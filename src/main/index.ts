// 主进程入口。职责边界：
// - 只做编排与 IPC，不实现业务细节（业务在 services/）
// - 持有唯一一份原生资源句柄（数据库、FFI、窗口）

import { app, BrowserWindow, dialog, ipcMain, screen, Tray, Menu, nativeImage, shell, systemPreferences, safeStorage, utilityProcess, powerMonitor } from 'electron'
import { join, basename, relative, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { serviceRequest as request } from './services/network'

import { InputHelper, InputDelivery, InputObservation, ContextHelper, UtilHelper, KeyboardHelper, type KeyEvent } from './native/ffi'
import { HotkeyStateMachine, parseShortcutString, type HotkeyBinding } from './services/hotkey'
import { ShortcutCapture, focusedKeyEvent } from './services/shortcut-capture'
import { CaptureSession } from './services/capture-session'
import { jsonObject } from './services/voice-context'
import { dispatchRecordingHotkey, reconcileCaptureState, bindRecordingPowerEvents } from './services/recording-controls'
import { registerDesktop, readPreferences } from './services/desktop'
import { resolveSkill } from '../shared/skills'
import { registerSkillActions } from './services/skill-actions'
import { SelectionActions } from './services/selection-actions'
import { desktopUpdater, recoverUpdateInstall, registerUpdater } from './services/updater'
import { registerSettingsBackup } from './services/settings-backup'
import { DictionarySync, registerDictionarySync } from './services/dictionary-sync'
import { OutputAudioControl } from './services/output-audio'
import { FloatingBarPositioner } from './services/floating-bar-position'
import { readFloatingBar } from '../shared/floating-bar'
import { resolveOutputPreferences } from '../shared/output-preferences'
import { HistoryLifecycle, readStoredAudio } from './services/history-lifecycle'
import { AudioStorage } from './services/audio-storage'
import { registerAudioStorage } from './services/audio-storage-ipc'
import { deliverToInput } from './services/input-delivery'
import { readInputDiagnostics, recordInputDiagnostic, inputDiagnosticReason } from './services/input-diagnostics'
import { capturedContext } from './services/capture-context'
import { AnswerCardSession } from './services/answer-card'
import { InputCorrections } from './services/input-corrections'
import { analyzeInputCorrection } from './services/correction-intelligence'
import { errorMessage, type CardPayload, type VoiceState } from '../shared/desktop'
import { AudioEncoder } from './services/audio'
import { HistoryRepo, DictionaryRepo, CorrectionRepo, initDatabase, closeDatabase } from './db'
import { AuthService, type AuthUser } from './services/auth'
import { SyncEngine, type SyncRecord } from './services/sync'
import { syncScope } from './services/sync-scope'
import { serviceEndpoint, serviceToken, networkSettingsPatch } from '../shared/network-policy'
import { OFFICIAL_BACKEND_URL } from '../shared/official-backend'
import { migrateOfficialBackend } from './services/official-backend'
import { registerRendererBridge } from './services/renderer-bridge'
import { startCallbackServer, type CallbackServer } from './services/callback-server'
import type { SpeechProvider } from './services/providers/types'
import { createProvider } from './services/providers'
import { resolveAsrLanguage } from './services/languages'
import { SecureConfigStore } from './services/secure-store'
import { applyPendingRefinement, REFINEMENT_SETUP_FILE } from './services/refinement-setup'
import { LocalAsrProcess } from './services/local-asr/process'
import { NativeLocalProvider } from './services/providers/native-local'
import { AppleSpeechProcess, AppleSpeechProvider } from './services/providers/apple-speech'
import { SenseVoiceModelStore } from './services/local-asr/model-store'
import { withModelReadiness } from './services/local-asr/ready-engine'
import { resolveProfilePaths } from './services/profile'
import { toFrontendHistory, fromFrontendHistory, paginate, toFrontendSyncUiStatus } from './services/frontend-shape'
import {
  parseDictionaryCsv, DICTIONARY_CSV_MAX_BYTES,
  type DictionaryCsvParseResult
} from './services/dictionary-csv'

// MARK: - 配置持久化
/**
 * 三模式快捷键绑定。默认值：
 * macOS 用 Fn；Windows 用右 Ctrl 听写，避免裸 Alt 打开应用菜单。
 * Fn 的优势是不与任何现有快捷键冲突，且位于键盘角落、单手可达。
 */
interface ShortcutBindings {
  dictationMode: HotkeyBinding
  askAnythingMode: HotkeyBinding
  translationMode: HotkeyBinding
}

interface AppConfig {
  mode: 'voice_transcript' | 'voice_command' | 'voice_translation'
  shortcuts: ShortcutBindings
  outputLanguage: string
  autoInject: boolean
  micDeviceId: string
  blacklistDomains: string[]
  /**
   * 转写后端地址。
   *
   * 兼容自建网关；SiliconFlow 使用固定的官方地址，不读取此配置。
   */
  apiBaseUrl: string

  /**
   * 账号与云端同步的后端地址。
   *
   * 与 apiBaseUrl 分开：转写可以完全本地，而账号/同步需要服务端。
   * 这样「本地转写 + 云端账号」的组合才成立。
   */
  cloudBaseUrl: string

  historyRetentionDays: number
  /**
   * 语音识别后端。
   * - custom：自建服务端协议，一次调用完成转写+润色
   * - openai：OpenAI 兼容协议，两次调用（转写 + 润色）
   * - local：本机 SenseVoice Small，文字整理独立配置
   * - siliconflow：硅基流动 SenseVoice Small，文字整理独立配置
   */
  provider: 'custom' | 'openai' | 'local' | 'siliconflow' | 'apple'
  appleSpeechLanguage: string
  /** OpenAI/本地 provider 的模型名 */
  sttModel: string
  /** 独立的官方文字润色服务；不复用 ASR 密钥 */
  refineModel: string
  refineBaseUrl: string
  refineApiKey: string
  /** 是否启用润色 */
  enableRefine: boolean
  /** OpenAI 兼容服务的 API Key（本地服务通常不需要） */
  apiKey: string
  /** SiliconFlow 专用密钥，不与兼容网关或文字整理复用。 */
  siliconflowApiKey: string
  /** 是否已完成首次引导。未完成时启动显示主窗口。 */
  hasOnboarded: boolean
}

/**
 * electron-store 是 CJS/ESM 双入口包，在 Electron 33（内置 Node 20）下
 * 静态 import 会让 ESM 加载器在预解析阶段崩溃。
 * 这里改为运行时动态导入，把模块解析推迟到 ready 之后。
 */
type StoreInstance = {
  store: AppConfig
  get<K extends keyof AppConfig>(key: K): AppConfig[K]
  set(values: Partial<AppConfig>): void
}

let store: StoreInstance | null = null

const DEFAULT_CONFIG = {
    mode: 'voice_transcript',
    // 旧配置保留 toggle 表示；实际触发方式由 recordingActivation 偏好统一控制。
    shortcuts: {
      dictationMode: { key: 'Fn', modifiers: [], pushToTalk: false },
      askAnythingMode: { key: 'Space', modifiers: ['Fn'], pushToTalk: false },
      translationMode: { key: 'Shift', modifiers: ['Fn'], pushToTalk: false }
    },
    outputLanguage: 'en',
    autoInject: true,
    micDeviceId: 'default',
    blacklistDomains: [],
  // 仅用于兼容网关；云端与本机 SenseVoice 均不读取此地址。
  apiBaseUrl: 'http://127.0.0.1:8090',
  // 账号与云端同步走 OpenType 服务端
  cloudBaseUrl: OFFICIAL_BACKEND_URL,
  historyRetentionDays: 90,
  provider: 'siliconflow',
  appleSpeechLanguage: 'auto',
  sttModel: 'sensevoice-small-int8',
  refineModel: 'deepseek-flash',
  refineBaseUrl: 'https://api.deepseek.com',
  refineApiKey: '',
  enableRefine: true,
  apiKey: '',
  siliconflowApiKey: '',
  hasOnboarded: false
}

async function initStore(): Promise<void> {
  const { default: Store } = await import('electron-store')
  const backend = new Store({
    name: 'opentype-config',
    // Old profiles without an explicit provider must keep their former local
    // behavior. Only a genuinely new profile defaults to uploading audio.
    defaults: existsSync(join(app.getPath('userData'), 'opentype-config.json'))
      ? { ...DEFAULT_CONFIG, provider: 'local', cloudBaseUrl: '' }
      : DEFAULT_CONFIG
  })
  store = new SecureConfigStore(backend, safeStorage, (issue) => {
    console.warn('[opentype] credential storage:', issue)
    void dialog.showMessageBox({
      type: 'warning', title: 'OpenType 安全存储',
      message: issue === 'session_only'
        ? '系统安全存储暂不可用。登录信息和 API Key 仅保留到本次退出，重启后需重新填写。'
        : '无法解锁已保存的登录信息或 API Key。请解锁系统钥匙串后重启 OpenType，或重新登录。',
      buttons: ['知道了']
    })
  }) as unknown as StoreInstance
  migrateOfficialBackend(store as unknown as SecureConfigStore)
  if (store.get('provider') === 'local') store.set({ sttModel: 'sensevoice-small-int8' })
  try {
    await applyPendingRefinement(join(app.getPath('userData'), REFINEMENT_SETUP_FILE), safeStorage,
      { set: values => store!.set(values as Partial<AppConfig>),
        isPersistedSecret: key => (store as unknown as SecureConfigStore).isPersistedSecret(key) })
  } catch {
    console.warn('[opentype] saved refinement setup could not be imported; encrypted setup retained for retry')
  }
}

const getConfig = (): AppConfig => ({ ...(store?.store ?? DEFAULT_CONFIG), cloudBaseUrl: OFFICIAL_BACKEND_URL } as AppConfig)
const getPublicConfig = () => {
  const c = getConfig()
  // Only settings used by the renderer cross this boundary, never store namespaces or secrets.
  return { mode:c.mode, shortcuts:effectiveShortcuts(), outputLanguage:c.outputLanguage, autoInject:c.autoInject,
    micDeviceId:c.micDeviceId, blacklistDomains:c.blacklistDomains, apiBaseUrl:c.apiBaseUrl,
    cloudBaseUrl:c.cloudBaseUrl, historyRetentionDays:c.historyRetentionDays, provider:c.provider, appleSpeechLanguage:c.appleSpeechLanguage ?? 'auto',
    sttModel:c.sttModel, refineModel:c.refineModel, refineBaseUrl:c.refineBaseUrl,
    enableRefine:c.enableRefine, hasOnboarded:c.hasOnboarded, hasRefineApiKey:!!c.refineApiKey,
    hasApiKey:!!c.apiKey, hasSiliconflowApiKey:!!c.siliconflowApiKey }
}

/**
 * 从前端写入的 app-settings 中推导 ASR 语言提示。
 *
 * 前端把用户勾选的识别语言存在 `app-settings.selectedLanguages`（BCP-47 数组）。
 * 勾一个语言时把它作为强提示，勾多个（或没勾）时交给 ASR 自动检测。
 *
 * 识别语言独立于翻译目标；多选或未选择时使用模型自动检测。
 */
function resolveAsrLanguageFromStore(): string {
  try {
    const settings = (store?.get('app-settings' as never) ?? {}) as Record<string, unknown>
    const selected = settings.selectedLanguages
    if (Array.isArray(selected) && selected.length > 0) {
      return resolveAsrLanguage(selected.filter((x): x is string => typeof x === 'string'))
    }
  } catch { /* store 未就绪时退回自动检测 */ }
  return 'auto'
}

/** 快捷键名 → 采集模式。按键本身决定模式，用户无需先进设置切换。 */
const BINDING_TO_MODE: Record<keyof ShortcutBindings, AppConfig['mode']> = {
  dictationMode: 'voice_transcript',
  askAnythingMode: 'voice_command',
  translationMode: 'voice_translation'
}

/**
 * 读取渲染层设置页写入的快捷键覆盖。
 *
 * 渲染层把设置存在 store:use 的 app-settings.featureShortcutBindings，
 * 形状是 { dictationMode: ['Fn+Space', ...], ... }（动作 → 快捷键字符串数组，
 * 所有有效项参与全局触发；公开配置仍保留第一个有效项作为主快捷键。
 */
function rendererShortcuts(action: keyof ShortcutBindings | 'pasteLastTranscript' | 'selectionActions'): HotkeyBinding[] {
  const settings = (store?.get('app-settings' as never) ?? {}) as Record<string, unknown>
  const list = (settings.featureShortcutBindings as Record<string, unknown> | undefined)?.[action]
  return Array.isArray(list) ? list.slice(0, 3).flatMap(value => {
    const parsed = typeof value === 'string' ? parseShortcutString(value) : null
    return parsed ? [parsed] : []
  }) : []
}
function rendererShortcutOverride(action: keyof ShortcutBindings): HotkeyBinding | null {
  return rendererShortcuts(action)[0] ?? null
}

/**
 * 有效快捷键绑定：渲染层设置优先，顶层 config.shortcuts 兜底。
 *
 * 渲染层设置页改写的是 app-settings.featureShortcutBindings，若主进程只读
 * config.shortcuts，用户在设置页改的热键永远不生效。
 */
function effectiveShortcuts(): ShortcutBindings {
  const defaults = getConfig().shortcuts
  return {
    dictationMode: rendererShortcutOverride('dictationMode') ?? defaults.dictationMode,
    askAnythingMode: rendererShortcutOverride('askAnythingMode') ?? defaults.askAnythingMode,
    translationMode: rendererShortcutOverride('translationMode') ?? defaults.translationMode
  }
}

/** 把三个模式的绑定摊平成状态机可用的列表。 */
function activeBindings(): HotkeyBinding[] {
  const settings = (store?.get('app-settings' as never) ?? {}) as Record<string, unknown>
  const activation = readPreferences(settings).recordingActivation
  const defaults = effectiveShortcuts()
  return [
    ...Object.keys(BINDING_TO_MODE).flatMap(action => {
      const key = action as keyof ShortcutBindings, bindings = rendererShortcuts(key)
      return (bindings.length ? bindings : [defaults[key]]).map(binding => ({ ...binding, activation, actionId: action }))
    }),
    ...rendererShortcuts('pasteLastTranscript').map(binding => ({ ...binding, activation: 'toggle' as const, actionId: 'pasteLastTranscript' })),
    ...rendererShortcuts('selectionActions').map(binding => ({ ...binding, activation: 'toggle' as const, actionId: 'selectionActions' })),
  ]
}

/**
 * 首次启动时把平台默认快捷键写进 app-settings.featureShortcutBindings。
 *
 * 渲染层浮窗的快捷键匹配（UfR9-a2Z.js 的 If hook）只认这个键，没有任何
 * 内置兜底——上游应用的首启迁移会写它，我们不写的话候选列表恒为空，
 * 表现为热键状态机已触发但浮窗不录音（最终以 too_short 取消）。
 * 值与渲染层 tn 表（UfR9-a2Z.js）逐平台一致。
 */
/** 平台默认快捷键表（与渲染层 tn 表一致）。 */
function platformDefaultShortcuts(): Record<string, string[]> {
  return process.platform === 'darwin'
    ? { dictationMode: ['Fn'], askAnythingMode: ['Fn+Space'], translationMode: ['Fn+LeftShift'], pasteLastTranscript: ['Ctrl+Cmd+V'], selectionActions: [] }
    : process.platform === 'win32'
      ? { dictationMode: ['RightCtrl'], askAnythingMode: ['Ctrl+F8'], translationMode: ['Ctrl+F9'], pasteLastTranscript: ['LeftCtrl+RightShift+V'], selectionActions: [] }
    : { dictationMode: ['RightAlt'], askAnythingMode: ['RightAlt+Space'], translationMode: ['RightAlt+RightShift'], pasteLastTranscript: ['LeftCtrl+RightShift+V'], selectionActions: [] }
}

/**
 * 首启播种 + 每次启动时修复 app-settings.featureShortcutBindings。
 *
 * 渲染层浮窗的热键匹配只认这个键，没有任何兜底——上游应用的首启迁移会写它。
 * 修复规则：整个键缺失 → 全量播种；单个动作的数组缺失/为空/全不可解析 →
 * 该动作回落默认（设置页录入器可能把按键误捕获成无效值或清空数组——
 * 空数组在主进程会回落默认，但渲染层直接拿空数组当「无绑定」，两边就不一致了）。
 * 非空的用户自定义值一律保留。
 */
function seedFeatureShortcutBindings(): void {
  const all = (store?.get('app-settings' as never) ?? {}) as Record<string, unknown>
  const defaults = platformDefaultShortcuts()
  const current = (all.featureShortcutBindings ?? {}) as Record<string, unknown>
  const repaired: Record<string, string[]> = { ...defaults }
  for (const action of Object.keys(defaults)) {
    const list = current[action]
    if (['pasteLastTranscript','selectionActions'].includes(action) && Array.isArray(list) && list.length === 0) { repaired[action] = []; continue }
    if (Array.isArray(list) && list.some((s) => typeof s === 'string' && parseShortcutString(s))) {
      repaired[action] = list as string[]
    }
  }
  store?.set({ 'app-settings': { ...all, featureShortcutBindings: repaired } } as never)
}

/**
 * 采集前台上下文，产出渲染层期望的形状。
 *
 * 键名是契约：渲染层读 appInfo.app_identifier / inputInfo（qA149QP2.mjs），
 * 不能沿用原生层的 appName/bundleId 驼峰。
 */
function collectFocusedContext(): { appInfo: Record<string, unknown> | null; inputInfo: Record<string, unknown> | null } {
  let appInfo: Record<string, unknown> | null = null
  let inputInfo: Record<string, unknown> | null = null
  try {
    const a = ContextHelper.getFocusedAppInfo()
    if (a) {
      appInfo = { app_name: a.appName, app_identifier: a.bundleId, pid: a.pid, window_title: '' }
    }
  } catch { /* 原生层失败按无上下文处理 */ }
  try {
    const i = ContextHelper.getFocusedInputInfo()
    if (i?.success) {
      inputInfo = {
        role: i.role ?? '',
        selected_text: i.selectedText ?? '',
        surrounding_text: i.surroundingText ?? '',
        web_url: i.web?.url ?? '',
        web_title: i.web?.title ?? ''
      }
    }
  } catch { /* 同上 */ }
  return { appInfo, inputInfo }
}

/** 由触发的绑定反查应使用的模式。 */
function modeForBinding(b: HotkeyBinding): AppConfig['mode'] | null {
  if (b.actionId && b.actionId in BINDING_TO_MODE) return BINDING_TO_MODE[b.actionId as keyof ShortcutBindings]
  const shortcuts = effectiveShortcuts()
  for (const key of Object.keys(BINDING_TO_MODE) as Array<keyof ShortcutBindings>) {
    const candidate = shortcuts[key]
    if (candidate.key === b.key && candidate.keyCode === b.keyCode && candidate.pushToTalk === b.pushToTalk
        && candidate.modifiers.length === b.modifiers.length
        && candidate.modifiers.every((m) => b.modifiers.includes(m))) {
      return BINDING_TO_MODE[key]
    }
  }
  return null
}

/** 首次引导是否已完成。未完成时主窗口应显示 onboarding 页而不是登录页。 */
function hasCompletedOnboarding(): boolean {
  return Boolean(store?.get('hasOnboarded' as keyof AppConfig))
}

/**
 * 当前会话模式。按下的快捷键决定本次采集模式，
 * 同时写回配置以便 UI 与后续请求一致。
 */
let sessionMode: AppConfig['mode'] = 'voice_transcript'

/**
 * 渲染层 recording-machine:set-disabled 的用户态开关（会话级，不持久化）。
 *
 * onboarding 各步骤挂载时禁用、卸载/完成时启用（DdHsgR7k.js 的 oe()），
 * 所以默认必须是 false（启用）：hub 从不调用这个通道，若默认禁用，
 * 录音会被永久锁死。complete-onboarding 时也会复位。
 */
let recordingUserDisabled = false

// MARK: - 窗口
let barWindow: BrowserWindow | null = null
let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null
let interactiveWindow: BrowserWindow | null = null
let callbackServer: CallbackServer | null = null
let pendingCardPayload: unknown = null
let cardBoundsTimer: NodeJS.Timeout | null = null
let barPositioner: FloatingBarPositioner | undefined
let outputAudio: OutputAudioControl | undefined
let outputAudioSession: string | undefined
let currentVoiceState: VoiceState | undefined
let outputAudioNotice = ''
let selectionActions: SelectionActions | undefined
const floatingBarPreferences = () => readFloatingBar(((store?.get('app-settings' as never) ?? {}) as Record<string, unknown>).floatingBar)

/**
 * 渲染层资源根目录。
 *
 * 开发态从项目根取，打包后从 resources 取。
 * 直接使用既有前端产物 —— 界面、交互、文案保持一致。
 */
/**
 * 前端页面枚举。
 *
 * 关键：登录态决定加载哪个页面 —— 未登录是 LOGIN，登录后是 HUB。
 * 这不是同一页面的两个状态，而是两个独立 HTML 入口。
 */
/** All shipping windows load the same source-built renderer and explicit preload. */
function rendererRoot(): string { return join(__dirname, '../renderer') }
function rendererPreload(): string { return join(__dirname, '../preload/index.js') }
function rendererDevUrl(): string | undefined {
  const devUrl = !app.isPackaged ? process.env.OPENTYPE_RENDERER_URL : undefined
  return devUrl && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(devUrl) ? devUrl : undefined
}
function loadRenderer(win: BrowserWindow, page: string): void {
  const devUrl = rendererDevUrl()
  if (devUrl) void win.loadURL(`${devUrl}/${page}`)
  else void win.loadFile(join(rendererRoot(), page))
}
/** Privileged windows may only show the app's own renderer pages (file:// build, or the dev server origin). */
function isAppRendererUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const devUrl = rendererDevUrl()
    if (devUrl) return url.origin === new URL(devUrl).origin
    if (url.protocol !== 'file:') return false
    // fileURLToPath throws on remote hosts (file://evil.com/…) and encoded separators; treated as foreign.
    const path = relative(rendererRoot(), fileURLToPath(url))
    return path !== '' && !path.startsWith('..') && !isAbsolute(path)
  } catch {
    return false
  }
}

/** 外部链接统一交系统浏览器，应用内不弹新窗口（浮窗/卡片里的链接同理）。 */
function redirectExternalLinks(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

function createBarWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    icon: join(app.getAppPath(), 'build/icon.png'),
    height: 104,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 关键：不抢焦点。否则录音浮窗一出现就会让目标应用的输入框失焦，
    // 松开热键后注入的文本会丢失落点。
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: rendererPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform !== 'win32') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  redirectExternalLinks(win)
  win.webContents.on('render-process-gone',()=>pipeline?.onCancel())
  loadRenderer(win, 'floating-bar.html')
  return win
}

/** One source-built entry renders onboarding and the local hub without an account gate. */
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1080,
    icon: join(app.getAppPath(), 'build/icon.png'),
    height: 720,
    minWidth: 780,
    minHeight: 580,
    backgroundColor: '#ffffff',
    title: 'OpenType',
    // 沉浸式顶部：隐藏原生标题栏，红绿灯内嵌进内容区。
    // Drag region and traffic-light spacing are owned by app.css.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 12 } } : {}),
    webPreferences: {
      preload: rendererPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // 外部链接（关于页的法律链接、分享链接等 target=_blank）一律交系统浏览器，
  // 不允许在应用内弹新窗口——否则用户会看到一个带原生框的裸 JSON/404 页。
  redirectExternalLinks(win)

  // 关闭后必须清引用：否则 open-entry-window 的 `??=` 会拿到已销毁窗口，
  // 直接抛 "Object has been destroyed"。
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })

  loadRenderer(win, 'index.html')
  return win
}

/** 登录态变化后重新加载主窗口到正确的页面。 */
function reloadMainWindowForAuthState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  loadRenderer(mainWindow, 'index.html')
}

/**
 * 登录成功后的统一收尾（深链接与本地回调服务共用）。
 *
 * onboarding 的 SIGN_UP 步内完成登录时不能整页 reload——
 * 那会把引导重置回第一步。改为发 user-state-change 事件，
 * 渲染层收到 {action:'login'} 后自己拉取用户数据并推进到下一步。
 */
function onLoginSuccess(): void {
  mainWindow ??= createMainWindow()
  mainWindow.show()
  if (!hasCompletedOnboarding()) {
    mainWindow.webContents.send('auth:app-login-loading-changed', false)
    mainWindow.webContents.send('user-state-change', { action: 'login' })
  } else {
    // 关键：切换到 HUB 页面。只发事件不够——前端是独立页面，
    // 登录页不知道「已登录」该显示什么。
    reloadMainWindowForAuthState()
  }
  void sync.pushNow()
}

/**
 * 交互卡片窗口：展示 AI 回答（ask_anything 模式的结果）。
 *
 * 尺寸常量：最小 120、最大 700，内容高度由渲染层上报。
 * 显示在鼠标所在显示器，避免多屏时出现在错误的屏幕。
 */
const CARD_MIN_HEIGHT = 120    // Short fallback messages should not leave empty space below the card.
const CARD_MAX_HEIGHT = 0x2bc   // 700

function createInteractiveWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    icon: join(app.getAppPath(), 'build/icon.png'),
    height: CARD_MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: rendererPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  redirectExternalLinks(win)
  loadRenderer(win, 'interactive-card.html')
  return win
}

/** 打开或更新卡片。已存在则复用窗口，避免闪烁。 */
function displayInteractiveCard(payload: CardPayload): void {
  pendingCardPayload = payload
  if (interactiveWindow && !interactiveWindow.isDestroyed()) {
    interactiveWindow.webContents.send('interactive-card:update', payload)
    interactiveWindow.showInactive()
    return
  }
  const window = interactiveWindow = createInteractiveWindow()
  window.once('ready-to-show', () => {
    if (interactiveWindow !== window || !pendingCardPayload) return
    window.webContents.send('interactive-card:update', pendingCardPayload)
    window.showInactive()
  })
  window.on('closed', () => {
    if (interactiveWindow === window) { interactiveWindow = null; answerCards.close(); selectionActions?.close(); pendingCardPayload = null }
  })
}

const answerCards = new AnswerCardSession({
  show: displayInteractiveCard,
  release: token => InputHelper.releaseTarget(token),
  deliver: (token, text, signal) => { inputCorrections.stop(); return deliverToInput(InputDelivery, { token }, text, signal) },
  validate: async payload => {
    if (pipeline?.isBusy) throw new Error('answer_recording_busy')
    if (payload.origin === 'selection' && !payload.audioId) return
    const row = payload.audioId ? await HistoryRepo.byId(payload.audioId) : null
    if (!row || row.status !== 'completed' || row.refinedText !== payload.text
      || (row.editedText !== null && row.editedText !== payload.text)) throw new Error('answer_record_changed')
  },
  saveDelivery: async (payload, outcome) => {
    if (payload.audioId && await HistoryRepo.recordInputDelivery(payload.audioId, payload.text, outcome)) historyChanged()
  },
})
function closeInteractiveCard(): void {
  selectionCapture?.abort(); selectionCapture = undefined
  selectionActions?.close(); answerCards.close(); pendingCardPayload = null; interactiveWindow?.hide()
}
function openInteractiveCard(payload: unknown): void {
  selectionActions?.close()
  const p = payload && typeof payload === 'object' ? payload as Partial<CardPayload> : {}
  answerCards.present({ text: typeof p.text === 'string' ? p.text : '',
    title: typeof p.title === 'string' ? p.title : undefined, audioId: typeof p.audioId === 'string' ? p.audioId : undefined })
}

/**
 * 更新卡片高度。渲染层上报内容高度，这里做防抖 + 夹取到合法区间。
 *
 * 防抖必要：内容高度在流式输出时会频繁变化，
 * 每次都调 setBounds 会导致窗口抖动。
 */
function updateCardBounds(bounds: unknown): void {
  if (cardBoundsTimer) clearTimeout(cardBoundsTimer)
  cardBoundsTimer = setTimeout(() => {
    cardBoundsTimer = null
    if (!interactiveWindow || interactiveWindow.isDestroyed()) return

    const h = (bounds as { height?: number })?.height
    if (typeof h !== 'number' || !Number.isFinite(h)) return

    const clamped = Math.max(CARD_MIN_HEIGHT, Math.min(CARD_MAX_HEIGHT, Math.round(h)))
    const current = interactiveWindow.getBounds()
    if (current.height === clamped) return

    // 显示在鼠标所在显示器，避免多屏时出现在错误屏幕
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { x, y, width } = display.workArea
    const winWidth = current.width
    const posX = Math.round(x + width / 2 - winWidth / 2)
    const posY = Math.round(y + 80)

    interactiveWindow.setBounds({ x: posX, y: posY, width: winWidth, height: clamped })
  }, 120)
}

// MARK: - 服务装配
const encoder = new AudioEncoder([
  join(process.resourcesPath ?? '', 'lib', 'libopusenc.dylib'),
  join(app.getAppPath(), 'native', 'libopusenc.dylib')
])

/**
 * 认证服务。userData 与前端的会话副本均经 SecureConfigStore 使用系统密钥加密。
 */
let auth: AuthService
let serviceUserId: string | null = null
let dictionarySync: DictionarySync | undefined
function createAuthService(): AuthService {
  return new AuthService({
    // 认证必须走云端后端，不能走本机网关
    onUserChanged: (user) => {
      const id = user?.user_id ?? null
      if (id !== serviceUserId) {
        serviceUserId = id
        sync?.invalidateSession()
        dictionarySync?.refreshAccount()
        pipeline?.dispose()
      }
    },
    apiBaseUrl: getConfig().cloudBaseUrl,
    webBaseUrl: getConfig().cloudBaseUrl,
    appVersion: app.getVersion(),
    load: async () => {
      const raw = store?.get('userData' as keyof AppConfig) as unknown as string | undefined
      if (!raw) return null
      try {
        const user = JSON.parse(raw) as AuthUser
        if (user.server_url && user.server_url !== OFFICIAL_BACKEND_URL) return null
        return user
      } catch { return null }
    },
    save: async (user) => {
      store?.set({ userData: user ? JSON.stringify({ ...user, server_url: OFFICIAL_BACKEND_URL }) : '' } as unknown as Partial<AppConfig>)
    }
  })
}

/**
 * 语音识别 provider。
 *
 * 严格使用用户选择的协议；云端模式不准备本地模型，也不隐式切换服务。
 */
let appleSpeech: AppleSpeechProcess | undefined
function getAppleSpeech() {
  return appleSpeech ??= new AppleSpeechProcess(app.isPackaged
    ? join(process.resourcesPath, 'lib/apple-speech/build/AppleSpeech')
    : join(app.getAppPath(), 'native/apple-speech/build/AppleSpeech'))
}
let nativeAsr: LocalAsrProcess | undefined
let localModels: SenseVoiceModelStore | undefined
let configGeneration = 0
function getLocalModels() {
  return localModels ??= new SenseVoiceModelStore(!app.isPackaged
    ? join(app.getAppPath(), 'gateway/models/sensevoice-int8')
    : join(app.getPath('userData'), 'models/sensevoice-int8'), undefined, `OpenType/${app.getVersion()}`)
}
function prepareLocalModels() {
  // Selecting local may reuse the bundled model offline. Download is still an
  // explicit settings action, and cloud-only startup never touches model files.
  return app.isPackaged
    ? getLocalModels().importBundle(join(process.resourcesPath, 'models/sensevoice-int8'))
    : getLocalModels().check()
}
let skillActions: ReturnType<typeof registerSkillActions> | undefined
let speechSettingsWindow: BrowserWindow | null = null
function showSpeechSettings() {
  if (speechSettingsWindow && !speechSettingsWindow.isDestroyed()) { speechSettingsWindow.show(); return }
  speechSettingsWindow = new BrowserWindow({ width: 780, height: 840, minWidth: 620, minHeight: 640,
    icon: join(app.getAppPath(), 'build/icon.png'),
    title: 'OpenType 听写设置', backgroundColor: '#f5f7f4',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  speechSettingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  speechSettingsWindow.webContents.on('will-navigate', event => event.preventDefault())
  speechSettingsWindow.on('closed', () => { speechSettingsWindow = null })
  void speechSettingsWindow.loadFile(join(__dirname, '../renderer/speech-settings.html'))
}
function buildProvider(): SpeechProvider {
  const c = getConfig()
  const authService = auth
  const refinement = { provider: 'deepseek' as const, baseUrl: c.refineBaseUrl,
    apiKey: c.refineApiKey, model: c.refineModel, enabled: c.enableRefine }
  if (c.provider === 'apple') {
    nativeAsr?.dispose(); localModels?.dispose()
    return new AppleSpeechProvider(getAppleSpeech(), refinement, c.appleSpeechLanguage ?? 'auto')
  }
  if (c.provider !== 'local') {
    nativeAsr?.dispose()
    appleSpeech?.dispose()
    localModels?.dispose()
    return createProvider({
      kind: c.provider,
      baseUrl: c.apiBaseUrl,
      apiKey: c.apiKey,
      siliconflowApiKey: c.siliconflowApiKey,
      model: c.sttModel,
      refine: c.enableRefine,
      refineModel: c.refineModel,
      refinement,
      appVersion: app.getVersion(),
      getToken: () => serviceToken(c.apiBaseUrl, c.cloudBaseUrl, () => authService.getAccessToken()),
      getDeviceId: () => UtilHelper.getDeviceId()
    })
  }

  const models = getLocalModels()
  nativeAsr ??= new LocalAsrProcess(() => {
    const child = utilityProcess.fork(join(__dirname, 'sensevoice-worker.js'), [], { serviceName: 'OpenType Local ASR', stdio: 'pipe' })
    child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {})
    return child
  }, models.directory)
  return new NativeLocalProvider(withModelReadiness(nativeAsr, models), refinement)
}

/**
 * 云端同步引擎。
 *
 * 转写走本地网关，同步走云端后端——两者地址不同，所以这里用 cloudBaseUrl。
 * 账号切换时由 onUserChanged 触发 invalidateSession，作废在途任务。
 */
/**
 * 同步引擎当前阶段。
 *
 * 前端用 get-ui-status 主动查询同步状态，而引擎的阶段变化是事件推送，
 * 两者之间需要这个变量搭桥：没有它，查询永远返回 idle。
 */
let syncPhase = 'idle'

/** 在途推送批次的进度（本地引擎驱动，见 SyncEngine.pushNow 的契约注释）。 */
let syncPushTotal = 0
let syncPushCompleted = 0

let sync: SyncEngine
function createSyncEngine(): SyncEngine {
  const baseUrl = syncScope(getConfig().cloudBaseUrl)
  const account = (userId: string) => ({ userId, serverUrl: baseUrl })
  return new SyncEngine({
    baseUrl,
    appVersion: app.getVersion(),
    getToken: () => auth.getAccessToken(),
    getUserId: () => auth.userId,
    loadSyncBlocked: (userId) => {
      const blocked = (store?.get('syncBlockedUsers' as never) ?? {}) as Record<string, boolean>
      return blocked[`${baseUrl}\n${userId}`] === true
    },
    saveSyncBlocked: (userId, disabled) => {
      const blocked = { ...((store?.get('syncBlockedUsers' as never) ?? {}) as Record<string, boolean>) }
      if (disabled) blocked[`${baseUrl}\n${userId}`] = true
      else delete blocked[`${baseUrl}\n${userId}`]
      store?.set({ syncBlockedUsers: blocked } as never)
    },
    loadPendingRecords: async (userId: string, limit: number, includeExhausted?: boolean) => {
      // 用 pendingSyncForApi 而非 pendingSync：前者把 drizzle 的 camelCase
      // 转成服务端期望的 snake_case，否则服务端读到 undefined
      return await HistoryRepo.pendingSyncForApi(userId, limit, includeExhausted, getConfig().blacklistDomains, baseUrl) as unknown as SyncRecord[]
    },
    markSynced: async (ids: string[]) => {
      await HistoryRepo.markSynced(ids)
    },
    markFailed: async (ids: string[]) => {
      await HistoryRepo.markSyncFailed(ids)
    },
    releasePushed: ids => HistoryRepo.releasePushedVersions(ids),
    loadPendingDeletions: (userId, limit, retryFailed) => HistoryRepo.pendingCloudDeletions(account(userId), limit, retryFailed),
    countPendingDeletions: userId => HistoryRepo.cloudDeletionCount(account(userId)),
    markDeletions: (userId, ids, acknowledged) => HistoryRepo.markCloudDeletions(account(userId), ids, acknowledged),
    applyRemoteDeletions: (ids, userId) => historyLifecycle.applyRemoteDeletions(ids, account(userId)),
    loadCursor: userId => HistoryRepo.syncCursor(account(userId)),
    saveCursor: (userId, cursor) => HistoryRepo.saveSyncCursor(account(userId), cursor),
    applyCloudEpoch: (userId, epoch) => HistoryRepo.applyCloudEpoch(account(userId), epoch),
    applyCloudEvictions: (ids, userId) => HistoryRepo.applyCloudEvictions(account(userId), ids),
    beginCloudWipe: userId => HistoryRepo.beginCloudWipe(account(userId)),
    finishCloudWipe: (userId, id) => HistoryRepo.finishCloudWipe(account(userId), id),
    hasPendingCloudWipe: userId => HistoryRepo.hasPendingCloudWipe(account(userId)),
    cloudExcludedCount: userId => HistoryRepo.cloudExcludedCount(account(userId)),
    applyRemote: async (records: SyncRecord[], userId: string) => {
      if (await HistoryRepo.applyRemote(records as never, account(userId))) historyChanged()
    },
    onStateChange: (state) => {
      // 记住当前阶段：前端会主动查 get-ui-status，而事件是被动推送，
      // 不记下来查询时只能返回 idle，加载态就永远不出现。
      syncPhase = state.phase
      // 在途批次进度：只由本地引擎驱动。服务端 sync_status 里的 total 是
      // 云端累计条数，拿它当进度会让渲染层的同步条永远停在 0%（「一直在加载」）。
      syncPushTotal = state.total ?? 0
      syncPushCompleted = state.completed ?? 0
      barWindow?.webContents.send('sync:state-changed', state)
      mainWindow?.webContents.send('sync:state-changed', state)
      // 渲染层 hub 页实际订阅的是这个事件名（同步进度条），payload 形状
      // 与 get-ui-status 一致。sync:state-changed 保留：自有 UI 在用。
      const uiStatus = toFrontendSyncUiStatus({
        phase: state.phase,
        total: syncPushTotal,
        completed: syncPushCompleted
      })
      barWindow?.webContents.send('transcription-history-sync:ui-status-changed', uiStatus)
      mainWindow?.webContents.send('transcription-history-sync:ui-status-changed', uiStatus)
    }
  })
}

let pipeline: CaptureSession
let audioStorage: AudioStorage
let historyLifecycle: HistoryLifecycle
let shownCorrectionCapsuleId: string | undefined
const inputCorrections = new InputCorrections({
  native: InputObservation,
  enabled: () => ((store?.get('app-settings' as never) ?? {}) as Record<string, unknown>).learnFromInputEdits === true,
  scope: () => DictionaryRepo.scope(),
  allowed: (id, text, target) => !target.audioContext.redacted && CorrectionRepo.canObserve(id, text, getConfig().blacklistDomains, target.inputWebDomains),
  analyze: (before, after, signal) => {
    const c = getConfig()
    return analyzeInputCorrection(before, after, { provider: 'deepseek', baseUrl: c.refineBaseUrl,
      model: c.refineModel, apiKey: c.refineApiKey, enabled: c.enableRefine }, signal)
  },
  save: (id, text, corrected, target, scope, pairs, fallbackReason) => {
    if (DictionaryRepo.scope() !== scope) return false
    const result = CorrectionRepo.observeEdit(id, text, corrected, getConfig().blacklistDomains, target.inputWebDomains, pairs)
    if (result.active) {
      mainWindow?.webContents.send('desktop:history-changed')
      for (const candidateId of result.retractedIds) {
        barWindow?.webContents.send('desktop:correction-capsule-candidate', { candidate: null, candidateId, scope: result.scope })
      }
      if (result.candidate) {
        shownCorrectionCapsuleId = result.candidate.id
        clearTimeout(barHideTimer)
        barWindow?.webContents.send('desktop:correction-capsule-candidate', {
          candidate: result.candidate, scope: result.scope, analysisFallback: fallbackReason,
        })
        barWindow?.showInactive()
      }
    }
    return result.active
  },
  retract: id => {
    for (const candidateId of CorrectionRepo.dismissInputEdits(id)) {
      barWindow?.webContents.send('desktop:correction-capsule-candidate', { candidate: null, candidateId, scope: DictionaryRepo.scope() })
    }
  },
})
let barHideTimer: ReturnType<typeof setTimeout> | undefined
const pendingFlush = new Map<string, () => void>()
function historyChanged() {
  mainWindow?.webContents.send('desktop:history-changed')
  sync.schedulePush()
}
function createVoicePipeline(): CaptureSession {
  return new CaptureSession({
    provider: buildProvider(),
    notify: state => {
      if (state.phase === 'recording' && state.audioId && outputAudioSession !== state.audioId) {
        inputCorrections.stop()
        outputAudioSession = state.audioId; outputAudioNotice = ''
        const prefs = readPreferences((store?.get('app-settings' as never) ?? {}) as Record<string, unknown>)
        outputAudio?.start(state.audioId, prefs.outputAudio)
      } else if (!['recording', 'stopping'].includes(state.phase) && outputAudioSession) {
        outputAudioSession = undefined; outputAudio?.stop()
      }
      state = { ...state, audioNotice: outputAudioNotice || undefined }
      state = reconcileCaptureState(hotkeys, state)
      currentVoiceState = state
      barWindow?.webContents.send('capture:state-changed', state)
      if (state.level === undefined) mainWindow?.webContents.send('capture:state-changed', state)
      barPositioner?.preview(false) // the capsule no longer shows the preview panel
      if (['preparing', 'recording', 'stopping', 'encoding', 'uploading', 'transcribing', 'refining', 'injecting'].includes(state.phase)) {
        clearTimeout(barHideTimer); barWindow?.showInactive()
      } else if (['done', 'error', 'cancelled'].includes(state.phase)) {
        const hasCompletionNotice = state.phase === 'done' && Boolean(state.detail?.trim() || state.audioNotice?.trim())
        const hideDelay = state.phase === 'error' ? 4500 : hasCompletionNotice ? 1400 : 300
        clearTimeout(barHideTimer)
        barHideTimer = setTimeout(() => barWindow?.hide(), hideDelay)
      }
    },
    getConfig: () => ({...getConfig(), mode:sessionMode, asrLanguage:resolveAsrLanguageFromStore(), appVersion:app.getVersion()}),
    context: async (mode, signal, preview, traceId) => {
      lastPaste?.abort(); inputCorrections.stop(); closeInteractiveCard()
      // The home-page microphone preview never inserts into another app and
      // does not acquire an external input target or its context.
      if (preview) return capturedContext({ appName: '', bundleId: '', pid: 0, contextRedacted: true }, getConfig().blacklistDomains)
      const target = await captureVoiceTarget(mode === 'voice_command', signal, traceId)
      if (signal.aborted) { if (target.token) InputHelper.releaseTarget(target.token); signal.throwIfAborted() }
      barPositioner?.begin(target.windowBounds)
      return capturedContext(target, getConfig().blacklistDomains)
    },
    flush: id => new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pendingFlush.delete(id);reject(new Error('capture_flush_timeout'))},5000)
      pendingFlush.set(id,()=>{clearTimeout(timer);pendingFlush.delete(id);resolve()})
      barWindow?.webContents.send('capture:flush',id)
    }),
    saveAudio: (id, data) => historyLifecycle.saveAudio(id, 'wav', data),
    saveHistory: record=>HistoryRepo.upsert(record),
    loadHistory: id=>HistoryRepo.byId(id),
    inject: async (text, target, signal) => {
      const traceId = target.inputTraceId ?? ''
      recordInputDiagnostic(traceId, 'delivery-start')
      try {
        const result = await deliverToInput(InputDelivery, { token: target.inputToken, reason: target.inputError }, text, signal)
        recordInputDiagnostic(traceId, 'delivery-result', { status: result.status, method: result.method, reason: result.detail })
        return result
      } catch (error) {
        recordInputDiagnostic(traceId, 'delivery-failed', { reason: inputDiagnosticReason((error as Error).message) })
        throw error
      }
    },
    releaseTarget: target => { if (target.inputToken) InputHelper.releaseTarget(target.inputToken) },
    observeInput: (id, text, target) => inputCorrections.start(id, text, target),
    showFallback: (text, audioId) => openInteractiveCard({ text, audioId, title: '文字已生成，尚未插入' }),
    showCard: (text, audioId, target) => answerCards.present({ text, audioId, title: '随便问',
      contextNotice: target.audioContext.redacted ? '当前输入环境的文字未用于回答。' : undefined },
      target.inputToken && target.selectedText && !target.audioContext.redacted
        ? { token: target.inputToken, selectedText: target.selectedText, appName: target.appName } : undefined),
    changed: historyChanged,
    personalization: async target => {
      const p = readPreferences((store?.get('app-settings' as never) ?? {}) as Record<string, unknown>)
      const output = resolveOutputPreferences(p, target.bundleId)
      const skill = resolveSkill(p.skills, { bundleId: target.bundleId, mode: target.mode ?? 'voice_transcript',
        domain: String(target.audioContext?.web_domain ?? ''), redacted: target.audioContext?.redacted === true, skillId: target.skillId })
      if (!p.usePersonalStyle) output.expression = 'original'
      return {
        dictionary: (await DictionaryRepo.list(DictionaryRepo.scope())).slice(0, 200).map(w => ({ term: w.term, hint: w.pronunciation })),
        style: p.usePersonalStyle ? p.personalStyle : '',
        output_preferences: output,
        ...(skill ? { skill } : {}),
      }
    }
  })
}

let lastPaste: AbortController | undefined
let selectionCapture: AbortController | undefined
function captureVoiceTarget(allowReadOnly: boolean, signal: AbortSignal, traceId?: string) {
  signal.throwIfAborted()
  return InputHelper.captureTarget(allowReadOnly, traceId)
}
async function openSelectionActions() {
  if (pipeline.isBusy || shortcutCapture.active || powerLifecycle?.paused()) return
  lastPaste?.abort(); inputCorrections.stop(); closeInteractiveCard()
  const controller = new AbortController(); selectionCapture = controller
  let snapshot: ReturnType<typeof InputHelper.captureTarget> | undefined
  try {
    snapshot = await captureVoiceTarget(true, controller.signal)
    controller.signal.throwIfAborted()
    if (!selectionActions || pipeline.isBusy) return
    const target = capturedContext(snapshot, getConfig().blacklistDomains)
    selectionActions.present(target); snapshot = undefined
  } catch (error) {
    if (!controller.signal.aborted) openInteractiveCard({ title: '无法读取当前选区', text: errorMessage((error as Error).message) })
  } finally {
    if (snapshot?.token) InputHelper.releaseTarget(snapshot.token)
    if (selectionCapture === controller) selectionCapture = undefined
  }
}
async function pasteLastTranscript(): Promise<void> {
  if (pipeline.isBusy || lastPaste) return
  const controller = new AbortController()
  lastPaste = controller
  inputCorrections.stop(); closeInteractiveCard()
  let target: ReturnType<typeof InputHelper.captureTarget> | undefined
  let text = ''
  try {
    target = await captureVoiceTarget(false, controller.signal)
    controller.signal.throwIfAborted()
    const row = await HistoryRepo.latestTranscript()
    controller.signal.throwIfAborted()
    text = row?.editedText ?? row?.refinedText ?? ''
    if (!text.trim()) { openInteractiveCard({ title: '粘贴上一条听写', text: '还没有可粘贴的听写文字。请先完成一次听写。' }); return }
    // Wait for the trigger chord to be released before the target receives text.
    for (let n = 0; pressedKeys.size && n < 100; n++) {
      controller.signal.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (pressedKeys.size) throw new Error('请松开快捷键后重试，文字尚未粘贴。')
    const result = await deliverToInput(InputDelivery, target, text, controller.signal)
    if (result.status === 'unverified') openInteractiveCard({ title: '请核对粘贴结果', text, detail: result.detail })
  } catch (error) {
    if (!controller.signal.aborted) {
      const detail = (error as Error).message
      openInteractiveCard({ title: text ? '尚未粘贴，可复制文字' : '尚未粘贴',
        text: text || '无法读取上一条听写，请打开历史记录。', detail })
    }
  } finally {
    if (target?.token) InputHelper.releaseTarget(target.token)
    if (lastPaste === controller) lastPaste = undefined
  }
}

const hotkeys = new HotkeyStateMachine(event => {
  if (event.binding.actionId === 'selectionActions') {
    if (event.action === 'start' && !recordingUserDisabled && !powerLifecycle?.paused() && !shortcutCapture.active && !pipeline.isBusy) openSelectionActions()
    return false
  }
  if (event.binding.actionId === 'pasteLastTranscript') {
    if (event.action === 'start' && !recordingUserDisabled && !powerLifecycle?.paused() && !shortcutCapture.active && !pipeline.isBusy) void pasteLastTranscript()
    return false
  }
  const accepted = dispatchRecordingHotkey(event, {
  enabled: () => !recordingUserDisabled && !powerLifecycle?.paused() && !shortcutCapture.active,
  busy: () => pipeline.isBusy,
  recording: () => pipeline.isRecording,
  start: event => {
    const mode = modeForBinding(event.binding)
    if (mode) {
      sessionMode = mode
      store?.set({ mode } as Partial<AppConfig>)
      mainWindow?.webContents.send('config:changed', getPublicConfig())
    }
    void pipeline.onStart()
  },
  stop: () => { void pipeline.onStop() },
  cancel: () => pipeline.onCancel(),
  })
  if (accepted !== false) barWindow?.webContents.send('hotkey:state-changed', { action: event.action })
  return accepted
})

// MARK: - 全局按键快照（global-keyboard 事件）

/**
 * 当前按下的键。渲染层订阅的 global-keyboard 事件 payload 是
 * 「当前按下的键」的数组快照（设置页热键录入直接整体替换显示态），
 * 元素形状：{ keyCode, keyName, enKeyName, isKeydown, isBlocked, timestamp }。
 *
 * 原生层同时上报普通键、Fn 和左右修饰键，保留物理键码供录入器使用。
 */
const pressedKeys = new Map<number, {
  keyCode: number
  keyName: string
  enKeyName: string
  isKeydown: boolean
  isBlocked: boolean
  timestamp: number
}>()

/** 把原生按键事件维护进按下快照，并广播给订阅方。 */
function broadcastGlobalKeyboard(ev: KeyEvent): void {
  if (ev.type === 'keyDown') {
    // 系统自动重复不产生新状态，快照没变就不发，避免 IPC 刷屏
    if (pressedKeys.has(ev.keyCode)) return
    pressedKeys.set(ev.keyCode, {
      keyCode: ev.keyCode,
      keyName: ev.key,
      enKeyName: ev.key,
      isKeydown: true,
      isBlocked: false,
      timestamp: ev.timestamp || Date.now()
    })
  } else {
    if (!pressedKeys.delete(ev.keyCode)) return
  }
  const snapshot = [...pressedKeys.values()]
  for (const win of [barWindow, mainWindow, interactiveWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('global-keyboard', snapshot)
  }
}

/**
 * 启动全局键盘监听（幂等：原生层已运行时会直接返回 0）。
 * 裸事件流同时喂给热键状态机与渲染层按键快照。
 */
const shortcutCapture = new ShortcutCapture()
let powerLifecycle: ReturnType<typeof bindRecordingPowerEvents> | undefined

function cancelRecordingControls(options: { keepDictation?: boolean } = {}) {
  selectionCapture?.abort(); selectionCapture = undefined
  selectionActions?.close()
  inputCorrections.stop()
  lastPaste?.abort()
  hotkeys.reset()
  if (options.keepDictation) pipeline?.interrupt()
  else pipeline?.onCancel()
  pressedKeys.clear()
  shortcutCapture.end()
}

function startKeyboardMonitor(): number {
  return KeyboardHelper.startMonitor((ev) => {
    if (shortcutCapture.handle(ev)) return
    if (recordingUserDisabled || powerLifecycle?.paused()) return
    broadcastGlobalKeyboard(ev)
    if (ev.type === 'keyDown' && ['Escape','Esc'].includes(ev.key)) { lastPaste?.abort(); pipeline.onCancel(); closeInteractiveCard(); hotkeys.setBindings(activeBindings()); return }
    hotkeys.handle(ev)
  })
}

/** 快捷键变更后重载：重读有效绑定，再重启监听。 */
function reloadKeyboardShortcuts(options: { keepDictation?: boolean } = {}): void {
  cancelRecordingControls(options)
  hotkeys.setBindings(activeBindings())
  // 清掉按下快照：stop/start 间隙可能丢 keyUp，留着会让渲染层误以为键还按着
  pressedKeys.clear()
  KeyboardHelper.stopMonitor()
  if (powerLifecycle?.paused()) return
  const rc = startKeyboardMonitor()
  if (rc !== 0) {
    console.warn('[opentype] 键盘监听重启未就绪', rc, KeyboardHelper.getStatus())
  }
}

// MARK: - IPC 注册

/** 读回录音字节。找不到返回 null（调用方据此跳过播放/压缩）。 */
async function readAudioBytes(audioId: string): Promise<ArrayBuffer | null> {
  const buf = await readStoredAudio(join(app.getPath('userData'), 'audio'), audioId)
  return buf ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer : null
}

// MARK: - 文件对话框

/**
 * IPC 字节归一：渲染层传过来的二进制可能是 ArrayBuffer、Uint8Array、
 * Buffer，偶发 base64 字符串或 { data: number[] }（结构化克隆的边角）。
 * 统一转 Buffer；认不出来的返回 null。
 */
function toBuffer(data: unknown): Buffer | null {
  if (!data) return null
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (typeof data === 'string') {
    const m = data.match(/^data:.*?;base64,(.*)$/s)
    try { return Buffer.from(m ? m[1] : data, 'base64') } catch { return null }
  }
  const anyData = data as { data?: unknown }
  if (Array.isArray(anyData?.data)) return Buffer.from(anyData.data as number[])
  return null
}

/** 保存对话框的默认路径：裸文件名落到下载目录，绝对路径原样用。 */
function saveDialogDefaultPath(defaultFileName: string | undefined, fallback: string): string {
  const name = (defaultFileName ?? '').trim() || fallback
  return name.includes('/') ? name : join(app.getPath('downloads'), name)
}

/**
 * 词典 CSV 选择 + 解析。
 *
 * 返回形状以渲染层后续处理代码为准（dictionary bulk-import 流程实测）：
 *   成功 { success:true, fileName, words } —— words 逐行透传给云端 preview
 *   取消 { success:false, fileName:'', reason:'canceled' }
 *   失败 { success:false, fileName, reason } —— reason 是渲染层 i18n 分支键
 */
async function pickAndParseDictionaryCsv(): Promise<DictionaryCsvParseResult> {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const result = win
    ? await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    : await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, fileName: '', reason: 'canceled' }
  }

  const filePath = result.filePaths[0]
  const fileName = basename(filePath)
  try {
    const info = await stat(filePath)
    if (info.size > DICTIONARY_CSV_MAX_BYTES) {
      return { success: false, fileName, reason: 'fileTooLarge' }
    }
    const text = await readFile(filePath, 'utf8')
    return parseDictionaryCsv(text, fileName)
  } catch {
    return { success: false, fileName, reason: 'readFailed' }
  }
}

/** 保存对话框的返回形状。渲染层两种读法都覆盖：audio 读 .canceled，png 读 .error==='cancelled'。 */
type SaveDialogResult =
  | { success: true; path: string }
  | { success: false; canceled?: boolean; error?: string }

async function saveBytesWithDialog(
  bytes: Buffer | null,
  defaultFileName: string | undefined,
  fallbackName: string
): Promise<SaveDialogResult> {
  if (!bytes || bytes.length === 0) {
    return { success: false, canceled: false, error: 'empty_data' }
  }
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const options = { defaultPath: saveDialogDefaultPath(defaultFileName, fallbackName) }
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true, error: 'cancelled' }
  }
  try {
    await writeFile(result.filePath, bytes)
    return { success: true, path: result.filePath }
  } catch (err) {
    return { success: false, canceled: false, error: (err as Error).message }
  }
}

/**
 * 导出录音。渲染层传 { audioData, defaultFileName }：
 * audioData 是它从 db:history-get 拿到的 ArrayBuffer（原样回传）。
 * 缺 audioData 时按 audioId 从本地 audio/ 目录兜底读。
 */
async function saveAudioWithDialog(
  params: { audioData?: unknown; audioId?: string; defaultFileName?: string }
): Promise<SaveDialogResult> {
  let bytes = toBuffer(params?.audioData)
  if (!bytes && params?.audioId) {
    const buf = await readAudioBytes(String(params.audioId))
    bytes = buf ? Buffer.from(buf) : null
  }
  return saveBytesWithDialog(bytes, params?.defaultFileName, 'recording.ogg')
}

/** 导出 PNG。渲染层传 { pngBytes: Uint8Array, defaultFileName }。 */
async function savePngWithDialog(
  params: { pngBytes?: unknown; defaultFileName?: string }
): Promise<SaveDialogResult> {
  return saveBytesWithDialog(toBuffer(params?.pngBytes), params?.defaultFileName, 'image.png')
}

/**
 * 注册渲染层 IPC 桥接层。
 *
 * 前端是编译产物，通道名硬编码（window.ipcRenderer.invoke('store:use', ...)）。
 * 这里把 88 个通道绑到已有服务，业务逻辑不重复实现。
 */
function registerFrontendCompat(): void {
  // Legacy generic storage is restricted to UI namespaces. In particular it
  // must never bypass config:get's credential redaction via get-all or a path.
  const uiStores = new Set(['app-settings', 'app-storage'])
  const validUiKey = (key: unknown): key is string => typeof key === 'string'
    && !['__proto__', 'prototype', 'constructor', 'apiKey', 'siliconflowApiKey', 'refineApiKey'].includes(key)
  const readUiStore = (name: string): Record<string, unknown> => {
    if (!uiStores.has(name)) return {}
    const value = store?.get(name as never)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key]) => validUiKey(key))) : {}
  }
  const { channels } = registerRendererBridge({
    store: {
      // 通用键值存储：前端用它持久化 UI 状态（快捷键、语言、引导标记等）
      get: (storeName, key) => {
        return validUiKey(key) ? readUiStore(storeName)[key] : undefined
      },
      set: (storeName, key, value) => {
        if (!uiStores.has(storeName) || !validUiKey(key)) return
        const all = readUiStore(storeName)
        all[key] = value
        store?.set({ [storeName]: all } as never)
      },
      getAll: readUiStore,
      delete: (storeName, key) => {
        if (!uiStores.has(storeName) || !validUiKey(key)) return
        const all = readUiStore(storeName)
        delete all[key]
        store?.set({ [storeName]: all } as never)
      }
    },

    db: {
      /**
       * 前端契约：(offset, limit) -> { data, hasMore }。
       *
       * 分页游标是 offset 而非 page，hasMore 由前端控制「加载更多」按钮。
       * 多取一条来判断 hasMore，省掉一次 count 查询。
       */
      historyList: async (offset, limit) => {
        const size = typeof limit === 'number' && limit > 0 ? limit : 50
        const skip = typeof offset === 'number' && offset > 0 ? offset : 0
        const rows = await HistoryRepo.list({ limit: size + 1, offset: skip })
        const { data, hasMore } = paginate(rows, size)
        return { data: data.map(toFrontendHistory), hasMore }
      },
      /**
       * 前端契约：(id) -> { success, history }。
       *
       * 前端直接读 history.mode_meta.ai_result / refined_text / audio_metadata，
       * 且 mode_meta 与 client_metadata 必须是**对象**（前端会再 JSON.stringify），
       * audio_metadata 必须是**字符串**（前端会 JSON.parse）。
       * 传错类型不会报错，只会让详情页与同步静默失效。
       */
      historyGet: async (id) => {
        const row = await HistoryRepo.byId(String(id))
        if (!row) return { success: false }
        const history = toFrontendHistory(row)
        // 详情页要播放录音：把音频字节一并带上，前端会包成 Blob
        const audio = await readAudioBytes(String(id))
        return { success: true, history: audio ? { ...history, audio } : history }
      },
      historyUpsert: async (record) => {
        await HistoryRepo.upsert(fromFrontendHistory(record) as never)
        // 渲染层驱动的写库（浮窗语音流）也要触发云同步推送，
        // 否则记录永远停在 pending_upload——schedulePush 此前定义了却从未被调用。
        sync.schedulePush()
        return { success: true }
      },
      /** 前端传单个 id，不是数组。 */
      historyDelete: async (id) => {
        await historyLifecycle.remove(String(id))
        return { success: true }
      },
      historyDeleteByDuration: async (seconds) => {
        // 按秒数清理：转成天数（HistoryRepo 以天为单位）
        await historyLifecycle.purgeOlderThan(Number(seconds) < 0 ? -1 : Number(seconds) / 86400)
        return { success: true }
      },
      /** 无参 -> { success, data }，data 是单个记录对象（非数组）。 */
      historyLatest: async () => {
        const latest = await HistoryRepo.latest()
        return latest ? { success: true, data: toFrontendHistory(latest) } : { success: false }
      },
      /** 无参 -> { success, id }。 */
      historyLatestId: async () => {
        const latest = await HistoryRepo.latest()
        return latest ? { success: true, id: latest.id } : { success: false }
      },
      /** 无参 -> { reason }。前端在拿不到最新 id 时用它归因。 */
      historyLatestIdForErrorTracking: async () => ({ reason: 'no_history' }),
      deviceId: () => UtilHelper.getDeviceId(),
      /**
       * 前端契约：({ id, audioBuffer, mimeType, fileSuffix })。
       *
       * 同一个 id 可能被写两次（原始 wav，随后覆盖成压缩后的 ogg），
       * 所以必须允许覆盖写。扩展名取自前端，不写死。
       */
      saveAudio: async (params) => {
        const { id, audioBuffer, fileSuffix } = params ?? {}
        if (!id || !audioBuffer) return { success: false, error: 'invalid_params' }
        const suffix = typeof fileSuffix === 'string' && fileSuffix ? fileSuffix : 'ogg'
        const file = await historyLifecycle.saveAudio(String(id), suffix, Buffer.from(audioBuffer), true)
        await HistoryRepo.setAudioPath(String(id), file)
        return { success: true, path: file }
      },
      /**
       * 前端契约：({ audioId }) -> { outputArrayBuffer }。
       *
       * 前端**不检查 success**，直接解构 outputArrayBuffer 去压缩；
       * 所以失败时只能给 undefined，不能抛错——抛错会让整个录音流程中断。
       */
      getAudio: async (params) => {
        const id = params?.audioId
        if (!id) return {}
        const buf = await readAudioBytes(String(id))
        return buf ? { outputArrayBuffer: buf } : {}
      },
      updateClientMetadata: async (id, metadata) => {
        await HistoryRepo.updateClientMetadata(id, metadata)
        sync.schedulePush()
      },
      updateModeMeta: async (id, patch) => {
        await HistoryRepo.updateModeMeta(id, patch)
        sync.schedulePush()
      }
    },

    audio: {
      voiceFlow: async (params) => {
        // 前端传 { audioId, arrayBuffer, abortId, userOverTime, sendTime,
        // outputLanguage, isRetry } —— 不含 mode，由 pipeline 按 audioId 从库里还原
        const result = await pipeline.voiceFlowForRenderer(params)
        return result
      },
      abort: (abortId) => { pipeline.cancelByAbortId(abortId) },
      /**
       * 前端契约：({ arrayBuffer }) -> { success, outputArrayBuffer }。
       *
       * 前端在 success 且 outputArrayBuffer 非空时才用它覆盖存档，
       * 所以编码失败要如实回报，不能给个空 buffer 冒充成功。
       */
      compressOpus: async (data) => {
        try {
          // 前端传的是 Float32 PCM 的 ArrayBuffer
          const pcm = new Float32Array(data)
          const result = await encoder.encode([pcm], 16000)
          if (!result.data?.byteLength) return { success: false, error: 'empty_output' }
          return { success: true, outputArrayBuffer: result.data }
        } catch (err) {
          return { success: false, error: (err as Error).message }
        }
      },
      cleanAudioFile: async () => {
        // Legacy completion messages are not deletion authority. Orphans now
        // require review; explicitly deleted history has a durable cleanup queue.
        await historyLifecycle.flushAudioCleanup()
      },
      /** 前端要 { success, devices: { inputDevices } }，缺一层它读不到设备。 */
      devices: () => ({
        success: true,
        devices: { inputDevices: UtilHelper.getAudioDevices() }
      }),
      isMuted: () => ({ success: true, isMuted: UtilHelper.isAudioMuted() }),
      mute: () => { UtilHelper.muteAudio() },
      unmute: () => { UtilHelper.unmuteAudio() }
    },

    /**
     * 分块编码会话：start → encode×N → end。
     *
     * 前端用它边录边编码，压低长录音的内存峰值。每次 encode 独立可失败，
     * 失败时回 { success:false } 让前端跳过该块继续录，而不是整段中断。
     */
    chunkSession: {
      start: () => ({ success: true }),
      encode: async (params) => {
        try {
          if (!params?.arrayBuffer) return { success: false }
          const pcm = new Float32Array(params.arrayBuffer)
          const result = await encoder.encode([pcm], 16000)
          if (!result.data?.byteLength) return { success: false }
          // duration 让前端估算进度；按 16k 单声道 float32 反推时长
          const duration = pcm.length / 16000
          return { success: true, outputArrayBuffer: result.data, duration }
        } catch {
          return { success: false }
        }
      },
      end: () => ({ success: true })
    },

    sync: {
      getStatus: async () => {
        return sync.getStatus()
      },
      /**
       * UI 状态：在服务端状态上叠加本地的同步阶段。
       *
       * 前端用 phase==='syncing' 显示加载态、'error' 显示错误态。
       * 直接复用 getStatus 会永远返回 idle，用户看不到同步正在进行。
       */
      getUiStatus: async () => {
        const status = await sync.getStatus()
        // 服务端 status.total 是云端累计条数，会被 toFrontendSyncUiStatus 读成
        // 推送进度——必须用本地在途批次的值覆盖，否则同步条永远卡在 0%。
        return { ...(status ?? {}), phase: syncPhase, total: syncPushTotal, completed: syncPushCompleted }
      },
      pushImmediately: async () => {
        const result = await sync.pushNow({ retryFailed: true })
        // 同 getUiStatus：服务端 status.total 是累计值，必须用本地在途进度覆盖
        return { ...(await sync.getStatus() ?? {}), ...result, phase: syncPhase, total: syncPushTotal, completed: syncPushCompleted }
      },
      setSyncEnabled: async (enabled) => sync.updateSettings({ sync_enabled: enabled }),
      setCloudRetention: async (days) => sync.updateSettings({ cloud_retention: days }),
      wipeCloud: () => sync.wipeCloud(),
      confirmAlerts: async () => ({ ok: true }),
      refreshFromRemote: async () => sync.pull(0)
    },

    auth: {
      getCurrent: async () => {
        const info = auth.getAuthInfo()
        return info.userId ? { user_id: info.userId } : null
      },
      getAccessToken: () => auth.getAccessToken(),
      logout: async () => { sync.invalidateSession(); await auth.logout() },
      startAppLogin: async () => ({ success: false, detail: 'use_password_login' })
    },

    keyboard: {
      start: () => startKeyboardMonitor(),
      stop: () => { KeyboardHelper.stopMonitor() },
      reload: () => { reloadKeyboardShortcuts() },
      insertText: (text) => { InputHelper.insertText(text) },
      insertRichText: (html, text) => { InputHelper.insertRichText(html, text) },
      getDeviceList: () => KeyboardHelper.getDeviceList()
    },

    i18n: {
      getLanguage: () => (store?.get('language' as never) as unknown as string) ?? app.getLocale(),
      setLanguage: (lang) => { store?.set({ language: lang } as never) }
    },

    files: {
      saveRecordingLog: async (log) => {
        // 用户主动导出诊断日志时调用
        const dir = join(app.getPath('userData'), 'logs')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const file = join(dir, `recording-${Date.now()}.json`)
        await writeFile(file, String(log ?? ''), 'utf8')
        return file
      },
      pickAndParseDictionaryCsv: () => pickAndParseDictionaryCsv(),
      saveAudioWithDialog: (params) => saveAudioWithDialog(params),
      savePngWithDialog: (params) => savePngWithDialog(params)
    },

    context: {
      /**
       * 渲染层传 app_path（如 /Applications/Safari.app），
       * 期望返回图标 dataURL 字符串；拿不到必须返回 null（它按 falsy 跳过缓存）。
       */
      appIcon: async (appPath) => {
        if (!appPath || typeof appPath !== 'string') return null
        try {
          const icon = await app.getFileIcon(appPath, { size: 'normal' })
          return icon.isEmpty() ? null : icon.toDataURL()
        } catch {
          return null
        }
      }
    },

    onboarding: {
      complete: () => {
        // 引导结束时渲染层会 oe(false) 重新启用录音机，这里再复位一次兜底
        recordingUserDisabled = false
        store?.set({ hasOnboarded: true } as Partial<AppConfig>)
        // 与登录成功后同一条重载路径：已登录进 HUB，未登录进 LOGIN
        reloadMainWindowForAuthState()
      },
      getUserProfileSurveys: () => ({ success: true, records: [] }),
      submitUserProfileSurvey: async (payload) => {
        // 尽力转发到服务端；无 token 或失败都静默成功，不阻断引导流程
        try {
          const endpoint = serviceEndpoint(getConfig().cloudBaseUrl, '/user/update_onboarding')
          const token = await auth.getAccessToken()
          if (!token) return
          const response = await request(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
              'user-agent': `OpenType/${app.getVersion()}`
            },
            // 与渲染层自带 HTTP 客户端的约定一致：业务参数包在 params 下
            body: JSON.stringify({ params: payload })
          })
          await response.body.dump()
        } catch { /* 忽略 */ }
      }
    },

    focusedContext: {
      // 返回最后一次捕获的前台应用信息。前端据此在润色时带上上下文。
      // 形状契约：{ appInfo: { app_identifier, ... }, inputInfo }（渲染层按键名读取）。
      getLastFocusedInfo: () => collectFocusedContext(),
      getAudioContext: () => {
        const { appInfo, inputInfo } = collectFocusedContext()
        return {
          active_application: appInfo,
          text_insertion_point: inputInfo
            ? { cursor_state: { selected_text: inputInfo.selected_text ?? '', surrounding_text: inputInfo.surrounding_text ?? '' } }
            : null,
          context_metadata: {
            // 前台就是我们自己的窗口（pid 相同）时，渲染层据此跳过上下文展示
            is_own_application: Boolean(appInfo && appInfo.pid === process.pid)
          }
        }
      },
      getFocusedAppInfo: () => collectFocusedContext().appInfo,
      getFocusedInputInfo: () => collectFocusedContext().inputInfo,
      // 裸字符串契约：渲染层对返回值直接 .trim()
      getSelectedText: () => {
        try {
          return ContextHelper.getFocusedInputInfo()?.selectedText ?? ''
        } catch {
          return ''
        }
      },
      getFullContext: () => collectFocusedContext(),
      setLastFocusedInfoTimer: () => {}
    },

    recording: {
      isUserDisabled: () => recordingUserDisabled,
      setUserDisabled: (disabled) => {
        if (recordingUserDisabled === disabled) return
        recordingUserDisabled = disabled
        if (disabled) cancelRecordingControls()
        // 渲染层订阅 recording-machine:disabled-changed 同步 UI 态
        for (const win of [barWindow, mainWindow, interactiveWindow]) {
          if (win && !win.isDestroyed()) win.webContents.send('recording-machine:disabled-changed', disabled)
        }
      }
    },

    windows: {
      isLidOpen: () => UtilHelper.isLidOpen(),
      openUrl: (url) => { void shell.openExternal(url) },
      /**
       * 打开设置弹窗。
       *
       * tab 是数字枚举（settings=0/account=1/about=2/personal=3/help=4），
       * options 可带 openTranslationTargetLanguageModal / openMicrophoneModal。
       * 设置界面由前端渲染，主进程负责显示窗口并转发这两项，
       * 否则浮窗里点「翻译设置」会落到默认页。
       */
      openSettingsModal: (tab, options) => {
        mainWindow ??= createMainWindow()
        mainWindow.show()
        mainWindow.focus()
        // 渲染层订阅的事件名是 page-event--hub--open-settings-hub，
        // payload 形状 { menu: 页签枚举, params: 选项 }（从产物订阅点反查）
        mainWindow.webContents.send('page-event--hub--open-settings-hub', { menu: tab, params: options })
      },
      openEntryWindow: () => { mainWindow ??= createMainWindow(); mainWindow.show() },
      openBar: () => { barWindow?.showInactive() },
      closeSidebar: () => { /* 侧栏在渲染层内部管理 */ },
      closeInteractiveCard,
      openInteractiveCard: (payload) => { openInteractiveCard(payload) },
      getInteractiveCardPayload: () => pendingCardPayload,
      updateInteractiveCardBounds: (bounds) => { updateCardBounds(bounds) },
      setHubWindowButtonVisibility: () => undefined,
      floatingBarSetExpanded: () => undefined,
      floatingBarClick: () => { void pipeline.onStart() },
      isOnboardingWindowVisible: () => Boolean(mainWindow?.isVisible()),
      launchApplication: (bundleId) => UtilHelper.launchApplication(bundleId),
      restart: () => { app.relaunch(); app.exit(0) }
    }
  })
  console.log(`[opentype] 渲染层 IPC 桥接已注册 ${channels.length} 个通道`)
}

function registerIpc(): void {
  ipcMain.handle('desktop:answer-replace-selection', (event, id: string) => {
    if (event.sender !== interactiveWindow?.webContents || event.senderFrame !== interactiveWindow.webContents.mainFrame) throw new Error('answer_selection_expired')
    return answerCards.replace(id)
  })
  ipcMain.on('config:frontend-runtime', (event) => {
    const config = getConfig()
    event.returnValue = {
      cloudBaseUrl: config.cloudBaseUrl.replace(/\/+$/, ''),
      appVersion: app.getVersion(), provider: config.provider
    }
  })
  ipcMain.handle('capture:start', async (_e,options?:{preview?:boolean}) => pipeline.onStart({preview:options?.preview===true}))
  ipcMain.handle('capture:stop', async () => pipeline.onStop())
  ipcMain.handle('capture:cancel', () => pipeline.onCancel())
  ipcMain.on('capture:flushed', (event,id:string)=>{if(event.sender===barWindow?.webContents)pendingFlush.get(id)?.()})
  ipcMain.on('capture:failed', (event,id:string,detail:string)=>{
    const owner = barWindow?.webContents
    if(owner && event.sender===owner && event.senderFrame===owner.mainFrame) pipeline.captureFailed(id,
      ['microphone_permission','microphone_missing','microphone_busy','microphone_disconnected'].includes(detail)?detail:'capture_failed')
  })

  ipcMain.on('capture:push-audio', (_e, payload: { pcm: number[]; sampleRate: number; level: number; audioId: string }) => {
    if (_e.sender !== barWindow?.webContents || typeof payload.audioId !== 'string') return
    // Float32Array 经结构化克隆后变成普通数组，这里还原
    pipeline.pushAudio(new Float32Array(payload.pcm), payload.sampleRate, payload.level, payload.audioId)
  })

  // 音量走独立通道：它来自 AnalyserNode，频率远高于音频块，
  // 混进音频流会让每帧都搬运一遍样本数据
  ipcMain.on('capture:push-level', (_e, level: number) => {
    if (_e.sender === barWindow?.webContents) pipeline.pushLevel(level)
  })

  // 渲染层 IPC 桥接
  registerFrontendCompat()
  const desktopServices = registerDesktop({
    getBlacklistDomains: () => getConfig().blacklistDomains,
    cloudAccount: () => auth.userId ? { userId: auth.userId, serverUrl: syncScope(getConfig().cloudBaseUrl) } : null,
    isRecordingBusy: () => pipeline.isBusy,
    getPreferences:()=> (store?.get('app-settings' as never)??{}) as Record<string,unknown>,
    savePreferences:p=>{
      store?.set({'app-settings':{...((store?.get('app-settings' as never)??{}) as object),...p}} as never)
      if (p.learnFromInputEdits === false) {
        inputCorrections.stop()
        for (const candidateId of CorrectionRepo.dismissAllInputEdits()) {
          barWindow?.webContents.send('desktop:correction-capsule-candidate', { candidate: null, candidateId, scope: DictionaryRepo.scope() })
        }
        shownCorrectionCapsuleId = undefined
      }
      refreshTrayMenu()
      barPositioner?.preview(false)
      barPositioner?.refresh()
    },
    reloadShortcuts:()=>reloadKeyboardShortcuts(),
    completeOnboarding:()=>{store?.set({hasOnboarded:true});recordingUserDisabled=false},
    audio:async id=>{const a=await readAudioBytes(id);return a?Buffer.from(a):null},voice:p=>pipeline.voiceFlowForRenderer(p),importCsv:pickAndParseDictionaryCsv,changed:historyChanged
  })

  registerAudioStorage(() => audioStorage, () => mainWindow?.webContents)
  registerDictionarySync(()=>dictionarySync!,()=>mainWindow?.webContents)
  registerSettingsBackup({ owner:()=>mainWindow?.webContents,
    preferences:()=>readPreferences((store?.get('app-settings' as never)??{}) as Record<string,unknown>),
    updatePreferences:desktopServices.updatePreferences,
    busy:()=>pipeline.isBusy || !!lastPaste || !!selectionCapture || !!selectionActions?.isBusy || !!skillActions?.isBusy(),
  })
  desktopUpdater.configure({
    channel: ((store?.get('app-settings' as never) ?? {}) as Record<string,unknown>).updateChannel === 'beta' ? 'beta' : 'stable',
    saveChannel: updateChannel => store?.set({ 'app-settings': { ...((store?.get('app-settings' as never) ?? {}) as object), updateChannel } } as never),
    canInstall: () => !pipeline.isBusy && !lastPaste && !selectionCapture && !selectionActions?.isBusy && !skillActions?.isBusy(),
  })
  registerUpdater(() => mainWindow?.webContents)
  selectionActions = new SelectionActions({
    settings: () => readPreferences((store?.get('app-settings' as never) ?? {}) as Record<string, unknown>).skills,
    refinement: () => { const c = getConfig(); return { provider:'deepseek', enabled:c.enableRefine, apiKey:c.refineApiKey, baseUrl:c.refineBaseUrl, model:c.refineModel } },
    outputLanguage: () => getConfig().outputLanguage,
    show: displayInteractiveCard,
    complete: (payload, selection) => { answerCards.present(payload, selection) },
    release: token => InputHelper.releaseTarget(token), busy: () => pipeline.isBusy,
  })
  ipcMain.handle('desktop:selection-run', (event, id, action, options) => {
    const owner = interactiveWindow?.webContents
    if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('invalid_skill_request')
    return selectionActions?.run(id, action, options)
  })
  ipcMain.handle('desktop:selection-cancel', (event, id) => {
    const owner = interactiveWindow?.webContents
    if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('invalid_skill_request')
    selectionActions?.cancel(id)
  })
  skillActions = registerSkillActions({ owner: () => mainWindow?.webContents,
    settings: () => readPreferences((store?.get('app-settings' as never) ?? {}) as Record<string, unknown>).skills,
    refinement: () => { const c = getConfig(); return { provider: 'deepseek', enabled: c.enableRefine, apiKey: c.refineApiKey, baseUrl: c.refineBaseUrl, model: c.refineModel } },
    outputLanguage: () => getConfig().outputLanguage,
  })

  // MARK: 认证
  const accountCaller = (event: Electron.IpcMainInvokeEvent) => {
    const owner = mainWindow?.webContents
    if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('invalid_auth_request')
  }
  ipcMain.handle('auth:challenge-config', event => { accountCaller(event); return auth.challengeConfiguration() })
  ipcMain.handle('auth:register', async (event, params: { email: string; password: string; displayName?: string; turnstileToken?: string }) => {
    accountCaller(event)
    const r = await auth.register(params.email, params.password, params.displayName, params.turnstileToken)
    if (r.success) void sync.pushNow()
    return r
  })
  ipcMain.handle('auth:login-password', async (event, params: { email: string; password: string; turnstileToken?: string }) => {
    accountCaller(event)
    const r = await auth.loginWithPassword(params.email, params.password, params.turnstileToken)
    if (r.success) void sync.pushNow()
    return r
  })


  // MARK: 同步
  ipcMain.handle('sync:status', () => sync.getStatus())
  ipcMain.handle('sync:local-status', () => sync.localStatus())
  ipcMain.handle('sync:push-now', () => sync.pushNow({ retryFailed: true }))
  ipcMain.handle('sync:pull', () => sync.pull())
  ipcMain.handle('sync:load-older', (_e, params: { before: number | null; limit?: number }) =>
    sync.loadOlder(params.before, params.limit))
  ipcMain.handle('sync:update-settings', (_e, patch: { cloud_retention?: number; sync_enabled?: boolean }) =>
    sync.updateSettings(patch))
  ipcMain.handle('sync:wipe-cloud', () => sync.wipeCloud())

  ipcMain.handle('device:list-microphones', () => UtilHelper.getAudioDevices())
  let releaseShortcutCapture: (() => void) | undefined
  ipcMain.handle('keyboard:begin-capture', (event, id: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !win.isFocused() || typeof id !== 'string' || id.length > 100) throw new Error('shortcut_capture_unavailable')
    if (pipeline.isBusy) throw new Error('请先结束当前听写，再修改快捷键')
    releaseShortcutCapture?.()
    hotkeys.setBindings(activeBindings())
    const contents = event.sender
    const release = (reason: 'closed' | 'blurred' = 'closed') => {
      shortcutCapture.end(id, reason)
      hotkeys.setBindings(activeBindings())
      contents.removeListener('before-input-event', input)
      contents.removeListener('destroyed', closed)
      contents.removeListener('render-process-gone', closed)
      contents.removeListener('did-start-navigation', closed)
      win.removeListener('blur', blurred)
      if (releaseShortcutCapture === closed) releaseShortcutCapture = undefined
    }
    const closed = () => release()
    const blurred = () => release('blurred')
    const input = (e: Electron.Event, key: Electron.Input) => {
      // Tab and Enter retain keyboard access to Cancel/Save; they are not offered as bare shortcuts.
      if (['Tab', 'Enter'].includes(key.key) && !key.meta && !key.control && !key.alt) return
      const normalized = focusedKeyEvent(key)
      if (!normalized) return
      e.preventDefault()
      shortcutCapture.handle(normalized)
    }
    shortcutCapture.begin(id, contents.id, state => {
      if (!contents.isDestroyed()) contents.send('keyboard:capture', state)
      if (!state.active) release(state.reason === 'blurred' ? 'blurred' : 'closed')
    })
    releaseShortcutCapture = closed
    contents.on('before-input-event', input)
    contents.once('destroyed', closed)
    contents.once('render-process-gone', closed)
    contents.once('did-start-navigation', closed)
    win.once('blur', blurred)
  })
  ipcMain.handle('keyboard:end-capture', (event, id: string) => {
    if (shortcutCapture.owner !== event.sender.id) return
    shortcutCapture.end(id)
    if (!shortcutCapture.active) releaseShortcutCapture?.()
  })
  ipcMain.handle('keyboard:status', () => KeyboardHelper.getStatus())
  for (const channel of ['desktop:output-audio-status', 'desktop:output-audio-recover']) {
    ipcMain.handle(channel, event => {
      const owner = mainWindow?.webContents
      if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('invalid_request')
      if (!outputAudio) throw new Error('output_audio_unavailable')
      return channel === 'desktop:output-audio-status' ? outputAudio.snapshot() : outputAudio.retryRecovery()
    })
  }
  ipcMain.handle('keyboard:restart', () => { reloadKeyboardShortcuts(); return KeyboardHelper.getStatus() })
  ipcMain.handle('device:get-permissions', () => ({
    inputMonitoring: KeyboardHelper.getStatus().inputMonitoring,
    accessibility: UtilHelper.checkAccessibilityPermission(),
    microphone: UtilHelper.checkMicrophonePermission(),
    isBrowser: ContextHelper.isBrowserApp(ContextHelper.getFocusedAppInfo()?.bundleId ?? '')
  }))
  /**
   * 请求麦克风权限。
   *
   * 必须显式请求：AVCaptureDevice.authorizationStatus 只查询状态，
   * 不会触发系统弹窗。缺了这一步，首次使用录音时会静默失败。
   *
   * macOS 的麦克风权限是进程级的，授权后无需重启；
   * 辅助功能权限则需要重启才生效（见下）。
   */
  ipcMain.handle('device:request-microphone', async () => {
    const status = UtilHelper.checkMicrophonePermission()
    if (status === 3) return { granted: true, status }
    if (process.platform === 'win32') {
      await shell.openExternal('ms-settings:privacy-microphone')
      return { granted: false, status, reason: 'system_settings' }
    }
    if (status === 2) return { granted: false, status, reason: 'denied' }

    // notDetermined 或 restricted：调 askForMediaAccess 触发弹窗
    const granted = await systemPreferences.askForMediaAccess('microphone')
    return { granted, status: UtilHelper.checkMicrophonePermission() }
  })

  ipcMain.handle('device:request-accessibility', () => {
    // 触发系统授权弹窗；用户授权后需重启应用才能生效
    if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true)
    return UtilHelper.checkAccessibilityPermission()
  })

  ipcMain.handle('history:list', (_e, options) => HistoryRepo.list(options ?? {}))
  ipcMain.handle('history:latest', () => HistoryRepo.latest())
  ipcMain.handle('history:by-app', (_e, bundleId: string) => HistoryRepo.byApp(bundleId))
  ipcMain.handle('history:delete', async (_e, id: string, cloud = false) => {
    if (typeof cloud !== 'boolean') throw new Error('invalid_config')
    if (cloud && !auth.userId) throw new Error('not_authenticated')
    inputCorrections.cancel(id)
    for (const candidateId of CorrectionRepo.dismissInputEdits(id)) {
      barWindow?.webContents.send('desktop:correction-capsule-candidate', { candidate: null, candidateId, scope: DictionaryRepo.scope() })
    }
    await historyLifecycle.remove(id, cloud ? { userId: auth.userId!, serverUrl: syncScope(getConfig().cloudBaseUrl) } : undefined)
    return true
  })
  ipcMain.handle('history:clear', async () => {
    inputCorrections.stop()
    for (const candidateId of CorrectionRepo.dismissAllInputEdits()) {
      barWindow?.webContents.send('desktop:correction-capsule-candidate', { candidate: null, candidateId, scope: DictionaryRepo.scope() })
    }
    await historyLifecycle.clear()
    return true
  })

  const modelCaller = (event: Electron.IpcMainInvokeEvent) => {
    const owner = [mainWindow, speechSettingsWindow].find(window => window && !window.isDestroyed() && window.webContents === event.sender)
    if (!owner || event.senderFrame !== owner.webContents.mainFrame) throw new Error('invalid_model_request')
  }
  ipcMain.handle('local-asr:status', event => { modelCaller(event); return getLocalModels().check() })
  ipcMain.handle('local-asr:install', async event => {
    modelCaller(event)
    if (pipeline.isBusy) throw new Error('请先结束当前听写，再准备模型。')
    const status = await getLocalModels().install(app.isPackaged ? join(process.resourcesPath, 'models/sensevoice-int8') : undefined)
    if (status.state === 'ready' && !pipeline.isBusy) nativeAsr?.dispose()
    return status
  })
  ipcMain.handle('local-asr:cancel', event => { modelCaller(event); getLocalModels().dispose() })
  const diagnosticId = (value: unknown) => {
    if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('invalid_config')
    return value
  }
  const diagnosticRecord = async (key: string) => {
    const data = readInputDiagnostics(key)
    if (!data.summary.reason && !data.events.some(event => event.stage === 'delivery-result' || event.stage === 'delivery-failed')) {
      const row = await HistoryRepo.byId(key)
      data.summary.reason = inputDiagnosticReason(jsonObject(row?.debugInfo).detail)
    }
    return data
  }
  ipcMain.handle('input-diagnostics:read', async (event, id: unknown) => {
    modelCaller(event)
    return diagnosticRecord(diagnosticId(id))
  })
  ipcMain.handle('input-diagnostics:export', async (event, id: unknown) => {
    modelCaller(event)
    const key = diagnosticId(id), data = await diagnosticRecord(key)
    const result = await dialog.showSaveDialog({ defaultPath: `OpenType-input-${key}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
    return result.filePath
  })

  const appleLanguage = (value: unknown) => {
    if (typeof value !== 'string' || !/^(auto|[a-zA-Z]{2,3}([_-][a-zA-Z0-9]{2,8})*)$/.test(value)) throw new Error('invalid_config')
    return value
  }
  ipcMain.handle('apple-speech:status', (event, language: unknown = 'auto') => {
    modelCaller(event); return getAppleSpeech().status(appleLanguage(language))
  })
  ipcMain.handle('apple-speech:install', (event, language: unknown = 'auto') => {
    modelCaller(event)
    if (pipeline.isBusy) throw new Error('请先结束当前听写，再准备模型。')
    return getAppleSpeech().install(appleLanguage(language))
  })
  ipcMain.handle('apple-speech:cancel', event => { modelCaller(event); getAppleSpeech().cancelInstall() })
  ipcMain.handle('config:get', () => getPublicConfig())
  ipcMain.handle('config:set', async (_e, patch: Partial<AppConfig>) => {
    if (patch && typeof patch === 'object' && 'cloudBaseUrl' in patch) throw new Error('official_backend_managed')
    const allowed = new Set(['mode','shortcuts','outputLanguage','autoInject','micDeviceId','blacklistDomains','apiBaseUrl','historyRetentionDays','provider','appleSpeechLanguage','sttModel','refineModel','refineBaseUrl','refineApiKey','enableRefine','apiKey','siliconflowApiKey'])
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key=>!allowed.has(key))) throw new Error('invalid_config')
    if ('provider' in patch && !['local', 'siliconflow', 'openai', 'custom', 'apple'].includes(patch.provider!)) throw new Error('invalid_config')
    if ('appleSpeechLanguage' in patch) appleLanguage(patch.appleSpeechLanguage)
    if ('siliconflowApiKey' in patch) {
      if (typeof patch.siliconflowApiKey !== 'string' || patch.siliconflowApiKey.length > 1024
        || /[^\x21-\x7e]/.test(patch.siliconflowApiKey.trim())) throw new Error('invalid_config')
      patch = { ...patch, siliconflowApiKey: patch.siliconflowApiKey.trim() }
    }
    const providerKeys = ['provider', 'appleSpeechLanguage', 'apiBaseUrl', 'sttModel', 'refineModel', 'enableRefine', 'apiKey', 'siliconflowApiKey', 'refineBaseUrl', 'refineApiKey']
    if (pipeline.isBusy && providerKeys.some(key => key in patch)) throw new Error('请先结束当前听写，再修改识别服务')
    patch = networkSettingsPatch(getConfig(), patch)
    if ('historyRetentionDays' in patch && ![-1,7,30,90].includes(patch.historyRetentionDays!)) throw new Error('invalid_retention')
    if ('shortcuts' in patch && pipeline.isBusy) throw new Error('请先结束当前听写，再修改快捷键')
    if (patch.provider === 'local') {
      const generation = configGeneration
      if ((await getLocalModels().check()).state !== 'ready') throw new Error('请先下载并启用本地模型。')
      if (generation !== configGeneration) throw new Error('speech_settings_changed')
      if (pipeline.isBusy) throw new Error('请先结束当前听写，再启用本地模型。')
    }
    if ((patch.provider ?? getConfig().provider) === 'apple' && ('provider' in patch || 'appleSpeechLanguage' in patch)) {
      const generation = configGeneration
      const status = await getAppleSpeech().status(patch.appleSpeechLanguage ?? getConfig().appleSpeechLanguage ?? 'auto')
      if (!status.available || !status.installed) throw new Error(status.error || 'apple_speech_model_missing')
      if (generation !== configGeneration) throw new Error('speech_settings_changed')
      if (pipeline.isBusy) throw new Error('请先结束当前听写，再修改识别服务')
    }
    if ((patch.provider ?? getConfig().provider) === 'apple') patch = { ...patch, sttModel: 'apple-speech' }
    if ((patch.provider ?? getConfig().provider) === 'local') patch = { ...patch, sttModel: 'sensevoice-small-int8' }
    store?.set(patch as AppConfig)
    configGeneration++
    const next = getConfig()
    // provider 相关配置变了需要重建实例（协议/模型/密钥都可能变）
    if (providerKeys.some(key => key in patch)) {
      pipeline.setProvider(buildProvider())
      if (patch.provider === 'local') void prepareLocalModels()
    }
    if ('shortcuts' in patch) reloadKeyboardShortcuts()
    const publicConfig = getPublicConfig()
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('config:changed', publicConfig)
    if ('historyRetentionDays' in patch) {
      await historyLifecycle.purgeOlderThan(next.historyRetentionDays)
    }
    return publicConfig
  })

  ipcMain.handle('window:show-bar', () => barWindow?.showInactive())
  ipcMain.on('desktop:corrections-active-candidate', (event, candidateId: unknown) => {
    if (event.sender !== barWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return
    const active = typeof candidateId === 'string' && CorrectionRepo.isPendingInputEdit(candidateId) ? candidateId : undefined
    shownCorrectionCapsuleId = active
    if (active) { clearTimeout(barHideTimer); barWindow?.showInactive() }
  })
  ipcMain.handle('window:hide-bar', () => {
    if (currentVoiceState && ['preparing', 'recording', 'stopping', 'encoding', 'uploading', 'transcribing', 'refining', 'injecting'].includes(currentVoiceState.phase)) return
    if (shownCorrectionCapsuleId && CorrectionRepo.isPendingInputEdit(shownCorrectionCapsuleId)) return
    return barWindow?.hide()
  })

  ipcMain.handle('input:inject-text', (_e, text: string) => InputHelper.insertText(text))
  ipcMain.handle('input:get-selected-text', () => InputHelper.getSelectedText())
}

// MARK: - 深链接回调（登录闭环）

/**
 * 处理 OAuth 回调深链接。
 *
 * 流程：应用在系统浏览器打开授权页 → 用户完成授权 → 服务端重定向到
 * `opentype://auth/callback?code=...&state=...` → 操作系统唤起本应用 → 此处兑换 token。
 *
 * 单实例锁保证深链接被交给已运行的实例，而不是新开一个进程。
 */
let pendingDeepLink: string | undefined
let deepLinksReady = false
async function handleDeepLink(url: string): Promise<void> {
  try {
    if (url.length > 8192) return
    const parsed = new URL(url)
    if (parsed.protocol !== 'opentype:') return
    if (parsed.hostname !== 'auth' || parsed.pathname !== '/callback') return

    const code = parsed.searchParams.get('code')
    const state = parsed.searchParams.get('state')
    if (!code || !state) return
    if (!deepLinksReady) { pendingDeepLink = url; return }

    // 通知登录页「正在处理」，避免用户以为卡住
    mainWindow?.webContents.send('auth:app-login-loading-changed', true)

    const result = await auth.exchangeLoginCode(code, state)
    if (result.success) {
      onLoginSuccess()
    } else {
      mainWindow?.webContents.send('auth:app-login-loading-changed', false)
      mainWindow?.webContents.send('auth:app-login-failed', result.detail ?? 'unknown')
    }
  } catch {
    // 非法深链接直接忽略，不抛出
  }
}

/** 注册为 opentype:// 协议的处理器。 */
function registerProtocol(): void {
  if (process.defaultApp) {
    // 开发态：必须传「绝对路径」，否则系统解析不了。
    //
    // 踩过的坑：用 process.argv[1] 时，`electron .` 启动会得到 "."，
    // 注册进 LaunchServices 的是一段无效路径，点开链接唤不起应用
    // ——表现为登录后跳回深链接但界面毫无反应。
    const appPath = app.getAppPath()
    app.setAsDefaultProtocolClient('opentype', process.execPath, [appPath])
    console.log(`[opentype] 协议处理器: opentype:// → ${process.execPath} ${appPath}`)
  } else {
    app.setAsDefaultProtocolClient('opentype')
  }
}

// MARK: - 托盘
function createTray(): void {
  // 同时提供 1x 与 2x，macOS 会按屏幕缩放自动选择；
  // 只给 1x 在 Retina 上会模糊。图标缺失时退回空图标，
  // 但那样用户就失去了唯一入口，所以启动时会额外显示主窗口兜底。
  const iconPath = join(app.getAppPath(), 'build', process.platform === 'darwin' ? 'tray.png' : 'icon.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    console.warn('[opentype] 托盘图标缺失，无法通过托盘打开界面')
    icon = nativeImage.createEmpty()
  } else {
    if (process.platform === 'darwin') icon.setTemplateImage(true)
    else icon = icon.resize({ width: 32, height: 32 })
  }
  tray = new Tray(icon)
  tray.setToolTip('OpenType')
  refreshTrayMenu()
}
function refreshTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return
  const p = readPreferences((store?.get('app-settings' as never) ?? {}) as Record<string, unknown>)
  const selectSkill = (selected: string) => {
    const all = (store?.get('app-settings' as never) ?? {}) as Record<string, unknown>
    store?.set({ 'app-settings': { ...all, skills: { ...p.skills, selected } } } as never)
    const next = readPreferences((store?.get('app-settings' as never) ?? {}) as Record<string, unknown>)
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('desktop:preferences-changed', next)
    refreshTrayMenu()
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: () => { mainWindow ??= createMainWindow(); mainWindow.show() } },
    { label: '听写模型与 DeepSeek 设置', click: showSpeechSettings },
    { label: '当前 Skill', enabled: p.skills.enabled, submenu: [
      { label: '按场景自动选择', type: 'radio', checked: p.skills.selected === 'auto', click: () => selectSkill('auto') },
      { label: '不使用 Skill', type: 'radio', checked: p.skills.selected === 'none', click: () => selectSkill('none') },
      ...p.skills.items.filter(s=>s.enabled).map(s=>({ label: s.name, type: 'radio' as const, checked: p.skills.selected === s.id, click: () => selectSkill(s.id) })),
    ] },
    { label: '粘贴上一条听写', click: () => { void pasteLastTranscript() } },
    { label: '选中文字快捷操作', click: openSelectionActions },
    { label: '开始/停止录音', click: () => { void (pipeline.isBusy ? pipeline.onStop() : pipeline.onStart()) } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]))
}

// MARK: - 生命周期

/**
 * 显式设置应用名与数据目录。
 *
 * 两件事都必须做，且必须在 app.whenReady() 之前：
 *
 * 1. setName —— 开发态下 app.getName() 默认返回 'Electron'，
 *    会导致通知、菜单、崩溃恢复提示显示错误的名称。
 *
 * 2. setPath('userData') —— 这是关键的安全措施。
 *    默认路径由 app name 推导，若时序不对会落到通用的 `Electron/` 目录，
 *    与机器上其他 Electron 应用共用，导致：
 *      - 数据库、配置、Cookie 互相覆盖
 *      - 与其他同类应用的目录产生 Chromium 单例锁冲突
 *    显式指定独立目录，彻底隔离。
 */
app.setName('OpenType')

// 数据目录：用反向域名前缀，与任何其他应用彻底隔离。
//
// 不用 "OpenType" 的原因：macOS 的 APFS 默认大小写不敏感，
// "OpenType" 与 "opentype" 是同一个目录 —— 清理旧目录时极易误删在用数据
// （这是实际踩过的坑）。反向域名 + 明确后缀不会与任何东西混淆。
// Explicit profiles support independent troubleshooting without touching the normal profile.
const testUserData = !app.isPackaged ? process.env.OPENTYPE_TEST_USER_DATA_DIR : undefined
const profile = resolveProfilePaths({
  appData: app.getPath('appData'), defaultLogs: process.platform === 'darwin'
    ? join(app.getPath('home'), 'Library', 'Logs', 'dev.opentype.desktop') : join(app.getPath('appData'), 'dev.opentype.desktop', 'logs'),
  packaged: app.isPackaged, testDirectory: testUserData,
  cliDirectory: app.commandLine.hasSwitch('user-data-dir') ? app.commandLine.getSwitchValue('user-data-dir') : undefined,
})
app.setPath('userData', profile.userData)
app.setPath('logs', profile.logs)
app.setPath('sessionData', profile.userData)

// The marker means "the new process started and owns this profile". It is
// written right after ready + single-instance lock, before secure storage: an
// ad-hoc update's first launch can block on a keychain prompt in initStore.
// Returns whether this is an updater relaunch (the helper is still running).
function confirmUpdaterRestart(): boolean {
  if (!app.commandLine.hasSwitch('update-install-confirm-token')) return false
  const token = app.commandLine.getSwitchValue('update-install-confirm-token')
  const requestedPath = app.commandLine.getSwitchValue('update-install-confirm-path')
  if (!/^[a-f0-9]{32}$/.test(token) || !requestedPath) return true
  try {
    const installDir = join(app.getPath('userData'), 'update-install')
    mkdirSync(installDir, { recursive:true, mode:0o700 })
    const canonicalDir = realpathSync(installDir)
    const markerPath = join(canonicalDir, `confirm-${token}.json`)
    if (resolve(requestedPath) !== markerPath || existsSync(markerPath)) return true
    writeFileSync(markerPath, JSON.stringify({ token, pid:process.pid, version:app.getVersion(), userDataPath:app.getPath('userData') }), { mode:0o600, flag:'wx' })
  } catch (error) {
    console.warn('[opentype] update restart confirmation failed:', error)
  }
  return true
}

// Every webContents (main, bar, card, settings): no navigation away from the app's own pages
// (e.g. a link dropped onto a window) and no <webview>. Subframes such as Turnstile are unaffected.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    let allowed = false
    try { allowed = isAppRendererUrl(url) } catch { allowed = false }
    if (!allowed) event.preventDefault()
  })
  contents.on('will-attach-webview', event => event.preventDefault())
})

// 单实例锁：深链接需要交给已运行实例处理，否则会新开进程导致登录态分裂
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    // 从命令行参数里找深链接
    const link = argv.find((a) => a.startsWith('opentype://'))
    if (link) void handleDeepLink(link)
    mainWindow?.show()
  })

  // macOS 走 open-url 事件而非命令行参数
  app.on('open-url', (event, url) => {
    event.preventDefault()
    void handleDeepLink(url)
  })
}

if (gotLock) app.whenReady().then(async () => {
  // Before initStore/safeStorage (see confirmUpdaterRestart), then report the
  // previous install result and sweep stale update leftovers.
  recoverUpdateInstall(confirmUpdaterRestart())
  powerMonitor.on('lock-screen', closeInteractiveCard)
  powerMonitor.on('suspend', closeInteractiveCard)
  // store 必须在读取任何配置前就绪：热键绑定、编码器路径都依赖它
  await initStore()
  auth = createAuthService()
  sync = createSyncEngine()
  pipeline = createVoicePipeline()
  await auth.initialize()
  serviceUserId = auth.userId

  // 开发态 Dock 图标：打包后由 .app 的 icns 提供，dev 下默认是 Electron 图标
  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'))
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon)
  }

  // 渲染层浮窗只认 app-settings.featureShortcutBindings，首启必须播种默认值
  seedFeatureShortcutBindings()

  initDatabase(join(app.getPath('userData'), 'db'))
  HistoryRepo.setOwnerResolver(() => auth.userId ? { userId: auth.userId, serverUrl: syncScope(getConfig().cloudBaseUrl) } : null)
  const previousAccountScope = store?.get('accountBackendMigrationScope' as never) as unknown
  if (typeof previousAccountScope === 'string' && previousAccountScope) {
    HistoryRepo.preserveLegacyCloudScope(previousAccountScope)
    store?.set({ accountBackendMigrationScope: '' } as never)
  }
  dictionarySync = new DictionarySync({
    account:()=>auth.userId?{userId:auth.userId,server:getConfig().cloudBaseUrl}:null,
    token:()=>auth.getAccessToken(),
    busy:()=>pipeline.isBusy||!!lastPaste||!!selectionCapture||!!selectionActions?.isBusy||!!skillActions?.isBusy(),
  })
  historyLifecycle = new HistoryLifecycle(join(app.getPath('userData'), 'audio'),
    id => pipeline.cancelByAbortId(id), historyChanged)
  audioStorage = new AudioStorage(join(app.getPath('userData'), 'audio'), {
    isBusy: () => pipeline.isBusy, isWriting: id => historyLifecycle.isWriting(id), changed: historyChanged,
  })

  // Accessibility authorizes insertion; global keyboard listening is checked separately.
  const trusted = UtilHelper.checkAccessibilityPermission()
  if (!trusted && process.platform === 'darwin') {
    systemPreferences.isTrustedAccessibilityClient(true)
  }

  if (!profile.custom) registerProtocol()

  // 启动本地 OAuth 回调服务。
  // 深链接在开发态不可用（bundle id 是 com.github.electron），
  // 本地回调绕开系统协议注册，行为与打包后一致。
  try {
    callbackServer = await startCallbackServer({
      onCallback: async ({ code, state }) => {
        const result = await auth.exchangeLoginCode(code, state)
        if (result.success) onLoginSuccess()
        return result
      }
    })
    auth.setLocalCallbackPort(callbackServer.port)
    console.log(`[opentype] 本地回调服务: http://127.0.0.1:${callbackServer.port}/auth/callback`)
  } catch (err) {
    console.warn('[opentype] 本地回调服务启动失败，退回深链接:', (err as Error).message)
  }

  const preferences=readPreferences((store?.get('app-settings' as never)??{}) as Record<string,unknown>)
  const { nativeTheme }=await import('electron');nativeTheme.themeSource=preferences.appearance
  // 「在 Dock 中显示应用」只在切换时生效的话重启后会失效；启动时按保存值恢复。
  // 打开窗口的路径（托盘、activate、快捷键）都不会强制 app.dock.show()，以该偏好为准。
  if (process.platform === 'darwin' && app.dock && !preferences.showInDock) app.dock.hide()
  registerIpc()
  barWindow = createBarWindow()
  barPositioner = new FloatingBarPositioner(barWindow, floatingBarPreferences, floatingBar => {
    const saved = (store?.get('app-settings' as never) ?? {}) as Record<string, unknown>
    store?.set({ 'app-settings': { ...saved, floatingBar } } as never)
    const preferences = readPreferences({ ...saved, floatingBar })
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('desktop:preferences-changed', preferences)
  })
  outputAudio = new OutputAudioControl((id, detail) => {
    if (!id || !currentVoiceState || currentVoiceState.audioId !== id) return
    outputAudioNotice = detail
    currentVoiceState = { ...currentVoiceState, audioNotice: detail || undefined }
    barWindow?.webContents.send('capture:state-changed', currentVoiceState)
  }, status => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:output-audio-state', status)
  })
  createTray()

  // 首次启动（或从未完成登录/授权）时显示主窗口。
  // 否则用户看不到任何界面——浮窗只在热键触发时出现，托盘图标又可能不显眼。
  // The source entry chooses onboarding from the persisted configuration.
  const hasOnboarded = hasCompletedOnboarding()
  console.log(`[opentype] hasOnboarded=${hasOnboarded}`)
  if (!hasOnboarded || profile.custom) {
    mainWindow = createMainWindow()
    mainWindow.show()
    console.log(`[opentype] 主窗口已创建并显示: ${mainWindow.isVisible()} ${JSON.stringify(mainWindow.getBounds())}`)
  }
  console.log(`[opentype] 托盘可用: ${tray !== null && !tray.isDestroyed()}`)
  console.log(`[opentype] 就绪`)
  if (testUserData && process.env.OPENTYPE_TEST_OPEN_SPEECH_SETTINGS === '1') showSpeechSettings()

  // Show onboarding/settings first. Only a selected local provider prepares its model.
  if (getConfig().provider === 'local') void prepareLocalModels()

  hotkeys.setBindings(activeBindings())

  // Keep missing Input Monitoring permission visible instead of silently failing in the tray.
  const rc = startKeyboardMonitor()
  if (rc !== 0) {
    console.warn('[opentype] 键盘监听尚未就绪', rc, KeyboardHelper.getStatus())
    mainWindow ??= createMainWindow()
    mainWindow.show()
  }

  powerLifecycle = bindRecordingPowerEvents(powerMonitor, {
    // Sleep/lock only ends live microphone capture; finished or in-flight dictation still lands in history.
    suspend: () => { cancelRecordingControls({ keepDictation: true }); KeyboardHelper.stopMonitor() },
    // Resume/unlock must never abort a session that already stopped and is still transcribing/refining.
    resume: () => reloadKeyboardShortcuts({ keepDictation: true }),
  })
  deepLinksReady = true
  const startupLink = pendingDeepLink ?? process.argv.find(argument => argument.startsWith('opentype://'))
  pendingDeepLink = undefined
  if (startupLink) void handleDeepLink(startupLink)

  // Resume durable audio cleanup on launch, then enforce the chosen local retention.
  const cleanupHistory = () => historyLifecycle.purgeOlderThan(getConfig().historyRetentionDays)
    .catch(() => console.warn('[opentype] history cleanup will retry'))
  void cleanupHistory()
  // Resume pending deletions and consume other devices' changes from the local durable cursor.
  void sync.synchronize()
  setInterval(() => { void sync.synchronize() }, 60_000).unref()
  setInterval(() => {
    void cleanupHistory()
  }, 6 * 3600 * 1000)
})

app.on('will-quit', () => {
  callbackServer?.close()
  callbackServer = null
})

app.on('activate', () => {
  if (!app.isReady() || !pipeline) return
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow()
  mainWindow.show()
})

app.on('window-all-closed', () => {
  // 常驻托盘应用：关掉窗口不退出
})

app.on('before-quit', () => {
  selectionCapture?.abort(); selectionCapture = undefined
  dictionarySync?.dispose()
  selectionActions?.close()
  outputAudio?.dispose()
  barPositioner?.dispose()
  inputCorrections.stop()
  answerCards.close()
  powerLifecycle?.dispose()
  hotkeys.reset()
  lastPaste?.abort()
  skillActions?.dispose()
  localModels?.dispose()
  nativeAsr?.dispose()
  appleSpeech?.dispose()
  sync?.dispose()
  pipeline?.dispose()
  KeyboardHelper.stopMonitor()
  closeDatabase()
  InputHelper.restoreClipboard()
})

export { getConfig }
