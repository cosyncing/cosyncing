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
import 'package:cosyncing_client/src/features/sessions/requests/session_command_args_codec.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/created_session_attach_intents.dart';
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
  group(
    'SessionDetailController session_detail_outbox_commands_test.dart',
    () {
      const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

      test('sendPrompt records its attempt before transport send', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.onSendPrompt = () {
          expect(fakeOutboxRepository.messages, hasLength(1));
          expect(
            fakeOutboxRepository.messages.single.status,
            SessionOutboxMessageStatus.sending,
          );
          expect(fakeOutboxRepository.messages.single.attemptCount, 1);
        };

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPrompt(' durable prompt ');

        expect(sent, isTrue);
        expect(fakeConnection.lastPrompt, 'durable prompt');
        final clientMessageId = fakeConnection.lastPromptClientMessageId;
        expect(clientMessageId, startsWith('ca.'));
        final outbox = fakeOutboxRepository.messageById(clientMessageId!);
        expect(outbox?.brokerProfileId, fakeControllerBrokerScope());
        expect(outbox?.kind, SessionOutboxMessageKind.prompt);
        // DR1: store the shared-draft revision this send observed verbatim so
        // replay reproduces the frame. 0 means this device holds no shared
        // draft, which stops the broker clearing another device's draft.
        expect(outbox?.payload, const {
          'text': 'durable prompt',
          'draftRevision': 0,
        });
        expect(outbox?.status, SessionOutboxMessageStatus.sending);
      });

      test('the selected permission mode is sent and made durable', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPrompt('scoped prompt', permissionMode: 'auto');

        expect(sent, isTrue);
        // The exact token reaches the wire...
        expect(fakeConnection.lastPromptPermissionMode, 'auto');
        // ...and the durable row records it, so a retry reproduces this frame
        // rather than re-reading a composer that may have moved on. The broker
        // fingerprints every field but the client message id, so a drifted
        // replay comes back as a conflicting reuse of that id.
        final outbox = fakeOutboxRepository.messageById(
          fakeConnection.lastPromptClientMessageId!,
        );
        expect(outbox?.payload, const {
          'text': 'scoped prompt',
          'permissionMode': 'auto',
          'draftRevision': 0,
        });
      });

      test('a prompt with no override claims no mode at all', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPrompt('unscoped prompt');

        // Absent, not blank and not echoed back: an ordinary prompt must not
        // re-assert a mode, which would outrank one the server changed.
        expect(fakeConnection.lastPromptPermissionMode, isNull);
        final outbox = fakeOutboxRepository.messageById(
          fakeConnection.lastPromptClientMessageId!,
        );
        expect(outbox?.payload.containsKey('permissionMode'), isFalse);
      });

      test('client-message ack marks outbox row delivered', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPrompt('ack me');
        final clientMessageId = fakeConnection.lastPromptClientMessageId!;

        fakeConnection.emitEvent(
          AckWireEvent(
            ackKind: 'client-message',
            clientMessageId: clientMessageId,
          ),
        );
        await Future<void>.delayed(Duration.zero);

        expect(
          fakeOutboxRepository.messageById(clientMessageId)?.status,
          SessionOutboxMessageStatus.delivered,
        );
      });

      test(
        'cached client-message failure is terminal and removes optimistic UI',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .sendPrompt('nack me');
          final clientMessageId = fakeConnection.lastPromptClientMessageId!;

          fakeConnection.emitEvent(
            NackWireEvent(
              code: 'CLIENT_MESSAGE_FAILED',
              message: 'broker rejected the prompt',
              clientMessageId: clientMessageId,
            ),
          );
          await Future<void>.delayed(Duration.zero);

          expect(
            fakeOutboxRepository.messageById(clientMessageId)?.status,
            SessionOutboxMessageStatus.failed,
          );
          expect(
            container
                .read(sessionDetailControllerProvider(key))
                .optimisticPrompts,
            isEmpty,
          );
          expect(
            container.read(sessionDetailControllerProvider(key)).error,
            contains('broker rejected the prompt'),
          );
        },
      );

      test(
        'advertised action command sends only in a prompt-capable session',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          fakeConnection
            ..emitEvent(
              const CommandsWireEvent(
                commands: [
                  SlashCommand(
                    name: '/goal',
                    kind: SlashCommandKind.action,
                  ),
                ],
              ),
            )
            ..emitSessionControl(const {
              'drive': {'state': 'driving', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            });
          await Future<void>.delayed(Duration.zero);

          final sent = await controller.sendActionCommand(
            'goal',
            args: const {'args': 'pause'},
          );

          expect(sent, isTrue);
          expect(fakeConnection.sendCommandCount, 1);
          expect(fakeConnection.lastCommandName, 'goal');
          expect(fakeConnection.lastCommandArgs, const {'args': 'pause'});
          expect(
            fakeOutboxRepository.messages.single.kind,
            SessionOutboxMessageKind.actionCommand,
          );
        },
      );

      test(
        'advertised action command fails closed in answer-only sync',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          fakeConnection
            ..emitEvent(
              const CommandsWireEvent(
                commands: [
                  SlashCommand(
                    name: 'goal',
                    kind: SlashCommandKind.action,
                  ),
                ],
              ),
            )
            ..emitSessionControl(const {
              'drive': {'state': 'observing', 'supported': true},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': true,
                'input': 'answer-only',
              },
            });
          await Future<void>.delayed(Duration.zero);

          final sent = await controller.sendActionCommand(
            'goal',
            args: const {'args': 'pause'},
          );

          expect(sent, isFalse);
          expect(fakeConnection.sendCommandCount, 0);
          expect(fakeOutboxRepository.messages, isEmpty);
          expect(
            container.read(sessionDetailControllerProvider(key)).error,
            contains('prompt-capable'),
          );
        },
      );

      test('interrupt fails closed when stop is not advertised', () async {
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        fakeConnection
          ..emitEvent(
            const CommandsWireEvent(
              commands: [
                SlashCommand(name: 'stop', kind: SlashCommandKind.prompt),
              ],
            ),
          )
          ..emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }, status: 'working');
        await drainSessionDetailMicrotasks();

        final outcome = await controller.interruptCurrentTurn();

        expect(outcome, SessionInterruptOutcome.unsupported);
        expect(fakeConnection.sendCommandCount, 0);
        expect(fakeOutboxRepository.messages, isEmpty);
      });

      test('interrupt falls back to an advertised abort action', () async {
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        fakeConnection
          ..emitEvent(
            const CommandsWireEvent(
              commands: [
                SlashCommand(name: 'abort', kind: SlashCommandKind.action),
              ],
            ),
          )
          ..emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }, status: 'working');
        await drainSessionDetailMicrotasks();

        final outcome = await controller.interruptCurrentTurn();

        expect(outcome, SessionInterruptOutcome.sent);
        expect(fakeConnection.sendCommandCount, 1);
        expect(fakeConnection.lastCommandName, 'abort');
        expect(fakeOutboxRepository.messages, isEmpty);
      });

      test(
        'interrupt sends the advertised stop without durable replay',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          fakeConnection
            ..emitEvent(
              const CommandsWireEvent(
                commands: [
                  SlashCommand(name: 'abort', kind: SlashCommandKind.action),
                  SlashCommand(name: '/stop', kind: SlashCommandKind.action),
                ],
              ),
            )
            ..emitSessionControl(const {
              'drive': {'state': 'driving', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            }, status: 'working');
          await drainSessionDetailMicrotasks();

          final outcome = await controller.interruptCurrentTurn();

          expect(outcome, SessionInterruptOutcome.sent);
          expect(fakeConnection.sendCommandCount, 1);
          expect(fakeConnection.lastCommandName, '/stop');
          expect(
            fakeConnection.lastCommandClientMessageId,
            startsWith('ca.'),
          );
          expect(fakeOutboxRepository.messages, isEmpty);
          expect(
            container.read(sessionDetailControllerProvider(key)).interruptPhase,
            SessionInterruptPhase.requested,
          );

          fakeConnection.emitEvent(
            NackWireEvent(
              code: 'INTERRUPT_FAILED',
              message: 'turn could not be interrupted',
              clientMessageId: fakeConnection.lastCommandClientMessageId,
            ),
          );
          await drainSessionDetailMicrotasks();
          expect(
            container.read(sessionDetailControllerProvider(key)).interruptPhase,
            SessionInterruptPhase.idle,
          );
          expect(
            await controller.interruptCurrentTurn(),
            SessionInterruptOutcome.sent,
          );
          expect(fakeConnection.sendCommandCount, 2);
        },
      );

      test('failed interrupt can be retried', () async {
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        fakeConnection
          ..failNextCommand = true
          ..emitEvent(
            const CommandsWireEvent(
              commands: [
                SlashCommand(name: 'stop', kind: SlashCommandKind.action),
              ],
            ),
          )
          ..emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }, status: 'working');
        await drainSessionDetailMicrotasks();

        final first = await controller.interruptCurrentTurn();
        final second = await controller.interruptCurrentTurn();

        expect(first, SessionInterruptOutcome.failed);
        expect(second, SessionInterruptOutcome.sent);
        expect(fakeConnection.sendCommandCount, 2);
      });

      test('duplicate interrupt taps send once for a working turn', () async {
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        final releaseSend = Completer<void>();
        fakeConnection
          ..emitEvent(
            const CommandsWireEvent(
              commands: [
                SlashCommand(name: 'stop', kind: SlashCommandKind.action),
              ],
            ),
          )
          ..emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }, status: 'working')
          ..onSendCommand = () => releaseSend.future;
        await drainSessionDetailMicrotasks();

        final first = controller.interruptCurrentTurn();
        await drainSessionDetailMicrotasks();
        final duplicate = await controller.interruptCurrentTurn();
        releaseSend.complete();

        expect(duplicate, SessionInterruptOutcome.alreadyRequested);
        expect(await first, SessionInterruptOutcome.sent);
        expect(fakeConnection.sendCommandCount, 1);
        expect(
          await controller.interruptCurrentTurn(),
          SessionInterruptOutcome.alreadyRequested,
        );
        expect(fakeConnection.sendCommandCount, 1);
      });

      test('turn finishing first suppresses a stale interrupt', () async {
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        fakeConnection
          ..emitEvent(
            const CommandsWireEvent(
              commands: [
                SlashCommand(name: 'stop', kind: SlashCommandKind.action),
              ],
            ),
          )
          ..emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
        await drainSessionDetailMicrotasks();

        final outcome = await controller.interruptCurrentTurn();

        expect(outcome, SessionInterruptOutcome.notWorking);
        expect(fakeConnection.sendCommandCount, 0);
        expect(
          container.read(sessionDetailControllerProvider(key)).interruptPhase,
          SessionInterruptPhase.idle,
        );
      });

      test(
        'finish during the interrupt write does not latch the next turn',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          final releaseSend = Completer<void>();
          fakeConnection
            ..emitEvent(
              const CommandsWireEvent(
                commands: [
                  SlashCommand(name: 'stop', kind: SlashCommandKind.action),
                ],
              ),
            )
            ..emitSessionControl(const {
              'drive': {'state': 'driving', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            }, status: 'working')
            ..onSendCommand = () => releaseSend.future;
          await drainSessionDetailMicrotasks();

          final interrupt = controller.interruptCurrentTurn();
          await drainSessionDetailMicrotasks();
          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
          await drainSessionDetailMicrotasks();
          releaseSend.complete();

          expect(await interrupt, SessionInterruptOutcome.notWorking);
          expect(
            container.read(sessionDetailControllerProvider(key)).interruptPhase,
            SessionInterruptPhase.idle,
          );

          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }, status: 'working');
          await drainSessionDetailMicrotasks();
          expect(
            await controller.interruptCurrentTurn(),
            SessionInterruptOutcome.sent,
          );
          expect(fakeConnection.sendCommandCount, 2);
        },
      );

      test(
        'old interrupt completion does not overwrite the next turn request',
        () async {
          keepSessionDetailAlive(container, key);
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.attach();
          final firstSend = Completer<void>();
          final secondSend = Completer<void>();
          fakeConnection
            ..emitEvent(
              const CommandsWireEvent(
                commands: [
                  SlashCommand(name: 'stop', kind: SlashCommandKind.action),
                ],
              ),
            )
            ..emitSessionControl(const {
              'drive': {'state': 'driving', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            }, status: 'working')
            ..onSendCommand = () => fakeConnection.sendCommandCount == 1
                ? firstSend.future
                : secondSend.future;
          await drainSessionDetailMicrotasks();

          final firstInterrupt = controller.interruptCurrentTurn();
          await drainSessionDetailMicrotasks();
          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
          await drainSessionDetailMicrotasks();
          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }, status: 'working');
          await drainSessionDetailMicrotasks();

          final secondInterrupt = controller.interruptCurrentTurn();
          await drainSessionDetailMicrotasks();
          firstSend.complete();
          expect(await firstInterrupt, SessionInterruptOutcome.notWorking);
          expect(
            container.read(sessionDetailControllerProvider(key)).interruptPhase,
            SessionInterruptPhase.sending,
          );

          secondSend.complete();
          expect(await secondInterrupt, SessionInterruptOutcome.sent);
          expect(fakeConnection.sendCommandCount, 2);
          expect(
            container.read(sessionDetailControllerProvider(key)).interruptPhase,
            SessionInterruptPhase.requested,
          );
        },
      );

      test(
        'reconnect replays retryable outbox rows with the same id',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await fakeOutboxRepository.upsert(
            SessionOutboxMessage.create(
              sessionKey: key,
              brokerProfileId: fakeControllerBrokerScope(),
              clientMessageId: 'ca.retry.same-id',
              kind: SessionOutboxMessageKind.prompt,
              payload: const {'text': 'please retry'},
            ).copyWith(status: SessionOutboxMessageStatus.retryable),
          );

          fakeConnection
            ..emitState(SessionDetailConnectionStatus.reconnecting)
            ..emitState(SessionDetailConnectionStatus.connected);
          await Future<void>.delayed(Duration.zero);

          expect(fakeConnection.sendPromptCount, 0);

          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
          await Future<void>.delayed(Duration.zero);
          await Future<void>.delayed(Duration.zero);

          expect(fakeConnection.sendPromptCount, 1);
          expect(fakeConnection.lastPrompt, 'please retry');
          expect(
            fakeConnection.lastPromptClientMessageId,
            'ca.retry.same-id',
          );
        },
      );

      test(
        'a replayed prompt asks for the mode it was sent with',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await fakeOutboxRepository.upsert(
            SessionOutboxMessage.create(
              sessionKey: key,
              brokerProfileId: fakeControllerBrokerScope(),
              clientMessageId: 'ca.retry.mode',
              kind: SessionOutboxMessageKind.prompt,
              payload: const {
                'text': 'please retry',
                'permissionMode': 'manual',
              },
            ).copyWith(status: SessionOutboxMessageStatus.retryable),
          );

          fakeConnection
            ..emitState(SessionDetailConnectionStatus.reconnecting)
            ..emitState(SessionDetailConnectionStatus.connected);
          await Future<void>.delayed(Duration.zero);
          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
          await Future<void>.delayed(Duration.zero);
          await Future<void>.delayed(Duration.zero);

          // Read from the durable row, not from live UI state — nothing in
          // this test ever selected a mode, so a recomputed replay would send
          // none and change a request the user already made.
          expect(fakeConnection.sendPromptCount, 1);
          expect(fakeConnection.lastPromptPermissionMode, 'manual');
        },
      );

      test(
        'a row written before the mode existed replays unchanged',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await fakeOutboxRepository.upsert(
            SessionOutboxMessage.create(
              sessionKey: key,
              brokerProfileId: fakeControllerBrokerScope(),
              clientMessageId: 'ca.retry.legacy-mode',
              kind: SessionOutboxMessageKind.prompt,
              payload: const {'text': 'please retry'},
            ).copyWith(status: SessionOutboxMessageStatus.retryable),
          );

          fakeConnection
            ..emitState(SessionDetailConnectionStatus.reconnecting)
            ..emitState(SessionDetailConnectionStatus.connected);
          await Future<void>.delayed(Duration.zero);
          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
          await Future<void>.delayed(Duration.zero);
          await Future<void>.delayed(Duration.zero);

          // Byte-identical to its first send. Adding a mode on replay would
          // change the fingerprint and turn an already-executed prompt into a
          // terminal id conflict.
          expect(fakeConnection.sendPromptCount, 1);
          expect(fakeConnection.lastPromptPermissionMode, isNull);
        },
      );

      test(
        'outbox replay waits while the current control is Observe',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await fakeOutboxRepository.upsert(
            SessionOutboxMessage.create(
              sessionKey: key,
              brokerProfileId: fakeControllerBrokerScope(),
              clientMessageId: 'ca.retry.observe',
              kind: SessionOutboxMessageKind.prompt,
              payload: const {'text': 'do not auto-send'},
            ).copyWith(status: SessionOutboxMessageStatus.retryable),
          );

          fakeConnection
            ..emitState(SessionDetailConnectionStatus.reconnecting)
            ..emitState(SessionDetailConnectionStatus.connected)
            ..emitSessionControl(const {
              'drive': {'state': 'observing', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            });
          await Future<void>.delayed(Duration.zero);
          await Future<void>.delayed(Duration.zero);

          expect(fakeConnection.sendPromptCount, 0);
          expect(
            fakeOutboxRepository.messageById('ca.retry.observe')?.status,
            SessionOutboxMessageStatus.retryable,
          );
        },
      );

      test(
        'answer-only replay permits card replies but not prompts',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await fakeOutboxRepository.upsert(
            SessionOutboxMessage.create(
              sessionKey: key,
              brokerProfileId: fakeControllerBrokerScope(),
              clientMessageId: 'ca.retry.prompt',
              kind: SessionOutboxMessageKind.prompt,
              payload: const {'text': 'blocked prompt'},
            ).copyWith(status: SessionOutboxMessageStatus.retryable),
          );
          await fakeOutboxRepository.upsert(
            SessionOutboxMessage.create(
              sessionKey: key,
              brokerProfileId: fakeControllerBrokerScope(),
              clientMessageId: 'ca.retry.answer',
              kind: SessionOutboxMessageKind.questionAnswer,
              payload: const {
                'requestId': 'question-1',
                'answers': [
                  ['yes'],
                ],
              },
            ).copyWith(status: SessionOutboxMessageStatus.retryable),
          );

          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'unavailable', 'supported': false},
            'terminalSync': {
              'supported': true,
              'syncAvailable': true,
              'active': true,
              'input': 'answer-only',
            },
          });
          await Future<void>.delayed(Duration.zero);
          await Future<void>.delayed(Duration.zero);

          expect(fakeConnection.sendPromptCount, 0);
          expect(fakeConnection.sendQuestionAnswerCount, 1);
        },
      );

      test(
        'legacy artifact replay without signed context is retired',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await fakeOutboxRepository.upsert(
            SessionOutboxMessage.create(
              sessionKey: key,
              brokerProfileId: fakeControllerBrokerScope(),
              clientMessageId: 'ca.retry.legacy-artifact',
              kind: SessionOutboxMessageKind.artifactInteraction,
              payload: const {
                'artifactKey': 'artifact-1',
                'interaction': {'type': 'click'},
              },
            ).copyWith(status: SessionOutboxMessageStatus.retryable),
          );

          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
          await drainSessionDetailMicrotasks();

          expect(fakeConnection.sendArtifactInteractionCount, 0);
          expect(
            fakeOutboxRepository
                .messageById('ca.retry.legacy-artifact')
                ?.status,
            SessionOutboxMessageStatus.failed,
          );
        },
      );

      test(
        'ownership change retires retryable outbox before reattach',
        () async {
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
          await fakeOutboxRepository.upsert(
            SessionOutboxMessage.create(
              sessionKey: key,
              brokerProfileId: fakeControllerBrokerScope(),
              clientMessageId: 'ca.retry.mode-change',
              kind: SessionOutboxMessageKind.prompt,
              payload: const {'text': 'stale ownership'},
            ).copyWith(status: SessionOutboxMessageStatus.retryable),
          );

          final takeover = controller.takeOver();
          await Future<void>.delayed(Duration.zero);
          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
          final succeeded = await takeover;

          expect(succeeded, isTrue);
          expect(fakeConnection.sendPromptCount, 0);
          expect(
            fakeOutboxRepository.messageById('ca.retry.mode-change')?.status,
            SessionOutboxMessageStatus.failed,
          );
          expect(
            fakeOutboxRepository.messageById('ca.retry.mode-change')?.lastError,
            contains('ownership change'),
          );
        },
      );

      test('sendPrompt ignores empty or whitespace-only text', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPrompt('   \n  ');

        expect(sent, isFalse);
        expect(fakeConnection.sendPromptCount, 0);
      });

      test('sendPrompt rejects when session is not connected', () async {
        keepSessionDetailAlive(container, key);

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPrompt('should fail');

        expect(sent, isFalse);
        expect(fakeConnection.sendPromptCount, 0);
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          contains('Cannot send prompt until the session is connected.'),
        );
      });

      test('sendPrompt surfaces send errors', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.failNextPrompt = true;

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPrompt('this will fail');

        expect(sent, isFalse);
        expect(fakeConnection.sendPromptCount, 1);
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          contains("Couldn't send the prompt."),
        );
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .optimisticPrompts,
          isEmpty,
        );
      });

      test('exposes latest commands from commands wire events', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        fakeConnection
          ..emitEvent(
            const CommandsWireEvent(
              commands: [SlashCommand(name: 'cmd-old')],
            ),
          )
          ..emitEvent(
            const CommandsWireEvent(
              commands: [
                SlashCommand(
                  name: 'cmd-new',
                  description: 'Newest command',
                  usage: '/cmd-new',
                ),
              ],
            ),
          );
        await Future<void>.delayed(Duration.zero);

        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .commands
              .map((command) => command.name),
          ['cmd-new'],
        );
      });

      test(
        'sendCommand sends trimmed name and args when connected',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();

          final sent = await container
              .read(sessionDetailControllerProvider(key).notifier)
              .sendCommand(
                '   /status   ',
                args: const {'limit': 5},
              );

          expect(sent, isTrue);
          expect(fakeConnection.sendCommandCount, 1);
          expect(fakeConnection.lastCommandName, '/status');
          expect(fakeConnection.lastCommandArgs, const {'limit': 5});
          expect(
            container.read(sessionDetailControllerProvider(key)).error,
            isNull,
          );
        },
      );

      test('sendCommand adds the selected permission mode exactly', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendCommand(
              '/review',
              args: const {'limit': 5},
              permissionMode: '  accept-edits  ',
            );

        expect(sent, isTrue);
        expect(
          fakeConnection.lastCommandArgs,
          const {'limit': 5, 'permissionMode': 'accept-edits'},
        );
        expect(
          fakeOutboxRepository.messages.single.payload['args'],
          const {'limit': 5, 'permissionMode': 'accept-edits'},
        );
      });

      test('sendCommand rejects duplicate permission mode sources', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendCommand(
              '/review',
              args: const {'permissionMode': 'default'},
              permissionMode: 'accept-edits',
            );

        expect(sent, isFalse);
        expect(fakeConnection.sendCommandCount, 0);
        expect(fakeOutboxRepository.messages, isEmpty);
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          contains('permission selector'),
        );
      });

      test(
        'compact progress ignores start notice and clears on history reset',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();

          final sent = await container
              .read(sessionDetailControllerProvider(key).notifier)
              .sendCommand('/compact');

          expect(sent, isTrue);
          expect(
            container
                .read(sessionDetailControllerProvider(key))
                .commandProgress
                ?.name,
            'compact',
          );
          fakeConnection.emitSessionControl(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
          await Future<void>.delayed(Duration.zero);
          expect(
            container
                .read(sessionDetailControllerProvider(key))
                .commandProgress,
            isNotNull,
            reason: 'compact may report idle before its completion notice',
          );

          fakeConnection.emitEvent(
            const NoticeWireEvent(message: 'Compacting the conversation...'),
          );
          await Future<void>.delayed(Duration.zero);
          expect(
            container
                .read(sessionDetailControllerProvider(key))
                .commandProgress,
            isNotNull,
            reason: 'the requester notice acknowledges start, not completion',
          );

          fakeConnection.emitEvent(
            MessageWireEvent(
              seq: 1,
              message: AgentMessage.fromJson({
                'type': 'history-reset',
                'notice': 'Compacted the conversation.',
              }),
            ),
          );
          await Future<void>.delayed(Duration.zero);
          expect(
            container
                .read(sessionDetailControllerProvider(key))
                .commandProgress,
            isNull,
          );
        },
      );

      test('sendCommand carries the selected model override', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        const model = SessionCurrentModel(
          providerID: 'anthropic',
          modelID: 'claude-opus-4-6',
          reasoningEffort: 'max',
        );

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendCommand('/review', model: model);

        expect(sent, isTrue);
        expect(fakeConnection.lastCommandModel?.modelID, 'claude-opus-4-6');
        expect(fakeConnection.lastCommandModel?.reasoningEffort, 'max');
      });

      test(
        'sendCommand rejects a model arg before persisting outbox',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          const model = SessionCurrentModel(
            providerID: 'anthropic',
            modelID: 'claude-opus-4-6',
          );

          final sent = await container
              .read(sessionDetailControllerProvider(key).notifier)
              .sendCommand(
                '/review',
                args: const {'model': 'legacy-model-arg'},
                model: model,
              );

          expect(sent, isFalse);
          expect(fakeConnection.sendCommandCount, 0);
          expect(fakeOutboxRepository.messages, isEmpty);
          expect(
            container.read(sessionDetailControllerProvider(key)).error,
            sessionCommandModelArgError,
          );
        },
      );

      test('sendCommand rejects empty command names', () async {
        keepSessionDetailAlive(container, key);

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendCommand('   \n  ');

        expect(sent, isFalse);
        expect(fakeConnection.sendCommandCount, 0);
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          contains('empty command name'),
        );
      });

      test('sendCommand rejects when disconnected', () async {
        keepSessionDetailAlive(container, key);

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendCommand('/help');

        expect(sent, isFalse);
        expect(fakeConnection.sendCommandCount, 0);
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          contains('until the session is connected'),
        );
      });

      test('sendCommand surfaces send errors', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.failNextCommand = true;

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendCommand('/help');

        expect(sent, isFalse);
        expect(fakeConnection.sendCommandCount, 1);
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          contains("Couldn't send the command."),
        );
      });

      test(
        'pickAttachments stages the selected file without sending',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();

          final picked = await container
              .read(sessionDetailControllerProvider(key).notifier)
              .pickAttachments();

          expect(picked, isTrue);
          expect(fakeConnection.sendFileCount, 0);
          expect(fakeConnection.sendPromptCount, 0);
          final state = container.read(sessionDetailControllerProvider(key));
          expect(state.stagedAttachments, hasLength(1));
          expect(state.stagedAttachments.single.attachment.name, 'notes.txt');
          expect(
            state.stagedAttachments.single.phase,
            SessionAttachmentUploadPhase.selected,
          );
        },
      );

      test(
        'multi-select preserves order and replace keeps chip identity',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          fakeAttachmentPicker.selectedAttachments = const [
            SessionAttachment(
              name: 'first.txt',
              data: 'YQ==',
              byteLength: 1,
            ),
            SessionAttachment(
              name: 'second.txt',
              data: 'Yg==',
              byteLength: 1,
            ),
          ];
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.pickAttachments();
          var staged = container
              .read(sessionDetailControllerProvider(key))
              .stagedAttachments;
          expect(
            staged.map((attachment) => attachment.attachment.name),
            ['first.txt', 'second.txt'],
          );
          final firstId = staged.first.localId;
          fakeAttachmentPicker.selectedAttachments = const [
            SessionAttachment(
              name: 'replacement.txt',
              data: 'Yw==',
              byteLength: 1,
            ),
          ];

          expect(await controller.replaceAttachment(firstId), isTrue);

          staged = container
              .read(sessionDetailControllerProvider(key))
              .stagedAttachments;
          expect(staged.first.localId, firstId);
          expect(staged.first.attachment.name, 'replacement.txt');
          expect(staged.last.attachment.name, 'second.txt');
          expect(fakeConnection.sendPromptCount, 0);
          expect(fakeConnection.sendFileCount, 0);
        },
      );

      test(
        'prompt and inline file are one turn and clear only after ACK',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .pickAttachments();
          fakeConnection.onSendPrompt = () {
            fakeConnection.emitEvent(
              AckWireEvent(
                ackKind: 'client-message',
                clientMessageId: fakeConnection.lastPromptClientMessageId,
              ),
            );
          };

          final sent = await container
              .read(sessionDetailControllerProvider(key).notifier)
              .sendPrompt('read this');

          expect(sent, isTrue);
          expect(fakeConnection.sendPromptCount, 1);
          expect(fakeConnection.lastPrompt, 'read this');
          expect(fakeConnection.lastPromptFiles, hasLength(1));
          expect(fakeConnection.lastPromptFiles.single.data, 'aGVsbG8=');
          expect(fakeConnection.lastPromptFiles.single.stagedRef, isNull);
          expect(
            container
                .read(sessionDetailControllerProvider(key))
                .stagedAttachments,
            isEmpty,
          );
        },
      );

      test(
        'multi-select fails atomically above the retained count limit',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          fakeAttachmentPicker.selectedAttachments = List.generate(
            promptAttachmentMaxFiles + 1,
            (index) => SessionAttachment(
              name: '$index.txt',
              data: 'eA==',
              byteLength: 1,
            ),
          );

          final picked = await container
              .read(sessionDetailControllerProvider(key).notifier)
              .pickAttachments();
          final state = container.read(sessionDetailControllerProvider(key));

          expect(picked, isFalse);
          expect(state.stagedAttachments, isEmpty);
          expect(state.error, sessionAttachmentLimitErrorKey);
          expect(fakeConnection.sendPromptCount, 0);
        },
      );

      test(
        'removeAttachment removes the selected file without a send',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          final controller = container.read(
            sessionDetailControllerProvider(key).notifier,
          );
          await controller.pickAttachments();
          final localId = container
              .read(sessionDetailControllerProvider(key))
              .stagedAttachments
              .single
              .localId;

          await controller.removeAttachment(localId);

          expect(
            container
                .read(sessionDetailControllerProvider(key))
                .stagedAttachments,
            isEmpty,
          );
          expect(fakeConnection.sendPromptCount, 0);
          expect(fakeConnection.sendFileCount, 0);
        },
      );

      test(
        'attachment picker cancellation does not queue upload transfer rows',
        () async {
          keepSessionDetailAlive(container, key);
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          fakeAttachmentPicker.selectedAttachment = null;

          final picked = await container
              .read(sessionDetailControllerProvider(key).notifier)
              .pickAttachments();

          expect(picked, isFalse);
          expect(fakeConnection.sendFileCount, 0);
          expect(fakeAttachmentPicker.pickCount, 1);
          expect(
            container.read(sessionArtifactTransferControllerProvider),
            isEmpty,
          );
        },
      );

      test(
        'attachment picker errors do not queue upload transfer rows',
        () async {
          final throwingPicker = ThrowingSessionAttachmentPicker();
          final throwingConnection = FakeSessionDetailConnection();
          final throwingContainer = buildControllerContainer(
            key,
            throwingConnection,
            throwingPicker,
          );
          addTearDown(throwingContainer.dispose);
          keepSessionDetailAlive(throwingContainer, key);
          await throwingContainer
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();

          final picked = await throwingContainer
              .read(sessionDetailControllerProvider(key).notifier)
              .pickAttachments();

          expect(picked, isFalse);
          expect(throwingConnection.sendFileCount, 0);
          expect(
            throwingContainer.read(sessionArtifactTransferControllerProvider),
            isEmpty,
          );
          expect(
            throwingContainer.read(sessionDetailControllerProvider(key)).error,
            sessionAttachmentSelectionErrorKey,
          );
        },
      );

      test('prompt NACK retains attachments for an explicit retry', () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.pickAttachments();
        fakeConnection.onSendPrompt = () {
          fakeConnection.emitEvent(
            NackWireEvent(
              code: 'ATTACHMENT_DELIVERY_FAILED',
              message: 'adapter rejected attachment',
              clientMessageId: fakeConnection.lastPromptClientMessageId,
            ),
          );
        };

        expect(await controller.sendPrompt('read this'), isFalse);

        final staged = container
            .read(sessionDetailControllerProvider(key))
            .stagedAttachments;
        expect(staged, hasLength(1));
        expect(staged.single.attachment.name, 'notes.txt');
        expect(staged.single.phase, SessionAttachmentUploadPhase.error);
        expect(
          fakeOutboxRepository
              .messageById(fakeConnection.lastPromptClientMessageId!)
              ?.status,
          SessionOutboxMessageStatus.failed,
        );
      });
    },
  );
}
