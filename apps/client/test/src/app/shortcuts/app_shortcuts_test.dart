import 'package:cosyncing_client/src/app/shortcuts/app_shortcuts.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Mounts a text field beside a shortcut host so a test can put focus inside
/// or outside an editable and watch the guards react.
///
/// [fired] collects shortcut ids, so an assertion reads as "which commands did
/// this keystroke run".
Widget _harness({
  required List<String> fired,
  required FocusNode fieldFocus,
  bool? webReserved,
}) {
  return MaterialApp(
    home: CallbackShortcuts(
      bindings: {
        ...appShortcutBindings(
          specs: appShortcutsForScope(AppShortcutScope.workspace),
          handlers: {
            AppShortcutId.closeSession: () => fired.add('close'),
            AppShortcutId.newSession: () => fired.add('new'),
            AppShortcutId.nextSession: () => fired.add('next'),
            AppShortcutId.previousSession: () => fired.add('previous'),
            AppShortcutId.jumpToLastSession: () => fired.add('last'),
          },
          webReserved: webReserved,
        ),
        ...appShortcutOrdinalBindings(
          kSessionOrdinalActivators,
          (index) => fired.add('ordinal:$index'),
        ),
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          body: TextField(focusNode: fieldFocus),
        ),
      ),
    ),
  );
}

Future<void> _press(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  List<LogicalKeyboardKey> modifiers = const [],
}) async {
  for (final modifier in modifiers) {
    await tester.sendKeyDownEvent(modifier);
  }
  await tester.sendKeyDownEvent(key);
  await tester.sendKeyUpEvent(key);
  for (final modifier in modifiers.reversed) {
    await tester.sendKeyUpEvent(modifier);
  }
  await tester.pump();
}

void main() {
  group('app shortcut registry', () {
    test('every id appears exactly once', () {
      final ids = kAppShortcuts.map((spec) => spec.id).toList();
      expect(ids.toSet(), hasLength(ids.length));
    });

    test('navigation and text size are native-only, and say so', () {
      for (final spec in kAppShortcuts) {
        if (spec.group != AppShortcutGroup.navigation &&
            spec.group != AppShortcutGroup.textSize) {
          continue;
        }
        // On web the browser takes Ctrl/Cmd+digit and the whole zoom triad
        // before the page sees them, so neither family may claim a web chord.
        expect(spec.webChord, isNull, reason: '${spec.id} claims a web chord');
        expect(spec.webSafeActivators, isEmpty);
        expect(spec.bareActivators, isEmpty);
      }
    });

    test('no bare activator carries a modifier', () {
      for (final spec in kAppShortcuts) {
        for (final activator in spec.bareActivators) {
          expect(activator.control, isFalse);
          expect(activator.meta, isFalse);
          expect(activator.alt, isFalse);
          expect(activator.shift, isFalse);
        }
      }
    });

    test('no digit ever carries Ctrl+Alt', () {
      // AltGr is Ctrl+Alt on Windows and European Linux layouts, and it lives
      // on the digit row of German, AZERTY, Spanish and Nordic keyboards.
      final digits = <LogicalKeyboardKey>{
        LogicalKeyboardKey.digit0,
        LogicalKeyboardKey.digit1,
        LogicalKeyboardKey.digit2,
        LogicalKeyboardKey.digit3,
        LogicalKeyboardKey.digit4,
        LogicalKeyboardKey.digit5,
        LogicalKeyboardKey.digit6,
        LogicalKeyboardKey.digit7,
        LogicalKeyboardKey.digit8,
        LogicalKeyboardKey.digit9,
      };
      for (final spec in kAppShortcuts) {
        for (final activator in spec.webSafeActivators) {
          expect(digits.contains(activator.trigger), isFalse);
        }
      }
    });

    test('the ordinals are eight bare digits, and 9 is not one of them', () {
      expect(kSessionOrdinalActivators, hasLength(8));
      expect(
        kSessionOrdinalActivators.map((activator) => activator.trigger),
        isNot(contains(LogicalKeyboardKey.digit9)),
      );
    });
  });

  group('bare-key focus guard', () {
    testWidgets('bare digits fire when no text field holds focus', (
      tester,
    ) async {
      final fired = <String>[];
      final fieldFocus = FocusNode();
      addTearDown(fieldFocus.dispose);
      await tester.pumpWidget(_harness(fired: fired, fieldFocus: fieldFocus));
      await tester.pump();

      await _press(tester, LogicalKeyboardKey.digit2);
      await _press(tester, LogicalKeyboardKey.digit9);
      await _press(tester, LogicalKeyboardKey.bracketRight);
      await _press(tester, LogicalKeyboardKey.bracketLeft);

      expect(fired, ['ordinal:1', 'last', 'next', 'previous']);
    });

    // The regression that would make the whole bare layer unusable: typing a
    // digit or a bracket into the composer must insert text, not switch tabs.
    testWidgets('bare keys are inert while a text field holds focus', (
      tester,
    ) async {
      final fired = <String>[];
      final fieldFocus = FocusNode();
      addTearDown(fieldFocus.dispose);
      await tester.pumpWidget(_harness(fired: fired, fieldFocus: fieldFocus));
      fieldFocus.requestFocus();
      await tester.pump();

      await tester.enterText(find.byType(TextField), '2]9[');
      await _press(tester, LogicalKeyboardKey.digit2);
      await _press(tester, LogicalKeyboardKey.bracketRight);

      expect(fired, isEmpty);
      expect(find.text('2]9['), findsOneWidget);
    });

    testWidgets('an active IME composition suppresses bare keys', (
      tester,
    ) async {
      final fired = <String>[];
      final fieldFocus = FocusNode();
      addTearDown(fieldFocus.dispose);
      await tester.pumpWidget(_harness(fired: fired, fieldFocus: fieldFocus));
      fieldFocus.requestFocus();
      await tester.pump();

      tester
          .state<EditableTextState>(find.byType(EditableText))
          .updateEditingValue(
            const TextEditingValue(
              text: 'ni',
              selection: TextSelection.collapsed(offset: 2),
              composing: TextRange(start: 0, end: 2),
            ),
          );
      await tester.pump();

      expect(appShortcutCompositionActive(), isTrue);
      await _press(tester, LogicalKeyboardKey.digit2);
      expect(fired, isEmpty);
    });
  });

  group('AltGr guard', () {
    testWidgets('Linux suppresses Ctrl+Alt chords inside a text field', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final fired = <String>[];
      final fieldFocus = FocusNode();
      addTearDown(fieldFocus.dispose);
      await tester.pumpWidget(_harness(fired: fired, fieldFocus: fieldFocus));
      fieldFocus.requestFocus();
      await tester.pump();

      // AltGr+W and AltGr+N are real characters on European layouts.
      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [
          LogicalKeyboardKey.controlLeft,
          LogicalKeyboardKey.altLeft,
        ],
      );
      await _press(
        tester,
        LogicalKeyboardKey.keyN,
        modifiers: const [
          LogicalKeyboardKey.controlLeft,
          LogicalKeyboardKey.altLeft,
        ],
      );

      expect(fired, isEmpty);
      debugDefaultTargetPlatformOverride = null;
    });

    testWidgets('Linux fires Ctrl+Alt chords outside a text field', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final fired = <String>[];
      final fieldFocus = FocusNode();
      addTearDown(fieldFocus.dispose);
      await tester.pumpWidget(_harness(fired: fired, fieldFocus: fieldFocus));
      await tester.pump();

      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [
          LogicalKeyboardKey.controlLeft,
          LogicalKeyboardKey.altLeft,
        ],
      );

      expect(fired, ['close']);
      debugDefaultTargetPlatformOverride = null;
    });

    // Cmd+Opt inserts nothing on macOS, so the guard there would only remove
    // function.
    testWidgets('macOS fires Cmd+Alt chords even inside a text field', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final fired = <String>[];
      final fieldFocus = FocusNode();
      addTearDown(fieldFocus.dispose);
      await tester.pumpWidget(_harness(fired: fired, fieldFocus: fieldFocus));
      fieldFocus.requestFocus();
      await tester.pump();

      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [
          LogicalKeyboardKey.metaLeft,
          LogicalKeyboardKey.altLeft,
        ],
      );

      expect(fired, ['close']);
      debugDefaultTargetPlatformOverride = null;
    });
  });

  group('surface split', () {
    testWidgets('native binds the plain form and the +Alt form', (
      tester,
    ) async {
      final fired = <String>[];
      final fieldFocus = FocusNode();
      addTearDown(fieldFocus.dispose);
      await tester.pumpWidget(
        _harness(fired: fired, fieldFocus: fieldFocus, webReserved: false),
      );
      await tester.pump();

      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [LogicalKeyboardKey.controlLeft],
      );
      await _press(
        tester,
        LogicalKeyboardKey.keyT,
        modifiers: const [LogicalKeyboardKey.controlLeft],
      );
      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [
          LogicalKeyboardKey.controlLeft,
          LogicalKeyboardKey.altLeft,
        ],
      );

      expect(fired, ['close', 'new', 'close']);
    });

    testWidgets('web binds only the +Alt form and the bare keys', (
      tester,
    ) async {
      final fired = <String>[];
      final fieldFocus = FocusNode();
      addTearDown(fieldFocus.dispose);
      await tester.pumpWidget(
        _harness(fired: fired, fieldFocus: fieldFocus, webReserved: true),
      );
      await tester.pump();

      // The browser takes these before Flutter sees them, so binding them
      // would advertise commands that never run.
      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [LogicalKeyboardKey.controlLeft],
      );
      await _press(
        tester,
        LogicalKeyboardKey.keyT,
        modifiers: const [LogicalKeyboardKey.controlLeft],
      );
      await _press(
        tester,
        LogicalKeyboardKey.tab,
        modifiers: const [LogicalKeyboardKey.controlLeft],
      );
      expect(fired, isEmpty);

      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [
          LogicalKeyboardKey.controlLeft,
          LogicalKeyboardKey.altLeft,
        ],
      );
      await _press(
        tester,
        LogicalKeyboardKey.keyN,
        modifiers: const [
          LogicalKeyboardKey.controlLeft,
          LogicalKeyboardKey.altLeft,
        ],
      );
      await _press(tester, LogicalKeyboardKey.digit3);

      expect(fired, ['close', 'new', 'ordinal:2']);
    });
  });
}
