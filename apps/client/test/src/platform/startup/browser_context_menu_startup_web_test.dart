@TestOn('browser')
library;

import 'dart:async';

import 'package:cosyncing_client/src/platform/startup/browser_context_menu_startup_web.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// The startup invariant: `BrowserContextMenu.enabled` must be settled before
/// the first frame. `bootstrap` awaits the helper before `runApp`, so this
/// reduces to: the helper's future must not complete while the platform
/// response is still pending. An implementation that gives up early (for
/// example with `Future.timeout`, which does not cancel the platform call)
/// settles during the hold below and fails this test — a late response would
/// then flip the global after live `SelectionArea`s exist, the exact mid-life
/// tree-shape transition the helper exists to prevent.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'helper settles only when the context-menu platform call does',
    () async {
      final gate = Completer<void>();
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.contextMenu,
        (call) async {
          expect(call.method, 'disableContextMenu');
          await gate.future;
          return null;
        },
      );

      var settled = false;
      final pending = disableBrowserContextMenuBeforeFirstFrame().whenComplete(
        () {
          settled = true;
        },
      );

      addTearDown(() async {
        // Failure-safe: an expect below may throw while the platform call is
        // still gated. Release the gate, settle the helper, and only then
        // restore the channel and the global for sibling tests.
        if (!gate.isCompleted) gate.complete();
        await pending.catchError((Object _) {});
        binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.contextMenu,
          (call) async => null,
        );
        await BrowserContextMenu.enableContextMenu();
        binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.contextMenu,
          null,
        );
      });

      // Hold the platform response well past any plausible internal cutoff.
      await Future<void>.delayed(const Duration(seconds: 3));
      expect(
        settled,
        isFalse,
        reason: 'the first frame must wait for the final context-menu state',
      );
      expect(BrowserContextMenu.enabled, isTrue);

      gate.complete();
      await pending;
      expect(settled, isTrue);
      expect(BrowserContextMenu.enabled, isFalse);
    },
  );

  test(
    'a channel error settles with the menu enabled and no later mutation',
    () async {
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.contextMenu,
        (call) async {
          throw PlatformException(code: 'fixture-context-menu-failure');
        },
      );
      addTearDown(() {
        binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.contextMenu,
          null,
        );
      });

      // The helper must swallow the failure (startup continues) and the
      // documented fallback shape must hold: the flag stays enabled.
      await disableBrowserContextMenuBeforeFirstFrame();
      expect(BrowserContextMenu.enabled, isTrue);

      // A failed call leaves no pending work that could mutate the global
      // later: drain the event queue and re-check.
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(BrowserContextMenu.enabled, isTrue);
    },
  );
}
