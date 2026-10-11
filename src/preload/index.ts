// preload 桥接层。渲染层永远拿不到 ipcRenderer 本体，
// 只暴露一份显式白名单 API，避免渲染进程被注入脚本后能调用任意主进程能力。

import { contextBridge, ipcRenderer } from 'electron'
import { desktop } from './desktop'
import type { AuthChallengeConfiguration } from '../shared/auth-challenge'

const CH = {
  // 录音链路
  START_CAPTURE: 'capture:start',
  STOP_CAPTURE: 'capture:stop',
  CANCEL_CAPTURE: 'capture:cancel',
  PUSH_AUDIO: 'capture:push-audio',
  PUSH_LEVEL: 'capture:push-level',
  ON_PIPELINE_STATE: 'capture:state-changed',

  // 设备与权限
  LIST_MICROPHONES: 'device:list-microphones',
  GET_PERMISSIONS: 'device:get-permissions',
  REQUEST_ACCESSIBILITY: 'device:request-accessibility',
  REQUEST_MICROPHONE: 'device:request-microphone',

  // 历史
  HISTORY_LIST: 'history:list',
  HISTORY_LATEST: 'history:latest',
  HISTORY_BY_APP: 'history:by-app',
  HISTORY_DELETE: 'history:delete',
  HISTORY_CLEAR: 'history:clear',

  // 认证
  AUTH_IS_LOGGED_IN: 'auth:is-logged-in',
  AUTH_GET_CURRENT: 'auth:get-current',
  AUTH_GET_ACCESS_TOKEN: 'auth:get-access-token',
  AUTH_START_APP_LOGIN: 'auth:start-app-login',
  AUTH_LOGIN: 'auth:login',
  AUTH_REGISTER: 'auth:register',
  AUTH_LOGIN_PASSWORD: 'auth:login-password',
  AUTH_LOGOUT: 'auth:logout',
  ON_AUTH_LOGIN_FAILED: 'auth:app-login-failed',

  // 云端同步
  SYNC_STATUS: 'sync:status',
  SYNC_PUSH_NOW: 'sync:push-now',
  SYNC_PULL: 'sync:pull',
  SYNC_LOAD_OLDER: 'sync:load-older',
  SYNC_UPDATE_SETTINGS: 'sync:update-settings',
  SYNC_WIPE_CLOUD: 'sync:wipe-cloud',
  ON_SYNC_STATE: 'sync:state-changed',

  // 配置
  GET_CONFIG: 'config:get',
  SET_CONFIG: 'config:set',
  ON_CONFIG_CHANGED: 'config:changed',

  // 窗口
  WINDOW_SHOW_BAR: 'window:show-bar',
  WINDOW_HIDE_BAR: 'window:hide-bar',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  ON_WINDOW_MAXIMIZED: 'window:maximized-changed',
  ON_HOTKEY_STATE: 'hotkey:state-changed',

  // 注入
  INJECT_TEXT: 'input:inject-text',
  GET_SELECTED_TEXT: 'input:get-selected-text'
} as const

const api = {
  desktop,
  appleSpeech: {
    cancel: () => ipcRenderer.invoke('apple-speech:cancel'),
    status: (language = 'auto') => ipcRenderer.invoke('apple-speech:status', language) as Promise<import('../main/services/providers/apple-speech').AppleSpeechStatus>,
    install: (language = 'auto') => ipcRenderer.invoke('apple-speech:install', language) as Promise<import('../main/services/providers/apple-speech').AppleSpeechStatus>,
  },
  localAsr: {
    status: () => ipcRenderer.invoke('local-asr:status'),
    install: () => ipcRenderer.invoke('local-asr:install'),
    cancel: () => ipcRenderer.invoke('local-asr:cancel')
  },
  capture: {
    start: (options?: { preview?: boolean }) => ipcRenderer.invoke(CH.START_CAPTURE, options),
    stop: () => ipcRenderer.invoke(CH.STOP_CAPTURE),
    cancel: () => ipcRenderer.invoke(CH.CANCEL_CAPTURE),
    /** 音频分块用 send 而非 invoke：高频单向数据流不需要等待回执。 */
    pushAudio: (pcm: Float32Array, sampleRate: number, level: number, audioId: string) =>
      ipcRenderer.send(CH.PUSH_AUDIO, { pcm: Array.from(pcm), sampleRate, level, audioId }),
    /**
     * 音量单独上报。
     *
     * 与音频数据分离的原因：音量来自 AnalyserNode（音频线程已算好），
     * 采样率远高于音频块（每帧 vs 每 64ms），混在音频流里会白白搬运样本数据。
     */
    pushLevel: (level: number) => ipcRenderer.send(CH.PUSH_LEVEL, level),
    onState: (cb: (state: any) => void) => {
      const handler = (_: unknown, state: any) => cb(state)
      ipcRenderer.on(CH.ON_PIPELINE_STATE, handler)
      return () => { ipcRenderer.off(CH.ON_PIPELINE_STATE, handler) }
    }
  },

  auth: {
    challengeConfiguration: (): Promise<AuthChallengeConfiguration> => ipcRenderer.invoke('auth:challenge-config'),
    isLoggedIn: () => ipcRenderer.invoke(CH.AUTH_IS_LOGGED_IN),
    getCurrent: () => ipcRenderer.invoke(CH.AUTH_GET_CURRENT),
    getAccessToken: () => ipcRenderer.invoke(CH.AUTH_GET_ACCESS_TOKEN),
    /** 在系统浏览器打开授权页，回调经 opentype:// 深链接返回 */
    startLogin: (provider: string) => ipcRenderer.invoke(CH.AUTH_START_APP_LOGIN, provider),
    /** 兑换授权码（深链接回调后由主进程自动调用，此方法供手动补登） */
    login: (params: { code: string; state: string }) => ipcRenderer.invoke(CH.AUTH_LOGIN, params),
    /** 注册（邮箱 + 密码）。无需浏览器授权页。 */
    register: (params: { email: string; password: string; displayName?: string; turnstileToken?: string }) =>
      ipcRenderer.invoke(CH.AUTH_REGISTER, params),
    /** 密码登录。自建部署下比 PKCE 更直接。 */
    loginWithPassword: (params: { email: string; password: string; turnstileToken?: string }) =>
      ipcRenderer.invoke(CH.AUTH_LOGIN_PASSWORD, params),
    logout: () => ipcRenderer.invoke(CH.AUTH_LOGOUT),
    onLoginFailed: (cb: (detail: string) => void) => {
      const handler = (_: unknown, detail: string) => cb(detail)
      ipcRenderer.on(CH.ON_AUTH_LOGIN_FAILED, handler)
      return () => { ipcRenderer.off(CH.ON_AUTH_LOGIN_FAILED, handler) }
    }
  },

  sync: {
    localStatus: (): Promise<{ pendingDeletions: number; cloudExcluded: number; pendingCloudWipe: boolean }> => ipcRenderer.invoke('sync:local-status'),
    /** 云端同步状态：记录数、保留期、最后同步时间 */
    status: () => ipcRenderer.invoke(CH.SYNC_STATUS),
    /** 立即推送本地待同步记录（不等 10s 防抖） */
    pushNow: () => ipcRenderer.invoke(CH.SYNC_PUSH_NOW),
    /** 增量拉取云端记录 */
    pull: () => ipcRenderer.invoke(CH.SYNC_PULL),
    /** 向历史方向翻页 */
    loadOlder: (before: number | null, limit?: number) =>
      ipcRenderer.invoke(CH.SYNC_LOAD_OLDER, { before, limit }),
    /** 更新云端保留期等设置 */
    updateSettings: (patch: { cloud_retention?: number; sync_enabled?: boolean }) =>
      ipcRenderer.invoke(CH.SYNC_UPDATE_SETTINGS, patch),
    /** 清空云端历史（不可逆） */
    wipeCloud: () => ipcRenderer.invoke(CH.SYNC_WIPE_CLOUD),
    /** 订阅同步状态变化 */
    onState: (cb: (state: { phase: string; detail?: string }) => void) => {
      const handler = (_: unknown, state: { phase: string; detail?: string }) => cb(state)
      ipcRenderer.on(CH.ON_SYNC_STATE, handler)
      return () => { ipcRenderer.off(CH.ON_SYNC_STATE, handler) }
    }
  },

  device: {
    listMicrophones: () => ipcRenderer.invoke(CH.LIST_MICROPHONES),
    getPermissions: () => ipcRenderer.invoke(CH.GET_PERMISSIONS),
    requestAccessibility: () => ipcRenderer.invoke(CH.REQUEST_ACCESSIBILITY),
    /** 请求麦克风权限。首次录音前必须调用，否则 getUserMedia 静默失败。 */
    requestMicrophone: () => ipcRenderer.invoke(CH.REQUEST_MICROPHONE)
  },

  history: {
    list: (options?: { limit?: number; offset?: number }) => ipcRenderer.invoke(CH.HISTORY_LIST, options),
    latest: () => ipcRenderer.invoke(CH.HISTORY_LATEST),
    byApp: (bundleId: string) => ipcRenderer.invoke(CH.HISTORY_BY_APP, bundleId),
    remove: (id: string, cloud = false) => ipcRenderer.invoke(CH.HISTORY_DELETE, id, cloud),
    clear: () => ipcRenderer.invoke(CH.HISTORY_CLEAR)
  },

  config: {
    get: () => ipcRenderer.invoke(CH.GET_CONFIG),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke(CH.SET_CONFIG, patch),
    onChanged: (cb: (config: any) => void) => {
      const handler = (_: unknown, config: any) => cb(config)
      ipcRenderer.on(CH.ON_CONFIG_CHANGED, handler)
      return () => { ipcRenderer.off(CH.ON_CONFIG_CHANGED, handler) }
    }
  },

  window: {
    showBar: () => ipcRenderer.invoke(CH.WINDOW_SHOW_BAR),
    hideBar: () => ipcRenderer.invoke(CH.WINDOW_HIDE_BAR),
    minimize: () => ipcRenderer.send(CH.WINDOW_MINIMIZE),
    toggleMaximize: () => ipcRenderer.send(CH.WINDOW_TOGGLE_MAXIMIZE),
    close: () => ipcRenderer.send(CH.WINDOW_CLOSE),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(CH.WINDOW_IS_MAXIMIZED),
    onMaximizedChange: (cb: (maximized: boolean) => void) => {
      const handler = (_: unknown, maximized: boolean) => cb(maximized === true)
      ipcRenderer.on(CH.ON_WINDOW_MAXIMIZED, handler)
      return () => { ipcRenderer.off(CH.ON_WINDOW_MAXIMIZED, handler) }
    },
    onHotkeyState: (cb: (state: any) => void) => {
      const handler = (_: unknown, state: any) => cb(state)
      ipcRenderer.on(CH.ON_HOTKEY_STATE, handler)
      return () => { ipcRenderer.off(CH.ON_HOTKEY_STATE, handler) }
    }
  },

  input: {
    injectText: (text: string) => ipcRenderer.invoke(CH.INJECT_TEXT, text),
    getSelectedText: () => ipcRenderer.invoke(CH.GET_SELECTED_TEXT)
  },

  /** 平台标识，渲染层据此调整快捷键文案（⌘ vs Ctrl）。 */
  platform: process.platform
}

/** Defense in depth: only the app's own pages (packaged file://, or the local dev server) get the API. */
function isAppOrigin(): boolean {
  if (location.protocol === 'file:') {
    // Packaged/built pages load via loadFile(<app>/dist/renderer/<page>) — also inside app.asar.
    if (location.host !== '' || /%(2f|5c)/i.test(location.pathname)) return false
    let path: string
    try { path = decodeURIComponent(location.pathname) } catch { return false }
    if (path.split(/[\\/]/).includes('..')) return false
    return /\/dist\/renderer\/[^/]+/.test(path)
  }
  return location.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && location.port !== ''
}

if (process.isMainFrame && isAppOrigin()) contextBridge.exposeInMainWorld('opentype', api)

export type OpenTypeApi = typeof api
