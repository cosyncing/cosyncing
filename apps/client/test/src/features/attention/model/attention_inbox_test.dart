import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('groups action, maintenance, and resolved events in priority order', () {
    final entries = [
      _entry('resolved', 'run-finished', state: 'resolved', updatedAt: 5),
      _entry('maintenance', 'runtime-update-ready', updatedAt: 10),
      _entry('question', 'question-required', updatedAt: 8),
      _entry('failed', 'run-failed', updatedAt: 9),
      _entry('future', 'future-kind', updatedAt: 11),
    ];

    final inbox = AttentionInboxSections.fromEntries(entries);

    expect(inbox.actionRequired.map((entry) => entry.event.id), [
      'failed',
      'question',
    ]);
    expect(inbox.maintenance.map((entry) => entry.event.id), [
      'future',
      'maintenance',
    ]);
    expect(inbox.resolved.map((entry) => entry.event.id), ['resolved']);
  });

  test('dismissed events are omitted and unknown kinds remain visible', () {
    final inbox = AttentionInboxSections.fromEntries([
      _entry('dismissed', 'question-required', dismissedAt: 12),
      _entry('unknown', 'new-kind'),
    ]);

    expect(inbox.all.map((entry) => entry.event.id), ['unknown']);
    expect(inbox.unreadCount, 1);
  });

  test('broker or local read state removes event from unread count', () {
    final inbox = AttentionInboxSections.fromEntries([
      _entry('unread', 'run-finished'),
      _entry('read', 'run-finished', readAt: 20),
    ]);

    expect(inbox.unreadCount, 1);
  });

  test('critical severity remains forward-compatible action-required', () {
    final inbox = AttentionInboxSections.fromEntries([
      _entry('future-critical', 'future-kind', severity: 'critical'),
    ]);

    expect(inbox.actionRequired.single.event.id, 'future-critical');
    expect(inbox.maintenance, isEmpty);
  });

  test(
    'resolved device/security stay history and pairing fallback is informational',
    () {
      final inbox = AttentionInboxSections.fromEntries([
        _entry('paired', 'device-paired', state: 'resolved'),
        _entry('paired-active', 'device-paired', updatedAt: 3),
        _entry(
          'revoked',
          'security-alert',
          state: 'resolved',
          updatedAt: 2,
          severity: 'action-required',
        ),
      ]);

      expect(inbox.actionRequired, isEmpty);
      expect(inbox.maintenance.single.event.id, 'paired-active');
      expect(inbox.resolved.map((entry) => entry.event.id), [
        'revoked',
        'paired',
      ]);
    },
  );

  test(
    'historical baseline rows remain visible but do not count as unread',
    () {
      final inbox = AttentionInboxSections.fromEntries([
        _entry('historical', 'run-finished', historicalBaseline: true),
        _entry('active', 'run-finished'),
      ]);

      expect(
        inbox.all.map((entry) => entry.event.id),
        unorderedEquals(['active', 'historical']),
      );
      expect(
        inbox.all
            .singleWhere((entry) => entry.event.id == 'historical')
            .isUnread,
        isFalse,
      );
      expect(inbox.unreadCount, 1);
    },
  );

  test('scheduled outcomes remain durable resolved history rows', () {
    final inbox = AttentionInboxSections.fromEntries([
      _entry('sent', 'scheduled-send', state: 'resolved', updatedAt: 2),
      _entry(
        'failed',
        'scheduled-send-failed',
        state: 'resolved',
        updatedAt: 3,
        severity: 'action-required',
      ),
    ]);

    expect(inbox.actionRequired, isEmpty);
    expect(inbox.resolved.map((entry) => entry.event.id), ['failed', 'sent']);
  });
}

AttentionInboxEntry _entry(
  String id,
  String kind, {
  String state = 'active',
  int updatedAt = 1,
  int? readAt,
  int? dismissedAt,
  bool historicalBaseline = false,
  String severity = 'informational',
}) {
  return AttentionInboxEntry(
    profile: BrokerProfile(
      id: 'profile',
      displayName: 'Workstation',
      baseUri: Uri.parse('http://127.0.0.1:7734'),
      createdAt: DateTime(2026),
    ),
    event: AttentionEventView(
      id: id,
      cursor: 1,
      revision: 1,
      presentationRevision: 1,
      kind: kind,
      state: state,
      severity: severity,
      dedupeKey: id,
      createdAt: 1,
      updatedAt: updatedAt,
      title: id,
      historicalBaseline: historicalBaseline,
      action: const AttentionEventAction(kind: 'open-attention-inbox'),
      readAt: readAt,
      dismissedAt: dismissedAt,
    ),
  );
}
