import Cocoa
import FlutterMacOS

private func findFlutterViewController(_ viewController: NSViewController?) -> FlutterViewController? {
  guard let vc = viewController else {
    return nil
  }
  if let fvc = vc as? FlutterViewController {
    return fvc
  }
  for child in vc.children {
    let fvc = findFlutterViewController(child)
    if fvc != nil {
      return fvc
    }
  }
  return nil
}

public class DesktopDropPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    guard let flutterView = registrar.view else { return }
    guard let flutterWindow = flutterView.window else { return }
    guard let vc = findFlutterViewController(flutterWindow.contentViewController) else { return }

    let channel = FlutterMethodChannel(name: "desktop_drop", binaryMessenger: registrar.messenger)

    let instance = DesktopDropPlugin()

      channel.setMethodCallHandler(instance.handle(_:result:))

    let d = DropTarget(frame: vc.view.bounds, channel: channel)
    d.autoresizingMask = [.width, .height]
    instance.target = d

    // Register for real file types only.
    //
    // Fork divergence. Upstream also registers
    // NSFilePromiseReceiver.readableDraggedTypes, which makes the window
    // accept promise-only drags this fork then refuses. Advertising a payload
    // we will not take shows the drop affordance and ends in a rejection
    // notice; declining the type up front lets macOS give the user its own
    // no-drop cursor instead.
    let types: [NSPasteboard.PasteboardType] = [
      .fileURL, // public.file-url
      NSPasteboard.PasteboardType("NSFilenamesPboardType"), // legacy array
    ]
    d.registerForDraggedTypes(types)

    vc.view.addSubview(d)

    registrar.addMethodCallDelegate(instance, channel: channel)
  }

    /// The view that receives drops, so the delivery bound can reach it.
    private weak var target: DropTarget?

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult){

      // Fork addition: accept the caller's delivery bound.
      if call.method == "setFileLimit" {
        let map = call.arguments as? NSDictionary
        target?.fileLimit = (map?["limit"] as? Int) ?? -1
        result(nil)
        return
      }

      if call.method ==  "startAccessingSecurityScopedResource"{
            let map = call.arguments as! NSDictionary
            var isStale: Bool = false

          let bookmarkByte = map["apple-bookmark"] as! FlutterStandardTypedData
          let bookmark = bookmarkByte.data

            let url = try? URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &isStale)
            let suc = url?.startAccessingSecurityScopedResource()
            result(suc)
            return
      }

      if call.method ==  "stopAccessingSecurityScopedResource"{
            let map = call.arguments as! NSDictionary
            var isStale: Bool = false
          let bookmarkByte = map["apple-bookmark"] as! FlutterStandardTypedData
          let bookmark = bookmarkByte.data
            let url = try? URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &isStale)
            url?.stopAccessingSecurityScopedResource()
            result(true)
            return
      }

      Swift.print("method not found: \(call.method)")
      result(FlutterMethodNotImplemented)
      return
  }


}

class DropTarget: NSView {
  private let channel: FlutterMethodChannel
  private let itemsLock = NSLock()

  /// Fork addition. Largest number of paths one drop may deliver; negative
  /// keeps upstream's unbounded enumeration.
  var fileLimit: Int = -1

  init(frame frameRect: NSRect, channel: FlutterMethodChannel) {
    self.channel = channel
    super.init(frame: frameRect)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    channel.invokeMethod("entered", arguments: convertPoint(sender.draggingLocation))
    return .copy
  }

  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
    channel.invokeMethod("updated", arguments: convertPoint(sender.draggingLocation))
    return .copy
  }

  override func draggingExited(_ sender: NSDraggingInfo?) {
    channel.invokeMethod("exited", arguments: nil)
  }

  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    let pb = sender.draggingPasteboard
    var items: [[String: Any]] = []
    var seen = Set<String>()

    func push(url: URL, fromPromise: Bool) {
      let path = url.path
      itemsLock.lock(); defer { itemsLock.unlock() }

      // Fork addition. Stop before the per-item work: admitting a path costs a
      // filesystem stat and, outside the container, a security-scoped bookmark.
      // A folder-sized drop pays neither past the caller's bound.
      if self.fileLimit >= 0 && items.count >= self.fileLimit { return }

      // de-dupe safely under lock
      if !seen.insert(path).inserted { return }

      let values = try? url.resourceValues(forKeys: [.isDirectoryKey])
      let isDirectory: Bool = values?.isDirectory ?? false

      // Only create a security-scoped bookmark for items outside our container.
      let bundleID = Bundle.main.bundleIdentifier ?? ""
      let containerRoot = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Containers/\(bundleID)", isDirectory: true)
        .path
      let tmpPath = FileManager.default.temporaryDirectory.path
      let isInsideContainer = path.hasPrefix(containerRoot) || path.hasPrefix(tmpPath)

      let bmData: Any
      if isInsideContainer {
        bmData = NSNull()
      } else {
        let bm = try? url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
        bmData = bm ?? NSNull()
      }
      items.append([
        "path": path,
        "apple-bookmark": bmData,
        "isDirectory": isDirectory,
        "fromPromise": fromPromise,
      ])
    }

    // Real file URLs only; there is no promise fallback in this fork.
    let urls = (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    let legacyList = (pb.propertyList(forType: NSPasteboard.PasteboardType("NSFilenamesPboardType")) as? [String]) ?? []

    // 1) Modern file URLs
    urls.forEach { push(url: $0, fromPromise: false) }
    // 2) Legacy filename array used by some apps
    legacyList.forEach { push(url: URL(fileURLWithPath: $0), fromPromise: false) }

    // 3) File promises are refused before materialization.
    //
    // Fork divergence. Upstream falls back to NSFilePromiseReceiver here: it
    // creates a temporary Drops/<timestamp> directory and writes every
    // promised file into it before Dart ever learns a drop happened. The
    // client rejects virtual payloads, so those bytes are pure cost and
    // nothing on the Dart side owns their cleanup — a rejected, removed, or
    // uploaded promise would stay on disk for the life of the container.
    // Reporting no items lets the composer refuse the drop honestly and
    // leaves no temporary directory behind, not even an empty one.

    channel.invokeMethod("performOperation_macos", arguments: items)
    return true
  }

  func convertPoint(_ location: NSPoint) -> [CGFloat] {
    return [location.x, bounds.height - location.y]
  }
}
