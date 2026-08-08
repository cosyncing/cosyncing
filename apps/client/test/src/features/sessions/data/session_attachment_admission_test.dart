import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

void main() {
  late FakeSessionDetailConnection fakeConnection;
  late FakeControllerAttachmentPicker fakeAttachmentPicker;
  late ProviderContainer container;

  setUp(() {
    fakeConnection = FakeSessionDetailConnection();
    fakeAttachmentPicker = FakeControllerAttachmentPicker();
    container = ProviderContainer(
      overrides: [
        ...dr1DurableDraftTestOverrides(),
        activeBrokerProfileProvider.overrideWith(
          (ref) => fakeControllerBrokerProfile(),
        ),
        brokerClientProvider.overrideWith(
          (ref) async => FakeControllerBrokerClient(),
        ),
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
          RecordingSessionOutboxRepository(),
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

  tearDown(() => container.dispose());

  const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

  test('paste/drop admission reuses picker staging without sending', () async {
    keepSessionDetailAlive(container, key);
    await container
        .read(sessionDetailControllerProvider(key).notifier)
        .attach();
    final controller = container.read(
      sessionDetailControllerProvider(key).notifier,
    );

    final admitted = await controller.admitAttachments(const [
      SessionAttachment(
        name: 'pasted.png',
        data: 'AQID',
        byteLength: 3,
        mimeType: 'image/png',
      ),
      SessionAttachment(
        name: 'dropped.txt',
        data: 'eA==',
        byteLength: 1,
        mimeType: 'text/plain',
      ),
    ]);

    final state = container.read(sessionDetailControllerProvider(key));
    expect(admitted, isTrue);
    expect(
      state.stagedAttachments.map((item) => item.attachment.name),
      ['pasted.png', 'dropped.txt'],
    );
    expect(fakeAttachmentPicker.pickCount, 0);
    expect(fakeConnection.sendPromptCount, 0);
    expect(fakeConnection.sendFileCount, 0);
  });

  test(
    'paste/drop capacity failure preserves existing chips atomically',
    () async {
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.pickAttachments();
      final before = container
          .read(sessionDetailControllerProvider(key))
          .stagedAttachments;

      final admitted = await controller.admitAttachments(
        List.generate(
          promptAttachmentMaxFiles,
          (index) => SessionAttachment(
            name: '$index.txt',
            data: 'eA==',
            byteLength: 1,
          ),
        ),
      );

      final state = container.read(sessionDetailControllerProvider(key));
      expect(admitted, isFalse);
      expect(
        state.stagedAttachments.map((item) => item.localId),
        before.map((item) => item.localId),
      );
      expect(
        state.stagedAttachments.map((item) => item.attachment.name),
        before.map((item) => item.attachment.name),
      );
      expect(state.error, sessionAttachmentLimitErrorKey);
      expect(fakeConnection.sendPromptCount, 0);
    },
  );
}
