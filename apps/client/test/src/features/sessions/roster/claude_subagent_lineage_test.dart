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

  final parent = _claude(
    id: 'parent-transcript',
    title: 'Roster subagent parent',
    nativeId: parentNativeId,
  );
  final alpha = _claude(
    id: 'child-alpha',
    title: 'Audit the roster join',
    origin: SessionOrigin.subagent,
    nativeId:
        'claude-subagent:aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa/agent-alpha',
    parentThreadId: parentNativeId,
  );
  final beta = _claude(
    id: 'child-beta',
    title: 'code-reviewer',
    origin: SessionOrigin.subagent,
    nativeId: 'claude-subagent:aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa/agent-beta',
    parentThreadId: parentNativeId,
  );

  test(
    'claude subagents stay hidden by default and roll up onto the parent',
    () {
      final projection = SessionRosterProjection.build(
        sessions: [parent, alpha, beta],
        preferences: const SessionVisibilityPreferences(),
      );

      expect(
        projection.visibleSessions.map((session) => session.id),
        ['parent-transcript'],
      );
      expect(projection.childCountFor(parent), 2);
    },
  );

  test(
    'showBackgroundSessions nests both claude children under the parent',
    () {
      final projection = SessionRosterProjection.build(
        sessions: [parent, alpha, beta],
        preferences: const SessionVisibilityPreferences(
          showBackgroundSessions: true,
        ),
        childExpansion: {
          sessionCompositeRosterKey(parent): SessionChildExpansion.expanded,
        },
      );

      expect(
        projection.visibleSessions.map((session) => session.id),
        ['parent-transcript', 'child-alpha', 'child-beta'],
      );
      expect(projection.parentFor(alpha)?.id, 'parent-transcript');
      expect(projection.parentFor(beta)?.id, 'parent-transcript');
    },
  );

  test('a working claude subagent lifts the collapsed parent row', () {
    final workingChild = _claude(
      id: 'child-alpha',
      title: 'Audit the roster join',
      origin: SessionOrigin.subagent,
      nativeId:
          'claude-subagent:aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa/agent-alpha',
      parentThreadId: parentNativeId,
      status: SessionStatus.working,
    );
    final projection = SessionRosterProjection.build(
      sessions: [parent, workingChild],
      preferences: const SessionVisibilityPreferences(),
    );

    expect(projection.effectiveStatusFor(parent), SessionStatus.working);
  });

  test('a parent that published no nativeId leaves its child top-level', () {
    // The adapter regression this guards: a Claude parent only publishes a
    // native identity when it actually has children. Drop it and the child
    // does not disappear — it fails open as its own row, which is the visible
    // symptom to look for.
    final orphanParent = _claude(
      id: 'parent-transcript',
      title: 'Roster subagent parent',
    );
    final projection = SessionRosterProjection.build(
      sessions: [orphanParent, alpha],
      preferences: const SessionVisibilityPreferences(
        showBackgroundSessions: true,
      ),
    );

    expect(projection.parentFor(alpha), isNull);
    expect(projection.childCountFor(orphanParent), 0);
    expect(
      projection.visibleSessions.map((session) => session.id),
      containsAll(<String>['parent-transcript', 'child-alpha']),
    );
  });

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

  test('two claude parents keep their own children', () {
    const otherNativeId = 'claude-bridge:bridgefixture';
    final bridgeParent = _claude(
      id: 'bridge-transcript',
      title: 'Bridged parent',
      nativeId: otherNativeId,
    );
    final bridgeChild = _claude(
      id: 'child-bridgekid',
      title: 'Bridge child',
      origin: SessionOrigin.subagent,
      nativeId:
          'claude-subagent:bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb/agent-bridgekid',
      parentThreadId: otherNativeId,
    );
    final projection = SessionRosterProjection.build(
      sessions: [parent, alpha, beta, bridgeParent, bridgeChild],
      preferences: const SessionVisibilityPreferences(
        showBackgroundSessions: true,
      ),
    );

    expect(projection.parentFor(alpha)?.id, 'parent-transcript');
    expect(projection.parentFor(bridgeChild)?.id, 'bridge-transcript');
    expect(projection.childCountFor(parent), 2);
    expect(projection.childCountFor(bridgeParent), 1);
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
