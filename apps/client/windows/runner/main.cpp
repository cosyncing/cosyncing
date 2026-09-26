#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>

#include <functional>
#include <string>

#include "flutter_window.h"
#include "utils.h"

namespace {

constexpr wchar_t kClientWindowClass[] = L"FLUTTER_RUNNER_WIN32_WINDOW";

std::wstring ExecutablePath() {
  std::wstring path(32768, L'\0');
  const DWORD length =
      GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  path.resize(length);
  return path;
}

// One client per user session and executable. Closing the window can leave the
// client running in the notification area, so a second launch from the Start
// menu must show that one instead of starting another copy beside it. Keyed by
// the executable path, so a build elsewhere (a development run) still starts.
std::wstring SingleInstanceName(const std::wstring& executable) {
  std::wstring folded = executable;
  CharLowerBuffW(folded.data(), static_cast<DWORD>(folded.size()));
  return L"Local\\Cosyncing.Client." +
         std::to_wstring(std::hash<std::wstring>{}(folded));
}

struct ClientWindowSearch {
  std::wstring executable;
  HWND found = nullptr;
};

// Finds the top-level client window another process of this executable owns.
BOOL CALLBACK FindClientWindow(HWND hwnd, LPARAM lparam) {
  auto* search = reinterpret_cast<ClientWindowSearch*>(lparam);
  wchar_t class_name[64] = {};
  if (GetClassNameW(hwnd, class_name, 64) == 0 ||
      wcscmp(class_name, kClientWindowClass) != 0) {
    return TRUE;
  }
  DWORD process_id = 0;
  GetWindowThreadProcessId(hwnd, &process_id);
  if (process_id == GetCurrentProcessId()) return TRUE;
  HANDLE process =
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (process == nullptr) return TRUE;
  std::wstring image(32768, L'\0');
  DWORD size = static_cast<DWORD>(image.size());
  const bool same = QueryFullProcessImageNameW(process, 0, image.data(), &size) &&
                    _wcsicmp(image.c_str(), search->executable.c_str()) == 0;
  CloseHandle(process);
  if (!same) return TRUE;
  search->found = hwnd;
  return FALSE;
}

// Shows the running client's window. Returns false when none is found within
// a few seconds (the first copy may still be creating it).
bool ShowRunningClient(const std::wstring& executable) {
  const UINT show_message = RegisterWindowMessageW(kShowRunningClientMessage);
  for (int attempt = 0; attempt < 30; ++attempt) {
    ClientWindowSearch search{executable};
    EnumWindows(FindClientWindow, reinterpret_cast<LPARAM>(&search));
    if (search.found != nullptr) {
      DWORD process_id = 0;
      GetWindowThreadProcessId(search.found, &process_id);
      // This launch owns the foreground right now; lend it to that process.
      AllowSetForegroundWindow(process_id);
      PostMessageW(search.found, show_message, 0, 0);
      return true;
    }
    Sleep(100);
  }
  return false;
}

}  // namespace

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  const std::wstring executable = ExecutablePath();
  HANDLE single_instance = ::CreateMutexW(
      nullptr, FALSE, SingleInstanceName(executable).c_str());
  if (single_instance != nullptr && ::GetLastError() == ERROR_ALREADY_EXISTS) {
    ShowRunningClient(executable);
    ::CloseHandle(single_instance);
    return EXIT_SUCCESS;
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1280, 720);
  if (!window.Create(L"Cosyncing", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  if (single_instance != nullptr) ::CloseHandle(single_instance);
  return EXIT_SUCCESS;
}
