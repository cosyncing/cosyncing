import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Disables the browser context menu once, before the first frame.
///
/// `SelectableRegion.build` reads the global `BrowserContextMenu.enabled` to
/// decide whether to mount its web platform-view context-menu wrapper. The
/// flag has no change notification, so flipping it while regions are live
/// re-inflates every region's `SelectionContainer` at a different tree depth
/// on its next rebuild. Release builds compile out the SDK's only guard
/// against the resulting double registration (`assert(_selectable == null)`
/// in `SelectableRegionState.add`), which corrupts the region's selectable
/// slot and defers the failure to a null-check throw at teardown.
///
/// The invariant is therefore: the flag's final value must be settled before
/// `runApp`. This await is deliberately unbounded — a timeout cannot provide
/// the invariant, because `Future.timeout` does not cancel the platform call
/// and the SDK mutates the flag in that original future's `.then`, so a late
/// response would flip the global after live regions exist. The two outcomes
/// that can settle are both safe shapes: success disables the menu for the
/// app's lifetime and the flutter/flutter#122680 platform view never mounts;
/// a channel error skips the SDK's `.then`, so the flag stays `true` for the
/// app's lifetime — the platform view then mounts as on any stock Flutter
/// web app (keeping the #122680 exposure), but the tree shape still never
/// changes mid-life.
Future<void> disableBrowserContextMenuBeforeFirstFrame() async {
  try {
    await BrowserContextMenu.disableContextMenu();
  } on Object catch (error) {
    debugPrint(
      'browser context menu disable failed; menu stays enabled: '
      '$error',
    );
  }
}
