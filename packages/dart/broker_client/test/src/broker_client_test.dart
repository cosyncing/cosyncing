import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:dio/dio.dart';
import 'package:http_mock_adapter/http_mock_adapter.dart';
import 'package:test/test.dart';

void main() {
  group('BrokerClient', () {
    late Dio dio;
    late DioAdapter dioAdapter;
    late BrokerClient client;

    setUp(() {
      dio = Dio();
      dioAdapter = DioAdapter(dio: dio);
      client = BrokerClient(
        baseUrl: 'http://127.0.0.1:7734',
        dio: dio,
      );
    });

    tearDown(() {
      client.close();
    });

    group('getHealth', () {
      test('returns HealthResponse on success', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/health',
          (server) => server.reply(200, {
            'ok': true,
            'machine': 'test-machine',
            'controlMode': 'observe-drive',
            'codexSyncServer': false,
          }),
        );

        final health = await client.getHealth();
        expect(health.ok, isTrue);
        expect(health.machine, 'test-machine');
        expect(health.controlMode, 'observe-drive');
        expect(health.codexSyncServer, isFalse);
      });

      test('throws BrokerException with BrokerError on 500', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/health',
          (server) => server.reply(500, {'error': 'internal error'}),
        );

        expect(
          () => client.getHealth(),
          throwsA(
            isA<BrokerException>().having(
              (e) => e.error?.error,
              'error.error',
              'internal error',
            ),
          ),
        );
      });

      test('throws BrokerException with statusCode on 404', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/health',
          (server) => server.reply(404, {'error': 'not found'}),
        );

        expect(
          () => client.getHealth(),
          throwsA(
            isA<BrokerException>().having(
              (e) => e.statusCode,
              'statusCode',
              404,
            ),
          ),
        );
      });

      test(
        'throws BrokerException without BrokerError on non-JSON response',
        () async {
          dioAdapter.onGet(
            'http://127.0.0.1:7734/api/health',
            (server) => server.reply(503, 'service unavailable'),
          );

          try {
            await client.getHealth();
            fail('should throw');
          } on BrokerException catch (e) {
            expect(e.statusCode, 503);
            expect(e.error, isNull);
          }
        },
      );
    });

    group('runtime and recovery APIs', () {
      test('gets runtime updates with fresh query', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/agent-runtime-updates?fresh=1',
          (server) => server.reply(200, {
            'ok': true,
            'updates': [
              {
                'agent': 'codex',
                'displayName': 'Codex',
                'managed': true,
                'state': 'pending',
                'updateAvailable': true,
                'autoRestartReady': false,
                'checkedAt': 1730000000000,
              },
            ],
          }),
        );

        final response = await client.getAgentRuntimeUpdates(fresh: true);
        expect(response.ok, isTrue);
        expect(response.updates, hasLength(1));
        expect(response.updates.first.agent, 'codex');
      });

      test('gets and sets codex runtime update policy', () async {
        dioAdapter
          ..onGet(
            'http://127.0.0.1:7734/api/agent-runtime-update-policy',
            (server) => server.reply(200, {
              'ok': true,
              'codexUpdatePolicy': 'when-idle',
            }),
          )
          ..onPost(
            'http://127.0.0.1:7734/api/agent-runtime-update-policy',
            data: {'codexUpdatePolicy': 'when-idle'},
            (server) => server.reply(200, {
              'ok': true,
              'codexUpdatePolicy': 'when-idle',
              'update': {
                'agent': 'codex',
                'displayName': 'Codex',
                'managed': true,
                'state': 'current',
                'updateAvailable': false,
                'autoRestartReady': true,
                'checkedAt': 1730000000000,
              },
            }),
          );

        final current = await client.getCodexUpdatePolicy();
        expect(current.codexUpdatePolicy, 'when-idle');
        final updated = await client.setCodexUpdatePolicy(
          const SetCodexUpdatePolicyRequest(codexUpdatePolicy: 'when-idle'),
        );
        expect(updated.ok, isTrue);
        expect(updated.update, isNotNull);
      });

      test('confirms runtime restart request body', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/agent-runtime-updates/codex/restart',
          data: {'confirmRestart': true},
          (server) => server.reply(200, {
            'ok': true,
            'update': {
              'agent': 'codex',
              'displayName': 'Codex',
              'managed': true,
              'state': 'pending',
              'updateAvailable': false,
              'autoRestartReady': false,
              'checkedAt': 1730000000000,
            },
          }),
        );

        final response = await client.restartAgentRuntime(
          agent: 'codex',
          confirmRestart: true,
        );
        expect(response.ok, isTrue);
      });

      test('propagates restart failures as BrokerException', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/agent-runtime-updates/opencode/restart',
          data: {'confirmRestart': true},
          (server) => server.reply(404, {
            'error': 'No managed runtime updater for opencode',
          }),
        );

        expect(
          () => client.restartAgentRuntime(
            agent: 'opencode',
            confirmRestart: true,
          ),
          throwsA(isA<BrokerException>()),
        );
      });

      test('gets authenticated broker health snapshot', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/broker/health',
          (server) => server.reply(200, {
            'ok': true,
            'status': 'degraded',
            'checkedAt': 1730000000000,
            'machine': 'broker-machine',
            'components': {
              'state-filesystem': {
                'status': 'healthy',
                'detailCodes': ['capacity-warning'],
                'checkedAt': 1730000000000,
              },
            },
          }),
        );

        final response = await client.getBrokerHealth();
        expect(response.status, 'degraded');
        expect(response.components['state-filesystem']!.detailCodes, [
          'capacity-warning',
        ]);
      });

      test('posts confirmed restart-all request', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/broker/restart-all',
          data: <String, dynamic>{'confirmRestart': true},
          (server) => server.reply(202, {
            'ok': true,
            'partialFailure': true,
            'components': {
              'codex': {
                'ok': true,
                'skipped': true,
                'reason': 'already stopped',
              },
              'opencode': {
                'strategy': 'broker-relaunch',
                'restartsWithBroker': true,
              },
              'broker': {'scheduled': true, 'dryRun': false},
            },
            'message': 'restart queued',
          }),
        );

        final response = await client.restartEverything(
          confirmRestart: true,
        );
        expect(response.ok, isTrue);
        expect(response.partialFailure, isTrue);
        expect(response.components?.codex?.skipped, isTrue);
        expect(response.components?.opencode?.strategy, 'broker-relaunch');
        expect(response.components?.broker?.scheduled, isTrue);
      });

      test('gets tokdash quota with base query', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/tokdash/quota?base=http%3A%2F%2F127.0.0.1%3A55423',
          (server) => server.reply(200, {
            'ok': true,
            'baseUrl': 'http://127.0.0.1:55423',
            'endpoint': '/api/quota',
            'data': {
              'enabled': true,
              'timestamp': 1730000000000,
              'providers': <String, dynamic>{},
            },
          }),
        );

        final response = await client.getTokdashQuota(
          base: 'http://127.0.0.1:55423',
        );
        expect(response.baseUrl, 'http://127.0.0.1:55423');
        expect(response.data, isNotNull);
      });

      test('gets and sets quota preference', () async {
        dioAdapter
          ..onGet(
            'http://127.0.0.1:7734/api/tokdash/quota-preference',
            (server) => server.reply(200, {'ok': true, 'enabled': true}),
          )
          ..onPost(
            'http://127.0.0.1:7734/api/tokdash/quota-preference',
            data: {'enabled': false},
            (server) => server.reply(200, {'ok': true, 'enabled': false}),
          );

        final getPreference = await client.getTokdashQuotaPreference();
        expect(getPreference.enabled, isTrue);

        final setPreference = await client.setTokdashQuotaPreference(
          const TokdashQuotaPreferenceRequest(enabled: false),
        );
        expect(setPreference.enabled, isFalse);
      });
    });

    group('listAgents', () {
      test('returns list of AgentInfo on success', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/agents',
          (server) => server.reply(200, [
            {
              'id': 'opencode',
              'displayName': 'OpenCode',
              'capabilities': {
                'integrationKind': 'http-sse',
                'attachModes': ['live', 'resume', 'observe'],
                'supportsObserve': true,
                'supportsResume': true,
                'supportsLiveAttach': true,
                'supportsNativeArtifact': true,
                'supportsNativeFileInput': true,
                'supportsModelSwitch': true,
                'permissionGranularity': 'per-tool',
              },
              'canCreateSession': true,
              'canSelectModelAtCreation': true,
            },
          ]),
        );

        final agents = await client.listAgents();
        expect(agents, hasLength(1));
        expect(agents.first.id, 'opencode');
        expect(agents.first.displayName, 'OpenCode');
        expect(agents.first.canCreateSession, isTrue);
        expect(agents.first.canSelectModelAtCreation, isTrue);
      });
    });

    group('listSessions', () {
      test('returns ListSessionsResponse on success', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/sessions',
          (server) => server.reply(200, {
            'machine': 'test-machine',
            'sessions': [
              {
                'id': 'session-1',
                'tool': 'opencode',
                'title': 'Test Session',
                'status': 'idle',
                'attachMode': 'live',
              },
            ],
          }),
        );

        final response = await client.listSessions();
        expect(response.machine, 'test-machine');
        expect(response.sessions, hasLength(1));
        expect(response.sessions.first.id, 'session-1');
      });

      test(
        'conditional list sends ETag and accepts 304 without a body',
        () async {
          dioAdapter.onGet(
            'http://127.0.0.1:7734/api/sessions',
            headers: const {'If-None-Match': 'W/"roster-v1"'},
            (server) => server.reply(
              304,
              null,
              headers: {
                'content-type': ['application/json'],
                'etag': ['W/"roster-v1"'],
              },
            ),
          );

          final result = await client.listSessionsConditional(
            etag: 'W/"roster-v1"',
          );

          expect(result.notModified, isTrue);
          expect(result.response, isNull);
          expect(result.etag, 'W/"roster-v1"');
        },
      );

      test(
        'conditional list puts the time bound in the broker query',
        () async {
          dioAdapter.onGet(
            'http://127.0.0.1:7734/api/sessions?window=7d',
            (server) => server.reply(
              200,
              {
                'machine': 'test-machine',
                'revision': 8,
                'sessions': <Object>[],
              },
            ),
          );

          final result = await client.listSessionsConditional(window: '7d');

          expect(result.response?.revision, 8);
        },
      );

      test('explicit refresh bypasses the ETag and decodes revision', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/sessions?refresh=1',
          (server) => server.reply(
            200,
            {'machine': 'test-machine', 'revision': 7, 'sessions': <Object>[]},
            headers: {
              'content-type': ['application/json'],
              'etag': ['W/"roster-v7"'],
            },
          ),
        );

        final result = await client.listSessionsConditional(
          etag: 'W/"roster-v1"',
          refresh: true,
        );

        expect(result.notModified, isFalse);
        expect(result.response?.revision, 7);
        expect(result.etag, 'W/"roster-v7"');
      });

      test('waits for and decodes transcript-free roster deltas', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/session-roster-deltas?after=7&waitMs=2000',
          (server) => server.reply(200, {
            'revision': 8,
            'deltas': [
              {
                'revision': 8,
                'machine': 'test-machine',
                'tool': 'codex',
                'sessionId': 'session-1',
                'changedFields': ['status'],
                'session': {
                  'id': 'session-1',
                  'machine': 'test-machine',
                  'tool': 'codex',
                  'title': 'Test Session',
                  'status': 'working',
                  'attachMode': 'observe',
                },
              },
            ],
          }),
        );

        final batch = await client.waitForSessionRosterDeltas(
          after: 7,
          wait: const Duration(seconds: 2),
        );

        expect(batch.revision, 8);
        expect(batch.deltas.single.changedFields, ['status']);
        expect(batch.deltas.single.session?.status, SessionStatus.working);
      });

      test('puts the roster window on delta waits', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/session-roster-deltas'
          '?after=8&waitMs=2000&window=7d',
          (server) => server.reply(200, {
            'revision': 9,
            'deltas': [
              {
                'revision': 9,
                'machine': 'test-machine',
                'tool': 'codex',
                'sessionId': 'old-session',
                'changedFields': ['removed'],
                'removed': true,
              },
            ],
          }),
        );

        final batch = await client.waitForSessionRosterDeltas(
          after: 8,
          wait: const Duration(seconds: 2),
          window: '7d',
        );

        expect(batch.revision, 9);
        expect(batch.deltas.single.removed, isTrue);
        expect(batch.deltas.single.session, isNull);
      });
    });

    group('schedule APIs', () {
      Map<String, dynamic> schedule({String state = 'scheduled'}) => {
        'id': 'schedule-1',
        'kind': 'message',
        'tool': 'codex',
        'sessionId': 'session-1',
        'sessionTitle': 'Release work',
        'text': 'Run the release checks',
        'at': 1730000000000,
        'state': state,
        'createdAt': 1729900000000,
        'updatedAt': 1729990000000,
      };

      test('lists full authenticated schedule records', () async {
        final authenticatedClient = BrokerClient(
          baseUrl: 'http://127.0.0.1:7734',
          token: 'schedule-token',
          dio: dio,
        );
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/schedules',
          headers: {'x-cosyncing-token': 'schedule-token'},
          (server) => server.reply(200, {
            'ok': true,
            'schedules': [schedule()],
          }),
        );

        final response = await authenticatedClient.listSchedules();

        expect(response.schedules, hasLength(1));
        expect(response.schedules.single.text, 'Run the release checks');
        authenticatedClient.close();
      });

      test(
        'a canceled list throws RequestCancelled without decoding',
        () async {
          var responsesProcessed = 0;
          dio.interceptors.add(
            InterceptorsWrapper(
              onResponse: (response, handler) {
                responsesProcessed += 1;
                handler.next(response);
              },
            ),
          );
          // The broker carries no default timeout, so this stands in for a read
          // the broker simply never answers.
          dioAdapter.onGet(
            'http://127.0.0.1:7734/api/schedules',
            (server) => server.reply(
              200,
              {
                'ok': true,
                'schedules': [schedule()],
              },
              delay: const Duration(seconds: 5),
            ),
          );

          final token = CancelToken();
          final pending = client.listSchedules(cancelToken: token);
          // Let the request actually reach the adapter before abandoning it.
          await Future<void>.delayed(const Duration(milliseconds: 20));
          token.cancel('test abandoned this read');

          await expectLater(
            pending.timeout(const Duration(seconds: 1)),
            throwsA(isA<RequestCancelled>()),
            reason:
                'cancellation must release the request promptly rather than '
                'wait out the response the caller no longer wants',
          );

          // Outlive the delayed reply: it must never be processed or decoded.
          await Future<void>.delayed(const Duration(seconds: 6));
          expect(
            responsesProcessed,
            0,
            reason: 'the abandoned response was never decoded',
          );
        },
        timeout: const Timeout(Duration(seconds: 30)),
      );

      test('a cancel-shaped failure with no token stays a BrokerException', () {
        // Control for the conditional mapping: 17 GET APIs share the helper,
        // and a cancellation no caller asked for is a fault to them.
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/schedules',
          (server) => server.throws(
            499,
            DioException(
              requestOptions: RequestOptions(path: '/api/schedules'),
              type: DioExceptionType.cancel,
              message: 'canceled by something the caller did not ask for',
            ),
          ),
        );

        expect(
          () => client.listSchedules(),
          throwsA(isA<BrokerException>()),
        );
      });

      test('creates a typed schedule request', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/schedules',
          data: {
            'kind': 'message',
            'tool': 'codex',
            'sessionId': 'session-1',
            'sessionTitle': 'Release work',
            'text': 'Run the release checks',
            'at': 1730000000000,
          },
          (server) => server.reply(201, {
            'ok': true,
            'schedule': schedule(),
          }),
        );

        final response = await client.createSchedule(
          const MessageScheduleCreate(
            tool: 'codex',
            sessionId: 'session-1',
            sessionTitle: 'Release work',
            text: 'Run the release checks',
            at: 1730000000000,
          ),
        );

        expect(response.schedule.id, 'schedule-1');
      });

      test('edits and acts on schedules with optimistic revisions', () async {
        dioAdapter
          ..onPatch(
            'http://127.0.0.1:7734/api/schedules/schedule-1',
            data: {'expectedRevision': 2, 'text': 'Edited'},
            (server) => server.reply(200, {
              'ok': true,
              'schedule': {...schedule(), 'revision': 3, 'text': 'Edited'},
            }),
          )
          ..onPost(
            'http://127.0.0.1:7734/api/schedules/schedule-1/actions',
            data: {'action': 'pause', 'expectedRevision': 3},
            (server) => server.reply(200, {
              'ok': true,
              'schedule': {
                ...schedule(state: 'paused'),
                'revision': 4,
                'text': 'Edited',
              },
            }),
          );

        final edited = await client.updateSchedule(
          'schedule-1',
          const ScheduleUpdate(expectedRevision: 2, text: 'Edited'),
        );
        final paused = await client.applyScheduleAction(
          'schedule-1',
          const ScheduleActionRequest(
            action: ScheduleAction.pause,
            expectedRevision: 3,
          ),
        );

        expect(edited.schedule.revision, 3);
        expect(edited.schedule.text, 'Edited');
        expect(paused.schedule.revision, 4);
        expect(paused.schedule.state, ScheduleState.paused);
      });

      test('cancels live rows and removes terminal rows', () async {
        dioAdapter
          ..onDelete(
            'http://127.0.0.1:7734/api/schedules/schedule-1',
            (server) => server.reply(200, {
              'ok': true,
              'schedule': schedule(state: 'canceled')..['revision'] = 7,
            }),
          )
          ..onDelete(
            'http://127.0.0.1:7734/api/schedules/schedule-2',
            (server) => server.reply(200, {'ok': true, 'removed': true}),
          );

        final canceled = await client.deleteSchedule('schedule-1');
        final removed = await client.deleteSchedule('schedule-2');

        expect(canceled, isA<ScheduleCanceledResponse>());
        expect(removed, isA<ScheduleRemovedResponse>());
      });
    });

    group('getAttentionEvents', () {
      test(
        'fetches bounded attention page with query args and pagination',
        () async {
          dioAdapter.onGet(
            'http://127.0.0.1:7734/api/attention-events?clientId=phone%201&after=7&limit=2&waitMs=500',
            (server) => server.reply(200, {
              'ok': true,
              'events': [
                {
                  'id': 'evt-001',
                  'cursor': 101,
                  'revision': 7,
                  'presentationRevision': 1,
                  'presentationStage': 'immediate',
                  'kind': 'permission-required',
                  'state': 'active',
                  'severity': 'action-required',
                  'dedupeKey': 'perm:test-session',
                  'createdAt': 1710000000000,
                  'updatedAt': 1710000000001,
                  'agent': 'opencode',
                  'sessionId': 'session-1',
                  'requestId': 'req-1',
                  'title': 'Permission needed',
                  'summary': 'Claude blocked on file write',
                  'action': {
                    'kind': 'open-session',
                    'tool': 'opencode',
                    'sessionId': 'session-1',
                    'futureActionField': 'preserved',
                  },
                  'readAt': 1710000000002,
                },
              ],
              'cursor': 101,
              'reset': true,
              'hasMore': false,
            }),
          );

          final page = await client.getAttentionEvents(
            clientId: 'phone 1',
            after: 7,
            limit: 2,
            waitMs: 500,
          );
          expect(page.cursor, 101);
          expect(page.reset, isTrue);
          expect(page.hasMore, isFalse);
          expect(page.events, hasLength(1));
          expect(page.events.first.id, 'evt-001');
          expect(page.events.first.isPermissionRequired, isTrue);
          expect(page.events.first.action.kind, 'open-session');
          expect(page.events.first.action.isOpenSession, isTrue);
        },
      );

      test('bounds receive time beyond the requested long-poll wait', () async {
        RequestOptions? capturedRequest;
        dio.interceptors.add(
          InterceptorsWrapper(
            onRequest: (options, handler) {
              capturedRequest = options;
              handler.next(options);
            },
          ),
        );
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/attention-events?clientId=phone&waitMs=15000',
          (server) => server.reply(200, {
            'ok': true,
            'events': <Object>[],
            'cursor': 0,
            'baselineThroughCursor': 0,
            'reset': false,
            'hasMore': false,
          }),
        );

        await client.getAttentionEvents(clientId: 'phone', waitMs: 15000);

        expect(capturedRequest?.receiveTimeout, const Duration(seconds: 25));
      });

      test('bounds immediate attention fetch receive time', () async {
        RequestOptions? capturedRequest;
        dio.interceptors.add(
          InterceptorsWrapper(
            onRequest: (options, handler) {
              capturedRequest = options;
              handler.next(options);
            },
          ),
        );
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/attention-events?clientId=phone',
          (server) => server.reply(200, {
            'ok': true,
            'events': <Object>[],
            'cursor': 0,
            'baselineThroughCursor': 0,
            'reset': false,
            'hasMore': false,
          }),
        );

        await client.getAttentionEvents(clientId: 'phone');

        expect(capturedRequest?.receiveTimeout, const Duration(seconds: 10));
      });

      test('throws AttentionFeedUnsupportedException on 404', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/attention-events?clientId=phone',
          (server) => server.reply(404, {'error': 'not found'}),
        );

        expect(
          () => client.getAttentionEvents(clientId: 'phone'),
          throwsA(
            isA<AttentionFeedUnsupportedException>().having(
              (e) => e.statusCode,
              'statusCode',
              404,
            ),
          ),
        );
      });

      test('keeps 500 responses as BrokerException', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/attention-events?clientId=phone',
          (server) => server.reply(500, {'error': 'broken feed'}),
        );

        expect(
          () => client.getAttentionEvents(clientId: 'phone'),
          throwsA(isA<BrokerException>()),
        );
      });

      test('supports cancellation via CancelToken', () async {
        final cancelToken = CancelToken()..cancel('tests cancel long poll');
        expect(
          () => client.getAttentionEvents(
            clientId: 'phone',
            cancelToken: cancelToken,
          ),
          throwsA(
            isA<DioException>().having(
              (e) => e.type,
              'type',
              DioExceptionType.cancel,
            ),
          ),
        );
      });
    });

    group('acknowledge/dismissAttentionEvent', () {
      test('posts clientId in acknowledge body', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/attention-events/evt-001/ack',
          data: {'clientId': 'phone'},
          (server) => server.reply(200, {'ok': true}),
        );

        final response = await client.acknowledgeAttentionEvent(
          'evt-001',
          clientId: 'phone',
        );
        expect(response['ok'], isTrue);
      });

      test('posts clientId in dismiss body', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/attention-events/evt%201/dismiss',
          data: {'clientId': 'phone 2'},
          (server) => server.reply(200, {'ok': true}),
        );

        final response = await client.dismissAttentionEvent(
          'evt 1',
          clientId: 'phone 2',
        );
        expect(response['ok'], isTrue);
      });

      test('posts one typed exact-revision bulk dismissal', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/attention-events/dismiss-batch',
          data: {
            'clientId': 'phone',
            'events': [
              {'eventId': 'evt-1', 'revision': 2},
              {'eventId': 'evt-2', 'revision': 4},
            ],
          },
          (server) => server.reply(200, {
            'ok': true,
            'accepted': [
              {'eventId': 'evt-1', 'revision': 2, 'dismissedAt': 10},
            ],
            'stale': [
              {'eventId': 'evt-2', 'revision': 4, 'currentRevision': 5},
            ],
            'notFound': <Object?>[],
          }),
        );

        final response = await client.dismissAttentionEvents(
          const [
            AttentionBulkDismissItem(eventId: 'evt-1', revision: 2),
            AttentionBulkDismissItem(eventId: 'evt-2', revision: 4),
          ],
          clientId: 'phone',
        );

        expect(response.accepted.single.dismissedAt, 10);
        expect(response.stale.single.currentRevision, 5);
      });

      test('refuses an oversized bulk dismissal before transport', () {
        expect(
          () => client.dismissAttentionEvents(
            List.generate(
              attentionBulkDismissMax + 1,
              (index) => AttentionBulkDismissItem(
                eventId: 'evt-$index',
                revision: 1,
              ),
            ),
            clientId: 'phone',
          ),
          throwsArgumentError,
        );
      });
    });

    group('push wake-token APIs', () {
      test(
        'posts exact token registration payload with optional fields',
        () async {
          dioAdapter.onPost(
            'http://127.0.0.1:7734/api/push/wake-tokens',
            data: {
              'deviceId': 'device-1',
              'platform': 'fcm',
              'token': 'token-abc',
              'label': 'work-phone',
            },
            (server) => server.reply(200, {
              'ok': true,
              'registration': {
                'deviceId': 'device-1',
                'platform': 'fcm',
                'tokenPreview': 'tok...abc',
                'label': 'work-phone',
                'createdAt': '2026-07-11T19:00:00.000Z',
                'updatedAt': '2026-07-11T19:01:00.000Z',
              },
            }),
          );

          final response = await client.registerWakeToken(
            const PushWakeTokenRegistrationRequest(
              deviceId: 'device-1',
              platform: 'fcm',
              token: 'token-abc',
              label: 'work-phone',
            ),
          );
          expect(response.ok, isTrue);
          expect(response.registration.deviceId, 'device-1');
          expect(response.registration.platform, 'fcm');
        },
      );

      test(
        'sends only required wake-token fields when optionals omitted',
        () async {
          dioAdapter.onPost(
            'http://127.0.0.1:7734/api/push/wake-tokens',
            data: {'platform': 'apns', 'token': 'token-xyz'},
            (server) => server.reply(200, {
              'ok': true,
              'registration': {
                'deviceId': 'generated-id',
                'platform': 'apns',
                'tokenPreview': 'tok...xyz',
                'createdAt': '2026-07-11T19:00:00.000Z',
                'updatedAt': '2026-07-11T19:01:00.000Z',
              },
            }),
          );

          final response = await client.registerWakeToken(
            const PushWakeTokenRegistrationRequest(
              platform: 'apns',
              token: 'token-xyz',
            ),
          );
          expect(response.registration.platform, 'apns');
        },
      );

      test(
        'throws BrokerException on wake-token registration failures',
        () async {
          dioAdapter.onPost(
            'http://127.0.0.1:7734/api/push/wake-tokens',
            data: {'platform': 'fcm', 'token': 'token-fail'},
            (server) => server.reply(
              400,
              {'error': 'invalid token', 'code': 'BAD_PARAM'},
            ),
          );

          expect(
            () => client.registerWakeToken(
              const PushWakeTokenRegistrationRequest(
                platform: 'fcm',
                token: 'token-fail',
              ),
            ),
            throwsA(
              isA<BrokerException>().having(
                (e) => e.statusCode,
                'statusCode',
                400,
              ),
            ),
          );
        },
      );

      test('lists wake-token registrations', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/push/wake-tokens',
          (server) => server.reply(200, {
            'ok': true,
            'registrations': [
              {
                'deviceId': 'device-1',
                'platform': 'fcm',
                'tokenPreview': 'tok...123',
                'createdAt': '2026-07-11T19:00:00.000Z',
                'updatedAt': '2026-07-11T19:00:01.000Z',
              },
            ],
          }),
        );

        final response = await client.listWakeTokens();
        expect(response.ok, isTrue);
        expect(response.registrations, hasLength(1));
        expect(response.registrations.first.deviceId, 'device-1');
      });

      test('throws BrokerException when listing wake-tokens fails', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/push/wake-tokens',
          (server) => server.reply(500, {'error': 'downstream error'}),
        );

        expect(
          () => client.listWakeTokens(),
          throwsA(isA<BrokerException>()),
        );
      });

      test('revokes wake-token registration by device id', () async {
        dioAdapter.onDelete(
          'http://127.0.0.1:7734/api/push/wake-tokens/device%201',
          (server) => server.reply(200, {'ok': true, 'revoked': true}),
        );

        final response = await client.revokeWakeToken('device 1');
        expect(response.ok, isTrue);
        expect(response.revoked, isTrue);
      });

      test('throws BrokerException when revoke fails', () async {
        dioAdapter.onDelete(
          'http://127.0.0.1:7734/api/push/wake-tokens/device%201',
          (server) => server.reply(
            404,
            {'error': 'missing', 'code': 'NOT_FOUND'},
          ),
        );

        expect(
          () => client.revokeWakeToken('device 1'),
          throwsA(
            isA<BrokerException>().having(
              (e) => e.statusCode,
              'statusCode',
              404,
            ),
          ),
        );
      });
    });

    group('createSession', () {
      test('returns CreateSessionResponse on success', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/sessions/opencode',
          data: Matchers.any,
          (server) => server.reply(200, {
            'session': {
              'id': 'new-session',
              'tool': 'opencode',
              'title': 'New Session',
              'status': 'idle',
              'attachMode': 'live',
            },
            'attachMode': 'live',
          }),
        );

        final response = await client.createSession('opencode');
        expect(response.session.id, 'new-session');
        expect(response.attachMode, 'live');
      });

      test('sends directory and title in body', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/sessions/opencode',
          data: Matchers.any,
          (server) => server.reply(200, {
            'session': {
              'id': 'new-session',
              'tool': 'opencode',
              'title': 'Custom Title',
              'status': 'idle',
              'attachMode': 'live',
            },
          }),
        );

        final response = await client.createSession(
          'opencode',
          directory: '/workspace/project',
          title: 'Custom Title',
        );
        expect(response.session.title, 'Custom Title');
      });

      test(
        'sends an exact optional model and loads its tool catalog',
        () async {
          dioAdapter
            ..onGet(
              'http://127.0.0.1:7734/api/agents/codex/models',
              (server) => server.reply(200, {
                'tool': 'codex',
                'models': [
                  {
                    'providerID': 'azure-openai',
                    'modelID': 'gpt-selected',
                    'variant': 'fast',
                    'label': 'Selected GPT',
                  },
                ],
                'refreshedAt': 1785400000000,
              }),
            )
            ..onPost(
              'http://127.0.0.1:7734/api/sessions/codex',
              data: {
                'directory': '/workspace/project',
                'model': {
                  'providerID': 'azure-openai',
                  'modelID': 'gpt-selected',
                  'variant': 'fast',
                  'reasoningEffort': 'high',
                },
              },
              (server) => server.reply(200, {
                'session': {
                  'id': 'new-session',
                  'tool': 'codex',
                  'title': 'Selected',
                  'status': 'idle',
                  'attachMode': 'observe',
                },
              }),
            );

          final catalog = await client.listAgentModels('codex');
          expect(catalog.tool, 'codex');
          expect(catalog.models.single.modelID, 'gpt-selected');
          expect(catalog.models.single.variant, 'fast');

          final response = await client.createSession(
            'codex',
            directory: '/workspace/project',
            model: const SessionCurrentModel(
              providerID: 'azure-openai',
              modelID: 'gpt-selected',
              variant: 'fast',
              reasoningEffort: 'high',
            ),
          );
          expect(response.session.id, 'new-session');
        },
      );
    });

    group('listMachines', () {
      test('returns typed local and degraded peer rosters', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/machines',
          (server) => server.reply(200, {
            'ok': true,
            'machine': 'local-machine',
            'machines': [
              {
                'machine': 'local-machine',
                'role': 'local',
                'status': 'ok',
                'sessions': <dynamic>[],
                'sessionCount': 0,
              },
              {
                'machine': 'peer-a',
                'role': 'peer',
                'status': 'degraded',
                'sessions': <dynamic>[],
                'sessionCount': 0,
                'code': 'MACHINE_PEER_TIMEOUT',
              },
            ],
          }),
        );

        final response = await client.listMachines();

        expect(response.machine, 'local-machine');
        expect(response.machines, hasLength(2));
        expect(response.machines.last.status, MachineRosterStatus.degraded);
        expect(response.machines.last.code, 'MACHINE_PEER_TIMEOUT');
      });

      test('resolves the authoritative owner by composite identity', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/machines/resolve'
          '?machineId=peer-a&tool=codex&sessionId=session-1',
          (server) => server.reply(200, {
            'ok': true,
            'status': 'resolved',
            'identity': {
              'machineId': 'peer-a',
              'tool': 'codex',
              'sessionId': 'session-1',
              'key': 'opaque-composite-key',
            },
            'owner': {
              'machineId': 'peer-a',
              'machine': 'Peer A',
              'role': 'peer',
              'route': 'direct',
              'authoritative': true,
              'baseUrl': 'https://peer-a.example',
              'requiresIndependentAuthentication': true,
            },
            'session': {
              'id': 'session-1',
              'tool': 'codex',
              'title': 'Peer session',
              'status': 'idle',
              'attachMode': 'observe',
              'identity': {
                'machineId': 'peer-a',
                'tool': 'codex',
                'sessionId': 'session-1',
                'key': 'opaque-composite-key',
              },
              'owner': {
                'machineId': 'peer-a',
                'machine': 'Peer A',
                'role': 'peer',
                'route': 'direct',
                'authoritative': true,
                'baseUrl': 'https://peer-a.example',
                'requiresIndependentAuthentication': true,
              },
            },
          }),
        );

        final resolution = await client.resolveMachineSession(
          machineId: 'peer-a',
          tool: 'codex',
          sessionId: 'session-1',
        );

        expect(resolution.canConnect, isTrue);
        expect(resolution.identity.key, 'opaque-composite-key');
        expect(resolution.owner?.baseUrl, 'https://peer-a.example');
        expect(resolution.owner?.requiresIndependentAuthentication, isTrue);
      });
    });

    group('renameSession', () {
      test('returns RenameSessionResponse on success', () async {
        dioAdapter.onPatch(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/rename',
          data: Matchers.any,
          (server) => server.reply(200, {
            'ok': true,
            'title': 'New Title',
          }),
        );

        final response = await client.renameSession(
          'opencode',
          'session-1',
          'New Title',
        );
        expect(response.ok, isTrue);
        expect(response.title, 'New Title');
      });

      test('can clear title with null', () async {
        dioAdapter.onPatch(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/rename',
          data: Matchers.any,
          (server) => server.reply(200, {
            'ok': true,
            'title': null,
          }),
        );

        final response = await client.renameSession(
          'opencode',
          'session-1',
          null,
        );
        expect(response.ok, isTrue);
        expect(response.title, isNull);
      });
    });

    group('renameProject', () {
      test('sends the directory and returns its display alias', () async {
        dioAdapter.onPatch(
          'http://127.0.0.1:7734/api/projects/rename',
          data: {'cwd': '/repo/project', 'name': 'Release work'},
          (server) => server.reply(200, {
            'ok': true,
            'cwd': '/repo/project',
            'projectName': 'Release work',
          }),
        );

        final response = await client.renameProject(
          '/repo/project',
          'Release work',
        );
        expect(response.ok, isTrue);
        expect(response.cwd, '/repo/project');
        expect(response.projectName, 'Release work');
      });

      test('can reset the display alias without changing cwd', () async {
        dioAdapter.onPatch(
          'http://127.0.0.1:7734/api/projects/rename',
          data: {'cwd': '/repo/project', 'name': null},
          (server) => server.reply(200, {
            'ok': true,
            'cwd': '/repo/project',
            'projectName': null,
          }),
        );

        final response = await client.renameProject('/repo/project', null);
        expect(response.cwd, '/repo/project');
        expect(response.projectName, isNull);
      });
    });

    group('clearSessionCache', () {
      test('returns ClearSessionCacheResponse on success', () async {
        dioAdapter.onDelete(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/cache',
          (server) => server.reply(200, {
            'ok': true,
            'clearedArtifacts': 5,
          }),
        );

        final response = await client.clearSessionCache(
          'opencode',
          'session-1',
        );
        expect(response.ok, isTrue);
        expect(response.clearedArtifacts, 5);
      });
    });

    group('forkSession', () {
      test('succeeds with session payload', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/fork',
          data: Matchers.any,
          (server) => server.reply(200, {
            'ok': true,
            'session': {
              'id': 'session-1-fork',
              'tool': 'opencode',
              'title': 'Forked',
              'status': 'idle',
              'attachMode': 'live',
            },
          }),
        );

        final response = await client.forkSession('opencode', 'session-1');
        expect(response.ok, isTrue);
        expect(response.session, isNotNull);
        expect(response.session!.id, 'session-1-fork');
        expect(response.session!.title, 'Forked');
      });

      test('includes messageId when provided', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/fork',
          data: {'messageId': 'msg-456'},
          (server) => server.reply(200, {'ok': true}),
        );

        final response = await client.forkSession(
          'opencode',
          'session-1',
          messageId: 'msg-456',
        );
        expect(response.ok, isTrue);
      });
    });

    group('cloneSession', () {
      test('succeeds with session payload', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/clone',
          data: Matchers.any,
          (server) => server.reply(200, {
            'ok': true,
            'session': {
              'id': 'session-1-clone',
              'tool': 'opencode',
              'title': 'Cloned',
              'status': 'idle',
              'attachMode': 'live',
            },
          }),
        );

        final response = await client.cloneSession('opencode', 'session-1');
        expect(response.ok, isTrue);
        expect(response.session, isNotNull);
        expect(response.session!.id, 'session-1-clone');
        expect(response.session!.title, 'Cloned');
      });
    });

    group('transcript export', () {
      test('prepares export using preflight endpoint', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/export/preflight',
          data: Matchers.any,
          (server) => server.reply(200, {
            'ok': true,
            'nonce': 'nonce-1',
            'expiresAt': 1719000000000,
            'confirm': {
              'action': 'transcriptExport',
              'tool': 'opencode',
              'sessionId': 'session-1',
              'sessionTitle': 'Session One',
              'format': 'html',
              'redactionMode': 'redacted-full',
              'tier': 'local',
              'retentionMinutes': 5,
              'sizeCapBytes': 1024,
              'irreversible': false,
              'message': 'Proceed',
            },
          }),
        );

        final response = await client.prepareTranscriptExport(
          'opencode',
          'session-1',
        );
        expect(response.ok, isTrue);
        expect(response.nonce, 'nonce-1');
        expect(response.confirm.format, 'html');
      });

      test('executes export with nonce', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/export',
          data: Matchers.any,
          (server) => server.reply(200, {
            'ok': true,
            'artifact': {
              'name': 'transcript.html',
              'format': 'html',
              'deliveryClass': 'export-attachment',
              'expiresAt': 1719000000000,
            },
          }),
        );

        final response = await client.exportTranscript(
          'opencode',
          'session-1',
          nonce: 'nonce-1',
        );
        expect(response.ok, isTrue);
        expect(response.artifact, isNotNull);
        expect(response.artifact!.deliveryClass, 'export-attachment');
      });
    });

    group('session filesystem', () {
      test('readSessionFile returns FsReadResult', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/fs/read'
          '?path=main.dart&maxBytes=1024',
          (server) => server.reply(200, {
            'ok': true,
            'path': 'main.dart',
            'size': 5,
            'limit': 1024,
            'truncated': false,
            'encoding': 'utf8',
            'data': 'hello',
            'mimeType': 'text/plain',
          }),
        );

        final response = await client.readSessionFile(
          'opencode',
          'session-1',
          path: 'main.dart',
          maxBytes: 1024,
        );
        expect(response.data, 'hello');
        expect(response.encoding, 'utf8');
        expect(response.mimeType, 'text/plain');
      });

      test('listSessionDirectory returns FsDirectoryResult', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/fs?path=src',
          (server) => server.reply(200, {
            'ok': true,
            'path': 'src',
            'stat': {
              'path': 'src',
              'type': 'directory',
              'size': 0,
              'mtimeMs': 0,
              'isDirectory': true,
              'isRegularFile': false,
              'isSymbolicLink': false,
            },
            'entries': [
              {
                'name': 'main.dart',
                'path': 'src/main.dart',
                'type': 'file',
                'size': 5,
                'mtimeMs': 0,
              },
            ],
          }),
        );

        final response = await client.listSessionDirectory(
          'opencode',
          'session-1',
          path: 'src',
        );
        expect(response.stat.isDirectory, isTrue);
        expect(response.entries, hasLength(1));
        expect(response.entries.first.name, 'main.dart');
      });

      test('downloadSessionFile returns bytes with W14 mime', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/fs/download'
          '?path=src%2Fmain.dart',
          (server) => server.reply(
            200,
            'hello-bytes',
            headers: {
              'content-type': ['application/octet-stream'],
              'x-cosyncing-mime-type': ['text/x-dart'],
              'content-length': ['11'],
            },
          ),
        );

        final download = await client.downloadSessionFile(
          'opencode',
          'session-1',
          path: 'src/main.dart',
        );
        expect(download.bytes, utf8.encode('hello-bytes'));
        // x-cosyncing-mime-type takes precedence over content-type.
        expect(download.contentType, 'text/x-dart');
        expect(download.contentLength, 11);
        expect(
          download.sourceUrl,
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/fs/download'
          '?path=src%2Fmain.dart',
        );
      });

      test('downloadSessionFile falls back to content-type mime', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/fs/download'
          '?path=notes.txt',
          (server) => server.reply(
            200,
            'plain',
            headers: {
              'content-type': ['text/plain'],
            },
          ),
        );

        final download = await client.downloadSessionFile(
          'opencode',
          'session-1',
          path: 'notes.txt',
        );
        expect(download.bytes, utf8.encode('plain'));
        expect(download.contentType, 'text/plain');
      });

      test(
        'downloadSessionFile sends Range and exposes resume metadata',
        () async {
          dioAdapter.onGet(
            'http://127.0.0.1:7734/api/sessions/opencode/session-1/fs/download'
            '?path=large.bin',
            headers: const {
              'range': 'bytes=512-1023',
              'if-range': '"file-v1"',
            },
            (server) => server.reply(
              206,
              Uint8List.fromList(List<int>.filled(512, 7)),
              headers: {
                'content-type': ['application/octet-stream'],
                'content-length': ['512'],
                'content-range': ['bytes 512-1023/2048'],
                'accept-ranges': ['bytes'],
                'etag': ['"file-v1"'],
                'last-modified': ['Fri, 17 Jul 2026 12:00:00 GMT'],
              },
            ),
          );

          final download = await client.downloadSessionFile(
            'opencode',
            'session-1',
            path: 'large.bin',
            rangeStart: 512,
            rangeEnd: 1023,
            ifRange: '"file-v1"',
          );

          expect(download.statusCode, 206);
          expect(download.bytes, hasLength(512));
          expect(download.contentRange, 'bytes 512-1023/2048');
          expect(download.acceptRanges, 'bytes');
          expect(download.etag, '"file-v1"');
          expect(download.lastModified, 'Fri, 17 Jul 2026 12:00:00 GMT');
        },
      );

      test('downloadSessionFile returns an empty typed 416 boundary', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/fs/download'
          '?path=empty.txt',
          headers: const {'range': 'bytes=0-511'},
          (server) => server.reply(
            416,
            Uint8List(0),
            headers: {
              'content-range': ['bytes */0'],
              'accept-ranges': ['bytes'],
              'etag': ['"empty-v1"'],
            },
          ),
        );

        final download = await client.downloadSessionFile(
          'opencode',
          'session-1',
          path: 'empty.txt',
          rangeStart: 0,
          rangeEnd: 511,
        );

        expect(download.statusCode, 416);
        expect(download.bytes, isEmpty);
        expect(download.contentRange, 'bytes */0');
      });

      test('downloadSessionFile wraps FS_REMOTE_DISABLED', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/fs/download'
          '?path=src%2Fmain.dart',
          (server) => server.reply(
            403,
            {
              'error': 'Remote file access is disabled',
              'code': 'FS_REMOTE_DISABLED',
            },
          ),
        );

        try {
          await client.downloadSessionFile(
            'opencode',
            'session-1',
            path: 'src/main.dart',
          );
          fail('should throw');
        } on BrokerException catch (e) {
          expect(e.statusCode, 403);
          expect(e.error?.code, 'FS_REMOTE_DISABLED');
          expect(e.message, 'File download failed');
        }
      });
    });

    group('chunked uploads', () {
      test('initUpload returns UploadInitResult', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/uploads',
          data: Matchers.any,
          (server) => server.reply(200, {
            'ok': true,
            'uploadId': 'upload-1',
            'offset': 0,
            'size': 1024,
            'expiresAt': 1719900000000,
          }),
        );

        final response = await client.initUpload(
          'opencode',
          'session-1',
          name: 'file.bin',
          mimeType: 'application/octet-stream',
          size: 1024,
        );
        expect(response.uploadId, 'upload-1');
        expect(response.size, 1024);
      });

      test('getUploadStatus returns UploadStatus', () async {
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/uploads/upload-1',
          (server) => server.reply(200, {
            'ok': true,
            'uploadId': 'upload-1',
            'offset': 512,
            'size': 1024,
            'name': 'file.bin',
            'mimeType': 'application/octet-stream',
          }),
        );

        final response = await client.getUploadStatus(
          'opencode',
          'session-1',
          'upload-1',
        );
        expect(response.offset, 512);
        expect(response.name, 'file.bin');
        expect(response.mimeType, 'application/octet-stream');
      });

      test('completeUpload returns UploadCompleteResult', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/uploads/upload-1/complete',
          (server) => server.reply(200, {
            'ok': true,
            'uploadId': 'upload-1',
            'stagedRef': 'stg1.opaque',
            'name': 'file.bin',
            'mimeType': 'application/octet-stream',
            'size': 1024,
            'expiresAt': 1719900000000,
          }),
        );

        final response = await client.completeUpload(
          'opencode',
          'session-1',
          'upload-1',
        );
        expect(response.uploadId, 'upload-1');
        expect(response.stagedRef, 'stg1.opaque');
        expect(response.size, 1024);
        expect(response.mimeType, 'application/octet-stream');
        expect(response.expiresAt, 1719900000000);
      });

      test('patchUploadChunk sends binary body with offset header', () async {
        dioAdapter.onPatch(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/uploads/upload-1',
          data: Matchers.any,
          (server) => server.reply(200, {
            'ok': true,
            'uploadId': 'upload-1',
            'offset': 515,
            'size': 1024,
            'progress': 0.5,
          }),
        );

        final response = await client.patchUploadChunk(
          'opencode',
          'session-1',
          'upload-1',
          offset: 512,
          bytes: const [1, 2, 3],
        );

        expect(response.uploadId, 'upload-1');
        expect(response.offset, 515);
        expect(response.progress, 0.5);
      });

      test('patchUploadChunk exposes authoritative offset mismatch', () async {
        dioAdapter.onPatch(
          'http://127.0.0.1:7734/api/sessions/opencode/session-1/uploads/upload-1',
          data: Matchers.any,
          (server) => server.reply(409, {
            'error': 'Offset mismatch',
            'code': 'UPLOAD_OFFSET_MISMATCH',
            'expectedOffset': 768,
          }),
        );

        try {
          await client.patchUploadChunk(
            'opencode',
            'session-1',
            'upload-1',
            offset: 512,
            bytes: const [1, 2, 3],
          );
          fail('should throw');
        } on UploadOffsetMismatchException catch (e) {
          expect(e.statusCode, 409);
          expect(e.error?.code, 'UPLOAD_OFFSET_MISMATCH');
          expect(e.expectedOffset, 768);
        }
      });
    });

    group('transport pairing', () {
      test('acceptTransportPairing posts typed accept body', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/transport/pairings/pair_abc/accept',
          data: {
            'peerId': 'phone-1',
            'peerToken': 'phone-token',
            'identityPublicKey': 'ed25519-public',
            'exchangePublicKey': 'x25519-public',
          },
          (server) => server.reply(200, {
            'ok': true,
            'peer': {
              'peerId': 'phone-1',
              'label': 'Phone',
              'identityPublicKey': 'ed25519-public',
            },
            'broker': {
              'peerId': 'broker-1',
              'peerToken': 'broker-token',
              'identityPublicKey': 'broker-identity-public',
            },
            'wrappedDataKey': {
              'version': 1,
              'algorithm': 'X25519-HKDF-SHA256-AES-256-GCM',
              'ephemeralPublicKey': 'ephemeral',
              'nonce': 'nonce',
              'ciphertext': 'cipher',
              'tag': 'tag',
            },
          }),
        );

        final response = await client.acceptTransportPairing(
          'pair_abc',
          const TransportPairingAcceptRequest(
            peerId: 'phone-1',
            peerToken: 'phone-token',
            identityPublicKey: 'ed25519-public',
            exchangePublicKey: 'x25519-public',
          ),
        );

        expect(response.peer.peerId, 'phone-1');
        expect(response.peer.label, 'Phone');
        expect(response.broker.peerId, 'broker-1');
        expect(response.broker.peerToken, 'broker-token');
        expect(response.wrappedDataKey.algorithm, contains('X25519'));
      });

      test('acceptTransportPairing surfaces pairing error codes', () async {
        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/transport/pairings/pair_used/accept',
          data: Matchers.any,
          (server) => server.reply(409, {
            'error': 'this pairing QR was already used',
            'code': 'PAIRING_ALREADY_ACCEPTED',
          }),
        );

        expect(
          () => client.acceptTransportPairing(
            'pair_used',
            const TransportPairingAcceptRequest(
              peerId: 'phone-1',
              peerToken: 'phone-token',
              identityPublicKey: 'ed25519-public',
              exchangePublicKey: 'x25519-public',
            ),
          ),
          throwsA(
            isA<BrokerException>().having(
              (e) => e.error?.code,
              'error.code',
              'PAIRING_ALREADY_ACCEPTED',
            ),
          ),
        );
      });
    });

    group('fetchArtifactUrl', () {
      test('returns artifact bytes with response metadata', () async {
        const url =
            'https://cdn.example.net/api/sessions/opencode/session-1/artifact/file-html?expires=1700000000&sig=token';

        dioAdapter.onGet(
          url,
          (server) => server.reply(
            200,
            'demo',
            headers: {
              'content-type': ['text/plain'],
              'content-length': ['4'],
              'x-artifact-key': ['artifact-123'],
              'x-content-hash': ['sha256:abcd'],
            },
          ),
        );

        final artifact = await client.fetchArtifactUrl(url);
        expect(artifact.bytes, [100, 101, 109, 111]);
        expect(artifact.contentType, 'text/plain');
        expect(artifact.contentLength, 4);
        expect(artifact.artifactKey, 'artifact-123');
        expect(artifact.contentHash, 'sha256:abcd');
        expect(artifact.sourceUrl, url);
      });

      test('wraps non-JSON failures as BrokerException', () async {
        const url =
            'https://cdn.example.net/api/sessions/opencode/session-1/artifact/fail';

        dioAdapter.onGet(
          url,
          (server) => server.reply(503, 'temporary outage'),
        );

        try {
          await client.fetchArtifactUrl(url);
          fail('should throw');
        } on BrokerException catch (e) {
          expect(e.statusCode, 503);
          expect(e.message, 'Artifact fetch failed');
        }
      });

      test('preserves signed fetch URLs and query parameters', () async {
        const signedUrl =
            'https://cdn.example.net/api/sessions/opencode/session-1/artifact/signed?expires=1700000000&sig=abc123%2Ftoken%3D';

        dioAdapter.onGet(
          signedUrl,
          (server) => server.reply(
            200,
            'z',
            headers: {
              'content-type': ['application/octet-stream'],
            },
          ),
        );

        final artifact = await client.fetchArtifactUrl(signedUrl);
        expect(artifact.sourceUrl, signedUrl);
        expect(artifact.bytes, [122]);
      });
    });

    group('with token', () {
      test('sends auth header when token is set', () async {
        final authenticatedClient = BrokerClient(
          baseUrl: 'http://127.0.0.1:7734',
          token: 'test-token',
          dio: dio,
        );

        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/health',
          headers: {'x-cosyncing-token': 'test-token'},
          (server) => server.reply(200, {'ok': true}),
        );

        await authenticatedClient.getHealth();
        authenticatedClient.close();
      });

      test('sends auth header and body on admin calls', () async {
        final authenticatedClient = BrokerClient(
          baseUrl: 'http://127.0.0.1:7734',
          token: 'admin-token',
          dio: dio,
        );

        dioAdapter.onPost(
          'http://127.0.0.1:7734/api/tokdash/quota-preference',
          headers: {'x-cosyncing-token': 'admin-token'},
          data: {'enabled': true},
          (server) => server.reply(200, {'ok': true, 'enabled': true}),
        );

        await authenticatedClient.setTokdashQuotaPreference(
          const TokdashQuotaPreferenceRequest(enabled: true),
        );
        authenticatedClient.close();
      });
    });

    group('fetchArtifactUrlBounded', () {
      // The happy path and the post-download over-ceiling guard use the mock
      // adapter below. The mid-flight web bound — Dio's `onReceiveProgress`
      // cancelling an oversized transfer before it fully lands — is exercised
      // by `_ChunkedHttpAdapter`, a real incremental transport (the mock cannot
      // stream, which is why this path was previously integration-only).
      test('returns the body when within the byte ceiling', () async {
        final body = utf8.encode('a small diff body');
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/diff',
          (server) => server.reply(200, body),
        );
        final download = await client.fetchArtifactUrlBounded(
          'http://127.0.0.1:7734/api/diff',
          maxBytes: 4096,
        );
        expect(download.bytes.length, body.length);
      });

      test('throws ArtifactTooLargeException when the body exceeds the '
          'ceiling', () async {
        final big = List<int>.filled(4096, 65);
        dioAdapter.onGet(
          'http://127.0.0.1:7734/api/big',
          (server) => server.reply(200, big),
        );
        await expectLater(
          client.fetchArtifactUrlBounded(
            'http://127.0.0.1:7734/api/big',
            maxBytes: 1024,
          ),
          throwsA(isA<ArtifactTooLargeException>()),
        );
      });

      test('cancels the transfer once the running received count crosses the '
          'ceiling (the Flutter Web byte bound)', () async {
        // No content-length: the only signal is the accumulating received
        // count — exactly the browser XHR case the web bound targets. The
        // adapter streams ten 512-byte chunks; the ceiling is crossed on the
        // third, and Dio must abort the subscription before the rest arrive.
        final adapter = _ChunkedHttpAdapter(
          chunks: List.generate(10, (_) => List<int>.filled(512, 65)),
        );
        dio.httpClientAdapter = adapter;
        await expectLater(
          client.fetchArtifactUrlBounded(
            'http://127.0.0.1:7734/api/stream',
            maxBytes: 1024,
          ),
          throwsA(isA<ArtifactTooLargeException>()),
        );
        expect(
          adapter.streamCancelled,
          isTrue,
          reason: 'Dio must abort the download subscription mid-stream',
        );
        expect(
          adapter.chunksEmitted,
          lessThan(adapter.chunks.length),
          reason: 'the transfer must stop before every chunk is sent',
        );
      });

      test('cancels immediately when the advertised content-length exceeds '
          'the ceiling, without draining the body', () async {
        // 1 MiB advertised against a 4 KiB ceiling: the first progress
        // callback carries a `total` over the limit, so the abort fires on the
        // first chunk — the body is never drained.
        final adapter = _ChunkedHttpAdapter(
          chunks: List.generate(8, (_) => List<int>.filled(256, 65)),
          contentLength: 1 << 20,
        );
        dio.httpClientAdapter = adapter;
        await expectLater(
          client.fetchArtifactUrlBounded(
            'http://127.0.0.1:7734/api/huge',
            maxBytes: 4096,
          ),
          throwsA(isA<ArtifactTooLargeException>()),
        );
        expect(adapter.streamCancelled, isTrue);
        expect(
          adapter.chunksEmitted,
          lessThan(adapter.chunks.length),
          reason: 'an advertised oversize must abort before the full body',
        );
      });
    });
  });
}

/// A [Dio] adapter that streams [chunks] to the client incrementally (with a
/// tiny gap between each) so Dio fires `onReceiveProgress` per chunk — the only
/// hook `fetchArtifactUrlBounded` can use to bound a download on Flutter Web,
/// where the browser XHR adapter buffers the whole response and exposes no
/// incremental byte stream. Records whether Dio cancelled the download
/// subscription ([streamCancelled]) and how many chunks actually went out
/// ([chunksEmitted]) so a test can prove the transfer was aborted mid-flight
/// rather than fully buffered.
class _ChunkedHttpAdapter implements HttpClientAdapter {
  _ChunkedHttpAdapter({
    required this.chunks,
    this.contentLength,
  });

  final List<List<int>> chunks;
  final int? contentLength;

  bool streamCancelled = false;
  int chunksEmitted = 0;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    late final StreamController<Uint8List> controller;
    controller = StreamController<Uint8List>(
      onListen: () async {
        for (final chunk in chunks) {
          // Stop feeding the moment Dio aborts the subscription (the cancel).
          if (streamCancelled || controller.isClosed) return;
          controller.add(Uint8List.fromList(chunk));
          chunksEmitted += 1;
          // Yield so Dio can deliver the chunk, run onReceiveProgress, and
          // (when over the ceiling) cancel before the next chunk is queued.
          await Future<void>.delayed(const Duration(milliseconds: 1));
        }
        if (!controller.isClosed) await controller.close();
      },
      onCancel: () => streamCancelled = true,
    );
    return ResponseBody(
      controller.stream,
      200,
      headers: {
        Headers.contentTypeHeader: const ['application/octet-stream'],
        if (contentLength != null)
          Headers.contentLengthHeader: ['$contentLength'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}
