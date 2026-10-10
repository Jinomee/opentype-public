import { useEffect, useRef, useState } from 'react'
import type { KeyboardMonitorStatus, Preferences, SettingsTab } from '../../shared/desktop'
import { errorMessage } from '../../shared/desktop'
import { COMMON_WRITING_APPS, EXPRESSIONS, type ExpressionStyle, type WritingApp } from '../../shared/output-preferences'
import { Icon, Modal, Row, Toggle } from '../components/ui'
import { ShortcutRecorder } from '../components/shortcut-recorder'
import { shortcutLabel } from '../shortcut-label'
import { SpeechSettings } from '../speech-settings'
import { Markdown } from '../components/markdown'
import { SettingsBackup } from '../components/settings-backup'
import { AccountChallenge } from '../components/account-challenge'
import type { UpdateState } from '../../shared/updater'
import type { OutputAudioStatus } from '../../shared/output-audio'
const api = window.opentype
const tabs: [SettingsTab, string, string][] = [
  ['account', '账户', 'user'],
  ['general', '设置', 'settings'],
  ['speech', '听写模型', 'mic'],
  ['personal', '个性化', 'pen'],
  ['about', '关于', 'info'],
  ['help', '帮助', 'help'],
]
export function Settings({
  initial,
  onClose,
  notify,
}: {
  initial: SettingsTab
  onClose: () => void
  notify: (s: string) => void
}) {
  const [tab, setTab] = useState<SettingsTab>(initial === 'skills' ? 'general' : initial),
    [prefs, setPrefs] = useState<Preferences>(),
    [error, setError] = useState('')
  useEffect(() => {
    void api.desktop
      .snapshot()
      .then((v) => setPrefs(v.preferences))
      .catch((e) => setError(errorMessage(e)))
    return api.desktop.onPreferences(setPrefs)
  }, [])
  const save = async (p: Partial<Preferences>) => {
    try {
      setPrefs(await api.desktop.preferences(p))
      notify('设置已保存')
      return true
    } catch (e) {
      notify(errorMessage(e))
      return false
    }
  }
  return (
    <Modal title="设置" onClose={onClose} wide>
      <div className="settings-layout">
        <nav className="settings-nav">
          {tabs.map(([id, label, icon]) => (
            <button
              className={tab === id ? 'active' : ''}
              key={id}
              onClick={() => setTab(id)}
            >
              <Icon name={icon} size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-content" key={tab}>
          <h1>{tabs.find(([id]) => id === tab)?.[1]}</h1>
          {error && <p role="alert">{error}</p>}
          {tab === 'general' && prefs && (
            <General preferences={prefs} save={save} notify={notify} />
          )}
          {tab === 'speech' && <SpeechSettings embedded />}
          {tab === 'account' && <Account notify={notify} />}
          {tab === 'personal' && prefs && (
            <Personal preferences={prefs} save={save} />
          )}
          {tab === 'about' && <About />}
          {tab === 'help' && <Help />}
        </div>
      </div>
    </Modal>
  )
}
function General({
  preferences: p,
  save,
  notify,
}: {
  preferences: Preferences
  save: (p: Partial<Preferences>) => Promise<boolean>
  notify: (s: string) => void
}) {
  const [shortcut, setShortcut] = useState<{ action: string; index: number } | null>(null),
    [config, setConfig] = useState<any>(),
    [mics, setMics] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    let active = true
    void api.config.get().then(c=>{if(active)setConfig(c)})
    const refresh = () => void navigator.mediaDevices.enumerateDevices()
      .then(ds => {if(active)setMics(ds.filter(d=>d.kind==='audioinput'))}).catch(()=>{})
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    window.addEventListener('focus', refresh)
    return () => { active=false; navigator.mediaDevices.removeEventListener('devicechange',refresh); window.removeEventListener('focus',refresh) }
  }, [])
  const configSave = async (patch: Record<string, unknown>) => {
    try {
      setConfig(await api.config.set(patch))
      notify('设置已保存')
    } catch (e) {
      notify(errorMessage(e))
    }
  }
  return (
    <>
      <h3 className="section-heading">快捷键</h3>
      <KeyboardStatus notify={notify} />
      <Row title="录音方式" >
        <select aria-label="录音方式" value={p.recordingActivation}
          onChange={e => void save({ recordingActivation: e.target.value as Preferences['recordingActivation'] })}>
          <option value="auto">短按或长按</option>
          <option value="toggle">按一下开始，再按一下结束</option>
          <option value="hold">按住说话，松开结束</option>
        </select>
      </Row>
      {[
        ['dictationMode', '语音输入', ''],
        ['translationMode', '翻译', ''],
        ['askAnythingMode', '随便问', ''],
        ['pasteLastTranscript', '粘贴上一条听写', '再粘贴一次上一条结果'],
        ['selectionActions', '选中文字快捷操作', '对选中的文字摘要、改写、翻译或校对'],
      ].map(([id, title, desc]) => (
        <Row key={id} title={title} description={desc}>
          <div className="shortcut-alternatives">
            {(p.featureShortcutBindings[id] ?? []).map((value,index)=><div className="shortcut-alternative" key={index}>
              <button className="shortcut" aria-label={`修改${title}快捷键 ${index+1}`} onClick={()=>setShortcut({action:id,index})}>{shortcutLabel(value)}</button>
              {((p.featureShortcutBindings[id]?.length??0)>1||['pasteLastTranscript','selectionActions'].includes(id)) && <button aria-label={`移除${title}快捷键 ${index+1}`} onClick={()=>void save({featureShortcutBindings:{...p.featureShortcutBindings,[id]:p.featureShortcutBindings[id].filter((_,i)=>i!==index)}})}>×</button>}
            </div>)}
            {(p.featureShortcutBindings[id]?.length??0)<3 && <button onClick={()=>setShortcut({action:id,index:p.featureShortcutBindings[id]?.length??0})}>添加快捷键</button>}
          </div>
        </Row>
      ))}
      <h3 className="section-heading">语言</h3>
      <Row title="识别语言" description={config?.provider === 'siliconflow' ? '云端 SiliconFlow 始终自动识别语言，此项对它不生效。' : '选择自动检测或指定说话的语言。'}>
        <select
          aria-label="识别语言"
          value={
            p.selectedLanguages.length === 1 ? p.selectedLanguages[0] : 'auto'
          }
          onChange={(e) =>
            void save({
              selectedLanguages:
                e.target.value === 'auto' ? [] : [e.target.value],
            })
          }
        >
          {[
            ['auto', '自动检测'],
            ['zh-CN', '普通话'],
            ['yue', '粤语'],
            ['en', 'English'],
            ['ja', '日本語'],
            ['ko', '한국어'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Row>
      <Row title="翻译目标" description="语音翻译后输出的语言。">
        <select
          aria-label="翻译目标"
          value={config?.outputLanguage ?? 'en'}
          onChange={(e) => void configSave({ outputLanguage: e.target.value })}
        >
          {[
            ['en', 'English'],
            ['zh-CN', '简体中文'],
            ['zh-TW', '繁體中文'],
            ['ja', '日本語'],
            ['ko', '한국어'],
            ['fr', 'Français'],
            ['de', 'Deutsch'],
            ['es', 'Español'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Row>
      <h3 className="section-heading">音频</h3>
      <Row
        title="麦克风"
        
      >
        <select
          aria-label="麦克风"
          value={config?.micDeviceId ?? 'default'}
          onChange={(e) => void configSave({ micDeviceId: e.target.value })}
        >
          <option value="default">跟随系统默认麦克风</option>
          {config?.micDeviceId && config.micDeviceId !== 'default' && !mics.some(m=>m.deviceId===config.micDeviceId) && <option value={config.micDeviceId}>已选设备未连接或尚未授权</option>}
          {mics
            .filter((m) => m.deviceId && m.deviceId !== 'default')
            .map((m, i) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || `麦克风 ${i + 1}`}
              </option>
            ))}
        </select>
      </Row>
      <Row title="录音提示音" >
        <Toggle label="录音提示音" checked={p.interactionSounds} onChange={interactionSounds=>void save({interactionSounds})}/>
      </Row>
      <OutputAudioSettings value={p.outputAudio} save={save} />
      {p.outputAudio==='mute'&&p.interactionSounds&&<p className="muted">外放静音时也听不到提示音。</p>}
      {([
        ['echoCancellation','回声消除',''],
        ['noiseSuppression','环境降噪',''],
        ['autoGainControl','自动增益',''],
      ] as const).map(([key,title,description])=><Row title={title} description={description} key={key}>
        <Toggle label={title} checked={p.audioProcessing[key]} onChange={value=>void save({audioProcessing:{...p.audioProcessing,[key]:value}})}/>
      </Row>)}
      
      <h3 className="section-heading">常规</h3>
      <Row title="浮窗位置" >
        <select aria-label="浮窗位置" value={p.floatingBar.placement} onChange={e=>void save({floatingBar:{...p.floatingBar,placement:e.target.value as Preferences['floatingBar']['placement']}})}>
          <option value="bottom">当前屏幕底部</option><option value="top">当前屏幕顶部</option><option value="remember">记住拖动位置</option>
        </select>
      </Row>
      <Row title="外观" description="选择明亮模式或黑暗模式。">
        <select
          aria-label="外观"
          value={p.appearance}
          onChange={(e) =>
            void save({
              appearance: e.target.value as Preferences['appearance'],
            })
          }
        >
          <option value="light">明亮</option>
          <option value="dark">黑暗</option>
          <option value="system">跟随系统</option>
        </select>
      </Row>
      <Row
        title="登录时启动应用"
        description="当您的计算机启动时自动打开 OpenType。"
      >
        <Toggle
          label="登录时启动应用"
          checked={p.launchAtLogin}
          onChange={(v) => void save({ launchAtLogin: v })}
        />
      </Row>
      {api.platform === 'darwin' && <Row
        title="在 Dock 中显示应用"
        description="在您的 Mac Dock 中显示 OpenType 以便快速访问。"
      >
        <Toggle
          label="在 Dock 中显示应用"
          checked={p.showInDock}
          onChange={(v) => void save({ showInDock: v })}
        />
      </Row>}
      <Row title="自动插入文字" description="完成听写后将文字输入原来的应用。">
        <Toggle
          label="自动插入文字"
          checked={config?.autoInject ?? true}
          onChange={(v) => void configSave({ autoInject: v })}
        />
      </Row>
      <SettingsBackup notify={notify} />
      {shortcut && <ShortcutRecorder
        current={p.featureShortcutBindings[shortcut.action]?.[shortcut.index] ?? ''}
        onClose={() => setShortcut(null)}
        onSave={value => { const next = [...(p.featureShortcutBindings[shortcut.action] ?? [])]; next[shortcut.index] = value; return save({ featureShortcutBindings: { ...p.featureShortcutBindings, [shortcut.action]: next } }) }}
      />}
    </>
  )
}
function OutputAudioSettings({ value, save }: { value: Preferences['outputAudio']; save: (patch: Partial<Preferences>) => Promise<boolean> }) {
  const [status, setStatus] = useState<OutputAudioStatus>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const supported = status?.supported ?? (api.platform === 'darwin' || api.platform === 'win32')
  useEffect(() => {
    let mounted = true, live = false
    const unwatch = api.desktop.outputAudio.onState(next => { live = true; if (mounted) setStatus(next) })
    void api.desktop.outputAudio.status().then(next => { if (mounted && !live) setStatus(next) })
      .catch(e => { if (mounted) setError(errorMessage(e)) })
    return () => { mounted = false; unwatch() }
  }, [])
  const retry = async () => {
    setBusy(true); setError('')
    try { setStatus(await api.desktop.outputAudio.retryRecovery()) }
    catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const labels: Record<OutputAudioStatus['phase'], string> = {
    idle: '没有待恢复的外放音量', starting: '正在调整外放音量',
    active: status?.detail === 'output_audio_changed' ? '保留您调整后的外放音量' : '录音音量设置已生效',
    restoring: '正在恢复外放音量', pending: '外放音量尚未完全恢复', error: '外放音量操作未完成',
  }
  return <>
    <Row title="录音时的外放音量" description={supported ? '' : '此平台暂不支持自动调节外放音量。'}>
      <select aria-label="录音时的外放音量" disabled={!supported} value={value} onChange={e => void save({ outputAudio: e.target.value as Preferences['outputAudio'] })}>
        <option value="off">保持原音量</option><option value="duck">降到原音量的 20%</option><option value="mute">静音外放</option>
      </select>
    </Row>
    {supported && <div aria-live="polite">
      {status && <p className="muted">{labels[status.phase]}{status.detail ? `：${errorMessage(status.detail)}` : ''}</p>}
      {status && ['pending', 'error'].includes(status.phase) && <>
        <button disabled={busy || status.recording} onClick={() => void retry()}>{busy ? '正在重试…' : '重试恢复音量'}</button>
        {status.recording && <p className="muted">结束录音后可重试恢复。</p>}
      </>}
      {api.platform === 'win32' && <p className="muted">只调节系统默认的播放设备。</p>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </>
}

function KeyboardStatus({ notify }: { notify: (s: string) => void }) {
  const [status, setStatus] = useState<KeyboardMonitorStatus>()
  useEffect(() => {
    let alive = true
    const refresh = () => void api.desktop.keyboard.status()
      .then((value) => { if (alive) setStatus(value) })
      .catch(() => {})
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const ready = status?.active && status.callbackRegistered && status.inputMonitoring
  return <Row tone={!status ? undefined : ready ? 'ok' : 'warn'} title={ready ? '全局快捷键监听已就绪' : '全局快捷键尚未就绪'} description={
    !status ? '正在检查…' : !status.inputMonitoring
      ? api.platform === 'darwin' ? '请在系统设置的「输入监控」里打开 OpenType'
        : '解锁屏幕或关掉安全提示后重新连接'
      : ready ? ''
        : '监听已暂停'
  }>
    <div className="inline">
      {status && !status.inputMonitoring && api.platform === 'darwin' && <button onClick={() => void api.desktop.openUrl(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'
      ).catch((e) => notify(errorMessage(e)))}>输入监控权限</button>}
      <button onClick={() => void api.desktop.keyboard.restart().then((value) => {
        setStatus(value)
        notify(value.active ? '快捷键监听已重新连接' : api.platform === 'darwin' ? '监听尚未就绪，请检查输入监控权限' : '监听尚未就绪，请返回普通桌面后重试')
      }).catch((e) => notify(errorMessage(e)))}>重新连接</button>
    </div>
  </Row>
}

function Personal({
  preferences: p,
  save,
}: {
  preferences: Preferences
  save: (p: Partial<Preferences>) => Promise<boolean>
}) {
  const [style, setStyle] = useState(p.personalStyle)
  const [apps, setApps] = useState<WritingApp[]>(COMMON_WRITING_APPS)
  const [selectedApp, setSelectedApp] = useState(COMMON_WRITING_APPS[0].bundleId)
  const [expression, setExpression] = useState<ExpressionStyle>('casual')
  const [savingRule, setSavingRule] = useState(false)
  useEffect(() => { void api.desktop.writingApps().then(setApps).catch(() => {}) }, [])
  // 语气与写作偏好只在文字整理（DeepSeek）可用时生效；状态来自听写设置的 config
  const [refineReady, setRefineReady] = useState<boolean>()
  useEffect(() => {
    let active = true
    const apply = (c: { enableRefine?: boolean; hasRefineApiKey?: boolean } | null | undefined) => {
      if (active && c) setRefineReady(!!c.enableRefine && !!c.hasRefineApiKey)
    }
    const off = api.config.onChanged(apply)
    void api.config.get().then(apply).catch(() => {})
    return () => { active = false; off() }
  }, [])
  const styleOff = !p.usePersonalStyle
  const styleHint = styleOff ? '已关闭「启用语气与写作偏好」，以下设置暂不生效。'
    : refineReady === false ? '文字整理未开启或未填写 DeepSeek API Key，以下设置暂不生效。' : ''
  const updateRule = async () => {
    const app = apps.find(a => a.bundleId === selectedApp)
    if (!app) return
    setSavingRule(true)
    try { await save({ appExpressions: [...p.appExpressions.filter(a => a.bundleId !== app.bundleId), { ...app, expression }] }) }
    finally { setSavingRule(false) }
  }
  return (
    <>
      <Row title="从历史修改生成纠词建议" description="你在历史里改过的词，会提示加入词典">
        <Toggle label="从历史修改生成纠词建议" checked={p.learnFromEdits} onChange={v => void save({ learnFromEdits: v })} />
      </Row>
      <Row title="从输入框修改生成纠词建议" description="听写后一分钟内识别你修改的词语，提示加入词典。启用文字整理并配置 DeepSeek 后优先使用 AI，否则使用本地识别。">
        <Toggle label="从输入框修改生成纠词建议" checked={p.learnFromInputEdits} onChange={v => void save({ learnFromInputEdits: v })} />
      </Row>
      <h2>听写输出格式</h2>
      
      <Row title="中文标点" >
        <select aria-label="中文标点" value={p.outputPreferences.punctuation}
          onChange={e => void save({ outputPreferences: { ...p.outputPreferences, punctuation: e.target.value as 'preserve' | 'chinese' } })}>
          <option value="preserve">保持结果</option><option value="chinese">使用中文标点</option>
        </select>
      </Row>
      <Row title="中英文与数字间距" >
        <select aria-label="中英文与数字间距" value={p.outputPreferences.spacing}
          onChange={e => void save({ outputPreferences: { ...p.outputPreferences, spacing: e.target.value as 'preserve' | 'space' | 'compact' } })}>
          <option value="preserve">保持结果</option><option value="space">加一个空格</option><option value="compact">不加空格</option>
        </select>
      </Row>
      <Row
        title="启用语气与写作偏好"
        description={refineReady === false ? '需要开启文字整理并填写 DeepSeek API Key（听写设置）' : '需要开启文字整理'}
      >
        <Toggle
          label="启用语气与写作偏好"
          checked={p.usePersonalStyle}
          onChange={(v) => void save({ usePersonalStyle: v })}
        />
      </Row>
      <Row title="默认表达方式" >
        <select aria-label="默认表达方式" disabled={!p.usePersonalStyle} value={p.outputPreferences.expression}
          onChange={e => void save({ outputPreferences: { ...p.outputPreferences, expression: e.target.value as ExpressionStyle } })}>
          {EXPRESSIONS.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
        </select>
      </Row>
      <div className={`app-expression-card${styleOff ? ' is-disabled' : ''}`}>
        <h2>按应用选择表达方式</h2>
        <p className="muted">比如微信用口语，邮件用正式表达。</p>
        {styleHint && <p className="muted setting-hint">{styleHint}</p>}
        <div className="app-expression-controls">
          <label className="field">应用<select aria-label="应用表达规则的应用" disabled={styleOff} value={selectedApp} onChange={e => setSelectedApp(e.target.value)}>
            {apps.map(a => <option key={a.bundleId} value={a.bundleId}>{a.appName}</option>)}
          </select></label>
          <label className="field">表达方式<select aria-label="应用表达规则的语气" disabled={styleOff} value={expression} onChange={e => setExpression(e.target.value as ExpressionStyle)}>
            {EXPRESSIONS.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select></label>
          <button disabled={styleOff || savingRule || (!p.appExpressions.some(a => a.bundleId === selectedApp) && p.appExpressions.length >= 50)} onClick={() => void updateRule()}>保存应用规则</button>
        </div>
        {p.appExpressions.map(rule => <Row key={rule.bundleId} title={rule.appName} description={EXPRESSIONS.find(([key]) => key === rule.expression)?.[1]}>
          <button aria-label={`移除${rule.appName}的表达规则`} onClick={() => void save({ appExpressions: p.appExpressions.filter(a => a.bundleId !== rule.bundleId) })}>恢复默认</button>
        </Row>)}
        
      </div>
      <div className={`personal-card${styleOff ? ' is-disabled' : ''}`}>
        <Icon name="spark" size={32} />
        <h2>让文字更像您</h2>
        <p>告诉它你习惯怎么写。</p>
        {styleHint && <p className="setting-hint">{styleHint}</p>}
        <label className="field">
          写作偏好
          <textarea
            rows={6}
            disabled={styleOff}
            value={style}
            maxLength={1200}
            onChange={(e) => setStyle(e.target.value)}
            placeholder="例如：表达简洁，使用中文标点；列举事项时分行，不添加表情。"
          />
        </label>
        <button
          className="primary"
          disabled={styleOff}
          onClick={() => void save({ personalStyle: style })}
        >
          保存偏好
        </button>
      </div>
    </>
  )
}
function Account({ notify }: { notify: (s: string) => void }) {
  const [challengeToken, setChallengeToken] = useState<string | null>(null)
  const [challengeAttempt, setChallengeAttempt] = useState(0)
  const [logged, setLogged] = useState(false),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sync, setSync] = useState<any>(null),
    [accountLoaded, setAccountLoaded] = useState(false),
    [phase, setPhase] = useState('')
  const authPending = useRef(false)
  const [pendingDeletions, setPendingDeletions] = useState(0)
  const [cloudExcluded, setCloudExcluded] = useState(0), [pendingCloudWipe, setPendingCloudWipe] = useState(false)
  const [confirmWipe, setConfirmWipe] = useState(false), [confirmRetention, setConfirmRetention] = useState<number | null>(null)
  const refreshLocal = async () => {
    const state = await api.sync.localStatus()
    setPendingDeletions(state.pendingDeletions)
    setCloudExcluded(state.cloudExcluded)
    setPendingCloudWipe(state.pendingCloudWipe)
  }
  const refreshSync = async () => {
    const status = await api.sync.status()
    setSync(status)
    await refreshLocal()
    if (!status) throw new Error('连不上同步服务')
  }
  const loadAccount = async () => {
    setError('')
    try { setLogged(await api.auth.isLoggedIn()); setAccountLoaded(true) }
    catch (e) { setError(errorMessage(e)) }
  }
  useEffect(() => {
    void api.sync.localStatus().then(s => { setPendingDeletions(s.pendingDeletions); setCloudExcluded(s.cloudExcluded ?? 0); setPendingCloudWipe(s.pendingCloudWipe === true) })
      .catch((e) => setError(errorMessage(e)))
  }, [logged, phase])
  useEffect(() => {
    void loadAccount()
    return api.sync.onState((s) => {
      setPhase(s.phase)
      if (s.phase === 'error') setError(errorMessage(s.detail))
    })
  }, [])
  useEffect(() => {
    if (logged)
      void refreshSync().catch((e) => setError(errorMessage(e)))
    else setSync(null)
  }, [logged])
  const syncSave = async (p: {
    sync_enabled?: boolean
    cloud_retention?: number
  }) => {
    setBusy(true);setError('')
    try {
      const r = await api.sync.updateSettings(p)
      if (r === null) {
        if (p.sync_enabled === false) {
          setSync((old: any) => ({ ...old, sync_enabled: false }))
          notify('已在本机关闭同步，联网后更新服务端')
          return
        }
        throw new Error('暂时无法连接同步服务')
      }
      setSync(r)
      await refreshLocal()
      notify(p.sync_enabled === false ? '云端同步已关闭' : '同步设置已保存')
    } catch (e) {
      setError(errorMessage(e))
    } finally { setBusy(false) }
  }
  return (
    <>
      {logged && accountLoaded && <div className="account-head">
        <div><h2>已登录</h2><p>历史和词典可以在设备间同步。</p></div>
        <button disabled={busy} onClick={async () => {
          if (authPending.current) return
          authPending.current = true; setBusy(true); setError('')
          try { await api.auth.logout(); setLogged(false); setPassword('') }
          catch (e) { setError(errorMessage(e)) }
          finally { authPending.current = false; setBusy(false) }
        }}>退出登录</button>
      </div>}
      {!accountLoaded ? <p role="status">{error ? <button onClick={() => void loadAccount()}>重新读取账户状态</button> : '正在读取账户状态…'}</p> : !logged ? (
        <form className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault()
            if (authPending.current || busy || !accountLoaded) return
            if (challengeToken === null) { setError(errorMessage('challenge_required')); return }
            const token = challengeToken
            setChallengeToken(null)
            authPending.current = true
            setBusy(true)
            setError('')
            try {
              const r = await (register
                ? api.auth.register({ email: email.trim(), password, turnstileToken: token || undefined })
                : api.auth.loginWithPassword({ email: email.trim(), password, turnstileToken: token || undefined }))
              if (!r.success) throw new Error(r.detail || '暂时无法登录，请重试')
              setLogged(true)
              setPassword('')
            } catch (e) {
              setError(errorMessage(e))
            } finally {
              authPending.current = false
              setBusy(false)
              setChallengeAttempt(value => value + 1)
            }
          }}
        >
          <div className="auth-title"><h2>{register ? '注册 OpenType' : '登录 OpenType'}</h2><p>同步历史和词典。不登录也能听写。</p></div>
          <label className="field">
            邮箱
            <input
              type="email"
              value={email}
              disabled={busy}
              required
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="field">
            密码
            <input
              type="password"
              value={password}
              disabled={busy}
              minLength={register ? 8 : undefined}
              required
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={register ? 'new-password' : 'current-password'}
            />
          </label>
          <AccountChallenge key={`${register ? 'register' : 'login'}-${challengeAttempt}`} action={register ? 'register' : 'login'}
            disabled={busy} onToken={setChallengeToken} />
          <button className="primary auth-submit" disabled={busy || challengeToken === null}>
            {busy ? '处理中…' : register ? '注册并登录' : '登录'}
          </button>
          <p className="auth-switch">{register ? '已有账户？' : '还没有账户？'}
            <button type="button" className="link" disabled={busy} onClick={() => { setChallengeToken(null); setRegister(!register); setError('') }}>
              {register ? '去登录' : '注册'}</button></p>
        </form>
      ) : (
        <>
          <Row
            title="云端同步"
            description="开启后，历史文字会上传到 OpenType；录音不参与同步。词典同步在词典页单独开启。"
          >
            <Toggle
              label="云端同步"
              disabled={busy || !sync || phase === 'clearing_cloud'}
              checked={!!sync?.sync_enabled}
              onChange={(v) => void syncSave({ sync_enabled: v })}
            />
          </Row>
          <Row title="云端保留时间" description="到期只删云端副本，本机不受影响。">
            <select
              aria-label="云端保留时间"
              value={sync?.cloud_retention ?? -1}
              disabled={busy || sync?.cloud_lifecycle_version !== 1}
              onChange={(e) => {
                const days = Number(e.target.value), old = sync?.cloud_retention ?? -1
                if (days > 0 && (old < 0 || days < old)) setConfirmRetention(days)
                else void syncSave({ cloud_retention: days })
              }}
            >
              <option value={-1}>永远</option>
              <option value={90}>90 天</option>
              <option value={30}>30 天</option>
              <option value={7}>7 天</option>
            </select>
          </Row>
          <Row title="云端历史" description={sync ? `云端现有 ${sync.total ?? 0} 条。${sync.cloud_lifecycle_version !== 1 ? '保留和清空暂不可用。' : ''}` : '正在读取…'}>
            <div className="row-actions">
              <button disabled={busy || !sync?.sync_enabled || phase === 'pushing' || phase === 'clearing_cloud'}
                onClick={() =>
                  void api.sync
                    .pushNow()
                    .then(r => { if (r.detail) throw new Error(r.detail) })
                    .then(() => api.sync.pull())
                    .then(r => { if (r.detail) throw new Error(r.detail) })
                    .then(refreshSync)
                    .then(() => notify('同步完成'))
                    .catch((e) => setError(errorMessage(e)))
                }>{phase === 'pushing' ? '同步中…' : '立即同步'}</button>
              <button className="danger-text" disabled={busy || phase === 'clearing_cloud' || sync?.cloud_lifecycle_version !== 1}
                onClick={() => setConfirmWipe(true)}>{pendingCloudWipe ? '确认上次清空' : '清空'}</button>
            </div>
          </Row>
          {pendingDeletions > 0 && <p className="muted">待云端确认删除：{pendingDeletions} 条，联网后自动同步。</p>}
          {cloudExcluded > 0 && <p className="muted">{cloudExcluded} 条记录因云端清空或到期仅保留在本机，不会再次自动上传。</p>}
        </>
      )}
      {confirmWipe && <Modal title={pendingCloudWipe ? '确认上次清空结果' : '清空云端历史'} onClose={() => { if (!busy) setConfirmWipe(false) }}>
        <div className="dialog-body">
          <p>{pendingCloudWipe ? '将查询并重试同一次清空请求，不会重复删除此后新上传的记录。' : '将移除当前账号的云端历史。本机文字、录音和已确认词典保留；云端副本无法恢复。'}</p>
          <p>各设备得知清空时已有的本机记录不会再自动上传，包括离线期间产生的记录。开启同步时，此后新录音可以继续上传。</p>
          <div className="dialog-actions"><button disabled={busy} onClick={() => setConfirmWipe(false)}>取消</button>
            <button className="danger" disabled={busy} onClick={async () => {
              setBusy(true);setError('')
              try {
                if (!await api.sync.wipeCloud()) throw new Error('清空结果尚未确认。请刷新状态，或稍后确认同一次清空请求。')
                setConfirmWipe(false); await refreshSync(); notify('云端清空已确认，本机历史与录音保留')
              } catch(e) {setError(errorMessage(e));setConfirmWipe(false)} finally {setBusy(false)}
            }}>{busy ? '正在确认…' : pendingCloudWipe ? '确认上次结果' : '确认清空云端'}</button></div>
        </div>
      </Modal>}
      {confirmRetention !== null && <Modal title="缩短云端保留时间" onClose={() => {if(!busy)setConfirmRetention(null)}}>
        <div className="dialog-body"><p>改为 {confirmRetention} 天后，超过保留期的云端副本会被移除，无法从云端恢复。本机历史和录音不受影响，已到期的记录不会重新上传。</p>
          <div className="dialog-actions"><button disabled={busy} onClick={()=>setConfirmRetention(null)}>取消</button>
            <button className="danger" disabled={busy} onClick={async()=>{await syncSave({cloud_retention:confirmRetention});setConfirmRetention(null)}}>确认更改</button></div>
        </div>
      </Modal>}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </>
  )
}
function About() {
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle', channel: 'stable' })
  const [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [pending, setPending] = useState(false)
  const actionPending = useRef(false)
  const busy = !loaded || pending || ['checking', 'downloading'].includes(update.phase)
  const change = async (action: () => Promise<UpdateState | void>) => {
    if (actionPending.current) return
    actionPending.current = true
    setPending(true)
    setError('')
    try {
      const state = await action()
      if (state) setUpdate(state)
    } catch (e) { setError(errorMessage(e)) }
    finally { actionPending.current = false; setPending(false) }
  }
  useEffect(() => {
    let alive = true, received = false
    void api.desktop.snapshot().then(v => { if (alive) setVersion(v.version) }).catch(e => { if (alive) setError(errorMessage(e)) })
    const off = api.desktop.updater.onState(s => {
      received = true
      if (alive) { setUpdate(s); setLoaded(true) }
    })
    void api.desktop.updater.get().then(s => {
      if (alive && !received) { setUpdate(s); setLoaded(true) }
    }).catch(e => { if (alive) setError(errorMessage(e)) })
    return () => { alive = false; off() }
  }, [])
  const status = update.message || ({checking:'正在检查…',current:'已是最新版本',available:`发现新版本 ${update.version ?? ''}`,downloading:`正在下载 ${update.version ?? ''} · ${Math.round(update.percent??0)}%`,ready:'更新已下载',installing:'正在安装更新…',cancelled:'下载已取消',error:'更新失败',unavailable:'此版本不支持自动更新'} as Record<string,string>)[update.phase]
  const open = (url: string) => void api.desktop.openUrl(url).catch(e => setError(errorMessage(e)))
  return (
    <div className="about-list">
      <div className="about-row">
        <div>
          <strong>版本</strong>
          <span aria-live="polite">{version ? `v${version.replace(/^v/, '')}` : ''}{status ? ` · ${status}` : ''}</span>
          {update.phase === 'downloading' && <div className="update-progress" role="progressbar" aria-label="更新下载进度"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.percent ?? 0)}>
            <i style={{ width: `${Math.max(2, Math.min(100, update.percent ?? 0))}%` }} />
            {update.total ? <small>{(((update.transferred ?? 0)) / 1048576).toFixed(1)} / {(update.total / 1048576).toFixed(1)} MB</small> : null}
          </div>}
        </div>
        {update.phase === 'available' ? <button className="primary" disabled={busy} onClick={() => void change(() => api.desktop.updater.download())}>下载更新</button>
          : update.phase === 'downloading' ? <button onClick={() => void api.desktop.updater.cancel().then(setUpdate).catch(e => setError(errorMessage(e)))}>取消下载</button>
          : update.phase === 'ready' ? <button className="primary" disabled={busy} onClick={() => void change(() => api.desktop.updater.install())}>重启并安装</button>
          : update.phase === 'installing' ? <button disabled>正在安装…</button>
          : <button disabled={busy} onClick={() => void change(() => api.desktop.updater.check(update.channel))}>{update.phase === 'checking' ? '正在检查…' : '检查更新'}</button>}
      </div>
      {update.phase === 'ready' && <p className="about-note">安装会关闭应用并重启，请先保存尚未保留的文字。</p>}
      {update.releaseNotes && <details className="about-notes"><summary>版本说明 · {update.version}</summary><Markdown text={update.releaseNotes} /></details>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="about-row">
        <strong>接收测试版</strong>
        <Toggle checked={update.channel === 'beta'} disabled={busy} onChange={value => void change(() => api.desktop.updater.check(value ? 'beta' : 'stable'))} label="接收测试版" />
      </div>
      <button className="about-row about-link" onClick={() => open('https://www.opentype.top/#download')}>
        <strong>版本下载</strong><Icon name="external" size={18} />
      </button>
    </div>
  )
}
function Help() {
  const groups: [string, [string, string][]][] = [
    ['开始使用', [
      ['如何开始听写？', '点进任意输入框，按听写快捷键开始说话，再按一次结束。Esc 取消。'],
      ['需要哪些权限？', api.platform === 'darwin' ? '麦克风、输入监控、辅助功能，在「系统设置 → 隐私与安全性」里打开。'
            : '在 Windows 隐私设置里允许桌面应用使用麦克风。'],
      ['翻译与随便问如何使用？', '按对应快捷键说话即可，需要先配好文字整理。选中文字再按随便问，可以让它改写或解释。'],
    ]],
    ['隐私与离线', [
      ['录音会上传吗？', '云端识别会把录音上传到 SiliconFlow；本地识别时录音不离开电脑。开启文字整理后，识别文字与允许的文字上下文会发送到整理服务。'],
      ['离线可以使用吗？', '在「听写模型」选择本地，点击「下载并启用」，准备完成后关闭文字整理并保存。'],
    ]],
    ['遇到问题', [
      ['失败后怎样找回内容？', '在历史记录里打开那一条，可以重放录音或重新识别。'],
    ]],
  ]
  return (
    <div className="help-content">
      {groups.map(([group, items]) => (
        <section className="help-group" key={group}>
          <h3 className="section-heading">{group}</h3>
          <div className="help-list">
            {items.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
