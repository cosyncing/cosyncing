import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

void main() {
  const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

  test('clear invalidates a controller-pending transcript snapshot', () async {
    final connection = FakeSessionDetailConnection();
    final repository = RecordingSessionTranscriptRepository();
    final container = buildControllerContainer(
      key,
      connection,
      FakeControllerAttachmentPicker(),
      transcriptRepository: repository,
    );
    addTearDown(container.dispose);
    final gate = Completer<void>();
    final fence = container.read(sessionCacheWriteFenceProvider);
    repository
      ..writeFence = fence
      ..pendingUpsert = gate;
    keepSessionDetailAlive(container, key);
    await container
        .read(sessionDetailControllerProvider(key).notifier)
        .attach();

    // Commit A is inside the shared repository fence and held open.
    connection.emitEvent(
      MessageWireEvent(
        seq: 1,
        message: AgentMessage.fromJson(const {
          'type': 'model-output',
          'key': 'answer-a',
          'text': 'held A',
        }),
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(repository.upserts, hasLength(1));

    // B is in the controller's coalescing slot, not repository.upsert.
    connection.emitEvent(
      HistoryWireEvent(
        messages: [
          AgentMessage.fromJson(const {
            'type': 'model-output',
            'key': 'answer-b',
            'text': 'pending B',
          }),
        ],
        cursor: 'cursor-b',
        attachTicket: 'ticket-b',
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(repository.upserts, hasLength(1));

    final clearing = fence.clearTranscript(
      brokerSourceKey: fakeControllerBrokerScope(),
      tool: key.tool,
      sessionId: key.sessionId,
      operation: () async => repository.stored = null,
    );
    gate.complete();
    await clearing;
    await drainSessionDetailMicrotasks();

    expect(
      repository.upserts,
      hasLength(1),
      reason: 'pre-clear pending B must never enter the repository',
    );
    expect(
      repository.stored,
      isNull,
      reason: 'A must drain before the clear deletes its committed row',
    );
    expect(connection.sendAckCount, 0);
    expect(connection.sendNackCount, 0);

    // A genuinely later event may rebuild the bounded current snapshot.
    repository.pendingUpsert = null;
    connection.emitEvent(
      MessageWireEvent(
        seq: 3,
        message: AgentMessage.fromJson(const {
          'type': 'model-output',
          'key': 'answer-c',
          'text': 'post-clear C',
        }),
      ),
    );
    await drainSessionDetailMicrotasks();

    expect(repository.upserts, hasLength(2));
    expect(repository.stored!.messages.last.raw['text'], 'post-clear C');
    expect(
      connection.sendAckCount,
      0,
      reason: 'the invalidated ticket remains available for reissue',
    );
    expect(connection.sendNackCount, 0);
  });
}
