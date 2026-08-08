import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DefaultBrokerSessionNotificationPolicy', () {
    final now = DateTime.utc(2026, 7, 2, 12, 0);

    test('does not notify when app lifecycle is resumed', () async {
      final monitor = _StubLifecycleMonitor(
        currentState: BrokerAppLifecycleState.resumed,
      );
      final sink = _CollectingSink();
      final policy = _buildPolicy(monitor: monitor, sink: sink);

      await policy.maybeNotifyForSessionEvent(
        tool: 'claude',
        sessionId: 'session-1',
        event: MessageWireEvent(
          seq: 1,
          message: AgentMessage(
            type: AgentMessageType.permissionRequest,
            raw: {'type': 'permission-request', 'requestId': 'req-1'},
          ),
        ),
      );

      expect(sink.shown, isEmpty);
    });

    test(
      'notifies on actionable live permission and question messages',
      () async {
        final monitor = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.paused,
        );
        final sink = _CollectingSink();
        final policy = _buildPolicy(
          monitor: monitor,
          sink: sink,
          now: () => now,
        );

        await policy.maybeNotifyForSessionEvent(
          tool: 'claude',
          sessionId: 'session-1',
          event: MessageWireEvent(
            seq: 7,
            message: AgentMessage(
              type: AgentMessageType.permissionRequest,
              id: 'msg-7',
              raw: {
                'type': 'permission-request',
                'requestId': 'req-permission',
              },
            ),
          ),
        );
        await policy.maybeNotifyForSessionEvent(
          tool: 'claude',
          sessionId: 'session-1',
          event: MessageWireEvent(
            seq: 8,
            message: AgentMessage(
              type: AgentMessageType.questionRequest,
              id: 'msg-8',
              raw: {'type': 'question-request', 'requestId': 'req-question'},
            ),
          ),
        );

        expect(sink.shown, hasLength(2));
        expect(sink.shown.first.title, 'Session requires your response');
        expect(sink.shown.last.title, 'Session requires your response');
        expect(sink.shown.map((request) => request.category), [
          BrokerNotificationCategory.actionRequired,
          BrokerNotificationCategory.actionRequired,
        ]);
        expect(sink.shown.first.importance, BrokerNotificationImportance.high);
        expect(sink.shown.first.createdAt, now);
      },
    );

    test(
      'does not notify on replayed messages, ordinary output, or non-message events',
      () async {
        final monitor = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.hidden,
        );
        final sink = _CollectingSink();
        final policy = _buildPolicy(monitor: monitor, sink: sink);

        await policy.maybeNotifyForSessionEvent(
          tool: 'claude',
          sessionId: 'session-1',
          event: MessageWireEvent(
            seq: 0,
            message: AgentMessage(
              type: AgentMessageType.permissionRequest,
              raw: {'type': 'permission-request', 'requestId': 'replay'},
            ),
          ),
        );
        await policy.maybeNotifyForSessionEvent(
          tool: 'claude',
          sessionId: 'session-1',
          event: MessageWireEvent(
            seq: 1,
            message: const AgentMessage(
              type: AgentMessageType.modelOutput,
              raw: {'type': 'model-output'},
            ),
          ),
        );
        await policy.maybeNotifyForSessionEvent(
          tool: 'claude',
          sessionId: 'session-1',
          event: const NoticeWireEvent(message: 'running'),
        );
        await policy.maybeNotifyForSessionEvent(
          tool: 'claude',
          sessionId: 'session-1',
          event: const HistoryWireEvent(messages: []),
        );

        expect(sink.shown, isEmpty);
      },
    );

    test('notifies for broker error events when app is not resumed', () async {
      final monitor = _StubLifecycleMonitor(
        currentState: BrokerAppLifecycleState.hidden,
      );
      final sink = _CollectingSink();
      final policy = _buildPolicy(monitor: monitor, sink: sink);

      await policy.maybeNotifyForSessionEvent(
        tool: 'claude',
        sessionId: 'session-1',
        event: const ErrorWireEvent(message: 'session ended unexpectedly'),
      );

      expect(sink.shown, hasLength(1));
      expect(sink.shown.single.title, 'Session error');
      expect(sink.shown.single.category, BrokerNotificationCategory.error);
      expect(
        sink.shown.single.payload['errorMessage'],
        'session ended unexpectedly',
      );
    });

    test('produces stable ids and metadata', () async {
      final monitor = _StubLifecycleMonitor(
        currentState: BrokerAppLifecycleState.paused,
      );
      final sink = _CollectingSink();
      final policy = _buildPolicy(monitor: monitor, sink: sink, now: () => now);
      final event = MessageWireEvent(
        seq: 42,
        message: AgentMessage(
          type: AgentMessageType.permissionRequest,
          id: 'msg-42',
          raw: {'type': 'permission-request', 'requestId': 'stable-request'},
        ),
      );

      await policy.maybeNotifyForSessionEvent(
        tool: 'claude',
        sessionId: 'session-2',
        event: event,
      );
      await policy.maybeNotifyForSessionEvent(
        tool: 'claude',
        sessionId: 'session-2',
        event: event,
      );

      expect(sink.shown, hasLength(2));
      expect(sink.shown.first.id, sink.shown.last.id);
      expect(sink.shown.first.id, startsWith('session-notification:'));
      expect(sink.shown.first.id, hasLength(29));
      expect(sink.shown.first.payload, {
        'tool': 'claude',
        'sessionId': 'session-2',
        'messageType': 'permission-request',
        'seq': 42,
        'requestId': 'stable-request',
      });
    });

    test(
      'uses the broker attention identity when profile context is available',
      () async {
        final monitor = _StubLifecycleMonitor(
          currentState: BrokerAppLifecycleState.hidden,
        );
        final sink = _CollectingSink();
        final policy = _buildPolicy(monitor: monitor, sink: sink);

        await policy.maybeNotifyForSessionEvent(
          tool: 'codex',
          sessionId: 'session-3',
          brokerProfileId: 'profile-a',
          event: MessageWireEvent(
            seq: 4,
            message: AgentMessage(
              type: AgentMessageType.questionRequest,
              raw: const {
                'type': 'question-request',
                'requestId': 'question-4',
              },
            ),
          ),
        );

        const dedupeKey = 'question-required:codex:session-3:question-4';
        expect(
          sink.shown.single.id,
          brokerAttentionNotificationId(
            brokerProfileId: 'profile-a',
            dedupeKey: dedupeKey,
          ),
        );
        expect(
          sink.shown.single.payload,
          containsPair('brokerProfileId', 'profile-a'),
        );
        expect(sink.shown.single.payload['attentionDedupeKey'], dedupeKey);
      },
    );

    test('keeps notification text generic across tool identity', () async {
      final monitor = _StubLifecycleMonitor(
        currentState: BrokerAppLifecycleState.paused,
      );
      final sink = _CollectingSink();
      final policy = _buildPolicy(monitor: monitor, sink: sink);
      final message = MessageWireEvent(
        seq: 3,
        message: AgentMessage(
          type: AgentMessageType.permissionRequest,
          id: 'msg-3',
          raw: {'type': 'permission-request'},
        ),
      );

      await policy.maybeNotifyForSessionEvent(
        tool: 'tool-a',
        sessionId: 'session-1',
        event: message,
      );
      await policy.maybeNotifyForSessionEvent(
        tool: 'tool-b',
        sessionId: 'session-1',
        event: message,
      );

      expect(sink.shown, hasLength(2));
      expect(sink.shown.first.title, sink.shown.last.title);
      expect(sink.shown.first.body, sink.shown.last.body);
      expect(sink.shown.first.id, isNot(equals(sink.shown.last.id)));
    });
  });
}

DefaultBrokerSessionNotificationPolicy _buildPolicy({
  required BrokerAppLifecycleMonitor monitor,
  required _CollectingSink sink,
  DateTime Function()? now,
}) {
  return DefaultBrokerSessionNotificationPolicy(
    lifecycleMonitor: monitor,
    sink: sink,
    now: now,
  );
}

final class _StubLifecycleMonitor implements BrokerAppLifecycleMonitor {
  _StubLifecycleMonitor({required this.currentState});

  @override
  BrokerAppLifecycleState currentState;

  @override
  Stream<BrokerAppLifecycleState> get stateChanges =>
      const Stream<BrokerAppLifecycleState>.empty();

  @override
  void dispose() {}
}

final class _CollectingSink implements BrokerNotificationSink {
  final List<BrokerNotificationRequest> shown = [];
  final List<String> cleared = [];
  bool clearAllCalled = false;

  @override
  Future<void> show(BrokerNotificationRequest request) async {
    shown.add(request);
  }

  @override
  Future<void> clear(String id) async {
    cleared.add(id);
  }

  @override
  Future<void> clearMany(Iterable<String> ids) async {
    cleared.addAll(ids);
  }

  @override
  Future<void> clearAll() async {
    clearAllCalled = true;
  }
}
