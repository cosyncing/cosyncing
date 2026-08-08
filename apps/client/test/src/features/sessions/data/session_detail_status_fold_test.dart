// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

/// A canonical broker `status` message, delivered as a plain message frame.
MessageWireEvent _statusEvent(String status) => MessageWireEvent(
  seq: 1,
  message: AgentMessage.fromJson({'type': 'status', 'status': status}),
);

SessionWireEvent _sessionEvent(String status) => SessionWireEvent(
  info: SessionInfo.fromJson({
    'id': 'session-1',
    'tool': 'claude',
    'title': 'Controller test',
    'status': status,
    'attachMode': 'observe',
    'cwd': '/repo',
  }),
);

void main() {
  late FakeSessionDetailConnection fakeConnection;
  late ProviderContainer container;

  setUp(() {
    fakeConnection = FakeSessionDetailConnection();
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

  group('SessionDetailController status folding', () {
    const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

    Future<SessionDetailController> attached() async {
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      return controller;
    }

    SessionStatus? statusOf() => container
        .read(sessionDetailControllerProvider(key))
        .sessionInfo
        ?.status;

    // The reported bug: a session that finished still read "Working" until the
    // page was reloaded. An older broker sends no `session` frame on the
    // transition, so the status message itself has to carry the correction.
    test('an idle status message clears a stale working status', () async {
      await attached();
      fakeConnection.emitEvent(_sessionEvent('working'));
      await Future<void>.delayed(Duration.zero);
      expect(statusOf(), SessionStatus.working);

      fakeConnection.emitEvent(_statusEvent('idle'));
      await Future<void>.delayed(Duration.zero);

      expect(statusOf(), SessionStatus.idle);
    });

    test(
      'a running status message promotes an idle session to working',
      () async {
        await attached();
        fakeConnection.emitEvent(_sessionEvent('idle'));
        await Future<void>.delayed(Duration.zero);

        fakeConnection.emitEvent(_statusEvent('running'));
        await Future<void>.delayed(Duration.zero);

        expect(statusOf(), SessionStatus.working);
      },
    );

    // The detail state does not track pending permission/question requests, so
    // it cannot know a block cleared. Only the broker's `session` frame may
    // move a session off needs-input.
    test('an idle status message leaves needs-input alone', () async {
      await attached();
      fakeConnection.emitEvent(_sessionEvent('needs-input'));
      await Future<void>.delayed(Duration.zero);

      fakeConnection.emitEvent(_statusEvent('idle'));
      await Future<void>.delayed(Duration.zero);

      expect(statusOf(), SessionStatus.needsInput);
    });

    test('folding preserves the rest of the session info', () async {
      await attached();
      fakeConnection.emitEvent(_sessionEvent('working'));
      await Future<void>.delayed(Duration.zero);

      fakeConnection.emitEvent(_statusEvent('idle'));
      await Future<void>.delayed(Duration.zero);

      final info = container
          .read(sessionDetailControllerProvider(key))
          .sessionInfo;
      expect(info?.status, SessionStatus.idle);
      expect(info?.title, 'Controller test');
      expect(info?.cwd, '/repo');
      expect(info?.attachMode, AttachMode.observe);
    });

    test('a non-status message leaves the status untouched', () async {
      await attached();
      fakeConnection.emitEvent(_sessionEvent('working'));
      await Future<void>.delayed(Duration.zero);

      fakeConnection.emitEvent(
        MessageWireEvent(
          seq: 2,
          message: AgentMessage.fromJson({
            'type': 'model-output',
            'key': 'k1',
            'text': 'hello',
          }),
        ),
      );
      await Future<void>.delayed(Duration.zero);

      expect(statusOf(), SessionStatus.working);
    });
  });
}
