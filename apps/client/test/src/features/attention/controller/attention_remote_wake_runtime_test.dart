import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_remote_wake_runtime.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

void main() {
  test(
    'opaque wake refetch persists and presents a fetched revision',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);
      server.listen((request) async {
        request.response.headers.contentType = ContentType.json;
        request.response.write(
          jsonEncode({
            'ok': true,
            'events': [
              {
                'id': 'wake-event',
                'cursor': 1,
                'revision': 1,
                'presentationRevision': 1,
                'kind': 'runtime-update-ready',
                'state': 'active',
                'severity': 'maintenance',
                'dedupeKey': 'wake-event',
                'createdAt': 1,
                'updatedAt': 1,
                'title': 'Update ready',
                'action': {'kind': 'open-runtime-settings'},
              },
            ],
            'cursor': 1,
            'reset': false,
            'hasMore': false,
          }),
        );
        await request.response.close();
      });
      final database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      final repository = DriftAttentionRepository(database);
      final sink = _CollectingSink();
      final profile = BrokerProfile(
        id: 'wake-profile',
        displayName: 'Wake profile',
        baseUri: Uri.parse('http://127.0.0.1:${server.port}'),
        createdAt: DateTime(2026),
      );

      await refetchAttentionProfilesAfterWake(
        profiles: [profile],
        enabledProfileIds: {profile.id},
        clientId: 'phone',
        repository: repository,
        createClient: (profile) async =>
            BrokerClient(baseUrl: profile.baseUri.toString()),
        isCurrentSource: (_) async => true,
        createDeliveryProcessor: (profile, isCurrentSource) =>
            AttentionFeedDeliveryProcessor(
              repository: repository,
              brokerProfileId: profile.id,
              brokerScopeKey: _scope(profile),
              lifecycleMonitor: _BackgroundLifecycleMonitor(),
              notificationSink: sink,
              onForegroundEvent: (_) async {},
              isCurrentSource: isCurrentSource,
            ),
      );

      expect(sink.requests, hasLength(1));
      expect(sink.requests.single.payload['eventId'], 'wake-event');
      final states = await repository.loadDeliveryStates(_scope(profile));
      expect(states.single.localPresentedRevision, 1);
      expect(await repository.loadCursor(_scope(profile)), 1);
    },
  );

  test(
    'opaque wake source change during persistence suppresses presentation',
    () async {
      final database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      final repository = _HeldDriftAttentionRepository(database);
      final profile = BrokerProfile(
        id: 'wake-profile-retired',
        displayName: 'Wake profile retired',
        baseUri: Uri.parse('http://127.0.0.1:7734'),
        createdAt: DateTime(2026),
        incarnationId: 'inc-a',
      );
      final sink = _CollectingSink();
      final client = _MockBrokerClient();
      when(
        () => client.getAttentionEvents(
          clientId: any(named: 'clientId'),
          after: any(named: 'after'),
          limit: any(named: 'limit'),
          waitMs: any(named: 'waitMs'),
          cancelToken: any(named: 'cancelToken'),
        ),
      ).thenAnswer(
        (_) async => AttentionEventsPage(
          events: [
            _jsonEvent(id: 'retired-wake-event', cursor: 1),
          ],
          cursor: 1,
          reset: false,
          hasMore: false,
        ),
      );
      when(client.close).thenReturn(null);
      var sourceIsCurrent = true;

      final refetch = refetchAttentionProfilesAfterWake(
        profiles: [profile],
        enabledProfileIds: {profile.id},
        clientId: 'phone',
        repository: repository,
        createClient: (_) async => client,
        isCurrentSource: (_) async => sourceIsCurrent,
        createDeliveryProcessor: (profile, isCurrentSource) =>
            AttentionFeedDeliveryProcessor(
              repository: repository,
              brokerProfileId: profile.id,
              brokerScopeKey: _scope(profile),
              lifecycleMonitor: _BackgroundLifecycleMonitor(),
              notificationSink: sink,
              onForegroundEvent: (_) async {},
              isCurrentSource: isCurrentSource,
            ),
      );
      await repository.persistenceStarted.future;

      sourceIsCurrent = false;
      repository.releasePersistence.complete();
      await refetch;

      expect(sink.requests, isEmpty);
      final states = await repository.loadDeliveryStates(_scope(profile));
      expect(states.single.localPresentedRevision, 0);
      expect(await repository.loadCursor(_scope(profile)), 1);
    },
  );

  test(
    'opaque wake repoint during alias cleanup suppresses presentation',
    () async {
      final database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      final repository = DriftAttentionRepository(database);
      final profile = BrokerProfile(
        id: 'wake-profile-alias-retired',
        displayName: 'Wake profile alias retired',
        baseUri: Uri.parse('http://127.0.0.1:7734'),
        createdAt: DateTime(2026),
        incarnationId: 'inc-a',
      );
      final scope = _scope(profile);
      await repository.persistAttentionEventsPage(
        brokerProfileId: scope,
        page: AttentionEventsPage(
          events: [
            _jsonEvent(
              id: 'retired-during-alias-cleanup',
              cursor: 1,
            ),
          ],
          cursor: 1,
          reset: false,
          hasMore: false,
        ),
      );
      await repository.advancePresentedRevision(
        brokerProfileId: scope,
        eventId: 'retired-during-alias-cleanup',
        presentedRevision: 1,
      );

      final sink = _HeldAliasSink();
      final client = _MockBrokerClient();
      when(
        () => client.getAttentionEvents(
          clientId: any(named: 'clientId'),
          after: any(named: 'after'),
          limit: any(named: 'limit'),
          waitMs: any(named: 'waitMs'),
          cancelToken: any(named: 'cancelToken'),
        ),
      ).thenAnswer(
        (_) async => AttentionEventsPage(
          events: [
            _jsonEvent(
              id: 'retired-during-alias-cleanup',
              cursor: 2,
              revision: 2,
              presentationRevision: 2,
            ),
          ],
          cursor: 2,
          reset: false,
          hasMore: false,
        ),
      );
      when(client.close).thenReturn(null);
      var sourceIsCurrent = true;

      final refetch = refetchAttentionProfilesAfterWake(
        profiles: [profile],
        enabledProfileIds: {profile.id},
        clientId: 'phone',
        repository: repository,
        createClient: (_) async => client,
        isCurrentSource: (_) async => sourceIsCurrent,
        createDeliveryProcessor: (profile, isCurrentSource) =>
            AttentionFeedDeliveryProcessor(
              repository: repository,
              brokerProfileId: profile.id,
              brokerScopeKey: _scope(profile),
              lifecycleMonitor: _BackgroundLifecycleMonitor(),
              notificationSink: sink,
              onForegroundEvent: (_) async {},
              isCurrentSource: isCurrentSource,
            ),
      );
      await sink.clearStarted.future;

      sourceIsCurrent = false;
      sink.releaseClear.complete();
      await refetch;

      expect(sink.requests, isEmpty);
      final states = await repository.loadDeliveryStates(scope);
      expect(states.single.localPresentedRevision, 1);
    },
  );

  test(
    'uses durable cursor when wake refetch receives stale response',
    () async {
      final database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      final repository = DriftAttentionRepository(database);
      final profile = BrokerProfile(
        id: 'wake-profile-stable-cursor',
        displayName: 'Wake profile stable',
        baseUri: Uri.parse('http://127.0.0.1:7734'),
        createdAt: DateTime(2026),
      );
      final sink = _CollectingSink();
      final calls = <int>[];
      final pages = [
        AttentionEventsPage(
          events: [
            _jsonEvent(id: 'wake-race', cursor: 10, revision: 3),
          ],
          cursor: 10,
          reset: false,
          hasMore: true,
        ),
        AttentionEventsPage(
          events: [
            _jsonEvent(id: 'wake-race', cursor: 5),
          ],
          cursor: 5,
          reset: false,
          hasMore: true,
        ),
        AttentionEventsPage(
          events: [
            _jsonEvent(id: 'wake-race', cursor: 11, revision: 4),
          ],
          cursor: 11,
          reset: false,
          hasMore: false,
        ),
      ];
      var call = 0;
      final client = _MockBrokerClient();
      when(
        () => client.getAttentionEvents(
          clientId: any(named: 'clientId'),
          after: any(named: 'after'),
          limit: any(named: 'limit'),
          waitMs: any(named: 'waitMs'),
          cancelToken: any(named: 'cancelToken'),
        ),
      ).thenAnswer((invocation) {
        calls.add(invocation.namedArguments[#after] as int);
        if (call >= pages.length) {
          return Future.value(
            const AttentionEventsPage(
              events: [],
              cursor: 11,
              reset: false,
              hasMore: false,
            ),
          );
        }
        final result = pages[call];
        call += 1;
        return Future.value(result);
      });
      when(client.close).thenReturn(null);

      await refetchAttentionProfilesAfterWake(
        profiles: [profile],
        enabledProfileIds: {profile.id},
        clientId: 'phone',
        repository: repository,
        createClient: (_) async => client,
        isCurrentSource: (_) async => true,
        createDeliveryProcessor: (profile, isCurrentSource) =>
            AttentionFeedDeliveryProcessor(
              repository: repository,
              brokerProfileId: profile.id,
              brokerScopeKey: _scope(profile),
              lifecycleMonitor: _BackgroundLifecycleMonitor(),
              notificationSink: sink,
              onForegroundEvent: (_) async {},
              isCurrentSource: isCurrentSource,
            ),
      );

      expect(calls.take(3), [0, 10, 10]);
      final states = await repository.loadDeliveryStates(_scope(profile));
      expect(states.single.event.summary, 'summary');
    },
  );

  test('reports catch-up deferred after the bounded wake page cap', () async {
    final database = AppDatabase(NativeDatabase.memory());
    addTearDown(database.close);
    final repository = DriftAttentionRepository(database);
    final profile = BrokerProfile(
      id: 'wake-profile-deferred',
      displayName: 'Wake profile deferred',
      baseUri: Uri.parse('http://127.0.0.1:7734'),
      createdAt: DateTime(2026),
    );
    final client = _MockBrokerClient();
    var calls = 0;
    when(
      () => client.getAttentionEvents(
        clientId: any(named: 'clientId'),
        after: any(named: 'after'),
        limit: any(named: 'limit'),
        waitMs: any(named: 'waitMs'),
        cancelToken: any(named: 'cancelToken'),
      ),
    ).thenAnswer((_) async {
      calls += 1;
      return AttentionEventsPage(
        events: const [],
        cursor: calls,
        reset: false,
        hasMore: true,
      );
    });
    when(client.close).thenReturn(null);

    final result = await refetchAttentionProfilesAfterWake(
      profiles: [profile],
      enabledProfileIds: {profile.id},
      clientId: 'phone',
      repository: repository,
      createClient: (_) async => client,
      isCurrentSource: (_) async => true,
      createDeliveryProcessor: (profile, isCurrentSource) =>
          AttentionFeedDeliveryProcessor(
            repository: repository,
            brokerProfileId: profile.id,
            brokerScopeKey: _scope(profile),
            lifecycleMonitor: _BackgroundLifecycleMonitor(),
            notificationSink: _CollectingSink(),
            onForegroundEvent: (_) async {},
            isCurrentSource: isCurrentSource,
          ),
    );

    expect(calls, attentionWakeMaxPages);
    expect(result.deferredProfileIds, {profile.id});
  });

  test('starts enabled profiles and revokes removed registrations', () async {
    final registrations = <String, _FakeRegistration>{};
    final coordinator = RemoteWakeCoordinator(
      createRegistration: (profile) async =>
          registrations.putIfAbsent(profile.id, _FakeRegistration.new),
    );

    await coordinator.reconcile(
      enabled: true,
      profiles: [_profile('one'), _profile('two')],
      enabledProfileIds: {'one', 'two'},
    );
    await coordinator.reconcile(
      enabled: true,
      profiles: [_profile('one'), _profile('two')],
      enabledProfileIds: {'one'},
    );

    expect(registrations['one']!.startCalls, 1);
    expect(registrations['one']!.revokeCalls, 0);
    expect(registrations['two']!.revokeCalls, 1);
    expect(registrations['two']!.stopCalls, 1);
    await coordinator.stop(revoke: false);
  });

  test('global opt-out revokes every active profile', () async {
    final registrations = <String, _FakeRegistration>{};
    final coordinator = RemoteWakeCoordinator(
      createRegistration: (profile) async =>
          registrations.putIfAbsent(profile.id, _FakeRegistration.new),
    );
    await coordinator.reconcile(
      enabled: true,
      profiles: [_profile('one'), _profile('two')],
      enabledProfileIds: {'one', 'two'},
    );

    await coordinator.reconcile(
      enabled: false,
      profiles: [_profile('one'), _profile('two')],
      enabledProfileIds: {'one', 'two'},
    );

    expect(
      registrations.values.map((item) => item.revokeCalls),
      everyElement(1),
    );
    expect(registrations.values.map((item) => item.stopCalls), everyElement(1));
    await coordinator.stop(revoke: false);
  });

  test(
    'repointing an enabled profile revokes A before registering B',
    () async {
      final registrations = <_FakeRegistration>[];
      final endpoints = <Uri>[];
      final coordinator = RemoteWakeCoordinator(
        createRegistration: (profile) async {
          endpoints.add(profile.baseUri);
          final registration = _FakeRegistration();
          registrations.add(registration);
          return registration;
        },
      );

      await coordinator.reconcile(
        enabled: true,
        profiles: [_profileAt('one', 'http://alpha.test')],
        enabledProfileIds: {'one'},
      );
      await coordinator.reconcile(
        enabled: true,
        profiles: [_profileAt('one', 'http://beta.test')],
        enabledProfileIds: {'one'},
      );

      expect(endpoints.map((uri) => uri.host), ['alpha.test', 'beta.test']);
      expect(registrations, hasLength(2));
      expect(registrations.first.revokeCalls, 1);
      expect(registrations.first.stopCalls, 1);
      expect(registrations.last.startCalls, 1);
      await coordinator.stop(revoke: false);
    },
  );

  test('one failed profile does not block healthy registration', () async {
    final errors = <String>[];
    final good = _FakeRegistration();
    final coordinator = RemoteWakeCoordinator(
      createRegistration: (profile) async =>
          profile.id == 'bad' ? _FakeRegistration(failStart: true) : good,
      onProfileError: (profileId, _) => errors.add(profileId),
    );

    await coordinator.reconcile(
      enabled: true,
      profiles: [_profile('bad'), _profile('good')],
      enabledProfileIds: {'bad', 'good'},
    );

    expect(errors, ['bad']);
    expect(good.startCalls, 1);
    await coordinator.stop(revoke: false);
  });
}

BrokerProfile _profile(String id) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse('http://127.0.0.1:7734/$id'),
  createdAt: DateTime(2026),
);

BrokerProfile _profileAt(String id, String endpoint) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse(endpoint),
  createdAt: DateTime(2026),
);

String _scope(BrokerProfile profile) =>
    RosterSource.ofProfile(profile).storageKey;

AttentionEventView _jsonEvent({
  required String id,
  required int cursor,
  int revision = 1,
  int presentationRevision = 1,
  String summary = 'summary',
}) {
  return AttentionEventView.fromJson(<String, dynamic>{
    'id': id,
    'cursor': cursor,
    'revision': revision,
    'presentationRevision': presentationRevision,
    'kind': 'runtime-update-ready',
    'state': 'active',
    'severity': 'maintenance',
    'dedupeKey': id,
    'createdAt': 1,
    'updatedAt': 2,
    'title': 'wake title',
    'summary': summary,
    'action': {'kind': 'open-runtime-settings'},
  });
}

class _MockBrokerClient extends Mock implements BrokerClient {}

final class _FakeRegistration implements RemoteWakeRegistration {
  _FakeRegistration({this.failStart = false});

  final bool failStart;
  int startCalls = 0;
  int stopCalls = 0;
  int revokeCalls = 0;

  @override
  Future<void> start() async {
    startCalls += 1;
    if (failStart) throw StateError('offline');
  }

  @override
  Future<void> stop() async => stopCalls += 1;

  @override
  Future<void> revoke() async => revokeCalls += 1;
}

class _CollectingSink implements BrokerNotificationSink {
  final List<BrokerNotificationRequest> requests = [];

  @override
  Future<void> show(BrokerNotificationRequest request) async {
    requests.add(request);
  }

  @override
  Future<void> clear(String id) async {}

  @override
  Future<void> clearMany(Iterable<String> ids) async {}

  @override
  Future<void> clearAll() async {}
}

final class _HeldAliasSink extends _CollectingSink {
  final clearStarted = Completer<void>();
  final releaseClear = Completer<void>();

  @override
  Future<void> clearMany(Iterable<String> ids) async {
    clearStarted.complete();
    await releaseClear.future;
    await super.clearMany(ids);
  }
}

final class _HeldDriftAttentionRepository extends DriftAttentionRepository {
  _HeldDriftAttentionRepository(super.database);

  final persistenceStarted = Completer<void>();
  final releasePersistence = Completer<void>();

  @override
  Future<void> persistAttentionEventsPage({
    required String brokerProfileId,
    required AttentionEventsPage page,
  }) async {
    persistenceStarted.complete();
    await releasePersistence.future;
    await super.persistAttentionEventsPage(
      brokerProfileId: brokerProfileId,
      page: page,
    );
  }
}

final class _BackgroundLifecycleMonitor implements BrokerAppLifecycleMonitor {
  @override
  BrokerAppLifecycleState get currentState => BrokerAppLifecycleState.paused;

  @override
  Stream<BrokerAppLifecycleState> get stateChanges =>
      const Stream<BrokerAppLifecycleState>.empty();

  @override
  void dispose() {}
}
