export interface InputSnapshot {
  windowBounds?: { x: number; y: number; width: number; height: number }
  traceId?: string
  token?: string
  reason?: string
  appName: string
  bundleId: string
  pid: number
  role?: string
  selectedText?: string
  contextText?: string
  webUrl?: string
  webUrls?: string[]
  contextRedacted?: boolean
  selectionReadOnly?: boolean
}
export interface DeliveryOutcome {
  status: 'verified' | 'unverified'
  method: string
  detail?: string
}
export interface InputDeliveryNative {
  prepare(token: string): { ok?: boolean; reason?: string } | Promise<{ ok?: boolean; reason?: string }>
  ready(token: string): { ok?: boolean; reason?: string }
  commit(token: string, text: string): { submitted?: boolean; method?: string; uncertain?: boolean; reason?: string } | Promise<{ submitted?: boolean; method?: string; uncertain?: boolean; reason?: string }>
  verify(token: string): { status?: 'verified' | 'unverified' | 'pending'; blind?: boolean; reason?: string }
}

/** Restoration may settle asynchronously. Only the native commit mutates text,
 * exactly once; verification never retries a paste, even after cancellation. */
export async function deliverToInput(
  native: InputDeliveryNative, snapshot: Pick<InputSnapshot, 'token' | 'reason'>, text: string, signal: AbortSignal,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<DeliveryOutcome> {
  signal.throwIfAborted()
  if (!snapshot.token) throw new Error(snapshot.reason || 'injection_target_unavailable')
  const token = snapshot.token, prepared = await native.prepare(token)
  if (!prepared.ok) throw new Error(prepared.reason || 'injection_target_unavailable')
  let ready = false, pendingReason = 'injection_target_unavailable'
  for (let attempt = 0; attempt < 20; attempt++) {
    signal.throwIfAborted()
    const state = native.ready(token)
    if (state.ok) { ready = true; break }
    // Chromium applies AX focus and selection changes asynchronously. The
    // native commit still rechecks the exact range immediately before paste.
    if (state.reason !== 'injection_focus_pending' && state.reason !== 'injection_selection_changed') throw new Error(state.reason || 'injection_target_unavailable')
    pendingReason = state.reason === 'injection_focus_pending' ? 'injection_focus_timeout' : state.reason
    await pause(40)
  }
  signal.throwIfAborted()
  if (!ready) throw new Error(pendingReason)
  let committed: Awaited<ReturnType<InputDeliveryNative['commit']>>
  try { committed = await native.commit(token, text) }
  catch {
    // A bridge failure cannot tell us whether the native side already posted
    // the paste. Do not offer an "unsent" fallback or automatically resend.
    return { status: 'unverified', method: 'unknown', detail: signal.aborted ? 'injection_cancelled_after_send' : 'injection_unverified' }
  }
  if (committed.reason === 'injection_already_sent') return { status: 'unverified', method: committed.method || 'unknown', detail: committed.reason }
  if (!committed.submitted && !committed.reason) return { status: 'unverified', method: 'unknown', detail: 'injection_unverified' }
  if (!committed.submitted) throw new Error(committed.reason || 'injection_failed')
  const method = committed.method || 'unknown'
  for (let attempt = 0; attempt < 12 && !committed.uncertain; attempt++) {
    if (signal.aborted) return { status: 'unverified', method, detail: 'injection_cancelled_after_send' }
    let state: ReturnType<InputDeliveryNative['verify']>
    try { state = native.verify(token) }
    catch { break }
    if (state.status === 'verified') return { status: 'verified', method }
    // The target app exposes no readable field (Windows blind typing): the
    // write went out and there is nothing to read back, so raise no warning.
    if (state.status === 'unverified' && state.blind) return { status: 'unverified', method }
    if (state.status !== 'pending') break
    await pause(50)
  }
  return { status: 'unverified', method, detail: 'injection_unverified' }
}
