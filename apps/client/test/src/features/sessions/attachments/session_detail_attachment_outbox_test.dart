import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import '../../../../support/session_detail_controller_test_harness.dart';

void main() {
  late FakeSessionDetailConnection fakeConnection;
  late FakeControllerAttachmentPicker fakeAttachmentPicker;
  late FakeControllerBrokerClient fakeBrokerClient;
  late RecordingSessionOutboxRepository fakeOutboxRepository;
  late ProviderContainer container;

  setUp(() {
    fakeConnection = FakeSessionDetailConnection();
    fakeAttachmentPicker = FakeControllerAttachmentPicker();
    fakeBrokerClient = FakeControllerBrokerClient();
    fakeOutboxRepository = RecordingSessionOutboxRepository();
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
          FakeControllerArtifactFileService(),
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
          RecordingSessionTranscriptRepository(),
        ),
        sessionDriveIntentStoreProvider.overrideWithValue(
          InMemoryControllerDriveIntentStore(),
        ),
        sessionListRepositoryProvider.overrideWith(
          (ref) async => InMemorySessionListRepository(),
        ),
        sessionListControllerProvider.overrideWith(
          StubSessionListController.new,
        ),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  group('SessionDetailController attachment outbox', () {
    const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

    test(
      'reconnect replays retained attachment metadata with the same id',
      () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.pickAttachments();
        final retained = container
            .read(sessionDetailControllerProvider(key))
            .stagedAttachments
            .single;
        const clientMessageId = 'ca.retry.attachment';
        await fakeOutboxRepository.upsert(
          SessionOutboxMessage.create(
            sessionKey: key,
            brokerProfileId: fakeControllerBrokerScope(),
            clientMessageId: clientMessageId,
            kind: SessionOutboxMessageKind.prompt,
            payload: {
              'text': 'retry with file',
              'files': [retained.toOutboxJson()],
            },
          ).copyWith(status: SessionOutboxMessageStatus.retryable),
        );

        fakeConnection
          ..emitState(SessionDetailConnectionStatus.reconnecting)
          ..emitState(SessionDetailConnectionStatus.connected);
        await Future<void>.delayed(Duration.zero);
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
        await Future<void>.delayed(const Duration(milliseconds: 50));

        expect(
          fakeOutboxRepository.messageById(clientMessageId)?.status,
          SessionOutboxMessageStatus.sending,
        );
        expect(fakeConnection.sendPromptCount, 1);
        expect(fakeConnection.lastPromptClientMessageId, clientMessageId);
        expect(fakeConnection.lastPromptFiles, hasLength(1));
        expect(fakeConnection.lastPromptFiles.single.name, 'notes.txt');
        expect(fakeConnection.lastPromptFiles.single.data, 'aGVsbG8=');
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .stagedAttachments,
          hasLength(1),
        );
      },
    );

    test(
      'large file uses opaque staging and outbox stores metadata only',
      () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        final bytes = List<int>.filled(
          promptAttachmentInlineFileMaxBytes + 1,
          7,
        );
        fakeAttachmentPicker.selectedAttachments = [
          SessionAttachment.streamed(
            name: 'large.bin',
            byteLength: bytes.length,
            mimeType: 'application/octet-stream',
            openRead: ({int start = 0, int? end}) => Stream.value(
              bytes.sublist(start, end ?? bytes.length),
            ),
          ),
        ];
        fakeBrokerClient.uploadCompleteResult = UploadCompleteResult(
          uploadId: 'upload-large',
          stagedRef: 'stg1.large-opaque',
          name: 'large.bin',
          mimeType: 'application/octet-stream',
          size: bytes.length,
          expiresAt: DateTime.now()
              .add(const Duration(hours: 1))
              .millisecondsSinceEpoch,
        );
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.pickAttachments();
        fakeConnection.onSendPrompt = () {
          fakeConnection.emitEvent(
            AckWireEvent(
              ackKind: 'client-message',
              clientMessageId: fakeConnection.lastPromptClientMessageId,
            ),
          );
        };

        expect(await controller.sendPrompt('inspect'), isTrue);

        expect(fakeBrokerClient.initUploadCount, 1);
        expect(fakeBrokerClient.completeUploadCount, 1);
        expect(fakeConnection.lastPromptFiles, hasLength(1));
        expect(fakeConnection.lastPromptFiles.single.data, isNull);
        expect(
          fakeConnection.lastPromptFiles.single.stagedRef,
          'stg1.large-opaque',
        );
        final row = fakeOutboxRepository.messageById(
          fakeConnection.lastPromptClientMessageId!,
        );
        final persistedFiles = row?.payload['files'] as List<dynamic>;
        final persisted = persistedFiles.single as Map<String, dynamic>;
        expect(persisted['stagedRef'], 'stg1.large-opaque');
        expect(persisted, isNot(contains('data')));
        expect(persisted, isNot(contains('path')));
        expect(persisted, isNot(contains('brokerPath')));
      },
    );
  });
}
