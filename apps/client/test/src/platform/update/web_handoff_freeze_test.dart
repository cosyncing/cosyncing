import 'package:cosyncing_client/src/platform/update/web_handoff_freeze.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final registry = WebHandoffParticipants.instance;

  setUp(registry.reset);
  tearDown(() {
    WebHandoffParticipants.readinessHook = null;
    registry.reset();
  });

  const fieldKey = Key('freeze-field');
  const openEditorKey = Key('freeze-open-editor');

  // Mounted the way App mounts it: in the MaterialApp builder, above the
  // Navigator, so dialogs and overlays freeze with everything else.
  Widget subject(TextEditingController controller) {
    return MaterialApp(
      builder: (context, child) => WebHandoffFreeze(child: child!),
      home: Scaffold(
        body: Column(
          children: [
            TextField(key: fieldKey, controller: controller),
            Builder(
              builder: (context) => ElevatedButton(
                key: openEditorKey,
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (_) => const AlertDialog(content: Text('editor')),
                ),
                child: const Text('open'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  group('WebHandoffFreeze', () {
    // Central review round 3: the commit verified this field EMPTY, and the
    // tab then waits several seconds for `go`. The verification is a
    // snapshot; this widget is the lock. A keystroke that cannot land is a
    // keystroke that cannot be lost with the document.
    testWidgets('the commit window refuses typing and new editors', (
      tester,
    ) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      registry.holdWhile(() => controller.text.isNotEmpty);
      await tester.pumpWidget(subject(controller));

      // Interactive before the window: the field takes focus and a keyboard
      // attaches to it.
      await tester.tap(find.byKey(fieldKey));
      await tester.pump();
      expect(tester.testTextInput.hasAnyClients, isTrue);

      // The freeze lands synchronously, inside commit()'s own turn.
      final pending = registry.commit();
      expect(registry.frozen.value, isTrue);
      await tester.pump();

      // The already-focused field loses its keyboard: pointer absorption
      // alone cannot silence hardware keys aimed at an existing focus.
      expect(
        tester.testTextInput.hasAnyClients,
        isFalse,
        reason: 'a focused field must not keep typing through the window',
      );

      // A tap cannot refocus it,
      await tester.tap(find.byKey(fieldKey), warnIfMissed: false);
      await tester.pump();
      expect(tester.testTextInput.hasAnyClients, isFalse);
      expect(controller.text, isEmpty);

      // and an editor that was never in the commit snapshot cannot even be
      // opened, so it cannot acquire losable state before `go`.
      await tester.tap(find.byKey(openEditorKey), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);

      expect(await pending, isTrue, reason: 'the empty field committed');
      expect(
        registry.frozen.value,
        isTrue,
        reason: 'the lock holds until go or release, not until the flush',
      );
    });

    // Central review round 4: the declarative freeze applies on the NEXT
    // frame, and a keystroke can be delivered before it. The revocation must
    // hold with NO frame between the commit and the input attempt — that is
    // what "synchronous" means here. The field is focused with an OPEN input
    // connection first, and the keystroke is injected raw, because a probe
    // that pumps on its way in would hand the declarative layer the very
    // frame this regression exists to deny it.
    testWidgets('a keystroke cannot beat the first frozen frame', (
      tester,
    ) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      registry.holdWhile(() => controller.text.isNotEmpty);
      await tester.pumpWidget(subject(controller));

      await tester.tap(find.byKey(fieldKey));
      await tester.pump();
      expect(tester.testTextInput.hasAnyClients, isTrue);

      final pending = registry.commit();
      expect(registry.frozen.value, isTrue);

      // No pump from here on — only microtasks, never a frame. ExcludeFocus
      // and AbsorbPointer have not been rebuilt; the imperative revocation
      // inside commit()'s own turn is the only thing in force.
      tester.testTextInput.enterText('must not land');
      await tester.idle();
      expect(
        controller.text,
        isEmpty,
        reason:
            'input delivered before the first frozen frame must be '
            'refused, or it dies with the document',
      );

      expect(await pending, isTrue);
      registry.releaseAll();
      await tester.pump();

      await tester.tap(find.byKey(fieldKey));
      await tester.pump();
      await tester.enterText(find.byKey(fieldKey), 'lands after release');
      expect(controller.text, 'lands after release');
    });

    testWidgets('an abandoned round hands the whole surface back', (
      tester,
    ) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      registry.holdWhile(() => controller.text.isNotEmpty);
      await tester.pumpWidget(subject(controller));

      expect(await registry.commit(), isTrue);
      await tester.pump();
      registry.releaseAll();
      await tester.pump();

      await tester.enterText(find.byKey(fieldKey), 'typed after the abort');
      expect(controller.text, 'typed after the abort');
      expect(
        await registry.prepare(),
        isFalse,
        reason: 'and that content defers the next round, as ever',
      );

      await tester.tap(find.byKey(openEditorKey));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
    });
  });
}
