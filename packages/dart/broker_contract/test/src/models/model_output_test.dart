import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  AgentMessage message(Map<String, dynamic> json) =>
      AgentMessage.fromJson(json);

  group('model-output typed accessors', () {
    test('parse text, delta, final, and key from a final frame', () {
      final msg = message({
        'type': 'model-output',
        'text': 'Hello world.',
        'delta': 'Hello ',
        'final': true,
        'key': 'turn-42',
      });

      expect(msg.modelOutputText, 'Hello world.');
      expect(msg.modelOutputDelta, 'Hello ');
      expect(msg.modelOutputFinal, isTrue);
      expect(msg.modelOutputKey, 'turn-42');
    });

    test('parse an incremental streaming frame (delta only)', () {
      final msg = message({
        'type': 'model-output',
        'delta': 'Hello ',
        'key': 'turn-42',
      });

      expect(msg.modelOutputText, isNull);
      expect(msg.modelOutputDelta, 'Hello ');
      expect(msg.modelOutputFinal, isFalse);
      expect(msg.modelOutputKey, 'turn-42');
    });

    test('treat missing fields as null / not-final', () {
      final msg = message({'type': 'model-output'});

      expect(msg.modelOutputText, isNull);
      expect(msg.modelOutputDelta, isNull);
      expect(msg.modelOutputKey, isNull);
      expect(msg.modelOutputFinal, isFalse);
    });

    test('are tolerant of wrong-typed fields (never throw)', () {
      final msg = message({
        'type': 'model-output',
        'text': 12345,
        'delta': <String, dynamic>{'x': 1},
        'final': 'true',
        'key': 99,
      });

      expect(msg.modelOutputText, isNull);
      expect(msg.modelOutputDelta, isNull);
      expect(
        msg.modelOutputFinal,
        isFalse,
        reason: 'string "true" is not bool',
      );
      expect(msg.modelOutputKey, isNull);
    });

    test('preserve additive broker fields without affecting accessors', () {
      final msg = message({
        'type': 'model-output',
        'text': 'done.',
        'final': true,
        'key': 'k1',
        'futureField': {'anything': true},
        'seq': 7,
      });

      expect(msg.modelOutputText, 'done.');
      expect(msg.isReadAloudEligible, isTrue);
      expect(msg.raw['futureField'], isNotNull);
    });

    test('ignore defensive content/output/result keys', () {
      final msg = message({
        'type': 'model-output',
        'content': 'legacy',
        'output': 'legacy',
        'result': 'legacy',
        'final': true,
      });

      // content/output/result are not real model-output fields.
      expect(msg.modelOutputText, isNull);
      expect(msg.isReadAloudEligible, isFalse);
    });
  });

  group('read-aloud eligibility', () {
    test('eligible for final model-output with non-empty text', () {
      final msg = message({
        'type': 'model-output',
        'text': 'Final answer.',
        'final': true,
        'key': 'k',
      });

      expect(msg.isReadAloudEligible, isTrue);
      expect(msg.readAloudSourceText, 'Final answer.');
      expect(msg.isFinalModelOutput, isTrue);
    });

    test('not eligible for non-model-output types', () {
      final msg = message({
        'type': 'thinking',
        'text': 'Hmm.',
        'final': true,
        'key': 'k',
      });

      expect(msg.type, AgentMessageType.thinking);
      expect(msg.modelOutputFinal, isTrue);
      expect(msg.isFinalModelOutput, isFalse, reason: 'wrong type');
      expect(msg.isReadAloudEligible, isFalse);
      expect(msg.readAloudSourceText, isNull);
    });

    test('not eligible when final is true but text is missing', () {
      final msg = message({
        'type': 'model-output',
        'final': true,
        'key': 'k',
        'delta': 'partial',
      });

      expect(msg.isFinalModelOutput, isTrue);
      expect(
        msg.isReadAloudEligible,
        isFalse,
        reason: 'no speakable text',
      );
      expect(msg.readAloudSourceText, isNull);
    });

    test('not eligible when final is true but text is empty', () {
      final msg = message({
        'type': 'model-output',
        'text': '',
        'final': true,
        'key': 'k',
      });

      expect(msg.isReadAloudEligible, isFalse);
    });

    test('not eligible when final is true but text is whitespace only', () {
      final msg = message({
        'type': 'model-output',
        'text': '   \n\t ',
        'final': true,
        'key': 'k',
      });

      expect(msg.isReadAloudEligible, isFalse);
      expect(msg.readAloudSourceText, isNull);
    });

    test('not eligible when final is false (streaming frame)', () {
      final msg = message({
        'type': 'model-output',
        'text': 'partial',
        'final': false,
        'key': 'k',
      });

      expect(msg.modelOutputFinal, isFalse);
      expect(msg.isReadAloudEligible, isFalse);
    });

    test('not eligible when final is absent (optional on the wire)', () {
      final msg = message({
        'type': 'model-output',
        'text': 'guess?',
        'key': 'k',
      });

      expect(msg.modelOutputFinal, isFalse);
      expect(
        msg.isReadAloudEligible,
        isFalse,
        reason: 'client never guesses finality',
      );
    });

    test('eligibility is purely field-driven', () {
      final raw = {
        'type': 'model-output',
        'text': 'Hi.',
        'final': true,
        'key': 'k',
      };
      final a = message(Map<String, dynamic>.from(raw));
      final b = message(Map<String, dynamic>.from(raw));

      expect(a.isReadAloudEligible, b.isReadAloudEligible);
      expect(a.readAloudSourceText, b.readAloudSourceText);
    });

    test('a replayed final frame is still eligible', () {
      final msg = message({
        'type': 'model-output',
        'text': 'Replayed.',
        'final': true,
        'key': 'k',
        'seq': 0,
      });

      expect(msg.isReadAloudEligible, isTrue);
      expect(msg.readAloudSourceText, 'Replayed.');
    });
  });
}
