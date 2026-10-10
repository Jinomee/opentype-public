import { useEffect, useRef, useState } from 'react'
import type { AppleSpeechStatus } from '../main/services/providers/apple-speech'
import type { ModelStatus } from '../main/services/local-asr/model-store'
import { errorMessage } from '../shared/desktop'
import { Icon, Toggle } from './components/ui'

type SpeechProvider = 'siliconflow' | 'local' | 'openai' | 'custom' | 'apple'
type SpeechConfig = { appleSpeechLanguage?: string; provider: SpeechProvider; enableRefine: boolean; hasRefineApiKey: boolean; hasSiliconflowApiKey: boolean }

export function SpeechSettings({ embedded = false, onDone, onBack }: { embedded?: boolean; onDone?: () => void; onBack?: () => void }) {
  const onboarding = !!onDone
  const [appleLanguage, setAppleLanguage] = useState('auto')
  const [savedAppleLanguage, setSavedAppleLanguage] = useState('auto')
  const [appleStatus, setAppleStatus] = useState<AppleSpeechStatus>()
  const [appleRefresh, setAppleRefresh] = useState(0)
  const [provider, setProvider] = useState<SpeechProvider>('siliconflow')
  const [savedProvider, setSavedProvider] = useState<SpeechProvider>('siliconflow')
  const [enabled, setEnabled] = useState(true)
  const [savedEnabled, setSavedEnabled] = useState(true)
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [clearKey, setClearKey] = useState(false)
  const [cloudKey, setCloudKey] = useState('')
  const [hasCloudKey, setHasCloudKey] = useState(false)
  const [clearCloudKey, setClearCloudKey] = useState(false)
  const [status, setStatus] = useState<ModelStatus>()
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [loaded, setLoaded] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const preparingRef = useRef(false), cancelledRef = useRef(false), mountedRef = useRef(true)
  const [conflict, setConflict] = useState(false)
  const conflictRef = useRef(false)
  const dirtyRef = useRef(false)
  const dirty = appleLanguage !== savedAppleLanguage || provider !== savedProvider || enabled !== savedEnabled || !!key.trim() || !!cloudKey.trim() || clearKey || clearCloudKey
  dirtyRef.current = dirty
  const effectiveCloudKey = !!cloudKey.trim() || (hasCloudKey && !clearCloudKey)
  const effectiveRefineKey = !!key.trim() || (hasKey && !clearKey)
  const applySaved = (config: SpeechConfig) => {
    setAppleLanguage(config.appleSpeechLanguage ?? 'auto')
    setSavedAppleLanguage(config.appleSpeechLanguage ?? 'auto')
    setProvider(config.provider)
    setSavedProvider(config.provider)
    setEnabled(config.enableRefine)
    setSavedEnabled(config.enableRefine)
    setHasKey(config.hasRefineApiKey)
    setHasCloudKey(config.hasSiliconflowApiKey)
    setKey('')
    setCloudKey('')
    setClearKey(false)
    setClearCloudKey(false)
    setConflict(false)
    conflictRef.current = false
    setLoaded(true)
  }
  useEffect(() => {
    mountedRef.current = true
    let active = true, received = false
    const off = window.opentype.config.onChanged(config => {
      received = true
      if (!active || savingRef.current) return
      if (dirtyRef.current || preparingRef.current) { conflictRef.current = true; setConflict(true) }
      else applySaved(config)
    })
    void window.opentype.config.get().then((config) => {
      if (active && !received) applySaved(config)
    }).catch(() => {
      if (active) { setFailed(true); setMessage('无法读取设置，请重新打开此窗口。') }
    })
    return () => { active = false; mountedRef.current = false; cancelledRef.current = true; off() }
  }, [])
  const reload = async () => {
    setLoaded(false)
    try { applySaved(await window.opentype.config.get()); setFailed(false); setMessage('已重新载入保存的设置。') }
    catch { setFailed(true); setMessage('无法读取设置，请重新打开此窗口。') }
  }
  useEffect(() => {
    if (!loaded || provider !== 'local') return
    let active = true
    const refresh = () => void window.opentype.localAsr.status()
      .then(value => { if (active) setStatus(value) })
      .catch(() => { if (active) { setFailed(true); setMessage('无法读取模型状态，请重新打开设置。') } })
    refresh()
    const interval = setInterval(refresh, 1000)
    return () => { active = false; clearInterval(interval) }
  }, [loaded, provider])
  useEffect(() => {
    if (!loaded || provider !== 'apple') return
    let active = true
    setAppleStatus(undefined)
    void window.opentype.appleSpeech.status(appleLanguage).then(value => {
      if (!active) return
      setAppleStatus(value)
      // A "model missing" error from before the check finished is stale once it is ready.
      if (value.installed) { setFailed(false); setMessage('') }
    }).catch(() => { if (active) setAppleStatus({ available: false, installed: false, error: 'apple_speech_unavailable' }) })
    return () => { active = false }
  }, [loaded, provider, appleLanguage, appleRefresh])
  const prepareApple = async () => {
    if (!loaded || savingRef.current || preparingRef.current || conflictRef.current) return
    changed(); preparingRef.current = true; cancelledRef.current = false; setPreparing(true)
    try {
      const value = await window.opentype.appleSpeech.install(appleLanguage)
      if (!mountedRef.current) return
      setAppleStatus(value)
      if (value.error && value.error !== 'cancelled') throw new Error(value.error)
      setMessage(value.error === 'cancelled' ? '已取消' : '已就绪，请保存')
    } catch (error) { if (mountedRef.current) { setFailed(true); setMessage(errorMessage(error)) } }
    finally { preparingRef.current = false; if (mountedRef.current) setPreparing(false) }
  }
  const changed = () => { setMessage(''); setFailed(false) }
  const saveError = (error: unknown) => {
    if (String(error).includes('speech_settings_changed')) {
      conflictRef.current = true; setConflict(true)
      return '设置已在其他窗口更改，请重新载入。'
    }
    return errorMessage(error)
  }
  const download = async () => {
    if (!loaded || savingRef.current || preparingRef.current || conflictRef.current) return
    changed()
    preparingRef.current = true; cancelledRef.current = false
    setPreparing(true)
    setStatus(previous => ({ state: 'checking', downloaded: 0, total: previous?.total ?? 239549735 }))
    try {
      const result = await window.opentype.localAsr.install()
      if (!mountedRef.current) return
      setStatus(result)
      if (cancelledRef.current) { setMessage('已取消，识别方式未更改。'); return }
      if (result.state !== 'ready') throw new Error(result.error || '模型尚未准备完成，请重试。')
      if (conflictRef.current) { setMessage('模型已准备好。请重新载入设置后再启用。'); return }
      savingRef.current = true; setSaving(true)
      const saved = await window.opentype.config.set({ provider: 'local' })
      if (!mountedRef.current) return
      // Enabling the model must not discard unrelated text/key drafts.
      setProvider(saved.provider); setSavedProvider(saved.provider)
      const otherChanges = enabled !== savedEnabled || !!key.trim() || !!cloudKey.trim() || clearKey || clearCloudKey
      setMessage(otherChanges ? '本地模型已启用，其他修改仍需保存。' : '本地模型已启用。')
    } catch (error) {
      if (mountedRef.current) { setFailed(true); setMessage(saveError(error)) }
    } finally {
      preparingRef.current = false; savingRef.current = false
      if (mountedRef.current) { setPreparing(false); setSaving(false) }
    }
  }
  const cancelDownload = async () => {
    cancelledRef.current = true
    setMessage('正在取消…')
    try { if (provider === 'apple') await window.opentype.appleSpeech.cancel(); else await window.opentype.localAsr.cancel() }
    catch (error) { setFailed(true); setMessage(errorMessage(error)) }
  }
  /** Waits for the check still in flight instead of reporting "missing" while it runs. */
  const currentAppleStatus = async () => {
    let value = appleStatus
    if (!value) {
      try { value = await window.opentype.appleSpeech.status(appleLanguage) }
      catch { value = { available: false, installed: false, error: 'apple_speech_unavailable' } }
      if (mountedRef.current) setAppleStatus(value)
    }
    if (!value.installed && mountedRef.current) { setFailed(true); setMessage(errorMessage(value.error || 'apple_speech_model_missing')) }
    return value
  }
  const save = async (): Promise<boolean> => {
    if (!loaded || conflict || savingRef.current || preparingRef.current) return false
    if (provider === 'apple' && !(await currentAppleStatus())?.installed) return false
    savingRef.current = true
    setSaving(true)
    changed()
    try {
      const result = await window.opentype.config.set({
        ...(provider !== savedProvider ? { provider } : {}),
        ...(appleLanguage !== savedAppleLanguage ? { appleSpeechLanguage: appleLanguage } : {}),
        ...(enabled !== savedEnabled ? { enableRefine: enabled } : {}),
        ...(cloudKey.trim() ? { siliconflowApiKey: cloudKey.trim() } : clearCloudKey ? { siliconflowApiKey: '' } : {}),
        ...(key.trim() ? { refineApiKey: key.trim() } : clearKey ? { refineApiKey: '' } : {}),
      })
      applySaved(result)
      setMessage('已保存')
      return true
    } catch (error) {
      setFailed(true)
      setMessage(`修改尚未生效：${saveError(error)}`)
    } finally { savingRef.current = false; setSaving(false) }
    return false
  }
  const next = async () => {
    if (!loaded || conflict || savingRef.current || preparingRef.current) return
    if (provider === 'siliconflow' && !effectiveCloudKey) {
      setFailed(true); setMessage('请填写云端 Key，或切换到本地并准备模型。'); return
    }
    if (provider === 'local' && status?.state !== 'ready') {
      setFailed(true); setMessage('请先准备本地模型，再继续。'); return
    }
    if (provider === 'apple' && !(await currentAppleStatus())?.installed) return
    if (!dirty || await save()) onDone?.()
  }
  const busyModel = status?.state === 'downloading' || status?.state === 'installing' || status?.state === 'checking'
  const providers: [SpeechProvider, string, string, string][] = [
    ['siliconflow', 'cloud', '云端', '免下载，需联网'],
    ['local', 'drive', '本地', '240 MB，离线'],
    ['apple', 'apple', 'Apple', '系统自带'],
  ].filter(([value]) => value !== 'apple' || window.opentype.platform === 'darwin' || provider === 'apple') as [SpeechProvider, string, string, string][]
  const refineFields = <>
    <div className="asr-row">
      <span className="asr-row-text">{!onboarding && <strong>文字整理</strong>}<small>去口头禅、理顺标点，翻译和随便问需要它；文字会发给 DeepSeek。</small></span>
      <Toggle label="文字整理" disabled={preparing} checked={enabled} onChange={value => { changed(); setEnabled(value) }} />
    </div>
    {enabled && <label className="asr-field">
      <span className="asr-field-head">DeepSeek API Key
        {hasKey && <span className="asr-field-meta">{clearKey ? '保存后清除' : '已保存'}
          <button type="button" disabled={preparing} className="text-button" onClick={() => { changed(); setKey(''); setClearKey(!clearKey) }}>{clearKey ? '撤销' : '清除'}</button></span>}
      </span>
      <input type="password" disabled={preparing} autoComplete="off" spellCheck={false} value={key} onChange={event => { changed(); setKey(event.target.value); setClearKey(false) }} placeholder={hasKey ? '留空则不变' : effectiveRefineKey ? 'sk-…' : 'sk-…（不填则输出识别原文）'} />
    </label>}
  </>
  return (
    <main className={`asr ${embedded ? 'embedded' : ''} ${onboarding ? 'asr-onb' : ''}`}>
      {!embedded && <h1>听写模型</h1>}
      {conflict && <div className="asr-status error" role="alert">
        <span>设置在别的窗口改过了。</span>
        <button disabled={saving || preparing} onClick={() => void reload()}>放弃修改并重新载入</button>
      </div>}
      {!loaded && failed && !conflict && <button onClick={() => void reload()}>重新读取设置</button>}
      <fieldset disabled={!loaded || saving || conflict}>
        <div role="radiogroup" aria-label="语音识别方式" className="asr-providers">
          {providers.map(([value, icon, title, hint]) => (
            <label key={value} className={`asr-provider ${provider === value ? 'selected' : ''}`}>
              <input type="radio" disabled={preparing} name="speech-provider" value={value} checked={provider === value} onChange={() => { changed(); setProvider(value) }} />
              <Icon name={icon} size={18} />
              <strong>{title}</strong>
              <small>{hint}</small>
            </label>
          ))}
        </div>
        {provider !== 'local' && provider !== 'siliconflow' && provider !== 'apple' && <p className="asr-note">正在使用旧的语音服务，选一种后保存即可切换。</p>}
        {provider === 'siliconflow' && <label className="asr-field">
          <span className="asr-field-head">SiliconFlow API Key
            {hasCloudKey && <span className="asr-field-meta">{clearCloudKey ? '保存后清除' : '已保存'}
              <button type="button" className="text-button" onClick={() => { changed(); setCloudKey(''); setClearCloudKey(!clearCloudKey) }}>{clearCloudKey ? '撤销' : '清除'}</button></span>}
          </span>
          <input type="password" autoComplete="off" spellCheck={false} value={cloudKey} aria-invalid={!effectiveCloudKey}
            onChange={event => { changed(); setCloudKey(event.target.value); setClearCloudKey(false) }} placeholder={hasCloudKey ? '留空则不变' : '填上 Key 才能使用云端识别'} />
        </label>}
        {provider === 'apple' && <>
          <label className="asr-field"><span className="asr-field-head">识别语言
              {!appleStatus?.error && <span className={`asr-field-meta ${appleStatus?.installed ? 'ready' : appleStatus ? 'pending' : ''}`} aria-live="polite">
                {appleStatus?.installed && <Icon name="check" size={13} />}{!appleStatus ? '正在检查…' : appleStatus.installed ? '已就绪' : '未就绪'}
                {appleStatus && !appleStatus.installed
                  ? <button type="button" className="text-button strong" disabled={preparing || !appleStatus.available} onClick={event => { event.preventDefault(); void prepareApple() }}>准备并授权</button>
                  : <button type="button" className="text-button" disabled={preparing} onClick={event => { event.preventDefault(); setAppleRefresh(value => value + 1) }}>刷新</button>}
              </span>}
            </span>
            <select disabled={preparing} value={appleLanguage} onChange={event => { changed(); setAppleLanguage(event.target.value) }}>
              <option value="auto">跟随通用识别语言（自动检测时跟随系统）</option>
              {Array.from(new Set(['zh-CN', 'zh-TW', 'yue-CN', 'en-US', 'ja-JP', 'ko-KR', appleLanguage, ...(appleStatus?.supportedLocales ?? []).map(locale => locale.replaceAll('_', '-'))])).filter(locale => locale !== 'auto').sort().map(locale => <option key={locale} value={locale}>{({ 'zh-CN': '普通话', 'zh-TW': '中文（台湾）', 'yue-CN': '粤语', 'en-US': '英语', 'ja-JP': '日语', 'ko-KR': '韩语' } as Record<string, string>)[locale] ?? locale}</option>)}
            </select>
          </label>
          {appleStatus?.error && <div className="asr-status error" role="alert">
            <span>{errorMessage(appleStatus.error)}</span>
            <span className="asr-status-actions">
              <button className="text-button" disabled={preparing} onClick={() => setAppleRefresh(value => value + 1)}>刷新</button>
              <button disabled={preparing || !appleStatus.available} onClick={() => void prepareApple()}>准备并授权</button>
            </span>
          </div>}
        </>}
        {provider === 'local' && <div className={`asr-status ${status?.state === 'ready' ? 'ready' : status?.error ? 'error' : busyModel ? 'busy' : 'pending'}`} aria-live="polite">
          {status?.state === 'ready' ? <>
              <span><Icon name="check" size={15} />{savedProvider === 'local' ? '本地模型已启用' : '模型已就绪'}</span>
              {savedProvider !== 'local' && !onboarding && <button disabled={preparing} onClick={() => void download()}>启用本地模型</button>}
            </> : status?.state === 'downloading' || status?.state === 'installing' ? <>
              <progress value={status.downloaded} max={status.total} /><span>{Math.floor((status.downloaded / status.total) * 100)}%</span>
              {!preparing && <button onClick={() => void cancelDownload()}>取消</button>}
            </> : <>
              <span>{status?.error ?? (status?.state === 'checking' ? '正在检查…' : '模型还没下载')}</span>
              <button disabled={preparing || !status || status.state === 'checking'} onClick={() => void download()}>{status?.error ? '重试' : '下载并启用'}</button>
            </>}
        </div>}
        {onboarding
          ? <details className="asr-refine"><summary>文字整理（可选）</summary><div className="asr-refine-body">{refineFields}</div></details>
          : <div className="asr-refine">{refineFields}</div>}
      </fieldset>
      {preparing && <div className="asr-status busy" role="status">
        <span>{provider === 'apple' ? '正在准备 Apple 识别…' : saving ? '正在启用本地模型…' : status?.state === 'checking' ? '正在检查本地模型…' : '正在准备本地模型…'}</span>
        <button disabled={saving} onClick={() => void cancelDownload()}>取消</button>
      </div>}
      <div className="asr-actions">
        {onboarding ? <>
          <button className="primary large" disabled={!loaded || saving || preparing || conflict} onClick={() => void next()}>{saving ? '正在保存…' : '继续'} <Icon name="arrow" /></button>
          {onBack && <button className="ghost" disabled={saving || preparing} onClick={onBack}>上一步</button>}
          {failed && <span role="alert" className="asr-message error">{message}</span>}
        </> : <>
          <button className="primary" disabled={!loaded || saving || preparing || conflict || !dirty} onClick={() => void save()}>{saving ? '正在保存…' : '保存'}</button>
          <span role={failed ? 'alert' : 'status'} className={`asr-message ${failed ? 'error' : ''}`}>{message || (dirty ? '有未保存的修改' : '')}</span>
        </>}
      </div>
    </main>
  )
}
