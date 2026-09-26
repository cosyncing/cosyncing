#ifndef RUNNER_FLUTTER_WINDOW_H_
#define RUNNER_FLUTTER_WINDOW_H_

#include <flutter/dart_project.h>
#include <flutter/encodable_value.h>
#include <flutter/flutter_view_controller.h>
#include <flutter/method_channel.h>
#include <windows.h>

#include <memory>
#include <string>

#include "win32_window.h"

// Registered message a second launch posts to the running client's window so
// it shows itself instead of the second copy starting.
inline constexpr wchar_t kShowRunningClientMessage[] =
    L"Cosyncing.Client.ShowWindow";

// A window that does nothing but host a Flutter view.
class FlutterWindow : public Win32Window {
 public:
  // Creates a new FlutterWindow hosting a Flutter view running |project|.
  explicit FlutterWindow(const flutter::DartProject& project);
  virtual ~FlutterWindow();

 protected:
  // Win32Window:
  bool OnCreate() override;
  void OnDestroy() override;
  LRESULT MessageHandler(HWND window, UINT const message, WPARAM const wparam,
                         LPARAM const lparam) noexcept override;

 private:
  // Handles `com.cosyncing.client/window` calls from Dart.
  void HandleWindowCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // Shows the window, including after it was closed to the notification area,
  // and brings it to the front. Returns whether it became the foreground.
  bool ShowAndRaise();

  // Adds or removes the notification-area icon.
  void AddTrayIcon();
  void RemoveTrayIcon();

  // Shows the notification-area menu at a screen position.
  void ShowTrayMenu(int x, int y);

  // Exits for real, bypassing keep-running.
  void Quit();

  // The project to run.
  flutter::DartProject project_;

  // The Flutter instance hosted by this window.
  std::unique_ptr<flutter::FlutterViewController> flutter_controller_;

  // Lets Dart bring this window to the front (a tapped notification) and set
  // what closing it does.
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      window_channel_;

  // Set from Dart: closing the window hides it to the notification area so
  // notifications still arrive. Until Dart says so, closing quits.
  bool keep_running_ = false;

  // Set by the menu's Quit, so the close that follows is not hidden.
  bool quitting_ = false;

  bool tray_icon_added_ = false;
  HICON tray_icon_ = nullptr;
  std::wstring tray_tooltip_ = L"Cosyncing";
  std::wstring tray_open_label_ = L"Open Cosyncing";
  std::wstring tray_quit_label_ = L"Quit Cosyncing";

  // Explorer broadcasts this after it restarts; every icon must be re-added.
  UINT taskbar_created_message_ = 0;
  UINT show_running_client_message_ = 0;
};

#endif  // RUNNER_FLUTTER_WINDOW_H_
