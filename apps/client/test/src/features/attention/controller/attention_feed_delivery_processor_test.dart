import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/l10n/app_localizations_en.dart';
import 'package:cosyncing_client/l10n/app_localizations_zh.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

const String _clientId = 'delivery-processor-client';
const String _profileId = 'delivery-processor-profile';

void main() {
  late _MockBrokerClient brokerClient;
  late _InMemoryDeliveryRepository repository;
  late _FailingAwareNotificationSink notificationSink;
  late _StubLifecycleMonitor lifecycleMonitor;

  setUpAll(() {
    registerFallbackValue(<AttentionBulkDismissItem>[]);
  });

  setUp(() {
    brokerClient = _MockBrokerClient();
    repository = _InMemoryDeliveryRepository(profileId: _profileId);
    notificationSink = _FailingAwareNotificationSink();
    lifecycleMonitor = _StubLifecycleMonitor(
      currentState: BrokerAppLifecycleState.hidden,
    );
  });

  AttentionFeedDeliveryProcessor makeProcessor({
    AppLocalizations? localizations,
  }) {
    return AttentionFeedDeliveryProcessor(
      repository: repository,
      brokerProfileId: _profileId,
      lifecycleMonitor: lifecycleMonitor,
      notificationSink: notificationSink,
      onForegroundEvent: (_) async {},
      now: () => DateTime(2026),
      localizations: localizations,
    );
  }

  test(
    'retries failed read and dismiss posts on later reconcile pass',
    () async {
      final event = _attentionEvent(id: 'evt-persist');
      await repository.persistAttentionEventsPage(
        brokerProfileId: _profileId,
        page: AttentionEventsPage(
          events: [event],
          cursor: 1,
          reset: false,
          hasMore: false,
        ),
      );
      await repository.markRead(
        _profileId,
        'evt-persist',
        readAt: DateTime(2026, 7, 11),
      );
      await repository.markDismissed(
        _profileId,
        'evt-persist',
        dismissedAt: DateTime(2026, 7, 11, 0, 1),
      );

      var ackAttempts = 0;
      var dismissAttempts = 0;
      when(
        () => brokerClient.acknowledgeAttentionEvent(
          any(),
          clientId: any(named: 'clientId'),
        ),
      ).thenAnswer((_) async {
        ackAttempts += 1;
        if (ackAttempts == 1) throw StateError('offline');
        return const <String, dynamic>{};
      });
      when(
        () => brokerClient.dismissAttentionEvent(
          any(),
          clientId: any(named: 'clientId'),
        ),
      ).thenAnswer((_) async {
        dismissAttempts += 1;
        if (dismissAttempts == 1) throw StateError('offline');
        return const <String, dynamic>{};
      });

      final processor = makeProcessor();
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      final pending = await repository.loadDeliveryStates(_profileId);
      final stateAfterFirstPass = pending.single;
      expect(ackAttempts, 1);
      expect(dismissAttempts, 1);
      expect(stateAfterFirstPass.brokerReadAt, isNull);
      expect(stateAfterFirstPass.brokerDismissedAt, isNull);

      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      final reconciled = await repository.loadDeliveryStates(_profileId);
      final stateAfterSecondPass = reconciled.single;
      expect(ackAttempts, 2);
      expect(dismissAttempts, 2);
      expect(stateAfterSecondPass.brokerReadAt, isNotNull);
      expect(stateAfterSecondPass.brokerDismissedAt, isNotNull);
    },
  );

  test(
    'retries revision-scoped offline dismissals in one profile batch',
    () async {
      final events = [
        _attentionEvent(id: 'bulk-a'),
        _attentionEvent(id: 'bulk-b'),
        _attentionEvent(id: 'bulk-c'),
      ];
      await repository.persistAttentionEventsPage(
        brokerProfileId: _profileId,
        page: AttentionEventsPage(
          events: events,
          cursor: 3,
          reset: false,
          hasMore: false,
        ),
      );
      await repository.markSnapshotDismissed([
        for (final event in events)
          AttentionEventSnapshot(
            brokerProfileId: _profileId,
            eventId: event.id,
            revision: event.revision,
          ),
      ]);
      var attempts = 0;
      when(
        () => brokerClient.dismissAttentionEvents(
          any(),
          clientId: any(named: 'clientId'),
        ),
      ).thenAnswer((invocation) async {
        attempts += 1;
        if (attempts == 1) throw StateError('offline');
        final items =
            invocation.positionalArguments.single
                as List<AttentionBulkDismissItem>;
        return AttentionBulkDismissResponse(
          accepted: [
            for (final item in items)
              AttentionBulkDismissAccepted(
                eventId: item.eventId,
                revision: item.revision,
                dismissedAt: 100,
              ),
          ],
          stale: const [],
          notFound: const [],
        );
      });

      final processor = makeProcessor();
      expect(
        await processor.reconcileMutations(
          brokerClient: brokerClient,
          clientId: _clientId,
        ),
        0,
      );
      expect(await repository.loadPendingMutations(_profileId), hasLength(3));

      expect(
        await processor.reconcileMutations(
          brokerClient: brokerClient,
          clientId: _clientId,
        ),
        0,
      );
      expect(await repository.loadPendingMutations(_profileId), isEmpty);
      expect(attempts, 2);
      verifyNever(
        () => brokerClient.dismissAttentionEvent(
          any(),
          clientId: any(named: 'clientId'),
        ),
      );
    },
  );

  test('bulk stale result releases its obsolete local dismissal', () async {
    final event = _attentionEvent(id: 'bulk-stale');
    await repository.persistAttentionEventsPage(
      brokerProfileId: _profileId,
      page: AttentionEventsPage(
        events: [event],
        cursor: 1,
        reset: false,
        hasMore: false,
      ),
    );
    await repository.markSnapshotDismissed([
      AttentionEventSnapshot(
        brokerProfileId: _profileId,
        eventId: event.id,
        revision: event.revision,
      ),
    ]);
    when(
      () => brokerClient.dismissAttentionEvents(
        any(),
        clientId: any(named: 'clientId'),
      ),
    ).thenAnswer(
      (_) async => const AttentionBulkDismissResponse(
        accepted: [],
        stale: [
          AttentionBulkDismissStale(
            eventId: 'bulk-stale',
            revision: 1,
            currentRevision: 2,
          ),
        ],
        notFound: [],
      ),
    );

    final released = await makeProcessor().reconcileMutations(
      brokerClient: brokerClient,
      clientId: _clientId,
    );

    expect(released, 1);
    expect(
      (await repository.loadDeliveryStates(_profileId)).single.localDismissedAt,
      isNull,
    );
  });

  test(
    'presents only non-historical events during presentation reconciliation',
    () async {
      final historyEvent = _attentionEvent(
        id: 'evt-history',
        state: 'resolved',
        presentationRevision: 5,
        historicalBaseline: true,
      );
      final maintenanceEvent = _attentionEvent(
        id: 'evt-maint',
        kind: 'runtime-update-ready',
        presentationRevision: 3,
      );
      await repository.persistAttentionEventsPage(
        brokerProfileId: _profileId,
        page: AttentionEventsPage(
          events: [historyEvent, maintenanceEvent],
          cursor: 2,
          reset: false,
          hasMore: false,
        ),
      );

      when(
        () => brokerClient.acknowledgeAttentionEvent(
          any(),
          clientId: any(named: 'clientId'),
        ),
      ).thenAnswer((_) async => const <String, dynamic>{});
      when(
        () => brokerClient.dismissAttentionEvent(
          any(),
          clientId: any(named: 'clientId'),
        ),
      ).thenAnswer((_) async => const <String, dynamic>{});

      final processor = makeProcessor();
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      final shownEventIds = notificationSink.shownEventIds;
      expect(shownEventIds, ['evt-maint']);
      final rows = await repository.loadDeliveryStates(_profileId);
      final historyState = rows.firstWhere(
        (item) => item.event.id == 'evt-history',
      );
      final maintenanceState = rows.firstWhere(
        (item) => item.event.id == 'evt-maint',
      );
      expect(historyState.event.historicalBaseline, isTrue);
      expect(historyState.localPresentedRevision, 0);
      expect(maintenanceState.localPresentedRevision, 3);
    },
  );

  test(
    'replays explicit mutations for historical rows and never presents them',
    () async {
      final event = _attentionEvent(
        id: 'evt-baseline',
        presentationRevision: 8,
      );
      await repository.persistAttentionEventsPage(
        brokerProfileId: _profileId,
        page: AttentionEventsPage(
          events: [
            event.copyWithHistoricalBaseline(),
          ],
          cursor: 12,
          reset: false,
          hasMore: false,
          baselineThroughCursor: 1,
        ),
      );
      await repository.markRead(_profileId, 'evt-baseline');

      when(
        () => brokerClient.acknowledgeAttentionEvent(
          any(),
          clientId: any(named: 'clientId'),
        ),
      ).thenAnswer((_) async => const <String, dynamic>{});

      final processor = makeProcessor();
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      final rows = await repository.loadDeliveryStates(_profileId);
      final state = rows.singleWhere((item) => item.event.id == 'evt-baseline');
      expect(state.localReadAt, isNotNull);
      expect(state.brokerReadAt, isNotNull);
      expect(state.event.historicalBaseline, isTrue);
      verify(
        () => brokerClient.acknowledgeAttentionEvent(
          'evt-baseline',
          clientId: _clientId,
        ),
      ).called(1);
      expect(notificationSink.shownEventIds, isEmpty);
      expect(
        state.localPresentedRevision,
        isNot(state.event.presentationRevision),
      );
      expect(state.event.presentationRevision, equals(8));
      expect(state.localPresentedRevision, 0);
    },
  );

  test(
    'keeps scheduled success quiet and presents scheduled failure as high',
    () async {
      await repository.persistAttentionEventsPage(
        brokerProfileId: _profileId,
        page: AttentionEventsPage(
          events: [
            _attentionEvent(
              id: 'schedule-sent',
              kind: 'scheduled-send',
              state: 'resolved',
              presentationRevision: 2,
            ),
            _attentionEvent(
              id: 'schedule-failed',
              kind: 'scheduled-send-failed',
              state: 'resolved',
              presentationRevision: 3,
              severity: 'action-required',
            ),
          ],
          cursor: 2,
          reset: false,
          hasMore: false,
        ),
      );

      await makeProcessor().reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(notificationSink.shownEventIds, ['schedule-failed']);
      final request = notificationSink.requests.single;
      expect(request.category, BrokerNotificationCategory.actionRequired);
      expect(request.importance, BrokerNotificationImportance.high);
      final rows = await repository.loadDeliveryStates(_profileId);
      expect(
        rows
            .singleWhere((row) => row.event.id == 'schedule-sent')
            .localPresentedRevision,
        2,
      );
      expect(
        rows
            .singleWhere((row) => row.event.id == 'schedule-failed')
            .localPresentedRevision,
        3,
      );
    },
  );

  test(
    'coalesces a startup legacy request with its first durable feed event',
    () async {
      const dedupeKey = 'permission-required:codex:session-cold:request-cold';
      final event = _attentionEvent(
        id: 'event-cold',
        kind: 'permission-required',
        severity: 'action-required',
        dedupeKey: dedupeKey,
        tool: 'codex',
        sessionId: 'session-cold',
        requestId: 'request-cold',
      );
      await repository.persistAttentionEventsPage(
        brokerProfileId: _profileId,
        page: AttentionEventsPage(
          events: [event],
          cursor: 1,
          reset: false,
          hasMore: false,
        ),
      );

      final legacyPolicy = DefaultBrokerSessionNotificationPolicy(
        lifecycleMonitor: lifecycleMonitor,
        sink: notificationSink,
      );
      await legacyPolicy.maybeNotifyForSessionEvent(
        tool: 'codex',
        sessionId: 'session-cold',
        brokerProfileId: _profileId,
        event: MessageWireEvent(
          seq: 9,
          message: AgentMessage.fromJson(const {
            'type': 'permission-request',
            'requestId': 'request-cold',
          }),
        ),
      );

      await makeProcessor().reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(notificationSink.requests, hasLength(2));
      expect(
        notificationSink.requests.map((request) => request.id).toSet(),
        hasLength(1),
      );
      expect(
        notificationSink.requests.last.id,
        attentionNotificationId(
          brokerProfileId: _profileId,
          eventId: event.id,
          dedupeKey: dedupeKey,
          presentationRevision: event.presentationRevision,
        ),
      );
      expect(
        notificationSink.requests.last.payload['attentionDedupeKey'],
        dedupeKey,
      );
      expect(notificationSink.shownEventIds, ['event-cold']);
      expect(notificationSink.clearedIds, [
        attentionNotificationId(
          brokerProfileId: _profileId,
          eventId: 'event-cold',
        ),
      ]);
    },
  );

  test(
    'session notifications carry localized tool and title identity',
    () async {
      await repository.persistAttentionEventsPage(
        brokerProfileId: _profileId,
        page: AttentionEventsPage(
          events: [
            _attentionEvent(
              id: 'ready',
              tool: 'codex',
              sessionId: 'session-ready',
              sessionTitle: 'Build release',
            ),
            _attentionEvent(
              id: 'failed',
              kind: 'run-failed',
              tool: 'claude',
              sessionId: 'session-failed',
              sessionTitle: 'Fix login',
            ),
            _attentionEvent(
              id: 'input',
              kind: 'question-required',
              tool: 'opencode',
              sessionId: 'session-input',
              sessionTitle: 'Choose API',
            ),
            _attentionEvent(
              id: 'degraded',
              kind: 'sync-degraded',
              tool: 'codex',
              sessionId: 'session-degraded',
              sessionTitle: 'Release check',
            ),
          ],
          cursor: 4,
          reset: false,
          hasMore: false,
        ),
      );

      await makeProcessor(localizations: AppLocalizationsEn()).reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(
        notificationSink.requests.map((request) => request.body),
        containsAll([
          'Codex: Build release is ready to review.',
          'Claude: Fix login failed.',
          'OpenCode: Choose API needs input',
          'Codex: Release check sync is degraded.',
        ]),
      );

      final chineseRepository = _InMemoryDeliveryRepository(
        profileId: _profileId,
      );
      await chineseRepository.persistAttentionEventsPage(
        brokerProfileId: _profileId,
        page: AttentionEventsPage(
          events: [
            _attentionEvent(
              id: 'ready-zh',
              tool: 'codex',
              sessionId: 'session-ready-zh',
              sessionTitle: '构建发布',
            ),
          ],
          cursor: 1,
          reset: false,
          hasMore: false,
        ),
      );
      final chineseProcessor = AttentionFeedDeliveryProcessor(
        repository: chineseRepository,
        brokerProfileId: _profileId,
        lifecycleMonitor: lifecycleMonitor,
        notificationSink: notificationSink,
        onForegroundEvent: (_) async {},
        localizations: AppLocalizationsZh(),
      );
      await chineseProcessor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );
      expect(notificationSink.requests.last.body, contains('Codex: 构建发布'));
    },
  );
}

AttentionEventView _attentionEvent({
  required String id,
  String kind = 'run-finished',
  String state = 'active',
  int presentationRevision = 1,
  int cursor = 1,
  bool historicalBaseline = false,
  String severity = 'informational',
  String? dedupeKey,
  String? tool,
  String? sessionId,
  String? sessionTitle,
  String? requestId,
}) {
  final event = AttentionEventView.fromJson(<String, dynamic>{
    'id': id,
    'cursor': cursor,
    'revision': 1,
    'presentationRevision': presentationRevision,
    'kind': kind,
    'state': state,
    'severity': severity,
    'dedupeKey': dedupeKey ?? 'dedupe-$id',
    'createdAt': 1,
    'updatedAt': 2,
    'title': 'Event $id',
    if (sessionId != null) 'sessionId': sessionId,
    if (sessionTitle != null) 'sessionTitle': sessionTitle,
    if (requestId != null) 'requestId': requestId,
    'action': tool != null && sessionId != null
        ? {
            'kind': 'open-session',
            'tool': tool,
            'sessionId': sessionId,
          }
        : {'kind': 'open-attention-inbox'},
  });
  if (!historicalBaseline) {
    return event;
  }
  return event.copyWithHistoricalBaseline();
}

extension _HistoricalEventCopy on AttentionEventView {
  AttentionEventView copyWithHistoricalBaseline() {
    return AttentionEventView(
      id: id,
      cursor: cursor,
      revision: revision,
      presentationRevision: presentationRevision,
      kind: kind,
      state: state,
      severity: severity,
      dedupeKey: dedupeKey,
      createdAt: createdAt,
      updatedAt: updatedAt,
      presentationStage: presentationStage,
      resolvedAt: resolvedAt,
      agent: agent,
      sessionId: sessionId,
      requestId: requestId,
      turnId: turnId,
      goalKey: goalKey,
      title: title,
      summary: summary,
      action: action,
      raw: raw,
      readAt: readAt,
      dismissedAt: dismissedAt,
      historicalBaseline: true,
    );
  }
}

class _MockBrokerClient extends Mock implements BrokerClient {}

class _FailingAwareNotificationSink implements BrokerNotificationSink {
  final List<BrokerNotificationRequest> requests = [];
  final List<String> shownEventIds = [];
  final List<String> clearedIds = [];

  @override
  Future<void> show(BrokerNotificationRequest request) async {
    requests.add(request);
    final eventId = request.payload['eventId'];
    if (eventId is String) {
      shownEventIds.add(eventId);
    }
  }

  @override
  Future<void> clear(String id) async {
    clearedIds.add(id);
  }

  @override
  Future<void> clearMany(Iterable<String> ids) async {
    clearedIds.addAll(ids);
  }

  @override
  Future<void> clearAll() async {}
}

class _StubLifecycleMonitor implements BrokerAppLifecycleMonitor {
  _StubLifecycleMonitor({required this.currentState});

  @override
  BrokerAppLifecycleState currentState;

  @override
  Stream<BrokerAppLifecycleState> get stateChanges =>
      const Stream<BrokerAppLifecycleState>.empty();

  @override
  void dispose() {}
}

class _InMemoryDeliveryRepository implements AttentionRepository {
  _InMemoryDeliveryRepository({required this.profileId});

  final String profileId;
  final Map<String, AttentionEventView> events = {};
  final Map<String, int> localPresentedRevision = {};
  final Map<String, int?> localReadAt = {};
  final Map<String, int?> localDismissedAt = {};
  final Map<String, int?> localDismissedRevision = {};
  final Map<String, int?> brokerReadAtById = {};
  final Map<String, int?> brokerDismissedAtById = {};
  int cursor = 0;

  @override
  Future<void> persistAttentionEventsPage({
    required String brokerProfileId,
    required AttentionEventsPage page,
  }) async {
    if (page.cursor < 0) {
      throw ArgumentError('cursor must be >= 0');
    }
    if (brokerProfileId != profileId) return;
    cursor = page.cursor;
    for (final event in page.events) {
      events[event.id] = event;
      localPresentedRevision.putIfAbsent(event.id, () => 0);
    }
  }

  @override
  Future<List<AttentionEventView>> loadEvents(String brokerProfileId) async {
    if (brokerProfileId != profileId) return [];
    return events.values.toList(growable: false);
  }

  @override
  Future<List<AttentionDeliveryState>> loadDeliveryStates(
    String brokerProfileId,
  ) async {
    if (brokerProfileId != profileId) return [];
    final result = <AttentionDeliveryState>[];
    for (final event in events.values) {
      final merged = AttentionEventView(
        id: event.id,
        cursor: event.cursor,
        revision: event.revision,
        presentationRevision: event.presentationRevision,
        kind: event.kind,
        state: event.state,
        severity: event.severity,
        dedupeKey: event.dedupeKey,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        resolvedAt: event.resolvedAt,
        agent: event.agent,
        sessionId: event.sessionId,
        sessionTitle: event.sessionTitle,
        requestId: event.requestId,
        turnId: event.turnId,
        goalKey: event.goalKey,
        title: event.title,
        summary: event.summary,
        presentationStage: event.presentationStage,
        historicalBaseline: events[event.id]?.historicalBaseline ?? false,
        action: event.action,
        readAt: localReadAt[event.id],
        dismissedAt: localDismissedAt[event.id],
        raw: event.raw,
      );
      result.add(
        AttentionDeliveryState(
          event: merged,
          localPresentedRevision: localPresentedRevision[event.id] ?? 0,
          localReadAt: localReadAt[event.id],
          localDismissedAt: localDismissedAt[event.id],
          localDismissedRevision: localDismissedRevision[event.id],
          brokerReadAt: brokerReadAtById[event.id],
          brokerDismissedAt: brokerDismissedAtById[event.id],
        ),
      );
    }
    result.sort(
      (left, right) => right.event.updatedAt.compareTo(left.event.updatedAt),
    );
    return result;
  }

  @override
  Future<int> loadCursor(String brokerProfileId) async {
    if (brokerProfileId != profileId) return 0;
    return cursor;
  }

  @override
  Future<int> loadUnreadCount(String brokerProfileId) async => 0;

  @override
  Future<List<AttentionEventSnapshot>> markSnapshotDismissed(
    List<AttentionEventSnapshot> snapshot, {
    DateTime? dismissedAt,
  }) async {
    final accepted = <AttentionEventSnapshot>[];
    for (final item in snapshot) {
      final event = events[item.eventId];
      if (item.brokerProfileId != profileId ||
          event?.revision != item.revision ||
          localDismissedAt[item.eventId] != null) {
        continue;
      }
      localDismissedAt[item.eventId] =
          (dismissedAt ?? DateTime.now()).millisecondsSinceEpoch;
      localDismissedRevision[item.eventId] = item.revision;
      accepted.add(item);
    }
    return accepted;
  }

  @override
  Future<int> reconcileBulkDismissResult({
    required String brokerProfileId,
    required AttentionBulkDismissResponse result,
  }) async {
    var released = 0;
    for (final item in result.accepted) {
      if (localDismissedRevision[item.eventId] != item.revision) continue;
      final local = localDismissedAt[item.eventId]!;
      brokerDismissedAtById[item.eventId] = item.dismissedAt > local
          ? item.dismissedAt
          : local;
    }
    for (final item in result.stale) {
      if (localDismissedRevision[item.eventId] != item.revision) continue;
      localDismissedAt[item.eventId] = null;
      localDismissedRevision[item.eventId] = null;
      brokerDismissedAtById[item.eventId] = null;
      released += 1;
    }
    for (final item in result.notFound) {
      if (localDismissedRevision[item.eventId] != item.revision) continue;
      brokerDismissedAtById[item.eventId] = localDismissedAt[item.eventId];
    }
    return released;
  }

  @override
  Future<List<AttentionDeliveryState>> loadPendingMutations(
    String brokerProfileId,
  ) async {
    if (brokerProfileId != profileId) return [];
    final rows = await loadDeliveryStates(profileId);
    return rows
        .where(
          (row) =>
              (row.localReadAt != null &&
                  (row.brokerReadAt == null ||
                      row.localReadAt! > row.brokerReadAt!)) ||
              (row.localDismissedAt != null &&
                  (row.brokerDismissedAt == null ||
                      row.localDismissedAt! > row.brokerDismissedAt!)),
        )
        .toList(growable: false);
  }

  @override
  Future<List<AttentionDeliveryState>> loadPendingPresentations(
    String brokerProfileId,
  ) async {
    if (brokerProfileId != profileId) return [];
    final rows = await loadDeliveryStates(profileId);
    return rows
        .where(
          (row) =>
              !row.event.historicalBaseline &&
              row.event.dismissedAt == null &&
              row.event.presentationRevision > row.localPresentedRevision,
        )
        .toList(growable: false);
  }

  @override
  Future<void> markRead(
    String brokerProfileId,
    String eventId, {
    DateTime? readAt,
  }) async {
    if (brokerProfileId != profileId) return;
    localReadAt[eventId] = (readAt ?? DateTime.now()).millisecondsSinceEpoch;
  }

  @override
  Future<void> markDismissed(
    String brokerProfileId,
    String eventId, {
    DateTime? dismissedAt,
  }) async {
    if (brokerProfileId != profileId) return;
    localDismissedAt[eventId] =
        (dismissedAt ?? DateTime.now()).millisecondsSinceEpoch;
  }

  @override
  Future<bool> advancePresentedRevision({
    required String brokerProfileId,
    required String eventId,
    required int presentedRevision,
  }) async {
    if (brokerProfileId != profileId) return false;
    final current = localPresentedRevision[eventId];
    if (current == null || current >= presentedRevision) return false;
    localPresentedRevision[eventId] = presentedRevision;
    return true;
  }

  @override
  Future<bool> markBrokerReadSynced({
    required String brokerProfileId,
    required String eventId,
    required DateTime brokerReadAt,
  }) async {
    if (brokerProfileId != profileId) return false;
    if (!events.containsKey(eventId)) return false;
    brokerReadAtById[eventId] = brokerReadAt.millisecondsSinceEpoch;
    return true;
  }

  @override
  Future<bool> markBrokerDismissedSynced({
    required String brokerProfileId,
    required String eventId,
    required DateTime brokerDismissedAt,
  }) async {
    if (brokerProfileId != profileId) return false;
    if (!events.containsKey(eventId)) return false;
    brokerDismissedAtById[eventId] = brokerDismissedAt.millisecondsSinceEpoch;
    return true;
  }
}
