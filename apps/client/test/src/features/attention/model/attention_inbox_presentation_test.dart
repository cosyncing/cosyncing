import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox_presentation.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('pending projection preserves other events for the same session', () {
    final request = entry('request', 'question-required', read: true);
    final completion = entry('completion', 'run-finished');
    final older = entry('older', 'run-finished', read: true);
    final maintenance = entry('maintenance', 'runtime-update-ready');
    final future = entry('future', 'new-kind');
    final urgent = entry('urgent', 'new-kind', severity: 'critical');
    final failed = entry('failed', 'run-failed');
    final resolved = entry('answered', 'question-required', resolved: true);
    final groups = AttentionInboxPresentation(
      AttentionInboxSections.fromEntries([
        request,
        completion,
        older,
        maintenance,
        future,
        urgent,
        failed,
        resolved,
      ]),
    );
    expect(groups.requests, [request]);
    expect(groups.completions, [completion]);
    expect(groups.urgent, containsAll([urgent, failed]));
    expect(
      groups.activity,
      containsAll([older, maintenance, future, resolved]),
    );
    expect(groups.pendingCount, 4);
    expect(
      <dynamic>{
        ...groups.requests,
        ...groups.completions,
        ...groups.urgent,
        ...groups.activity,
      }.length,
      8,
    );
  });

  test('same event id from separate brokers remains independently visible', () {
    final first = entry('id', 'question-required');
    final second = entry('id', 'runtime-update-ready', profile: 'second');
    final groups = AttentionInboxPresentation(
      AttentionInboxSections.fromEntries([first, second]),
    );
    expect(groups.requests, [first]);
    expect(groups.activity, [second]);
  });
}

AttentionInboxEntry entry(
  String id,
  String kind, {
  bool read = false,
  bool resolved = false,
  String severity = 'informational',
  String profile = 'first',
}) => AttentionInboxEntry(
  profile: BrokerProfile(
    id: profile,
    displayName: profile,
    baseUri: Uri.parse('http://localhost:17734'),
    createdAt: DateTime(2026),
  ),
  event: AttentionEventView(
    id: id,
    cursor: 1,
    revision: 1,
    presentationRevision: 1,
    kind: kind,
    state: resolved ? 'resolved' : 'active',
    severity: severity,
    dedupeKey: id,
    createdAt: 1,
    updatedAt: 1,
    title: id,
    readAt: read ? 1 : null,
    resolvedAt: resolved ? 1 : null,
    sessionId: 'same-session',
    action: const AttentionEventAction(kind: 'open-attention-inbox'),
  ),
);
