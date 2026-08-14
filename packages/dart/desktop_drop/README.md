# desktop_drop (vendored fork)

Repository-owned fork of the pub package `desktop_drop`, used only by
`apps/client` for composer file drops (A1b).

## Provenance

| | |
| --- | --- |
| Upstream | https://github.com/MixinNetwork/flutter-plugins/tree/main/packages/desktop_drop |
| Forked from | pub.dev `desktop_drop` 0.7.1 |
| Fork version | `0.7.1+cosyncing.5` |
| License | unchanged, see `LICENSE` |

The fork version carries the `+cosyncing.N` build suffix so it is never
mistaken for upstream 0.7.1. Bump `N` on every fork change.

## Divergence from upstream 0.7.1

**Android and iOS removed.** Upstream declares an Android plugin whose
`onAttachedToActivity` installs an `android.R.id.content` drag listener that
returns `true` for every `DragEvent`. Declaring the platform is enough to
consume Android drag/drop, and this app renders no Android drop target. The
`android/` directory and the `android:` platform entry are both gone.
`apps/client/test/src/features/sessions/attachments/desktop_drop_platform_boundary_test.dart`
fails if either returns.

**Web registrar replaced.** `lib/desktop_drop_web.dart` registers no global
browser handler. Upstream installs a document-level handler that recursively
enumerates a dropped directory — including the `readEntries` pagination loop —
before the widget callback ever sees a `DropItemDirectory`. The client instead
observes browser drag events at its exact composer boundary and snapshots a
bounded file list there, so the fork's `registerWith` is intentionally empty.

**macOS file promises refused before materialization.** Upstream's
`performDragOperation` creates a temporary `Drops/<timestamp>` directory on
*every* drop, then falls back to `NSFilePromiseReceiver` and writes each
promised file into it before Dart learns the drop happened. The client rejects
virtual payloads, so nothing on the Dart side ever owns those bytes: a
rejected, removed, or uploaded promise would sit in the container until the OS
reclaims it, and ordinary drops would leave empty directories behind. The fork
removes the destination directory, the promise receiver, and the work queue,
and no longer registers `NSFilePromiseReceiver.readableDraggedTypes` — a
payload we refuse should get macOS's own no-drop cursor rather than a drop
affordance ending in a rejection notice.
`desktop_drop_platform_boundary_test.dart` fails if any of that machinery
returns. Dart rejects `fromPromise` items as well, so a promise arriving from
any other path is still refused before it is read.

**`DesktopDrop.instance.setFileLimit(n)`.** Upstream delivers every path a drop
carries, so a caller's own limit can only be applied after the platform has
enumerated, stat-ed, and marshalled the lot. The bound now travels into native
code instead, matching what the vendored `pasteboard` does for the clipboard:

- Windows: `DragQueryFile(hDrop, 0xFFFFFFFF, …)` reports the count without
  reading a single name, so the cut lands before any path is converted.
- macOS: applied inside the push loop, before the per-item `resourceValues`
  stat and the security-scoped `bookmarkData` — the expensive part of admitting
  a path. `readObjects` still materializes the URL array; that is one AppKit
  call and not something the plugin can bound.
- Linux: GTK hands the whole selection over as one blob, so the bound is a cut
  of that blob — nothing past it becomes a Dart string, a list entry, or a
  `DropItem`. The cut counts what Dart will actually deliver: `LineSplitter`
  ends a line at `\n`, `\r\n`, or a bare `\r`, and empty lines are dropped
  before the caller counts them. Counting raw `\n` instead would let blank
  lines spend the budget — an overflowing drop arriving under the limit and
  being silently accepted in part — and would let a `\r`-separated payload past
  the bound entirely.

A negative limit restores upstream's unbounded delivery, and a host without the
handler keeps it too: the Dart call swallows `MissingPluginException` rather
than failing the drop surface. Web is unaffected — the browser hands its whole
`FileList` to the registrar, so that path bounds itself where it claims files.

**Windows no longer prints dropped paths.** Upstream wrote every dropped file
path to stdout from `IDropTarget::Drop`.

**Formatting only.** `lib/src/channel.dart`, `lib/src/drop_target.dart`, and
`lib/src/events.dart` differ from upstream only by `dart format` under this
repository's line length. Do not treat these as behavioral changes.

**Whitespace only.** Upstream's `DesktopDropPlugin.swift` carries trailing
whitespace that `git diff --check` reports, so the import would have committed
a defect the repository rejects everywhere else. Those characters are stripped;
nothing else on those lines changed. Strip them again after any upstream
re-import, and diff with `-b` when comparing against a fresh pub cache copy.

**Not vendored.** `CHANGELOG.md`, `analysis_options.yaml`, `example/`, and
upstream's `test/` are omitted; they are not part of the shipped plugin.

## Verification

Native code cannot be exercised by `flutter test`, so each platform is compiled
directly, and `desktop_drop_platform_boundary_test.dart` asserts at the source
that each one still carries its bound:

- Linux: `g++ -c linux/desktop_drop_plugin.cc -I linux/include -I <flutter>/bin/cache/artifacts/engine/linux-x64 $(pkg-config --cflags gtk+-3.0) -Wall -Wextra -std=c++17`
- macOS: `xcrun swiftc -typecheck -sdk $(xcrun --show-sdk-path --sdk macosx) -target arm64-apple-macos11 -F <FlutterMacOS.xcframework>/macos-arm64_x86_64 macos/desktop_drop/Sources/desktop_drop/DesktopDropPlugin.swift`
- Windows: `cl.exe /c /EHsc /std:c++17 /W3 /DUNICODE /D_UNICODE /DFLUTTER_PLUGIN_IMPL /I <cpp_client_wrapper/include> /I windows/include windows/desktop_drop_plugin.cpp`
  (`/DUNICODE` is required — Flutter's CMake sets it, and upstream fails the
  same way without it.)

## Updating the fork

1. Fetch the target upstream release into the pub cache:
   `flutter pub cache add desktop_drop -v <version>`
2. Diff it against this tree, which reports the divergences above plus any new
   upstream change:
   `diff -ru ~/.pub-cache/hosted/pub.dev/desktop_drop-<version> packages/dart/desktop_drop`
3. Apply upstream changes to `lib/`, `linux/`, `macos/`, and `windows/` only.
   Never restore `android/`, `ios/`, or upstream's web registrar.
4. Re-run `dart format` on `lib/` so the formatting divergence stays the only
   incidental diff.
5. Update the provenance table above and bump the `+cosyncing.N` suffix in
   `pubspec.yaml`.
6. Run `flutter pub get` in `apps/client` to refresh the generated plugin
   manifests, then the A1b intake tests and `bun run ci:check-boundaries`.
