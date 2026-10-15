// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
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
      expect(state.error?.lead, FailureLead.attachRequiresServer);
      expect(
        state.connectionStatus,
        SessionDetailConnectionStatus.disconnected,
      );
    });
  });
}
