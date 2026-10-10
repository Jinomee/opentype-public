import koffi from 'koffi'
import type { KeyboardMonitorStatus } from '../../shared/desktop'

export interface KeyEvent {
  type: 'keyDown' | 'keyUp'
  keyCode: number
  key: string
  modifiers: string[]
  isRepeat: boolean
  timestamp: number
}

// Keep the five-argument Swift C ABI in one place, shared by production and tests.
const callbackType = koffi.pointer(koffi.proto('bool OpenTypeKeyCallback(int, str, int, int, str)'))
export function createKeyboardMonitor(lib: koffi.IKoffiLib) {
  if (process.platform === 'win32') return createQueuedKeyboardMonitor(lib)
  const start = lib.func('startKeyboardMonitor', 'int', [callbackType])
  const stop = lib.func('stopKeyboardMonitor', 'void', [])
  const status = lib.func('getKeyboardMonitorStatus', 'void *', [])
  const free = lib.func('freeString', 'void', ['void *'])
  let callback: ReturnType<typeof koffi.register> | undefined
  let listener: ((event: KeyEvent) => void) | undefined
  let generation = 0
  return {
    startMonitor(onEvent: (event: KeyEvent) => void): number {
      listener = onEvent
      if (!callback) {
        callback = koffi.register((_code: number, _name: string | null, _down: number, _repeat: number, json: string | null) => {
          if (!json) return false
          let event: KeyEvent
          try { event = JSON.parse(json) as KeyEvent } catch { return false }
          const current = generation
          // Return to CGEventTap immediately. Context capture, IPC and recording
          // may block; doing them inside the tap can make macOS disable it.
          setImmediate(() => {
            if (current !== generation) return
            try { listener?.(event) }
            catch (error) { console.error('[keyboard] event handler failed', error instanceof Error ? error.name : 'unknown') }
          })
          return false
        }, callbackType)
      }
      // Keep registration after failure: the native watchdog retries permission changes.
      return start(callback) as number
    },
    stopMonitor(): void {
      stop()
      generation += 1
      listener = undefined
      if (callback) { koffi.unregister(callback); callback = undefined }
    },
    /** macOS never eats shortcut keys; only the Windows hook can. */
    setSwallow(_keys: { key: string; modifiers: string[] }[], _escape: boolean): void {},
    getStatus(): KeyboardMonitorStatus {
      const ptr = status()
      if (!ptr) throw new Error('keyboard_status_unavailable')
      try { return JSON.parse(koffi.decode(ptr, 'char', -1) as string) }
      finally { free(ptr) }
    },
  }
}

/** WH_KEYBOARD_LL only enqueues native data. Polling never blocks its system
 * callback, and its queue-loss marker cancels any potentially stale gesture. */
function createQueuedKeyboardMonitor(lib: koffi.IKoffiLib) {
  const start = lib.func('startKeyboardMonitor', 'int', ['void *'])
  const stop = lib.func('stopKeyboardMonitor', 'void', [])
  const drain = lib.func('drainKeyboardEvents', 'void *', [])
  const status = lib.func('getKeyboardMonitorStatus', 'void *', [])
  const free = lib.func('freeString', 'void', ['void *'])
  const swallow = lib.func('setKeyboardSwallow', 'void', ['str', 'bool'])
  let timer: ReturnType<typeof setInterval> | undefined
  let listener: ((event: KeyEvent) => void) | undefined
  let requested = false, ticks = 0, available = true
  const read = <T>(fn: ReturnType<koffi.IKoffiLib['func']>): T => {
    const pointer = fn()
    if (!pointer) throw new Error('keyboard_status_unavailable')
    try { return JSON.parse(koffi.decode(pointer, 'char', -1) as string) as T }
    finally { free(pointer) }
  }
  const emit = (event: KeyEvent) => {
    try { listener?.(event) } catch (error) { console.error('[keyboard] event handler failed', error instanceof Error ? error.name : 'unknown') }
  }
  const reset = () => emit({ type: 'keyDown', keyCode: 0x1b, key: 'Escape', modifiers: [], isRepeat: false, timestamp: Date.now() })
  return {
    startMonitor(onEvent: (event: KeyEvent) => void): number {
      listener = onEvent; requested = true
      const result = start(null) as number
      if (!timer) {
        timer = setInterval(() => {
          if (!requested) return
          try {
            // Secure desktop and lock transitions invalidate held modifiers.
            if (++ticks % 125 === 0) {
              const current = read<KeyboardMonitorStatus>(status)
              if (available && !current.inputMonitoring) { reset(); stop() }
              if (current.inputMonitoring && (!available || !current.active)) start(null)
              available = current.inputMonitoring
            }
            const batch = read<{ events: KeyEvent[]; reset: boolean }>(drain)
            if (batch.reset) reset()
            else for (const event of batch.events) { if (!requested) break; emit(event) }
          } catch { reset() }
        }, 8)
        timer.unref()
      }
      return result
    },
    stopMonitor() { requested = false; clearInterval(timer); timer = undefined; stop(); listener = undefined },
    getStatus() { return read<KeyboardMonitorStatus>(status) },
    /** Shortcut keys the hook eats so they do not also reach the app in front. */
    setSwallow(keys: { key: string; modifiers: string[] }[], escape: boolean) {
      const bit: Record<string, number> = { Control: 1, Option: 2, Shift: 4, Command: 8 }
      const spec = keys.filter(k => !k.modifiers.includes('Fn')).map(k => `${k.key}:${k.modifiers.reduce((mask, m) => mask | (bit[m] ?? 0), 0)}`).join(',')
      swallow(spec, escape)
    },
  }
}
