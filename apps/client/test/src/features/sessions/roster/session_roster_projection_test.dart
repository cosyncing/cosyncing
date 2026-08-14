import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final parent = _session(
    id: 'parent',
    title: 'Same title',
    nativeId: 'native-parent',
  );
  final childOne = _session(
    id: 'child-1',
    title: 'Same title',
    origin: SessionOrigin.subagent,
    nativeId: 'native-child-1',
    parentThreadId: 'native-parent',
  );
  final childTwo = _session(
    id: 'child-2',
    title: 'Same title',
    origin: SessionOrigin.subagent,
    nativeId: 'native-child-2',
    parentThreadId: 'native-parent',
  );
  final exec = _session(
    id: 'exec',
    title: 'Exec run',
    origin: SessionOrigin.exec,
  );
  final vscode = _session(
    id: 'vscode',
    title: 'IDE session',
    origin: SessionOrigin.vscode,
  );
  final future = _session(
    id: 'future',
    title: 'Future origin',
    origin: SessionOrigin.unknown,
  );

  test('defaults hide auto origins, show VS Code, and fail open', () {
    final projection = SessionRosterProjection.build(
      sessions: [parent, childOne, childTwo, exec, vscode, future],
      preferences: const SessionVisibilityPreferences(),
    );

    expect(
      projection.visibleSessions.map((session) => session.id),
      ['parent', 'vscode', 'future'],
    );
    expect(projection.childCountFor(parent), 2);
  });

  test('parent peek reveals both identical-title children by id', () {
    final projection = SessionRosterProjection.build(
      sessions: [parent, childOne, childTwo],
      preferences: const SessionVisibilityPreferences(),
      childExpansion: {
        sessionCompositeRosterKey(parent): SessionChildExpansion.expanded,
      },
    );

    expect(
      projection.visibleSessions.map((session) => session.id),
      ['parent', 'child-1', 'child-2'],
    );
    expect(projection.parentFor(childOne)?.id, 'parent');
    expect(projection.parentFor(childTwo)?.id, 'parent');
  });

  test('parent linkage never crosses tool identities', () {
    final otherToolParent = _session(
      id: 'other-parent',
      title: 'Other parent',
      tool: 'claude',
      nativeId: 'native-parent',
    );
    final projection = SessionRosterProjection.build(
      sessions: [otherToolParent, childOne],
      preferences: const SessionVisibilityPreferences(
        showBackgroundSessions: true,
      ),
    );

    expect(projection.parentFor(childOne), isNull);
  });

  test('global filters show background and can hide VS Code', () {
    final projection = SessionRosterProjection.build(
      sessions: [parent, childOne, exec, vscode],
      preferences: const SessionVisibilityPreferences(
        showBackgroundSessions: true,
        showVscodeSessions: false,
      ),
    );

    expect(
      projection.visibleSessions.map((session) => session.id),
      ['parent', 'child-1', 'exec'],
    );
  });

  test('groups OpenCode sub-agent sessions under their spawning parent', () {
    // The client stays agent-neutral: OpenCode produces the same origin +
    // parent/native id shape codex does (parentThreadId → the parent's nativeId),
    // so the shared projection nests OpenCode children exactly like codex ones.
    final ocParent = _session(
      id: 'ses_parent',
      title: 'Build the thing',
      tool: 'opencode',
      nativeId: 'ses_parent',
    );
    final ocChildOne = _session(
      id: 'ses_child1',
      title: 'Explore repo (@explore subagent)',
      tool: 'opencode',
      origin: SessionOrigin.subagent,
      nativeId: 'ses_child1',
      parentThreadId: 'ses_parent',
    );
    final ocChildTwo = _session(
      id: 'ses_child2',
      title: 'Research API (@general subagent)',
      tool: 'opencode',
      origin: SessionOrigin.subagent,
      nativeId: 'ses_child2',
      parentThreadId: 'ses_parent',
    );

    final collapsed = SessionRosterProjection.build(
      sessions: [ocParent, ocChildOne, ocChildTwo],
      preferences: const SessionVisibilityPreferences(),
    );
    // Children stay off the top level by default; the parent carries a count.
    expect(collapsed.visibleSessions.map((s) => s.id), ['ses_parent']);
    expect(collapsed.childCountFor(ocParent), 2);

    final expanded = SessionRosterProjection.build(
      sessions: [ocParent, ocChildOne, ocChildTwo],
      preferences: const SessionVisibilityPreferences(),
      childExpansion: {
        sessionCompositeRosterKey(ocParent): SessionChildExpansion.expanded,
      },
    );
    expect(expanded.visibleSessions.map((s) => s.id), [
      'ses_parent',
      'ses_child1',
      'ses_child2',
    ]);
    expect(expanded.parentFor(ocChildOne)?.id, 'ses_parent');
    expect(expanded.parentFor(ocChildTwo)?.id, 'ses_parent');
  });

  test('child peek identity never crosses machines', () {
    final parentA = _session(
      id: 'parent',
      title: 'Parent A',
      machine: 'host-a',
      nativeId: 'native-parent',
    );
    final parentB = _session(
      id: 'parent',
      title: 'Parent B',
      machine: 'host-b',
      nativeId: 'native-parent',
    );
    final childA = _session(
      id: 'child',
      title: 'Child A',
      machine: 'host-a',
      origin: SessionOrigin.subagent,
      nativeId: 'native-child',
      parentThreadId: 'native-parent',
    );
    final childB = _session(
      id: 'child',
      title: 'Child B',
      machine: 'host-b',
      origin: SessionOrigin.subagent,
      nativeId: 'native-child',
      parentThreadId: 'native-parent',
    );

    final projection = SessionRosterProjection.build(
      sessions: [parentA, parentB, childA, childB],
      preferences: const SessionVisibilityPreferences(),
      childExpansion: {
        sessionCompositeRosterKey(parentA): SessionChildExpansion.expanded,
      },
    );
    final visible = projection.visibleSessions
        .map(sessionCompositeRosterKey)
        .toSet();

    expect(visible, contains(sessionCompositeRosterKey(childA)));
    expect(visible, isNot(contains(sessionCompositeRosterKey(childB))));
  });

  test('keeps an orphaned sub-agent visible at top level', () {
    // Parent pruned / never discovered: the child names a parent the roster
    // does not contain, so no toggle can reveal it. It must not vanish — it is
    // surfaced at top level regardless of the background-origin filter.
    final orphan = _session(
      id: 'ses_orphan',
      title: 'Search files (@explore subagent)',
      tool: 'opencode',
      origin: SessionOrigin.subagent,
      nativeId: 'ses_orphan',
      parentThreadId: 'ses_missing_parent',
    );

    final projection = SessionRosterProjection.build(
      sessions: [orphan],
      preferences: const SessionVisibilityPreferences(),
    );

    expect(projection.visibleSessions.map((s) => s.id), ['ses_orphan']);
    expect(projection.parentFor(orphan), isNull);
    expect(projection.childCountFor(orphan), 0);
  });

  test('groups by real cwd and keeps projectName display-only', () {
    final aliased = _session(
      id: 'aliased',
      title: 'A',
      cwd: '/work/real-project',
      projectName: 'Friendly project',
    );
    final sameDirectory = _session(
      id: 'same-cwd',
      title: 'B',
      cwd: '/work/real-project',
    );
    final noDirectory = _session(id: 'none', title: 'C', cwd: null);
    final projection = SessionRosterProjection.build(
      sessions: [aliased, sameDirectory, noDirectory],
      preferences: const SessionVisibilityPreferences(),
    );

    expect(projection.groups, hasLength(2));
    expect(projection.groups.first.label, 'Friendly project');
    expect(projection.groups.first.cwd, '/work/real-project');
    expect(projection.groups.first.sessions, hasLength(2));
    expect(projection.groups.last.cwd, isNull);
  });

  test('filters by query, status, agent, and activity age', () {
    final now = DateTime(2026, 7, 22, 12);
    final recent = _session(
      id: 'recent',
      title: 'Implement roster',
      projectName: 'Cosyncing',
      status: SessionStatus.working,
      updatedAt: now.subtract(const Duration(hours: 2)).millisecondsSinceEpoch,
    );
    final old = _session(
      id: 'old',
      title: 'Archived task',
      tool: 'claude',
      updatedAt: now.subtract(const Duration(days: 45)).millisecondsSinceEpoch,
    );

    SessionRosterProjection project(SessionRosterFilters filters) =>
        SessionRosterProjection.build(
          sessions: [recent, old],
          preferences: const SessionVisibilityPreferences(),
          filters: filters,
          now: now,
        );

    expect(
      project(const SessionRosterFilters(query: 'cosync')).visibleSessions,
      [recent],
    );
    expect(
      project(
        const SessionRosterFilters(
          status: SessionStatus.working,
          tool: 'codex',
        ),
      ).visibleSessions,
      [recent],
    );
    expect(
      project(
        const SessionRosterFilters(
          activity: SessionActivityWindow.older30Days,
        ),
      ).visibleSessions,
      [old],
    );
    expect(
      project(
        const SessionRosterFilters(olderThanDays: 30),
      ).visibleSessions,
      [old],
    );
  });

  test('project summary prioritizes needs-input and reports exact counts', () {
    final projection = SessionRosterProjection.build(
      sessions: [
        _session(id: 'needs', title: 'Needs', status: SessionStatus.needsInput),
        _session(
          id: 'working',
          title: 'Working',
          status: SessionStatus.working,
        ),
        _session(id: 'idle', title: 'Idle'),
      ],
      preferences: const SessionVisibilityPreferences(),
    );

    final group = projection.groups.single;
    expect(group.summaryStatus, SessionStatus.needsInput);
    expect(group.needsInputCount, 1);
    expect(group.workingCount, 1);
    expect(group.idleCount, 1);
  });

  test('same cwd on two machines remains two identity-safe groups', () {
    final first = _session(
      id: 'same',
      title: 'First',
      machine: 'host-a',
    );
    final second = _session(
      id: 'same',
      title: 'Second',
      machine: 'host-b',
    );
    final projection = SessionRosterProjection.build(
      sessions: [first, second],
      preferences: const SessionVisibilityPreferences(),
    );

    expect(projection.groups, hasLength(2));
    expect(
      sessionCompositeRosterKey(first),
      isNot(sessionCompositeRosterKey(second)),
    );
  });

  test('ready marker requires observed working to idle and clears on open', () {
    final tracker = ReadyToReviewTracker();
    final coldIdle = _session(id: 'ready', title: 'Ready');
    expect(tracker.observe([coldIdle]), isEmpty);

    final working = _session(
      id: 'ready',
      title: 'Ready',
      status: SessionStatus.working,
    );
    expect(tracker.observe([working]), isEmpty);
    final ready = tracker.observe([coldIdle]);
    expect(ready, {sessionCompositeRosterKey(coldIdle)});

    tracker.markOpened(coldIdle);
    expect(tracker.observe([coldIdle]), isEmpty);

    tracker.observe([working]);
    expect(tracker.observe([coldIdle]), isNotEmpty);
    expect(tracker.observe(const []), isEmpty);
    expect(tracker.observe([coldIdle]), isEmpty);
  });

  test('active and non-idle sessions never retain ready markers', () {
    final tracker = ReadyToReviewTracker();
    final working = _session(
      id: 'active',
      title: 'Active',
      status: SessionStatus.working,
    );
    final idle = _session(id: 'active', title: 'Active');
    tracker.observe([working]);
    expect(
      tracker.observe([idle], activeKey: sessionRosterKey(idle)),
      isEmpty,
    );
    expect(tracker.observe([working]), isEmpty);
  });

  // R1c. Before this lane the projection resolved parent links but returned
  // rows in raw broker order with no depth and no rollup, so a newer or working
  // child could sort above its idle parent and the parent pill read only its
  // own status. Every test below fails against that flat projection.
  group('lineage forest (R1c)', () {
    SessionInfo root(
      String id, {
      SessionStatus status = SessionStatus.idle,
      String tool = 'codex',
      String? machine,
      String? cwd = '/work/project',
    }) => _session(
      id: id,
      title: 'Root $id',
      tool: tool,
      machine: machine,
      cwd: cwd,
      nativeId: id,
      status: status,
    );

    SessionInfo child(
      String id,
      String parentId, {
      SessionStatus status = SessionStatus.idle,
      String tool = 'codex',
      String? machine,
      String? cwd = '/work/project',
    }) => _session(
      id: id,
      title: 'Child $id',
      tool: tool,
      machine: machine,
      cwd: cwd,
      origin: SessionOrigin.subagent,
      nativeId: id,
      parentThreadId: parentId,
      status: status,
    );

    const showChildren = SessionVisibilityPreferences(
      showBackgroundSessions: true,
    );

    SessionRosterProjection project(
      List<SessionInfo> sessions, {
      SessionVisibilityPreferences preferences = showChildren,
      Map<String, SessionChildExpansion> childExpansion = const {},
      Map<String, SessionChildExpansion> revealChildExpansion = const {},
      SessionRosterFilters filters = const SessionRosterFilters(),
      Set<String> readyToReviewKeys = const {},
    }) => SessionRosterProjection.build(
      sessions: sessions,
      preferences: preferences,
      childExpansion: childExpansion,
      revealChildExpansion: revealChildExpansion,
      filters: filters,
      readyToReviewKeys: readyToReviewKeys,
      now: DateTime(2026, 7, 27, 12),
    );

    test('a child arriving before its parent still renders after it', () {
      final projection = project([child('c1', 'p1'), root('p1')]);

      expect(projection.visibleSessions.map((s) => s.id), ['p1', 'c1']);
      expect(projection.visibleRows.map((row) => row.depth), [0, 1]);
      expect(
        projection.visibleRows.last.rootKey,
        projection.visibleRows[0].key,
      );
    });

    test('a newer working child never sorts above its idle parent', () {
      // Broker order is status then recency, so the working child leads.
      final projection = project([
        child('c1', 'p1', status: SessionStatus.working),
        root('p1'),
      ]);

      expect(projection.visibleSessions.map((s) => s.id), ['p1', 'c1']);
      expect(
        projection.visibleRows.first.effectiveStatus,
        SessionStatus.working,
      );
      // The canonical row is untouched: only the display value moved.
      expect(
        projection.allSessions.firstWhere((s) => s.id == 'p1').status,
        SessionStatus.idle,
      );
    });

    test('two descendant levels flatten at increasing depth', () {
      final projection = project([
        root('p1'),
        child('c1', 'p1'),
        child('g1', 'c1'),
        child('g2', 'c1'),
      ]);

      expect(projection.visibleSessions.map((s) => s.id), [
        'p1',
        'c1',
        'g1',
        'g2',
      ]);
      expect(projection.visibleRows.map((row) => row.depth), [0, 1, 2, 2]);
      final rootKey = projection.visibleRows.first.key;
      expect(
        projection.visibleRows.every((row) => row.rootKey == rootKey),
        isTrue,
      );
    });

    test('siblings keep broker order and stay stable across rebuilds', () {
      final sessions = [
        root('p1'),
        child('c2', 'p1'),
        child('c1', 'p1'),
        child('c3', 'p1'),
      ];
      final first = project(sessions);
      final second = project(sessions);

      expect(first.visibleSessions.map((s) => s.id), [
        'p1',
        'c2',
        'c1',
        'c3',
      ]);
      expect(
        second.visibleSessions.map((s) => s.id),
        first.visibleSessions.map((s) => s.id),
      );
    });

    test('a self-parenting row fails open as a top-level root', () {
      final selfLinked = _session(
        id: 'loop',
        title: 'Loop',
        origin: SessionOrigin.subagent,
        nativeId: 'loop',
        parentThreadId: 'loop',
      );
      final projection = project([selfLinked]);

      expect(projection.visibleSessions.map((s) => s.id), ['loop']);
      expect(projection.parentFor(selfLinked), isNull);
      expect(projection.visibleRows.single.depth, 0);
    });

    test('a two-node cycle fails open instead of recursing forever', () {
      final a = _session(
        id: 'a',
        title: 'A',
        nativeId: 'a',
        parentThreadId: 'b',
        origin: SessionOrigin.subagent,
      );
      final b = _session(
        id: 'b',
        title: 'B',
        nativeId: 'b',
        parentThreadId: 'a',
        origin: SessionOrigin.subagent,
      );
      final projection = project([a, b]);

      // One edge is cut, so the pair renders rather than vanishing or hanging.
      expect(projection.visibleRows, hasLength(2));
      expect(
        projection.visibleRows.where((row) => row.depth == 0),
        hasLength(1),
      );
      expect(projection.visibleSessions.map((s) => s.id).toSet(), {'a', 'b'});
    });

    test('links never cross tools or machines', () {
      final crossTool = project([
        root('p1', tool: 'claude'),
        child('c1', 'p1'),
      ]);
      expect(crossTool.visibleRows.every((row) => row.depth == 0), isTrue);

      final crossMachine = project([
        root('p1', machine: 'host-a'),
        child('c1', 'p1', machine: 'host-b'),
      ]);
      expect(crossMachine.visibleRows.every((row) => row.depth == 0), isTrue);
    });

    test('a missing parent leaves the child a top-level orphan root', () {
      final orphan = child('c1', 'nobody');
      final projection = project(
        [orphan],
        preferences: const SessionVisibilityPreferences(),
      );

      expect(projection.visibleRows.single.depth, 0);
      expect(projection.visibleRows.single.isRoot, isTrue);
      expect(projection.parentFor(orphan), isNull);
      // The subagent origin label is still on the canonical row.
      expect(projection.visibleSessions.single.origin, SessionOrigin.subagent);
    });

    test('background visibility and parent peek both preserve adjacency', () {
      final sessions = [child('c1', 'p1'), root('p1'), root('p2')];

      final hidden = project(
        sessions,
        preferences: const SessionVisibilityPreferences(),
      );
      expect(hidden.visibleSessions.map((s) => s.id), ['p1', 'p2']);

      final byGlobal = project(sessions);
      expect(byGlobal.visibleSessions.map((s) => s.id), ['p1', 'c1', 'p2']);

      final byPeek = project(
        sessions,
        preferences: const SessionVisibilityPreferences(),
        childExpansion: {
          sessionCompositeRosterKey(sessions[1]):
              SessionChildExpansion.expanded,
        },
      );
      expect(byPeek.visibleSessions.map((s) => s.id), ['p1', 'c1', 'p2']);
      expect(byPeek.visibleRows.map((row) => row.depth), [0, 1, 0]);
    });

    test('effective root status is needs input over working over idle', () {
      SessionStatus statusOf(List<SessionInfo> sessions) =>
          project(sessions).visibleRows.first.effectiveStatus;

      expect(statusOf([root('p1'), child('c1', 'p1')]), SessionStatus.idle);
      expect(
        statusOf([
          root('p1'),
          child('c1', 'p1', status: SessionStatus.working),
        ]),
        SessionStatus.working,
      );
      expect(
        statusOf([
          root('p1'),
          child('c1', 'p1', status: SessionStatus.working),
          child('c2', 'p1', status: SessionStatus.needsInput),
        ]),
        SessionStatus.needsInput,
      );
      // A needs-input grandchild promotes the root past an idle intermediate.
      final nested = project([
        root('p1'),
        child('c1', 'p1'),
        child('g1', 'c1', status: SessionStatus.needsInput),
      ]);
      expect(nested.visibleRows[0].effectiveStatus, SessionStatus.needsInput);
      // The intermediate parent and the child keep their own status.
      expect(nested.visibleRows[1].effectiveStatus, SessionStatus.idle);
      expect(nested.visibleRows[2].effectiveStatus, SessionStatus.needsInput);
    });

    test('a root stays working until every working descendant settles', () {
      SessionStatus rootStatus(SessionStatus a, SessionStatus b) => project([
        root('p1'),
        child('c1', 'p1', status: a),
        child('c2', 'p1', status: b),
      ]).visibleRows.first.effectiveStatus;

      expect(
        rootStatus(SessionStatus.working, SessionStatus.working),
        SessionStatus.working,
      );
      expect(
        rootStatus(SessionStatus.idle, SessionStatus.working),
        SessionStatus.working,
      );
      expect(
        rootStatus(SessionStatus.idle, SessionStatus.idle),
        SessionStatus.idle,
      );
    });

    test('the status filter consumes the root effective status', () {
      final sessions = [
        root('p1'),
        child('c1', 'p1', status: SessionStatus.working),
        root('p2'),
      ];
      final working = project(
        sessions,
        filters: const SessionRosterFilters(status: SessionStatus.working),
      );

      // p1 is canonically idle but displays Working, so it survives the filter;
      // the genuinely idle p2 does not.
      expect(working.visibleSessions.map((s) => s.id), ['p1', 'c1']);
    });

    test('a hidden descendant still rolls activity up to its root', () {
      final projection = project(
        [root('p1'), child('c1', 'p1', status: SessionStatus.working)],
        preferences: const SessionVisibilityPreferences(),
      );

      expect(projection.visibleSessions.map((s) => s.id), ['p1']);
      expect(
        projection.visibleRows.single.effectiveStatus,
        SessionStatus.working,
      );
      expect(projection.groups.single.workingCount, 1);
    });

    test('project totals and counts ignore expanded children', () {
      final sessions = [
        root('p1'),
        child('c1', 'p1', status: SessionStatus.working),
        child('c2', 'p1', status: SessionStatus.working),
        root('p2', status: SessionStatus.needsInput),
      ];

      final collapsed = project(
        sessions,
        preferences: const SessionVisibilityPreferences(),
      ).groups.single;
      final expanded = project(sessions).groups.single;

      for (final group in [collapsed, expanded]) {
        expect(group.rootCount, 2);
        expect(group.needsInputCount, 1);
        expect(group.workingCount, 1);
        expect(group.idleCount, 0);
        expect(group.summaryStatus, SessionStatus.needsInput);
      }
      // Only the flattened row count differs.
      expect(collapsed.rows, hasLength(2));
      expect(expanded.rows, hasLength(4));
    });

    test('an orphan counts as its own root in project totals', () {
      final group = project([root('p1'), child('c1', 'nobody')]).groups.single;

      expect(group.rootCount, 2);
      expect(group.rows.every((row) => row.isRoot), isTrue);
    });

    test('a resolved child inherits its parent project group', () {
      final projection = project([
        root('p1', cwd: '/work/parent'),
        child('c1', 'p1', cwd: '/work/elsewhere'),
      ]);

      expect(projection.groups, hasLength(1));
      expect(projection.groups.single.cwd, '/work/parent');
      expect(projection.groups.single.rows.map((row) => row.session.id), [
        'p1',
        'c1',
      ]);
    });

    test('ready to review waits for the whole subtree to settle', () {
      final tracker = ReadyToReviewTracker();
      SessionStatus effective(
        List<SessionInfo> sessions,
        SessionInfo session,
      ) => SessionRosterLineage.build(sessions).effectiveStatusFor(session);

      Set<String> observe(List<SessionInfo> sessions) => tracker.observe(
        sessions,
        statusOf: (session) => effective(sessions, session),
      );

      final parent = root('p1');
      final busy = [parent, child('c1', 'p1', status: SessionStatus.working)];
      final settled = [parent, child('c1', 'p1')];

      expect(observe(busy), isEmpty);
      // The parent was idle the whole time; only the subtree settling makes it
      // ready. A per-row tracker would never have fired here at all.
      expect(observe(settled), contains(sessionCompositeRosterKey(parent)));
    });

    test('search keeps a matching descendant reachable under its parent', () {
      final projection = project(
        [root('p1'), child('c1', 'p1')],
        filters: const SessionRosterFilters(query: 'Child c1'),
      );

      expect(projection.visibleSessions.map((s) => s.id), ['p1', 'c1']);
      expect(projection.visibleRows.map((row) => row.depth), [0, 1]);
    });

    test('the child control hides and reshows while background is enabled', () {
      // Regression: the control used to read only an "explicitly peeked" set,
      // so with showBackgroundSessions on it claimed the children were hidden
      // while they were on screen, and toggling it changed nothing.
      final parent = root('p1');
      final sessions = [parent, child('c1', 'p1')];
      final parentKey = sessionCompositeRosterKey(parent);

      final auto = project(sessions);
      expect(auto.visibleSessions.map((s) => s.id), ['p1', 'c1']);
      expect(auto.visibleRows.first.childrenRevealed, isTrue);

      // Toggling from that revealed state must actually hide the subtree.
      final hidden = project(
        sessions,
        childExpansion: {parentKey: SessionChildExpansion.collapsed},
      );
      expect(hidden.visibleSessions.map((s) => s.id), ['p1']);
      expect(hidden.visibleRows.single.childrenRevealed, isFalse);

      // And toggling back reshows it.
      final reshown = project(
        sessions,
        childExpansion: {parentKey: SessionChildExpansion.expanded},
      );
      expect(reshown.visibleSessions.map((s) => s.id), ['p1', 'c1']);
      expect(reshown.visibleRows.first.childrenRevealed, isTrue);
    });

    test('the child control reports hidden while background is disabled', () {
      final sessions = [root('p1'), child('c1', 'p1')];
      final projection = project(
        sessions,
        preferences: const SessionVisibilityPreferences(),
      );

      expect(projection.visibleRows.single.childrenRevealed, isFalse);
      expect(projection.visibleRows.single.childCount, 1);
    });

    test('search reveals a hidden matching child and clearing re-hides it', () {
      // Regression: `kept` retained the ancestry, but the child was still
      // rejected structurally, so searching a hidden child showed the parent
      // alone with no way to see the match.
      final sessions = [root('p1'), child('c1', 'p1')];
      const hidden = SessionVisibilityPreferences();

      final idle = project(sessions, preferences: hidden);
      expect(idle.visibleSessions.map((s) => s.id), ['p1']);

      final searching = project(
        sessions,
        preferences: hidden,
        // Matches the child only: the parent is 'Root p1'.
        filters: const SessionRosterFilters(query: 'Child c1'),
      );
      expect(searching.visibleSessions.map((s) => s.id), ['p1', 'c1']);
      expect(searching.visibleRows.map((row) => row.depth), [0, 1]);

      // Clearing restores the hidden view: the reveal wrote no override.
      final cleared = project(sessions, preferences: hidden);
      expect(cleared.visibleSessions.map((s) => s.id), ['p1']);
    });

    test('a search reveal surfaces only the matching child path', () {
      final sessions = [
        root('p1'),
        child('c1', 'p1'),
        child('c2', 'p1'),
        child('g1', 'c1'),
      ];
      final searching = project(
        sessions,
        preferences: const SessionVisibilityPreferences(),
        filters: const SessionRosterFilters(query: 'Child g1'),
      );

      // The grandchild's ancestors come along; its uncle does not.
      expect(searching.visibleSessions.map((s) => s.id), ['p1', 'c1', 'g1']);
      expect(searching.visibleRows.map((row) => row.depth), [0, 1, 2]);
    });

    test('a saved collapse never blocks a search reveal', () {
      // Narrowing ignores the saved map entirely, so a subtree the user closed
      // earlier still surfaces its matching descendant — and clearing the
      // search puts it straight back, because the reveal wrote nothing.
      final parent = root('p1');
      final sessions = [parent, child('c1', 'p1')];
      final saved = {
        sessionCompositeRosterKey(parent): SessionChildExpansion.collapsed,
      };
      const hidden = SessionVisibilityPreferences();

      final before = project(
        sessions,
        preferences: hidden,
        childExpansion: saved,
      );
      expect(before.visibleSessions.map((s) => s.id), ['p1']);

      final searching = project(
        sessions,
        preferences: hidden,
        childExpansion: saved,
        filters: const SessionRosterFilters(query: 'Child c1'),
      );
      expect(searching.visibleSessions.map((s) => s.id), ['p1', 'c1']);
      expect(searching.visibleRows.first.childrenRevealed, isTrue);

      final cleared = project(
        sessions,
        preferences: hidden,
        childExpansion: saved,
      );
      expect(cleared.visibleSessions.map((s) => s.id), ['p1']);
      expect(cleared.visibleRows.single.childrenRevealed, isFalse);
    });

    test('a toggle during a reveal never mutates the saved child state', () {
      final parent = root('p1');
      final sessions = [parent, child('c1', 'p1')];
      final parentKey = sessionCompositeRosterKey(parent);
      const hidden = SessionVisibilityPreferences();
      const query = SessionRosterFilters(query: 'Child c1');

      // Saved expanded, closed during the reveal: hidden now, expanded again as
      // soon as the filters clear.
      final savedExpanded = {parentKey: SessionChildExpansion.expanded};
      final closedDuringSearch = project(
        sessions,
        preferences: hidden,
        childExpansion: savedExpanded,
        revealChildExpansion: {parentKey: SessionChildExpansion.collapsed},
        filters: query,
      );
      expect(closedDuringSearch.visibleSessions.map((s) => s.id), ['p1']);
      expect(
        project(
          sessions,
          preferences: hidden,
          childExpansion: savedExpanded,
        ).visibleSessions.map((s) => s.id),
        ['p1', 'c1'],
      );

      // Saved collapsed, opened during the reveal: shown now, collapsed again
      // once the filters clear.
      final savedCollapsed = {parentKey: SessionChildExpansion.collapsed};
      final openedDuringSearch = project(
        sessions,
        preferences: hidden,
        childExpansion: savedCollapsed,
        revealChildExpansion: {parentKey: SessionChildExpansion.expanded},
        filters: query,
      );
      expect(openedDuringSearch.visibleSessions.map((s) => s.id), ['p1', 'c1']);
      expect(
        project(
          sessions,
          preferences: hidden,
          childExpansion: savedCollapsed,
        ).visibleSessions.map((s) => s.id),
        ['p1'],
      );
    });

    test('a duplicated roster row is projected exactly once', () {
      final parent = root('p1');
      final projection = project([parent, parent, child('c1', 'p1')]);

      expect(projection.visibleSessions.map((s) => s.id), ['p1', 'c1']);
      expect(projection.groups.single.rootCount, 1);
    });
  });
}

SessionInfo _session({
  required String id,
  required String title,
  String tool = 'codex',
  String? cwd = '/work/project',
  String? projectName,
  SessionOrigin? origin,
  String? nativeId,
  String? parentThreadId,
  String? machine,
  SessionStatus status = SessionStatus.idle,
  int? updatedAt,
}) => SessionInfo(
  id: id,
  tool: tool,
  title: title,
  cwd: cwd,
  projectName: projectName,
  origin: origin,
  nativeId: nativeId,
  parentThreadId: parentThreadId,
  machine: machine,
  status: status,
  updatedAt: updatedAt,
  attachMode: AttachMode.live,
);
