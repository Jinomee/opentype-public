// This process keeps a materialized clipboard backup in memory until delivery
// ends. It never stores clipboard contents in an application profile or file.
#include "ClipboardData.h"
#include "ClipboardProtocol.h"
#include "PrivateStorage.h"
#include <set>
#include <array>
#include <cerrno>
#include <cstdlib>

namespace {
using namespace otclip;
struct View{
  void* value=nullptr;
  ~View(){if(value)UnmapViewOfFile(value);}
};
struct MutexOwnership{
  HANDLE value;
  ~MutexOwnership(){ReleaseMutex(value);}
};
struct ClipboardLock{
  bool open;
  explicit ClipboardLock(HWND window):open(OpenClipboard(window)!=FALSE){}
  ~ClipboardLock(){if(open)CloseClipboard();}
};
void failGuard(){throw std::runtime_error("injection_clipboard_unavailable");}
bool supported(const ClipboardData::Item& item){
  const auto& f=item.format;const auto kind=item.medium.tymed;
  if(f.ptd||f.dwAspect!=DVASPECT_CONTENT||f.lindex!=-1)return false;
  UINT cf=f.cfFormat;
  if(cf==CF_BITMAP||cf==CF_DSPBITMAP)return kind==TYMED_GDI;
  if(cf==CF_METAFILEPICT||cf==CF_DSPMETAFILEPICT)return kind==TYMED_MFPICT;
  if(cf==CF_ENHMETAFILE||cf==CF_DSPENHMETAFILE)return kind==TYMED_ENHMF;
  // Private/display-owner formats and palettes need an owner-specific release
  // contract. Never empty those merely to deliver text.
  return kind==TYMED_HGLOBAL&&((cf>=CF_TEXT&&cf<CF_MAX&&cf!=CF_PALETTE)||cf==CF_DSPTEXT||cf>=0xc000);
}
ComPtr<ClipboardData> duplicate(ClipboardData* data){
  ComPtr<ClipboardData> result;result.Attach(new ClipboardData);std::set<CLIPFORMAT> formats;
  for(const auto& item:data->items){
    if(!supported(item)||!formats.insert(item.format.cfFormat).second)failGuard();
    STGMEDIUM copy={};if(!copyMedium(item.format,item.medium,copy))failGuard();
    try{result->items.push_back({item.format,copy});}catch(...){ReleaseStgMedium(&copy);throw;}
  }return result;
}
HANDLE raw(const STGMEDIUM& medium){
  switch(medium.tymed){
    case TYMED_HGLOBAL:return medium.hGlobal;
    case TYMED_GDI:return medium.hBitmap;
    case TYMED_MFPICT:return medium.hMetaFilePict;
    case TYMED_ENHMF:return medium.hEnhMetaFile;
    default:return nullptr;
  }
}
enum class Publish{complete,retry,changed};
class Guard{
  HWND window=nullptr;
  ComPtr<ClipboardData> saved;
  bool owns=false;
  DWORD sequence=0;
public:
  Guard(){
    WNDCLASSW type={};type.hInstance=GetModuleHandleW(nullptr);type.lpfnWndProc=DefWindowProcW;type.lpszClassName=L"OpenType.ClipboardGuard";
    if(!RegisterClassW(&type)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS)failGuard();
    window=CreateWindowExW(0,type.lpszClassName,L"",0,0,0,0,0,HWND_MESSAGE,nullptr,type.hInstance,nullptr);
    if(!window)failGuard();
  }
  ~Guard(){if(window)DestroyWindow(window);}
  void prepare(){
    saved=archiveClipboard();
    // Validate complete replayability before the caller can authorize a change.
    auto check=duplicate(saved.Get());
  }
  DWORD currentSequence()const{return sequence;}
  Publish publish(ClipboardData* data,DWORD expected,bool restoring){
    auto staged=duplicate(data); // Allocate every copy before opening/emptying.
    Publish result=Publish::complete;
    {
      ClipboardLock lock(window);if(!lock.open)return Publish::retry;
      if(GetClipboardSequenceNumber()!=expected||(restoring&&GetClipboardOwner()!=window))return Publish::changed;
      if(!EmptyClipboard())return Publish::retry;
      owns=true;
      for(auto& item:staged->items){
        if(!SetClipboardData(item.format.cfFormat,raw(item.medium))){result=Publish::retry;break;}
        // Windows now owns this particular copy, including its nested metafile.
        ZeroMemory(&item.medium,sizeof(item.medium));
      }
    }
    // CloseClipboard adds synthesized formats (CF_TEXT, CF_OEMTEXT, CF_LOCALE)
    // and advances the sequence again, so record it only after closing. Read it
    // before checking ownership: another app's EmptyClipboard is then detected.
    sequence=GetClipboardSequenceNumber();
    if(GetClipboardOwner()!=window){owns=false;return Publish::changed;}
    return result;
  }
  void restore(){
    while(owns){
      if(GetClipboardSequenceNumber()!=sequence||GetClipboardOwner()!=window){owns=false;return;}
      try{
        auto result=publish(saved.Get(),sequence,true);
        if(result==Publish::complete||result==Publish::changed){owns=false;return;}
      }catch(...){}
      // Temporary clipboard locks/allocation failures keep the backup alive.
      // Pump OLE messages while waiting; user copying something new wins next time.
      MsgWaitForMultipleObjectsEx(0,nullptr,300,QS_ALLINPUT,MWMO_INPUTAVAILABLE);
      MSG message;while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)){TranslateMessage(&message);DispatchMessageW(&message);}
    }
  }
};
HANDLE parse(const wchar_t* text){
  if(!text||!*text)failGuard();for(auto* cursor=text;*cursor;cursor++)if(*cursor<L'0'||*cursor>L'9')failGuard();
  errno=0;wchar_t* end=nullptr;auto value=_wcstoui64(text,&end,10);
  if(errno||!end||*end||!value||value>UINTPTR_MAX||value==UINTPTR_MAX)failGuard();return reinterpret_cast<HANDLE>(static_cast<uintptr_t>(value));
}
void respond(Packet* packet,Result result,HANDLE ready,HANDLE applied){
  InterlockedExchange(&packet->result,result);SetEvent(ready);SetEvent(applied);
}
}
int wmain(int argc,wchar_t** argv){
  if(argc!=8)return 2;
  if(FAILED(OleInitialize(nullptr)))return 1;
  int code=0;
  try{
    std::array<HANDLE,7> handles{};for(size_t i=0;i<handles.size();i++)handles[i]=parse(argv[i+1]);
    // Mapping, ready, apply, applied, restore, posted, parent process.
    View header;header.value=MapViewOfFile(handles[0],FILE_MAP_READ|FILE_MAP_WRITE,0,0,sizeof(Packet));if(!header.value)failGuard();
    auto* initial=static_cast<Packet*>(header.value);
    uint32_t textBytes=initial->textBytes,htmlBytes=initial->htmlBytes,baseline=initial->originalSequence;
    if(initial->signature!=magic||initial->version!=1||!textBytes||textBytes%sizeof(wchar_t)||textBytes>maximumPayload||htmlBytes>maximumPayload-textBytes)failGuard();
    View content;content.value=MapViewOfFile(handles[0],FILE_MAP_READ|FILE_MAP_WRITE,0,0,sizeof(Packet)+textBytes+htmlBytes);if(!content.value)failGuard();
    auto* packet=static_cast<Packet*>(content.value);
    try{
      otprivate::UserAccess user;auto security=user.attributes();
      auto name=L"Local\\OpenType.ClipboardGuard."+user.sid();otprivate::Handle mutex(CreateMutexW(&security,FALSE,name.c_str()));
      DWORD locked=mutex?WaitForSingleObject(mutex.get(),0):WAIT_FAILED;
      if(locked!=WAIT_OBJECT_0&&locked!=WAIT_ABANDONED){respond(packet,locked==WAIT_TIMEOUT?occupied:unavailable,handles[1],handles[3]);code=1;}
      else{
        MutexOwnership owner{mutex.get()};Guard guard;
        try{
          std::wstring text(static_cast<const wchar_t*>(static_cast<const void*>(packet+1)),textBytes/sizeof(wchar_t));
          std::string html(reinterpret_cast<const char*>(packet+1)+textBytes,htmlBytes);
          if(text.find(L'\0')!=std::wstring::npos||html.find('\0')!=std::string::npos)failGuard();
          guard.prepare();
          if(GetClipboardSequenceNumber()!=baseline){respond(packet,changed,handles[1],handles[3]);code=1;}
          else{
            ComPtr<ClipboardData> replacement;replacement.Attach(new ClipboardData);
            replacement->add(CF_UNICODETEXT,text.c_str(),(text.size()+1)*sizeof(wchar_t));
            if(!html.empty()){
              UINT format=RegisterClipboardFormatW(L"HTML Format");if(!format)failGuard();auto value=htmlClipboard(html);
              replacement->add(static_cast<CLIPFORMAT>(format),value.c_str(),value.size()+1);
            }
            InterlockedExchange(&packet->result,ready);SetEvent(handles[1]);
            HANDLE before[]={handles[4],handles[6],handles[2]};
            if(wait(before,3,15000)==2){
              auto result=guard.publish(replacement.Get(),baseline,false);
              if(result!=Publish::complete){respond(packet,result==Publish::changed?changed:unavailable,handles[1],handles[3]);code=1;}
              else{
                packet->appliedSequence=guard.currentSequence();InterlockedExchange(&packet->result,applied);SetEvent(handles[3]);
                HANDLE after[]={handles[4],handles[6],handles[5]};
                if(wait(after,3,30000)==2){
                  // Delivery was posted exactly once by the parent. Give the
                  // target time to consume it, while quit/cancel can restore now.
                  HANDLE finish[]={handles[4],handles[6]};wait(finish,2,1200);
                }
              }
            }
          }
        }catch(...){respond(packet,unavailable,handles[1],handles[3]);code=1;}
        guard.restore();
      }
    }catch(...){respond(packet,unavailable,handles[1],handles[3]);code=1;}
  }catch(...){code=1;}
  OleUninitialize();return code;
}
