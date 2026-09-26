import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  /// Set from Dart (`setKeepRunning` on `com.cosyncing.client/window`): whether
  /// closing the window leaves the app running in the Dock so notifications
  /// still arrive. Until Dart says so, closing the last window quits, as it
  /// always did.
  var keepRunning = false

  /// Held while the window is closed but the app keeps running. App Nap would
  /// otherwise stretch the notification feed's retry timers by minutes.
  private var closedWindowActivity: NSObjectProtocol?

  override func applicationDidFinishLaunching(_ notification: Notification) {
    super.applicationDidFinishLaunching(notification)
    NotificationCenter.default.addObserver(
      self, selector: #selector(windowWillClose(_:)),
      name: NSWindow.willCloseNotification, object: mainFlutterWindow)
    NotificationCenter.default.addObserver(
      self, selector: #selector(windowDidBecomeVisible(_:)),
      name: NSWindow.didBecomeKeyNotification, object: mainFlutterWindow)
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return !keepRunning
  }

  override func applicationShouldHandleReopen(
    _ sender: NSApplication, hasVisibleWindows flag: Bool
  ) -> Bool {
    if !flag { showMainWindow() }
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }

  /// Shows the window, reopening it after the user closed it, and brings the
  /// app to the front.
  func showMainWindow() {
    guard let window = mainFlutterWindow else { return }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func windowWillClose(_ notification: Notification) {
    guard keepRunning, closedWindowActivity == nil else { return }
    closedWindowActivity = ProcessInfo.processInfo.beginActivity(
      options: .userInitiatedAllowingIdleSystemSleep,
      reason: "Delivering notifications while the window is closed")
  }

  @objc private func windowDidBecomeVisible(_ notification: Notification) {
    guard let activity = closedWindowActivity else { return }
    ProcessInfo.processInfo.endActivity(activity)
    closedWindowActivity = nil
  }
}
