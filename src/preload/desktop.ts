import { ipcRenderer } from 'electron'
import type { ProcessingProgress } from '../shared/processing'
import type { InputDiagnostics } from '../shared/input-diagnostics'
import type { UpdateState } from '../shared/updater'
import type { OutputAudioStatus } from '../shared/output-audio'
import type { BackupPreview, BackupRestoreResult } from '../shared/backup'
import type { DictionaryConflict, DictionarySyncStatus } from '../shared/dictionary-sync'
import type { AudioStorageAction, AudioStorageResult, AudioStorageSnapshot } from '../shared/audio-storage'
import type { WritingApp } from '../shared/output-preferences'
import type { CorrectionAcceptance, CorrectionCandidate, CorrectionList, HistoryEditResult } from '../shared/corrections'
import type {
  KeyboardMonitorStatus,
  ShortcutCaptureState,
  CardPayload,
  DesktopSnapshot,
  DictionaryWord,
  HistoryDetail,
  HistoryItem,
  HistoryStats,
  Preferences,
  VoiceState,
} from '../shared/desktop'
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args)
function watch<T>(channel: string, cb: (value: T) => void) {
  const handler = (_: unknown, value: T) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}
export const desktop = {
  outputAudio: {
    status: () => invoke<OutputAudioStatus>('desktop:output-audio-status'),
    retryRecovery: () => invoke<OutputAudioStatus>('desktop:output-audio-recover'),
    onState: (cb: (status: OutputAudioStatus) => void) => watch('desktop:output-audio-state', cb),
  },
  dictionarySync: {
    status:()=>invoke<DictionarySyncStatus>('desktop:dictionary-sync-status'),
    run:()=>invoke<DictionarySyncStatus>('desktop:dictionary-sync-run'),
    configure:(enabled:boolean,copyLocal=false,scope?:string)=>invoke<DictionarySyncStatus>('desktop:dictionary-sync-configure',enabled,copyLocal,scope),
    selectView:(view:'local'|'account',scope?:string)=>invoke<DictionarySyncStatus>('desktop:dictionary-sync-view',view,scope),
    copyLocal:(scope?:string)=>invoke<{added:number}>('desktop:dictionary-sync-copy-local',scope),
    rebuild:(scope?:string)=>invoke<DictionarySyncStatus>('desktop:dictionary-sync-rebuild',scope),
    conflicts:()=>invoke<DictionaryConflict[]>('desktop:dictionary-sync-conflicts'),
    resolve:(key:string,revision:number,choice:'local'|'remote',scope:string|undefined,mutationId:string)=>invoke<void>('desktop:dictionary-sync-resolve',key,revision,choice,scope,mutationId),
    onState:(cb:(status:DictionarySyncStatus)=>void)=>watch('desktop:dictionary-sync-state',cb),
  },
  backup: {
    export: () => invoke<boolean>('desktop:backup-export'),
    preview: () => invoke<BackupPreview|null>('desktop:backup-preview'),
    restore: (token:string,options:{settings:boolean;dictionary:boolean;conflict:'keep'|'replace'}) => invoke<BackupRestoreResult>('desktop:backup-restore',token,options),
  },
  updater: {
    get: () => invoke<UpdateState>('desktop:update-get'),
    check: (channel: 'stable'|'beta') => invoke<UpdateState>('desktop:update-check', channel),
    download: () => invoke<UpdateState>('desktop:update-download'),
    cancel: () => invoke<UpdateState>('desktop:update-cancel'),
    install: () => invoke<void>('desktop:update-install'),
    onState: (cb: (state: UpdateState) => void) => watch('desktop:update-state', cb),
  },
  selection: {
    run: (id: string, action: 'summarize'|'rewrite'|'translate'|'proofread'|'skill'|'custom', options?: { skillId?: string; instruction?: string }) => invoke<void>('desktop:selection-run', id, action, options),
    cancel: (id: string) => invoke<void>('desktop:selection-cancel', id),
  },
  skills: {
    onProgress: (cb: (value: ProcessingProgress & { id: string }) => void) => watch('desktop:skill-progress', cb),
    run: (id: string, skillId: string, text: string) => invoke<{ text: string; skillName: string }>('desktop:skill-run', id, skillId, text),
    cancel: (id: string) => invoke<void>('desktop:skill-cancel', id),
  },
  audioStorage: {
    scan: () => invoke<AudioStorageSnapshot>('desktop:audio-storage-scan'),
    preview: (token: string, key: string) => invoke<Uint8Array>('desktop:audio-storage-preview', token, key),
    act: (token: string, keys: string[], action: AudioStorageAction) => invoke<AudioStorageResult>('desktop:audio-storage-act', token, keys, action),
  },
  snapshot: () => invoke<DesktopSnapshot>('desktop:snapshot'),
  writingApps: () => invoke<WritingApp[]>('desktop:writing-apps'),
  preferences: (patch: Partial<Preferences>) =>
    invoke<Preferences>('desktop:preferences', patch),
  completeOnboarding: () => invoke<void>('desktop:complete-onboarding'),
  copy: (text: string) => invoke<void>('clipboard:write-text', text),
  openUrl: (url: string) => invoke<void>('desktop:open-url', url),
  onSettings: (cb: (value: { menu?: number }) => void) =>
    watch('page-event--hub--open-settings-hub', cb),
  onHistory: (cb: () => void) => watch('desktop:history-changed', cb),
  onPreferences: (cb: (value: Preferences) => void) =>
    watch('desktop:preferences-changed', cb),
  history: {
    diagnostics: (id: string) => invoke<InputDiagnostics>('input-diagnostics:read', id),
    exportDiagnostics: (id: string) => invoke<string | null>('input-diagnostics:export', id),
    restoreVersion: (id: string, version: 'raw' | 'processed') => invoke<HistoryItem>('desktop:history-restore-version', id, version),
    list: (offset = 0, limit = 50, query = '', mode = '') =>
      invoke<{ data: HistoryItem[]; hasMore: boolean }>(
        'desktop:history-list',
        { offset, limit, query, mode },
      ),
    detail: (id: string) => invoke<HistoryDetail>('desktop:history-detail', id),
    retry: (id: string) => invoke<HistoryItem>('desktop:history-retry', id),
    edit: (id: string, text: string) =>
      invoke<HistoryEditResult>('desktop:history-edit', id, text),
    exportAudio: (id: string) =>
      invoke<{ success: boolean; canceled?: boolean }>(
        'file:save-audio-with-dialog',
        { audioId: id, defaultFileName: `OpenType-${id}.wav` },
      ),
    stats: () =>
      invoke<HistoryStats>(
        'desktop:history-stats',
      ),
  },
  dictionary: {
    snapshot:()=>invoke<{scope:string;words:DictionaryWord[]}>('desktop:dictionary-snapshot'),
    onChanged: (cb:()=>void) => watch('desktop:dictionary-changed',cb),
    list: () => invoke<DictionaryWord[]>('desktop:dictionary-list'),
    save: (term: string, pronunciation: string, id?: string, scope?:string,expected?:{term:string;pronunciation:string|null}) =>
      invoke<void>('desktop:dictionary-save', { term, pronunciation, id,scope,expected }),
    remove: (id: string,scope?:string,expected?:{term:string;pronunciation:string|null}) => invoke<void>('desktop:dictionary-remove', id,scope,expected),
    import: (scope?:string) =>
      invoke<{ success: boolean; added?: number; reason?: string }>(
        'desktop:dictionary-import',
        scope,
      ),
  },
  corrections: {
    list: (offset = 0, historyId?: string) => invoke<CorrectionList>('desktop:corrections-list', offset, historyId),
    dismiss: (id: string) => invoke<void>('desktop:corrections-dismiss', id),
    accept: (id: string, term: string, hint: string,scope?:string) => invoke<CorrectionAcceptance>('desktop:corrections-accept', id, term, hint,scope),
    setCapsuleCandidate: (id?: string) => ipcRenderer.send('desktop:corrections-active-candidate', id),
    onCapsuleCandidate: (cb: (value: { candidate: CorrectionCandidate | null; candidateId?: string; scope?: string; analysisFallback?: 'not_configured' | 'request_failed' }) => void) =>
      watch('desktop:correction-capsule-candidate', cb),
  },
  keyboard: {
    beginCapture: (id: string) => invoke<void>('keyboard:begin-capture', id),
    endCapture: (id: string) => invoke<void>('keyboard:end-capture', id),
    onCapture: (cb: (state: ShortcutCaptureState) => void) => watch('keyboard:capture', cb),
    status: () => invoke<KeyboardMonitorStatus>('keyboard:status'),
    restart: () => invoke<KeyboardMonitorStatus>('keyboard:restart'),
  },
  recording: {
    onFlush: (cb: (id: string) => void) => watch('capture:flush', cb),
    flushed: (id: string) => ipcRenderer.send('capture:flushed', id),
    failed: (id: string, detail = 'capture_failed') => ipcRenderer.send('capture:failed', id, detail),
    onState: (cb: (state: VoiceState) => void) =>
      watch('capture:state-changed', cb),
  },
  card: {
    get: () => invoke<CardPayload | null>('page:get-interactive-card-payload'),
    onUpdate: (cb: (payload: CardPayload) => void) =>
      watch('interactive-card:update', cb),
    close: () => invoke<void>('page:close-interactive-card'),
    replaceSelection: (id: string) => invoke<void>('desktop:answer-replace-selection', id),
    resize: (height: number) => invoke<void>('page:update-interactive-card-bounds', { height }),
  },
}
