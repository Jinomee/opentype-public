#include "Common.h"
#include <hidusage.h>

namespace {
std::mutex lifecycle, queueMutex;
std::thread hookThread;
std::atomic<DWORD> hookThreadID{0};
std::atomic<bool> requested{false}, active{false};
std::atomic<uint64_t> eventCount{0}, lastEvent{0};
std::deque<std::string> events;
bool overflow = false, held[256] = {}, altGr = false;
HHOOK hook = nullptr;
struct PendingControl { std::string event; DWORD time = 0; ULONGLONG since = 0; } pendingControl;
// Keys a shortcut owns are eaten so they do not also act in the app in front
// (Ctrl+F8 stepping a debugger, Escape clearing a chat box while it cancels a
// dictation). Escape is eaten only while something can be cancelled.
struct Swallow { DWORD key = 0; int mods = 0; };
std::vector<Swallow> swallowed; bool swallowEscape = false, eaten[256] = {};
enum : int { modControl = 1, modOption = 2, modShift = 4, modCommand = 8 };

std::string keyName(DWORD key) {
  if (key>='A' && key<='Z') return std::string(1,static_cast<char>(key));
  if (key>='0' && key<='9') return std::string(1,static_cast<char>(key));
  if (key>=VK_F1 && key<=VK_F24) return "F"+std::to_string(key-VK_F1+1);
  if (key>=VK_NUMPAD0 && key<=VK_NUMPAD9) return "Numpad"+std::to_string(key-VK_NUMPAD0);
  static const std::map<DWORD,std::string> names = {
    {VK_LWIN,"LeftCommand"},{VK_RWIN,"RightCommand"},{VK_LCONTROL,"LeftControl"},{VK_RCONTROL,"RightControl"},
    {VK_LMENU,"LeftOption"},{VK_RMENU,"RightOption"},{VK_LSHIFT,"LeftShift"},{VK_RSHIFT,"RightShift"},
    {VK_SPACE,"Space"},{VK_RETURN,"Enter"},{VK_ESCAPE,"Escape"},{VK_TAB,"Tab"},{VK_BACK,"Backspace"},
    {VK_DELETE,"Delete"},{VK_INSERT,"Insert"},{VK_HOME,"Home"},{VK_END,"End"},{VK_PRIOR,"PageUp"},{VK_NEXT,"PageDown"},
    {VK_LEFT,"ArrowLeft"},{VK_RIGHT,"ArrowRight"},{VK_UP,"ArrowUp"},{VK_DOWN,"ArrowDown"},
    {VK_ADD,"NumpadAdd"},{VK_SUBTRACT,"NumpadSubtract"},{VK_MULTIPLY,"NumpadMultiply"},{VK_DIVIDE,"NumpadDivide"},
    {VK_DECIMAL,"NumpadDecimal"},{VK_OEM_MINUS,"-"},{VK_OEM_PLUS,"="},{VK_OEM_COMMA,","},{VK_OEM_PERIOD,"."},
    {VK_OEM_1,";"},{VK_OEM_2,"/"},{VK_OEM_3,"`"},{VK_OEM_4,"["},{VK_OEM_5,"\\"},{VK_OEM_6,"]"},{VK_OEM_7,"'"},
    {VK_CAPITAL,"CapsLock"},{VK_SNAPSHOT,"PrintScreen"},{VK_PAUSE,"Pause"},{VK_APPS,"ContextMenu"}};
  auto entry = names.find(key); return entry == names.end() ? "Unknown" : entry->second;
}
void append(const std::string& event) {
  if (events.size() >= 512) { events.clear(); overflow = true; }
  events.push_back(event);
}
LRESULT CALLBACK keyHook(int code, WPARAM action, LPARAM data) {
  if (code != HC_ACTION) return CallNextHookEx(hook,code,action,data);
  const auto& raw = *reinterpret_cast<KBDLLHOOKSTRUCT*>(data);
  if (raw.dwExtraInfo == ot::inputMarker || raw.vkCode == VK_PACKET) return CallNextHookEx(hook,code,action,data);
  DWORD key = raw.vkCode;
  if (key==VK_CONTROL) key=(raw.flags&LLKHF_EXTENDED)?VK_RCONTROL:VK_LCONTROL;
  if (key==VK_MENU) key=(raw.flags&LLKHF_EXTENDED)?VK_RMENU:VK_LMENU;
  if (key==VK_SHIFT) key=MapVirtualKeyW(raw.scanCode,MAPVK_VSC_TO_VK_EX);
  if (key >= 256) return CallNextHookEx(hook,code,action,data);
  bool down = action==WM_KEYDOWN || action==WM_SYSKEYDOWN, consume = false;
  try {
  std::lock_guard<std::mutex> guard(queueMutex);
  bool repeat = down && held[key]; held[key] = down;
  // Windows emits a synthetic left Ctrl immediately before AltGr. Defer this
  // one event briefly so right Alt remains usable without swallowing real Ctrl.
  if (!pendingControl.event.empty()) {
    if (key==VK_RMENU && down && raw.time==pendingControl.time) altGr=true;
    else append(pendingControl.event);
    pendingControl = {};
  }
  bool control = (held[VK_LCONTROL]&&!altGr)||held[VK_RCONTROL];
  std::vector<std::string> mods;
  if ((held[VK_LWIN]||held[VK_RWIN]) && key!=VK_LWIN && key!=VK_RWIN) mods.push_back("Command");
  if (control && key!=VK_LCONTROL && key!=VK_RCONTROL) mods.push_back("Control");
  if ((held[VK_LMENU]||held[VK_RMENU]) && key!=VK_LMENU && key!=VK_RMENU) mods.push_back("Option");
  if ((held[VK_LSHIFT]||held[VK_RSHIFT]) && key!=VK_LSHIFT && key!=VK_RSHIFT) mods.push_back("Shift");
  int mask=0;
  for(const auto& mod:mods)mask|=mod=="Control"?modControl:mod=="Option"?modOption:mod=="Shift"?modShift:modCommand;
  if(down&&!repeat){
    bool own=key==VK_ESCAPE&&swallowEscape&&mask==0;
    for(const auto& entry:swallowed)if(entry.key==key&&entry.mods==mask)own=true;
    eaten[key]=own;
  }
  consume=eaten[key];
  if(!down)eaten[key]=false;
  std::string flags="["; for(const auto& mod:mods) { if(flags.size()>1)flags+=',';flags+=ot::quote(mod); } flags+=']';
  std::string event = ot::object({{"type",ot::quote(std::string(down?"keyDown":"keyUp"))},{"key",ot::quote(keyName(key))},
    {"keyCode",std::to_string(key)},{"modifiers",flags},{"isRepeat",repeat?"true":"false"},{"timestamp",std::to_string(ot::epochMilliseconds())}});
  if (key==VK_LCONTROL && down && !repeat) pendingControl={event,raw.time,GetTickCount64()};
  else if (!(key==VK_LCONTROL && !down && altGr)) append(event);
  if (key==VK_LCONTROL && !down) altGr=false;
  eventCount++; lastEvent=ot::epochMilliseconds();
  } catch (...) {
    std::lock_guard<std::mutex> guard(queueMutex);overflow=true;
  }
  if (consume) return 1;
  return CallNextHookEx(hook,code,action,data);
}
void stop() {
  requested=false;
  DWORD id=hookThreadID.load(); if(id)PostThreadMessageW(id,WM_QUIT,0,0);
  if(hookThread.joinable())hookThread.join();
  active=false;hookThreadID=0;
  std::lock_guard<std::mutex> guard(queueMutex);events.clear();pendingControl={};overflow=false;altGr=false;
  std::fill(std::begin(held),std::end(held),false);std::fill(std::begin(eaten),std::end(eaten),false);
}
}

// Windows uses polling across the FFI boundary. The hook never calls JS while
// Windows waits for it, and stop can join without deadlocking Electron's loop.
OT_EXPORT int startKeyboardMonitor(void*) {
  std::lock_guard<std::mutex> guard(lifecycle);
  if(active)return 0;
  stop();requested=true;
  auto ready=std::make_shared<std::promise<int>>();auto result=ready->get_future();
  hookThread=std::thread([ready] {
    MSG msg;PeekMessageW(&msg,nullptr,0,0,PM_NOREMOVE);hookThreadID=GetCurrentThreadId();
    HMODULE module=nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,reinterpret_cast<LPCWSTR>(&keyHook),&module);
    hook=SetWindowsHookExW(WH_KEYBOARD_LL,keyHook,module,0);active=hook!=nullptr;ready->set_value(active?0:-1);
    if(hook){while(GetMessageW(&msg,nullptr,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}UnhookWindowsHookEx(hook);hook=nullptr;}
    active=false;
  });
  return result.get();
}
// spec: "F8:1\nSpace:5" (key name as reported, modifier mask as above).
OT_EXPORT void setKeyboardSwallow(const char* spec,bool escape){
  std::vector<Swallow> list;std::string text=spec?spec:"";size_t start=0;
  while(start<text.size()){
    size_t end=text.find('\n',start);auto item=text.substr(start,end==std::string::npos?std::string::npos:end-start);
    size_t colon=item.rfind(':');
    if(colon!=std::string::npos&&colon>0){
      auto name=item.substr(0,colon);int mods=std::atoi(item.c_str()+colon+1);
      for(DWORD key=0;key<256;key++)if(keyName(key)==name){
        bool modifier=key==VK_LWIN||key==VK_RWIN||(key>=VK_LSHIFT&&key<=VK_RMENU)||key==VK_SHIFT||key==VK_CONTROL||key==VK_MENU;
        if(!modifier)list.push_back({key,mods});break;
      }
    }
    if(end==std::string::npos)break;start=end+1;
  }
  std::lock_guard<std::mutex> guard(queueMutex);swallowed=std::move(list);swallowEscape=escape;
}
OT_EXPORT void stopKeyboardMonitor(){std::lock_guard<std::mutex> guard(lifecycle);stop();}
OT_EXPORT char* drainKeyboardEvents(){
  std::lock_guard<std::mutex> guard(queueMutex);
  if(!pendingControl.event.empty() && GetTickCount64()-pendingControl.since>=4){append(pendingControl.event);pendingControl={};}
  std::string list="[";for(const auto& event:events){if(list.size()>1)list+=',';list+=event;}list+=']';events.clear();
  auto out=ot::object({{"events",list},{"reset",overflow?"true":"false"}});overflow=false;return ot::result(out);
}
OT_EXPORT char* getKeyboardMonitorStatus(){return ot::result(ot::object({
  {"platform","\"win32\""},{"inputMonitoring",ot::inputDesktopAvailable()?"true":"false"},
  {"requested",requested?"true":"false"},{"active",active?"true":"false"},{"callbackRegistered",requested?"true":"false"},
  {"eventCount",std::to_string(eventCount.load())},{"lastEventAt",std::to_string(lastEvent.load())},{"recoveryCount","0"}}));}
OT_EXPORT char* transformKeyNamesToKeyCodes(const char* names){
  std::string text=names?names:"",out="[";size_t start=0;
  while(start<text.size()){size_t end=text.find(',',start);auto wanted=text.substr(start,end-start);
    for(DWORD key=0;key<256;key++)if(keyName(key)==wanted){if(out.size()>1)out+=',';out+=std::to_string(key);break;}
    if(end==std::string::npos)break;start=end+1;
  }return ot::result(out+']');
}
OT_EXPORT char* getKeyboardDeviceList(){
  UINT count=0;if(GetRawInputDeviceList(nullptr,&count,sizeof(RAWINPUTDEVICELIST))!=0)return ot::result("[]");
  std::vector<RAWINPUTDEVICELIST> devices(count);
  if(GetRawInputDeviceList(devices.data(),&count,sizeof(RAWINPUTDEVICELIST))==static_cast<UINT>(-1))return ot::result("[]");
  std::string out="[";
  for(const auto& device:devices)if(device.dwType==RIM_TYPEKEYBOARD){
    UINT size=0;GetRawInputDeviceInfoW(device.hDevice,RIDI_DEVICENAME,nullptr,&size);
    std::wstring name(size,L'\0');if(!size||GetRawInputDeviceInfoW(device.hDevice,RIDI_DEVICENAME,name.data(),&size)==static_cast<UINT>(-1))continue;
    name.resize(wcsnlen(name.c_str(),name.size()));if(out.size()>1)out+=',';
    out+=ot::object({{"name",ot::quote(name)},{"vendorId","\"\""},{"productId","\"\""}});
  }return ot::result(out+']');
}
