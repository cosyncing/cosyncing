import 'package:cosyncing_client/src/platform/update/web_handoff_hold.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// The ordinary shape: a page whose fields nothing persists.
class _Host extends StatefulWidget {
  const _Host({required this.controllers});

  final List<TextEditingController> controllers;

  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> with WebHandoffHold<_Host> {
  @override
  List<TextEditingController> get webHandoffControllers => widget.controllers;

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

/// A surface whose losable state is not only text — a picked option, or a
/// field that only counts while it is open.
class _SelectionHost extends StatefulWidget {
  const _SelectionHost({required this.controller, required this.selected});

  final TextEditingController controller;
  final ValueNotifier<bool> selected;

  @override
  State<_SelectionHost> createState() => _SelectionHostState();
}

class _SelectionHostState extends State<_SelectionHost>
    with WebHandoffHold<_SelectionHost> {
  @override
  List<TextEditingController> get webHandoffControllers => [widget.controller];

  @override
  bool webHandoffHasContent() =>
      widget.selected.value || super.webHandoffHasContent();

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

void main() {
  final registry = WebHandoffParticipants.instance;

  setUp(() {
    WebHandoffParticipants.readinessHook = null;
    registry.reset();
  });

  tearDown(() {
    WebHandoffParticipants.readinessHook = null;
    registry.reset();
  });

  group('WebHandoffHold', () {
    testWidgets('an empty field holds nothing and a filled one defers', (
      tester,
    ) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(_Host(controllers: [controller]));

      expect(registry.participantCount, 1, reason: 'the surface registered');
      expect(
        await registry.prepare(),
        isTrue,
        reason: 'an empty field has nothing a handoff could discard',
      );

      controller.text = 'a token nobody saved';
      expect(await registry.prepare(), isFalse);
      expect(await registry.commit(), isFalse);
      expect(registry.lockedCount, 0, reason: 'a refusal freezes nothing');
    });

    // Without this a tab that deferred because of this field would keep
    // deferring on the retry cadence — up to a quarter of an hour on the slow
    // tier — after the user already cleared it.
    testWidgets('clearing the last field announces readiness', (tester) async {
      var hints = 0;
      WebHandoffParticipants.readinessHook = () => hints++;
      final first = TextEditingController();
      final second = TextEditingController();
      addTearDown(first.dispose);
      addTearDown(second.dispose);
      await tester.pumpWidget(_Host(controllers: [first, second]));

      first.text = 'half a broker url';
      second.text = 'and a token';
      expect(hints, 0, reason: 'filling a field is not a readiness change');

      first.clear();
      expect(
        hints,
        0,
        reason: 'the other field still holds something',
      );

      second.clear();
      expect(hints, 1, reason: 'the surface became free');
      expect(await registry.prepare(), isTrue);
    });

    testWidgets('unmounting removes the hold and reports readiness', (
      tester,
    ) async {
      var hints = 0;
      WebHandoffParticipants.readinessHook = () => hints++;
      final controller = TextEditingController(text: 'unsent');
      addTearDown(controller.dispose);
      await tester.pumpWidget(_Host(controllers: [controller]));
      expect(await registry.prepare(), isFalse);

      await tester.pumpWidget(const SizedBox.shrink());
      expect(registry.participantCount, 0);
      expect(
        hints,
        1,
        reason: 'a closed editor is the common way to become free',
      );
      expect(await registry.prepare(), isTrue);
    });

    testWidgets('a set of controllers that changes is re-watched', (
      tester,
    ) async {
      var hints = 0;
      WebHandoffParticipants.readinessHook = () => hints++;
      final first = TextEditingController();
      final second = TextEditingController();
      addTearDown(first.dispose);
      addTearDown(second.dispose);
      await tester.pumpWidget(_Host(controllers: [first]));

      // A question card re-paired onto a different request grows its answer
      // slots; a controller nobody watches is a field nobody defers for.
      await tester.pumpWidget(_Host(controllers: [first, second]));
      tester.state<_HostState>(find.byType(_Host)).refreshWebHandoffHold();

      second.text = 'an answer the agent is waiting on';
      expect(await registry.prepare(), isFalse);

      hints = 0;
      second.clear();
      expect(hints, 1, reason: 'the new controller reports readiness too');
    });

    testWidgets('non-text state can defer as well', (tester) async {
      final controller = TextEditingController();
      final selected = ValueNotifier<bool>(true);
      addTearDown(controller.dispose);
      addTearDown(selected.dispose);
      await tester.pumpWidget(
        _SelectionHost(controller: controller, selected: selected),
      );

      expect(
        await registry.prepare(),
        isFalse,
        reason: 'a picked option is as unrecoverable as typed text',
      );

      selected.value = false;
      expect(await registry.prepare(), isTrue);
    });
  });
}
