// SQLite 数据访问层。使用 better-sqlite3 同步驱动 + drizzle，
// 同步驱动在主进程里反而是优势：写入历史是高频小事务，异步排队会引入不必要的调度开销。

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, desc, and, sql } from 'drizzle-orm'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { extractCorrections, extractInputCorrections, type CorrectionPair } from '../services/correction-extraction'
import type { CorrectionCandidate, CorrectionList, CorrectionAcceptance } from '../../shared/corrections'
import type { HistoryStats } from '../../shared/desktop'
import { history, historyTombstones, dictionary, type HistoryStatus, type SyncStatus, type CaptureMode } from './schema'
import { jsonObject, voiceContext } from '../services/voice-context'
import { DictionarySyncStore, dictionaryTermKey } from './dictionary-sync'

/** drizzle 从 schema 推导出的插入类型。用它收窄 upsert 入参，
 *  避免 Record<string, any> 逃过 schema 校验（字段拼错在编译期就能发现）。 */
export type HistoryInsert = typeof history.$inferInsert
export type HistoryRow = typeof history.$inferSelect
export interface HistorySyncAccount { userId: string; serverUrl: string }

let db: ReturnType<typeof drizzle> | null = null
let raw: Database.Database | null = null
let dictionarySyncStore: DictionarySyncStore | undefined
let activeDictionaryScope='local'
/** Account logged in when a history row is first created; null while logged out. */
let historyOwner: () => HistorySyncAccount | null = () => null
/** Pushed-content fingerprints captured by pendingSyncForApi, consumed by markSynced/markSyncFailed. */
const pushedVersions = new Map<string, string>()
/** Defensive cap: entries are normally consumed by the push response within one batch. */
const MAX_PUSHED_VERSIONS = 1000
/** sync_failed rows stop being retried automatically after this many attempts (see pendingSync). */
const MAX_SYNC_ATTEMPTS = 3
function pushVersion(row: HistoryRow): string {
  return JSON.stringify([row.updatedAt, row.status, row.mode, row.refinedText, row.duration, row.createdAt,
    row.audioMetadata, row.appVersion, row.micDevice, row.modeMeta, row.audioContext])
}
export function getDictionarySyncStore(){if(!dictionarySyncStore)throw new Error('database not initialized');return dictionarySyncStore}

/**
 * 初始化数据库。dbDir 由调用方注入（主进程传 app.getPath('userData')/db），
 * 这样数据层不依赖 Electron 运行时，可独立测试。
 */
export function initDatabase(dbDir: string): void {
  if (db) return

  const dir = dbDir
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, 'opentype.db')

  raw = new Database(file)

  // WAL 模式：读写并发不互相阻塞，录音落库时 UI 查询不会被卡住
  raw.pragma('journal_mode = WAL')
  // NORMAL 同步级别在 WAL 下已足够安全，且写入快一个数量级
  raw.pragma('synchronous = NORMAL')
  raw.pragma('foreign_keys = ON')

  migrate(raw)
  db = drizzle(raw)
  dictionarySyncStore = new DictionarySyncStore(raw)
}

/**
 * 增量补列。
 *
 * `CREATE TABLE IF NOT EXISTS` 对已存在的表完全跳过——旧版本数据库不会获得新列。
 * 真实产品用 drizzle 的迁移文件链解决（14 个 SQL 文件逐步 ALTER），
 * 这里用等效做法：读取现有列，缺失的逐个 ALTER TABLE ADD COLUMN。
 *
 * 这是必需的：用户在旧版本上录制的历史记录不能因为升级而丢失。
 */
function addMissingColumns(conn: Database.Database, table: string, columns: Record<string, string>): void {
  const existing = new Set(
    (conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  )
  for (const [name, definition] of Object.entries(columns)) {
    if (existing.has(name)) continue
    try {
      conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
    } catch (err) {
      // SQLite 的 ADD COLUMN 有限制（如不能加 NOT NULL 无默认值的列），
      // 单列失败不应中断整个迁移
      console.warn(`[db] 补列失败 ${table}.${name}: ${(err as Error).message}`)
    }
  }
}

/** 建表。真实项目里用 drizzle-kit 生成迁移文件，这里内联以保证首次启动即可用。 */
function migrate(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT,
      status TEXT,
      mode TEXT DEFAULT 'voice_transcript' NOT NULL,
      refined_text TEXT,
      edited_text TEXT,
      edited_text_status TEXT DEFAULT 'NOT_EXTRACTED' NOT NULL,
      edited_text_attempts INTEGER DEFAULT 0 NOT NULL,
      has_reverted_ai INTEGER,
      ax_text TEXT,
      ax_html TEXT,
      languages TEXT,
      detected_language TEXT,
      duration REAL,
      audio_local_path TEXT,
      audio_metadata TEXT,
      mic_device TEXT,
      mic_device_info BLOB,
      focused_app_name TEXT,
      focused_app_bundle_id TEXT,
      focused_app_window_title TEXT,
      focused_app_web_url TEXT,
      focused_app_web_domain TEXT,
      input_context TEXT,
      mode_meta BLOB,
      app_version TEXT DEFAULT '0.0.0' NOT NULL,
      debug_info TEXT,
      audio_context TEXT,
      client_metadata TEXT,
      sync_status TEXT DEFAULT 'pending_upload' NOT NULL,
      sync_attempt_count INTEGER DEFAULT 0 NOT NULL,
      server_updated_at INTEGER,
      synced_from_cloud INTEGER DEFAULT 0 NOT NULL,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS history_id_unique ON history (id);
    CREATE INDEX IF NOT EXISTS idx_history_user_created ON history (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_history_status ON history (status);
    -- 注意：detected_language 在旧库中可能尚不存在，其索引在补列后单独创建

    CREATE INDEX IF NOT EXISTS idx_history_user_app_status_created
      ON history (user_id, focused_app_bundle_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_history_push_candidate
      ON history (user_id, sync_status, created_at, sync_attempt_count)
      WHERE status = 'completed' AND refined_text IS NOT NULL AND refined_text <> '';

    CREATE TABLE IF NOT EXISTS dictionary (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT,
      term TEXT NOT NULL,
      pronunciation TEXT,
      created_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dictionary_user_term_unique ON dictionary (user_id, term);
    CREATE TABLE IF NOT EXISTS history_tombstones (
      id TEXT PRIMARY KEY NOT NULL,
      deleted_at TEXT NOT NULL,
      audio_pending INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_history_audio_cleanup ON history_tombstones (audio_pending, id);
    CREATE TABLE IF NOT EXISTS history_cloud_deletions (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      server_url TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (server_url, user_id, id)
    );
    CREATE TABLE IF NOT EXISTS history_sync_cursors (
      server_url TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cursor INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (server_url, user_id)
    );
    CREATE TABLE IF NOT EXISTS history_cloud_evictions (
      server_url TEXT NOT NULL,
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (server_url, user_id, id)
    );
    CREATE TABLE IF NOT EXISTS history_cloud_epochs (
      server_url TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cloud_epoch INTEGER NOT NULL DEFAULT 0,
      pending_wipe_id TEXT,
      PRIMARY KEY (server_url, user_id)
    );
    CREATE TABLE IF NOT EXISTS audio_storage_journal (
      key TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL
    );
  `)

  // 补列之后才能建依赖新列的索引
  try {
    conn.exec('CREATE INDEX IF NOT EXISTS idx_history_detected_language ON history (detected_language)')
  } catch { /* 列不存在时忽略 */ }

  // 对已存在的表补齐后续版本新增的列（等效于 drizzle 的 ALTER 迁移链）
  addMissingColumns(conn, 'history', {
    edited_text: 'TEXT',
    edited_text_status: "TEXT DEFAULT 'NOT_EXTRACTED' NOT NULL",
    edited_text_attempts: 'INTEGER DEFAULT 0 NOT NULL',
    has_reverted_ai: 'INTEGER',
    ax_text: 'TEXT',
    audio_context: 'TEXT',
    ax_html: 'TEXT',
    languages: 'TEXT',
    detected_language: 'TEXT',
    mic_device_info: 'BLOB',
    mode_meta: 'BLOB',
    cloud_scope: 'TEXT'
  })
  addMissingColumns(conn, 'dictionary', {
    source_history_id: 'TEXT REFERENCES history(id) ON DELETE SET NULL',
    source_kind: 'TEXT',
  })
  conn.exec(`CREATE TABLE IF NOT EXISTS correction_candidates (
    id TEXT PRIMARY KEY NOT NULL,
    history_id TEXT NOT NULL REFERENCES history(id) ON DELETE CASCADE,
    original TEXT NOT NULL,
    replacement TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'dismissed')),
    dictionary_id TEXT REFERENCES dictionary(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE (history_id, original, replacement)
  );
  CREATE INDEX IF NOT EXISTS idx_corrections_state_created ON correction_candidates (state, created_at);
  CREATE INDEX IF NOT EXISTS idx_corrections_dictionary ON correction_candidates (dictionary_id);
  CREATE TRIGGER IF NOT EXISTS invalidate_correction_candidates AFTER UPDATE OF refined_text, edited_text, mode, status ON history
  WHEN OLD.refined_text IS NOT NEW.refined_text OR OLD.edited_text IS NOT NEW.edited_text OR OLD.mode IS NOT NEW.mode OR OLD.status IS NOT NEW.status
  BEGIN DELETE FROM correction_candidates WHERE history_id = NEW.id AND state = 'pending'; END;`)
  addMissingColumns(conn, 'correction_candidates', {
    source_kind: "TEXT NOT NULL DEFAULT 'history_edit'",
    source_domains: "TEXT NOT NULL DEFAULT '[]'",
  })
}

function requireDb() {
  if (!db) throw new Error('database not initialized, call initDatabase() first')
  return db
}

function wasDeleted(id: string): boolean {
  return !!requireDb().select({ id: historyTombstones.id }).from(historyTombstones)
    .where(eq(historyTombstones.id, id)).get()
}

function belongsToRemote(row: Pick<HistoryRow, 'userId' | 'cloudScope' | 'syncedFromCloud'>, account: HistorySyncAccount): boolean {
  if (row.cloudScope) return row.userId === account.userId && row.cloudScope === account.serverUrl
  // Older downloads omitted account metadata. Adopt only when this authenticated
  // server confirms the exact record ID; never claim these rows for an arbitrary upload.
  return row.userId === account.userId || (row.userId === null && row.syncedFromCloud)
}

function removeRows(rows: Array<{ id: string }>): number {
  const d = requireDb()
  return d.transaction(tx => {
    const deletedAt = new Date().toISOString()
    for (const row of rows) {
      tx.insert(historyTombstones).values({ id: row.id, deletedAt })
        .onConflictDoUpdate({ target: historyTombstones.id, set: { audioPending: true } }).run()
      tx.delete(history).where(eq(history.id, row.id)).run()
    }
    return rows.length
  })
}

export const HistoryRepo = {
  /** New rows created while an account is logged in belong to it, so another account never claims them. */
  setOwnerResolver(resolve: () => HistorySyncAccount | null): void { historyOwner = resolve },

  /**
   * 渲染层是分批 patch 写入（先建占位、再补模式/元数据/状态），
   * 所以冲突时必须更新「本次实际提供的字段」而不是固定子集——
   * 固定子集会把后到的 mode_meta/audio_metadata 等 patch 静默丢弃；
   * 同时永不回写 createdAt，保留首建的创建时间。
   */
  async upsert(record: HistoryInsert): Promise<void> {
    const d = requireDb()
    if (wasDeleted(record.id)) return
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (key === 'id' || key === 'createdAt' || value === undefined) continue
      patch[key] = value
    }
    // Ownership is stamped only on first insert (never in the conflict patch), so a
    // later patch after an account switch cannot move the row to another account.
    const owner = record.userId == null ? historyOwner() : null
    d.insert(history).values(owner ? { ...record, userId: owner.userId, cloudScope: owner.serverUrl } : record).onConflictDoUpdate({
      target: history.id,
      set: patch
    }).run()
  },

  /** A card can outlive a history edit/retry/deletion. Update only the existing
   * answer it displayed; never recreate a deleted row or overwrite newer text. */
  async recordInputDelivery(id: string, expectedText: string, outcome: { status: 'verified' | 'unverified' | 'failed'; method?: string; detail?: string }): Promise<boolean> {
    const d = requireDb()
    return d.transaction(tx => {
      const row = tx.select().from(history).where(eq(history.id, id)).get()
      if (!row || row.status !== 'completed' || row.refinedText !== expectedText || (row.editedText !== null && row.editedText !== expectedText)) return false
      tx.update(history).set({
        modeMeta: JSON.stringify({ ...jsonObject(row.modeMeta), delivery: outcome.status === 'failed' ? 'card' : 'selection',
          input_delivery: outcome.status, input_method: outcome.method }),
        debugInfo: JSON.stringify({ ...jsonObject(row.debugInfo), detail: outcome.detail }),
        syncStatus: 'pending_upload', updatedAt: new Date().toISOString(),
      }).where(eq(history.id, id)).run()
      return true
    })
  },

  async list(options: { limit?: number; offset?: number; status?: HistoryStatus } = {}) {
    const d = requireDb()
    const limit = options.limit ?? 50
    const conditions = options.status ? eq(history.status, options.status) : undefined
    const query = d.select().from(history).orderBy(desc(history.createdAt)).limit(limit).offset(options.offset ?? 0)
    return conditions ? query.where(conditions).all() : query.all()
  },

  /**
   * 按 id 取单条。
   *
   * 前端的 db:history-get 需要它：返回 {success, history}，
   * 用 list({id}) 再取首元素是不等价的——id 不在 list 的过滤条件里，
   * 那样只会拿到最新一条，前端据此渲染详情会张冠李戴。
   */
  async byId(id: string) {
    const d = requireDb()
    return d.select().from(history).where(eq(history.id, id)).get() ?? null
  },

  async search(query: string, mode: string, offset: number, limit: number) {
    const conditions = []
    if (query) conditions.push(sql`instr(lower(coalesce(${history.editedText}, ${history.refinedText}, '')), lower(${query})) > 0`)
    if (mode) conditions.push(eq(history.mode, mode as CaptureMode))
    return requireDb().select().from(history).where(and(...conditions)).orderBy(desc(history.createdAt)).limit(limit).offset(offset).all()
  },

  async stats(): Promise<HistoryStats> {
    const totals = requireDb().select({ count: sql<number>`count(*)`, words: sql<number>`coalesce(sum(length(coalesce(${history.editedText}, ${history.refinedText}, ''))), 0)`, seconds: sql<number>`coalesce(sum(${history.duration}), 0)` }).from(history).get()!
    let dictationCharacters = 0, dictationSeconds = 0
    // Keep legacy output totals intact. Pace uses only original dictation and
    // its matching audio; edits, AI answers and missing transcripts cannot inflate it.
    const recordings = raw!.prepare(`SELECT mode_meta, duration FROM history
      WHERE mode = 'voice_transcript' AND status = 'completed' AND duration > 0`).iterate()
    for (const entry of recordings) {
      const row = entry as { mode_meta: unknown; duration: number }
      if (!Number.isFinite(row.duration)) continue
      const original = jsonObject(row.mode_meta).raw_text
      if (typeof original !== 'string') continue
      const characters = original.match(/[\p{L}\p{N}]/gu)?.length ?? 0
      if (!characters) continue
      dictationCharacters += characters
      dictationSeconds += row.duration
    }
    return { ...totals, dictationCharacters, dictationSeconds }
  },

  async latestTranscript() {
    return requireDb().select().from(history)
      .where(and(eq(history.mode, 'voice_transcript'), eq(history.status, 'completed'), sql`length(trim(coalesce(${history.editedText}, ${history.refinedText}, ''))) > 0`))
      .orderBy(desc(history.createdAt)).limit(1).get() ?? null
  },

  async latest() {
    const d = requireDb()
    return d.select().from(history).orderBy(desc(history.createdAt)).limit(1).get() ?? null
  },

  async byApp(bundleId: string, limit = 20) {
    const d = requireDb()
    return d.select().from(history)
      .where(eq(history.focusedAppBundleId, bundleId))
      .orderBy(desc(history.createdAt))
      .limit(limit)
      .all()
  },

  async remove(id: string, account?: HistorySyncAccount): Promise<void> {
    requireDb().transaction(() => {
      if (account) {
        const row = requireDb().select().from(history).where(eq(history.id, id)).get()
        const queued = raw!.prepare('SELECT 1 FROM history_cloud_deletions WHERE server_url = ? AND user_id = ? AND id = ?')
          .get(account.serverUrl, account.userId, id)
        if ((!row && !queued) || (row && (row.userId !== account.userId || row.cloudScope !== account.serverUrl))) {
          throw new Error('history_cloud_account_mismatch')
        }
        raw!.prepare('INSERT OR IGNORE INTO history_cloud_deletions (id, user_id, server_url) VALUES (?, ?, ?)')
          .run(id, account.userId, account.serverUrl)
      }
      removeRows([{ id }])
    })
  },

  pendingCloudDeletions(account: HistorySyncAccount, limit = 200, retryFailed = false): string[] {
    return (raw!.prepare(`SELECT id FROM history_cloud_deletions WHERE server_url = ? AND user_id = ?
      AND acknowledged = 0 AND (attempts < 3 OR ? = 1) ORDER BY id LIMIT ?`)
      .all(account.serverUrl, account.userId, retryFailed ? 1 : 0, limit) as { id: string }[]).map(r => r.id)
  },

  cloudDeletionCount(account: HistorySyncAccount): number {
    return (raw!.prepare('SELECT COUNT(*) AS count FROM history_cloud_deletions WHERE server_url = ? AND user_id = ? AND acknowledged = 0')
      .get(account.serverUrl, account.userId) as { count: number }).count
  },

  markCloudDeletions(account: HistorySyncAccount, ids: string[], acknowledged: boolean): void {
    requireDb().transaction(() => {
      const stmt = raw!.prepare(`UPDATE history_cloud_deletions SET ${acknowledged ? 'acknowledged = 1' : 'attempts = attempts + 1'}
        WHERE server_url = ? AND user_id = ? AND id = ?`)
      for (const id of ids) stmt.run(account.serverUrl, account.userId, id)
    })
  },

  /** A remote deletion never deletes another account's record or queues an echo upload. */
  async applyRemoteDeletions(ids: string[], account: HistorySyncAccount): Promise<string[]> {
    return requireDb().transaction(() => {
      const removed: string[] = []
      for (const id of ids) {
        raw!.prepare(`INSERT INTO history_cloud_deletions (id, user_id, server_url, acknowledged) VALUES (?, ?, ?, 1)
          ON CONFLICT (server_url, user_id, id) DO UPDATE SET acknowledged = 1`).run(id, account.userId, account.serverUrl)
        const row = requireDb().select().from(history).where(eq(history.id, id)).get()
        if (row && belongsToRemote(row, account)) {
          removeRows([{ id }])
          removed.push(id)
        }
      }
      return removed
    })
  },

  syncCursor(account: HistorySyncAccount): number {
    return (raw!.prepare('SELECT cursor FROM history_sync_cursors WHERE server_url = ? AND user_id = ?')
      .get(account.serverUrl, account.userId) as { cursor: number } | undefined)?.cursor ?? 0
  },

  saveSyncCursor(account: HistorySyncAccount, cursor: number): void {
    raw!.prepare(`INSERT INTO history_sync_cursors (server_url, user_id, cursor) VALUES (?, ?, ?)
      ON CONFLICT (server_url, user_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor)`)
      .run(account.serverUrl, account.userId, cursor)
  },

  /** Exclude cloud-cleared content from upload without touching local text,
   * audio, correction sources or local deletion tombstones. */
  applyCloudEvictions(account: HistorySyncAccount, ids: string[]): void {
    requireDb().transaction(() => {
      const insert = raw!.prepare('INSERT OR IGNORE INTO history_cloud_evictions (server_url, user_id, id) VALUES (?, ?, ?)')
      for (const id of ids) insert.run(account.serverUrl, account.userId, id)
    })
  },
  cloudEpoch(account: HistorySyncAccount): number {
    requireDb()
    return (raw!.prepare('SELECT cloud_epoch FROM history_cloud_epochs WHERE server_url = ? AND user_id = ?')
      .get(account.serverUrl, account.userId) as { cloud_epoch: number } | undefined)?.cloud_epoch ?? 0
  },
  applyCloudEpoch(account: HistorySyncAccount, epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('invalid_cloud_epoch')
    requireDb().transaction(() => {
      if (epoch <= HistoryRepo.cloudEpoch(account)) return
      // A device learning about a wipe cannot reliably date offline captures
      // against the server clock. Keep its existing recordings local; captures
      // made after this acknowledgement can sync normally.
      raw!.prepare(`INSERT OR IGNORE INTO history_cloud_evictions (server_url, user_id, id)
        SELECT ?, ?, id FROM history WHERE (user_id = ? OR user_id IS NULL) AND (cloud_scope = ? OR cloud_scope IS NULL)`)
        .run(account.serverUrl, account.userId, account.userId, account.serverUrl)
      raw!.prepare(`INSERT INTO history_cloud_epochs(server_url, user_id, cloud_epoch) VALUES (?, ?, ?)
        ON CONFLICT(server_url,user_id) DO UPDATE SET cloud_epoch = excluded.cloud_epoch`).run(account.serverUrl, account.userId, epoch)
    })
  },
  beginCloudWipe(account: HistorySyncAccount): string {
    requireDb()
    const current = raw!.prepare('SELECT pending_wipe_id FROM history_cloud_epochs WHERE server_url = ? AND user_id = ?')
      .get(account.serverUrl, account.userId) as { pending_wipe_id: string | null } | undefined
    if (current?.pending_wipe_id) return current.pending_wipe_id
    const id = crypto.randomUUID()
    raw!.prepare(`INSERT INTO history_cloud_epochs(server_url,user_id,pending_wipe_id) VALUES (?,?,?)
      ON CONFLICT(server_url,user_id) DO UPDATE SET pending_wipe_id = excluded.pending_wipe_id`).run(account.serverUrl, account.userId, id)
    return id
  },
  finishCloudWipe(account: HistorySyncAccount, id: string): void {
    requireDb();raw!.prepare('UPDATE history_cloud_epochs SET pending_wipe_id = NULL WHERE server_url = ? AND user_id = ? AND pending_wipe_id = ?')
      .run(account.serverUrl, account.userId, id)
  },
  hasPendingCloudWipe(account: HistorySyncAccount): boolean {
    requireDb(); return Boolean((raw!.prepare('SELECT pending_wipe_id FROM history_cloud_epochs WHERE server_url = ? AND user_id = ?')
      .get(account.serverUrl, account.userId) as { pending_wipe_id: string | null } | undefined)?.pending_wipe_id)
  },
  cloudExcludedCount(account: HistorySyncAccount): number {
    requireDb()
    return (raw!.prepare(`SELECT count(*) AS n FROM history_cloud_evictions e JOIN history h ON h.id = e.id
      WHERE e.server_url = ? AND e.user_id = ? AND (h.user_id = ? OR h.user_id IS NULL) AND (h.cloud_scope = ? OR h.cloud_scope IS NULL)`)
      .get(account.serverUrl,account.userId,account.userId,account.serverUrl) as { n: number }).n
  },

  async clear(): Promise<string[]> {
    const rows = requireDb().select({ id: history.id }).from(history).all()
    removeRows(rows)
    return rows.map(row => row.id)
  },

  async pendingAudioCleanup(afterId = '', limit = 100): Promise<string[]> {
    return requireDb().select({ id: historyTombstones.id }).from(historyTombstones)
      .where(and(eq(historyTombstones.audioPending, true), sql`${historyTombstones.id} > ${afterId}`))
      .orderBy(historyTombstones.id).limit(limit).all().map(row => row.id)
  },

  async markAudioRemoved(id: string): Promise<void> {
    requireDb().update(historyTombstones).set({ audioPending: false })
      .where(eq(historyTombstones.id, id)).run()
  },

  async isDeleted(id: string): Promise<boolean> { return wasDeleted(id) },

  /**
   * 把未归属的历史记录认领给当前用户。
   *
   * 这是「先离线试用、后登录」场景的必经处理：试用期录制的记录 user_id 为 null，
   * 若不认领，它们永远进不了同步候选集（pendingSync 按 user_id 过滤），用户会觉得记录丢了。
   * 返回被认领的条数。
   */
  async claimOrphans(userId: string): Promise<number> {
    const d = requireDb()
    const result = d.update(history)
      .set({ userId, updatedAt: new Date().toISOString() })
      .where(sql`${history.userId} IS NULL`)
      .run()
    return result.changes ?? 0
  },

  /** Retain device history while preventing a server migration from uploading it. */
  preserveLegacyCloudScope(serverUrl: string): void {
    requireDb()
    raw!.prepare('UPDATE history SET cloud_scope = ? WHERE cloud_scope IS NULL').run(serverUrl)
  },

  /**
   * 取待同步记录。两个关键过滤：
   * 1. 同时接纳「属于该用户」与「尚未归属」的记录——后者由 claimOrphans 认领后进入同步队列。
   * 2. 只挑真正有内容的：空文本记录推上去只会浪费配额与带宽。
   */
  /**
   * 待推送记录。
   *
   * 推送候选集的过滤条件：
   *
   *   status = 'completed'
   *   AND ((refined_text IS NOT NULL AND refined_text <> '')
   *        OR (mode = 'voice_command' AND json_extract(mode_meta,'$.ai_result.delivery') = 'external'))
   *
   * 第二个分支容易漏：语音命令即使文本为空，只要触发了外部动作（如打开应用）
   * 就是有价值的记录。只筛「文本非空」会让这类记录永远不推送。
   */
  async pendingSync(userId: string, limit = 50, includeExhausted = false, serverUrl?: string) {
    const d = requireDb()
    return d.select().from(history)
      .where(and(
        sql`(${history.userId} = ${userId} OR ${history.userId} IS NULL)`,
        ...(serverUrl ? [eq(history.cloudScope, serverUrl)] : []),
        ...(serverUrl ? [sql`NOT EXISTS (SELECT 1 FROM history_cloud_evictions e WHERE e.server_url = ${serverUrl} AND e.user_id = ${userId} AND e.id = ${history.id})`] : []),
        sql`(${history.syncStatus} = 'pending_upload' OR
          (${history.syncStatus} = 'sync_failed' AND (${includeExhausted ? 1 : 0} = 1 OR ${history.syncAttemptCount} < ${MAX_SYNC_ATTEMPTS})))`,
        eq(history.status, 'completed' as HistoryStatus),
        sql`(
          (${history.refinedText} IS NOT NULL AND ${history.refinedText} <> '')
          OR (${history.mode} = 'voice_command'
              AND json_extract(${history.modeMeta}, '$.ai_result.delivery') = 'external')
        )`
      ))
      .orderBy(history.createdAt)
      .limit(limit)
      .all()
  },

  /**
   * 记录音频文件落盘路径。
   *
   * 单独一个方法而不是塞进 upsert：前端先写音频、后写记录，
   * 顺序不固定，upsert 可能还没发生过，此时更新会命中 0 行。
   */
  async setAudioPath(id: string, path: string): Promise<void> {
    requireDb().update(history)
      .set({ audioLocalPath: path, updatedAt: new Date().toISOString() })
      .where(eq(history.id, id))
      .run()
  },

  /** 更新记录的上下文元数据。前端录音过程中分批写入。 */
  async updateClientMetadata(id: string, metadata: unknown): Promise<void> {
    const d = requireDb()
    const value = typeof metadata === 'string' ? metadata : JSON.stringify(metadata ?? {})
    d.update(history)
      .set({ clientMetadata: value, updatedAt: new Date().toISOString() })
      .where(eq(history.id, id))
      .run()
  },

  /** 更新记录的模式元数据。合并而非覆盖——前端分批 patch。 */
  async updateModeMeta(id: string, patch: unknown): Promise<void> {
    const d = requireDb()
    const existing = d.select({ modeMeta: history.modeMeta }).from(history)
      .where(eq(history.id, id)).get() as { modeMeta: string | null } | undefined

    let merged: Record<string, unknown> = {}
    if (existing?.modeMeta) {
      try { merged = JSON.parse(existing.modeMeta) } catch { /* 旧值损坏则重来 */ }
    }
    // 浅合并：前端每次只传变化的部分
    const patchObj = typeof patch === 'string' ? JSON.parse(patch) : (patch ?? {})
    Object.assign(merged, patchObj)

    d.update(history)
      .set({ modeMeta: JSON.stringify(merged), updatedAt: new Date().toISOString() })
      .where(eq(history.id, id))
      .run()
  },

  /**
   * 把云端拉取的记录写入本地。
   *
   * 与 upsert 的区别：标记 syncedFromCloud=1 且 syncStatus='synced'，
   * 否则拉下来的记录会被当成待推送，形成回环推送。
   */
  async applyRemote(records: Array<Record<string, unknown>>, account?: HistorySyncAccount): Promise<number> {
    const d = requireDb()
    let applied = 0
    for (const r of records) {
      if (!r?.id) continue
      const id = String(r.id)
      if (wasDeleted(id)) continue
      if (account && raw!.prepare('SELECT 1 FROM history_cloud_deletions WHERE server_url = ? AND user_id = ? AND id = ?')
        .get(account.serverUrl, account.userId, id)) continue
      if (account && raw!.prepare('SELECT 1 FROM history_cloud_evictions WHERE server_url = ? AND user_id = ? AND id = ?')
        .get(account.serverUrl, account.userId, id)) continue
      const now = new Date().toISOString()
      const serverUpdatedAt = Number(r.server_updated_at ?? Date.now())

      const existing = d.select({ id: history.id, userId: history.userId, cloudScope: history.cloudScope, syncedFromCloud: history.syncedFromCloud, syncStatus: history.syncStatus, syncAttemptCount: history.syncAttemptCount }).from(history)
        .where(eq(history.id, id)).get()
      if (account && existing && !belongsToRemote(existing, account)) continue
      // Local unpushed changes win while they will still be pushed; exhausted failures heal from the cloud copy.
      if (existing && (existing.syncStatus === 'pending_upload'
        || (existing.syncStatus === 'sync_failed' && existing.syncAttemptCount < MAX_SYNC_ATTEMPTS))) continue

      const fields = {
        refinedText: (r.refined_text as string) ?? null,
        status: ((r.status as string) ?? 'completed') as HistoryStatus,
        mode: ((r.mode as string) ?? 'voice_transcript') as CaptureMode,
        duration: (r.duration as number) ?? null,
        updatedAt: now,
        serverUpdatedAt,
        syncedFromCloud: true,
        syncStatus: 'synced' as SyncStatus,
        ...(account ? { userId: account.userId, cloudScope: account.serverUrl } : {})
      }

      if (existing) {
        d.update(history).set(fields).where(eq(history.id, id)).run()
      } else {
        d.insert(history).values({
          id,
          userId: (r.user_id as string) ?? null,
          createdAt: (r.created_at as string) ?? now,
          audioMetadata: (r.audio_metadata as string) ?? null,
          appVersion: (r.app_version as string) ?? '0.0.0',
          micDevice: (r.mic_device as string) ?? null,
          modeMeta: r.mode_meta == null ? null : typeof r.mode_meta === 'string' ? r.mode_meta : JSON.stringify(r.mode_meta),
          audioContext: (r.audio_context as string) ?? null,
          ...fields
        }).run()
      }
      applied += 1
    }
    return applied
  },

  /**
   * 取待推送记录，转成服务端期望的 snake_case 形状。
   *
   * drizzle 的 select() 返回 TS 属性名（camelCase），而服务端协议用列名
   * （snake_case）。不做转换会导致服务端读到 undefined —— 表现为
   * 「推送成功但云端为空」这类难查的问题。
   */
  async pendingSyncForApi(userId: string, limit = 50, includeExhausted = false, blacklist: string[] = [], serverUrl?: string): Promise<Array<Record<string, unknown>>> {
    // Claim anonymous records before sending, so account changes and deletion during upload retain ownership.
    if (serverUrl) raw!.prepare(`UPDATE history SET user_id = ?, cloud_scope = ? WHERE
      (user_id IS NULL OR user_id = ?) AND cloud_scope IS NULL AND synced_from_cloud = 0`).run(userId, serverUrl, userId)
    const rows = (await this.pendingSync(userId, limit, includeExhausted, serverUrl))
    // A new batch supersedes any abandoned one (session change, failed request); never grow unbounded.
    if (pushedVersions.size + rows.length > MAX_PUSHED_VERSIONS) pushedVersions.clear()
    return rows.map((r) => {
      pushedVersions.set(r.id, pushVersion(r))
      // Keep AX dumps, local paths, input-field snapshots and diagnostic payloads local.
      // The local audio_context column keeps input_context; only the upload omits it.
      const context: Partial<ReturnType<typeof voiceContext>> = voiceContext(r.audioContext, r, blacklist)
      delete context.input_context
      const meta = jsonObject(r.modeMeta)
      delete meta.selected_text
      const fields = toSnakeCase(r)
      const record: Record<string, unknown> = {}
      for (const key of ['id', 'status', 'mode', 'refined_text', 'duration', 'created_at', 'updated_at', 'audio_metadata', 'app_version', 'mic_device']) {
        record[key] = fields[key]
      }
      record.mode_meta = JSON.stringify(meta)
      record.audio_context = JSON.stringify(context)
      return record
    })
  },

  /** Drops push fingerprints for a finished batch (any outcome), or all of them when a push run ends/is abandoned. */
  releasePushedVersions(ids?: string[]): void {
    if (!ids) { pushedVersions.clear(); return }
    for (const id of ids) pushedVersions.delete(id)
  },

  /** Marks only rows still matching the pushed snapshot; rows edited while the push was in flight stay pending. */
  async markSynced(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const d = requireDb()
    d.transaction(tx => {
      const now = new Date().toISOString()
      for (const id of ids) {
        const pushed = pushedVersions.get(id)
        pushedVersions.delete(id)
        const row = tx.select().from(history).where(eq(history.id, id)).get()
        if (!row || (pushed !== undefined && pushVersion(row) !== pushed)) continue
        tx.update(history).set({ syncStatus: 'synced' as SyncStatus, updatedAt: now })
          .where(eq(history.id, id)).run()
      }
    })
  },

  async markSyncFailed(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    for (const id of ids) pushedVersions.delete(id)
    const d = requireDb()
    // 失败次数累加，上层据此做指数退避；超过阈值后不再自动重试
    d.update(history)
      .set({
        syncStatus: 'sync_failed' as SyncStatus,
        syncAttemptCount: sql`${history.syncAttemptCount} + 1`,
        updatedAt: new Date().toISOString()
      })
      .where(sql`${history.id} IN ${ids}`)
      .run()
  },

  /** Retention removes local content; durable cleanup work is consumed by HistoryLifecycle. */
  async purgeOlderThan(days: number): Promise<number> {
    return (await this.expireOlderThan(days)).length
  },

  async expireOlderThan(days: number): Promise<string[]> {
    if (!Number.isFinite(days) || days < 0) return []
    const d = requireDb()
    const cutoff = Date.now() - days * 24 * 3600 * 1000
    // julianday handles both SQLite timestamps and ISO strings with timezone offsets.
    const rows = d.select({ id: history.id }).from(history)
      .where(sql`julianday(${history.createdAt}) < julianday(${cutoff / 1000}, 'unixepoch')`).all()
    removeRows(rows)
    return rows.map(row => row.id)
  }
}

export const DictionaryRepo = {
  scope:()=>activeDictionaryScope,
  setScope:(scope:string)=>{activeDictionaryScope=scope},
  importPortable(words: Array<{ term: string; pronunciation: string }>, conflict: 'keep'|'replace', commitPreferences: () => void) {
    return raw!.transaction(() => {
      const db = requireDb(), scope=activeDictionaryScope, existing = new Map(db.select().from(dictionary).where(eq(dictionary.userId,scope)).all().map(w=>[dictionaryTermKey(w.term),w]))
      let added = 0, updated = 0, kept = 0
      for (const word of words) {
        const found = existing.get(dictionaryTermKey(word.term))
        if (found) {
          if (conflict === 'replace' && (found.pronunciation ?? '') !== word.pronunciation) {
            db.update(dictionary).set({pronunciation:word.pronunciation}).where(eq(dictionary.id,found.id)).run(); updated++
            existing.set(dictionaryTermKey(word.term), {...found, pronunciation:word.pronunciation})
          } else kept++
        } else {
          const value = { id:crypto.randomUUID(),userId:scope,term:word.term.normalize('NFC').trim(),pronunciation:word.pronunciation,createdAt:new Date().toISOString() }
          db.insert(dictionary).values(value).run(); added++
          existing.set(dictionaryTermKey(value.term),{...value,sourceHistoryId:null,sourceKind:null})
        }
      }
      commitPreferences()
      return { added, updated, kept }
    })()
  },
  async update(userId: string, id: string, term: string, pronunciation: string) {
    requireDb().update(dictionary).set({term:term.normalize('NFC').trim(), pronunciation}).where(and(eq(dictionary.id,id),eq(dictionary.userId,userId))).run()
  },
  async remove(userId: string, id: string) {
    requireDb().delete(dictionary).where(and(eq(dictionary.id,id),eq(dictionary.userId,userId))).run()
  },
  async add(userId: string, term: string, pronunciation?: string) {
    requireDb().insert(dictionary).values({
      id: crypto.randomUUID(),
      userId,
      term:term.normalize('NFC').trim(),
      pronunciation: pronunciation ?? null,
      createdAt: new Date().toISOString()
    }).onConflictDoNothing().run()
  },

  async list(userId: string) {
    return requireDb().select().from(dictionary).where(eq(dictionary.userId, userId)).orderBy(sql`rowid DESC`).all()
  }
}

const editHash = (text: string) => createHash('sha256').update(text).digest('hex')
const canLearn = (row: HistoryRow, blacklist: string[]) => row.mode === 'voice_transcript'
  && row.status === 'completed' && !voiceContext(row.audioContext, row, blacklist).redacted
interface CandidateRow { id: string; history_id: string; original: string; replacement: string; source_hash: string; state: string; dictionary_id: string | null; source_kind: 'history_edit' | 'input_edit'; source_domains: string }
function learningDomainsAllowed(domains: unknown, blacklist: string[]): domains is string[] {
  return Array.isArray(domains) && domains.length <= 64 && domains.every(d => typeof d === 'string' && !voiceContext({ web_domain: d }, {}, blacklist).redacted)
}

/** Local-only suggestions. Saving an edit and its derived proposals is atomic;
 * source deletion cascades, while explicitly accepted dictionary terms survive. */
export const CorrectionRepo = {
  canObserve(id: string, expected: string, blacklist: string[] = [], domains: string[] = []): boolean {
    const row = requireDb().select().from(history).where(eq(history.id, id)).get()
    return Boolean(row && !wasDeleted(id) && canLearn(row, blacklist) && row.editedText === null && row.refinedText === expected
      && jsonObject(row.modeMeta).input_delivery === 'verified' && learningDomainsAllowed(domains, blacklist))
  },
  observeEdit(id: string, expected: string, corrected: string, blacklist: string[] = [], domains: string[] = [], validatedPairs?: CorrectionPair[]): { active: boolean; candidates: number; candidate: CorrectionCandidate | null; retractedIds: string[]; scope: string } {
    return requireDb().transaction(() => {
      const scope = DictionaryRepo.scope()
      if (typeof corrected !== 'string' || corrected.length > 100_000 || !CorrectionRepo.canObserve(id, expected, blacklist, domains)) return { active: false, candidates: 0, candidate: null, retractedIds: [], scope }
      const pairs = validatedPairs === undefined ? extractInputCorrections(expected, corrected)
        : validatedPairs.filter(pair => pair && typeof pair.original === 'string' && typeof pair.replacement === 'string'
          && pair.original.length > 0 && pair.replacement.length > 0 && pair.original !== pair.replacement
          && expected.includes(pair.original) && corrected.includes(pair.replacement))
      // Persist only word pairs, not the edited field or a new history version.
      const retractedIds = (raw!.prepare("SELECT id FROM correction_candidates WHERE history_id = ? AND state = 'pending' AND source_kind = 'input_edit'").all(id) as { id: string }[]).map(row => row.id)
      raw!.prepare("DELETE FROM correction_candidates WHERE history_id = ? AND state = 'pending' AND source_kind = 'input_edit'").run(id)
      const known = new Set((raw!.prepare('SELECT term FROM dictionary WHERE user_id = ?').all(scope) as { term: string }[]).map(word => dictionaryTermKey(word.term)))
      const insert = raw!.prepare(`INSERT OR IGNORE INTO correction_candidates
        (id, history_id, original, replacement, source_hash, source_kind, source_domains, created_at) VALUES (?, ?, ?, ?, ?, 'input_edit', ?, ?)`)
      let candidates = 0
      let firstId: string | undefined
      for (const pair of pairs) {
        if (known.has(dictionaryTermKey(pair.replacement))) continue
        const candidateId = crypto.randomUUID()
        const inserted = insert.run(candidateId, id, pair.original, pair.replacement,
          editHash(expected), JSON.stringify(domains), new Date().toISOString()).changes
        candidates += inserted
        if (inserted && !firstId) firstId = candidateId
      }
      const candidate = firstId ? raw!.prepare(`SELECT c.id, c.history_id AS historyId, c.original, c.replacement,
        c.created_at AS createdAt, coalesce(h.focused_app_name, '') AS appName, c.source_kind AS sourceKind
        FROM correction_candidates c JOIN history h ON h.id = c.history_id WHERE c.id = ?`).get(firstId) as CorrectionCandidate : null
      return { active: true, candidates, candidate, retractedIds, scope }
    })
  },
  dismissInputEdits(historyId: string): string[] {
    requireDb()
    const ids = (raw!.prepare("SELECT id FROM correction_candidates WHERE history_id = ? AND state = 'pending' AND source_kind = 'input_edit'").all(historyId) as { id: string }[]).map(row => row.id)
    raw!.prepare("DELETE FROM correction_candidates WHERE history_id = ? AND state = 'pending' AND source_kind = 'input_edit'").run(historyId)
    return ids
  },
  dismissAllInputEdits(): string[] {
    requireDb()
    const ids = (raw!.prepare("SELECT id FROM correction_candidates WHERE state = 'pending' AND source_kind = 'input_edit'").all() as { id: string }[]).map(row => row.id)
    raw!.prepare("DELETE FROM correction_candidates WHERE state = 'pending' AND source_kind = 'input_edit'").run()
    return ids
  },
  isPendingInputEdit(id: string): boolean {
    requireDb()
    return Boolean(raw!.prepare("SELECT 1 FROM correction_candidates WHERE id = ? AND state = 'pending' AND source_kind = 'input_edit' LIMIT 1").get(id))
  },
  restoreVersion(id: string, version: 'raw' | 'processed') {
    return requireDb().transaction(() => {
      const row = requireDb().select().from(history).where(eq(history.id, id)).get()
      if (!row || wasDeleted(id)) throw new Error('record_not_found')
      const value = version === 'raw' ? jsonObject(row.modeMeta).raw_text : row.refinedText
      if (typeof value !== 'string' || !value.trim()) throw new Error('history_version_missing')
      raw!.prepare("DELETE FROM correction_candidates WHERE history_id = ? AND state = 'pending'").run(id)
      requireDb().update(history).set({ editedText: version === 'raw' ? value : null,
        hasRevertedAi: version === 'raw', status: 'completed', syncStatus: 'pending_upload',
        modeMeta: JSON.stringify({ ...jsonObject(row.modeMeta), text_version: version }),
        updatedAt: new Date().toISOString() }).where(eq(history.id, id)).run()
      return requireDb().select().from(history).where(eq(history.id, id)).get()!
    })
  },
  saveEdit(id: string, text: string, enabled: boolean, blacklist: string[] = []): { candidates: number } {
    if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('invalid_history_text')
    return requireDb().transaction(() => {
      const row = requireDb().select().from(history).where(eq(history.id, id)).get()
      if (!row || wasDeleted(id)) throw new Error('record_not_found')
      const before = row.refinedText ?? String(jsonObject(row.modeMeta).raw_text ?? '')
      const pairs = enabled && canLearn(row, blacklist) ? extractCorrections(before, text) : []
      raw!.prepare("DELETE FROM correction_candidates WHERE history_id = ? AND state = 'pending'").run(id)
      requireDb().update(history).set({ editedText: text, updatedAt: new Date().toISOString() }).where(eq(history.id, id)).run()
      const insert = raw!.prepare(`INSERT OR IGNORE INTO correction_candidates
        (id, history_id, original, replacement, source_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      let candidates = 0
      for (const pair of pairs) candidates += insert.run(crypto.randomUUID(), id, pair.original, pair.replacement, editHash(text), new Date().toISOString()).changes
      return { candidates }
    })
  },
  list(offset = 0, historyId?: string): CorrectionList {
    requireDb()
    const skip = Math.max(0, Math.floor(Number(offset) || 0))
    const where = "c.state = 'pending'" + (historyId ? ' AND c.history_id = ?' : '')
    const args = historyId ? [historyId] : []
    const total = (raw!.prepare(`SELECT count(*) AS count FROM correction_candidates c WHERE ${where}`).get(...args) as { count: number }).count
    const items = raw!.prepare(`SELECT c.id, c.history_id AS historyId, c.original, c.replacement,
      c.created_at AS createdAt, coalesce(h.focused_app_name, '') AS appName, c.source_kind AS sourceKind FROM correction_candidates c
      JOIN history h ON h.id = c.history_id WHERE ${where} ORDER BY c.created_at DESC, c.id LIMIT 50 OFFSET ?`)
      .all(...args, skip) as CorrectionCandidate[]
    return { items, total, hasMore: skip + items.length < total }
  },
  dismiss(id: string) {
    requireDb(); raw!.prepare("UPDATE correction_candidates SET state = 'dismissed' WHERE id = ? AND state = 'pending'").run(id)
  },
  accept(id: string, term: string, hint: string, blacklist: string[] = []): CorrectionAcceptance {
    const t = typeof term === 'string' ? term.trim() : '', h = typeof hint === 'string' ? hint.trim() : ''
    if (!t || t.length > 100 || h.length > 100) throw new Error('empty_term')
    return requireDb().transaction(() => {
      const c = raw!.prepare('SELECT * FROM correction_candidates WHERE id = ?').get(id) as CandidateRow | undefined
      if (!c || c.state === 'dismissed') throw new Error('correction_stale')
      if (c.state === 'accepted') {
        if (c.dictionary_id) return { added: false, dictionaryId: c.dictionary_id }
        throw new Error('correction_stale')
      }
      const row = requireDb().select().from(history).where(eq(history.id, c.history_id)).get()
      let domains: unknown
      try { domains = JSON.parse(c.source_domains) } catch { throw new Error('correction_stale') }
      if (!row || !canLearn(row, blacklist) || !learningDomainsAllowed(domains, blacklist)
        || (c.source_kind === 'input_edit'
          ? row.editedText !== null || editHash(row.refinedText ?? '') !== c.source_hash
          : editHash(row.editedText ?? '') !== c.source_hash)) throw new Error('correction_stale')
      const scope=activeDictionaryScope
      const existing = requireDb().select().from(dictionary).where(eq(dictionary.userId, scope)).all()
        .find(w => dictionaryTermKey(w.term) === dictionaryTermKey(t))
      const dictionaryId = existing?.id ?? crypto.randomUUID()
      if (!existing) requireDb().insert(dictionary).values({ id: dictionaryId, userId: scope, term: t.normalize('NFC'),
        pronunciation: h, sourceHistoryId: row.id, sourceKind: c.source_kind, createdAt: new Date().toISOString() }).run()
      raw!.prepare("UPDATE correction_candidates SET state = 'accepted', dictionary_id = ? WHERE id = ?").run(dictionaryId, id)
      return { added: !existing, dictionaryId }
    })
  },
}

export function closeDatabase(): void {
  dictionarySyncStore=undefined;activeDictionaryScope='local'
  raw?.close()
  raw = null
  db = null
}

/**
 * 把 drizzle 的 camelCase 记录转成服务端期望的 snake_case。
 *
 * 只转协议里定义的字段——多余的字段会让请求体变大且可能触发服务端校验。
 * BLOB 列转成字符串，因为 JSON 无法直接序列化 Buffer。
 */
function toSnakeCase(record: Record<string, unknown>): Record<string, unknown> {
  const FIELD_MAP: Record<string, string> = {
    id: 'id',
    userId: 'user_id',
    status: 'status',
    mode: 'mode',
    refinedText: 'refined_text',
    duration: 'duration',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    audioMetadata: 'audio_metadata',
    appVersion: 'app_version',
    micDevice: 'mic_device',
    micDeviceInfo: 'mic_device_info',
    clientMetadata: 'client_metadata',
    modeMeta: 'mode_meta',
    debugInfo: 'debug_info',
    audioContext: 'audio_context',
    serverUpdatedAt: 'server_updated_at'
  }

  const out: Record<string, unknown> = {}
  for (const [camel, snake] of Object.entries(FIELD_MAP)) {
    const v = record[camel]
    if (v === undefined) continue
    // Buffer 无法 JSON 序列化，转字符串
    out[snake] = Buffer.isBuffer(v) ? v.toString('utf8') : v
  }
  return out
}

/** Storage inspection reads identifiers and paths only, never transcript contents. */
export const AudioStorageRepo = {
  references() {
    requireDb()
    const ids = new Set<string>(), paths = new Set<string>()
    for (const row of raw!.prepare('SELECT id, audio_local_path FROM history').all() as { id: string; audio_local_path: string | null }[]) {
      ids.add(row.id.toLowerCase())
      if (row.audio_local_path) paths.add(resolve(row.audio_local_path).toLowerCase())
    }
    for (const row of raw!.prepare('SELECT id FROM history_tombstones').all() as { id: string }[]) ids.add(row.id.toLowerCase())
    return { ids, paths }
  },
  entries(): Array<{ key: string; payload: string }> {
    requireDb()
    return raw!.prepare('SELECT key, payload FROM audio_storage_journal ORDER BY key').all() as Array<{ key: string; payload: string }>
  },
  save(key: string, payload: string): void {
    requireDb()
    raw!.prepare('INSERT INTO audio_storage_journal (key,payload) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key,payload)
  },
  remove(key: string): void { requireDb(); raw!.prepare('DELETE FROM audio_storage_journal WHERE key=?').run(key) },
  recover(id: string, path: string, modifiedAt: number): void {
    requireDb().transaction(() => {
      const refs = AudioStorageRepo.references()
      if (refs.ids.has(id.toLowerCase()) || refs.paths.has(resolve(path).toLowerCase())) throw new Error('audio_storage_referenced')
      const now = new Date().toISOString()
      // Recovery starts a new local retention period. Recognition is an explicit later action.
      raw!.prepare(`INSERT INTO history(id,status,mode,audio_local_path,mode_meta,created_at,updated_at)
        VALUES (?,'failed','voice_transcript',?,?,?,?)`).run(id,path,JSON.stringify({ recovered_audio: true, original_file_modified_at: modifiedAt }),now,now)
    })
  },
}
