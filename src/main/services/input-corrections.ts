import type { CaptureTarget } from './capture-session'
import type { CorrectionPair } from './correction-extraction'
import type { CorrectionAnalysis } from './correction-intelligence'

export interface InputObservationNative {
  begin(token: string, text: string): { ok?: boolean }
  read(token: string): { active?: boolean; text?: string; reason?: string }
  release(token: string): void
}
interface Observation { token: string; id: string; original: string; target: CaptureTarget; scope: string; started: number; latest: string; saved: string; changedAt: number; pausedAt?: number; revision: number; analyzingRevision?: number; analysisController?: AbortController }
interface Deps {
  native: InputObservationNative
  enabled: () => boolean
  allowed: (id: string, text: string, target: CaptureTarget) => boolean
  save: (id: string, original: string, corrected: string, target: CaptureTarget, scope: string, pairs?: CorrectionPair[], fallbackReason?: 'not_configured' | 'request_failed') => boolean
  analyze?: (original: string, corrected: string, signal: AbortSignal) => Promise<CorrectionAnalysis>
  scope?: () => string
  retract?: (id: string) => void
  now?: () => number
  schedule?: (fn: () => void) => () => void
}

/** One short-lived observation of a verified insertion. Native code checks the
 * exact field and unchanged surrounding text; only the inserted text crosses FFI.
 * No key logging, background-app polling, automatic dictionary writes or sync. */
export class InputCorrections {
  private current?: Observation
  private cancelTimer?: () => void
  constructor(private deps: Deps) {}
  private now() { return this.deps.now?.() ?? Date.now() }
  start(id: string, original: string, target: CaptureTarget): boolean {
    this.stop(true)
    if (!target.inputToken || !original || original.length > 100_000 || target.audioContext.redacted || !this.deps.enabled()) return false
    try {
      if (!this.deps.allowed(id, original, target) || !this.deps.native.begin(target.inputToken, original).ok) return false
      const now = this.now()
      this.current = { token: target.inputToken, id, original, target, scope: this.deps.scope?.() ?? '', started: now, latest: original, saved: original, changedAt: now, revision: 0 }
      const tick = () => this.poll()
      this.cancelTimer = this.deps.schedule ? this.deps.schedule(tick) : (() => {
        const timer = setInterval(tick, 250); timer.unref(); return () => clearInterval(timer)
      })()
      return true
    } catch {
      // Until true is returned the capture session still owns the native token.
      this.current = undefined; this.cancelTimer?.(); this.cancelTimer = undefined
      return false
    }
  }
  poll() {
    const s = this.current
    if (!s) return
    try {
      const now = this.now()
      if (now - s.started >= 60_000) { this.stop(true); return }
      if (!this.deps.enabled() || !this.deps.allowed(s.id, s.original, s.target)
        || (this.deps.scope && this.deps.scope() !== s.scope)) { this.stop(); return }
      const value = this.deps.native.read(s.token)
      if (!value.active) {
        // A short app/field focus change is common while correcting text. Native
        // code returns only the original field's value after focus returns; it
        // never reads the field that temporarily received focus.
        if (['app_inactive', 'field_unfocused'].includes(value.reason ?? '')) {
          s.pausedAt ??= now
          if (now - s.pausedAt < 8_000) return
          this.stop(true); return
        }
        this.stop(); return
      }
      s.pausedAt = undefined
      if (typeof value.text !== 'string' || value.text.length > 100_000) { this.stop(); return }
      if (value.text !== s.latest) {
        // Remove a superseded, still-pending proposal immediately, including
        // undo. Accepted dictionary terms remain under explicit user control.
        s.revision++
        s.analysisController?.abort()
        s.analysisController = undefined
        s.analyzingRevision = undefined
        if (s.saved !== s.original) {
          if (!this.deps.save(s.id, s.original, s.original, s.target, s.scope)) { this.stop(); return }
          s.saved = s.original
        }
        this.deps.retract?.(s.id)
        s.latest = value.text; s.changedAt = now; return
      }
      if (s.latest !== s.saved && now - s.changedAt >= 1500) {
        if (s.analyzingRevision !== s.revision) this.analyze(s, s.revision, s.latest)
      }
    } catch { this.stop() }
  }
  cancel(id: string) { if (this.current?.id === id) this.stop() }
  private analyze(s: Observation, revision: number, corrected: string) {
    s.analyzingRevision = revision
    const controller = new AbortController()
    s.analysisController = controller
    const finish = (pairs?: CorrectionPair[], fallbackReason?: 'not_configured' | 'request_failed') => {
      if (this.current !== s || s.revision !== revision || controller.signal.aborted) return
      try {
        const fresh = this.deps.native.read(s.token)
        if (!fresh.active || fresh.text !== corrected) {
          controller.abort()
          s.analysisController = undefined
          s.analyzingRevision = undefined
          return
        }
      } catch {
        controller.abort()
        s.analysisController = undefined
        s.analyzingRevision = undefined
        return
      }
      if (!this.deps.enabled() || !this.deps.allowed(s.id, s.original, s.target)
        || (this.deps.scope && this.deps.scope() !== s.scope)) { this.stop(); return }
      if (!this.deps.save(s.id, s.original, corrected, s.target, s.scope, pairs, fallbackReason)) { this.stop(); return }
      s.saved = corrected
      s.analysisController = undefined
      s.analyzingRevision = undefined
    }
    if (!this.deps.analyze) { finish(undefined, 'not_configured'); return }
    void this.deps.analyze(s.original, corrected, controller.signal).then(result => {
      if (result.kind === 'cancelled') return
      finish(result.kind === 'ok' ? result.pairs : undefined,
        result.kind === 'unavailable' ? result.reason : undefined)
    }).catch(() => finish(undefined, 'request_failed'))
  }
  stop(preserveStable = false) {
    const s = this.current
    this.current = undefined
    this.cancelTimer?.(); this.cancelTimer = undefined
    if (s) {
      s.analysisController?.abort()
      // Keep the last stable suggestion when observation ends. If the user
      // left during an unfinished edit, remove the older proposal instead.
      if (!preserveStable || s.latest !== s.saved) this.deps.retract?.(s.id)
      this.deps.native.release(s.token)
    }
  }
}
