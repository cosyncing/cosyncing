# pasteboard (vendored fork)

Repository-owned fork of the pub package `pasteboard`, used only by
`apps/client` for desktop clipboard attachment intake (A1b). Upstream's own
`README.md` is kept as-is; this file records the fork.

## Provenance

| | |
| --- | --- |
| Upstream | https://github.com/MixinNetwork/flutter-plugins/tree/main/packages/pasteboard |
| Forked from | pub.dev `pasteboard` 0.5.0 |
| Fork version | `0.5.0+cosyncing.6` |
| License | unchanged, see `LICENSE` |

Bump the `+cosyncing.N` suffix on every fork change.

## Why this is vendored

Upstream applies no caller bound. `files()` marshals every path the clipboard
holds, and `image` decodes, encodes, and transports the whole image before Dart
can measure it. A1b has to enforce an eight-file selection limit and a 64 MiB
per-file limit, and doing that in Dart means the cost is already paid by the
time the limit is checked. The fork moves both bounds into native code.

## Divergence from upstream 0.5.0

**`files({int? limit})`.** When `limit` is given, native code stops at that
many paths.

- Windows: `DragQueryFile(hDrop, 0xFFFFFFFF, …)` reports the count without
  reading a single name, so the bound applies before any path is read out.
- macOS: truncates while converting `NSURL` objects to paths.
- Linux: stops converting URIs once the bound is reached.

A result of exactly `limit` means the clipboard held at least that many, which
is why the client asks for one more than the selection limit — enough to prove
overflow, never more.

**`boundedImage({required int maxBytes, required int maxDecodedBytes})`.** Two
bounds, because they measure different things. `maxBytes` bounds the *result*
and is applied to the encoded bytes. `maxDecodedBytes` bounds what the plugin
will allocate on the way there and is applied to the decoded pixel size before
anything is encoded. Either refusal uses the `image-too-large` error code,
which Dart surfaces as `PasteboardLimitExceeded`.

They have to be separate. macOS and Linux return PNG, and no pixel count
predicts how well an image compresses — a 20 MP screenshot can encode to a few
MB — so comparing a decoded size against a file-size budget would refuse
ordinary screenshots. Give `maxDecodedBytes` a value no real image reaches and
let the encoded length decide.

- Windows: the DIB header carries the dimensions, so both refusals happen
  before the HBITMAP allocation, the blit, and the temporary BMP written to
  disk. The two bounds are close here but not the same number: the result is an
  uncompressed BMP *file*, so it costs the pixels plus a `BITMAPFILEHEADER` and
  a `BITMAPINFOHEADER` (54 bytes — the destination bitmap is always 32bpp, so
  there is no colour table), while the allocation ceiling prices the pixels
  alone. Charging the result bound for pixels only would pass a 4096x4096 image
  under a 64 MiB limit and then hand back a file 54 bytes over it, which Dart
  reads in full before rejecting.

  The header is written by whichever app owns the clipboard, so it is treated
  as hostile: the comparison divides rather than multiplies (two dimensions
  near `LONG_MAX` overflow `width * height * 4` back into a value that would
  pass), `biHeight` is widened before being negated (negating `LONG_MIN` is
  undefined), and a non-positive dimension is answered as "no image" rather
  than flowing into GDI unchecked.
- macOS: sizes each representation the `NSImage` already carries, so nothing is
  encoded before admission — not even the TIFF that `tiffRepresentation` would
  build, which is itself an allocation as large as the picture being refused.
  Depth comes from `bitsPerPixel`, not `samplesPerPixel` (a channel count: a
  16-bit RGBA rep is 8 bytes per pixel, not 4), and every product is
  overflow-checked, since Swift's `*` traps rather than wrapping and would
  crash the host on a hostile pasteboard. The encoded length is re-checked
  after the PNG encode.
- Linux: compares `gdk_pixbuf_get_byte_length` before the PNG encode, then
  re-checks the encoded buffer against `maxBytes`. The encoded buffer and the
  `GError` are scope-owned: `fl_value_new_uint8_list` copies, and upstream
  freed the buffer on no path at all, leaking a whole PNG per successful
  screenshot paste. `files()` has the same fix — `g_file_get_path` allocates
  and upstream never released it.

The toolkit's own decode into an `NSImage`/`GdkPixbuf`/DIB is not ours to
prevent — AppKit, GTK, and the Win32 clipboard do that before the plugin is
called. What the fork avoids is the encode, the channel transfer, and the Dart
allocation.

The unbounded `files()` and `image` entry points are unchanged, so any other
caller behaves exactly as upstream.

**Not vendored.** `example/` is omitted. So is `android/gradle/`: the wrapper
jar is scaffolding for building the plugin standalone, Flutter drives the
plugin build from the app's own Gradle, and the repository audits every checked
in binary. `android/build.gradle` and the Kotlin source are unchanged, so
Android behavior is untouched.

**Whitespace only.** Upstream's iOS `SwiftPasteboardPlugin.swift` carries
trailing whitespace and a blank line at EOF that `git diff --check` reports, so
the import would have committed a defect the repository rejects everywhere
else. Those characters are stripped; nothing else changed, and the file is
otherwise untouched upstream code. Strip them again after any upstream
re-import, and diff with `-b` when comparing against a fresh pub cache copy.
`windows/strconv.h` still ends without a final newline, which `git diff
--check` does not report; it is left exactly as upstream wrote it.

`analysis_options.yaml` is omitted for the same reason, matching the vendored
`desktop_drop`. It is upstream's config for developing the plugin standalone,
and its `include: package:flutter_lints/flutter.yaml` does not resolve from a
path dependency the app never installs dev dependencies for — the analyzer
reported that as a package-resolution warning on every client gate run. The
fork's Dart is still format-checked by the client gate, which runs
`dart format` over `../../packages/dart`, and its behavioral divergences are
asserted by `desktop_drop_platform_boundary_test.dart`.

## Verification

Native code cannot be exercised by `flutter test`, so each platform is compiled
directly:

- Linux: `g++ -c linux/pasteboard_plugin.cc -I linux/include -I <flutter>/bin/cache/artifacts/engine/linux-x64 $(pkg-config --cflags gtk+-3.0) -Wall -Wextra -std=c++17`
- macOS: `xcrun swiftc -typecheck -sdk $(xcrun --show-sdk-path --sdk macosx) -target arm64-apple-macos11 -F <FlutterMacOS.xcframework>/macos-arm64_x86_64 macos/pasteboard/Sources/pasteboard/PasteboardPlugin.swift`
- Windows: `cl.exe /c /EHsc /std:c++17 /W3 /DUNICODE /D_UNICODE /DFLUTTER_PLUGIN_IMPL /I <cpp_client_wrapper/include> /I windows/include windows/pasteboard_plugin.cpp`
  (`/DUNICODE` is required — Flutter's CMake sets it, and upstream fails the
  same way without it.)

Compile the upstream copy under the identical harness when a result looks
surprising; that is how the `/DUNICODE` requirement was identified as a harness
gap rather than a fork defect.

## Updating the fork

1. `flutter pub cache add pasteboard -v <version>`
2. `diff -ru ~/.pub-cache/hosted/pub.dev/pasteboard-<version> packages/dart/pasteboard`
3. Reapply the two bounded entry points; leave the unbounded ones alone.
4. Recompile all three platforms as above.
5. Update this file and bump the `+cosyncing.N` suffix in `pubspec.yaml`.
6. `flutter pub get` in `apps/client`, then the A1b intake tests.
