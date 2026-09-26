import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/l10n/app_localizations_en.dart';
import 'package:cosyncing_client/l10n/app_localizations_zh.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_presentation_coordinator.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_notification_type_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
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
    AttentionNotificationSettingResolver? resolveSetting,
    AttentionNotificationDeliveryObserver? onDelivery,
    AttentionFeedForegroundHandler? onForegroundEvent,
    AttentionPresentationCoordinator? presentationCoordinator,
  }) {
    return AttentionFeedDeliveryProcessor(
      repository: repository,
      brokerProfileId: _profileId,
      lifecycleMonitor: lifecycleMonitor,
      notificationSink: notificationSink,
      onForegroundEvent: onForegroundEvent ?? (_) async {},
      now: () => DateTime(2026),
      localizations: localizations ?? AppLocalizationsEn(),
      resolveSetting:
          resolveSetting ??
          (type) async => AttentionNotificationTypeSetting.defaultsFor(type),
      onDelivery: onDelivery,
      presentationCoordinator:
          presentationCoordinator ??
          const SingleWindowPresentationCoordinator(),
    );
  }

  Future<void> persist(List<AttentionEventView> events, {int cursor = 1}) =>
      repository.persistAttentionEventsPage(
        brokerProfileId: _profileId,
        page: AttentionEventsPage(
          events: events,
          cursor: cursor,
          reset: false,
          hasMore: false,
        ),
      );

  Future<int> presentedRevision(String eventId) async =>
      (await repository.loadDeliveryStates(
        _profileId,
      )).singleWhere((row) => row.event.id == eventId).localPresentedRevision;

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
        kind: 'device-paired',
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
    'keeps scheduled success quiet and presents scheduled failure',
    () async {
      await persist([
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
      ], cursor: 2);

      await makeProcessor().reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(notificationSink.shownEventIds, ['schedule-failed']);
      final request = notificationSink.requests.single;
      expect(request.title, 'Scheduled message failed');
      expect(
        request.channel.id,
        AttentionNotificationType.scheduledSendFailed.channelId,
      );
      expect(request.playSound, isTrue);
      expect(await presentedRevision('schedule-sent'), 2);
      expect(await presentedRevision('schedule-failed'), 3);
    },
  );

  test(
    'the title is the event type and the body the truncated session title',
    () async {
      await persist([
        _attentionEvent(
          id: 'ready',
          tool: 'codex',
          sessionId: 'session-ready',
          sessionTitle:
              'Rewrite the whole notification delivery pipeline for every '
              'platform we ship',
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
        ),
        _attentionEvent(id: 'paired', kind: 'device-paired'),
      ], cursor: 4);

      await makeProcessor().reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      final byEvent = {
        for (final request in notificationSink.requests)
          request.payload['eventId']: request,
      };
      expect(byEvent['ready']!.title, 'Turn finished');
      expect(
        byEvent['ready']!.body,
        'Rewrite the whole notification delivery pipelin…',
      );
      expect(byEvent['ready']!.threadKey, 'codex:session-ready');
      expect(
        byEvent['ready']!.alertKey,
        attentionNotificationAlertKey(eventId: 'ready', revision: 1),
        reason: 'the first alert of revision 1, as a push of it names it',
      );
      expect(byEvent['ready']!.playSound, isFalse);
      expect(byEvent['failed']!.title, 'Turn failed');
      expect(byEvent['failed']!.body, 'Fix login');
      expect(byEvent['failed']!.playSound, isTrue);
      expect(byEvent['input']!.title, 'Question');
      expect(byEvent['input']!.body, 'Untitled session');
      expect(byEvent['input']!.channel.urgent, isTrue);
      // Not a session event: the broker's own event title.
      expect(byEvent['paired']!.title, 'New device paired');
      expect(byEvent['paired']!.body, 'Event paired');
    },
  );

  test('titles follow the locale snapshot', () async {
    await persist([
      _attentionEvent(
        id: 'ready-zh',
        tool: 'codex',
        sessionId: 'session-ready-zh',
        sessionTitle: '构建发布',
      ),
    ]);

    await makeProcessor(localizations: AppLocalizationsZh()).reconcile(
      brokerClient: brokerClient,
      clientId: _clientId,
    );

    expect(notificationSink.requests.single.title, '轮次已完成');
    expect(notificationSink.requests.single.body, '构建发布');
  });

  test('"event type only" leaves the body empty', () async {
    await persist([
      _attentionEvent(
        id: 'private',
        tool: 'codex',
        sessionId: 'session-private',
        sessionTitle: 'Acquisition due diligence',
      ),
    ]);

    await makeProcessor(
      resolveSetting: (type) async =>
          AttentionNotificationTypeSetting.defaultsFor(
            type,
          ).copyWith(showSessionTitle: false),
    ).reconcile(brokerClient: brokerClient, clientId: _clientId);

    expect(notificationSink.requests.single.title, 'Turn finished');
    expect(notificationSink.requests.single.body, isEmpty);
  });

  test('the per-type sound choice reaches the request', () async {
    await persist([
      _attentionEvent(
        id: 'loud',
        tool: 'codex',
        sessionId: 'session-loud',
      ),
    ]);

    await makeProcessor(
      resolveSetting: (type) async =>
          AttentionNotificationTypeSetting.defaultsFor(
            type,
          ).copyWith(sound: true),
    ).reconcile(brokerClient: brokerClient, clientId: _clientId);

    expect(notificationSink.requests.single.playSound, isTrue);
  });

  test(
    'a type switched off neither notifies nor banners, and is reported',
    () async {
      lifecycleMonitor.currentState = BrokerAppLifecycleState.resumed;
      await persist([
        _attentionEvent(id: 'off', tool: 'codex', sessionId: 'session-off'),
      ]);
      final banners = <String>[];
      final deliveries = <(AttentionNotificationType, String?)>[];

      final processor = makeProcessor(
        resolveSetting: (type) async =>
            AttentionNotificationTypeSetting.defaultsFor(
              type,
            ).copyWith(enabled: type != AttentionNotificationType.turnFinished),
        onForegroundEvent: (event) async => banners.add(event.id),
        onDelivery: (type, result) => deliveries.add((type, result.reason)),
      );
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );
      lifecycleMonitor.currentState = BrokerAppLifecycleState.hidden;
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(banners, isEmpty);
      expect(notificationSink.requests, isEmpty);
      expect(deliveries, [
        (AttentionNotificationType.turnFinished, 'type-off'),
      ]);
      expect(await presentedRevision('off'), 1);
    },
  );

  test('sync-degraded and unknown kinds are never OS notifications', () async {
    await persist([
      _attentionEvent(
        id: 'degraded',
        kind: 'sync-degraded',
        tool: 'codex',
        sessionId: 'session-degraded',
      ),
      _attentionEvent(id: 'future', kind: 'kind-from-the-future'),
      // Default severity is informational.
      _attentionEvent(id: 'health-info', kind: 'broker-health'),
      _attentionEvent(
        id: 'health-critical',
        kind: 'broker-health',
        severity: 'critical',
      ),
    ], cursor: 4);

    await makeProcessor().reconcile(
      brokerClient: brokerClient,
      clientId: _clientId,
    );

    expect(notificationSink.shownEventIds, ['health-critical']);
    expect(notificationSink.requests.single.title, 'Server problem');
    for (final id in ['degraded', 'future', 'health-info']) {
      expect(await presentedRevision(id), 1, reason: id);
    }
  });

  test(
    'a newer turn outcome replaces the session notification in place',
    () async {
      await persist([
        _attentionEvent(id: 'turn-1', tool: 'codex', sessionId: 'session-a'),
      ]);
      final processor = makeProcessor();
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );
      await persist([
        _attentionEvent(
          id: 'turn-2',
          kind: 'run-failed',
          tool: 'codex',
          sessionId: 'session-a',
          cursor: 2,
        ),
        _attentionEvent(
          id: 'other-session',
          tool: 'codex',
          sessionId: 'session-b',
          cursor: 3,
        ),
      ], cursor: 3);
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      final ids = {
        for (final request in notificationSink.requests)
          request.payload['eventId']: request.id,
      };
      expect(ids['turn-1'], ids['turn-2']);
      expect(ids['other-session'], isNot(ids['turn-1']));
      expect(
        ids['turn-1'],
        brokerAttentionNotificationId(
          brokerProfileId: _profileId,
          dedupeKey: 'session-outcome:codex:session-a',
        ),
      );
    },
  );

  test(
    'a request reminder re-alerts in its slot and clears older-client ids',
    () async {
      const dedupeKey = 'permission-required:codex:session-r:request-r';
      AttentionEventView request(int revision) => _attentionEvent(
        id: 'request-r',
        kind: 'permission-required',
        severity: 'action-required',
        dedupeKey: dedupeKey,
        tool: 'codex',
        sessionId: 'session-r',
        requestId: 'request-r',
        presentationRevision: revision,
      );
      await persist([request(1)]);
      final processor = makeProcessor();
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );
      expect(notificationSink.clearedIds, isEmpty);

      await persist([request(2)], cursor: 2);
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      final slot = brokerAttentionNotificationId(
        brokerProfileId: _profileId,
        dedupeKey: dedupeKey,
      );
      expect(notificationSink.requests.map((r) => r.id), [slot, slot]);
      // An older client stacked `…:presentation:<revision>` ids; clear them.
      expect(notificationSink.clearedIds, contains('$slot:presentation:2'));
      expect(notificationSink.clearedIds, isNot(contains(slot)));
    },
  );

  group('with other windows of this app', () {
    test('a background window leaves an event to a foreground one', () async {
      final coordinator = _ScriptedCoordinator()..otherInForeground = true;
      await persist([
        _attentionEvent(id: 'shared', tool: 'codex', sessionId: 'session-x'),
      ]);
      final processor = makeProcessor(presentationCoordinator: coordinator);

      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(notificationSink.requests, isEmpty);
      // Still pending: the foreground window presents it in-app.
      expect(await presentedRevision('shared'), 0);

      // That window closed before presenting it.
      coordinator.otherInForeground = false;
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(notificationSink.requests, hasLength(1));
      expect(await presentedRevision('shared'), 1);
    });

    test('a foreground window presents in-app without asking', () async {
      lifecycleMonitor.currentState = BrokerAppLifecycleState.resumed;
      final coordinator = _ScriptedCoordinator()..otherInForeground = true;
      await persist([
        _attentionEvent(id: 'mine', tool: 'codex', sessionId: 'session-x'),
      ]);
      final banners = <String>[];
      final processor = makeProcessor(
        presentationCoordinator: coordinator,
        onForegroundEvent: (event) async => banners.add(event.id),
      );

      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(banners, ['mine']);
      expect(coordinator.foregroundQueries, 0);
      expect(await presentedRevision('mine'), 1);
    });

    test('presentation runs inside the exclusive section', () async {
      final log = <String>[];
      final coordinator = _ScriptedCoordinator(log: log);
      notificationSink.onShow = () => log.add('show');
      await persist([
        _attentionEvent(id: 'locked', tool: 'codex', sessionId: 'session-x'),
      ]);

      await makeProcessor(
        presentationCoordinator: coordinator,
      ).reconcile(brokerClient: brokerClient, clientId: _clientId);

      expect(log, ['enter $_profileId', 'show', 'exit $_profileId']);
    });

    test('a window that waited sees what the other one presented', () async {
      await persist([
        _attentionEvent(id: 'raced', tool: 'codex', sessionId: 'session-x'),
      ]);
      final coordinator = _ScriptedCoordinator(
        // While this window waits, another presents the event and records it.
        beforeEnter: () => repository.advancePresentedRevision(
          brokerProfileId: _profileId,
          eventId: 'raced',
          presentedRevision: 1,
        ),
      );

      await makeProcessor(
        presentationCoordinator: coordinator,
      ).reconcile(brokerClient: brokerClient, clientId: _clientId);

      expect(notificationSink.requests, isEmpty);
    });
  });

  test('a blocked presentation advances without retrying', () async {
    notificationSink.nextResults.add(
      const BrokerNotificationDeliveryResult(
        BrokerNotificationDeliveryOutcome.blocked,
        reason: 'permission-not-granted',
      ),
    );
    await persist([
      _attentionEvent(id: 'blocked', tool: 'codex', sessionId: 'session-x'),
    ]);
    final deliveries = <String?>[];
    final processor = makeProcessor(
      onDelivery: (_, result) => deliveries.add(result.reason),
    );

    await processor.reconcile(brokerClient: brokerClient, clientId: _clientId);
    await processor.reconcile(brokerClient: brokerClient, clientId: _clientId);

    expect(notificationSink.requests, hasLength(1));
    expect(deliveries, ['permission-not-granted']);
    expect(await presentedRevision('blocked'), 1);
  });

  group('after permission is granted', () {
    const refused = BrokerNotificationDeliveryResult(
      BrokerNotificationDeliveryOutcome.blocked,
      reason: BrokerNotificationDeliveryResult.permissionNotGrantedReason,
    );

    AttentionEventView request(String id, {String state = 'active'}) =>
        _attentionEvent(
          id: id,
          kind: 'permission-required',
          state: state,
          severity: 'action-required',
          tool: 'codex',
          sessionId: 'session-$id',
          requestId: 'request-$id',
        );

    test('an open request refused before the grant is shown again', () async {
      notificationSink.nextResults.addAll([refused, refused, refused]);
      await persist([
        request('open'),
        request('answered'),
        _attentionEvent(id: 'turn', tool: 'codex', sessionId: 'session-t'),
      ]);
      final processor = makeProcessor();
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );
      expect(notificationSink.requests, hasLength(3));
      // The second request is answered before permission arrives.
      await persist([request('answered', state: 'resolved')], cursor: 2);

      await processor.presentPermissionBlockedRequests();

      expect(
        notificationSink.requests.skip(3).map((r) => r.payload['eventId']),
        ['open'],
        reason:
            'only the still-open request; a finished turn stays in the inbox',
      );
      await processor.presentPermissionBlockedRequests();
      expect(
        notificationSink.requests,
        hasLength(4),
        reason: 'a request shown after the grant is not shown again',
      );
    });

    test('a request resolved while refused is forgotten', () async {
      notificationSink.nextResults.add(refused);
      await persist([request('gone')]);
      final processor = makeProcessor();
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );
      final page = [request('gone', state: 'resolved')];
      await persist(page, cursor: 2);
      await processor.clearResolvedRequests(page);
      // The broker raises the same request again; it presents on its own.
      await persist([request('gone')], cursor: 3);

      await processor.presentPermissionBlockedRequests();

      expect(notificationSink.requests, hasLength(1));
    });

    test(
      'a request turned off in Settings before the grant stays quiet',
      () async {
        notificationSink.nextResults.add(refused);
        await persist([request('muted')]);
        var enabled = true;
        final processor = makeProcessor(
          resolveSetting: (type) async =>
              AttentionNotificationTypeSetting.defaultsFor(
                type,
              ).copyWith(enabled: enabled),
        );
        await processor.reconcile(
          brokerClient: brokerClient,
          clientId: _clientId,
        );
        enabled = false;

        await processor.presentPermissionBlockedRequests();

        expect(notificationSink.requests, hasLength(1));
      },
    );

    test('a request refused for another reason is not replayed', () async {
      notificationSink.nextResults.add(
        const BrokerNotificationDeliveryResult(
          BrokerNotificationDeliveryOutcome.blocked,
          reason: 'channel-off',
        ),
      );
      await persist([request('channel')]);
      final processor = makeProcessor();
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      await processor.presentPermissionBlockedRequests();

      expect(notificationSink.requests, hasLength(1));
    });
  });

  test(
    'a failed presentation retries within its budget, then advances',
    () async {
      for (
        var i = 0;
        i < AttentionFeedDeliveryProcessor.maxFailedPresentationAttempts + 1;
        i++
      ) {
        notificationSink.nextResults.add(
          const BrokerNotificationDeliveryResult(
            BrokerNotificationDeliveryOutcome.failed,
            reason: 'toast failed',
          ),
        );
      }
      await persist([
        _attentionEvent(id: 'flaky', tool: 'codex', sessionId: 'session-f'),
      ]);
      final processor = makeProcessor();

      for (
        var i = 1;
        i < AttentionFeedDeliveryProcessor.maxFailedPresentationAttempts;
        i++
      ) {
        await processor.reconcile(
          brokerClient: brokerClient,
          clientId: _clientId,
        );
        expect(await presentedRevision('flaky'), 0, reason: 'attempt $i');
      }
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(
        notificationSink.requests,
        hasLength(AttentionFeedDeliveryProcessor.maxFailedPresentationAttempts),
      );
      expect(await presentedRevision('flaky'), 1);
    },
  );

  test('a transient failure that recovers presents once', () async {
    notificationSink.nextResults.add(
      const BrokerNotificationDeliveryResult(
        BrokerNotificationDeliveryOutcome.failed,
      ),
    );
    await persist([
      _attentionEvent(id: 'recovers', tool: 'codex', sessionId: 'session-r'),
    ]);
    final processor = makeProcessor();

    await processor.reconcile(brokerClient: brokerClient, clientId: _clientId);
    await processor.reconcile(brokerClient: brokerClient, clientId: _clientId);
    await processor.reconcile(brokerClient: brokerClient, clientId: _clientId);

    expect(notificationSink.requests, hasLength(2));
    expect(await presentedRevision('recovers'), 1);
  });

  test(
    'a request answered before this device presented it is never shown',
    () async {
      await persist([
        _attentionEvent(
          id: 'answered',
          kind: 'permission-required',
          state: 'resolved',
          severity: 'action-required',
          tool: 'codex',
          sessionId: 'session-q',
          requestId: 'request-q',
        ),
      ]);

      await makeProcessor().reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(notificationSink.requests, isEmpty);
      // Never presented here, so there is nothing of ours to clear.
      expect(notificationSink.clearedIds, isEmpty);
      expect(await presentedRevision('answered'), 1);
    },
  );

  group('read or dismissed on another device', () {
    String slotOf(AttentionEventView event) => attentionNotificationSlotId(
      brokerProfileId: _profileId,
      event: event,
    )!;

    AttentionEventView outcome(
      String id, {
      int createdAt = 1,
      Map<String, Object?> extra = const {},
    }) => _attentionEvent(
      id: id,
      tool: 'codex',
      sessionId: 'session-1',
      extra: {'createdAt': createdAt, ...extra},
    );

    test('clears a shown outcome once another device has seen it', () async {
      await persist([outcome('done')]);
      final processor = makeProcessor();
      await processor.reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );
      expect(notificationSink.shownEventIds, ['done']);

      final seen = outcome('done', extra: {'seenAt': 50});
      await persist([seen], cursor: 2);
      await processor.clearSeenElsewhere([seen]);

      expect(notificationSink.clearedIds, contains(slotOf(seen)));
    });

    test(
      'leaves the slot to a newer outcome this device has not handled',
      () async {
        final seen = outcome('older', extra: {'seenAt': 50});
        final newer = outcome('newer', createdAt: 5);
        await persist([seen, newer]);

        await makeProcessor().clearSeenElsewhere([seen]);

        expect(slotOf(seen), slotOf(newer));
        expect(notificationSink.clearedIds, isNot(contains(slotOf(seen))));
      },
    );

    test('leaves a request to its answer', () async {
      final request = _attentionEvent(
        id: 'ask',
        kind: 'permission-required',
        severity: 'action-required',
        dedupeKey: 'permission-required:codex:session-1:ask',
        tool: 'codex',
        sessionId: 'session-1',
        requestId: 'ask',
        extra: {'seenAt': 50},
      );
      await persist([request]);

      await makeProcessor().clearSeenElsewhere([request]);

      expect(notificationSink.clearedIds, isEmpty);
    });

    test('leaves an event this device handled to its own clear', () async {
      final read = outcome('mine', extra: {'seenAt': 50, 'readAt': 50});
      await persist([read]);

      await makeProcessor().clearSeenElsewhere([read]);

      expect(notificationSink.clearedIds, isEmpty);
    });

    test('never shows an outcome seen elsewhere before it arrived', () async {
      await persist([
        outcome('late', extra: {'seenAt': 50}),
      ]);

      await makeProcessor().reconcile(
        brokerClient: brokerClient,
        clientId: _clientId,
      );

      expect(notificationSink.shownEventIds, isEmpty);
      expect(await presentedRevision('late'), 1);
    });
  });

  test(
    'clearResolvedRequests clears requests resolved elsewhere, and only them',
    () async {
      AttentionEventView requestEvent(String id, String state) =>
          _attentionEvent(
            id: id,
            kind: 'question-required',
            state: state,
            severity: 'action-required',
            dedupeKey: 'question-required:codex:session-$id:$id',
            tool: 'codex',
            sessionId: 'session-$id',
            requestId: id,
          );
      final answered = requestEvent('answered', 'resolved');
      final pending = requestEvent('pending', 'active');
      final finished = _attentionEvent(
        id: 'finished',
        state: 'resolved',
        tool: 'codex',
        sessionId: 'session-finished',
      );

      await makeProcessor().clearResolvedRequests([
        answered,
        pending,
        finished,
      ]);

      final answeredIds = attentionNotificationIdsForEvent(
        brokerProfileId: _profileId,
        event: answered,
      );
      expect(notificationSink.clearedIds.toSet(), answeredIds);
      expect(
        answeredIds,
        contains(
          brokerAttentionNotificationId(
            brokerProfileId: _profileId,
            dedupeKey: answered.dedupeKey,
          ),
        ),
      );
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
  Map<String, Object?> extra = const {},
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
    ...extra,
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

/// Scriptable stand-in for the other windows of this app.
final class _ScriptedCoordinator implements AttentionPresentationCoordinator {
  _ScriptedCoordinator({this.log, this.beforeEnter});

  final List<String>? log;
  final Future<Object?> Function()? beforeEnter;
  bool otherInForeground = false;
  int foregroundQueries = 0;

  @override
  Future<void> exclusive(String scopeKey, Future<void> Function() body) async {
    await beforeEnter?.call();
    log?.add('enter $scopeKey');
    try {
      await body();
    } finally {
      log?.add('exit $scopeKey');
    }
  }

  @override
  Future<bool> anotherWindowInForeground() async {
    foregroundQueries += 1;
    return otherInForeground;
  }

  @override
  void dispose() {}
}

class _FailingAwareNotificationSink implements BrokerNotificationSink {
  final List<BrokerNotificationRequest> requests = [];
  final List<String> shownEventIds = [];
  final List<String> clearedIds = [];

  /// Scripted results, consumed one per show; `shown` once empty.
  final List<BrokerNotificationDeliveryResult> nextResults = [];

  /// Called on every show.
  void Function()? onShow;

  @override
  Future<BrokerNotificationDeliveryResult> show(
    BrokerNotificationRequest request,
  ) async {
    onShow?.call();
    requests.add(request);
    final result = nextResults.isEmpty
        ? BrokerNotificationDeliveryResult.shown
        : nextResults.removeAt(0);
    final eventId = request.payload['eventId'];
    if (eventId is String &&
        result.outcome == BrokerNotificationDeliveryOutcome.shown) {
      shownEventIds.add(eventId);
    }
    return result;
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
