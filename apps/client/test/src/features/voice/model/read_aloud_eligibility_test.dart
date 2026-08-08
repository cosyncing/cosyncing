import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/voice/model/read_aloud_eligibility.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  AgentMessage finalMessage({
    String? text = 'Hello world.',
    String? key,
    String? id,
    bool isFinal = true,
  }) {
    return AgentMessage(
      type: AgentMessageType.modelOutput,
      id: id,
      raw: {
        'type': 'model-output',
        if (text != null) 'text': text,
        'final': isFinal,
        if (key != null) 'key': key,
      },
    );
  }

  group('resolveReadAloudIdentity', () {
    test('uses modelOutputKey when present', () {
      final message = finalMessage(key: 'turn-1', id: 'msg-1');
      expect(resolveReadAloudIdentity(message), 'turn-1');
    });

    test('falls back to AgentMessage.id when key absent', () {
      final message = finalMessage(id: 'msg-42');
      expect(resolveReadAloudIdentity(message), 'msg-42');
    });

    test('returns null when both key and id absent', () {
      const message = AgentMessage(
        type: AgentMessageType.modelOutput,
        raw: {'type': 'model-output', 'text': 'Hi.', 'final': true},
      );
      expect(resolveReadAloudIdentity(message), isNull);
    });

    test('trims whitespace from key', () {
      final message = finalMessage(key: '  turn-1  ', id: 'msg-1');
      expect(resolveReadAloudIdentity(message), 'turn-1');
    });

    test('trims whitespace from id fallback', () {
      final message = finalMessage(id: '  msg-42  ');
      expect(resolveReadAloudIdentity(message), 'msg-42');
    });

    test('empty key falls back to id', () {
      final message = finalMessage(key: '', id: 'msg-42');
      expect(resolveReadAloudIdentity(message), 'msg-42');
    });

    test('empty key and empty id returns null', () {
      final message = finalMessage(key: '', id: '');
      expect(resolveReadAloudIdentity(message), isNull);
    });
  });

  group('isReadAloudEligible', () {
    test('eligible for final model-output with text and identity', () {
      final message = finalMessage(key: 'turn-1', id: 'msg-1');
      expect(isReadAloudEligible(message), isTrue);
    });

    test('not eligible for non-final', () {
      final message = finalMessage(key: 'turn-1', id: 'msg-1', isFinal: false);
      expect(isReadAloudEligible(message), isFalse);
    });

    test('not eligible for empty text', () {
      final message = finalMessage(text: '   ', key: 'turn-1', id: 'msg-1');
      expect(isReadAloudEligible(message), isFalse);
    });

    test('not eligible for missing identity', () {
      const message = AgentMessage(
        type: AgentMessageType.modelOutput,
        raw: {'type': 'model-output', 'text': 'Hi.', 'final': true},
      );
      expect(isReadAloudEligible(message), isFalse);
    });

    test('not eligible for non-model-output type', () {
      const message = AgentMessage(
        type: AgentMessageType.status,
        id: 'msg-1',
        raw: {'type': 'status', 'text': 'done', 'final': true},
      );
      expect(isReadAloudEligible(message), isFalse);
    });
  });

  group('newestEligibleIndices', () {
    test('two eligible final frames with same key => only newest index', () {
      final messages = [
        finalMessage(key: 'turn-1', id: 'msg-1'),
        finalMessage(key: 'turn-1', id: 'msg-2'),
      ];
      final result = newestEligibleIndices(messages);
      expect(result, {1});
    });

    test('different identities => both indices', () {
      final messages = [
        finalMessage(key: 'turn-a', id: 'msg-1'),
        finalMessage(key: 'turn-b', id: 'msg-2'),
      ];
      final result = newestEligibleIndices(messages);
      expect(result, {0, 1});
    });

    test('ineligible later frame does not suppress eligible final', () {
      final messages = [
        finalMessage(key: 'turn-1', id: 'msg-1'),
        finalMessage(key: 'turn-1', id: 'msg-2', isFinal: false),
      ];
      final result = newestEligibleIndices(messages);
      expect(result, {0});
    });

    test('id fallback dedup works', () {
      final messages = [
        finalMessage(id: 'msg-1'),
        finalMessage(id: 'msg-1'),
      ];
      final result = newestEligibleIndices(messages);
      expect(result, {1});
    });

    test('three same-key frames => only last index', () {
      final messages = [
        finalMessage(key: 'turn-1', id: 'msg-1'),
        finalMessage(key: 'turn-1', id: 'msg-2'),
        finalMessage(key: 'turn-1', id: 'msg-3'),
      ];
      final result = newestEligibleIndices(messages);
      expect(result, {2});
    });

    test('mixed eligible and ineligible messages', () {
      final messages = [
        finalMessage(key: 'turn-a', id: 'msg-1'),
        // Non-model-output, not eligible.
        const AgentMessage(
          type: AgentMessageType.status,
          id: 'msg-2',
          raw: {'type': 'status', 'text': 'running'},
        ),
        finalMessage(key: 'turn-b', id: 'msg-3'),
        // Same key as turn-a, newer.
        finalMessage(key: 'turn-a', id: 'msg-4'),
      ];
      final result = newestEligibleIndices(messages);
      // turn-a: newest is index 3; turn-b: index 2.
      expect(result, {2, 3});
    });

    test('empty list => empty set', () {
      expect(newestEligibleIndices([]), isEmpty);
    });

    test('all ineligible => empty set', () {
      final messages = [
        finalMessage(key: 'turn-1', id: 'msg-1', isFinal: false),
        const AgentMessage(
          type: AgentMessageType.status,
          id: 'msg-2',
          raw: {'type': 'status', 'text': 'done'},
        ),
      ];
      expect(newestEligibleIndices(messages), isEmpty);
    });
  });
}
