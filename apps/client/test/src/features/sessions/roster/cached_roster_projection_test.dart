import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/roster/cached_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:flutter_test/flutter_test.dart';

/// N3: the cached identity projection preserves the R1b/R1c display SHAPE
/// without deriving any activity from it.
void main() {
  SessionRosterIdentity identity({
    String id = 's1',
    String tool = 'codex',
    String title = 'Session',
    String? machine = 'mac',
    String? cwd = '/work/app',
    String? projectName,
    String? nativeId,
    String? parentThreadId,
    SessionOrigin? origin,
    int? updatedAt,
    int? createdAt,
  }) => SessionRosterIdentity(
    tool: tool,
    sessionId: id,
    title: title,
    machine: machine,
    cwd: cwd,
    projectName: projectName,
    nativeId: nativeId,
    parentThreadId: parentThreadId,
    origin: origin,
    updatedAt: updatedAt,
    createdAt: createdAt,
  );

  const showAll = SessionVisibilityPreferences(showBackgroundSessions: true);

  group('hierarchy', () {
    test('a child renders directly beneath its parent', () {
      final projection = CachedRosterProjection.build(
        rows: [
          identity(id: 'parent', nativeId: 'n-parent', updatedAt: 300),
          identity(id: 'other', updatedAt: 100),
          identity(
            id: 'child',
            nativeId: 'n-child',
            parentThreadId: 'n-parent',
            origin: SessionOrigin.subagent,
            updatedAt: 200,
          ),
        ],
        preferences: showAll,
      );

      final ids = projection.rows.map((row) => row.identity.sessionId).toList();
      expect(ids, ['parent', 'child', 'other']);
      expect(projection.rows[1].depth, 1);
      expect(projection.rows[1].parent?.sessionId, 'parent');
    });

    test('parent linkage never crosses a machine boundary', () {
      final projection = CachedRosterProjection.build(
        rows: [
          identity(id: 'parent', nativeId: 'shared'),
          identity(
            id: 'child',
            machine: 'linux',
            nativeId: 'n-child',
            parentThreadId: 'shared',
            origin: SessionOrigin.subagent,
          ),
        ],
        preferences: showAll,
      );

      expect(projection.rows.every((row) => row.depth == 0), isTrue);
      expect(projection.rows.every((row) => row.parent == null), isTrue);
    });

    test('parent linkage never crosses a tool boundary', () {
      final projection = CachedRosterProjection.build(
        rows: [
          identity(id: 'parent', nativeId: 'shared'),
          identity(
            id: 'child',
            tool: 'opencode',
            nativeId: 'n-child',
            parentThreadId: 'shared',
            origin: SessionOrigin.subagent,
          ),
        ],
        preferences: showAll,
      );

      expect(projection.rows.every((row) => row.depth == 0), isTrue);
    });

    test('a self-link fails open as a root', () {
      final projection = CachedRosterProjection.build(
        rows: [
          identity(id: 'loner', nativeId: 'me', parentThreadId: 'me'),
        ],
        preferences: showAll,
      );

      expect(projection.rows.single.depth, 0);
      expect(projection.rows.single.parent, isNull);
    });

    test('a cycle fails open instead of recursing', () {
      final projection = CachedRosterProjection.build(
        rows: [
          identity(id: 'a', nativeId: 'na', parentThreadId: 'nb'),
          identity(id: 'b', nativeId: 'nb', parentThreadId: 'na'),
        ],
        preferences: showAll,
      );

      expect(projection.rows, hasLength(2));
      expect(projection.rows.any((row) => row.depth == 0), isTrue);
    });

    test('an orphan child obeys the background-session preference', () {
      // The authoritative pane surfaces an orphan regardless of the preference,
      // because a search can still reach it there. This pane has no search and
      // the retention pass keeps parent/child as a pair, so an orphan means the
      // parent genuinely is not in the roster — and the user's "hide background
      // sessions" must win in the one view that cannot be filtered back.
      final rows = [
        identity(
          id: 'child',
          nativeId: 'n-child',
          parentThreadId: 'n-missing',
          origin: SessionOrigin.subagent,
        ),
      ];

      final hidden = CachedRosterProjection.build(
        rows: rows,
        preferences: const SessionVisibilityPreferences(),
      );
      expect(hidden.isEmpty, isTrue);

      final shown = CachedRosterProjection.build(
        rows: rows,
        preferences: showAll,
      );
      expect(shown.rows.single.identity.sessionId, 'child');
      expect(shown.rows.single.depth, 0);
      expect(shown.rows.single.parent, isNull);
    });

    test('a resolved child inherits its logical root project group', () {
      final projection = CachedRosterProjection.build(
        rows: [
          identity(id: 'parent', nativeId: 'n-parent'),
          identity(
            id: 'child',
            cwd: '/tmp/elsewhere',
            nativeId: 'n-child',
            parentThreadId: 'n-parent',
            origin: SessionOrigin.subagent,
          ),
        ],
        preferences: showAll,
      );

      expect(projection.groups, hasLength(1));
      expect(projection.groups.single.cwd, '/work/app');
      expect(projection.groups.single.rows, hasLength(2));
      expect(projection.groups.single.rootCount, 1);
    });
  });

  group('grouping', () {
    test('groups key on machine and cwd and label from projectName', () {
      final projection = CachedRosterProjection.build(
        rows: [
          identity(id: 'a', projectName: 'App'),
          identity(id: 'b', machine: 'linux'),
          identity(id: 'c', cwd: null, machine: null),
        ],
        preferences: showAll,
      );

      final byKey = {
        for (final group in projection.groups) group.key: group,
      };
      expect(byKey.keys, hasLength(3));
      expect(byKey['mac\u0000/work/app']!.label, 'App');
      expect(byKey['linux\u0000/work/app']!.label, 'app');
      expect(byKey['__ungrouped__']!.label, 'Other sessions');
    });

    test('the cached grouping key matches the authoritative one', () {
      const session = SessionInfo(
        id: 'a',
        tool: 'codex',
        title: 'Session',
        status: SessionStatus.working,
        attachMode: AttachMode.live,
        machine: 'mac',
        cwd: '/work/app',
      );
      final authoritative = SessionRosterProjection.build(
        sessions: const [session],
        preferences: showAll,
      );
      final cached = CachedRosterProjection.build(
        rows: [SessionRosterIdentity.fromSession(session)],
        preferences: showAll,
      );

      expect(cached.groups.single.key, authoritative.groups.single.key);
      expect(cached.groups.single.label, authoritative.groups.single.label);
    });
  });

  group('origin visibility', () {
    test('background rows are hidden by default, like the real roster', () {
      final projection = CachedRosterProjection.build(
        rows: [
          identity(id: 'parent', nativeId: 'n-parent'),
          identity(
            id: 'child',
            nativeId: 'n-child',
            parentThreadId: 'n-parent',
            origin: SessionOrigin.subagent,
          ),
        ],
        preferences: const SessionVisibilityPreferences(),
      );

      expect(
        projection.rows.map((row) => row.identity.sessionId),
        ['parent'],
      );
    });

    test('vscode rows follow the same preference as the real roster', () {
      final projection = CachedRosterProjection.build(
        rows: [identity(id: 'ide', origin: SessionOrigin.vscode)],
        preferences: const SessionVisibilityPreferences(
          showVscodeSessions: false,
        ),
      );

      expect(projection.isEmpty, isTrue);
    });
  });

  // D4: the cached pane derives its order instead of rendering the stored row
  // sequence, and carries `createdAt` so a session that has never been updated
  // can be ranked at all.
  group('order', () {
    test('roots and siblings order by recency, not by stored row order', () {
      final projection = CachedRosterProjection.build(
        // Stored order is a RETENTION ranking, not a display order: the bound
        // pass inserts a parent just ahead of the child that pulled it in.
        rows: [
          identity(id: 'r2', updatedAt: 200),
          identity(id: 'p1', nativeId: 'n-p1', updatedAt: 500),
          identity(
            id: 'c2',
            nativeId: 'n-c2',
            parentThreadId: 'n-p1',
            origin: SessionOrigin.subagent,
            updatedAt: 300,
          ),
          identity(id: 'r1', updatedAt: 900),
          identity(
            id: 'c1',
            nativeId: 'n-c1',
            parentThreadId: 'n-p1',
            origin: SessionOrigin.subagent,
            updatedAt: 400,
          ),
        ],
        preferences: showAll,
      );

      expect(projection.rows.map((row) => row.identity.sessionId), [
        'r1',
        'p1',
        'c1',
        'c2',
        'r2',
      ]);
      expect(projection.rows.map((row) => row.depth), [0, 0, 1, 1, 0]);
    });

    test('a row with no updatedAt ranks by createdAt', () {
      final projection = CachedRosterProjection.build(
        rows: [
          identity(id: 'older', updatedAt: 500, createdAt: 100),
          // Created but never updated. Before the anchor was carried this row
          // ranked at zero and sank to the bottom of the pane, which is the
          // opposite of where the authoritative roster puts it.
          identity(id: 'fresh', createdAt: 900),
        ],
        preferences: showAll,
      );

      expect(projection.rows.map((row) => row.identity.sessionId), [
        'fresh',
        'older',
      ]);
    });

    test('rows with no timestamps at all hold a stable order', () {
      List<String> order(List<SessionRosterIdentity> rows) =>
          CachedRosterProjection.build(
            rows: rows,
            preferences: showAll,
          ).rows.map((row) => row.identity.sessionId).toList();
      final rows = [identity(id: 'b'), identity(id: 'c'), identity(id: 'a')];

      // Nothing to rank on, so composite identity decides — the same tie-break
      // the authoritative comparator uses.
      expect(order(rows), ['a', 'b', 'c']);
      expect(order(rows.reversed.toList()), ['a', 'b', 'c']);
    });

    test(
      'the cached order matches the authoritative order for settled rows',
      () {
        // The cache has no status and never will, so it cannot reproduce the
        // working band. It CAN agree about everything that is not working, and
        // this pins that agreement rather than assuming it.
        const sessions = [
          SessionInfo(
            id: 'a',
            tool: 'codex',
            title: 'A',
            status: SessionStatus.idle,
            attachMode: AttachMode.live,
            machine: 'mac',
            cwd: '/work/app',
            updatedAt: 200,
            createdAt: 10,
          ),
          SessionInfo(
            id: 'b',
            tool: 'codex',
            title: 'B',
            status: SessionStatus.idle,
            attachMode: AttachMode.live,
            machine: 'mac',
            cwd: '/work/app',
            updatedAt: 900,
            createdAt: 20,
          ),
          SessionInfo(
            id: 'c',
            tool: 'codex',
            title: 'C',
            status: SessionStatus.idle,
            attachMode: AttachMode.live,
            machine: 'mac',
            cwd: '/work/app',
            updatedAt: 500,
            createdAt: 30,
          ),
        ];
        final authoritative = SessionRosterProjection.build(
          sessions: sessions,
          preferences: showAll,
        );
        final cached = CachedRosterProjection.build(
          rows: sessions.map(SessionRosterIdentity.fromSession).toList(),
          preferences: showAll,
        );

        expect(
          cached.rows.map((row) => row.identity.sessionId),
          authoritative.visibleSessions.map((session) => session.id),
        );
        expect(cached.rows.map((row) => row.identity.sessionId), [
          'b',
          'c',
          'a',
        ]);
      },
    );
  });

  test('duplicate composite identities are projected once', () {
    final projection = CachedRosterProjection.build(
      rows: [
        identity(title: 'first'),
        identity(title: 'second'),
      ],
      preferences: showAll,
    );

    expect(projection.rows, hasLength(1));
    expect(projection.rows.single.identity.title, 'second');
  });
}
