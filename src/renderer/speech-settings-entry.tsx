import { createRoot } from 'react-dom/client'
import { SpeechSettings } from './speech-settings'
import { TitleBar } from './components/title-bar'
import { useSyncedTheme } from './theme'
import './app.css'
function SpeechSettingsWindow() {
  useSyncedTheme()
  return <><TitleBar /><SpeechSettings /></>
}
createRoot(document.getElementById('root')!).render(<SpeechSettingsWindow />)
