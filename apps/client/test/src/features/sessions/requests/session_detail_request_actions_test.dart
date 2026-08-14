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
  group('SessionDetailController session_detail_request_actions_test.dart', () {
    const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

    test(
      'sendPermissionDecision submits when connected and request id exists',
      () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPermissionDecision(
              requestId: ' perm-1 ',
              decision: 'approve',
            );

        expect(sent, isTrue);
        expect(fakeConnection.sendPermissionDecisionCount, 1);
        expect(fakeConnection.lastPermissionDecisionRequestId, 'perm-1');
        expect(fakeConnection.lastPermissionDecision, 'approve');
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          isNull,
        );
      },
    );

    test('sendPermissionDecision requires a request id', () async {
      keepSessionDetailAlive(container, key);

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .sendPermissionDecision(
            requestId: '   ',
            decision: 'approve',
          );

      expect(sent, isFalse);
      expect(fakeConnection.sendPermissionDecisionCount, 0);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        contains('without a request id'),
      );
    });

    test(
      'sendPermissionDecision rejects when session is not connected',
      () async {
        keepSessionDetailAlive(container, key);

        final sent = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .sendPermissionDecision(
              requestId: 'perm-1',
              decision: 'approve',
            );

        expect(sent, isFalse);
        expect(fakeConnection.sendPermissionDecisionCount, 0);
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          contains('until the session is connected'),
        );
      },
    );

    test('sendPermissionDecision keeps send errors off the page', () async {
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      fakeConnection.failNextPermissionDecision = true;

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .sendPermissionDecision(
            requestId: 'perm-1',
            decision: 'approve',
          );

      expect(sent, isFalse);
      expect(fakeConnection.sendPermissionDecisionCount, 1);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        isNull,
      );
      expect(fakeOutboxRepository.messages, hasLength(1));
      expect(
        fakeOutboxRepository.messages.single.status,
        SessionOutboxMessageStatus.retryable,
      );
      expect(
        fakeOutboxRepository.messages.single.lastError,
        contains('permission failed'),
      );
    });

    test('sendQuestionAnswer submits answers when connected', () async {
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .sendQuestionAnswer(
            requestId: '  q-1 ',
            answers: const [
              ['first'],
              ['second'],
            ],
          );

      expect(sent, isTrue);
      expect(fakeConnection.sendQuestionAnswerCount, 1);
      expect(fakeConnection.lastQuestionRequestId, 'q-1');
      expect(
        fakeConnection.lastQuestionAnswers,
        const [
          ['first'],
          ['second'],
        ],
      );
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        isNull,
      );
    });

    test('sendQuestionAnswer requires a request id', () async {
      keepSessionDetailAlive(container, key);

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .sendQuestionAnswer(
            requestId: ' ',
            answers: const [],
          );

      expect(sent, isFalse);
      expect(fakeConnection.sendQuestionAnswerCount, 0);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        contains('without a request id'),
      );
    });

    test('sendQuestionAnswer rejects empty answers', () async {
      keepSessionDetailAlive(container, key);

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .sendQuestionAnswer(
            requestId: 'q-1',
            answers: const [
              [' ', '\n'],
              [],
            ],
          );

      expect(sent, isFalse);
      expect(fakeConnection.sendQuestionAnswerCount, 0);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        contains('Cannot send empty question answers.'),
      );
    });

    test('sendQuestionAnswer rejects when session is not connected', () async {
      keepSessionDetailAlive(container, key);

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .sendQuestionAnswer(
            requestId: 'q-1',
            answers: const [
              ['answer'],
            ],
          );

      expect(sent, isFalse);
      expect(fakeConnection.sendQuestionAnswerCount, 0);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        contains('until the session is connected'),
      );
    });

    test('sendQuestionAnswer keeps send errors off the page', () async {
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      fakeConnection.failNextQuestionAnswer = true;

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .sendQuestionAnswer(
            requestId: 'q-1',
            answers: const [
              ['answer'],
            ],
          );

      expect(sent, isFalse);
      expect(fakeConnection.sendQuestionAnswerCount, 1);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        isNull,
      );
      expect(fakeOutboxRepository.messages, hasLength(1));
      expect(
        fakeOutboxRepository.messages.single.status,
        SessionOutboxMessageStatus.retryable,
      );
      expect(
        fakeOutboxRepository.messages.single.lastError,
        contains('question answer failed'),
      );
    });

    test('rejectQuestion sends dismiss signal when connected', () async {
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .rejectQuestion('  q-2 ');

      expect(sent, isTrue);
      expect(fakeConnection.rejectQuestionCount, 1);
      expect(fakeConnection.lastRejectQuestionRequestId, 'q-2');
    });

    test('rejectQuestion requires a connected session', () async {
      keepSessionDetailAlive(container, key);

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .rejectQuestion('q-3');

      expect(sent, isFalse);
      expect(fakeConnection.rejectQuestionCount, 0);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        contains('until the session is connected'),
      );
    });

    test('rejectQuestion requires a request id', () async {
      keepSessionDetailAlive(container, key);

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .rejectQuestion('   ');

      expect(sent, isFalse);
      expect(fakeConnection.rejectQuestionCount, 0);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        contains('without a request id'),
      );
    });

    test('rejectQuestion keeps send errors off the page', () async {
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      fakeConnection.failNextRejectQuestion = true;

      final sent = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .rejectQuestion('q-4');

      expect(sent, isFalse);
      expect(fakeConnection.rejectQuestionCount, 1);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        isNull,
      );
      expect(fakeOutboxRepository.messages, hasLength(1));
      expect(
        fakeOutboxRepository.messages.single.status,
        SessionOutboxMessageStatus.retryable,
      );
      expect(
        fakeOutboxRepository.messages.single.lastError,
        contains('reject question failed'),
      );
    });

    test('disconnect closes without reconnect', () async {
      keepSessionDetailAlive(container, key);

      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .disconnect();

      expect(fakeConnection.closeCount, 1);
      expect(fakeConnection.lastReconnect, isFalse);
      expect(
        container.read(sessionDetailControllerProvider(key)).connectionStatus,
        SessionDetailConnectionStatus.closed,
      );
    });

    test('provider disposal disposes the connection', () async {
      keepSessionDetailAlive(container, key);

      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      container.dispose();

      expect(fakeConnection.disposeCount, 1);
    });

    test('attach reports a missing active broker profile', () async {
      container.dispose();
      container = ProviderContainer(
        overrides: [
          ...dr1DurableDraftTestOverrides(),
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            InMemorySessionArtifactTransferRepository(),
          ),
          sessionOutboxRepositoryProvider.overrideWithValue(
            RecordingSessionOutboxRepository(),
          ),
          sessionTranscriptRepositoryProvider.overrideWithValue(
            RecordingSessionTranscriptRepository(),
          ),
          sessionDriveIntentStoreProvider.overrideWithValue(
            InMemoryControllerDriveIntentStore(),
          ),
        ],
      );
      keepSessionDetailAlive(container, key);

      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      final state = container.read(sessionDetailControllerProvider(key));
      expect(state.error, 'Connect to a server before attaching to a session.');
      expect(
        state.connectionStatus,
        SessionDetailConnectionStatus.disconnected,
      );
    });
  });
}
