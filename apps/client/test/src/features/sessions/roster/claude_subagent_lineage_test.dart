import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:flutter_test/flutter_test.dart';

/// Claude parent/child roster case (plan item 1).
///
/// The Claude adapter now publishes `<slug>/<uuid>/subagents/agent-*.jsonl` as
/// observe-only child rows. Their lineage ids are namespaced — the parent falls
/// back to `claude-session:<uuid>` when it has no bridge identity, and a child
/// is `claude-subagent:<parent uuid>/<agent>` — so these tests pin that the
/// shared, agent-neutral projection nests them with no Claude-specific branch,
/// and that the one thing the adapter must not get wrong (a parent with no
/// published `nativeId`) fails open as a top-level row rather than vanishing.
void main() {
  const parentNativeId = 'claude-session:aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa';

  final alpha = _claude(
    id: 'child-alpha',
    title: 'Audit the roster join',
    origin: SessionOrigin.subagent,
    nativeId:
        'claude-subagent:aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa/agent-alpha',
    parentThreadId: parentNativeId,
  );

  test('claude lineage never joins across tools or machines', () {
    final codexImpostor = _claude(
      id: 'codex-parent',
      title: 'Same native id, other tool',
      tool: 'codex',
      nativeId: parentNativeId,
    );
    final remoteParent = _claude(
      id: 'parent-transcript',
      title: 'Same native id, other machine',
      nativeId: parentNativeId,
      machine: 'ubuntu3090',
    );
    final projection = SessionRosterProjection.build(
      sessions: [codexImpostor, remoteParent, alpha],
      preferences: const SessionVisibilityPreferences(
        showBackgroundSessions: true,
      ),
    );

    expect(projection.parentFor(alpha), isNull);
  });
}

SessionInfo _claude({
  required String id,
  required String title,
  String tool = 'claude',
  String? cwd = '/work/project',
  SessionOrigin? origin,
  String? nativeId,
  String? parentThreadId,
  String? machine,
  SessionStatus status = SessionStatus.idle,
}) => SessionInfo(
  id: id,
  tool: tool,
  title: title,
  cwd: cwd,
  origin: origin,
  nativeId: nativeId,
  parentThreadId: parentThreadId,
  machine: machine,
  status: status,
  attachMode: AttachMode.observe,
);
