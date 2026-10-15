// Composer verbs for feature tests (F04): what the user types, presses and
// reads in the composer of the open session.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'app_driver.dart';
import 'composer_wire.dart';
import 'cosyncing_app.dart';
import 'fake_broker.dart';
import 'roster_driver.dart';

/// The composer's text field.
final Finder promptField = find.byKey(const Key('session-detail-prompt-input'));

/// The Send button.
final Finder sendButton = find.byKey(const Key('session-detail-send-button'));

/// A saved server with session `s1` and its [ComposerDesk], opened in the App.
Future<(AppDriver, FakeBroker, ComposerDesk)> openComposer(
  FeatureContext f, {
  void Function(FakeBroker broker, ComposerDesk desk)? setup,
  FeatureViewport viewport = FeatureViewport.desktop,
  String tool = 'codex',
}) async {
  final studio = f.network.add('http://studio.test:7734')
    ..addSession('s1', 'Fix login', tool: tool);
  final desk = ComposerDesk(studio, tool: tool);
  setup?.call(studio, desk);
  await f.storage.seedServer(studio);
  final app = await f.launch(viewport: viewport);
  await app.openFromRoster('s1', tool: tool, cwd: '/work/studio');
  return (app, studio, desk);
}

/// Composer verbs over a running App.
extension ComposerDriver on AppDriver {
  /// What the composer holds.
  String get composerText => tester
      .widget<EditableText>(
        find.descendant(of: promptField, matching: find.byType(EditableText)),
      )
      .controller
      .text;

  /// Whether Send can be pressed.
  bool get canSend => tester.widget<IconButton>(sendButton).onPressed != null;

  /// Types [text] without pressing Send.
  Future<void> type(String text) => enterText(promptField, text);

  /// Presses Send.
  Future<void> pressSend() => tap(sendButton);

  /// The app goes to the background the way the OS reports it
  /// (inactive, hidden, paused).
  Future<void> background() async {
    for (final state in const [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await settle();
  }

  /// The app returns to the foreground (hidden, inactive, resumed).
  Future<void> foreground() async {
    for (final state in const [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await settle();
  }

  /// Advances fake time by exactly [duration] and nothing more (unlike
  /// [elapse], which also settles, i.e. keeps advancing while frames are
  /// scheduled): for asserting what has or has not happened inside a
  /// debounce window.
  Future<void> tick(Duration duration) async {
    await tester.pump(duration);
    await flushRealAsync();
    await tester.pump();
  }

  /// Focuses the composer.
  Future<void> focusComposer() async {
    await tester.tap(promptField);
    await settle();
  }

  /// Presses [key] with [modifiers] held.
  Future<void> chord(
    LogicalKeyboardKey key, {
    List<LogicalKeyboardKey> modifiers = const [],
  }) async {
    for (final modifier in modifiers) {
      await tester.sendKeyDownEvent(modifier);
    }
    await tester.sendKeyEvent(key);
    for (final modifier in modifiers.reversed) {
      await tester.sendKeyUpEvent(modifier);
    }
    await settle();
  }

  /// How many times [text] is on screen as a whole text run.
  int bubbles(String text) => [
    for (final element in find.byType(RichText).evaluate())
      if ((element.widget as RichText).text.toPlainText() == text) element,
  ].length;
}

/// What the device holds durably for the composer of a session: the stored
/// draft rows, by session id.
Future<Map<String, ({String text, bool dirty})>> durableDrafts(
  FeatureContext f,
) async {
  final rows = await f.storage.database
      .select(f.storage.database.sessionDraftRows)
      .get();
  return {
    for (final row in rows)
      row.sessionId: (text: row.draftText, dirty: row.dirty),
  };
}
