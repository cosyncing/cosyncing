import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  private var windowChannel: FlutterMethodChannel?

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)

    // Dart raises the window for a tapped notification (macOS activates the
    // app but does not reopen a closed window) and sets what closing does.
    let channel = FlutterMethodChannel(
      name: "com.cosyncing.client/window",
      binaryMessenger: flutterViewController.engine.binaryMessenger)
    channel.setMethodCallHandler { call, result in
      guard let delegate = NSApp.delegate as? AppDelegate else {
        result(FlutterMethodNotImplemented)
        return
      }
      switch call.method {
      case "updateOperation":
        let prefix = "--cosyncing-update="
        result(CommandLine.arguments.first(where: { $0.hasPrefix(prefix) })
          .map { String($0.dropFirst(prefix.count)) })
      case "quitForUpdate":
        result(nil)
        DispatchQueue.main.async { NSApp.terminate(nil) }
      case "raise":
        delegate.showMainWindow()
        result(true)
      case "setKeepRunning":
        let arguments = call.arguments as? [String: Any]
        delegate.keepRunning = arguments?["enabled"] as? Bool ?? false
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
    windowChannel = channel

    super.awakeFromNib()
  }
}
