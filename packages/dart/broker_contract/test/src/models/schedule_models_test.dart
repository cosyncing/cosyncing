import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('schedule create requests', () {
    test('encodes a one-shot existing-session message', () {
      const request = MessageScheduleCreate(
        tool: 'codex',
        sessionId: 'session-1',
        sessionTitle: 'Release work',
        text: 'Run the release checks',
        at: 1730000000000,
      );

      expect(request.toJson(), {
        'kind': 'message',
        'tool': 'codex',
        'sessionId': 'session-1',
        'sessionTitle': 'Release work',
        'text': 'Run the release checks',
        'at': 1730000000000,
      });
      expect(request.toJson(), isNot(contains('repeat')));
      expect(request.toJson(), isNot(contains('timeZone')));
    });

    test('encodes a repeating new-session prompt', () {
      const request = NewSessionScheduleCreate(
        tool: 'codex',
        directory: '/work/project',
        title: 'Daily review',
        model: SessionCurrentModel(
          providerID: 'azure-openai',
          modelID: 'gpt-selected',
          reasoningEffort: 'high',
        ),
        text: 'Review open changes',
        at: 1730000000000,
        repeat: ScheduleRepeat.weekdays,
        timeZone: 'Europe/London',
      );

      expect(request.toJson(), {
        'kind': 'new-session',
        'tool': 'codex',
        'directory': '/work/project',
        'title': 'Daily review',
        'model': {
          'providerID': 'azure-openai',
          'modelID': 'gpt-selected',
          'reasoningEffort': 'high',
        },
        'text': 'Review open changes',
        'at': 1730000000000,
        'repeat': 'weekdays',
        'timeZone': 'Europe/London',
      });
    });

    test('encodes cron and bounded retry policy', () {
      const request = NewSessionScheduleCreate(
        tool: 'codex',
        text: 'Review open changes',
        cron: ScheduleCron(
          expression: '0 9 * * 1-5',
          timeZone: 'Europe/London',
        ),
        retryPolicy: ScheduleRetryPolicy(
          maxRetries: 3,
          delayMs: 300000,
          backoff: ScheduleRetryBackoff.exponential,
          retryOn: [
            ScheduleFailureKind.delivery,
            ScheduleFailureKind.quota,
          ],
        ),
      );

      expect(request.toJson(), {
        'kind': 'new-session',
        'tool': 'codex',
        'text': 'Review open changes',
        'cron': {
          'expression': '0 9 * * 1-5',
          'timeZone': 'Europe/London',
        },
        'retryPolicy': {
          'maxRetries': 3,
          'delayMs': 300000,
          'backoff': 'exponential',
          'retryOn': ['delivery', 'quota'],
        },
      });
      expect(request.toJson(), isNot(contains('at')));
    });

    test('encodes revision edits and lifecycle actions', () {
      const update = ScheduleUpdate(
        expectedRevision: 4,
        text: 'Updated prompt',
        cron: ScheduleCron(
          expression: '30 8 * * *',
          timeZone: 'Europe/London',
        ),
        clearRepeat: true,
        clearTimeZone: true,
        clearRetryPolicy: true,
      );
      const action = ScheduleActionRequest(
        action: ScheduleAction.runNow,
        expectedRevision: 5,
      );

      expect(update.toJson(), {
        'expectedRevision': 4,
        'text': 'Updated prompt',
        'repeat': null,
        'cron': {
          'expression': '30 8 * * *',
          'timeZone': 'Europe/London',
        },
        'retryPolicy': null,
        'timeZone': null,
      });
      expect(action.toJson(), {
        'action': 'run-now',
        'expectedRevision': 5,
      });
    });
  });

  group('schedule responses', () {
    test('parses every field on a repeating record', () {
      final json = _scheduleJson()
        ..['model'] = {
          'providerID': 'azure-openai',
          'modelID': 'gpt-selected',
          'variant': 'fast',
        };
      final record = ScheduleRecord.fromJson(json);

      expect(record.id, 'schedule-1');
      expect(record.revision, 1);
      expect(record.kind, ScheduleKind.newSession);
      expect(record.tool, 'codex');
      expect(record.directory, '/work/project');
      expect(record.title, 'Daily review');
      expect(record.model?.providerID, 'azure-openai');
      expect(record.model?.modelID, 'gpt-selected');
      expect(record.model?.variant, 'fast');
      expect(record.text, 'Review open changes');
      expect(record.at, 1730000000000);
      expect(record.repeat, ScheduleRepeat.daily);
      expect(record.timeZone, 'Europe/London');
      expect(record.recurrenceTime, '09:30');
      expect(record.state, ScheduleState.scheduled);
      expect(record.lastFiredAt, 1729990000000);
      expect(record.lastOutcome, ScheduleOutcome.delivered);
      expect(record.lastError, 'Earlier occurrence was late');
      expect(record.createdSessionId, 'created-session-1');
      expect(record.toJson(), {...json, 'revision': 1});
    });

    test('parses all lifecycle states and outcomes tolerantly', () {
      for (final entry in <String, ScheduleState>{
        'scheduled': ScheduleState.scheduled,
        'paused': ScheduleState.paused,
        'delivered': ScheduleState.delivered,
        'failed': ScheduleState.failed,
        'missed': ScheduleState.missed,
        'canceled': ScheduleState.canceled,
        'future-state': ScheduleState.unknown,
      }.entries) {
        final record = ScheduleRecord.fromJson(
          _scheduleJson()..['state'] = entry.key,
        );
        expect(record.state, entry.value);
      }

      for (final entry in <String, ScheduleOutcome>{
        'delivered': ScheduleOutcome.delivered,
        'failed': ScheduleOutcome.failed,
        'missed': ScheduleOutcome.missed,
        'future-outcome': ScheduleOutcome.unknown,
      }.entries) {
        final record = ScheduleRecord.fromJson(
          _scheduleJson()..['lastOutcome'] = entry.key,
        );
        expect(record.lastOutcome, entry.value);
      }
    });

    test('parses list and create wrappers', () {
      final list = ScheduleListResponse.fromJson({
        'ok': true,
        'schedules': [_scheduleJson()],
      });
      final created = ScheduleCreateResponse.fromJson({
        'ok': true,
        'schedule': _scheduleJson(),
      });

      expect(list.schedules, hasLength(1));
      expect(created.schedule.id, 'schedule-1');
    });

    test('parses mutation response and retry bookkeeping', () {
      final response = ScheduleMutationResponse.fromJson({
        'ok': true,
        'schedule': {
          ..._scheduleJson(),
          'revision': 7,
          'state': 'paused',
          'lastFailureKind': 'quota',
          'retryAttempt': 2,
          'nextRetryAt': 1730000100000,
          'occurrenceAt': 1730000000000,
          'pendingSessionId': 'pending-1',
          'lastFailedSessionId': 'failed-1',
        },
      });

      expect(response.schedule.revision, 7);
      expect(response.schedule.state, ScheduleState.paused);
      expect(response.schedule.lastFailureKind, ScheduleFailureKind.quota);
      expect(response.schedule.retryAttempt, 2);
      expect(response.schedule.pendingSessionId, 'pending-1');
    });

    test('distinguishes cancel from terminal removal', () {
      final canceled = ScheduleDeleteResponse.fromJson({
        'ok': true,
        'schedule': _scheduleJson()..['state'] = 'canceled',
      });
      final removed = ScheduleDeleteResponse.fromJson({
        'ok': true,
        'removed': true,
      });

      expect(canceled, isA<ScheduleCanceledResponse>());
      expect(
        (canceled as ScheduleCanceledResponse).schedule.state,
        ScheduleState.canceled,
      );
      expect(removed, isA<ScheduleRemovedResponse>());
    });

    test('rejects malformed success wrappers', () {
      expect(
        () => ScheduleListResponse.fromJson({
          'ok': false,
          'schedules': <dynamic>[],
        }),
        throwsFormatException,
      );
      expect(
        () => ScheduleDeleteResponse.fromJson({'ok': true}),
        throwsFormatException,
      );
    });
  });
}

Map<String, dynamic> _scheduleJson() => <String, dynamic>{
  'id': 'schedule-1',
  'kind': 'new-session',
  'tool': 'codex',
  'directory': '/work/project',
  'title': 'Daily review',
  'text': 'Review open changes',
  'at': 1730000000000,
  'repeat': 'daily',
  'timeZone': 'Europe/London',
  'recurrenceTime': '09:30',
  'state': 'scheduled',
  'createdAt': 1729900000000,
  'updatedAt': 1729990000000,
  'lastFiredAt': 1729990000000,
  'lastOutcome': 'delivered',
  'lastError': 'Earlier occurrence was late',
  'createdSessionId': 'created-session-1',
};
