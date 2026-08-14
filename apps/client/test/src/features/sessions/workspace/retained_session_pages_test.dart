import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/view/visible_attention_session_scope.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/retained_session_pages.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_controller.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:cosyncing_client/src/features/voice/data/read_aloud_preferences_store.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_read_aloud_preferences_store.dart';

void main() {
  testWidgets(
    'cached switches paint in one frame and preserve page-local state',
    (tester) async {
      final ledger = _PageLedger();
      final config = ValueNotifier(
        _HostConfig(
          source: _sourceA,
          open: _open([_a], active: _a.key),
        ),
      );
      addTearDown(config.dispose);
      final container = _container();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        _subject(
          container,
          config,
          (context, session) => _ProbePage(session: session, ledger: ledger),
        ),
      );
      await tester.pump();

      await tester.enterText(
        find.byKey(const Key('probe-input-codex/a')),
        'draft',
      );
      final aState = ledger.states[_a.key]!;
      aState.controller.selection = const TextSelection(
        baseOffset: 1,
        extentOffset: 4,
      );
      await tester.tap(find.byKey(const Key('probe-expand-codex/a')));
      await tester.drag(
        find.byKey(const Key('probe-scroll-codex/a')),
        const Offset(0, -600),
      );
      await tester.pump();
      final scrollOffset = aState.scrollController.offset;
      expect(aState.focusNode.hasFocus, isTrue);

      config.value = _HostConfig(
        source: _sourceA,
        open: _open([_a, _b], active: _b.key),
      );
      await tester.pump();

      expect(
        find.text('PAGE codex/b').hitTestable(),
        findsOneWidget,
        reason: 'the destination paints on the first switched frame',
      );
      expect(ledger.mounts[_a.key], 1);
      expect(ledger.tickerEnabled[_a.key], isFalse);
      expect(ledger.tickerEnabled[_b.key], isTrue);
      expect(aState.focusNode.hasFocus, isFalse);

      config.value = _HostConfig(
        source: _sourceA,
        open: _open([_a, _b], active: _a.key),
      );
      await tester.pump();

      expect(find.text('PAGE codex/a').hitTestable(), findsOneWidget);
      expect(ledger.mounts[_a.key], 1, reason: 'cached A never remounted');
      expect(identical(ledger.states[_a.key], aState), isTrue);
      expect(aState.controller.text, 'draft');
      expect(
        aState.controller.selection,
        const TextSelection(baseOffset: 1, extentOffset: 4),
      );
      expect(aState.expanded, isTrue);
      expect(aState.scrollController.offset, scrollOffset);
    },
  );

  testWidgets('active plus four uses deterministic LRU eviction and close', (
    tester,
  ) async {
    final ledger = _PageLedger();
    final config = ValueNotifier(
      _HostConfig(
        source: _sourceA,
        open: _open([_refs[0]], active: _refs[0].key),
      ),
    );
    addTearDown(config.dispose);
    final container = _container();
    addTearDown(container.dispose);
    await tester.pumpWidget(
      _subject(
        container,
        config,
        (context, session) => _ProbePage(session: session, ledger: ledger),
      ),
    );

    for (var index = 1; index < _refs.length; index++) {
      config.value = _HostConfig(
        source: _sourceA,
        open: _open(_refs.sublist(0, index + 1), active: _refs[index].key),
      );
      await tester.pump();
    }

    expect(ledger.aliveKeys, {
      _refs[1].key,
      _refs[2].key,
      _refs[3].key,
      _refs[4].key,
      _refs[5].key,
    });
    expect(ledger.disposals[_refs[0].key], 1);
    expect(ledger.aliveKeys, hasLength(retainedSessionPageBudget));

    // Closing a retained inactive tab disposes its page once.
    config.value = _HostConfig(
      source: _sourceA,
      open: _open(
        [_refs[0], _refs[1], _refs[2], _refs[4], _refs[5]],
        active: _refs[5].key,
      ),
    );
    await tester.pump();
    expect(ledger.disposals[_refs[3].key], 1);

    // Closing an already-evicted member does not dispose anything twice.
    config.value = _HostConfig(
      source: _sourceA,
      open: _open(
        [_refs[1], _refs[2], _refs[4], _refs[5]],
        active: _refs[5].key,
      ),
    );
    await tester.pump();
    expect(ledger.disposals[_refs[0].key], 1);

    // Returning to the evicted page is a cold UI remount and evicts the least
    // recent retained page, while open membership remains independent.
    config.value = _HostConfig(
      source: _sourceA,
      open: _open(
        [_refs[0], _refs[1], _refs[2], _refs[4], _refs[5]],
        active: _refs[0].key,
      ),
    );
    await tester.pump();
    expect(ledger.mounts[_refs[0].key], 2);
    expect(ledger.aliveKeys, hasLength(retainedSessionPageBudget));
  });

  testWidgets('broker source replacement cannot reuse an equal session key', (
    tester,
  ) async {
    final ledger = _PageLedger();
    final config = ValueNotifier(
      _HostConfig(
        source: _sourceA,
        open: _open([_a], active: _a.key),
      ),
    );
    addTearDown(config.dispose);
    final container = _container();
    addTearDown(container.dispose);
    await tester.pumpWidget(
      _subject(
        container,
        config,
        (context, session) => _ProbePage(session: session, ledger: ledger),
      ),
    );
    await tester.pump();
    final firstState = ledger.states[_a.key];

    config.value = _HostConfig(
      source: _sourceB,
      open: _open([_a], active: _a.key),
    );
    await tester.pump();

    expect(ledger.mounts[_a.key], 2);
    expect(ledger.disposals[_a.key], 1);
    expect(identical(ledger.states[_a.key], firstState), isFalse);
  });

  testWidgets('only the onstage retained page publishes Attention truth', (
    tester,
  ) async {
    final config = ValueNotifier(
      _HostConfig(
        source: _sourceA,
        open: _open([_a], active: _a.key),
      ),
    );
    addTearDown(config.dispose);
    final container = _container();
    addTearDown(container.dispose);
    await tester.pumpWidget(
      _subject(
        container,
        config,
        (context, session) => VisibleAttentionSessionScope(
          tool: session.tool,
          sessionId: session.id,
          child: Text('ATTENTION ${session.key}'),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(container.read(visibleAttentionSessionProvider)?.sessionId, 'a');

    config.value = _HostConfig(
      source: _sourceA,
      open: _open([_a, _b], active: _b.key),
    );
    await tester.pump();
    await tester.pump();

    final visible = container.read(visibleAttentionSessionProvider);
    expect(visible?.sessionId, 'b');
    expect(visible?.isStillVisible(), isTrue);

    config.value = _HostConfig(
      source: _sourceA,
      open: _open([_a, _b], active: _b.key),
      branchVisible: false,
    );
    await tester.pump();
    await tester.pump();
    expect(
      container.read(visibleAttentionSessionProvider),
      isNull,
      reason: 'an offstage navigation branch owns no visible session',
    );
  });

  testWidgets('tab switches stop TTS and discard active microphone input', (
    tester,
  ) async {
    final output = _RecordingSpeechOutput();
    final input = _RecordingSpeechInput();
    addTearDown(output.close);
    addTearDown(input.close);
    final container = _container(
      extraOverrides: [
        speechOutputFactoryProvider.overrideWithValue(() => output),
        speechInputFactoryProvider.overrideWithValue(() => input),
        readAloudPreferencesStoreProvider.overrideWithValue(
          InMemoryReadAloudPreferencesStore(),
        ),
      ],
    );
    addTearDown(container.dispose);
    final config = ValueNotifier(
      _HostConfig(
        source: _sourceA,
        open: _open([_a], active: _a.key),
      ),
    );
    addTearDown(config.dispose);
    await tester.pumpWidget(
      _subject(
        container,
        config,
        (context, session) => _VoiceOwner(session.key),
      ),
    );
    await tester.pump();
    expect(output.stopCalls, 0);
    expect(input.cancelCalls, 0);

    config.value = _HostConfig(
      source: _sourceA,
      open: _open([_a, _b], active: _b.key),
    );
    await tester.pump();

    expect(output.stopCalls, 1);
    expect(input.cancelCalls, 1);
  });

  testWidgets('ordinary and large retained payloads stay inside the budget', (
    tester,
  ) async {
    for (final payloadRows in const [40, 4000]) {
      final ledger = _PageLedger(payloadRows: payloadRows);
      final config = ValueNotifier(
        _HostConfig(
          source: _sourceA,
          open: _open([_refs[0]], active: _refs[0].key),
        ),
      );
      final container = _container();
      await tester.pumpWidget(
        _subject(
          container,
          config,
          (context, session) => _ProbePage(session: session, ledger: ledger),
        ),
      );
      for (var index = 1; index < _refs.length; index++) {
        config.value = _HostConfig(
          source: _sourceA,
          open: _open(_refs.sublist(0, index + 1), active: _refs[index].key),
        );
        await tester.pump();
      }
      final stopwatch = Stopwatch()..start();
      for (var index = 0; index < 20; index++) {
        final active = _refs[index.isEven ? 4 : 5];
        config.value = _HostConfig(
          source: _sourceA,
          open: _open(_refs, active: active.key),
        );
        await tester.pump();
      }
      stopwatch.stop();

      expect(ledger.aliveKeys, hasLength(retainedSessionPageBudget));
      expect(
        ledger.livePayloadRows,
        retainedSessionPageBudget * payloadRows,
      );
      debugPrint(
        'retained-cache payloadRows=$payloadRows switches=20 '
        'elapsedUs=${stopwatch.elapsedMicroseconds} '
        'livePages=${ledger.aliveKeys.length} '
        'livePayloadRows=${ledger.livePayloadRows}',
      );
      await tester.pumpWidget(const SizedBox.shrink());
      config.dispose();
      container.dispose();
      await tester.pump();
    }
  });
}

Widget _subject(
  ProviderContainer container,
  ValueNotifier<_HostConfig> config,
  RetainedSessionPageBuilder builder,
) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    home: ValueListenableBuilder<_HostConfig>(
      valueListenable: config,
      builder: (context, value, _) => Scaffold(
        body: TickerMode(
          enabled: value.branchVisible,
          child: RetainedSessionPages(
            source: value.source,
            open: value.open,
            builder: builder,
          ),
        ),
      ),
    ),
  ),
);

ProviderContainer _container({List<Override> extraOverrides = const []}) =>
    ProviderContainer(
      overrides: [
        activeBrokerProfileProvider.overrideWith(
          (ref) => BrokerProfile(
            id: 'profile-a',
            displayName: 'A',
            baseUri: Uri.parse('http://a.test'),
            createdAt: DateTime(2026),
          ),
        ),
        ...extraOverrides,
      ],
    );

OpenSessionsState _open(List<SessionRef> refs, {required String active}) =>
    OpenSessionsState(refs: refs, activeKey: active);

const _a = SessionRef(
  tool: 'codex',
  id: 'a',
  title: 'A',
  status: SessionStatus.idle,
);
const _b = SessionRef(
  tool: 'codex',
  id: 'b',
  title: 'B',
  status: SessionStatus.idle,
);
const _refs = <SessionRef>[
  SessionRef(tool: 'codex', id: '1', title: '1', status: SessionStatus.idle),
  SessionRef(tool: 'codex', id: '2', title: '2', status: SessionStatus.idle),
  SessionRef(tool: 'codex', id: '3', title: '3', status: SessionStatus.idle),
  SessionRef(tool: 'codex', id: '4', title: '4', status: SessionStatus.idle),
  SessionRef(tool: 'codex', id: '5', title: '5', status: SessionStatus.idle),
  SessionRef(tool: 'codex', id: '6', title: '6', status: SessionStatus.idle),
];
const _sourceA = RosterSource(profileId: 'p', endpoint: 'http://a.test');
const _sourceB = RosterSource(profileId: 'p', endpoint: 'http://b.test');

final class _HostConfig {
  const _HostConfig({
    required this.source,
    required this.open,
    this.branchVisible = true,
  });

  final RosterSource source;
  final OpenSessionsState open;
  final bool branchVisible;
}

final class _PageLedger {
  _PageLedger({this.payloadRows = 0});

  final int payloadRows;
  final Map<String, int> mounts = {};
  final Map<String, int> disposals = {};
  final Map<String, bool> tickerEnabled = {};
  final Map<String, _ProbePageState> states = {};

  Set<String> get aliveKeys => states.keys.toSet();
  int get livePayloadRows => states.length * payloadRows;
}

final class _ProbePage extends StatefulWidget {
  const _ProbePage({required this.session, required this.ledger});

  final SessionRef session;
  final _PageLedger ledger;

  @override
  State<_ProbePage> createState() => _ProbePageState();
}

final class _ProbePageState extends State<_ProbePage> {
  late final TextEditingController controller;
  late final FocusNode focusNode;
  late final ScrollController scrollController;
  late final List<String> payload;
  bool expanded = false;

  @override
  void initState() {
    super.initState();
    controller = TextEditingController();
    focusNode = FocusNode();
    scrollController = ScrollController();
    payload = List<String>.generate(
      widget.ledger.payloadRows,
      (index) => '${widget.session.key}:$index:retained-payload',
      growable: false,
    );
    widget.ledger
      ..mounts.update(
        widget.session.key,
        (value) => value + 1,
        ifAbsent: () => 1,
      )
      ..states[widget.session.key] = this;
  }

  @override
  void dispose() {
    widget.ledger.disposals.update(
      widget.session.key,
      (value) => value + 1,
      ifAbsent: () => 1,
    );
    if (identical(widget.ledger.states[widget.session.key], this)) {
      widget.ledger.states.remove(widget.session.key);
    }
    controller.dispose();
    focusNode.dispose();
    scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    widget.ledger.tickerEnabled[widget.session.key] = TickerMode.valuesOf(
      context,
    ).enabled;
    return Column(
      children: [
        Text('PAGE ${widget.session.key}'),
        TextField(
          key: Key('probe-input-${widget.session.key}'),
          controller: controller,
          focusNode: focusNode,
        ),
        TextButton(
          key: Key('probe-expand-${widget.session.key}'),
          onPressed: () => setState(() => expanded = !expanded),
          child: Text(expanded ? 'EXPANDED' : 'COLLAPSED'),
        ),
        Expanded(
          child: ListView.builder(
            key: Key('probe-scroll-${widget.session.key}'),
            controller: scrollController,
            itemCount: 100,
            itemBuilder: (context, index) => SizedBox(
              height: 32,
              child: Text('${widget.session.key} row $index'),
            ),
          ),
        ),
      ],
    );
  }
}

final class _VoiceOwner extends ConsumerWidget {
  const _VoiceOwner(this.label);

  final String label;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref
      ..watch(readAloudControllerProvider.notifier)
      ..watch(voiceInputControllerProvider.notifier);
    return Text(label);
  }
}

final class _RecordingSpeechOutput implements SpeechOutput {
  final _states = StreamController<SpeechOutputState>.broadcast();
  int stopCalls = 0;

  @override
  SpeechOutputCapabilities get capabilities => const SpeechOutputCapabilities(
    synthesis: true,
    pauseResume: false,
    installedLanguageVoiceAvailability: true,
  );

  @override
  SpeechOutputState get current => const SpeechOutputIdle();

  @override
  Stream<SpeechOutputState> get states => _states.stream;

  @override
  Future<void> dispose() async => _states.close();

  @override
  Future<void> pause() async {}

  @override
  Future<void> resume() async {}

  @override
  Future<void> setRate(double rate) async {}

  @override
  Future<void> speak({
    required String messageKey,
    required List<SpeechUtterance> utterances,
  }) async {}

  @override
  Future<void> stop() async {
    stopCalls++;
  }

  Future<void> close() async {
    if (!_states.isClosed) await _states.close();
  }
}

final class _RecordingSpeechInput implements SpeechInput {
  final _states = StreamController<SpeechInputState>.broadcast();
  int cancelCalls = 0;

  @override
  SpeechInputCapabilities get capabilities => const SpeechInputCapabilities(
    recognition: true,
    onDeviceRecognition: false,
    soundLevelEvents: false,
  );

  @override
  SpeechInputState get current => const SpeechInputIdle();

  @override
  Stream<SpeechInputState> get states => _states.stream;

  @override
  Future<void> cancel() async {
    cancelCalls++;
  }

  @override
  String? consumeReady() => null;

  @override
  Future<void> dispose() async => _states.close();

  @override
  Future<void> requestPermission() async {}

  @override
  Future<void> start({required SpeechRecognitionPolicy policy}) async {}

  @override
  Future<void> stop() async {}

  Future<void> close() async {
    if (!_states.isClosed) await _states.close();
  }
}
