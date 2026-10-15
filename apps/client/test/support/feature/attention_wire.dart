// The attention feed of one fake broker, and the notification verbs over a
// running App, for F07 feature tests.
//
// `AttentionDesk` is the broker's durable event log: events get cursors, a
// change to an event gets a new cursor and revision, every page names the
// baseline (the head when it was read), and read/dismiss state is kept per
// client, exactly as the real attention store answers `GET
// /api/attention-events` and the ack, dismiss and dismiss-batch posts. It
// replaces `FakeBroker.publishAttention`'s simpler poll for the broker it is
// installed on.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'app_driver.dart';
import 'fake_broker.dart';
import 'fake_os_notifications.dart';

/// The durable attention events of one broker.
class AttentionDesk {
  /// Installs the attention routes on [broker].
  AttentionDesk(this.broker) {
    broker.routes.add(_route);
  }

  /// The broker this log belongs to.
  final FakeBroker broker;

  /// Every event, oldest first.
  final List<Map<String, Object?>> events = [];

  int _cursor = 0;
  int _ids = 0;
  final List<Completer<void>> _waiters = [];

  /// Per client: event id -> when it was read there.
  final Map<String, Map<String, int>> _read = {};

  /// Per client: event id -> (when, revision) it was dismissed there.
  final Map<String, Map<String, (int, int)>> _dismissed = {};

  /// Event ids the app acknowledged (read), in order received.
  final List<String> acknowledged = [];

  /// Event ids the app dismissed one by one, in order received.
  final List<String> dismissedSingly = [];

  /// Each dismiss-batch the app posted, as its (id, revision) pairs.
  final List<List<(String, int)>> batches = [];

  /// Number of poll requests answered.
  int polls = 0;

  /// Polls that asked for an answer at once (no long-poll wait): the feed's
  /// first poll and every refetch.
  int immediatePolls = 0;

  /// Poll `after` values received, in order.
  final List<int?> pollCursors = [];

  /// Answer polls with this status instead of pages (401 for a rejected
  /// token), until cleared.
  int? pollStatus;

  /// The head cursor.
  int get head => _cursor;

  /// Publishes an event and wakes the app's long poll.
  ///
  /// [kind] is the broker kind (`run-finished`, `permission-required`, ...).
  /// A session event names its session through [sessionId] and shows
  /// [sessionTitle] in a notification body.
  Map<String, Object?> publish({
    String kind = 'run-finished',
    String agent = 'codex',
    String? sessionId,
    String? sessionTitle,
    String? title,
    String? summary,
    String? requestId,
    String severity = 'informational',
    String? dedupeKey,
    String? actionKind,
    int? createdAt,
    Map<String, Object?> extra = const {},
  }) {
    final cursor = ++_cursor;
    final now = createdAt ?? DateTime.now().millisecondsSinceEpoch;
    final id = '${broker.baseUri.host}-${++_ids}';
    final event = <String, Object?>{
      'id': id,
      'cursor': cursor,
      'revision': 1,
      'presentationRevision': 1,
      'kind': kind,
      'state': 'active',
      'severity': severity,
      'dedupeKey': dedupeKey ?? '$kind:$agent:$sessionId:$requestId:$id',
      'createdAt': now,
      'updatedAt': now,
      'agent': agent,
      'sessionId': ?sessionId,
      'sessionTitle': ?sessionTitle,
      'requestId': ?requestId,
      'title': title ?? kind,
      'summary': ?summary,
      'action': {
        'kind':
            actionKind ??
            (sessionId == null ? 'open-attention-inbox' : 'open-session'),
        if (sessionId != null) ...{'tool': agent, 'sessionId': sessionId},
      },
      ...extra,
    };
    events.add(event);
    _wake();
    return event;
  }

  /// The event with [id].
  Map<String, Object?> event(String id) =>
      events.firstWhere((event) => event['id'] == id);

  /// Moves [id] to a new revision with [changes] (a new cursor).
  void change(String id, Map<String, Object?> changes) {
    final target = event(id);
    target
      ..addAll(changes)
      ..['cursor'] = ++_cursor
      ..['revision'] = (target['revision']! as int) + 1
      ..['updatedAt'] = DateTime.now().millisecondsSinceEpoch;
    _wake();
  }

  /// The request behind [id] was answered: the event resolves.
  void resolve(String id) => change(id, {
    'state': 'resolved',
    'resolvedAt': DateTime.now().millisecondsSinceEpoch,
  });

  /// Another device handled [id] (read it there).
  void seenElsewhere(String id) =>
      change(id, {'seenAt': DateTime.now().millisecondsSinceEpoch});

  /// Presents [id] again (the broker's reminder): a new presentation
  /// revision.
  void renew(String id) => change(id, {
    'presentationRevision': (event(id)['presentationRevision']! as int) + 1,
  });

  void _wake() {
    for (final waiter in List.of(_waiters)) {
      if (!waiter.isCompleted) waiter.complete();
    }
    _waiters.clear();
  }

  Map<String, Object?> _view(Map<String, Object?> event, String? clientId) {
    final id = event['id']! as String;
    final readAt = _read[clientId]?[id];
    final dismissed = _dismissed[clientId]?[id];
    final applies = dismissed != null && dismissed.$2 == event['revision'];
    return {
      ...event,
      'readAt': ?readAt,
      if (applies) 'dismissedAt': dismissed.$1,
    };
  }

  Future<FakeBrokerResponse?> _route(FakeBrokerRequest request) async {
    final path = request.path;
    if (request.method == 'GET' && path == '/api/attention-events') {
      return _poll(request);
    }
    final body = request.body is Map
        ? (request.body! as Map).cast<String, Object?>()
        : const <String, Object?>{};
    final clientId = body['clientId'] as String?;
    final ack = RegExp(r'^/api/attention-events/([^/]+)/ack$').firstMatch(path);
    if (request.method == 'POST' && ack != null) {
      final id = Uri.decodeComponent(ack.group(1)!);
      acknowledged.add(id);
      _read.putIfAbsent(clientId ?? '', () => {})[id] =
          DateTime.now().millisecondsSinceEpoch;
      return const FakeBrokerResponse(200, {'ok': true});
    }
    final dismiss = RegExp(
      r'^/api/attention-events/([^/]+)/dismiss$',
    ).firstMatch(path);
    if (request.method == 'POST' && dismiss != null) {
      final id = Uri.decodeComponent(dismiss.group(1)!);
      dismissedSingly.add(id);
      _dismissed.putIfAbsent(clientId ?? '', () => {})[id] = (
        DateTime.now().millisecondsSinceEpoch,
        event(id)['revision']! as int,
      );
      return const FakeBrokerResponse(200, {'ok': true});
    }
    if (request.method == 'POST' &&
        path == '/api/attention-events/dismiss-batch') {
      final items = [
        for (final item in (body['events'] as List? ?? const []))
          (
            (item as Map)['eventId']! as String,
            (item['revision']! as num).toInt(),
          ),
      ];
      batches.add(items);
      final accepted = <Map<String, Object?>>[];
      final stale = <Map<String, Object?>>[];
      for (final (id, revision) in items) {
        final current = event(id)['revision']! as int;
        if (current == revision) {
          final at = DateTime.now().millisecondsSinceEpoch;
          _dismissed.putIfAbsent(clientId ?? '', () => {})[id] = (
            at,
            revision,
          );
          accepted.add({
            'eventId': id,
            'revision': revision,
            'dismissedAt': at,
          });
        } else {
          stale.add({
            'eventId': id,
            'revision': revision,
            'currentRevision': current,
          });
        }
      }
      return FakeBrokerResponse(200, {
        'ok': true,
        'accepted': accepted,
        'stale': stale,
        'notFound': const <Object?>[],
      });
    }
    return null;
  }

  Future<FakeBrokerResponse> _poll(FakeBrokerRequest request) async {
    final params = request.uri.queryParameters;
    final clientId = params['clientId'];
    final after = int.tryParse(params['after'] ?? '');
    final limit = int.tryParse(params['limit'] ?? '') ?? 100;
    final wait = (int.tryParse(params['waitMs'] ?? '') ?? 0) > 0;
    polls += 1;
    if (!wait) immediatePolls += 1;
    pollCursors.add(after);
    final status = pollStatus;
    if (status != null) {
      return FakeBrokerResponse.error(status, 'AUTH_REQUIRED', 'refused');
    }
    while (true) {
      final candidates = [
        for (final event in events)
          if (after == null || (event['cursor']! as int) > after) event,
      ]..sort((a, b) => (a['cursor']! as int).compareTo(b['cursor']! as int));
      if (candidates.isNotEmpty || !wait) {
        final page = candidates.take(limit).toList();
        return FakeBrokerResponse(200, {
          'ok': true,
          'events': [for (final event in page) _view(event, clientId)],
          'cursor': page.isEmpty ? head : page.last['cursor'],
          'baselineThroughCursor': head,
          'reset': false,
          'hasMore': candidates.length > page.length,
        });
      }
      final waiter = Completer<void>();
      _waiters.add(waiter);
      await waiter.future;
    }
  }
}

/// Notification verbs and readings over a running App.
extension NotificationsDriver on AppDriver {
  /// Opens the Notifications inbox through the sidebar.
  Future<void> openInbox() => tapKey('sessions-workspace-attention');

  /// The inbox row of event [id].
  Finder inboxRow(Object id) => find.byKey(Key('attention-event-$id'));

  /// The text the row of [id] shows.
  String rowText(Object id) => textOfRow(inboxRow(id));

  /// Visible text inside [row].
  String textOfRow(Finder row) => [
    for (final element
        in find.descendant(of: row, matching: find.byType(RichText)).evaluate())
      (element.widget as RichText).text.toPlainText(),
  ].join(' | ');

  /// Whether the inbox row of [id] offers Mark read (the event is unread
  /// activity).
  bool rowUnread(Object id) => find
      .descendant(of: inboxRow(id), matching: find.text('Mark read'))
      .evaluate()
      .isNotEmpty;

  /// Dismisses [id] from its inbox row.
  Future<void> dismissRow(Object id) => tapKey('attention-dismiss-$id');

  /// The number the Notifications nav row carries (0 when it has no badge).
  int get badge {
    final row = find.byKey(const Key('sessions-workspace-attention'));
    if (row.evaluate().isEmpty) return -1;
    final digits = RegExp(r'^\d+\+?$');
    for (final element
        in find.descendant(of: row, matching: find.byType(Text)).evaluate()) {
      final data = (element.widget as Text).data;
      if (data != null && digits.hasMatch(data)) {
        return int.parse(data.replaceAll('+', ''));
      }
    }
    return 0;
  }

  /// The foreground banner, when one is showing.
  Finder get banner => find.byKey(const Key('foreground-attention-banner'));

  /// Waits for the OS to be showing [count] notifications.
  Future<void> waitForOs(FakeOsNotifications os, int count) => pumpUntil(
    () => os.active.length == count,
    reason: 'the OS shows $count notifications (shows ${os.activeTitles})',
  );
}
