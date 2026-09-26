import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_auto_read_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/notification_test_support.dart';

void main() {
  late AppDatabase database;
  late DriftAttentionRepository repository;
  late _RecordingBrokerClient brokerClient;
  late _RecordingSink sink;
  late ControllableLifecycleMonitor lifecycle;
  late ProviderContainer container;

  final profile = BrokerProfile(
    id: 'profile-1',
    displayName: 'Local',
    baseUri: Uri.parse('http://127.0.0.1:7734'),
    createdAt: DateTime(2026, 9, 23),
  );
  final scope = RosterSource.ofProfile(profile).storageKey;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    repository = DriftAttentionRepository(database);
    brokerClient = _RecordingBrokerClient();
    sink = _RecordingSink();
    lifecycle = ControllableLifecycleMonitor();
    container = ProviderContainer(
      overrides: [
        attentionRepositoryProvider.overrideWithValue(repository),
        attentionProfileClientProvider.overrideWith(
          (ref, _) async => brokerClient,
        ),
        attentionClientIdProvider.overrideWith((ref) async => 'device-1'),
        sessionLocalNotificationSinkProvider.overrideWithValue(sink),
        sessionNotificationLifecycleMonitorProvider.overrideWithValue(
          lifecycle,
        ),
        brokerProfileListProvider.overrideWith(
          () => _FixedProfileList([profile]),
        ),
      ],
    )..listen(attentionAutoReadRuntimeProvider, (_, _) {});
  });

  tearDown(() async {
    container.dispose();
    await database.close();
  });

  Future<void> persist(List<AttentionEventView> events, {int cursor = 1}) =>
      repository.persistAttentionEventsPage(
        brokerProfileId: scope,
        page: AttentionEventsPage(
          events: events,
          cursor: cursor,
          reset: false,
          hasMore: false,
        ),
      );

  Future<AttentionEventView> stored(String id) async =>
      (await repository.loadEvents(scope)).singleWhere((e) => e.id == id);

  void show(String sessionId, {bool Function()? stillVisible}) {
    container.read(visibleAttentionSessionsProvider.notifier).state = [
      VisibleAttentionSession(
        source: RosterSource.ofProfile(profile),
        tool: 'codex',
        sessionId: sessionId,
        owner: Object(),
        isStillVisible: stillVisible ?? () => true,
      ),
    ];
  }

  String slotOf(AttentionEventView event) => attentionNotificationSlotId(
    brokerProfileId: profile.id,
    event: event,
  )!;

  test(
    'opening a session reads its finished and failed turns and clears them',
    () async {
      final finished = _event('turn-1', 'run-finished', sessionId: 'on');
      final failed = _event('turn-2', 'run-failed', sessionId: 'on');
      final elsewhere = _event('turn-3', 'run-finished', sessionId: 'off');
      await persist([finished, failed, elsewhere]);

      show('on');
      await pumpEventQueue();

      expect((await stored('turn-1')).readAt, isNotNull);
      expect((await stored('turn-2')).readAt, isNotNull);
      expect((await stored('turn-3')).readAt, isNull);
      expect(brokerClient.acknowledged, unorderedEquals(['turn-1', 'turn-2']));
      expect(sink.cleared, contains(slotOf(failed)));
      expect(sink.cleared, isNot(contains(slotOf(elsewhere))));
    },
  );

  test(
    'a pending request loses its notification but keeps its inbox row',
    () async {
      AttentionEventView request(int presentationRevision) => _event(
        'request-1',
        'permission-required',
        sessionId: 'on',
        severity: 'action-required',
        presentationRevision: presentationRevision,
      );
      await persist([request(1)]);

      show('on');
      await pumpEventQueue();

      expect(sink.cleared, contains(slotOf(request(1))));
      expect((await stored('request-1')).readAt, isNull);
      expect((await stored('request-1')).state, 'active');
      expect(brokerClient.acknowledged, isEmpty);

      // Cleared once per presentation: a re-run does not clear again, a
      // reminder that arrives while the session is on screen does.
      sink.cleared.clear();
      container.read(attentionInboxRevisionProvider.notifier).state += 1;
      await pumpEventQueue();
      expect(sink.cleared, isEmpty);

      await persist([request(2)], cursor: 2);
      container.read(attentionInboxRevisionProvider.notifier).state += 1;
      await pumpEventQueue();
      expect(sink.cleared, contains(slotOf(request(2))));
    },
  );

  test('a turn finishing while its session is on screen is read', () async {
    show('on');
    await pumpEventQueue();

    await persist([_event('late-turn', 'run-finished', sessionId: 'on')]);
    container.read(attentionInboxRevisionProvider.notifier).state += 1;
    await pumpEventQueue();

    expect((await stored('late-turn')).readAt, isNotNull);
  });

  test('nothing is read while the app is in the background', () async {
    lifecycle.emit(BrokerAppLifecycleState.hidden);
    await persist([_event('turn-bg', 'run-finished', sessionId: 'on')]);

    show('on');
    await pumpEventQueue();
    expect((await stored('turn-bg')).readAt, isNull);
    expect(sink.cleared, isEmpty);

    lifecycle.emit(BrokerAppLifecycleState.resumed);
    await pumpEventQueue();
    expect((await stored('turn-bg')).readAt, isNotNull);
  });

  test('a claim whose page is no longer visible reads nothing', () async {
    await persist([_event('turn-stale', 'run-finished', sessionId: 'on')]);

    show('on', stillVisible: () => false);
    await pumpEventQueue();

    expect((await stored('turn-stale')).readAt, isNull);
  });

  test('events that are never notifications are left alone', () async {
    await persist([
      _event('degraded', 'sync-degraded', sessionId: 'on'),
      _event('sent', 'scheduled-send', sessionId: 'on'),
    ]);

    show('on');
    await pumpEventQueue();

    expect((await stored('degraded')).readAt, isNull);
    expect((await stored('sent')).readAt, isNull);
    expect(sink.cleared, isEmpty);
  });
}

AttentionEventView _event(
  String id,
  String kind, {
  required String sessionId,
  String severity = 'informational',
  int presentationRevision = 1,
}) => AttentionEventView.fromJson({
  'id': id,
  'cursor': presentationRevision,
  'revision': presentationRevision,
  'presentationRevision': presentationRevision,
  'kind': kind,
  'state': kind == 'permission-required' ? 'active' : 'resolved',
  'severity': severity,
  'dedupeKey': '$kind:codex:$sessionId:$id',
  'createdAt': 1,
  'updatedAt': presentationRevision,
  'title': 'Title',
  'sessionId': sessionId,
  'action': {'kind': 'open-session', 'tool': 'codex', 'sessionId': sessionId},
});

final class _FixedProfileList extends BrokerProfileListNotifier {
  _FixedProfileList(this.profiles);

  final List<BrokerProfile> profiles;

  @override
  Future<List<BrokerProfile>> build() async => profiles;
}

final class _RecordingBrokerClient extends BrokerClient {
  _RecordingBrokerClient() : super(baseUrl: 'http://127.0.0.1:7734');

  final acknowledged = <String>[];

  @override
  Future<Map<String, dynamic>> acknowledgeAttentionEvent(
    String eventId, {
    required String clientId,
  }) async {
    acknowledged.add(eventId);
    return {'ok': true};
  }
}

final class _RecordingSink implements BrokerNotificationSink {
  final cleared = <String>[];

  @override
  Future<BrokerNotificationDeliveryResult> show(
    BrokerNotificationRequest request,
  ) async => BrokerNotificationDeliveryResult.shown;

  @override
  Future<void> clear(String id) async => cleared.add(id);

  @override
  Future<void> clearMany(Iterable<String> ids) async => cleared.addAll(ids);

  @override
  Future<void> clearAll() async {}
}
