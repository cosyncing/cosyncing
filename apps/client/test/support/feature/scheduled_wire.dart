// The broker's scheduled-sends REST surface for feature tests (F04d): one
// stateful fake in place of the five private schedule fakes the legacy tests
// carried. It keeps the rows, enforces the revision check and the cancel /
// remove distinction, and counts the reads, so a scenario can assert what the
// app asked and what the user then sees.
import 'dart:convert';

import 'composer_wire.dart';
import 'fake_broker.dart';

/// Schedules of one broker.
class ScheduleDesk {
  /// Serves `/api/schedules` of [broker].
  ScheduleDesk(this.broker) {
    broker.routes.add(_route);
  }

  /// The broker.
  final FakeBroker broker;

  /// Rows the broker holds, in broker order.
  final List<Map<String, Object?>> rows = [];

  /// `GET /api/schedules` reads answered or refused so far.
  int listCalls = 0;

  /// Answer every list read with this instead of the rows (a failure).
  FakeBrokerResponse? listFailure;

  /// Answer the next mutation (create, edit, action, delete) with this.
  FakeBrokerResponse? mutationFailure;

  /// Schedules created through the API, oldest first.
  final List<Map<String, Object?>> created = [];

  /// Edit bodies received, oldest first.
  final List<Map<String, Object?>> edits = [];

  /// Lifecycle action bodies received (pause, resume, run-now).
  final List<Map<String, Object?>> actions = [];

  /// Ids deleted through the API, oldest first.
  final List<String> deletes = [];

  var _serial = 0;
  int _clock = 1760000000000;

  /// Adds a stored one-shot message to [sessionId], due in [dueIn].
  Map<String, Object?> addMessage(
    String text, {
    String sessionId = 's1',
    String tool = 'codex',
    String state = 'scheduled',
    Duration dueIn = const Duration(hours: 2),
    String? id,
    String? lastError,
  }) {
    final row = <String, Object?>{
      'id': id ?? 'sched-${++_serial}',
      'revision': 1,
      'kind': 'message',
      'tool': tool,
      'sessionId': sessionId,
      'sessionTitle': 'Fix login',
      'text': text,
      'at': DateTime.now().add(dueIn).millisecondsSinceEpoch,
      'state': state,
      'createdAt': _clock,
      'updatedAt': _clock,
      'lastError': ?lastError,
    };
    rows.add(row);
    return row;
  }

  /// The row with [id].
  Map<String, Object?> row(String id) => rows.firstWhere((r) => r['id'] == id);

  /// The broker delivers [id] at its time: the row is delivered and the
  /// prompt reaches the session through [desk].
  void deliver(String id, ComposerDesk desk) {
    final stored = row(id);
    _bump(stored, {'state': 'delivered', 'lastFiredAt': _clock});
    desk.echoPrompt(stored['text']! as String);
  }

  void _bump(Map<String, Object?> stored, Map<String, Object?> change) {
    stored
      ..addAll(change)
      ..['revision'] = (stored['revision']! as int) + 1
      ..['updatedAt'] = ++_clock;
  }

  FakeBrokerResponse _ok(Map<String, Object?> body) =>
      FakeBrokerResponse(200, {'ok': true, ...body});

  Future<FakeBrokerResponse?> _route(FakeBrokerRequest request) async {
    final path = request.path;
    if (path != '/api/schedules' && !path.startsWith('/api/schedules/')) {
      return null;
    }
    final method = request.method;
    if (method == 'GET' && path == '/api/schedules') {
      listCalls += 1;
      final failure = listFailure;
      if (failure != null) return failure;
      return _ok({'schedules': List.of(rows)});
    }
    final failure = mutationFailure;
    if (failure != null) {
      mutationFailure = null;
      return failure;
    }
    final body = request.body is Map
        ? (request.body! as Map).cast<String, Object?>()
        : const <String, Object?>{};
    if (method == 'POST' && path == '/api/schedules') {
      final row = <String, Object?>{
        'id': 'sched-${++_serial}',
        'revision': 1,
        'kind': body['kind'],
        'tool': body['tool'],
        'sessionId': ?body['sessionId'],
        'sessionTitle': ?body['sessionTitle'],
        'directory': ?body['directory'],
        'title': ?body['title'],
        'text': body['text'],
        'at': body['at'],
        'state': 'scheduled',
        'createdAt': ++_clock,
        'updatedAt': _clock,
      };
      rows.add(row);
      created.add(body);
      return _ok({'schedule': row});
    }
    final id = Uri.decodeComponent(path.split('/')[3]);
    final index = rows.indexWhere((r) => r['id'] == id);
    if (index < 0) {
      return FakeBrokerResponse.error(404, 'SCHEDULE_NOT_FOUND', 'No such id');
    }
    final stored = rows[index];
    if (method == 'PATCH') {
      edits.add(body);
      if (body['expectedRevision'] != stored['revision']) {
        return FakeBrokerResponse.error(
          409,
          'SCHEDULE_STALE',
          'The schedule changed.',
        );
      }
      _bump(stored, {
        if (body.containsKey('text')) 'text': body['text'],
        if (body.containsKey('at')) 'at': body['at'],
      });
      return _ok({'schedule': stored});
    }
    if (method == 'DELETE') {
      deletes.add(id);
      final state = stored['state'];
      if (state == 'scheduled' || state == 'paused') {
        _bump(stored, {'state': 'canceled'});
        return _ok({'schedule': stored});
      }
      rows.removeAt(index);
      return _ok({'removed': true});
    }
    if (method == 'POST' && path.endsWith('/actions')) {
      if (body['expectedRevision'] != stored['revision']) {
        return FakeBrokerResponse.error(
          409,
          'SCHEDULE_STALE',
          'The schedule changed.',
        );
      }
      actions.add(body);
      final state = switch (body['action']) {
        'pause' => 'paused',
        'resume' => 'scheduled',
        'run-now' => 'delivered',
        _ => null,
      };
      if (state == null) {
        return FakeBrokerResponse.error(400, 'UNSUPPORTED', jsonEncode(body));
      }
      _bump(stored, {'state': state});
      return _ok({'schedule': stored});
    }
    return null;
  }
}
