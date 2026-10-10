#include "Common.h"
#include "ClipboardLease.h"
#include <shlobj.h>
#include <cstdio>

namespace {
constexpr int documentLimit = 1000000;
std::wstring bstr(BSTR value) { return value ? std::wstring(value,SysStringLen(value)) : L""; }
std::wstring rangeText(IUIAutomationTextRange* range,int maximum=documentLimit+1) {
  BSTR raw=nullptr;if(!range||FAILED(range->GetText(maximum,&raw)))throw std::runtime_error("injection_target_unavailable");
  auto value=bstr(raw);SysFreeString(raw);return value;
}
std::wstring normalizedLines(const std::wstring& value){
  std::wstring out;out.reserve(value.size());
  for(size_t i=0;i<value.size();i++){
    if(value[i]==L'\r'){out+=L'\n';if(i+1<value.size()&&value[i+1]==L'\n')i++;}
    else out+=value[i];
  }return out;
}
bool browser(DWORD pid) {
  auto name=ot::processName(pid);std::transform(name.begin(),name.end(),name.begin(),towlower);
  return name==L"chrome.exe"||name==L"msedge.exe"||name==L"firefox.exe"||name==L"brave.exe"||name==L"opera.exe"||name==L"vivaldi.exe";
}
bool protectedField(IUIAutomationElement* element) {
  if(!element)return true;
  ComPtr<IUIAutomationTreeWalker> walker;auto* api=ot::automation();if(!api||FAILED(api->get_ControlViewWalker(&walker)))return true;
  ComPtr<IUIAutomationElement> current=element;
  for(int depth=0;current&&depth<64;depth++){
    BOOL password=TRUE;
    if(FAILED(current->get_CurrentIsPassword(&password))||password)return true;
    CONTROLTYPEID type=0;if(FAILED(current->get_CurrentControlType(&type)))return true;
    if(type==UIA_WindowControlTypeId||type==UIA_DocumentControlTypeId)return false;
    ComPtr<IUIAutomationElement> parent;if(FAILED(walker->GetParentElement(current.Get(),&parent)))return true;current=parent;
  }return true;
}
std::vector<std::wstring> webURLs(IUIAutomationElement* element,bool* needsRedaction=nullptr) {
  std::vector<std::wstring> urls;auto* api=ot::automation();ComPtr<IUIAutomationTreeWalker> walker;
  if(needsRedaction)*needsRedaction=true;
  if(!api||FAILED(api->get_ControlViewWalker(&walker)))return urls;
  bool webFramework=false,incomplete=false;
  ComPtr<IUIAutomationElement> current=element;
  for(int depth=0;current&&depth<64;depth++){
    CONTROLTYPEID type=0;current->get_CurrentControlType(&type);
    BSTR framework=nullptr;
    if(SUCCEEDED(current->get_CurrentFrameworkId(&framework))){auto name=bstr(framework);if(name==L"Chrome"||name==L"Gecko"||name==L"Firefox")webFramework=true;}
    SysFreeString(framework);
    if(type==UIA_DocumentControlTypeId){
      bool known=false;
      VARIANT value;VariantInit(&value);
      if(SUCCEEDED(current->GetCurrentPropertyValue(UIA_LegacyIAccessibleValuePropertyId,&value))&&value.vt==VT_BSTR){
        auto url=bstr(value.bstrVal);if(url.rfind(L"https://",0)==0||url.rfind(L"http://",0)==0||url.rfind(L"file://",0)==0){urls.push_back(url);known=true;}
      }VariantClear(&value);
      if(!known)incomplete=true;
    }
    ComPtr<IUIAutomationElement> parent;if(FAILED(walker->GetParentElement(current.Get(),&parent)))break;current=parent;
  }
  if(current)incomplete=true;
  int pid=0;element->get_CurrentProcessId(&pid);
  if(needsRedaction)*needsRedaction=(webFramework||browser(static_cast<DWORD>(pid)))&&(incomplete||urls.empty());
  return urls;
}
struct Snapshot {
  std::wstring value;
  int start=0,end=0;
  bool writable=false;
  ComPtr<IUIAutomationTextRange> selection;
};
Snapshot read(IUIAutomationElement* element) {
  if(protectedField(element))throw std::runtime_error("injection_target_unavailable");
  Snapshot out;ComPtr<IUIAutomationTextPattern> text;
  if(FAILED(element->GetCurrentPatternAs(UIA_TextPatternId,IID_PPV_ARGS(&text))))throw std::runtime_error("injection_target_unavailable");
  ComPtr<IUIAutomationTextRange> document;ComPtr<IUIAutomationTextRangeArray> ranges;
  int count=0;
  if(FAILED(text->get_DocumentRange(&document))||FAILED(text->GetSelection(&ranges))||!ranges||FAILED(ranges->get_Length(&count))||count!=1
    ||FAILED(ranges->GetElement(0,&out.selection)))throw std::runtime_error("injection_selection_changed");
  out.value=rangeText(document.Get());if(out.value.size()>documentLimit)throw std::runtime_error("injection_target_unavailable");
  ComPtr<IUIAutomationTextRange> prefix;
  if(FAILED(document->Clone(&prefix))||FAILED(prefix->MoveEndpointByRange(TextPatternRangeEndpoint_End,out.selection.Get(),TextPatternRangeEndpoint_Start)))throw std::runtime_error("injection_selection_changed");
  out.start=static_cast<int>(rangeText(prefix.Get()).size());
  if(FAILED(prefix->MoveEndpointByRange(TextPatternRangeEndpoint_End,out.selection.Get(),TextPatternRangeEndpoint_End)))throw std::runtime_error("injection_selection_changed");
  out.end=static_cast<int>(rangeText(prefix.Get()).size());
  if(out.start<0||out.end<out.start||out.end>static_cast<int>(out.value.size()))throw std::runtime_error("injection_selection_changed");
  // TextPattern can represent both editable fields and a reader's selection.
  VARIANT readonly;VariantInit(&readonly);
  if(SUCCEEDED(document->GetAttributeValue(UIA_IsReadOnlyAttributeId,&readonly))&&readonly.vt==VT_BOOL)out.writable=readonly.boolVal==VARIANT_FALSE;
  VariantClear(&readonly);
  ComPtr<IUIAutomationValuePattern> value;
  if(SUCCEEDED(element->GetCurrentPatternAs(UIA_ValuePatternId,IID_PPV_ARGS(&value)))){BOOL flag=TRUE;if(SUCCEEDED(value->get_CurrentIsReadOnly(&flag)))out.writable=!flag;}
  BOOL enabled=FALSE;if(FAILED(element->get_CurrentIsEnabled(&enabled))||!enabled)out.writable=false;
  return out;
}
struct Target {
  HWND window=nullptr;DWORD pid=0;
  ComPtr<IUIAutomationElement> element;
  Snapshot original;
  std::wstring expected,inserted;
  std::vector<std::wstring> urls;
  bool submitted=false,verified=false;
  ULONGLONG observation=0;
  // field: the focused control exposed a writable UI Automation text pattern,
  // so delivery is checked against its exact text and selection. Without it
  // (most Electron apps, terminals, games, Java/Qt apps) the target is the
  // foreground app itself, as in VocaWin: type into it while it stays in front.
  bool field=false;
};
std::map<std::string,std::shared_ptr<Target>> targets;
HWND rootWindow(HWND window){HWND root=window?GetAncestor(window,GA_ROOT):nullptr;return root?root:window;}
bool focused(const Target& target) {
  DWORD pid=0;GetWindowThreadProcessId(target.window,&pid);
  if(!IsWindow(target.window)||pid!=target.pid||rootWindow(GetForegroundWindow())!=target.window||!ot::inputDesktopAvailable())return false;
  if(!target.field)return true;
  ComPtr<IUIAutomationElement> current;BOOL same=FALSE;auto* api=ot::automation();
  return api&&SUCCEEDED(api->GetFocusedElement(&current))&&current&&SUCCEEDED(api->CompareElements(current.Get(),target.element.Get(),&same))&&same
    && webURLs(target.element.Get())==target.urls;
}
std::shared_ptr<Target> targetFor(const std::string& token) {
  auto found=targets.find(token);if(found==targets.end())throw std::runtime_error("injection_target_closed");return found->second;
}
Snapshot unchanged(const Target& target,bool checkSelection) {
  DWORD pid=0;GetWindowThreadProcessId(target.window,&pid);
  if(!IsWindow(target.window)||pid!=target.pid)throw std::runtime_error("injection_target_closed");
  if(!ot::sameIntegrity(target.pid))throw std::runtime_error("injection_elevated_target");
  if(!target.field)return target.original;
  Snapshot now=read(target.element.Get());
  if(!now.writable||now.value!=target.original.value)throw std::runtime_error("injection_target_changed");
  if(checkSelection&&(now.start!=target.original.start||now.end!=target.original.end))throw std::runtime_error("injection_selection_changed");
  return now;
}
bool passwordField(IUIAutomationElement* element){BOOL password=FALSE;return element&&SUCCEEDED(element->get_CurrentIsPassword(&password))&&password;}
std::string capture(bool allowReadOnly,bool keepTarget=true) {
  HWND window=rootWindow(GetForegroundWindow());std::string base="{"+ot::appFields(window);
  if(!window||!ot::inputDesktopAvailable())return base+",\"contextRedacted\":true,\"reason\":\"injection_target_unavailable\"}";
  DWORD pid=0;GetWindowThreadProcessId(window,&pid);
  auto* api=ot::automation();ComPtr<IUIAutomationElement> element;
  if(api&&(FAILED(api->GetFocusedElement(&element))||!element))element.Reset();
  if(element){int elementPID=0;element->get_CurrentProcessId(&elementPID);if(static_cast<DWORD>(elementPID)!=pid)element.Reset();}
  // Never type into a password box, even blind.
  if(passwordField(element.Get()))return base+",\"contextRedacted\":true,\"reason\":\"injection_target_unavailable\"}";
  // Context is optional: a control without a readable text pattern still
  // gets the text, it only goes without surrounding context.
  Snapshot value;bool readable=false;
  if(element&&!protectedField(element.Get())){try{value=read(element.Get());readable=true;}catch(...){readable=false;}}
  bool redacted=!readable;std::vector<std::wstring> urls;
  if(readable){bool hidden=false;urls=webURLs(element.Get(),&hidden);redacted=hidden||(browser(pid)&&urls.empty());}
  std::string urlList="[";
  for(const auto& url:urls){if(urlList.size()>1)urlList+=',';urlList+=ot::quote(url);}urlList+=']';
  base+=",\"contextRedacted\":"+std::string(redacted?"true":"false")+",\"webUrls\":"+urlList;
  if(!urls.empty())base+=",\"webUrl\":"+ot::quote(urls.front());
  if(readable&&!redacted&&(value.writable||allowReadOnly)){
    base+=",\"selectedText\":"+ot::quote(value.value.substr(value.start,value.end-value.start));
    int start=std::max(0,value.start-800),end=std::min(static_cast<int>(value.value.size()),value.end+400);
    base+=",\"contextText\":"+ot::quote(value.value.substr(start,std::min(2000,end-start)));
  }
  RECT bounds;if(GetWindowRect(window,&bounds))base+=",\"windowBounds\":"+ot::object({{"x",std::to_string(bounds.left)},{"y",std::to_string(bounds.top)},
    {"width",std::to_string(bounds.right-bounds.left)},{"height",std::to_string(bounds.bottom-bounds.top)}});
  // UIPI silently drops typed and pasted input into an elevated app.
  if(!ot::sameIntegrity(pid))return base+",\"selectionReadOnly\":false,\"reason\":\"injection_elevated_target\"}";
  // A reader's selection (a web page, a PDF) is context for a command, not a
  // place to type: keep the old answer-card behaviour there.
  if(readable&&!value.writable)return base+",\"selectionReadOnly\":true,\"reason\":\"injection_target_unavailable\"}";
  if(pid==GetCurrentProcessId()&&!readable)return base+",\"reason\":\"injection_target_unavailable\"}";
  if(keepTarget&&targets.size()<16){
    auto target=std::make_shared<Target>();target->window=window;target->pid=pid;target->field=readable;
    if(readable){target->element=element;target->original=value;target->urls=urls;}
    auto token=ot::guid();targets[token]=target;base+=",\"token\":"+ot::quote(token);
  }
  return base+'}';
}

// The child owns the backup and clipboard publication. Closing the parent or
// its handle requests restoration without relying on a timer in Electron.
std::unique_ptr<otclip::Lease> clipboardLease;
void restoreClipboard(){
  if(!clipboardLease)return;
  clipboardLease->restore();
  if(clipboardLease->waitForExit(0))clipboardLease.reset();
}
bool modifiersHeld(){for(int key:{VK_CONTROL,VK_MENU,VK_SHIFT,VK_LWIN,VK_RWIN})if(GetAsyncKeyState(key)&0x8000)return true;return false;}
// Classic Notepad and WordPad take UNICODE key events (the caret moves) but
// drop the glyphs, so they always get the clipboard paste.
bool pasteOnly(DWORD pid){auto name=ot::processName(pid);std::transform(name.begin(),name.end(),name.begin(),towlower);return name==L"notepad.exe"||name==L"wordpad.exe";}
// Typing leaves the clipboard alone. Line breaks would be typed as Enter,
// which sends a message in most chat apps, so multi-line text is pasted.
constexpr size_t typingLimit=600;
bool typeable(const Target& target,const std::wstring& text){
  return !text.empty()&&text.size()<=typingLimit&&text.find_first_of(L"\r\n\t")==std::wstring::npos&&!pasteOnly(target.pid);
}
struct Typed{bool complete=false,any=false;};
// UNICODE SendInput in small batches: one large burst makes Electron apps,
// terminals and remote sessions drop or reorder characters. A surrogate pair
// stays within one batch.
Typed typeText(const Target& target,const std::wstring& text){
  Typed out;constexpr size_t batch=24;size_t i=0;
  while(i<text.size()){
    // Keep the original foreground window for every batch. The user can
    // switch apps while a longer transcript is being typed.
    if(!focused(target)||modifiersHeld())return out;
    std::vector<INPUT> keys;size_t chars=0;
    while(i<text.size()&&chars<batch){
      size_t units=(IS_HIGH_SURROGATE(text[i])&&i+1<text.size()&&IS_LOW_SURROGATE(text[i+1]))?2:1;
      for(size_t u=0;u<units;u++)for(int up=0;up<2;up++){INPUT key={};key.type=INPUT_KEYBOARD;key.ki.wScan=text[i+u];
        key.ki.dwFlags=KEYEVENTF_UNICODE|(up?KEYEVENTF_KEYUP:0);key.ki.dwExtraInfo=ot::inputMarker;keys.push_back(key);}
      i+=units;chars++;
    }
    UINT sent=SendInput(static_cast<UINT>(keys.size()),keys.data(),sizeof(INPUT));
    if(sent==0&&!out.any){
      Sleep(20);
      if(!focused(target)||modifiersHeld())return out;
      sent=SendInput(static_cast<UINT>(keys.size()),keys.data(),sizeof(INPUT));
    }
    if(sent>0)out.any=true;
    if(sent!=keys.size())return out;
    if(i<text.size())Sleep(4);
  }
  out.complete=true;return out;
}
std::string commit(Target& target,const std::wstring& text,const std::string& html={}) {
  if(target.submitted)throw std::runtime_error("injection_already_sent");
  if(!focused(target))throw std::runtime_error("injection_focus_pending");
  unchanged(target,true);
  if(text.empty()&&(!target.field||target.original.start==target.original.end))return std::string("{\"submitted\":false,\"reason\":\"injection_empty_text\"}");
  if(modifiersHeld())throw std::runtime_error("injection_keys_held");
  if(!target.field&&typeable(target,text)){
    target.submitted=true;target.inserted=text;
    auto typed=typeText(target,text);
    if(typed.complete)return std::string("{\"submitted\":true,\"uncertain\":false,\"method\":\"windows_typing\"}");
    // Part of the text already reached the app: pasting it all again would
    // duplicate it, so report the uncertainty instead.
    if(typed.any)return std::string("{\"submitted\":true,\"uncertain\":true,\"method\":\"windows_typing\"}");
    target.submitted=false;
  }
  if(clipboardLease){
    clipboardLease->restore();
    if(!clipboardLease->waitForExit(4000))throw std::runtime_error("injection_clipboard_unavailable");
    clipboardLease.reset();
  }
  DWORD clipboardSequence=0;
  try{
    // Allocate the expected document before authorizing any clipboard change.
    target.expected=target.original.value.substr(0,target.original.start)+text+target.original.value.substr(target.original.end);
    target.inserted=text;
    if(!text.empty())clipboardLease=std::make_unique<otclip::Lease>(text,html);
    // Archiving may ask another process for its OLE data. Recheck the original
    // target after it returns, before authorizing clipboard publication.
    if(!focused(target))throw std::runtime_error("injection_focus_pending");
    unchanged(target,true);
    if(clipboardLease)clipboardSequence=clipboardLease->apply();
    if(!focused(target))throw std::runtime_error("injection_focus_pending");
    unchanged(target,true);
    if(clipboardLease&&(!clipboardLease->active()||GetClipboardSequenceNumber()!=clipboardSequence))throw std::runtime_error("injection_clipboard_changed");
    if(modifiersHeld())throw std::runtime_error("injection_keys_held");
  }catch(...){restoreClipboard();throw;}
  target.submitted=true;
  INPUT keys[4]={};UINT count=text.empty()?2:4;
  WORD codes[4]={VK_CONTROL,'V','V',VK_CONTROL};
  if(text.empty()){codes[0]=VK_BACK;codes[1]=VK_BACK;}
  for(UINT i=0;i<count;i++){keys[i].type=INPUT_KEYBOARD;keys[i].ki.wVk=codes[i];keys[i].ki.dwExtraInfo=ot::inputMarker;
    keys[i].ki.dwFlags=(text.empty()?i==1:i>=2)?KEYEVENTF_KEYUP:0;}
  UINT sent=SendInput(count,keys,sizeof(INPUT));
  if(sent<count){
    // Release only the keys this operation may have pressed. Never retry paste.
    INPUT release[2]={};release[0].type=release[1].type=INPUT_KEYBOARD;
    release[0].ki.wVk=text.empty()?VK_BACK:'V';release[1].ki.wVk=VK_CONTROL;
    for(auto& key:release){key.ki.dwFlags=KEYEVENTF_KEYUP;key.ki.dwExtraInfo=ot::inputMarker;}SendInput(text.empty()?1:2,release,sizeof(INPUT));
  }
  if(clipboardLease)clipboardLease->posted();
  return ot::object({{"submitted","true"},{"uncertain",sent==count?"false":"true"},{"method","\"windows_clipboard\""}});
}
// A combo shortcut may still be held when the text is ready; typed or pasted
// keys would then arrive as shortcuts. Wait briefly off the UI thread.
void waitForModifiers(){for(int waited=0;waited<600&&modifiersHeld();waited+=15)Sleep(15);if(!modifiersHeld())Sleep(30);}
template<class F> char* respond(F action){try{return ot::result(ot::system(std::move(action)));}catch(const std::exception& error){return ot::result(ot::failure(error.what()));}catch(...){return ot::result(ot::failure("injection_bridge_error"));}}
}

OT_EXPORT char* captureInputTarget(){return respond([]{return capture(false);});}
OT_EXPORT char* captureCommandTarget(){return respond([]{return capture(true);});}
OT_EXPORT char* getCurrentInputState(){return ot::result(ot::appInfo(GetForegroundWindow()));}
OT_EXPORT char* getFocusedAppInfo(){return getCurrentInputState();}
OT_EXPORT bool isBrowserApp(const char* name){try{auto value=ot::wide(name);std::transform(value.begin(),value.end(),value.begin(),towlower);return value==L"chrome.exe"||value==L"msedge.exe"||value==L"firefox.exe"||value==L"brave.exe"||value==L"opera.exe"||value==L"vivaldi.exe";}catch(...){return false;}}
OT_EXPORT char* getFocusedInputInfo(){return respond([]{auto json=capture(true,false);json.insert(1,json.find("\"reason\":")==std::string::npos?"\"success\":true,":"\"success\":false,");return json;});}
OT_EXPORT char* prepareInputTarget(const char* token){std::string id=token?token:"";return respond([id]{auto target=targetFor(id);unchanged(*target,false);
  if(IsIconic(target->window))ShowWindowAsync(target->window,SW_RESTORE);
  if(rootWindow(GetForegroundWindow())!=target->window&&!SetForegroundWindow(target->window))throw std::runtime_error("injection_focus_pending");
  if(target->field&&(FAILED(target->element->SetFocus())||FAILED(target->original.selection->Select())))throw std::runtime_error("injection_focus_pending");
  return std::string("{\"ok\":true}");});}
OT_EXPORT char* inputTargetReady(const char* token){std::string id=token?token:"";return respond([id]{auto target=targetFor(id);if(!focused(*target))throw std::runtime_error("injection_focus_pending");unchanged(*target,true);return std::string("{\"ok\":true}");});}
OT_EXPORT char* commitInputTarget(const char* token,const char* text){try{std::string id=token?token:"";auto value=ot::wide(text);waitForModifiers();return respond([id,value]{return commit(*targetFor(id),value);});}catch(...){return ot::result(ot::failure("invalid_utf8"));}}
OT_EXPORT char* verifyInputTarget(const char* token){std::string id=token?token:"";return respond([id]{auto target=targetFor(id);if(!target->submitted)throw std::runtime_error("injection_failed");
  // Typed or pasted into an app without a readable field: nothing to check.
  if(!target->field)return std::string("{\"status\":\"unverified\",\"blind\":true}");
  if(!focused(*target))return std::string("{\"status\":\"unverified\"}");auto value=read(target->element.Get());
  if(normalizedLines(value.value)==normalizedLines(target->expected)){target->verified=true;return std::string("{\"status\":\"verified\"}");}
  return std::string("{\"status\":\"pending\"}");});}
OT_EXPORT void releaseInputTarget(const char* token){std::string id=token?token:"";try{ot::system([id]{targets.erase(id);});}catch(...) {}}
OT_EXPORT char* beginInputObservation(const char* token,const char* text){try{std::string id=token?token:"";auto inserted=ot::wide(text);return respond([id,inserted]{auto target=targetFor(id);
  if(!target->field||!target->verified||target->inserted!=inserted||!focused(*target)||normalizedLines(read(target->element.Get()).value)!=normalizedLines(target->expected))return std::string("{\"ok\":false}");
  target->observation=GetTickCount64();return std::string("{\"ok\":true}");});}catch(...){return ot::result("{\"ok\":false}");}}
OT_EXPORT char* readInputObservation(const char* token){std::string id=token?token:"";return respond([id]{auto target=targetFor(id);
  if(!target->field)return std::string("{\"active\":false,\"reason\":\"field_invalid\"}");
  if(!target->observation||GetTickCount64()-target->observation>=60000)return std::string("{\"active\":false,\"reason\":\"expired\"}");
  if(!IsWindow(target->window))return std::string("{\"active\":false,\"reason\":\"target_invalid\"}");
  DWORD pid=0;GetWindowThreadProcessId(target->window,&pid);if(pid!=target->pid)return std::string("{\"active\":false,\"reason\":\"target_invalid\"}");
  if(!ot::inputDesktopAvailable())return std::string("{\"active\":false,\"reason\":\"unavailable\"}");
  if(GetForegroundWindow()!=target->window)return std::string("{\"active\":false,\"reason\":\"app_inactive\"}");
  if(webURLs(target->element.Get())!=target->urls)return std::string("{\"active\":false,\"reason\":\"document_changed\"}");
  if(!focused(*target))return std::string("{\"active\":false,\"reason\":\"field_unfocused\"}");
  auto current=read(target->element.Get());auto prefix=target->original.value.substr(0,target->original.start),suffix=target->original.value.substr(target->original.end);
  if(current.value.size()<prefix.size()+suffix.size()||current.value.compare(0,prefix.size(),prefix)!=0||current.value.compare(current.value.size()-suffix.size(),suffix.size(),suffix)!=0)return std::string("{\"active\":false}");
  size_t length=current.value.size()-prefix.size()-suffix.size();
  if(length>100000||current.start<static_cast<int>(prefix.size())||current.end>static_cast<int>(prefix.size()+length))return std::string("{\"active\":false}");
  return ot::object({{"active","true"},{"text",ot::quote(current.value.substr(prefix.size(),length))}});});}
OT_EXPORT char* getSelectedText(){try{return ot::result(ot::system([]{ComPtr<IUIAutomationElement> field;auto* api=ot::automation();
  if(!api||FAILED(api->GetFocusedElement(&field)))return std::string();auto value=read(field.Get());return ot::utf8(value.value.substr(value.start,value.end-value.start));}));}catch(...){return nullptr;}}
OT_EXPORT int insertRichText(const char* html,const char* text){try{auto value=ot::wide(text);std::string markup=html?html:"";return ot::system([value,markup]{
  auto* api=ot::automation();ComPtr<IUIAutomationElement> field;if(!api||FAILED(api->GetFocusedElement(&field)))return -1;
  Target target;target.window=GetForegroundWindow();GetWindowThreadProcessId(target.window,&target.pid);target.element=field;target.field=true;target.original=read(field.Get());target.urls=webURLs(field.Get());commit(target,value,markup);return 0;
});}catch(...){return -1;}}
OT_EXPORT int insertText(const char* text){return insertRichText("",text);}
OT_EXPORT int deleteBackward(int count){if(count<=0||count>100000)return -1;try{return ot::system([count]{
  auto* api=ot::automation();ComPtr<IUIAutomationElement> field;if(!api||FAILED(api->GetFocusedElement(&field)))return -1;
  Target target;target.window=GetForegroundWindow();GetWindowThreadProcessId(target.window,&target.pid);target.element=field;target.field=true;target.original=read(field.Get());target.urls=webURLs(field.Get());
  if(target.original.start==target.original.end){int moved=0;if(FAILED(target.original.selection->MoveEndpointByUnit(TextPatternRangeEndpoint_Start,TextUnit_Character,-count,&moved))||FAILED(target.original.selection->Select()))return -1;target.original=read(field.Get());}
  if(target.original.start==target.original.end)return 0;commit(target,L"");return 0;
});}catch(...){return -1;}}
OT_EXPORT void restoreNativeClipboard(){try{ot::system([]{restoreClipboard();});}catch(...) {}}
