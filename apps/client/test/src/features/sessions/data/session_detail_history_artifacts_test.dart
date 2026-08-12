// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/created_session_attach_intents.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_command_args_codec.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import '../../../../support/session_detail_controller_test_harness.dart';

void main() {
  late FakeSessionDetailConnection fakeConnection;
  late FakeControllerArtifactFileService fakeArtifactFileService;
  late FakeControllerAttachmentPicker fakeAttachmentPicker;
  late FakeControllerBrokerClient fakeBrokerClient;
  late RecordingSessionOutboxRepository fakeOutboxRepository;
  late RecordingSessionTranscriptRepository fakeTranscriptRepository;
  late InMemoryControllerDriveIntentStore fakeDriveIntentStore;
  late InMemorySessionListRepository fakeSessionListRepository;
  late StubSessionListController fakeSessionListController;
  late ProviderContainer container;

  setUp(() {
    fakeConnection = FakeSessionDetailConnection();
    fakeArtifactFileService = FakeControllerArtifactFileService();
    fakeAttachmentPicker = FakeControllerAttachmentPicker();
    fakeBrokerClient = FakeControllerBrokerClient();
    fakeOutboxRepository = RecordingSessionOutboxRepository();
    fakeTranscriptRepository = RecordingSessionTranscriptRepository();
    fakeDriveIntentStore = InMemoryControllerDriveIntentStore();
    fakeSessionListRepository = InMemorySessionListRepository();
    fakeSessionListController = StubSessionListController();
    container = ProviderContainer(
      overrides: [
        ...dr1DurableDraftTestOverrides(),
        activeBrokerProfileProvider.overrideWith(
          (ref) => fakeControllerBrokerProfile(),
        ),
        brokerClientProvider.overrideWith((ref) async => fakeBrokerClient),
        sessionNotificationLifecycleMonitorProvider.overrideWithValue(
          StubBrokerAppLifecycleMonitor(
            currentState: BrokerAppLifecycleState.paused,
          ),
        ),
        sessionNotificationSinkProvider.overrideWithValue(
          CollectingNotificationSink(),
        ),
        sessionDetailConnectionFactoryProvider.overrideWithValue(
          ({required resolver, required sessionId, required tool}) {
            fakeConnection
              ..sessionId = sessionId
              ..tool = tool;
            return fakeConnection;
          },
        ),
        sessionArtifactFileServiceProvider.overrideWithValue(
          fakeArtifactFileService,
        ),
        sessionAttachmentPickerProvider.overrideWithValue(
          fakeAttachmentPicker,
        ),
        sessionArtifactTransferRepositoryProvider.overrideWithValue(
          InMemorySessionArtifactTransferRepository(),
        ),
        sessionOutboxRepositoryProvider.overrideWithValue(
          fakeOutboxRepository,
        ),
        sessionTranscriptRepositoryProvider.overrideWithValue(
          fakeTranscriptRepository,
        ),
        sessionDriveIntentStoreProvider.overrideWithValue(
          fakeDriveIntentStore,
        ),
        sessionListRepositoryProvider.overrideWith(
          (ref) async => fakeSessionListRepository,
        ),
        sessionListControllerProvider.overrideWith(
          () => fakeSessionListController,
        ),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  _BlockingHistoryPageConnection buildBlockerConnection(
    Completer<void> hold, {
    FakeSessionDetailConnection? fallback,
  }) {
    return _BlockingHistoryPageConnection(
      connection: fallback ?? fakeConnection,
      hold: hold,
    );
  }

  group(
    'SessionDetailController session_detail_history_artifacts_test.dart',
    () {
      const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

      test('projects live and replayed messages for renderers', () async {
        keepSessionDetailAlive(container, key);

        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        fakeConnection
          ..emitEvent(
            const HistoryWireEvent(
              messages: [
                AgentMessage(
                  type: AgentMessageType.userMessage,
                  raw: {'type': 'user-message'},
                ),
                AgentMessage(
                  type: AgentMessageType.error,
                  raw: {'type': 'error'},
                ),
              ],
              reset: true,
              cursor: 'cursor-1',
            ),
          )
          ..emitEvent(
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.modelOutput,
                raw: {'type': 'model-output'},
              ),
            ),
          );
        await Future<void>.delayed(Duration.zero);

        final state = container.read(sessionDetailControllerProvider(key));
        expect(
          state.messageEvents.map((message) => message.type),
          [
            AgentMessageType.userMessage,
            AgentMessageType.error,
            AgentMessageType.modelOutput,
          ],
        );
      });

      test(
        'exposes derived terminal and artifact messages from live and history',
        () {
          const state = SessionDetailState(
            tool: 'claude',
            sessionId: 'session-1',
            events: [
              HistoryWireEvent(
                reset: true,
                cursor: 'cursor-1',
                messages: [
                  AgentMessage(
                    type: AgentMessageType.fileArtifact,
                    id: 'artifact-history',
                    raw: {'type': 'file-artifact'},
                  ),
                  AgentMessage(
                    type: AgentMessageType.terminalOutput,
                    id: 'term-history',
                    raw: {'type': 'terminal-output'},
                  ),
                ],
              ),
              MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.terminalOutput,
                  id: 'term-live',
                  raw: {'type': 'terminal-output'},
                ),
              ),
              MessageWireEvent(
                seq: 2,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-live',
                  raw: {'type': 'file-artifact'},
                ),
              ),
            ],
          );

          expect(
            state.terminalOutputMessages.map((message) => message.id),
            ['term-history', 'term-live'],
          );
          expect(
            state.fileArtifactMessages.map((message) => message.id),
            ['artifact-history', 'artifact-live'],
          );
        },
      );

      test('downloadArtifact caches and exports inline artifacts', () async {
        keepSessionDetailAlive(container, key);

        final tempDir = await Directory.systemTemp.createTemp('g6-artifact');
        addTearDown(() => tempDir.delete(recursive: true));
        final tempFile = File('${tempDir.path}/inline-artifact.bin')
          ..writeAsStringSync('artifact-data');
        fakeArtifactFileService
          ..mockCachedFile = SessionArtifactCachedFile(
            cachedFilePath: tempFile.path,
            fileName: 'inline-artifact.bin',
            byteLength: tempFile.lengthSync(),
          )
          ..exportedPath = 'saved-${tempFile.path}';

        final saved = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .downloadArtifact(
              const SessionArtifactDescriptor(
                name: 'inline-artifact.bin',
                url: 'data:text/plain;base64,YWJj',
              ),
            );

        expect(saved, isTrue);
        expect(fakeArtifactFileService.cacheCallCount, 1);
        expect(fakeArtifactFileService.exportCallCount, 1);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .actionStateFor('inline-artifact.bin')
              .phase,
          SessionArtifactActionPhase.saved,
        );
        final transfer = container
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.completed);
        expect(transfer.direction, SessionArtifactTransferDirection.download);
        expect(transfer.exportedPath, 'saved-${tempFile.path}');
      });

      test(
        'downloadArtifact errors when no active broker client for remote file',
        () async {
          final offlineContainer = ProviderContainer(
            overrides: [
              ...dr1DurableDraftTestOverrides(),
              activeBrokerProfileProvider.overrideWith((ref) => null),
              sessionDetailConnectionFactoryProvider.overrideWithValue(
                ({required resolver, required sessionId, required tool}) {
                  fakeConnection
                    ..sessionId = sessionId
                    ..tool = tool;
                  return fakeConnection;
                },
              ),
              sessionArtifactFileServiceProvider.overrideWithValue(
                fakeArtifactFileService,
              ),
              sessionArtifactTransferRepositoryProvider.overrideWithValue(
                InMemorySessionArtifactTransferRepository(),
              ),
              sessionOutboxRepositoryProvider.overrideWithValue(
                RecordingSessionOutboxRepository(),
              ),
              sessionTranscriptRepositoryProvider.overrideWithValue(
                RecordingSessionTranscriptRepository(),
              ),
            ],
          );
          addTearDown(offlineContainer.dispose);
          keepSessionDetailAlive(offlineContainer, key);

          final saved = await offlineContainer
              .read(sessionDetailControllerProvider(key).notifier)
              .downloadArtifact(
                const SessionArtifactDescriptor(
                  name: 'artifact.bin',
                  artifactKey: 'file-123',
                  fetchUrl:
                      'https://cdn.example.net/api/sessions/claude/session-1'
                      '/artifact/file-123',
                ),
              );

          expect(saved, isFalse);
          expect(fakeArtifactFileService.cacheCallCount, 0);
          expect(fakeArtifactFileService.exportCallCount, 0);
          expect(
            offlineContainer
                .read(sessionDetailControllerProvider(key))
                .actionStateFor('file-123')
                .phase,
            SessionArtifactActionPhase.error,
          );
          expect(
            offlineContainer
                .read(sessionDetailControllerProvider(key))
                .actionStateFor('file-123')
                .message,
            contains('Connect to the server before downloading this artifact.'),
          );
          expect(
            offlineContainer.read(sessionDetailControllerProvider(key)).error,
            isNull,
          );
          final transfer = offlineContainer
              .read(sessionArtifactTransferControllerProvider)
              .single;
          expect(transfer.status, SessionArtifactTransferStatus.failed);
          expect(
            transfer.error,
            contains('Connect to the server before downloading this artifact.'),
          );
        },
      );

      test(
        'downloadArtifact surfaces save failures as artifact action errors',
        () async {
          keepSessionDetailAlive(container, key);
          fakeArtifactFileService.shouldThrowOnCache = true;

          final saved = await container
              .read(sessionDetailControllerProvider(key).notifier)
              .downloadArtifact(
                const SessionArtifactDescriptor(
                  name: 'inline-artifact.bin',
                  url: 'data:text/plain;base64,YWJj',
                ),
              );

          expect(saved, isFalse);
          expect(fakeArtifactFileService.cacheCallCount, 1);
          expect(fakeArtifactFileService.exportCallCount, 0);
          expect(
            container
                .read(sessionDetailControllerProvider(key))
                .actionStateFor('inline-artifact.bin')
                .phase,
            SessionArtifactActionPhase.error,
          );
          expect(
            container
                .read(sessionDetailControllerProvider(key))
                .actionStateFor('inline-artifact.bin')
                .message,
            contains("Couldn't save this artifact."),
          );
          expect(
            container.read(sessionDetailControllerProvider(key)).error,
            isNull,
          );
        },
      );

      test('prepareArtifactPreview caches inline HTML artifacts', () async {
        keepSessionDetailAlive(container, key);
        fakeArtifactFileService.mockCachedFile =
            const SessionArtifactCachedFile(
              cachedFilePath: '/tmp/preview.html',
              fileName: 'preview.html',
              contentType: 'text/html',
              byteLength: 12,
            );

        final cached = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .prepareArtifactPreview(
              const SessionArtifactDescriptor(
                name: 'preview.html',
                mimeType: 'text/html',
                url: 'data:text/html;base64,PGgxPk9LPC9oMT4=',
              ),
            );

        expect(cached?.fileName, 'preview.html');
        expect(fakeArtifactFileService.cacheCallCount, 1);
        expect(fakeArtifactFileService.exportCallCount, 0);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .actionStateFor('preview.html')
              .phase,
          SessionArtifactActionPhase.previewing,
        );
        final transfer = container
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.cached);
        expect(transfer.direction, SessionArtifactTransferDirection.preview);
      });

      test('recordArtifactPreviewResult stores previewed state', () {
        keepSessionDetailAlive(container, key);

        container
            .read(sessionDetailControllerProvider(key).notifier)
            .recordArtifactPreviewResult(
              const SessionArtifactDescriptor(
                name: 'preview.html',
                mimeType: 'text/html',
                url: 'data:text/html;base64,PGgxPk9LPC9oMT4=',
              ),
              opened: true,
              message: 'Preview opened',
            );

        final state = container.read(sessionDetailControllerProvider(key));
        expect(
          state.actionStateFor('preview.html').phase,
          SessionArtifactActionPhase.previewed,
        );
        expect(state.actionStateFor('preview.html').message, 'Preview opened');
      });

      test(
        'recordArtifactPreviewResult completes latest preview transfer',
        () async {
          keepSessionDetailAlive(container, key);
          fakeArtifactFileService.mockCachedFile =
              const SessionArtifactCachedFile(
                cachedFilePath: '/tmp/preview.html',
                fileName: 'preview.html',
                contentType: 'text/html',
                byteLength: 12,
              );
          const descriptor = SessionArtifactDescriptor(
            name: 'preview.html',
            mimeType: 'text/html',
            url: 'data:text/html;base64,PGgxPk9LPC9oMT4=',
          );

          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .prepareArtifactPreview(descriptor);
          container
              .read(sessionDetailControllerProvider(key).notifier)
              .recordArtifactPreviewResult(
                descriptor,
                opened: true,
                message: 'Preview opened',
              );

          final transfer = container
              .read(sessionArtifactTransferControllerProvider)
              .single;
          expect(transfer.status, SessionArtifactTransferStatus.completed);
          expect(transfer.cachedFilePath, '/tmp/preview.html');
          expect(transfer.detailLabel, 'Preview opened');
        },
      );

      test('prepareArtifactPreview rejects non-HTML artifacts', () async {
        keepSessionDetailAlive(container, key);

        final cached = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .prepareArtifactPreview(
              const SessionArtifactDescriptor(
                name: 'notes.txt',
                mimeType: 'text/plain',
                url: 'data:text/plain,hello',
              ),
            );

        expect(cached, isNull);
        expect(fakeArtifactFileService.cacheCallCount, 0);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .actionStateFor('notes.txt')
              .message,
          contains('Only HTML artifacts can be previewed.'),
        );
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          isNull,
        );
      });

      test(
        'prepareArtifactPreview errors without active broker for remote HTML',
        () async {
          final offlineContainer = ProviderContainer(
            overrides: [
              ...dr1DurableDraftTestOverrides(),
              activeBrokerProfileProvider.overrideWith((ref) => null),
              sessionArtifactFileServiceProvider.overrideWithValue(
                fakeArtifactFileService,
              ),
              sessionArtifactTransferRepositoryProvider.overrideWithValue(
                InMemorySessionArtifactTransferRepository(),
              ),
              sessionOutboxRepositoryProvider.overrideWithValue(
                RecordingSessionOutboxRepository(),
              ),
              sessionTranscriptRepositoryProvider.overrideWithValue(
                RecordingSessionTranscriptRepository(),
              ),
            ],
          );
          addTearDown(offlineContainer.dispose);
          keepSessionDetailAlive(offlineContainer, key);

          final cached = await offlineContainer
              .read(sessionDetailControllerProvider(key).notifier)
              .prepareArtifactPreview(
                const SessionArtifactDescriptor(
                  name: 'preview.html',
                  mimeType: 'text/html',
                  artifactKey: 'html-1',
                  fetchUrl: 'https://cdn.example.net/artifacts/html-1',
                ),
              );

          expect(cached, isNull);
          expect(fakeArtifactFileService.cacheCallCount, 0);
          expect(
            offlineContainer
                .read(sessionDetailControllerProvider(key))
                .actionStateFor('html-1')
                .message,
            contains('Connect to the server before previewing this artifact.'),
          );
          expect(
            offlineContainer.read(sessionDetailControllerProvider(key)).error,
            isNull,
          );
        },
      );

      test('prepareArtifactPreview surfaces cache failures', () async {
        keepSessionDetailAlive(container, key);
        fakeArtifactFileService.shouldThrowOnCache = true;

        final cached = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .prepareArtifactPreview(
              const SessionArtifactDescriptor(
                name: 'preview.html',
                mimeType: 'text/html',
                url: 'data:text/html;base64,PGgxPk9LPC9oMT4=',
              ),
            );

        expect(cached, isNull);
        expect(fakeArtifactFileService.cacheCallCount, 1);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .actionStateFor('preview.html')
              .message,
          contains("Couldn't prepare this artifact preview."),
        );
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          isNull,
        );
      });

      test('sendPrompt sends trimmed text only when connected', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPrompt('   hello module g3a   ');

        expect(sent, isTrue);
        expect(fakeConnection.sendPromptCount, 1);
        expect(fakeConnection.lastPrompt, 'hello module g3a');
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          isNull,
        );
      });

      test(
        'sendPrompt renders immediately and adopts the broker echo',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();

          final sent = await container
              .read(sessionDetailControllerProvider(key).notifier)
              .sendPrompt('visible immediately');

          expect(sent, isTrue);
          var current = container.read(sessionDetailControllerProvider(key));
          expect(current.optimisticPrompts, hasLength(1));
          expect(
            current.transcriptMessageEvents.single.raw['text'],
            'visible immediately',
          );

          fakeConnection.emitEvent(
            MessageWireEvent(
              seq: 1,
              message: AgentMessage.fromJson({
                'type': 'user-message',
                'key': 'native-user-1',
                'text': 'visible immediately',
              }),
            ),
          );
          await Future<void>.delayed(Duration.zero);

          current = container.read(sessionDetailControllerProvider(key));
          // In-order delivery: the echo landed exactly at the row's boundary,
          // so the position holder retires immediately (bounded state). The
          // RENDERED transcript adopts the canonical echo exactly once, still
          // under the same display identity (the legacy association is kept).
          expect(current.optimisticPrompts, isEmpty);
          expect(current.transcriptMessageEvents, hasLength(1));
          expect(
            current.transcriptMessageEvents.single.userMessageKey,
            'native-user-1',
          );
          expect(
            current.transcriptMessageEvents.single.userMessageClientKey,
            isNotNull,
          );
        },
      );

      test('sendPrompt persists and sends the exact model override', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        const model = SessionCurrentModel(
          providerID: 'openai',
          modelID: 'gpt-5.4',
          reasoningEffort: 'high',
          variant: 'codex',
        );

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPrompt('model turn', model: model);

        expect(sent, isTrue);
        expect(fakeConnection.lastPromptModel?.modelID, 'gpt-5.4');
        expect(fakeConnection.lastPromptModel?.reasoningEffort, 'high');
        final payload = fakeOutboxRepository.messages.single.payload;
        expect(payload['model'], model.toJson());
      });

      test(
        'sendDraft relays connected text without touching the outbox',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          fakeConnection
            ..emitSessionControl(const {
              'drive': {'state': 'driving', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            })
            // The draft contract is negotiated by hello, as on a real attach.
            ..emitEvent(defaultControllerHello);
          await drainSessionDetailMicrotasks();
          final before = await fakeOutboxRepository.loadForSession(key);

          final sent = await container
              .read(sessionDetailControllerProvider(key).notifier)
              .sendDraft('shared draft');

          expect(sent, isTrue);
          expect(fakeConnection.sendDraftCount, 1);
          expect(fakeConnection.lastDraft, 'shared draft');
          expect(await fakeOutboxRepository.loadForSession(key), before);
        },
      );

      test('sendDraft is a quiet no-op while disconnected', () async {
        keepSessionDetailAlive(container, key);

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendDraft('offline draft');

        expect(sent, isFalse);
        expect(fakeConnection.sendDraftCount, 0);
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          isNull,
        );
      });

      test(
        'semantic plan and artifact actions use the durable outbox',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
          await Future<void>.delayed(Duration.zero);

          final planSent = await controller.sendPlanAction(
            const PlanActionRequest(
              action: PlanActionKind.approve,
              planKey: 'tasks:main',
              planRevision: 'revision-7',
              title: 'Plan',
              items: [
                PlanActionItem(title: 'Implement', status: 'in-progress'),
              ],
            ),
          );
          final artifactSent = await controller.sendArtifactInteraction(
            const ArtifactInteractionRequest(
              artifactKey: 'artifact-1',
              interactionRef: 'signed:artifact-1:v1',
              interaction: {'type': 'click', 'action': 'approve'},
            ),
          );

          expect(planSent, isTrue);
          expect(artifactSent, isTrue);
          expect(fakeConnection.sendPlanActionCount, 1);
          expect(fakeConnection.lastPlanAction?.planKey, 'tasks:main');
          expect(fakeConnection.sendArtifactInteractionCount, 1);
          expect(
            fakeConnection.lastArtifactInteraction?.artifactKey,
            'artifact-1',
          );
          expect(
            fakeOutboxRepository.messages.map((message) => message.kind),
            [
              SessionOutboxMessageKind.planAction,
              SessionOutboxMessageKind.artifactInteraction,
            ],
          );
        },
      );

      test('semantic prompt-like actions fail closed in Observe', () async {
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await Future<void>.delayed(Duration.zero);

        final sent = await controller.sendPlanAction(
          const PlanActionRequest(
            action: PlanActionKind.exit,
            planKey: 'tasks:main',
            planRevision: 'revision-7',
            title: 'Plan',
          ),
        );

        expect(sent, isFalse);
        expect(fakeConnection.sendPlanActionCount, 0);
        expect(fakeOutboxRepository.messages, isEmpty);
      });

      test('malformed plan authority never enters the outbox', () async {
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await Future<void>.delayed(Duration.zero);

        final sent = await controller.sendPlanAction(
          const PlanActionRequest(
            action: PlanActionKind.approve,
            planKey: ' tasks:main',
            planRevision: 'revision-7',
          ),
        );

        expect(sent, isFalse);
        expect(fakeConnection.sendPlanActionCount, 0);
        expect(fakeOutboxRepository.messages, isEmpty);
      });

      test('explicit attach-ticket receipts use ack and nack paths', () async {
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();

        expect(
          await controller.sendAttachTicketReceipt(
            'ticket-1',
            accepted: true,
          ),
          isTrue,
        );
        expect(
          await controller.sendAttachTicketReceipt(
            'ticket-2',
            accepted: false,
          ),
          isTrue,
        );
        expect(fakeConnection.sendAckCount, 1);
        expect(fakeConnection.sendNackCount, 1);
        expect(fakeConnection.lastProtocolTicket, 'ticket-2');
      });

      test(
        'history attach ticket is acked only after durable commit',
        () async {
          final commit = Completer<void>();
          fakeTranscriptRepository.pendingUpsert = commit;
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();

          fakeConnection.emitEvent(
            HistoryWireEvent(
              messages: [
                AgentMessage.fromJson(const {
                  'type': 'model-output',
                  'key': 'answer-1',
                  'text': 'Durable answer',
                }),
              ],
              reset: true,
              cursor: 'cursor-9',
              attachTicket: 'ticket-durable',
            ),
          );
          await Future<void>.delayed(Duration.zero);

          expect(fakeTranscriptRepository.upserts, hasLength(1));
          expect(fakeConnection.sendAckCount, 0);
          commit.complete();
          await drainSessionDetailMicrotasks();

          expect(fakeConnection.sendAckCount, 1);
          expect(fakeConnection.lastProtocolTicket, 'ticket-durable');
          expect(fakeTranscriptRepository.upserts.single.cursor, 'cursor-9');
          expect(
            fakeTranscriptRepository.upserts.single.messages.single.raw['text'],
            'Durable answer',
          );
        },
      );

      test('durable transcript failure nacks the attach ticket', () async {
        fakeTranscriptRepository.failUpsert = true;
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        fakeConnection.emitEvent(
          const HistoryWireEvent(
            messages: [],
            reset: true,
            cursor: 'cursor-failed',
            attachTicket: 'ticket-failed',
          ),
        );
        await drainSessionDetailMicrotasks();

        expect(fakeConnection.sendAckCount, 0);
        expect(fakeConnection.sendNackCount, 1);
        expect(fakeConnection.lastProtocolTicket, 'ticket-failed');
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          contains("Couldn't save this transcript on the device."),
        );
      });

      test('coalesces transcript commits behind an in-flight write', () async {
        final gate = Completer<void>();
        fakeTranscriptRepository.pendingUpsert = gate;
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        // A history frame carries an attach ticket; its commit blocks on the
        // gate, so every later message coalesces behind one pending snapshot.
        fakeConnection.emitEvent(
          HistoryWireEvent(
            messages: [
              AgentMessage.fromJson(const {
                'type': 'model-output',
                'key': 'answer-1',
                'text': 'first',
              }),
            ],
            reset: true,
            cursor: 'cursor-1',
            attachTicket: 'ticket-coalesce',
          ),
        );
        await Future<void>.delayed(Duration.zero);

        for (var i = 2; i <= 5; i++) {
          fakeConnection.emitEvent(
            MessageWireEvent(
              seq: i,
              message: AgentMessage.fromJson({
                'type': 'model-output',
                'key': 'answer-$i',
                'text': 'msg-$i',
              }),
            ),
          );
        }
        await Future<void>.delayed(Duration.zero);

        // While the gate holds, only the first commit has started. The ticket
        // has not been acked.
        expect(fakeTranscriptRepository.upserts, hasLength(1));
        expect(fakeConnection.sendAckCount, 0);

        gate.complete();
        await drainSessionDetailMicrotasks();

        // Five wire events produced far fewer than five commits, and the final
        // commit carries the full reduced transcript.
        expect(fakeTranscriptRepository.upserts.length, lessThan(5));
        expect(
          fakeTranscriptRepository.upserts.last.messages.map(
            (message) => message.raw['text'],
          ),
          ['first', 'msg-2', 'msg-3', 'msg-4', 'msg-5'],
        );
        // The ticket is acked exactly once, after its covering commit.
        expect(fakeConnection.sendAckCount, 1);
        expect(fakeConnection.sendNackCount, 0);
        expect(fakeConnection.lastProtocolTicket, 'ticket-coalesce');
      });

      test(
        'offline transcript hydrates and seeds its committed cursor',
        () async {
          fakeTranscriptRepository.stored = SessionTranscriptSnapshot(
            brokerProfileId: fakeControllerBrokerScope(),
            sessionKey: key,
            messages: [
              AgentMessage.fromJson(const {
                'type': 'user-message',
                'key': 'cached-user',
                'text': 'Cached prompt',
              }),
            ],
            cursor: 'cached-cursor',
            olderCursor: 'older-cursor',
            hasEarlier: true,
            updatedAt: DateTime.utc(2026, 7, 17),
          );
          keepSessionDetailAlive(container, key);

          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();

          final state = container.read(sessionDetailControllerProvider(key));
          expect(state.messageEvents.single.raw['text'], 'Cached prompt');
          expect(state.hasEarlierHistory, isTrue);
          expect(fakeConnection.seededHistoryCursor, 'cached-cursor');
        },
      );

      test(
        'older history prepends without rewriting the persisted recent tail',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          fakeConnection.emitEvent(
            HistoryWireEvent(
              messages: [
                AgentMessage.fromJson(const {
                  'type': 'model-output',
                  'key': 'newer',
                  'text': 'Newer',
                }),
              ],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-2',
              hasEarlier: true,
            ),
          );
          await drainSessionDetailMicrotasks();
          final commitsBeforePage = fakeTranscriptRepository.upserts.length;

          expect(await controller.loadEarlierHistory(limit: 50), isTrue);
          expect(fakeConnection.lastHistoryPageCursor, 'page-2');
          expect(fakeConnection.lastHistoryPageLimit, 50);
          fakeConnection.emitEvent(
            HistoryPageWireEvent(
              messages: [
                AgentMessage.fromJson(const {
                  'type': 'user-message',
                  'key': 'older',
                  'text': 'Older',
                }),
              ],
              cursor: 'page-1',
              hasMore: true,
              endOfHistory: false,
              clientMessageId: fakeConnection.lastHistoryPageClientMessageId,
            ),
          );
          await drainSessionDetailMicrotasks();

          final state = container.read(sessionDetailControllerProvider(key));
          expect(
            state.messageEvents.map((message) => message.raw['text']),
            ['Older', 'Newer'],
          );
          expect(state.olderHistoryCursor, 'page-1');
          expect(state.hasEarlierHistory, isTrue);
          expect(
            fakeTranscriptRepository.upserts,
            hasLength(commitsBeforePage),
            reason:
                'an older decoded page is disposable and must not JSON-rewrite '
                'the accumulated transcript snapshot',
          );
          expect(fakeTranscriptRepository.upserts.last.olderCursor, 'page-2');

          fakeConnection.emitEvent(
            MessageWireEvent(
              seq: 9,
              message: AgentMessage.fromJson(const {
                'type': 'model-output',
                'key': 'live-tail',
                'text': 'Live tail',
              }),
            ),
          );
          await drainSessionDetailMicrotasks();
          expect(
            fakeTranscriptRepository.upserts.last.messages.map(
              (message) => message.raw['text'],
            ),
            ['Newer', 'Live tail'],
          );
          expect(fakeTranscriptRepository.upserts.last.olderCursor, 'page-2');
        },
      );

      test(
        'transport suspension retains a five-page H1 anchor across resume',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach(
            intent: SessionDetailAttachIntent.backgroundObserve,
          );

          AgentMessage message(int index) => AgentMessage.fromJson({
            'type': 'model-output',
            'key': 'resident-$index',
            'text': 'Resident $index',
          });

          fakeConnection.emitEvent(
            HistoryWireEvent(
              messages: [
                for (var index = 400; index < 500; index++) message(index),
              ],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-4',
              hasEarlier: true,
            ),
          );
          await drainSessionDetailMicrotasks();

          for (var page = 3; page >= 0; page--) {
            expect(await controller.loadEarlierHistory(), isTrue);
            fakeConnection.emitEvent(
              HistoryPageWireEvent(
                messages: [
                  for (
                    var index = page * 100;
                    index < (page + 1) * 100;
                    index++
                  )
                    message(index),
                ],
                cursor: page == 0 ? null : 'page-$page',
                hasMore: page != 0,
                endOfHistory: page == 0,
                clientMessageId: fakeConnection.lastHistoryPageClientMessageId,
              ),
            );
            await drainSessionDetailMicrotasks();
          }

          final anchorKey = stableTranscriptMessageKey(message(42))!;
          controller.protectHistoryViewportAnchor(anchorKey);
          final before = container.read(sessionDetailControllerProvider(key));
          expect(before.transcriptWindow.pages, hasLength(5));
          expect(
            before.messageEvents.any(
              (candidate) => stableTranscriptMessageKey(candidate) == anchorKey,
            ),
            isTrue,
          );

          await controller.suspendTransport();
          final hidden = container.read(sessionDetailControllerProvider(key));
          expect(
            hidden.transcriptWindow.pages,
            same(before.transcriptWindow.pages),
          );
          expect(hidden.messageEvents, same(before.messageEvents));
          expect(fakeConnection.closeCount, 1);

          await controller.attach(
            intent: SessionDetailAttachIntent.backgroundObserve,
          );
          fakeConnection.emitEvent(
            HistoryWireEvent(
              messages: [
                for (var index = 500; index < 600; index++) message(index),
              ],
              reset: true,
              cursor: 'replay-cursor',
              olderCursor: 'replay-page-5',
              hasEarlier: true,
            ),
          );
          await drainSessionDetailMicrotasks();
          final resumed = container.read(sessionDetailControllerProvider(key));
          expect(
            resumed.messageEvents.any(
              (candidate) => stableTranscriptMessageKey(candidate) == anchorKey,
            ),
            isTrue,
            reason:
                'browser suspension must retain the page containing the '
                'semantic viewport anchor through reconnect replay, not only '
                'its registry key',
          );
        },
      );

      test(
        'thousands of paged messages keep decoded and persisted bytes bounded',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          final body = List.filled(4096, 'x').join();
          AgentMessage message(int index) => AgentMessage.fromJson({
            'type': 'model-output',
            'key': 'history-$index',
            'text': '$index:$body',
          });

          fakeConnection.emitEvent(
            HistoryWireEvent(
              messages: [
                for (var index = 2400; index < 2500; index++) message(index),
              ],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-24',
              hasEarlier: true,
              truncated: const HistoryTruncation(shown: 100, total: 2500),
            ),
          );
          await drainSessionDetailMicrotasks();
          final commitsAfterTail = fakeTranscriptRepository.upserts.length;

          for (var page = 23; page >= 0; page--) {
            expect(await controller.loadEarlierHistory(), isTrue);
            final start = page * 100;
            fakeConnection.emitEvent(
              HistoryPageWireEvent(
                messages: [
                  for (var index = start; index < start + 100; index++)
                    message(index),
                ],
                cursor: page == 0 ? null : 'page-$page',
                hasMore: page != 0,
                endOfHistory: page == 0,
                clientMessageId: fakeConnection.lastHistoryPageClientMessageId,
              ),
            );
            await drainSessionDetailMicrotasks();
            if (page == 12) {
              controller.protectHistoryViewportAnchor(
                stableTranscriptMessageKey(message(1200)),
              );
              fakeConnection
                ..emitState(SessionDetailConnectionStatus.reconnecting)
                ..emitState(SessionDetailConnectionStatus.connected);
              await drainSessionDetailMicrotasks();
            }
          }

          final state = container.read(sessionDetailControllerProvider(key));
          expect(
            state.messageEvents.length,
            lessThanOrEqualTo(kMaxActiveTranscriptMessages),
          );
          expect(
            state.messageEvents
                .map(estimatedAgentMessageDecodedBytes)
                .fold<int>(0, (sum, bytes) => sum + bytes),
            lessThanOrEqualTo(kMaxActiveTranscriptDecodedBytes),
          );
          expect(state.messageEvents.first.raw['key'], 'history-0');
          expect(state.messageEvents.last.raw['key'], 'history-2499');
          expect(
            state.messageEvents.any(
              (message) => message.raw['key'] == 'history-1200',
            ),
            isTrue,
            reason:
                'a semantic viewport anchor must remain protected while its '
                'transcript widget is unmounted across reconnect',
          );
          expect(state.transcriptHistoryGaps, isNotEmpty);
          expect(
            state.transcriptMessageSegments.length,
            state.transcriptHistoryGaps.length + 1,
            reason:
                'non-contiguous retained pages must never become one ordinary '
                'conversation run',
          );
          expect(state.latestHistoryTruncation, isNull);
          expect(
            fakeTranscriptRepository.upserts,
            hasLength(commitsAfterTail),
            reason:
                'disposable older pages must never rewrite the durable tail',
          );
          final persisted = fakeTranscriptRepository.upserts.last;
          final persistedBytes = utf8
              .encode(
                jsonEncode([
                  for (final message in persisted.messages) message.toJson(),
                ]),
              )
              .length;
          expect(persisted.messages, hasLength(100));
          expect(
            persistedBytes,
            lessThanOrEqualTo(maxPersistedTranscriptSnapshotBytes),
          );
        },
      );

      test(
        'malformed history page fails closed without consuming cursor',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          fakeConnection.emitEvent(
            const HistoryWireEvent(
              messages: [],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-2',
              hasEarlier: true,
            ),
          );
          await drainSessionDetailMicrotasks();

          expect(await controller.loadEarlierHistory(), isTrue);
          fakeConnection.emitEvent(
            const UnknownWireEvent(
              kind: 'history-page',
              raw: {
                'kind': 'history-page',
                'messages': ['malformed'],
              },
            ),
          );
          await drainSessionDetailMicrotasks();

          final state = container.read(sessionDetailControllerProvider(key));
          expect(state.historyPageLoading, isFalse);
          expect(state.historyPageError, contains('malformed'));
          expect(state.olderHistoryCursor, 'page-2');
          expect(state.hasEarlierHistory, isTrue);
          expect(
            await controller.loadEarlierHistory(),
            isTrue,
            reason: 'timeout ends the in-flight guard for explicit retry',
          );
        },
      );

      test(
        'terminal paging refusal preserves transcript and blocks '
        'same-source retry',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          fakeConnection.emitEvent(
            HistoryWireEvent(
              messages: [
                AgentMessage.fromJson(const {
                  'type': 'model-output',
                  'key': 'newest',
                  'text': 'Newest',
                }),
              ],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-2',
              hasEarlier: true,
            ),
          );
          await drainSessionDetailMicrotasks();
          final transcriptBefore = container
              .read(sessionDetailControllerProvider(key))
              .transcriptMessageEvents;

          expect(await controller.loadEarlierHistory(), isTrue);
          fakeConnection.emitEvent(
            NackWireEvent(
              code: 'HISTORY_PAGE_RESOURCE_LIMIT',
              message: 'The bounded snapshot is too large.',
              clientMessageId: fakeConnection.lastHistoryPageClientMessageId,
            ),
          );
          await drainSessionDetailMicrotasks();

          final refused = container.read(sessionDetailControllerProvider(key));
          expect(
            refused.historyPageErrorCode,
            'HISTORY_PAGE_RESOURCE_LIMIT',
          );
          expect(refused.historyPageLoading, isFalse);
          expect(refused.olderHistoryCursor, 'page-2');
          expect(refused.transcriptMessageEvents, transcriptBefore);
          expect(await controller.loadEarlierHistory(), isFalse);
          expect(fakeConnection.historyPageRequestCount, 1);
        },
      );

      test(
        'hydrating a capped snapshot reconciles a live delta without dupes',
        () async {
          fakeTranscriptRepository.stored = SessionTranscriptSnapshot(
            brokerProfileId: fakeControllerBrokerScope(),
            sessionKey: key,
            messages: [
              for (var i = 100; i < 600; i++)
                AgentMessage.fromJson({
                  'type': 'model-output',
                  'key': 'msg-$i',
                  'text': 'reduced $i',
                }),
            ],
            cursor: 'tail',
            olderCursor: 'older',
            hasEarlier: true,
            truncation: const HistoryTruncation(shown: 500, total: 600),
            updatedAt: DateTime.utc(2026, 7, 17, 12),
          );

          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();

          final hydrated = container.read(
            sessionDetailControllerProvider(key),
          );
          expect(hydrated.messageEvents, hasLength(100));
          expect(hydrated.latestHistoryTruncation?.shown, 100);
          expect(hydrated.latestHistoryTruncation?.total, 600);
          expect(hydrated.hasEarlierHistory, isTrue);
          expect(
            hydrated.leadingTranscriptHistoryGap?.kind,
            TranscriptHistoryGapKind.reconnectRequired,
          );

          // Live reattach delta re-sends the last final plus two new messages.
          fakeConnection.emitEvent(
            HistoryWireEvent(
              messages: [
                AgentMessage.fromJson(const {
                  'type': 'model-output',
                  'key': 'msg-599',
                  'text': 'reduced 599',
                }),
                AgentMessage.fromJson(const {
                  'type': 'model-output',
                  'key': 'msg-600',
                  'text': 'live 600',
                }),
                AgentMessage.fromJson(const {
                  'type': 'model-output',
                  'key': 'msg-601',
                  'text': 'live 601',
                }),
              ],
              cursor: 'tail2',
              olderCursor: 'older2',
              hasEarlier: true,
            ),
          );
          await drainSessionDetailMicrotasks();

          final state = container.read(sessionDetailControllerProvider(key));
          // No duplicate finals: msg-599 stays a single row.
          expect(
            state.messageEvents.where((m) => m.raw['key'] == 'msg-599'),
            hasLength(1),
          );
          // The two genuinely new rows survive while the active decoded
          // window remains inside H1's hard count budget.
          expect(
            state.messageEvents,
            hasLength(kRetainedTranscriptTailMessages),
          );
          expect(state.messageEvents.last.raw['key'], 'msg-601');
          // Earlier content is still surfaced, not a silent continuous gap.
          expect(state.hasEarlierHistory, isTrue);
          expect(state.olderHistoryCursor, 'older2');
        },
      );

      test(
        'loadEarlierHistory times out and ignores its stale reply after retry',
        () async {
          final timeoutConnection = FakeSessionDetailConnection();
          final timeoutContainer = ProviderContainer(
            overrides: [
              ...dr1DurableDraftTestOverrides(),
              activeBrokerProfileProvider.overrideWith(
                (ref) => fakeControllerBrokerProfile(),
              ),
              brokerClientProvider.overrideWith(
                (ref) async => FakeControllerBrokerClient(),
              ),
              sessionDetailConnectionFactoryProvider.overrideWithValue(
                ({required resolver, required sessionId, required tool}) {
                  timeoutConnection
                    ..sessionId = sessionId
                    ..tool = tool;
                  return timeoutConnection;
                },
              ),
              sessionArtifactFileServiceProvider.overrideWithValue(
                FakeControllerArtifactFileService(),
              ),
              sessionAttachmentPickerProvider.overrideWithValue(
                FakeControllerAttachmentPicker(),
              ),
              sessionArtifactTransferRepositoryProvider.overrideWithValue(
                InMemorySessionArtifactTransferRepository(),
              ),
              sessionOutboxRepositoryProvider.overrideWithValue(
                RecordingSessionOutboxRepository(),
              ),
              sessionTranscriptRepositoryProvider.overrideWithValue(
                RecordingSessionTranscriptRepository(),
              ),
              sessionNotificationLifecycleMonitorProvider.overrideWithValue(
                StubBrokerAppLifecycleMonitor(
                  currentState: BrokerAppLifecycleState.paused,
                ),
              ),
              sessionNotificationSinkProvider.overrideWithValue(
                CollectingNotificationSink(),
              ),
              sessionDriveIntentStoreProvider.overrideWithValue(
                InMemoryControllerDriveIntentStore(),
              ),
              sessionHistoryPageTimeoutProvider.overrideWithValue(
                const Duration(milliseconds: 30),
              ),
            ],
          );
          addTearDown(timeoutContainer.dispose);
          keepSessionDetailAlive(timeoutContainer, key);

          final controller = timeoutContainer.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          timeoutConnection.emitEvent(
            const HistoryWireEvent(
              messages: [],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-2',
              hasEarlier: true,
            ),
          );
          await drainSessionDetailMicrotasks();

          // The broker accepts the frame but never emits a page or a nack.
          expect(await controller.loadEarlierHistory(), isTrue);
          expect(timeoutConnection.lastHistoryPageCursor, 'page-2');
          final expiredRequestId =
              timeoutConnection.lastHistoryPageClientMessageId;
          expect(
            timeoutContainer
                .read(sessionDetailControllerProvider(key))
                .historyPageLoading,
            isTrue,
          );

          await Future<void>.delayed(const Duration(milliseconds: 90));

          final state = timeoutContainer.read(
            sessionDetailControllerProvider(key),
          );
          expect(state.historyPageLoading, isFalse);
          expect(state.historyPageError, contains('timed out'));
          // The cursor and hasEarlier survive so retry stays possible.
          expect(state.olderHistoryCursor, 'page-2');
          expect(state.hasEarlierHistory, isTrue);

          expect(await controller.loadEarlierHistory(), isTrue);
          final retryRequestId =
              timeoutConnection.lastHistoryPageClientMessageId;
          expect(retryRequestId, isNot(expiredRequestId));

          timeoutConnection.emitEvent(
            HistoryPageWireEvent(
              messages: [
                AgentMessage.fromJson(const {
                  'type': 'model-output',
                  'key': 'stale-page',
                  'text': 'Stale page',
                }),
              ],
              cursor: 'stale-cursor',
              hasMore: true,
              endOfHistory: false,
              clientMessageId: expiredRequestId,
            ),
          );
          await drainSessionDetailMicrotasks();

          final duringRetry = timeoutContainer.read(
            sessionDetailControllerProvider(key),
          );
          expect(duringRetry.messageEvents, isEmpty);
          expect(duringRetry.olderHistoryCursor, 'page-2');
          expect(duringRetry.historyPageLoading, isTrue);

          timeoutConnection.emitEvent(
            HistoryPageWireEvent(
              messages: [
                AgentMessage.fromJson(const {
                  'type': 'model-output',
                  'key': 'accepted-page',
                  'text': 'Accepted page',
                }),
              ],
              cursor: 'page-1',
              hasMore: true,
              endOfHistory: false,
              clientMessageId: retryRequestId,
            ),
          );
          await drainSessionDetailMicrotasks();
          final afterRetry = timeoutContainer.read(
            sessionDetailControllerProvider(key),
          );
          expect(afterRetry.messageEvents.single.raw['key'], 'accepted-page');
          expect(afterRetry.olderHistoryCursor, 'page-1');
          expect(afterRetry.historyPageLoading, isFalse);
        },
      );

      test('loadEarlierHistory is one-in-flight at a time', () async {
        final hold = Completer<void>();
        final blockingConnection = buildBlockerConnection(hold);
        final blockerContainer = ProviderContainer(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            activeBrokerProfileProvider.overrideWith(
              (ref) => fakeControllerBrokerProfile(),
            ),
            brokerClientProvider.overrideWith(
              (ref) async => FakeControllerBrokerClient(),
            ),
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) {
                blockingConnection.connection
                  ..sessionId = sessionId
                  ..tool = tool;
                return blockingConnection;
              },
            ),
            sessionArtifactFileServiceProvider.overrideWithValue(
              FakeControllerArtifactFileService(),
            ),
            sessionAttachmentPickerProvider.overrideWithValue(
              FakeControllerAttachmentPicker(),
            ),
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
            sessionOutboxRepositoryProvider.overrideWithValue(
              RecordingSessionOutboxRepository(),
            ),
            sessionTranscriptRepositoryProvider.overrideWithValue(
              RecordingSessionTranscriptRepository(),
            ),
            sessionNotificationLifecycleMonitorProvider.overrideWithValue(
              StubBrokerAppLifecycleMonitor(
                currentState: BrokerAppLifecycleState.paused,
              ),
            ),
            sessionNotificationSinkProvider.overrideWithValue(
              CollectingNotificationSink(),
            ),
            sessionDriveIntentStoreProvider.overrideWithValue(
              InMemoryControllerDriveIntentStore(),
            ),
          ],
        );
        addTearDown(blockerContainer.dispose);
        keepSessionDetailAlive(blockerContainer, key);
        final blockerStateful = blockerContainer.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await blockerStateful.attach();
        blockingConnection.connection.emitEvent(
          HistoryWireEvent(
            messages: [
              AgentMessage.fromJson(const {
                'type': 'model-output',
                'key': 'newest',
                'text': 'Newest',
              }),
            ],
            reset: true,
            cursor: 'tail-cursor',
            olderCursor: 'page-2',
            hasEarlier: true,
          ),
        );
        await drainSessionDetailMicrotasks();

        final firstLoad = blockerStateful.loadEarlierHistory(limit: 50);
        await Future<void>.delayed(Duration.zero);
        final secondLoad = blockerStateful.loadEarlierHistory(limit: 50);

        expect(await secondLoad, isFalse);
        expect(blockingConnection.lastHistoryPageCursor, 'page-2');
        expect(
          blockingConnection.historyPageRequestCount,
          1,
          reason: 'the same cursor cannot be sent twice concurrently',
        );

        hold.complete();
        expect(await firstLoad, isTrue);
      });

      test(
        'can retry after malformed history-page reply without consuming cursor',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          container
              .read(sessionDetailControllerProvider(key))
              .transcriptMessageEvents;
          fakeConnection.emitEvent(
            const HistoryWireEvent(
              messages: [],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-2',
              hasEarlier: true,
            ),
          );
          await drainSessionDetailMicrotasks();

          expect(await controller.loadEarlierHistory(), isTrue);
          fakeConnection.emitEvent(
            const UnknownWireEvent(
              kind: 'history-page',
              raw: {
                'kind': 'history-page',
                'messages': ['malformed'],
              },
            ),
          );
          await drainSessionDetailMicrotasks();

          expect(fakeConnection.lastHistoryPageCursor, 'page-2');
          expect(
            container
                .read(sessionDetailControllerProvider(key))
                .historyPageError,
            isNotNull,
          );

          expect(await controller.loadEarlierHistory(), isTrue);
          expect(fakeConnection.lastHistoryPageCursor, 'page-2');
        },
      );

      test('keeps live messages while a history page is loading', () async {
        final hold = Completer<void>();
        final blockingConnection = buildBlockerConnection(hold);
        final blockerContainer = ProviderContainer(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            activeBrokerProfileProvider.overrideWith(
              (ref) => fakeControllerBrokerProfile(),
            ),
            brokerClientProvider.overrideWith(
              (ref) async => FakeControllerBrokerClient(),
            ),
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) {
                blockingConnection.connection
                  ..sessionId = sessionId
                  ..tool = tool;
                return blockingConnection;
              },
            ),
            sessionArtifactFileServiceProvider.overrideWithValue(
              FakeControllerArtifactFileService(),
            ),
            sessionAttachmentPickerProvider.overrideWithValue(
              FakeControllerAttachmentPicker(),
            ),
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
            sessionOutboxRepositoryProvider.overrideWithValue(
              RecordingSessionOutboxRepository(),
            ),
            sessionTranscriptRepositoryProvider.overrideWithValue(
              RecordingSessionTranscriptRepository(),
            ),
            sessionNotificationLifecycleMonitorProvider.overrideWithValue(
              StubBrokerAppLifecycleMonitor(
                currentState: BrokerAppLifecycleState.paused,
              ),
            ),
            sessionNotificationSinkProvider.overrideWithValue(
              CollectingNotificationSink(),
            ),
            sessionDriveIntentStoreProvider.overrideWithValue(
              InMemoryControllerDriveIntentStore(),
            ),
          ],
        );
        addTearDown(blockerContainer.dispose);
        keepSessionDetailAlive(blockerContainer, key);
        final blockerStateful = blockerContainer.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await blockerStateful.attach();
        blockingConnection.connection.emitEvent(
          HistoryWireEvent(
            messages: [
              AgentMessage.fromJson(const {
                'type': 'model-output',
                'key': 'newest',
                'text': 'Newest',
              }),
            ],
            reset: true,
            cursor: 'tail-cursor',
            olderCursor: 'page-2',
            hasEarlier: true,
          ),
        );
        await drainSessionDetailMicrotasks();

        final loading = blockerStateful.loadEarlierHistory(limit: 50);
        await Future<void>.delayed(Duration.zero);

        blockingConnection.connection.emitEvent(
          const MessageWireEvent(
            seq: 101,
            message: AgentMessage(
              type: AgentMessageType.modelOutput,
              id: 'live-during-page',
              raw: {
                'type': 'model-output',
                'key': 'live-during-page',
                'text': 'Live while loading',
              },
            ),
          ),
        );
        await drainSessionDetailMicrotasks();
        final partialState = blockerContainer.read(
          sessionDetailControllerProvider(key),
        );
        expect(
          partialState.messageEvents
              .map((message) => message.raw['key'])
              .toList(),
          ['newest', 'live-during-page'],
        );

        blockingConnection.connection.emitEvent(
          HistoryPageWireEvent(
            messages: [
              AgentMessage.fromJson(const {
                'type': 'model-output',
                'key': 'older',
                'text': 'Older',
              }),
            ],
            cursor: 'page-1',
            hasMore: false,
            endOfHistory: true,
            clientMessageId: blockingConnection.lastHistoryPageClientMessageId,
          ),
        );
        await drainSessionDetailMicrotasks();

        hold.complete();
        expect(await loading, isTrue);
        final state = blockerContainer.read(
          sessionDetailControllerProvider(key),
        );
        expect(
          state.messageEvents.map((message) => message.raw['key']).toList(),
          ['older', 'newest', 'live-during-page'],
        );
      });

      test(
        'older pages merge oldest->newest and dedupe by stable key',
        () async {
          final duplicateConnection = FakeSessionDetailConnection();
          final duplicateContainer = ProviderContainer(
            overrides: [
              ...dr1DurableDraftTestOverrides(),
              activeBrokerProfileProvider.overrideWith(
                (ref) => fakeControllerBrokerProfile(),
              ),
              brokerClientProvider.overrideWith(
                (ref) async => FakeControllerBrokerClient(),
              ),
              sessionDetailConnectionFactoryProvider.overrideWithValue(
                ({required resolver, required sessionId, required tool}) {
                  duplicateConnection
                    ..sessionId = sessionId
                    ..tool = tool;
                  return duplicateConnection;
                },
              ),
              sessionArtifactFileServiceProvider.overrideWithValue(
                FakeControllerArtifactFileService(),
              ),
              sessionAttachmentPickerProvider.overrideWithValue(
                FakeControllerAttachmentPicker(),
              ),
              sessionArtifactTransferRepositoryProvider.overrideWithValue(
                InMemorySessionArtifactTransferRepository(),
              ),
              sessionOutboxRepositoryProvider.overrideWithValue(
                RecordingSessionOutboxRepository(),
              ),
              sessionTranscriptRepositoryProvider.overrideWithValue(
                RecordingSessionTranscriptRepository(),
              ),
              sessionNotificationLifecycleMonitorProvider.overrideWithValue(
                StubBrokerAppLifecycleMonitor(
                  currentState: BrokerAppLifecycleState.paused,
                ),
              ),
              sessionNotificationSinkProvider.overrideWithValue(
                CollectingNotificationSink(),
              ),
              sessionDriveIntentStoreProvider.overrideWithValue(
                InMemoryControllerDriveIntentStore(),
              ),
            ],
          );
          addTearDown(duplicateContainer.dispose);
          keepSessionDetailAlive(duplicateContainer, key);

          final controller = duplicateContainer.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          duplicateConnection.emitEvent(
            HistoryWireEvent(
              messages: [
                AgentMessage.fromJson(const {
                  'type': 'model-output',
                  'key': 'tail',
                  'text': 'tail',
                }),
              ],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-2',
              hasEarlier: true,
            ),
          );
          await drainSessionDetailMicrotasks();

          expect(await controller.loadEarlierHistory(), isTrue);
          duplicateConnection.emitEvent(
            HistoryPageWireEvent(
              messages: [
                const AgentMessage(
                  type: AgentMessageType.modelOutput,
                  id: 'older',
                  raw: {
                    'type': 'model-output',
                    'key': 'older',
                    'text': 'older',
                  },
                ),
                AgentMessage.fromJson(const {
                  'type': 'model-output',
                  'key': 'tail',
                  'text': 'tail replaced',
                }),
              ],
              cursor: 'page-1',
              hasMore: false,
              endOfHistory: true,
              clientMessageId:
                  duplicateConnection.lastHistoryPageClientMessageId,
            ),
          );
          await drainSessionDetailMicrotasks();

          final state = duplicateContainer.read(
            sessionDetailControllerProvider(key),
          );
          expect(state.olderHistoryCursor, isNull);
          expect(state.hasEarlierHistory, isFalse);
          expect(
            state.messageEvents.map((message) => message.raw['key']).toList(),
            ['older', 'tail'],
          );
          expect(
            state.messageEvents
                .firstWhere((message) => message.raw['key'] == 'tail')
                .raw['text'],
            'tail',
          );
        },
      );
    },
  );
}

class _BlockingHistoryPageConnection
    implements SessionDetailConnection, SessionHistoryConnection {
  _BlockingHistoryPageConnection({
    required this.connection,
    required this.hold,
  });

  final FakeSessionDetailConnection connection;
  final Completer<void> hold;
  String? lastHistoryPageClientMessageId;
  String? lastHistoryPageCursor;
  int? lastHistoryPageLimit;
  int historyPageRequestCount = 0;

  @override
  void seedHistoryCursor(String cursor) {
    connection.seedHistoryCursor(cursor);
  }

  @override
  Future<void> requestHistoryPage({
    required String cursor,
    int? limit,
    String? clientMessageId,
  }) async {
    historyPageRequestCount++;
    lastHistoryPageClientMessageId = clientMessageId;
    lastHistoryPageCursor = cursor;
    lastHistoryPageLimit = limit;
    await hold.future;
    await connection.requestHistoryPage(
      cursor: cursor,
      limit: limit,
      clientMessageId: clientMessageId,
    );
  }

  @override
  SessionDetailConnectionStatus get state => connection.state;

  @override
  Stream<SessionDetailConnectionStatus> get stateStream =>
      connection.stateStream;

  @override
  Stream<WireEvent> get events => connection.events;

  @override
  Future<void> connect() => connection.connect();

  @override
  Future<void> close({bool reconnect = false}) => connection.close(
    reconnect: reconnect,
  );

  @override
  Future<void> reattach({String? mode, String? reason}) =>
      connection.reattach(mode: mode, reason: reason);

  @override
  void disarmDriveAuthority() => connection.disarmDriveAuthority();

  @override
  Future<void> sendPrompt(
    String text, {
    SessionCurrentModel? model,
    String? clientMessageId,
    int? draftRevision,
    String? draftUpdateId,
    List<PromptFileAttachment> files = const [],
  }) => connection.sendPrompt(
    text,
    model: model,
    clientMessageId: clientMessageId,
    draftRevision: draftRevision,
    draftUpdateId: draftUpdateId,
    files: files,
  );

  @override
  Future<void> sendDraft(
    String text, {
    String? updateId,
    int? baseRevision,
  }) => connection.sendDraft(
    text,
    updateId: updateId,
    baseRevision: baseRevision,
  );

  @override
  Future<void> sendPlanAction(
    PlanActionRequest request, {
    String? clientMessageId,
  }) => connection.sendPlanAction(request, clientMessageId: clientMessageId);

  @override
  Future<void> sendArtifactInteraction(
    ArtifactInteractionRequest request, {
    String? clientMessageId,
  }) => connection.sendArtifactInteraction(
    request,
    clientMessageId: clientMessageId,
  );

  @override
  Future<void> sendAck(String attachTicket, {String? clientMessageId}) =>
      connection.sendAck(attachTicket, clientMessageId: clientMessageId);

  @override
  Future<void> sendNack(String attachTicket, {String? clientMessageId}) =>
      connection.sendNack(attachTicket, clientMessageId: clientMessageId);

  @override
  Future<void> sendPermissionDecision(
    String requestId,
    String decision, {
    String? clientMessageId,
  }) => connection.sendPermissionDecision(
    requestId,
    decision,
    clientMessageId: clientMessageId,
  );

  @override
  Future<void> sendSetAgent(String agent, {String? clientMessageId}) =>
      connection.sendSetAgent(agent, clientMessageId: clientMessageId);

  @override
  Future<void> sendQuestionAnswer(
    String requestId,
    List<List<String>> answers, {
    String? clientMessageId,
  }) => connection.sendQuestionAnswer(
    requestId,
    answers,
    clientMessageId: clientMessageId,
  );

  @override
  Future<void> rejectQuestion(String requestId, {String? clientMessageId}) =>
      connection.rejectQuestion(requestId, clientMessageId: clientMessageId);

  @override
  Future<void> sendCommand(
    String name, {
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? clientMessageId,
  }) => connection.sendCommand(
    name,
    args: args,
    model: model,
    clientMessageId: clientMessageId,
  );

  @override
  Future<void> sendFile({
    required String name,
    required String data,
    String? mimeType,
    String? clientMessageId,
  }) => connection.sendFile(
    name: name,
    data: data,
    mimeType: mimeType,
    clientMessageId: clientMessageId,
  );

  @override
  Future<void> dispose() => connection.dispose();
}
