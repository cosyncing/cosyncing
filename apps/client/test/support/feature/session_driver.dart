// Session Detail verbs for feature tests (F05): the status sheet, take over,
// and what the page says about who owns the session.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'app_driver.dart';
import 'cosyncing_app.dart';
import 'fake_broker.dart';
import 'roster_driver.dart';

/// Session Detail verbs over a running App.
extension SessionDriver on AppDriver {
  static final _pillKey = RegExp(r'^session-detail-control-pill-(\w+)$');

  /// The ownership pill in the page header (`driving`, `observing`,
  /// `synced`, `syncAvailable`, `driverActive`, `unavailable`, `unknown`),
  /// or null when the page shows none.
  String? get pill {
    final names = <String>{};
    for (final element
        in find
            .byWidgetPredicate(
              (w) =>
                  w.key is ValueKey<String> &&
                  _pillKey.hasMatch(
                    (w.key! as ValueKey<String>).value,
                  ),
            )
            .evaluate()) {
      names.add(
        _pillKey
            .firstMatch((element.widget.key! as ValueKey<String>).value)!
            .group(1)!,
      );
    }
    return names.isEmpty ? null : names.single;
  }

  /// Whether the Observe bar (read-only composer with Take over) is showing.
  bool get composerIsReadOnly => find
      .byKey(const Key('session-detail-observe-composer-bar'))
      .evaluate()
      .isNotEmpty;

  /// Opens the Status sheet from the header chip.
  Future<void> openStatus() => tapKey('session-detail-status-chip');

  /// Closes whatever modal is open (a sheet or dialog) with the Escape key.
  Future<void> dismissModal() async {
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await settle();
  }

  /// Presses Take over in the Observe bar and confirms the dialog.
  Future<void> takeOver({bool confirm = true}) async {
    await tapKey('session-detail-composer-take-over-button');
    if (find
        .byKey(const Key('session-detail-take-over-dialog'))
        .evaluate()
        .isEmpty) {
      return;
    }
    if (confirm) {
      await tapKey('session-detail-take-over-confirm');
    } else {
      await tap(
        find.descendant(
          of: find.byKey(const Key('session-detail-take-over-dialog')),
          matching: find.widgetWithText(TextButton, 'Cancel'),
        ),
      );
    }
  }

  /// Types [text] into the composer and presses Send.
  Future<void> send(String text) async {
    await enterText(find.byKey(const Key('session-detail-prompt-input')), text);
    await tapKey('session-detail-send-button');
  }

  /// Records what the app copies to the clipboard, newest last.
  List<String> captureClipboard() {
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied.add((call.arguments as Map)['text'] as String);
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    return copied;
  }

  /// Frames of kind [kind] the app sent on session sockets to [broker].
  List<Map<String, dynamic>> framesSent(FakeBroker broker, String kind) => [
    for (final socket in network.sockets)
      if (identical(socket.broker, broker))
        for (final frame in socket.sent)
          if (frame['kind'] == kind) frame,
  ];
}

/// Saves [broker] as the active server, launches the App and opens session
/// [id] from the roster (its project is expanded first).
Future<AppDriver> openSession(
  FeatureContext f,
  FakeBroker broker, {
  String id = 's1',
  String cwd = '/work/studio',
}) async {
  await f.storage.seedServer(broker);
  final app = await f.launch();
  await app.openFromRoster(id, cwd: cwd);
  return app;
}
