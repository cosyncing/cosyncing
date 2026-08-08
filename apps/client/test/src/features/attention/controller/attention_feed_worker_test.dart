import 'dart:async';
import 'dart:collection';

// Test setup intentionally uses explicit start/process/stop statements; a
// cascade would obscure lifecycle ordering. Long descriptive names document
// notification-policy contracts.
// ignore_for_file: cascade_invocations, lines_longer_than_80_chars

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_worker.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

const String _clientId = 'attention-client-id';
const String _brokerProfileId = 'broker-profile-id';

void main() {
  late _MockBrokerClient brokerClient;
  late _InMemoryAttentionRepository repository;

  setUp(() {
    brokerClient = _MockBrokerClient();
    repository = _InMemoryAttentionRepository(profileId: _brokerProfileId);
  });

  Future<void> advanceToProcess() async {
    await Future<void>.delayed(Duration.zero);
  }

  group('AttentionFeedWorker', () {
    test(
      'presents only after persistence and presentation revision checks',
      () async {
        final lifecycle = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.hidden,
        );
        final sink = _CollectingNotificationSink();
        final trace = <String>[];
        final response = AttentionEventsPage(
          events: [
            _attentionEvent(
              id: 'evt-1',
              kind: 'run-finished',
              actionTool: 'claude',
              actionSessionId: 'session-1',
              presentationRevision: 3,
            ),
          ],
          cursor: 1,
          reset: false,
          hasMore: false,
        );

        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            response,
            response,
          ],
        );

        repository.onPersist = (eventIds) {
          trace.add('persist:${eventIds.join(',')}');
        };
        sink.onShow = (request) {
          trace.add('present:${request.payload['eventId']}');
        };

        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          onSupportChanged: (state) {
            trace.add('support:${state.name}');
          },
          sleep: (_) async {},
        );

        worker.start();
        await advanceToProcess();
        await worker.stop();

        expect(trace, [
          'persist:evt-1',
          'support:supported',
          'present:evt-1',
        ]);
        expect(
          repository.getStoredPresentedRevision('evt-1'),
          equals(3),
        );
      },
    );

    test(
      'stop during persistence suppresses every retired-source publication',
      () async {
        final foregroundEvents = <String>[];
        final platformNotifications = <BrokerNotificationRequest>[];
        final supportStates = <AttentionFeedSupportState>[];
        final persistedPages = <AttentionEventsPage>[];

        for (final lifecycleState in [
          BrokerAppLifecycleState.hidden,
          BrokerAppLifecycleState.resumed,
        ]) {
          final heldRepository = _InMemoryAttentionRepository(
            profileId: _brokerProfileId,
          );
          final persistenceStarted = Completer<void>();
          final releasePersistence = Completer<void>();
          heldRepository.onPersistAsync = (_) async {
            persistenceStarted.complete();
            await releasePersistence.future;
          };
          final client = _MockBrokerClient();
          _stubGetAttentionEvents(
            client: client,
            outcomes: [
              AttentionEventsPage(
                events: [
                  _attentionEvent(
                    id: 'retired-${lifecycleState.name}',
                    kind: 'run-finished',
                    actionTool: 'codex',
                    actionSessionId: 'session-retired',
                  ),
                ],
                cursor: 1,
                reset: false,
                hasMore: false,
              ),
            ],
          );
          final sink = _CollectingNotificationSink()
            ..onShow = platformNotifications.add;
          final worker = AttentionFeedWorker(
            brokerClient: client,
            repository: heldRepository,
            brokerProfileId: _brokerProfileId,
            clientId: _clientId,
            lifecycleMonitor: _StubLifecycleMonitor(
              currentState: lifecycleState,
            ),
            notificationSink: sink,
            onForegroundEvent: (event) async {
              foregroundEvents.add(event.id);
            },
            onSupportChanged: supportStates.add,
            onPagePersisted: (page) async {
              persistedPages.add(page);
            },
            sleep: (_) async {},
          );

          worker.start();
          await persistenceStarted.future;
          final stopping = worker.stop();
          await Future<void>.delayed(Duration.zero);
          releasePersistence.complete();
          await stopping;
        }

        expect(foregroundEvents, isEmpty);
        expect(platformNotifications, isEmpty);
        expect(supportStates, isEmpty);
        expect(persistedPages, isEmpty);
      },
    );

    test(
      'stop during pending-presentation load suppresses retired delivery',
      () async {
        await repository.persistAttentionEventsPage(
          brokerProfileId: _brokerProfileId,
          page: AttentionEventsPage(
            events: [
              _attentionEvent(
                id: 'retired-during-presentation-load',
                kind: 'run-finished',
                actionTool: 'codex',
                actionSessionId: 'session-retired-load',
              ),
            ],
            cursor: 1,
            reset: false,
            hasMore: false,
          ),
        );
        final loadStarted = Completer<void>();
        final releaseLoad = Completer<void>();
        repository.onLoadPendingPresentations = () async {
          loadStarted.complete();
          await releaseLoad.future;
        };
        final sink = _CollectingNotificationSink();
        final foregroundEvents = <String>[];
        final supportStates = <AttentionFeedSupportState>[];
        final persistedPages = <AttentionEventsPage>[];
        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: _StubLifecycleMonitor(
            currentState: BrokerAppLifecycleState.hidden,
          ),
          notificationSink: sink,
          onForegroundEvent: (event) async {
            foregroundEvents.add(event.id);
          },
          onSupportChanged: supportStates.add,
          onPagePersisted: (page) async {
            persistedPages.add(page);
          },
          sleep: (_) async {},
        );

        worker.start();
        await loadStarted.future;
        final stopping = worker.stop();
        releaseLoad.complete();
        await stopping;

        expect(sink.shown, isEmpty);
        expect(foregroundEvents, isEmpty);
        expect(supportStates, isEmpty);
        expect(persistedPages, isEmpty);
        expect(
          repository.getStoredPresentedRevision(
            'retired-during-presentation-load',
          ),
          0,
        );
      },
    );

    test(
      'suppresses repeated presentation across restart when revision is unchanged',
      () async {
        final lifecycle = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.hidden,
        );
        final sink = _CollectingNotificationSink();
        final response = AttentionEventsPage(
          events: [
            _attentionEvent(
              id: 'evt-2',
              kind: 'run-finished',
              actionTool: 'claude',
              actionSessionId: 'session-1',
              presentationRevision: 4,
            ),
          ],
          cursor: 3,
          reset: false,
          hasMore: false,
        );

        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            response,
          ],
        );

        final firstWorker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        firstWorker.start();
        await advanceToProcess();
        await firstWorker.stop();
        expect(sink.shown, hasLength(1));

        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [response],
        );
        sink.shown.clear();

        final secondWorker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        secondWorker.start();
        await advanceToProcess();
        await secondWorker.stop();

        expect(sink.shown, isEmpty);
      },
    );

    test(
      'reconciles presentation failures per event without losing cursor or other events',
      () async {
        final lifecycle = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.hidden,
        );
        final sink = _FailingNotificationSink(failingEventIds: {'evt-failed'});
        final response = AttentionEventsPage(
          events: [
            _attentionEvent(
              id: 'evt-failed',
              kind: 'run-finished',
              actionTool: 'tool-x',
              actionSessionId: 'session-1',
              presentationRevision: 2,
            ),
            _attentionEvent(
              id: 'evt-ok',
              kind: 'run-finished',
              actionTool: 'tool-x',
              actionSessionId: 'session-2',
              presentationRevision: 2,
            ),
          ],
          cursor: 2,
          reset: false,
          hasMore: false,
        );

        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            response,
            response,
          ],
        );

        final firstWorker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        firstWorker.start();
        await advanceToProcess();
        await firstWorker.stop();

        expect(sink.shown, hasLength(1));
        expect(sink.shown.map((req) => req.payload['eventId']), ['evt-ok']);
        expect(repository.getStoredPresentedRevision('evt-failed'), 0);
        expect(repository.getStoredPresentedRevision('evt-ok'), 2);
        expect(await repository.loadCursor(_brokerProfileId), 2);

        sink.failingEventIds.clear();

        final secondWorker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );
        sink.shown.clear();

        secondWorker.start();
        await advanceToProcess();
        await secondWorker.stop();

        expect(sink.shown, hasLength(1));
        expect(sink.shown.map((req) => req.payload['eventId']), ['evt-failed']);
        expect(repository.getStoredPresentedRevision('evt-failed'), 2);
      },
    );

    test(
      'uses durable cursor when a stale response arrives after a newer one',
      () async {
        final database = AppDatabase(NativeDatabase.memory());
        addTearDown(database.close);
        final durableRepository = DriftAttentionRepository(database);
        final afterCalls = <int>[];
        final pages = [
          AttentionEventsPage(
            events: [
              _attentionEvent(
                id: 'evt-race',
                kind: 'run-finished',
                actionTool: 'tool-r',
                actionSessionId: 'session-r',
                cursor: 10,
                summary: 'newer',
              ),
            ],
            cursor: 10,
            reset: false,
            hasMore: true,
          ),
          AttentionEventsPage(
            events: [
              _attentionEvent(
                id: 'evt-race',
                kind: 'run-finished',
                actionTool: 'tool-r',
                actionSessionId: 'session-r',
                cursor: 5,
                summary: 'stale',
              ),
            ],
            cursor: 5,
            reset: false,
            hasMore: true,
          ),
          AttentionEventsPage(
            events: [
              _attentionEvent(
                id: 'evt-race',
                kind: 'run-finished',
                actionTool: 'tool-r',
                actionSessionId: 'session-r',
                cursor: 11,
                summary: 'latest',
              ),
            ],
            cursor: 11,
            reset: false,
            hasMore: false,
          ),
        ];
        var call = 0;
        when(
          () => brokerClient.getAttentionEvents(
            clientId: _clientId,
            after: any(named: 'after'),
            limit: any(named: 'limit'),
            waitMs: any(named: 'waitMs'),
            cancelToken: any(named: 'cancelToken'),
          ),
        ).thenAnswer((invocation) async {
          afterCalls.add(invocation.namedArguments[#after] as int);
          if (call >= pages.length) {
            return const AttentionEventsPage(
              events: [],
              cursor: 11,
              reset: false,
              hasMore: false,
            );
          }
          final outcome = pages[call];
          call += 1;
          return outcome;
        });

        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: durableRepository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: _StubLifecycleMonitor(
            currentState: BrokerAppLifecycleState.hidden,
          ),
          notificationSink: _CollectingNotificationSink(),
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        worker.start();
        for (
          var attempt = 0;
          attempt < 100 && afterCalls.length < 3;
          attempt += 1
        ) {
          await Future<void>.delayed(const Duration(milliseconds: 5));
        }
        await worker.stop();

        expect(afterCalls.length, greaterThanOrEqualTo(3));
        expect(afterCalls[0], 0);
        expect(afterCalls[1], 10);
        expect(afterCalls[2], 10);
        expect(await durableRepository.loadCursor(_brokerProfileId), 11);
      },
    );

    test(
      'keeps resolved completion events as history and advances presentation cursor',
      () async {
        final lifecycle = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.hidden,
        );
        final sink = _CollectingNotificationSink();
        final response = AttentionEventsPage(
          events: [
            _attentionEvent(
              id: 'evt-history',
              kind: 'run-finished',
              state: 'resolved',
              actionTool: 'tool-y',
              actionSessionId: 'session-3',
              presentationRevision: 7,
            ),
            _attentionEvent(
              id: 'evt-maint',
              kind: 'runtime-update-ready',
              actionTool: 'tool-y',
              actionSessionId: 'session-4',
              cursor: 2,
              presentationRevision: 2,
            ),
          ],
          cursor: 7,
          reset: false,
          hasMore: false,
          baselineThroughCursor: 1,
        );

        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [response],
        );

        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        worker.start();
        await advanceToProcess();
        await worker.stop();

        expect(sink.shown, hasLength(1));
        expect(sink.shown.single.payload['eventId'], 'evt-maint');
        final rows = await repository.loadEvents(_brokerProfileId);
        final historyRow = rows.firstWhere((row) => row.id == 'evt-history');
        final maintRow = rows.firstWhere((row) => row.id == 'evt-maint');
        expect(historyRow.state, 'resolved');
        expect(maintRow.state, 'active');
        expect(repository.getStoredPresentedRevision('evt-history'), 0);
        expect(repository.getStoredPresentedRevision('evt-maint'), 2);
      },
    );

    test('invokes foreground callback when app is foregrounded', () async {
      final lifecycle = _StubLifecycleMonitor(
        currentState: BrokerAppLifecycleState.resumed,
      );
      final events = <AttentionEventView>[];

      _stubGetAttentionEvents(
        client: brokerClient,
        outcomes: [
          AttentionEventsPage(
            events: [
              _attentionEvent(
                id: 'evt-fg',
                kind: 'permission-required',
                actionTool: 'claude',
                actionSessionId: 'session-1',
              ),
            ],
            cursor: 1,
            reset: false,
            hasMore: false,
          ),
        ],
      );

      final worker = AttentionFeedWorker(
        brokerClient: brokerClient,
        repository: repository,
        brokerProfileId: _brokerProfileId,
        clientId: _clientId,
        lifecycleMonitor: lifecycle,
        notificationSink: _CollectingNotificationSink(),
        onForegroundEvent: (event) async {
          events.add(event);
        },
        sleep: (_) async {},
      );

      worker.start();
      await advanceToProcess();
      await worker.stop();

      expect(events, hasLength(1));
      expect(events.single.id, 'evt-fg');
    });

    test(
      'suppresses foreground callback for run-failed when session is currently focused',
      () async {
        final lifecycle = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.resumed,
        );
        final foregroundEvents = <String>[];

        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            AttentionEventsPage(
              events: [
                _attentionEvent(
                  id: 'evt-failed',
                  kind: 'run-failed',
                  actionTool: 'tool-a',
                  actionSessionId: 'session-1',
                  presentationRevision: 2,
                ),
              ],
              cursor: 1,
              reset: false,
              hasMore: false,
            ),
          ],
        );

        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: _CollectingNotificationSink(),
          onForegroundEvent: (event) async {
            foregroundEvents.add(event.id);
          },
          focusMatcher:
              ({
                required String? tool,
                required String? agent,
                required String? sessionId,
              }) {
                return tool == 'tool-a' && sessionId == 'session-1';
              },
          sleep: (_) async {},
        );

        worker.start();
        await advanceToProcess();
        await worker.stop();

        expect(foregroundEvents, isEmpty);
      },
    );

    test(
      'F4c suppresses the foreground banner for the exact visible session, '
      'keeps it for every other session/profile, and cannot be replayed',
      () async {
        final lifecycle = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.resumed,
        );
        final foregroundEvents = <String>[];

        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            AttentionEventsPage(
              events: [
                // Exact match on profile (this worker's), tool AND session.
                _attentionEvent(
                  id: 'evt-visible',
                  kind: 'run-finished',
                  actionTool: 'tool-a',
                  actionSessionId: 'session-1',
                  presentationRevision: 2,
                ),
                // Same tool, different session.
                _attentionEvent(
                  id: 'evt-other-session',
                  kind: 'run-finished',
                  actionTool: 'tool-a',
                  actionSessionId: 'session-2',
                  presentationRevision: 2,
                ),
                // Same session id, different tool.
                _attentionEvent(
                  id: 'evt-other-tool',
                  kind: 'run-finished',
                  actionTool: 'tool-b',
                  actionSessionId: 'session-1',
                  presentationRevision: 2,
                ),
                // Needs input on the very same visible session still presents:
                // it asks the user for something the transcript cannot.
                _attentionEvent(
                  id: 'evt-needs-input',
                  kind: 'permission-required',
                  actionTool: 'tool-a',
                  actionSessionId: 'session-1',
                  presentationRevision: 2,
                ),
              ],
              cursor: 1,
              reset: false,
              hasMore: false,
            ),
          ],
        );

        AttentionFeedWorker buildWorker() => AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: _CollectingNotificationSink(),
          onForegroundEvent: (event) async {
            foregroundEvents.add(event.id);
          },
          focusMatcher:
              ({
                required String? tool,
                required String? agent,
                required String? sessionId,
              }) => tool == 'tool-a' && sessionId == 'session-1',
          sleep: (_) async {},
        );

        final worker = buildWorker();
        worker.start();
        await advanceToProcess();
        await worker.stop();

        expect(
          foregroundEvents,
          unorderedEquals(<String>[
            'evt-other-session',
            'evt-other-tool',
            'evt-needs-input',
          ]),
          reason:
              'only the exact visible profile/tool/session completion is '
              'suppressed',
        );

        // The durable row survives: suppression advances the presentation
        // watermark, it does not dismiss or mark the event read.
        final states = await repository.loadPendingPresentations(
          _brokerProfileId,
        );
        expect(
          states.where((state) => state.event.id == 'evt-visible'),
          isEmpty,
          reason: 'the suppressed revision is consumed, not left pending',
        );
        final stored = await repository.loadDeliveryStates(_brokerProfileId);
        final suppressed = stored.singleWhere(
          (state) => state.event.id == 'evt-visible',
        );
        expect(suppressed.event.dismissedAt, isNull);
        expect(suppressed.localReadAt, isNull);
        expect(suppressed.localPresentedRevision, 2);

        // Replay the identical page: the watermark keeps it suppressed even if
        // the user has since navigated away (the matcher no longer matches).
        foregroundEvents.clear();
        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            AttentionEventsPage(
              events: [
                _attentionEvent(
                  id: 'evt-visible',
                  kind: 'run-finished',
                  actionTool: 'tool-a',
                  actionSessionId: 'session-1',
                  presentationRevision: 2,
                ),
              ],
              cursor: 1,
              reset: false,
              hasMore: false,
            ),
          ],
        );
        final replayWorker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: _CollectingNotificationSink(),
          onForegroundEvent: (event) async {
            foregroundEvents.add(event.id);
          },
          sleep: (_) async {},
        );
        replayWorker.start();
        await advanceToProcess();
        await replayWorker.stop();

        expect(
          foregroundEvents,
          isEmpty,
          reason: 'a suppressed event must not resurface after navigation',
        );
      },
    );

    test(
      'keeps metadata generic and distinguishes maintenance from critical broker health',
      () async {
        final lifecycle = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.hidden,
        );
        final sink = _CollectingNotificationSink();

        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            AttentionEventsPage(
              events: [
                _attentionEvent(
                  id: 'evt-maint',
                  kind: 'runtime-update-ready',
                  actionTool: 'tool-b',
                  actionSessionId: 'session-7',
                  summary: 'full prompt text that should not be copied',
                  presentationRevision: 9,
                ),
                _attentionEvent(
                  id: 'evt-health-critical',
                  kind: 'broker-health',
                  severity: 'action-required',
                  actionTool: 'broker',
                  actionSessionId: 'none',
                  actionKind: 'open-broker-health',
                ),
              ],
              cursor: 1,
              reset: false,
              hasMore: false,
            ),
          ],
        );

        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        worker.start();
        await advanceToProcess();
        await worker.stop();

        expect(sink.shown, hasLength(2));
        final maintenance = sink.shown.singleWhere(
          (request) => request.payload['eventId'] == 'evt-maint',
        );
        expect(
          maintenance.category,
          BrokerNotificationCategory.maintenance,
        );
        expect(maintenance.importance, BrokerNotificationImportance.normal);
        expect(maintenance.body, isNot(contains('prompt')));
        expect(maintenance.payload['summary'], isNull);
        final critical = sink.shown.singleWhere(
          (request) => request.payload['eventId'] == 'evt-health-critical',
        );
        expect(
          critical.category,
          BrokerNotificationCategory.actionRequired,
        );
        expect(critical.importance, BrokerNotificationImportance.high);
      },
    );

    test(
      'maps unknown attention kinds to generic info/normal background notifications',
      () async {
        final lifecycle = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.hidden,
        );
        final sink = _CollectingNotificationSink();

        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            AttentionEventsPage(
              events: [
                _attentionEvent(
                  id: 'evt-unknown',
                  kind: 'future-kind',
                  actionTool: 'tool-c',
                  actionSessionId: 'session-2',
                ),
              ],
              cursor: 1,
              reset: false,
              hasMore: false,
            ),
          ],
        );

        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        worker.start();
        await advanceToProcess();
        await worker.stop();

        expect(sink.shown.single.category, BrokerNotificationCategory.info);
        expect(
          sink.shown.single.importance,
          BrokerNotificationImportance.normal,
        );
        expect(sink.shown.single.title, isNotEmpty);
      },
    );

    test(
      'maps security alerts to high security notifications',
      () async {
        final sink = _CollectingNotificationSink();
        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            AttentionEventsPage(
              events: [
                _attentionEvent(
                  id: 'evt-security',
                  kind: 'security-alert',
                  actionTool: 'broker',
                  actionSessionId: 'none',
                ),
              ],
              cursor: 1,
              reset: false,
              hasMore: false,
            ),
          ],
        );
        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: _StubLifecycleMonitor(
            currentState: BrokerAppLifecycleState.hidden,
          ),
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        worker.start();
        await advanceToProcess();
        await worker.stop();

        expect(
          sink.shown.single.category,
          BrokerNotificationCategory.actionRequired,
        );
        expect(sink.shown.single.importance, BrokerNotificationImportance.high);
      },
    );

    test(
      'maps successful pairing to a normal informational notification',
      () async {
        final sink = _CollectingNotificationSink();
        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            AttentionEventsPage(
              events: [
                _attentionEvent(
                  id: 'evt-paired',
                  kind: 'device-paired',
                  actionTool: 'broker',
                  actionSessionId: 'none',
                ),
              ],
              cursor: 1,
              reset: false,
              hasMore: false,
            ),
          ],
        );
        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: _StubLifecycleMonitor(
            currentState: BrokerAppLifecycleState.hidden,
          ),
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        worker.start();
        await advanceToProcess();
        await worker.stop();

        expect(sink.shown.single.category, BrokerNotificationCategory.info);
        expect(
          sink.shown.single.importance,
          BrokerNotificationImportance.normal,
        );
      },
    );

    test(
      'suppresses later presentation for locally dismissed events',
      () async {
        final lifecycle = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.hidden,
        );
        final sink = _CollectingNotificationSink();
        await repository.persistAttentionEventsPage(
          brokerProfileId: _brokerProfileId,
          page: AttentionEventsPage(
            events: [
              _attentionEvent(
                id: 'evt-dismiss',
                kind: 'run-finished',
                actionTool: 'tool-d',
                actionSessionId: 'session-3',
              ),
            ],
            cursor: 1,
            reset: false,
            hasMore: false,
          ),
        );
        await repository.markDismissed(_brokerProfileId, 'evt-dismiss');

        _stubGetAttentionEvents(
          client: brokerClient,
          outcomes: [
            AttentionEventsPage(
              events: [
                _attentionEvent(
                  id: 'evt-dismiss',
                  kind: 'run-finished',
                  actionTool: 'tool-d',
                  actionSessionId: 'session-3',
                ),
              ],
              cursor: 2,
              reset: false,
              hasMore: false,
            ),
          ],
        );

        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        worker.start();
        await advanceToProcess();
        await worker.stop();

        expect(sink.shown, isEmpty);
      },
    );

    test('tracks unsupported state and recovery', () async {
      final lifecycle = _StubLifecycleMonitor(
        currentState: BrokerAppLifecycleState.hidden,
      );
      final sink = _CollectingNotificationSink();
      final delays = <Duration>[];

      _stubGetAttentionEvents(
        client: brokerClient,
        outcomes: [
          const AttentionFeedUnsupportedException(
            message: 'unsupported',
          ),
          AttentionEventsPage(
            events: [
              _attentionEvent(
                id: 'evt-ok',
                kind: 'run-finished',
                actionTool: 'tool-e',
                actionSessionId: 'session-4',
              ),
            ],
            cursor: 1,
            reset: false,
            hasMore: false,
          ),
        ],
      );

      final worker = AttentionFeedWorker(
        brokerClient: brokerClient,
        repository: repository,
        brokerProfileId: _brokerProfileId,
        clientId: _clientId,
        lifecycleMonitor: lifecycle,
        notificationSink: sink,
        onForegroundEvent: (_) async {},
        sleep: (duration) async {
          delays.add(duration);
        },
      );

      worker.start();
      await advanceToProcess();
      await advanceToProcess();
      await worker.stop();

      expect(worker.supportsFeed, isTrue);
      expect(delays, [const Duration(milliseconds: 250)]);
      expect(sink.shown, hasLength(1));
    });

    test(
      'fetches immediate page when hasMore and long-polls after catch-up',
      () async {
        final lifecycle = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.hidden,
        );
        final sink = _CollectingNotificationSink();
        final waitMsCalls = <int?>[];
        final queue = Queue<Object>()
          ..add(
            AttentionEventsPage(
              events: [
                _attentionEvent(
                  id: 'evt-1',
                  kind: 'run-finished',
                  actionTool: 'tool-f',
                  actionSessionId: 'session-5',
                ),
              ],
              cursor: 10,
              reset: false,
              hasMore: true,
            ),
          )
          ..add(
            AttentionEventsPage(
              events: [
                _attentionEvent(
                  id: 'evt-2',
                  kind: 'run-finished',
                  actionTool: 'tool-f',
                  actionSessionId: 'session-5',
                ),
              ],
              cursor: 20,
              reset: false,
              hasMore: false,
            ),
          )
          ..add(
            const AttentionEventsPage(
              events: [],
              cursor: 20,
              reset: false,
              hasMore: false,
            ),
          );

        final longPollStarted = Completer<void>();
        _mockWaitCallsOnGetAttentionEvents(
          client: brokerClient,
          waitCalls: waitMsCalls,
          plan: queue,
          onCall: () {
            if (waitMsCalls.length == 3 && !longPollStarted.isCompleted) {
              longPollStarted.complete();
            }
          },
        );
        final delays = <Duration>[];

        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: lifecycle,
          notificationSink: sink,
          onForegroundEvent: (_) async {},
          longPollWait: const Duration(milliseconds: 15),
          sleep: (duration) async {
            delays.add(duration);
          },
        );

        worker.start();
        await longPollStarted.future.timeout(const Duration(seconds: 1));
        await worker.stop();

        expect(waitMsCalls[0], isNull);
        expect(waitMsCalls[1], isNull);
        expect(waitMsCalls[2], 15);
        // The broker-side long poll is the wait; the worker must not add a
        // second local 15 ms delay after the response arrives.
        expect(delays, isEmpty);
        expect(sink.shown, hasLength(2));
      },
    );

    test('stops promptly during backoff', () async {
      final lifecycle = _StubLifecycleMonitor(
        currentState: BrokerAppLifecycleState.hidden,
      );
      final waiter = _BlockedSleep();
      final error = DioException(
        requestOptions: RequestOptions(path: '/api/attention-events'),
        type: DioExceptionType.connectionTimeout,
      );

      _stubGetAttentionEvents(
        client: brokerClient,
        outcomes: [error],
      );

      final worker = AttentionFeedWorker(
        brokerClient: brokerClient,
        repository: repository,
        brokerProfileId: _brokerProfileId,
        clientId: _clientId,
        lifecycleMonitor: lifecycle,
        notificationSink: _CollectingNotificationSink(),
        onForegroundEvent: (_) async {},
        sleep: waiter.call,
      );

      worker.start();
      await Future<void>.delayed(Duration.zero);
      final stopFuture = worker.stop();

      await stopFuture;
      expect(waiter.calls, hasLength(1));
      expect(waiter.calls.single, const Duration(milliseconds: 250));
      expect(waiter.completer.isCompleted, isFalse);
      expect(worker.supportsFeed, isFalse);
    });

    test(
      'a response released after stop cannot persist for a replacement source',
      () async {
        final requestStarted = Completer<void>();
        final releaseResponse = Completer<void>();
        when(
          () => brokerClient.getAttentionEvents(
            clientId: _clientId,
            after: any(named: 'after'),
            limit: any(named: 'limit'),
            waitMs: any(named: 'waitMs'),
            cancelToken: any(named: 'cancelToken'),
          ),
        ).thenAnswer((_) async {
          requestStarted.complete();
          await releaseResponse.future;
          return AttentionEventsPage(
            events: [
              _attentionEvent(
                id: 'evt-retired-source',
                kind: 'run-finished',
                actionTool: 'codex',
                actionSessionId: 'session-retired',
              ),
            ],
            cursor: 1,
            reset: false,
            hasMore: false,
          );
        });

        final worker = AttentionFeedWorker(
          brokerClient: brokerClient,
          repository: repository,
          brokerProfileId: _brokerProfileId,
          clientId: _clientId,
          lifecycleMonitor: _StubLifecycleMonitor(
            currentState: BrokerAppLifecycleState.hidden,
          ),
          notificationSink: _CollectingNotificationSink(),
          onForegroundEvent: (_) async {},
          sleep: (_) async {},
        );

        worker.start();
        await requestStarted.future;
        final stopped = worker.stop();
        releaseResponse.complete();
        await stopped;

        expect(await repository.loadEvents(_brokerProfileId), isEmpty);
      },
    );

    test('acknowledge and dismiss operations call local store first', () async {
      final repo = _AckDismissRepository();
      final localSink = _CollectingNotificationSink();
      final localLifecycle = _StubLifecycleMonitor(
        currentState: BrokerAppLifecycleState.hidden,
      );
      final events = [
        _attentionEvent(
          id: 'evt-op',
          kind: 'run-finished',
          actionTool: 'tool-x',
          actionSessionId: 'session-x',
        ),
      ];
      _stubGetAttentionEvents(
        client: brokerClient,
        outcomes: [
          AttentionEventsPage(
            events: events,
            cursor: 1,
            reset: false,
            hasMore: false,
          ),
        ],
      );
      when(
        () => brokerClient.acknowledgeAttentionEvent(
          any(),
          clientId: any(named: 'clientId'),
        ),
      ).thenAnswer((_) async => {});
      when(
        () => brokerClient.dismissAttentionEvent(
          any(),
          clientId: any(named: 'clientId'),
        ),
      ).thenAnswer((_) async => {});
      final ack = AttentionFeedWorker(
        brokerClient: brokerClient,
        repository: repo,
        brokerProfileId: _brokerProfileId,
        clientId: _clientId,
        lifecycleMonitor: localLifecycle,
        notificationSink: localSink,
        onForegroundEvent: (_) async {},
        sleep: (_) async {},
      );
      ack.start();
      await advanceToProcess();
      await ack.stop();

      await ack.acknowledgeAttentionEvent('evt-op');
      await ack.dismissAttentionEvent('evt-op');

      expect(repo.operationOrder, ['read', 'dismiss']);
      expect(repo.dismissedEvents, ['evt-op']);
      expect(repo.readEvents, ['evt-op']);
    });
  });
}

class _MockBrokerClient extends Mock implements BrokerClient {}

void _stubGetAttentionEvents({
  required _MockBrokerClient client,
  required List<Object> outcomes,
}) {
  final queue = Queue<Object>.from(outcomes);

  when(
    () => client.getAttentionEvents(
      clientId: _clientId,
      after: any(named: 'after'),
      limit: any(named: 'limit'),
      waitMs: any(named: 'waitMs'),
      cancelToken: any(named: 'cancelToken'),
    ),
  ).thenAnswer((_) async {
    if (queue.isEmpty) {
      return const AttentionEventsPage(
        events: [],
        cursor: 0,
        reset: false,
        hasMore: false,
      );
    }

    final outcome = queue.removeFirst();
    if (outcome is AttentionEventsPage) {
      return outcome;
    }
    if (outcome is AttentionFeedUnsupportedException) {
      throw outcome;
    }
    if (outcome is Exception) throw outcome;
    if (outcome is Error) throw outcome;
    throw StateError('Unexpected attention outcome: $outcome');
  });
}

void _mockWaitCallsOnGetAttentionEvents({
  required _MockBrokerClient client,
  required List<int?> waitCalls,
  required Queue<Object> plan,
  void Function()? onCall,
}) {
  when(
    () => client.getAttentionEvents(
      clientId: _clientId,
      after: any(named: 'after'),
      limit: any(named: 'limit'),
      waitMs: any(named: 'waitMs'),
      cancelToken: any(named: 'cancelToken'),
    ),
  ).thenAnswer((invocation) async {
    waitCalls.add(invocation.namedArguments[#waitMs] as int?);
    onCall?.call();

    if (plan.isEmpty) {
      return const AttentionEventsPage(
        events: [],
        cursor: 0,
        reset: false,
        hasMore: false,
      );
    }

    final outcome = plan.removeFirst();
    if (outcome is AttentionEventsPage) {
      return outcome;
    }
    if (outcome is AttentionFeedUnsupportedException) {
      throw outcome;
    }
    if (outcome is Exception) throw outcome;
    if (outcome is Error) throw outcome;
    throw StateError('Unexpected attention outcome: $outcome');
  });
}

AttentionEventView _attentionEvent({
  required String id,
  required String kind,
  required String actionTool,
  required String actionSessionId,
  int cursor = 1,
  int presentationRevision = 1,
  String summary = '',
  String actionKind = 'open-session',
  String? actionAgent,
  String state = 'active',
  String severity = 'informational',
  int revision = 1,
}) {
  return AttentionEventView.fromJson(<String, dynamic>{
    'id': id,
    'cursor': cursor,
    'revision': revision,
    'presentationRevision': presentationRevision,
    'kind': kind,
    'state': state,
    'severity': severity,
    'dedupeKey': 'dedupe-$id',
    'createdAt': 1,
    'updatedAt': 2,
    'title': 'Event $id',
    if (summary.isNotEmpty) 'summary': summary,
    'action': {
      'kind': actionKind,
      'tool': actionTool,
      'sessionId': actionSessionId,
      if (actionAgent != null) 'agent': actionAgent,
    },
  });
}

class _CollectingNotificationSink implements BrokerNotificationSink {
  final List<BrokerNotificationRequest> shown = [];
  void Function(BrokerNotificationRequest request)? onShow;

  @override
  Future<void> show(BrokerNotificationRequest request) async {
    shown.add(request);
    onShow?.call(request);
  }

  @override
  Future<void> clear(String id) async {}

  @override
  Future<void> clearMany(Iterable<String> ids) async {}

  @override
  Future<void> clearAll() async {}
}

final class _FailingNotificationSink extends _CollectingNotificationSink {
  _FailingNotificationSink({required Set<String> failingEventIds})
    : failingEventIds = {...failingEventIds};

  final Set<String> failingEventIds;

  @override
  Future<void> show(BrokerNotificationRequest request) async {
    final eventId = request.payload['eventId'];
    if (eventId is String && failingEventIds.contains(eventId)) {
      throw StateError('simulated sink failure');
    }
    await super.show(request);
  }
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

class _InMemoryAttentionRepository implements AttentionRepository {
  _InMemoryAttentionRepository({
    required this._profileId,
  });

  final String _profileId;
  final Map<String, _StoredAttentionEvent> _events = {};
  final Map<String, int> _cursorByProfile = {};
  int? _baselineThroughCursor;
  void Function(List<String> eventIds)? onPersist;
  Future<void> Function(List<String> eventIds)? onPersistAsync;
  Future<void> Function()? onLoadPendingPresentations;

  @override
  Future<void> persistAttentionEventsPage({
    required String brokerProfileId,
    required AttentionEventsPage page,
  }) async {
    if (brokerProfileId != _profileId) {
      return;
    }
    if (page.cursor < 0) {
      throw ArgumentError('cursor must be >= 0');
    }

    final eventIds = page.events
        .map((event) => event.id)
        .toList(growable: false);
    await onPersistAsync?.call(eventIds);
    onPersist?.call(eventIds);

    if (page.reset) {
      _events.clear();
      _baselineThroughCursor = null;
    }

    final baselineThroughCursor =
        _baselineThroughCursor ?? page.baselineThroughCursor;
    if (_baselineThroughCursor == null && baselineThroughCursor != null) {
      for (final stored in _events.values) {
        if (stored.event.historicalBaseline ||
            stored.event.cursor > baselineThroughCursor) {
          continue;
        }
        final markedHistorical = _StoredAttentionEvent(
          event: stored.event.copyWithHistoricalBaseline(),
          localPresentedRevision: stored.localPresentedRevision,
          brokerReadAt: stored.brokerReadAt,
          brokerDismissedAt: stored.brokerDismissedAt,
          localReadAt: stored.localReadAt,
          localDismissedAt: stored.localDismissedAt,
        );
        _events[stored.event.id] = markedHistorical;
      }
      _baselineThroughCursor = baselineThroughCursor;
    }

    for (final event in page.events) {
      final existing = _events[event.id];
      final shouldBeHistorical =
          baselineThroughCursor != null &&
          event.cursor <= baselineThroughCursor;
      _events[event.id] = _StoredAttentionEvent(
        event: event.copyWithLocalState(
          historicalBaseline:
              (existing?.event.historicalBaseline ?? false) ||
              shouldBeHistorical,
        ),
        brokerReadAt: existing?.brokerReadAt,
        brokerDismissedAt: existing?.brokerDismissedAt,
        localReadAt: existing?.localReadAt,
        localDismissedAt: existing?.localDismissedAt,
        localPresentedRevision: existing?.localPresentedRevision ?? 0,
      );
    }
    _cursorByProfile[_profileId] = page.cursor;
  }

  @override
  Future<List<AttentionEventView>> loadEvents(String brokerProfileId) async {
    if (brokerProfileId != _profileId) {
      return const [];
    }

    return _events.values
        .map(
          (stored) => stored.event.copyWithLocalState(
            readAt: stored.localReadAt?.millisecondsSinceEpoch,
            dismissedAt: stored.localDismissedAt?.millisecondsSinceEpoch,
          ),
        )
        .toList(growable: false);
  }

  @override
  Future<List<AttentionDeliveryState>> loadDeliveryStates(
    String brokerProfileId,
  ) async {
    if (brokerProfileId != _profileId) {
      return const [];
    }

    return _events.values
        .map(
          (stored) => AttentionDeliveryState(
            event: stored.event.copyWithLocalState(
              readAt: stored.localReadAt?.millisecondsSinceEpoch,
              dismissedAt: stored.localDismissedAt?.millisecondsSinceEpoch,
              historicalBaseline: stored.event.historicalBaseline,
            ),
            localPresentedRevision: stored.localPresentedRevision,
            localReadAt: stored.localReadAt?.millisecondsSinceEpoch,
            localDismissedAt: stored.localDismissedAt?.millisecondsSinceEpoch,
            localDismissedRevision: null,
            brokerReadAt: stored.brokerReadAt?.millisecondsSinceEpoch,
            brokerDismissedAt: stored.brokerDismissedAt?.millisecondsSinceEpoch,
          ),
        )
        .toList(growable: false);
  }

  @override
  Future<int> loadCursor(String brokerProfileId) async {
    if (brokerProfileId != _profileId) {
      return 0;
    }
    return _cursorByProfile[brokerProfileId] ?? 0;
  }

  @override
  Future<int> loadUnreadCount(String brokerProfileId) async => 0;

  @override
  Future<List<AttentionEventSnapshot>> markSnapshotDismissed(
    List<AttentionEventSnapshot> snapshot, {
    DateTime? dismissedAt,
  }) async => snapshot;

  @override
  Future<int> reconcileBulkDismissResult({
    required String brokerProfileId,
    required AttentionBulkDismissResponse result,
  }) async => 0;

  @override
  Future<List<AttentionDeliveryState>> loadPendingMutations(
    String brokerProfileId,
  ) async {
    final rows = await loadDeliveryStates(brokerProfileId);
    return rows
        .where(
          (state) =>
              (state.localReadAt != null &&
                  (state.brokerReadAt == null ||
                      state.localReadAt! > state.brokerReadAt!)) ||
              (state.localDismissedAt != null &&
                  (state.brokerDismissedAt == null ||
                      state.localDismissedAt! > state.brokerDismissedAt!)),
        )
        .toList(growable: false);
  }

  @override
  Future<List<AttentionDeliveryState>> loadPendingPresentations(
    String brokerProfileId,
  ) async {
    final rows = await loadDeliveryStates(brokerProfileId);
    await onLoadPendingPresentations?.call();
    return rows
        .where(
          (state) =>
              !state.event.historicalBaseline &&
              state.event.dismissedAt == null &&
              state.event.presentationRevision > state.localPresentedRevision,
        )
        .toList(growable: false);
  }

  @override
  Future<void> markRead(
    String brokerProfileId,
    String eventId, {
    DateTime? readAt,
  }) async {
    if (brokerProfileId != _profileId) {
      return;
    }
    _events[eventId]?.localReadAt =
        readAt ?? DateTime.fromMillisecondsSinceEpoch(0);
  }

  @override
  Future<void> markDismissed(
    String brokerProfileId,
    String eventId, {
    DateTime? dismissedAt,
  }) async {
    if (brokerProfileId != _profileId) {
      return;
    }
    final event = _events[eventId];
    if (event == null) {
      return;
    }
    event.localDismissedAt =
        dismissedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
  }

  @override
  Future<bool> markBrokerReadSynced({
    required String brokerProfileId,
    required String eventId,
    required DateTime brokerReadAt,
  }) async {
    if (brokerProfileId != _profileId) {
      return false;
    }
    final event = _events[eventId];
    if (event == null) {
      return false;
    }
    event.brokerReadAt = brokerReadAt;
    return true;
  }

  @override
  Future<bool> markBrokerDismissedSynced({
    required String brokerProfileId,
    required String eventId,
    required DateTime brokerDismissedAt,
  }) async {
    if (brokerProfileId != _profileId) {
      return false;
    }
    final event = _events[eventId];
    if (event == null) {
      return false;
    }
    event.brokerDismissedAt = brokerDismissedAt;
    return true;
  }

  @override
  Future<bool> advancePresentedRevision({
    required String brokerProfileId,
    required String eventId,
    required int presentedRevision,
  }) async {
    if (brokerProfileId != _profileId) {
      return false;
    }

    final event = _events[eventId];
    if (event == null || event.localPresentedRevision >= presentedRevision) {
      return false;
    }

    event.localPresentedRevision = presentedRevision;
    return true;
  }

  int getStoredPresentedRevision(String eventId) {
    return _events[eventId]?.localPresentedRevision ?? 0;
  }
}

extension _AttentionEventCopyExtension on AttentionEventView {
  AttentionEventView copyWithLocalState({
    int? readAt,
    int? dismissedAt,
    bool? historicalBaseline,
  }) {
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
      historicalBaseline: historicalBaseline ?? this.historicalBaseline,
      readAt: readAt,
      dismissedAt: dismissedAt,
    );
  }
}

extension _AttentionEventHistoricalExtension on AttentionEventView {
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
      historicalBaseline: true,
      readAt: readAt,
      dismissedAt: dismissedAt,
    );
  }
}

final class _StoredAttentionEvent {
  _StoredAttentionEvent({
    required this.event,
    required this.localPresentedRevision,
    this.brokerReadAt,
    this.brokerDismissedAt,
    this.localReadAt,
    this.localDismissedAt,
  });

  final AttentionEventView event;
  DateTime? brokerReadAt;
  DateTime? brokerDismissedAt;
  DateTime? localReadAt;
  DateTime? localDismissedAt;
  int localPresentedRevision;
}

class _BlockedSleep {
  final Completer<void> completer = Completer<void>();
  final List<Duration> calls = [];

  Future<void> call(Duration duration) {
    calls.add(duration);
    return completer.future;
  }
}

final class _AckDismissRepository extends _InMemoryAttentionRepository {
  _AckDismissRepository() : super(profileId: _brokerProfileId);

  final List<String> operationOrder = [];
  final List<String> readEvents = [];
  final List<String> dismissedEvents = [];

  @override
  Future<void> markRead(
    String brokerProfileId,
    String eventId, {
    DateTime? readAt,
  }) async {
    await super.markRead(
      brokerProfileId,
      eventId,
      readAt: readAt,
    );
    operationOrder.add('read');
    readEvents.add(eventId);
  }

  @override
  Future<void> markDismissed(
    String brokerProfileId,
    String eventId, {
    DateTime? dismissedAt,
  }) async {
    await super.markDismissed(
      brokerProfileId,
      eventId,
      dismissedAt: dismissedAt,
    );
    operationOrder.add('dismiss');
    dismissedEvents.add(eventId);
  }
}
