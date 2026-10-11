import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { createRoot } from 'react-dom/client'
import { Icon, IconButton } from './components/ui'
import { TitleBar } from './components/title-bar'
import { HistoryPage } from './pages/history'
import { DictionaryPage } from './pages/dictionary'
import { SkillsPage } from './pages/skills'
import { Settings } from './pages/settings'
import { shortcutLabel } from './shortcut-label'
import { useAppearanceTheme } from './theme'
import {
  errorMessage,
  type HistoryStats,
  type Preferences,
  type SettingsTab,
} from '../shared/desktop'
import './app.css'
import { SpeechSettings } from './speech-settings'
const api = window.opentype
function Hub() {
  const [page, setPage] = useState('home'),
    [settings, setSettings] = useState<SettingsTab | null>(null),
    [toast, setToast] = useState(''),
    [prefs, setPrefs] = useState<Preferences>(),
    [onboarding, setOnboarding] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState('')
  const notify = useCallback((s: string) => setToast(s), []),
    closeSettings = useCallback(() => setSettings(null), [])
  const load = () =>
    Promise.all([api.config.get(), api.desktop.snapshot()])
      .then(([c, s]) => {
        setPrefs(s.preferences)
        setOnboarding(!c.hasOnboarded)
        setLoaded(true)
        setError('')
      })
      .catch((e) => setError(errorMessage(e)))
  useEffect(() => {
    void load()
    const off = api.desktop.onSettings((v) =>
      setSettings(
        (
          {
            0: 'general',
            1: 'account',
            2: 'about',
            3: 'personal',
            4: 'help',
          } as Record<number, SettingsTab>
        )[v.menu ?? 0] ?? 'general',
      ),
    )
    const offPrefs = api.desktop.onPreferences(setPrefs)
    return () => {
      off()
      offPrefs()
    }
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 4500)
    return () => clearTimeout(timer)
  }, [toast])
  useAppearanceTheme(prefs?.appearance)
  return (
    <>
      <TitleBar />
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <Icon name="logo" size={22} />
            <span>OpenType</span>
          </div>
          <nav>
            {[
              ['home', '首页', 'home'],
              ['history', '历史记录', 'history'],
              ['dictionary', '词典', 'book'],
              ['skills', 'Skills', 'blocks'],
            ].map(([id, label, icon]) => (
              <button
                key={id}
                className={page === id ? 'active' : ''}
                onClick={() => setPage(id)}
              >
                <Icon name={icon} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <span className="sidebar-fill" />
          <div className="sidebar-bottom">
            <IconButton
              name="user"
              label="账户"
              onClick={() => setSettings('account')}
            />
            <span className="sidebar-spacer" />
            <IconButton
              name="settings"
              label="设置"
              onClick={() => setSettings('general')}
            />
            <IconButton
              name="help"
              label="帮助"
              onClick={() => setSettings('help')}
            />
          </div>
        </aside>
        <main className="page-content">
          {error ? (
            <div className="error-panel" role="alert">
              {error}
              <button onClick={() => void load()}>重新加载</button>
            </div>
          ) : !loaded ? (
            <div className="empty-state">正在打开 OpenType…</div>
          ) : onboarding ? (
            <Onboarding
              preferences={prefs}
              complete={() => {
                void api.desktop
                  .completeOnboarding()
                  .then(() => setOnboarding(false))
                  .catch((e) => notify(errorMessage(e)))
              }}
            />
          ) : page === 'history' ? (
            <HistoryPage notify={notify} />
          ) : page === 'dictionary' ? (
            <DictionaryPage notify={notify} />
          ) : page === 'skills' && prefs ? (
            <SkillsPage preferences={prefs} save={async p => {
              try { setPrefs(await api.desktop.preferences(p)); notify('已保存'); return true }
              catch (e) { notify(errorMessage(e)); return false }
            }} />
          ) : (
            <Home
              preferences={prefs}
              openSettings={setSettings}
              navigate={setPage}
            />
          )}
        </main>
      </div>
      {settings && (
        <Settings initial={settings} onClose={closeSettings} notify={notify} />
      )}
      <div className={`toast ${toast ? 'visible' : ''}`} role="status">
        {toast}
      </div>
    </>
  )
}
function Home({
  preferences,
  openSettings,
  navigate,
}: {
  preferences?: Preferences
  openSettings: (tab: SettingsTab) => void
  navigate: (page: string) => void
}) {
  const [stats, setStats] = useState<HistoryStats>({ count: 0, words: 0, seconds: 0, dictationCharacters: 0, dictationSeconds: 0 }),
    [permissions, setPermissions] = useState<{
      accessibility: boolean
      inputMonitoring?: boolean
      microphone: number
    }>(),
    [error, setError] = useState('')
  const [recording, setRecording] = useState(false),
    [processing, setProcessing] = useState(false)
  useEffect(
    () =>
      api.desktop.recording.onState((s) => {
        setRecording(s.phase === 'preparing' || s.phase === 'recording')
        setProcessing(
          ['stopping', 'encoding', 'uploading', 'transcribing', 'refining', 'injecting'].includes(s.phase),
        )
        if (s.phase === 'error') setError(errorMessage(s.detail))
      }),
    [],
  )
  useEffect(() => {
    const refresh = () => {
      void api.desktop.history
        .stats()
        .then(setStats)
        .catch((e) => setError(errorMessage(e)))
      void api.device.getPermissions().then(setPermissions)
    }
    refresh()
    const off = api.desktop.onHistory(refresh)
    window.addEventListener('focus', refresh)
    return () => {
      off()
      window.removeEventListener('focus', refresh)
    }
  }, [])
  const binding = (action: string) =>
    shortcutLabel(preferences?.featureShortcutBindings[action]?.[0] ?? '')
      .split(' + ')
  const minutes = stats.seconds / 60
  const dictationMinutes = stats.dictationSeconds / 60
  const hasDictationStats = stats.dictationCharacters > 0 && dictationMinutes > 0
  const pace = hasDictationStats ? Math.round(stats.dictationCharacters / dictationMinutes) : null
  // Assumes 40 Chinese characters per minute when typing by hand.
  const savedHours = hasDictationStats ? Math.max(0, stats.dictationCharacters / 40 - dictationMinutes) / 60 : null
  const skills = preferences?.skills
  const toggle = () => {
    setError('')
    void (recording ? api.capture.stop() : api.capture.start({ preview: true }))
      .catch((e) => setError(errorMessage(e)))
  }
  return (
    <div className="home">
      <h1 className="hero-title">开口说，不用打字</h1>
      <div className="home-layout">
        <div className="home-main">
          <section className="card mode-card">
            {[
              ['听写', <>杂乱的口述 <Icon name="arrow" size={13} /> 干净的文字</>, 'dictationMode', ''],
              ['翻译', <>说中文 <Icon name="arrow" size={13} /> 地道的外文</>, 'translationMode', 'trans'],
              ['随便问', <>选中文字，改写或提问</>, 'askAnythingMode', 'ask'],
            ].map(([title, desc, action, tone]) => (
              <div className="mode-row" key={action as string}>
                <div>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                </div>
                <div className="mode-keys">
                  {binding(action as string).map((k) => (
                    <kbd key={k} className={`keycap ${tone}`}>{k}</kbd>
                  ))}
                </div>
                {action === 'dictationMode' ? (
                  <button
                    className={`mode-try ${recording ? 'recording' : ''}`}
                    disabled={processing}
                    title={recording ? '结束测试' : processing ? '正在识别…' : '试试听写'}
                    aria-label={recording ? '结束测试' : '试试听写'}
                    onClick={toggle}
                  >
                    <Icon name="mic" size={18} />
                  </button>
                ) : (
                  <span className="mode-try placeholder" />
                )}
              </div>
            ))}
            <div className="mode-foot">
              {preferences?.recordingActivation === 'hold' ? '按住说话，松开结束'
                : preferences?.recordingActivation === 'toggle' ? '按一下开始，再按一下结束'
                  : '短按开始/停止，长按松手结束'}
              {recording ? <span className="rec-dot">正在录音，再点一次结束</span>
                : processing ? <span>正在识别…</span> : null}
            </div>
          </section>
          {permissions &&
            (!permissions.accessibility || permissions.microphone !== 3 || permissions.inputMonitoring === false) && (
              <div className="permission-banner">
                <Icon name="info" />
                <span>还有权限没开，听写可能用不了。</span>
                <PermissionButtons
                  permissions={permissions}
                  refresh={() =>
                    void api.device.getPermissions().then(setPermissions)
                  }
                  setError={setError}
                />
              </div>
            )}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          {skills && (
            <>
              <div className="home-section-head">
                <h2>按场景整理</h2>
                <label className="home-skill-picker">
                  处理方式
                  <select aria-label="听写 Skill" value={skills.selected} disabled={processing || !skills.enabled}
                    onChange={e => void api.desktop.preferences({ skills: { ...skills, selected: e.target.value } }).catch(e => setError(errorMessage(e)))}>
                    <option value="auto">按场景自动选择</option><option value="none">不使用 Skill</option>
                    {skills.items.filter(s => s.enabled).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="scene-grid">
                {skills.items.filter(s => s.enabled).slice(0, 6).map((s, i) => (
                  <button
                    key={s.id}
                    className={`card scene-card ${skills.selected === s.id ? 'selected' : ''}`}
                    disabled={!skills.enabled || processing}
                    onClick={() => void api.desktop.preferences({
                      skills: { ...skills, selected: skills.selected === s.id ? 'auto' : s.id },
                    }).catch(e => setError(errorMessage(e)))}
                  >
                    <span className={`scene-badge tone-${i % 6}`}>{[...s.name][0]}</span>
                    <h3>{s.name}</h3>
                    <p>{s.description || '自定义处理指令'}</p>
                    <small>
                      <span>
                        {s.automatic && (s.apps.length || s.domains.length)
                          ? `自动匹配 ${s.apps.length + s.domains.length} 处`
                          : '手动选择'}
                      </span>
                      {skills.selected === s.id && <b title="当前使用" aria-label="当前使用"><Icon name="check" size={13} /></b>}
                    </small>
                  </button>
                ))}
                <button className="card scene-card scene-add" onClick={() => navigate('skills')}>
                  <Icon name="plus" size={20} />
                  <span>管理 Skills</span>
                </button>
              </div>
              {!skills.enabled && <p className="muted">Skills 已关闭，打开后可按场景整理文字。</p>}
            </>
          )}
        </div>
        <aside className="home-rail">
          <section className="card stat-card">
            {[
              ['clock', Math.round(minutes).toLocaleString(), 'min', '录音时长'],
              ['mic', stats.words.toLocaleString(), '字', '输出字数'],
              ['bolt', pace === null ? '—' : pace.toLocaleString(), '字/分', '口述速度'],
              ['hourglass', savedHours === null ? '—' : savedHours >= 1 ? savedHours.toFixed(1) : Math.round(savedHours * 60).toString(), savedHours !== null && savedHours >= 1 ? 'h' : 'min', '省下的打字时间'],
              ['pen', stats.count.toLocaleString(), '条', '历史记录'],
            ].map(([icon, value, unit, label]) => (
              <div className="stat" key={label}>
                <Icon name={icon} size={20} />
                <div>
                  {value === '—' ? <strong className="stat-empty">记录多一些后显示</strong> : <strong>{value}<small>{unit}</small></strong>}
                  <span>{label}</span>
                </div>
              </div>
            ))}
            
          </section>
          <button className="card promo-card green" onClick={() => openSettings('speech')}>
            <h3>隐私由您掌控</h3>
            <p>想完全离线，就用 <b>本地识别</b>，再关掉文字整理。</p>
            <span className="promo-glyph"><Icon name="lock" size={84} /></span>
          </button>
          <button className="card promo-card blue" onClick={() => navigate('dictionary')}>
            <h3>教它认识新词</h3>
            <p>把人名、品牌和术语加进 <b>词典</b>，识别更准。</p>
            <span className="promo-glyph"><Icon name="book" size={84} /></span>
          </button>
          <button className="text-button rail-link" onClick={() => navigate('history')}>
            查看历史记录 <Icon name="arrow" size={15} />
          </button>
        </aside>
      </div>
    </div>
  )
}
function PermissionButtons({
  permissions: p,
  refresh,
  setError,
}: {
  permissions: { accessibility: boolean; microphone: number; inputMonitoring?: boolean }
  refresh: () => void
  setError: (s: string) => void
}) {
  return (
    <div className="inline">
      {p.microphone !== 3 && (
        <button
          onClick={() => void (async () => {
            if (p.microphone === 2) await api.desktop.openUrl(api.platform === 'win32' ? 'ms-settings:privacy-microphone'
              : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
            else if (api.platform === 'darwin') await api.device.requestMicrophone()
            else {
              // getUserMedia is the permission/availability check on Windows;
              // release every track immediately after this explicit user action.
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
              stream.getTracks().forEach(track => track.stop())
            }
            refresh()
          })().catch(e => setError(errorMessage(e)))}
        >
          麦克风权限
        </button>
      )}
      {p.inputMonitoring === false && api.platform === 'darwin' && (
        <button onClick={() => void api.desktop.openUrl(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'
        ).then(refresh).catch((e) => setError(errorMessage(e)))}>输入监控权限</button>
      )}
      {!p.accessibility && (
        <button
          onClick={() =>
            void api.device
              .requestAccessibility()
              .then(refresh)
              .catch((e) => setError(errorMessage(e)))
          }
        >
          {api.platform === 'darwin' ? '辅助功能权限' : '重新检查输入状态'}
        </button>
      )}
    </div>
  )
}
function Onboarding({ complete, preferences }: { complete: () => void; preferences?: Preferences }) {
  const shortcut = (action: string) => shortcutLabel(preferences?.featureShortcutBindings[action]?.[0] ?? '')
  const [step, setStep] = useState(0),
    [permissions, setPermissions] = useState({
      accessibility: false,
      inputMonitoring: false,
      microphone: 0,
    }),
    [error, setError] = useState('')
  useEffect(() => {
    const refresh = () =>
      void api.device
        .getPermissions()
        .then(setPermissions)
        .catch((e) => setError(errorMessage(e)))
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const mic = permissions.microphone === 3
  const perms: [string, string, string, boolean, string, string][] = [
    ['mic', '麦克风', '录音', mic, '已授权', '待授权'],
    ['bolt', api.platform === 'darwin' ? '输入监控' : '键盘监听环境', '在任何应用里响应快捷键', !!permissions.inputMonitoring, '可用', '尚不可用'],
    ['pen', api.platform === 'darwin' ? '辅助功能' : '系统输入环境', '把文字写进输入框', permissions.accessibility, '可用', '尚不可用'],
  ]
  // Windows has no permission prompts for the keyboard hook or typing; only
  // show that step there when something is actually blocked.
  const skipPermissions = api.platform !== 'darwin' && mic && !!permissions.inputMonitoring && permissions.accessibility
  const shown = skipPermissions ? [0, 2, 3] : [0, 1, 2, 3], position = Math.max(0, shown.indexOf(step))
  return (
    <div className="onboarding">
      <div className="onb-main">
        <div className="onb-brand"><span className="brand-mark"><Icon name="logo" size={20} /></span>OpenType</div>
        <div className="onb-progress">
          <div className="steps">
            {shown.map((value, index) => <span key={value} className={index <= position ? 'active' : ''} />)}
          </div>
          <span>第 {position + 1} 步，共 {shown.length} 步</span>
        </div>
        {step === 0 ? (
          <>
            <h1>少打字，<br />多说话。</h1>
            <p>
              说出来，OpenType 帮你写成文字。
            </p>
            <div className="onb-actions">
              <button className="primary large" onClick={() => setStep(skipPermissions ? 2 : 1)}>
                开始使用 <Icon name="arrow" />
              </button>
            </div>
          </>
        ) : step === 1 ? (
          <>
            <h1>打开权限</h1>
            <p>{api.platform === 'darwin' ? '开启下面三项权限，快捷键和输入才能正常工作。'
              : '允许麦克风访问后即可开始。'}</p>
            <div className="onboarding-permissions">
              {perms.map(([icon, title, desc, ok, yes, no]) => (
                <div className={`perm-item ${ok ? 'ok' : ''}`} key={icon}>
                  <span className="perm-icon"><Icon name={icon} size={18} /></span>
                  <span className="perm-text"><strong>{title}</strong><small>{desc}</small></span>
                  <span className={`perm-state ${ok ? 'ok' : ''}`}>{ok && <Icon name="check" size={14} />}{ok ? yes : no}</span>
                </div>
              ))}
              <PermissionButtons
                permissions={permissions}
                refresh={() =>
                  void api.device.getPermissions().then(setPermissions)
                }
                setError={setError}
              />
            </div>
            <div className="onb-actions">
              <button className="primary large" onClick={() => setStep(2)}>
                继续 <Icon name="arrow" />
              </button>
              <button className="ghost" onClick={() => setStep(0)}>上一步</button>
            </div>
            <p className="muted">也可以稍后再授权。</p>
          </>
        ) : step === 2 ? (
          <>
            <h1>选择识别方式</h1>
            <p>之后可以在设置里随时更改。</p>
            <SpeechSettings embedded onDone={() => setStep(3)} onBack={() => setStep(skipPermissions ? 0 : 1)} />
          </>
        ) : (
          <>
            <h1>说第一句话试试</h1>
            <p>
              点进任意输入框，使用 <kbd>{shortcut('dictationMode')}</kbd>：
              {preferences?.recordingActivation === 'hold' ? '按住说话，松开结束'
                : preferences?.recordingActivation === 'toggle' ? '按一下开始，再按一下结束'
                  : '短按开始/停止，长按松手结束'}，Esc 取消。
            </p>
            <div className="onboarding-tips">
              {[
                ['听写', 'dictationMode', ''],
                ['翻译', 'translationMode', 'trans'],
                ['随便问', 'askAnythingMode', 'ask'],
              ].map(([label, action, tone]) => (
                <p key={action}>
                  <span>{label}</span>
                  <span className="mode-keys">
                    {shortcut(action).split(' + ').map((k) => <kbd key={k} className={`keycap ${tone}`}>{k}</kbd>)}
                  </span>
                </p>
              ))}
            </div>
            <div className="onb-actions">
              <button className="primary large" onClick={complete}>
                进入 OpenType <Icon name="arrow" />
              </button>
              <button className="ghost" onClick={() => setStep(2)}>上一步</button>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
      </div>
      <aside className={`onb-visual step-${step}`} aria-hidden="true">
        {step === 0 ? (
          <div className="onb-demo">
            <div className="onb-bubble raw">嗯…那个，明天下午三点，呃，不对，四点半开会，会议室还是 3B</div>
            <div className="onb-capsule"><span className="cap-x"><Icon name="close" size={13} /></span><span className="bars">{Array.from({ length: 13 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 0.08}s` }} />)}</span><span className="cap-stop"><Icon name="check" size={13} /></span></div>
            <div className="onb-bubble clean"><small>OpenType 整理后</small>明天下午四点半开会，会议室还是 3B。</div>
          </div>
        ) : step === 1 ? (
          <div className="onb-demo">
            <div className="onb-shield"><Icon name="lock" size={34} /></div>
            <h3>只用来听写</h3>
            <ul>
              <li>麦克风：录下你说的话</li>
              <li>{api.platform === 'darwin' ? '输入监控' : '键盘监听'}：在任何应用里响应快捷键</li>
              <li>{api.platform === 'darwin' ? '辅助功能' : '输入环境'}：把文字写进输入框</li>
            </ul>
          </div>
        ) : step === 2 ? (
          <div className="onb-demo">
            <div className="onb-shield"><Icon name="cloud" size={34} /></div>
            <h3>云端还是本地</h3>
          </div>
        ) : (
          <div className="onb-demo">
            <div className="onb-modes">
              {([['听写', 'dictationMode', 'dict'], ['翻译', 'translationMode', 'trans'], ['随便问', 'askAnythingMode', 'ask']] as const).map(([label, key, tone]) => (
                <div className="onb-mode" key={key}>
                  <span className="onb-mode-keys">{shortcut(key).split(' + ').map((k) => <kbd key={k} className={`keycap ${tone === 'dict' ? '' : tone}`}>{k}</kbd>)}</span>
                  <div className={`onb-capsule ${tone}`}><span className="cap-x"><Icon name="close" size={13} /></span><span className="bars">{Array.from({ length: 11 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 0.08}s` }} />)}</span><span className="cap-stop"><Icon name="check" size={13} /></span></div>
                  <span className="onb-mode-label">{label}</span>
                </div>
              ))}
            </div>
            <p className="onb-hint">胶囊颜色对应模式：白色听写，蓝色翻译，绿色随便问</p>
          </div>
        )}
      </aside>
    </div>
  )
}
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false }
  static getDerivedStateFromError() {
    return { error: true }
  }
  render() {
    return this.state.error ? (
      <div className="fatal-error">
        <h1>界面遇到问题</h1>
        <p>记录都还在，重新打开就好。</p>
        <button onClick={() => location.reload()}>重新打开</button>
      </div>
    ) : (
      this.props.children
    )
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <Hub />
  </ErrorBoundary>,
)
