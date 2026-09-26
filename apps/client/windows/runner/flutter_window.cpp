#include "flutter_window.h"

#include <flutter/standard_method_codec.h>
#include <shellapi.h>
#include <windowsx.h>

#include <optional>

#include "flutter/generated_plugin_registrant.h"
#include "resource.h"
#include "utils.h"

namespace {

constexpr UINT kTrayCallbackMessage = WM_APP + 1;
constexpr UINT kTrayIconId = 1;
constexpr UINT kTrayOpenCommand = 1;
constexpr UINT kTrayQuitCommand = 2;

// Reads one string argument; |fallback| when it is absent or empty.
std::wstring StringArgument(const flutter::EncodableMap& arguments,
                            const char* key, const std::wstring& fallback) {
  const auto found = arguments.find(flutter::EncodableValue(key));
  if (found == arguments.end()) return fallback;
  const auto* value = std::get_if<std::string>(&found->second);
  if (value == nullptr) return fallback;
  std::wstring converted = Utf16FromUtf8(*value);
  return converted.empty() ? fallback : converted;
}

}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  taskbar_created_message_ = RegisterWindowMessageW(L"TaskbarCreated");
  show_running_client_message_ =
      RegisterWindowMessageW(kShowRunningClientMessage);

  // A toast activation reaches the running process through COM without
  // raising any window, so a tapped notification asks for it explicitly.
  window_channel_ =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(),
          "com.cosyncing.client/window",
          &flutter::StandardMethodCodec::GetInstance());
  window_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                 result) { HandleWindowCall(call, std::move(result)); });

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  RemoveTrayIcon();
  if (tray_icon_ != nullptr) {
    DestroyIcon(tray_icon_);
    tray_icon_ = nullptr;
  }
  window_channel_ = nullptr;
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

void FlutterWindow::HandleWindowCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  if (call.method_name() == "raise") {
    result->Success(flutter::EncodableValue(ShowAndRaise()));
    return;
  }
  if (call.method_name() == "setKeepRunning") {
    const auto* arguments =
        std::get_if<flutter::EncodableMap>(call.arguments());
    if (arguments == nullptr) {
      result->Error("bad-arguments", "setKeepRunning takes a map");
      return;
    }
    const auto enabled = arguments->find(flutter::EncodableValue("enabled"));
    const bool* enabled_value =
        enabled == arguments->end() ? nullptr
                                    : std::get_if<bool>(&enabled->second);
    keep_running_ = enabled_value != nullptr && *enabled_value;
    tray_tooltip_ = StringArgument(*arguments, "tooltip", tray_tooltip_);
    tray_open_label_ = StringArgument(*arguments, "openLabel", tray_open_label_);
    tray_quit_label_ = StringArgument(*arguments, "quitLabel", tray_quit_label_);
    if (keep_running_) {
      // Re-added so a changed tooltip takes effect.
      RemoveTrayIcon();
      AddTrayIcon();
    } else {
      RemoveTrayIcon();
      // Nothing is left to bring a hidden window back: show it.
      HWND hwnd = GetHandle();
      if (hwnd != nullptr && !IsWindowVisible(hwnd)) ShowAndRaise();
    }
    result->Success();
    return;
  }
  result->NotImplemented();
}

bool FlutterWindow::ShowAndRaise() {
  HWND hwnd = GetHandle();
  if (hwnd == nullptr) return false;
  ShowWindow(hwnd, IsIconic(hwnd) ? SW_RESTORE : SW_SHOW);
  return SetForegroundWindow(hwnd) != FALSE;
}

void FlutterWindow::AddTrayIcon() {
  HWND hwnd = GetHandle();
  if (hwnd == nullptr || tray_icon_added_) return;
  if (tray_icon_ == nullptr) {
    tray_icon_ = static_cast<HICON>(LoadImageW(
        GetModuleHandle(nullptr), MAKEINTRESOURCEW(IDI_APP_ICON), IMAGE_ICON,
        GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON),
        LR_DEFAULTCOLOR));
  }
  NOTIFYICONDATAW data = {};
  data.cbSize = sizeof(data);
  data.hWnd = hwnd;
  data.uID = kTrayIconId;
  data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP;
  data.uCallbackMessage = kTrayCallbackMessage;
  data.hIcon = tray_icon_;
  wcsncpy_s(data.szTip, tray_tooltip_.c_str(), _TRUNCATE);
  if (!Shell_NotifyIconW(NIM_ADD, &data)) return;
  data.uVersion = NOTIFYICON_VERSION_4;
  Shell_NotifyIconW(NIM_SETVERSION, &data);
  tray_icon_added_ = true;
}

void FlutterWindow::RemoveTrayIcon() {
  if (tray_icon_added_) {
    NOTIFYICONDATAW data = {};
    data.cbSize = sizeof(data);
    data.hWnd = GetHandle();
    data.uID = kTrayIconId;
    Shell_NotifyIconW(NIM_DELETE, &data);
    tray_icon_added_ = false;
  }
}

void FlutterWindow::ShowTrayMenu(int x, int y) {
  HWND hwnd = GetHandle();
  HMENU menu = CreatePopupMenu();
  if (hwnd == nullptr || menu == nullptr) return;
  AppendMenuW(menu, MF_STRING, kTrayOpenCommand, tray_open_label_.c_str());
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kTrayQuitCommand, tray_quit_label_.c_str());
  SetMenuDefaultItem(menu, kTrayOpenCommand, FALSE);
  // Without the foreground, the menu would not close on a click elsewhere.
  SetForegroundWindow(hwnd);
  const UINT alignment = GetSystemMetrics(SM_MENUDROPALIGNMENT) != 0
                             ? TPM_RIGHTALIGN
                             : TPM_LEFTALIGN;
  const UINT command = static_cast<UINT>(TrackPopupMenuEx(
      menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON | alignment, x, y,
      hwnd, nullptr));
  PostMessageW(hwnd, WM_NULL, 0, 0);
  DestroyMenu(menu);
  if (command == kTrayOpenCommand) {
    ShowAndRaise();
  } else if (command == kTrayQuitCommand) {
    Quit();
  }
}

void FlutterWindow::Quit() {
  quitting_ = true;
  keep_running_ = false;
  RemoveTrayIcon();
  HWND hwnd = GetHandle();
  if (hwnd != nullptr) PostMessageW(hwnd, WM_CLOSE, 0, 0);
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // Before Flutter sees it: a close while keep-running hides the window to the
  // notification area, and Flutter must not start an application exit.
  if (message == WM_CLOSE && keep_running_ && !quitting_) {
    ShowWindow(hwnd, SW_HIDE);
    return 0;
  }
  if (message == kTrayCallbackMessage) {
    switch (LOWORD(lparam)) {
      case NIN_SELECT:
      case NIN_KEYSELECT:
        ShowAndRaise();
        break;
      case WM_CONTEXTMENU:
        ShowTrayMenu(GET_X_LPARAM(wparam), GET_Y_LPARAM(wparam));
        break;
    }
    return 0;
  }
  if (show_running_client_message_ != 0 &&
      message == show_running_client_message_) {
    ShowAndRaise();
    return 0;
  }
  if (taskbar_created_message_ != 0 && message == taskbar_created_message_) {
    tray_icon_added_ = false;
    if (keep_running_) AddTrayIcon();
    return 0;
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
