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
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_focus.dart';
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
    expect(
      container.read(visibleAttentionSessionsProvider).single.sessionId,
      'a',
    );

    config.value = _HostConfig(
      source: _sourceA,
      open: _open([_a, _b], active: _b.key),
    );
    await tester.pump();
    await tester.pump();

    final visible = container.read(visibleAttentionSessionsProvider).single;
    expect(visible.sessionId, 'b');
    expect(visible.isStillVisible(), isTrue);

    config.value = _HostConfig(
      source: _sourceA,
      open: _open([_a, _b], active: _b.key),
      branchVisible: false,
    );
    await tester.pump();
    await tester.pump();
    expect(
      container.read(visibleAttentionSessionsProvider),
      isEmpty,
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
  group('focused pane versus visible set', () {
    testWidgets('a visible pane keeps ticking while another holds focus', (
      tester,
    ) async {
      final ledger = _PageLedger();
      final config = ValueNotifier(
        _HostConfig(
          source: _sourceA,
          open: _open([_a, _b], active: _a.key),
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

      expect(ledger.tickerEnabled[_a.key], isTrue);
      expect(ledger.tickerEnabled[_b.key], isNull, reason: 'B never painted');

      config.value = _HostConfig(
        source: _sourceA,
        open: _open([_a, _b], active: _a.key),
        visibleKeys: {_a.key, _b.key},
        focusedKey: _a.key,
      );
      await tester.pump();

      // The whole point of the split: B is on screen without holding focus,
      // so it is onstage and its animations run. Under the old single
      // `activeKey` it would have been frozen behind an Offstage.
      expect(ledger.tickerEnabled[_a.key], isTrue);
      expect(ledger.tickerEnabled[_b.key], isTrue);
      expect(_offstage(tester, _a.key), isFalse);
      expect(_offstage(tester, _b.key), isFalse);
      // Not hit-testability: this host stacks its retained pages, so the two
      // overlap here. Laying visible panes out side by side belongs to the
      // workspace split, not to the page host.
      expect(find.text('PAGE codex/b', skipOffstage: false), findsOneWidget);
    });

    testWidgets('a pane outside the visible set does not tick', (tester) async {
      final ledger = _PageLedger();
      final config = ValueNotifier(
        _HostConfig(
          source: _sourceA,
          open: _open([_a, _b], active: _a.key),
          visibleKeys: {_a.key, _b.key},
          focusedKey: _a.key,
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
      expect(ledger.tickerEnabled[_b.key], isTrue);

      config.value = _HostConfig(
        source: _sourceA,
        open: _open([_a, _b], active: _a.key),
        visibleKeys: {_a.key},
        focusedKey: _a.key,
      );
      await tester.pump();

      expect(ledger.tickerEnabled[_b.key], isFalse);
      expect(_offstage(tester, _b.key), isTrue);
      expect(find.text('PAGE codex/b').hitTestable(), findsNothing);
      expect(ledger.mounts[_b.key], 1, reason: 'retained, not remounted');
    });

    testWidgets('a second visible pane does not steal focus from the first', (
      tester,
    ) async {
      final ledger = _PageLedger();
      final config = ValueNotifier(
        _HostConfig(
          source: _sourceA,
          open: _open([_a, _b], active: _a.key),
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
      await tester.tap(find.byKey(const Key('probe-input-codex/a')));
      await tester.pump();
      final aState = ledger.states[_a.key]!;
      expect(aState.focusNode.hasFocus, isTrue);

      config.value = _HostConfig(
        source: _sourceA,
        open: _open([_a, _b], active: _a.key),
        visibleKeys: {_a.key, _b.key},
        focusedKey: _a.key,
      );
      await tester.pump();

      // Becoming visible is not becoming focused. A composer losing its caret
      // because a file pane appeared beside it is the failure this pins.
      expect(aState.focusNode.hasFocus, isTrue);
      expect(ledger.states[_b.key]!.focusNode.hasFocus, isFalse);
    });

    testWidgets('every visible pane publishes its Attention claim', (
      tester,
    ) async {
      final config = ValueNotifier(
        _HostConfig(
          source: _sourceA,
          open: _open([_a, _b], active: _a.key),
          visibleKeys: {_a.key, _b.key},
          focusedKey: _a.key,
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

      // Suppression keys on the visible set, not on focus: an unfocused pane
      // is still being read, so notifying for it is the duplicate the claim
      // exists to prevent.
      final claims = container.read(visibleAttentionSessionsProvider);
      expect(claims.map((claim) => claim.sessionId).toSet(), {'a', 'b'});
      expect(claims.every((claim) => claim.isStillVisible()), isTrue);

      config.value = _HostConfig(
        source: _sourceA,
        open: _open([_a, _b], active: _a.key),
        visibleKeys: {_a.key},
        focusedKey: _a.key,
      );
      await tester.pump();
      await tester.pump();

      expect(
        container.read(visibleAttentionSessionsProvider).single.sessionId,
        'a',
      );
    });

    testWidgets('the focused pane is published for media ownership', (
      tester,
    ) async {
      final config = ValueNotifier(
        _HostConfig(
          source: _sourceA,
          open: _open([_a, _b], active: _a.key),
          visibleKeys: {_a.key, _b.key},
          focusedKey: _a.key,
        ),
      );
      addTearDown(config.dispose);
      final container = _container();
      addTearDown(container.dispose);
      await tester.pumpWidget(
        _subject(container, config, (context, session) => Text(session.key)),
      );
      await tester.pump();
      expect(container.read(focusedPaneProvider), _a.key);

      config.value = _HostConfig(
        source: _sourceA,
        open: _open([_a, _b], active: _a.key),
        visibleKeys: {_a.key, _b.key},
        focusedKey: _b.key,
      );
      await tester.pump();
      await tester.pump();
      expect(container.read(focusedPaneProvider), _b.key);

      config.value = _HostConfig(
        source: _sourceA,
        open: _open([_a, _b], active: _a.key),
        visibleKeys: {_a.key, _b.key},
        focusedKey: _b.key,
        branchVisible: false,
      );
      await tester.pump();
      await tester.pump();
      expect(
        container.read(focusedPaneProvider),
        isNull,
        reason: 'an offstage branch focuses nothing',
      );
    });

    testWidgets('eviction never reaches a pane that is on screen', (
      tester,
    ) async {
      final ledger = _PageLedger();
      final config = ValueNotifier(
        _HostConfig(
          source: _sourceA,
          open: _open([_refs[0]], active: _refs[0].key),
          visibleKeys: {_refs[0].key},
          focusedKey: _refs[0].key,
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

      // Walk the focus across every tab while pinning ref 0 visible beside it.
      for (var index = 1; index < _refs.length; index++) {
        config.value = _HostConfig(
          source: _sourceA,
          open: _open(_refs.sublist(0, index + 1), active: _refs[index].key),
          visibleKeys: {_refs[0].key, _refs[index].key},
          focusedKey: _refs[index].key,
        );
        await tester.pump();
      }

      expect(ledger.aliveKeys, hasLength(retainedSessionPageBudget));
      expect(
        ledger.aliveKeys,
        contains(_refs[0].key),
        reason: 'the pinned second pane outlived the LRU window',
      );
      expect(ledger.tickerEnabled[_refs[0].key], isTrue);
    });

    testWidgets(
      'moving focus stops the pane being left, not the one arriving',
      (
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
            open: _open([_a, _b], active: _a.key),
            visibleKeys: {_a.key, _b.key},
            focusedKey: _a.key,
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

        // A becomes the owner as it takes focus; B arriving on screen beside it
        // changes nothing, because visibility is not focus.
        config.value = _HostConfig(
          source: _sourceA,
          open: _open([_a, _b], active: _a.key),
          visibleKeys: {_a.key, _b.key},
          focusedKey: _a.key,
        );
        await tester.pump();
        expect(output.stopCalls, 0);
        expect(input.cancelCalls, 0);

        config.value = _HostConfig(
          source: _sourceA,
          open: _open([_a, _b], active: _a.key),
          visibleKeys: {_a.key, _b.key},
          focusedKey: _b.key,
        );
        await tester.pump();

        expect(output.stopCalls, 1);
        expect(input.cancelCalls, 1);
        expect(
          container.read(readAloudControllerProvider.notifier).owningPane,
          _b.key,
          reason: 'whatever starts next belongs to the pane now in front',
        );
        expect(
          container.read(voiceInputControllerProvider.notifier).owningPane,
          _b.key,
        );
      },
    );
  });
}

/// Whether the retained slot for [pageKey] is offstage.
///
/// Read from the `Offstage` itself rather than inferred from hit-testing: the
/// host stacks its pages, so an onstage page can still sit under another.
bool _offstage(WidgetTester tester, String pageKey) => tester
    .widget<Offstage>(
      find.byKey(Key('retained-session-page-$pageKey'), skipOffstage: false),
    )
    .offstage;

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
            visibleKeys: value.visibleKeys,
            focusedKey: value.focusedKey,
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
    this.visibleKeys,
    this.focusedKey,
  });

  final RosterSource source;
  final OpenSessionsState open;
  final bool branchVisible;

  /// Null keeps the single-pane default: the active tab alone is onscreen.
  final Set<String>? visibleKeys;
  final String? focusedKey;
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
