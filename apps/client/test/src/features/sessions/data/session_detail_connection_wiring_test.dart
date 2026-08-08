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
  group('SessionDetailConnection wiring', () {
    test(
      'defaults production adapter factory to FlutterWebSocketAdapter',
      () async {
        final container = productionControllerContainer();
        addTearDown(container.dispose);

        final adapter = container.read(
          sessionSocketAdapterFactoryProvider,
        )('ws://127.0.0.1/stream');

        expect(adapter, isA<FlutterWebSocketAdapter>());
        await adapter.close();
      },
    );

    test(
      'uses session socket adapter factory provider in production wiring',
      () async {
        final adapter = TrackingWebSocketAdapter();
        final wiredContainer = ProviderContainer(
          overrides: [
            sessionSocketAdapterFactoryProvider.overrideWithValue(
              (_) => adapter,
            ),
          ],
        );
        addTearDown(wiredContainer.dispose);

        final factory = wiredContainer.read(
          sessionDetailConnectionFactoryProvider,
        );
        final connection = factory(
          resolver: EndpointResolver(baseUrl: 'http://127.0.0.1:7734'),
          tool: 'claude',
          sessionId: 'session-1',
        );

        await connection.connect();
        expect(adapter.connectCalled, isTrue);
        await connection.close();
        await connection.dispose();
      },
    );
  });
}
