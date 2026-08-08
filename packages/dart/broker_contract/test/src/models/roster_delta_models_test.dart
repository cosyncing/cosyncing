import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  test('decodes a bounded session metadata delta', () {
    final batch = SessionRosterDeltaBatch.fromJson({
      'revision': 3,
      'deltas': [
        {
          'revision': 3,
          'machine': 'host-a',
          'tool': 'codex',
          'sessionId': 'session-1',
          'changedFields': ['status', 'currentModel'],
          'session': {
            'id': 'session-1',
            'machine': 'host-a',
            'tool': 'codex',
            'title': 'Roster task',
            'status': 'working',
            'attachMode': 'observe',
            'currentModel': {
              'providerID': 'openai',
              'modelID': 'gpt-5.4-codex',
              'label': 'GPT-5.4',
            },
          },
        },
      ],
    });

    expect(batch.revision, 3);
    expect(batch.resetRequired, isFalse);
    expect(batch.deltas.single.session?.status, SessionStatus.working);
    expect(batch.deltas.single.session?.currentModel?.label, 'GPT-5.4');
  });

  test('decodes removal and reset batches without a session payload', () {
    final batch = SessionRosterDeltaBatch.fromJson({
      'revision': 0,
      'resetRequired': true,
      'deltas': [
        {
          'revision': 1,
          'machine': 'host-a',
          'tool': 'codex',
          'sessionId': 'removed',
          'changedFields': ['removed'],
          'removed': true,
        },
      ],
    });

    expect(batch.resetRequired, isTrue);
    expect(batch.deltas.single.removed, isTrue);
    expect(batch.deltas.single.session, isNull);
  });
}
