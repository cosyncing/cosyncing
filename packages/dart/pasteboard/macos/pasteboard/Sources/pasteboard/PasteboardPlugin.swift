import Cocoa
import FlutterMacOS
import AppKit

public class PasteboardPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: "pasteboard", binaryMessenger: registrar.messenger)
    let instance = PasteboardPlugin()
    registrar.addMethodCallDelegate(instance, channel: channel)
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "image":
      image(maxBytes: PasteboardPlugin.intArgument(call, "maxBytes"),
            maxDecodedBytes: PasteboardPlugin.intArgument(call, "maxDecodedBytes"),
            result: result)
    case "files":
      files(limit: PasteboardPlugin.intArgument(call, "limit"), result: result)
    case "writeFiles":
      if let arguments = call.arguments as? [String] {
        writeFiles(arguments, result: result)
      } else {
        result(FlutterError(code: "0", message: "arguments is not String list.", details: nil))
      }
    case "writeImage":
      if let data = call.arguments as? FlutterStandardTypedData {
        writeImageToPasteboard(data.data, result: result)
      } else {
        result(FlutterError(code: "0", message: "arguments is not data", details: nil))
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func writeImageToPasteboard(_ data: Data, result: FlutterResult) {
    let image = NSImage(data: data) ?? NSImage()
    NSPasteboard.general.clearContents()
    NSPasteboard.general.writeObjects([image as NSImage])
    result(nil)
  }

  /// Fork addition: reads an optional integer bound from the call arguments.
  private static func intArgument(_ call: FlutterMethodCall, _ name: String) -> Int? {
    guard let arguments = call.arguments as? [String: Any] else { return nil }
    return arguments[name] as? Int
  }

  private func image(maxBytes: Int?, maxDecodedBytes: Int?, result: FlutterResult) {
    guard let image = NSPasteboard.general.readObjects(forClasses: [NSImage.self], options: nil)?.first as? NSImage else {
      result(nil)
      return
    }

    // Fork addition. Two bounds, because they measure different things.
    //
    // The decoded size is what this plugin would have to allocate to encode at
    // all, and it is knowable up front — so it is checked first, against the
    // caller's allocation ceiling. It is NOT a proxy for the encoded size:
    // PNG compresses by an amount no dimension can predict, and refusing a
    // 20 MP screenshot because 20 MP * 4 exceeds a file-size budget would
    // reject an image that encodes to a few MB. The encoded length below is
    // what the file limit actually applies to.
    //
    // AppKit has already decoded the pasteboard's own representation by this
    // point — that decode belongs to the toolkit — but nothing beyond it is
    // paid for a refused image.
    if let maxDecodedBytes = maxDecodedBytes {
      guard let estimate = PasteboardPlugin.decodedByteEstimate(image),
            estimate <= maxDecodedBytes else {
        result(FlutterError(code: "image-too-large",
                            message: "decoded clipboard image exceeds \(maxDecodedBytes) bytes",
                            details: nil))
        return
      }
    }
    guard let maxBytes = maxBytes else {
      result(image.png)
      return
    }
    // Admitted: only now is it worth materializing a bitmap to encode from.
    guard let bitmap = image.tiffRepresentation?.bitmap else {
      result(nil)
      return
    }
    guard let png = bitmap.png, png.count <= maxBytes else {
      result(FlutterError(code: "image-too-large",
                          message: "encoded clipboard image exceeds \(maxBytes) bytes",
                          details: nil))
      return
    }
    result(png)
  }

  /// Fork addition: decoded size of [image] without allocating anything.
  ///
  /// The representations an `NSImage` already carries know their own pixel
  /// dimensions, so the bound can be applied before `tiffRepresentation` —
  /// which re-encodes the whole image, an allocation as large as the picture
  /// this check exists to refuse. Returns nil when the size cannot be
  /// established or does not fit in an `Int`, both of which are refusals:
  /// Swift's `*` traps on overflow, so the arithmetic is checked rather than
  /// left to crash the host app on a hostile pasteboard.
  private static func decodedByteEstimate(_ image: NSImage) -> Int? {
    var largest = 0
    for rep in image.representations {
      // NSImageRepMatchesDevice (0) means the rep is resolution independent
      // and carries no pixel count of its own.
      guard rep.pixelsWide > 0, rep.pixelsHigh > 0 else { continue }
      // `bitsPerPixel`, not `samplesPerPixel`, which counts channels: a
      // 16-bit-per-sample RGBA rep is 8 bytes per pixel, not 4, and pricing it
      // at 4 would let a hostile pasteboard through at twice the bound.
      let perPixel = max(4, ((rep as? NSBitmapImageRep)?.bitsPerPixel ?? 32) / 8)
      // Sized per representation rather than by maxing width and height across
      // all of them: a 1000x10 rep beside a 10x1000 one is not a 1000x1000
      // image, and pricing it as one refuses something a hundred times smaller.
      let (area, areaOverflowed) =
        rep.pixelsWide.multipliedReportingOverflow(by: rep.pixelsHigh)
      if areaOverflowed { return nil }
      let (size, sizeOverflowed) = area.multipliedReportingOverflow(by: perPixel)
      if sizeOverflowed { return nil }
      largest = max(largest, size)
    }
    if largest > 0 { return largest }

    // No representation carried a pixel count. Fall back to the point size a
    // resolution-independent one would render at, converted defensively:
    // `Int(_:)` on a non-finite or out-of-range CGFloat traps, and this value
    // comes off the pasteboard.
    let pointWidth = Double(image.size.width).rounded(.up)
    let pointHeight = Double(image.size.height).rounded(.up)
    guard pointWidth.isFinite, pointHeight.isFinite,
          pointWidth > 0, pointHeight > 0,
          pointWidth < Double(Int.max), pointHeight < Double(Int.max) else {
      return nil
    }
    let (area, areaOverflowed) =
      Int(pointWidth).multipliedReportingOverflow(by: Int(pointHeight))
    if areaOverflowed { return nil }
    let (estimate, estimateOverflowed) = area.multipliedReportingOverflow(by: 4)
    return estimateOverflowed ? nil : estimate
  }

  private func files(limit: Int?, result: FlutterResult) {
    guard let urlList = NSPasteboard.general.readObjects(forClasses: [NSURL.self], options: nil) else {
      result(nil)
      return
    }

    var resultFiles: [String] = []

    for url in urlList {
      // Fork addition: stop at the caller's bound instead of marshalling
      // every path a clipboard happens to hold.
      if let limit = limit, resultFiles.count >= limit { break }
      if let path = (url as? NSURL)?.path {
        resultFiles.append(path)
      }
    }
    result(resultFiles)
  }

  private func writeFiles(_ files: [String], result: FlutterResult) {
    var urls: [NSURL] = []

    files.forEach { file in
      urls.append(NSURL(fileURLWithPath: file))
    }
    NSPasteboard.general.clearContents()
    if NSPasteboard.general.writeObjects(urls) {
      result(nil)
    } else {
      result(FlutterError(code: "0", message: "failed to write pasteboard objects", details: nil))
    }
  }
}

extension NSBitmapImageRep {
  var png: Data? { representation(using: .png, properties: [:]) }
}

extension Data {
  var bitmap: NSBitmapImageRep? { NSBitmapImageRep(data: self) }
}

extension NSImage {
  var png: Data? { tiffRepresentation?.bitmap?.png }
}
