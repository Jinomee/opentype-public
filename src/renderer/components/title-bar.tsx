import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'

const api = window.opentype

/**
 * Drag strip across the top of the window. macOS keeps its native traffic
 * lights (the strip starts after them); Windows hides the native title bar,
 * so the minimize / maximize / close controls are drawn here, above dialogs.
 */
export function TitleBar() {
  const custom = api.platform === 'win32'
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!custom) return
    void api.window.isMaximized().then(setMaximized).catch(() => {})
    return api.window.onMaximizedChange(setMaximized)
  }, [custom])
  return (
    <>
      <div className={`titlebar${custom ? ' custom' : ''}`} />
      {custom && (
        <div className="window-controls">
          <button type="button" aria-label="最小化" title="最小化" onClick={() => api.window.minimize()}>
            <Minus size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'}
            onClick={() => api.window.toggleMaximize()}>
            {maximized
              ? <Copy size={13} strokeWidth={1.5} aria-hidden="true" style={{ transform: 'scaleX(-1)' }} />
              : <Square size={12} strokeWidth={1.5} aria-hidden="true" />}
          </button>
          <button type="button" className="close" aria-label="关闭" title="关闭" onClick={() => api.window.close()}>
            <X size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}
