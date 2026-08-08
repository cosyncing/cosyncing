import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  test('known attention kinds distinguish security alerts from pairing', () {
    expect(knownAttentionEventKinds, contains('security-alert'));
    final event = AttentionEvent.fromJson({
      'id': 'security-1',
      'cursor': 1,
      'revision': 1,
      'presentationRevision': 1,
      'kind': 'security-alert',
      'state': 'resolved',
      'severity': 'action-required',
      'dedupeKey': 'security-alert:auth',
      'createdAt': 1,
      'updatedAt': 1,
      'title': 'Security alert',
      'action': {'kind': 'open-attention-inbox'},
    });
    expect(event.isSecurityAlert, isTrue);
    expect(event.isDevicePaired, isFalse);
  });

  test('scheduled-send attention kinds are typed separately', () {
    AttentionEvent event(String kind) => AttentionEvent.fromJson({
      'id': 'schedule-1',
      'cursor': 1,
      'revision': 1,
      'presentationRevision': 1,
      'kind': kind,
      'state': 'resolved',
      'severity': 'informational',
      'dedupeKey': 'schedule-1',
      'createdAt': 1,
      'updatedAt': 1,
      'title': 'Scheduled send',
      'action': {'kind': 'open-attention-inbox'},
    });

    expect(knownAttentionEventKinds, contains('scheduled-send'));
    expect(knownAttentionEventKinds, contains('scheduled-send-failed'));
    expect(event('scheduled-send').isScheduledSend, isTrue);
    expect(event('scheduled-send').isScheduledSendFailed, isFalse);
    expect(event('scheduled-send-failed').isScheduledSendFailed, isTrue);
  });

  group('AttentionEventAction', () {
    test('parses known action payload with helpers', () {
      final action = AttentionEventAction.fromJson({
        'kind': 'open-session',
        'tool': 'opencode',
        'sessionId': 'session-1',
        'futureValue': 'preserved',
      });
      expect(action.kind, 'open-session');
      expect(action.tool, 'opencode');
      expect(action.sessionId, 'session-1');
      expect(action.isOpenSession, isTrue);
      expect(action.isKnownKind, isTrue);

      final json = action.toJson();
      expect(json['tool'], 'opencode');
      expect(json['sessionId'], 'session-1');
      expect(json['futureValue'], 'preserved');
    });

    test('preserves unknown action kinds and fields', () {
      final action = AttentionEventAction.fromJson({
        'kind': 'open-future-portal',
        'foo': 'bar',
        'nested': {'id': 1},
      });
      expect(action.kind, 'open-future-portal');
      expect(action.isKnownKind, isFalse);
      expect(action.toJson()['foo'], 'bar');
      expect((action.toJson()['nested'] as Map<String, dynamic>)['id'], 1);
    });
  });

  group('AttentionEvent', () {
    test('roundtrips known event fields and helper kinds', () {
      final event = AttentionEvent.fromJson({
        'id': 'evt-1',
        'cursor': 88,
        'revision': 3,
        'presentationRevision': 2,
        'presentationStage': 'immediate',
        'kind': 'permission-required',
        'state': 'active',
        'severity': 'action-required',
        'dedupeKey': 'dedupe-1',
        'createdAt': 1710000000000,
        'updatedAt': 1710000001000,
        'agent': 'opencode',
        'sessionId': 'session-1',
        'sessionTitle': 'Named session',
        'requestId': 'req-1',
        'turnId': 'turn-1',
        'goalKey': 'goal-1',
        'title': 'Need approval',
        'summary': 'A file needs permission',
        'action': {
          'kind': 'open-session',
          'tool': 'opencode',
          'sessionId': 'session-1',
        },
        'unknownField': true,
      });
      expect(event.id, 'evt-1');
      expect(event.isPermissionRequired, isTrue);
      expect(event.isKnownKind, isTrue);
      expect(event.action.isOpenSession, isTrue);
      expect(event.sessionTitle, 'Named session');
      expect(event.toJson()['unknownField'], isTrue);
      expect(event.toJson()['goalKey'], 'goal-1');
      expect(event.toJson()['sessionTitle'], 'Named session');
      expect(event.toJson()['presentationStage'], 'immediate');
      final actionJson = event.toJson()['action'] as Map<String, dynamic>;
      expect(actionJson['kind'], 'open-session');
    });

    test('preserves future kind and still roundtrips', () {
      final event = AttentionEvent.fromJson({
        'id': 'evt-future',
        'cursor': 0,
        'revision': 0,
        'presentationRevision': 0,
        'kind': 'future-kind',
        'state': 'resolved',
        'severity': 'maintenance',
        'dedupeKey': 'dedupe-future',
        'createdAt': 10,
        'updatedAt': 20,
        'title': 'Future thing',
        'action': {'kind': 'unknown-action'},
      });
      expect(event.kind, 'future-kind');
      expect(event.isKnownKind, isFalse);
      expect(event.action.kind, 'unknown-action');
      expect(event.action.isKnownKind, isFalse);
      expect(event.toJson()['kind'], 'future-kind');
      final actionJson = event.toJson()['action'] as Map<String, dynamic>;
      expect(actionJson['kind'], 'unknown-action');
      expect(event.toJson()['resolvedAt'], isNull);
      expect(event.sessionTitle, isNull);
    });
  });

  group('AttentionBulkDismissResponse', () {
    test('parses structured accepted, stale, and not-found results', () {
      final response = AttentionBulkDismissResponse.fromJson({
        'ok': true,
        'accepted': [
          {'eventId': 'accepted', 'revision': 2, 'dismissedAt': 10},
        ],
        'stale': [
          {'eventId': 'stale', 'revision': 1, 'currentRevision': 3},
        ],
        'notFound': [
          {'eventId': 'missing', 'revision': 1},
        ],
      });

      expect(attentionBulkDismissMax, 2000);
      expect(response.accepted.single.eventId, 'accepted');
      expect(response.accepted.single.dismissedAt, 10);
      expect(response.stale.single.currentRevision, 3);
      expect(response.notFound.single.toJson(), {
        'eventId': 'missing',
        'revision': 1,
      });
    });
  });

  group('AttentionEventView', () {
    test('parses read/dismiss cursor fields', () {
      final view = AttentionEventView.fromJson({
        'id': 'evt-view',
        'cursor': 1,
        'revision': 1,
        'presentationRevision': 1,
        'kind': 'run-finished',
        'state': 'resolved',
        'severity': 'informational',
        'dedupeKey': 'dedupe-view',
        'createdAt': 1,
        'updatedAt': 2,
        'title': 'Run finished',
        'action': {'kind': 'open-attention-inbox'},
        'readAt': 3,
        'dismissedAt': 4,
      });
      expect(view.readAt, 3);
      expect(view.dismissedAt, 4);
      expect(view.toJson()['readAt'], 3);
      expect(view.toJson()['dismissedAt'], 4);
    });
  });

  group('AttentionEventsPage', () {
    test('parses page metadata and tolerates missing ok wrapper', () {
      final page = AttentionEventsPage.fromJson({
        'events': [
          {
            'id': 'evt-1',
            'cursor': 2,
            'revision': 1,
            'presentationRevision': 1,
            'kind': 'run-failed',
            'state': 'resolved',
            'severity': 'maintenance',
            'dedupeKey': 'dedupe-run',
            'createdAt': 1,
            'updatedAt': 2,
            'title': 'Run failed',
            'action': {'kind': 'open-attention-inbox'},
            'readAt': 5,
          },
        ],
        'cursor': 2,
        'reset': true,
        'hasMore': false,
      });
      expect(page.cursor, 2);
      expect(page.reset, isTrue);
      expect(page.hasMore, isFalse);
      expect(page.events, hasLength(1));
      expect(page.events.first.isRunFailed, isTrue);
      expect(page.events.first.toJson()['readAt'], 5);
    });

    test('serializes page shape', () {
      const page = AttentionEventsPage(
        events: [
          AttentionEventView(
            id: 'evt-1',
            cursor: 9,
            revision: 1,
            presentationRevision: 1,
            kind: 'question-required',
            state: 'active',
            severity: 'informational',
            dedupeKey: 'dedupe-q',
            createdAt: 1,
            updatedAt: 2,
            title: 'Question',
            action: AttentionEventAction(kind: 'open-attention-inbox'),
            readAt: 3,
          ),
        ],
        cursor: 9,
        reset: false,
        hasMore: false,
      );
      final json = page.toJson();
      expect(json['cursor'], 9);
      expect(json['events'], isA<List<dynamic>>());
      expect((json['events'] as List).first, isA<Map<String, dynamic>>());
    });

    test('parses optional baselineThroughCursor', () {
      final page = AttentionEventsPage.fromJson({
        'events': [
          {
            'id': 'evt-baseline',
            'cursor': 4,
            'revision': 1,
            'presentationRevision': 1,
            'kind': 'run-finished',
            'state': 'active',
            'severity': 'informational',
            'dedupeKey': 'dedupe-baseline',
            'createdAt': 1,
            'updatedAt': 2,
            'title': 'Historical floor',
            'action': {'kind': 'open-attention-inbox'},
          },
        ],
        'cursor': 4,
        'reset': false,
        'hasMore': true,
        'baselineThroughCursor': 2,
      });
      expect(page.baselineThroughCursor, 2);
    });

    test('omits baselineThroughCursor when absent', () {
      final page = AttentionEventsPage.fromJson({
        'events': [
          {
            'id': 'evt-legacy',
            'cursor': 7,
            'revision': 1,
            'presentationRevision': 1,
            'kind': 'run-finished',
            'state': 'active',
            'severity': 'informational',
            'dedupeKey': 'dedupe-legacy',
            'createdAt': 1,
            'updatedAt': 2,
            'title': 'legacy',
            'action': {'kind': 'open-attention-inbox'},
          },
        ],
        'cursor': 7,
        'reset': false,
        'hasMore': false,
      });
      expect(page.baselineThroughCursor, isNull);
    });
  });
}
