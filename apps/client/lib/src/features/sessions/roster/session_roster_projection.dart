import 'package:broker_contract/broker_contract.dart';

/// Device-global origin filters for the broker roster.
final class SessionVisibilityPreferences {
  /// Creates origin visibility settings.
  const SessionVisibilityPreferences({
    this.showBackgroundSessions = false,
    this.showVscodeSessions = true,
  });

  /// Shows `subagent` and `exec` rows when true.
  final bool showBackgroundSessions;

  /// Shows human-initiated IDE rows when true.
  final bool showVscodeSessions;

  /// Returns a copy with selected fields replaced.
  SessionVisibilityPreferences copyWith({
    bool? showBackgroundSessions,
    bool? showVscodeSessions,
  }) => SessionVisibilityPreferences(
    showBackgroundSessions:
        showBackgroundSessions ?? this.showBackgroundSessions,
    showVscodeSessions: showVscodeSessions ?? this.showVscodeSessions,
  );
}

/// Activity-time preset matching the accepted PoC roster controls.
enum SessionActivityWindow {
  /// No activity-time constraint.
  any,

  /// Updated in the last day.
  today,

  /// Updated in the last seven days.
  last7Days,

  /// Updated in the last thirty days.
  last30Days,

  /// Older than seven days.
  older7Days,

  /// Older than thirty days.
  older30Days,
}

/// Ephemeral, device-local filters applied to the authoritative roster.
final class SessionRosterFilters {
  /// Creates ephemeral roster filters.
  const SessionRosterFilters({
    this.query = '',
    this.status,
    this.tool,
    this.activity = SessionActivityWindow.any,
    this.olderThanDays,
  });

  /// Case-insensitive query across session/project metadata.
  final String query;

  /// Optional exact activity status.
  final SessionStatus? status;

  /// Optional exact agent/tool id.
  final String? tool;

  /// Relative activity-time preset.
  final SessionActivityWindow activity;

  /// Optional custom minimum age in days.
  final int? olderThanDays;

  /// Whether any search or filter narrows the authoritative roster.
  ///
  /// Roster presentation uses this to temporarily reveal matching groups
  /// without writing to the user's saved project-expansion set.
  bool get isNarrowing => isSearching || activity != SessionActivityWindow.any;

  /// Whether the user is actively seeking sessions — query text, a status or
  /// tool chip, or the age filter. Only these gestures reveal match paths and
  /// route expansion toggles to the transient reveal maps.
  ///
  /// The activity window is deliberately not counted: the pane mirrors it
  /// from the broker query window on every build (7 days in the live app),
  /// so a reveal keyed on [isNarrowing] held the roster permanently in
  /// search-reveal mode — every subagent subtree forced open past both the
  /// closed default and any saved collapse.
  bool get isSearching =>
      query.trim().isNotEmpty ||
      status != null ||
      tool != null ||
      olderThanDays != null;

  /// Returns a copy with selected values replaced or cleared.
  SessionRosterFilters copyWith({
    String? query,
    SessionStatus? status,
    bool clearStatus = false,
    String? tool,
    bool clearTool = false,
    SessionActivityWindow? activity,
    int? olderThanDays,
    bool clearOlderThanDays = false,
  }) => SessionRosterFilters(
    query: query ?? this.query,
    status: clearStatus ? null : status ?? this.status,
    tool: clearTool ? null : tool ?? this.tool,
    activity: activity ?? this.activity,
    olderThanDays: clearOlderThanDays
        ? null
        : olderThanDays ?? this.olderThanDays,
  );
}

/// Tracks only observed Working -> Idle transitions; cold-start idle rows are
/// seeded as known and never marked ready.
final class ReadyToReviewTracker {
  final Map<String, SessionStatus> _known = {};
  final Set<String> _ready = {};

  /// Observes a new authoritative roster and returns current review keys.
  ///
  /// [statusOf] supplies the status a row is judged by. The roster passes
  /// [SessionRosterLineage.effectiveStatusFor] so a parent is not announced as
  /// ready while a descendant is still working; it defaults to the row's own
  /// canonical status.
  Set<String> observe(
    List<SessionInfo> sessions, {
    String? activeKey,
    SessionStatus Function(SessionInfo session)? statusOf,
  }) {
    final present = <String>{};
    for (final session in sessions) {
      final key = sessionCompositeRosterKey(session);
      present.add(key);
      final status = statusOf == null ? session.status : statusOf(session);
      final before = _known[key];
      if (before == SessionStatus.working &&
          status == SessionStatus.idle &&
          sessionRosterKey(session) != activeKey &&
          key != activeKey) {
        _ready.add(key);
      }
      if (status != SessionStatus.idle ||
          sessionRosterKey(session) == activeKey ||
          key == activeKey) {
        _ready.remove(key);
      }
      _known[key] = status;
    }
    _known.removeWhere((key, _) => !present.contains(key));
    _ready.removeWhere((key) => !present.contains(key));
    return Set.unmodifiable(_ready);
  }

  /// Clears the marker for an explicitly opened session.
  void markOpened(SessionInfo session) {
    _ready.remove(sessionCompositeRosterKey(session));
  }
}

/// Per-parent control over whether that parent's child subtree is displayed.
///
/// Tri-state on purpose: [auto] has to stay distinct from [collapsed] so the
/// control can flip a subtree that the global background-session preference is
/// already revealing, instead of silently agreeing with it.
enum SessionChildExpansion {
  /// No explicit choice: the global background-session preference decides, and
  /// a search/filter may reveal a matching descendant transiently.
  auto,

  /// The user opened this subtree.
  expanded,

  /// The user closed this subtree. In the saved map this outranks the global
  /// preference; in the transient reveal map it closes the current search path.
  collapsed,
}

/// One flattened roster row: a canonical session plus where it is displayed.
///
/// The canonical [session] is never cloned or rewritten. [effectiveStatus] is a
/// display value used for the roster pill, status filtering, root-level project
/// counts and ready-to-review timing only — never for Session Detail, Stop,
/// Drive, ownership, broker frames or notifications.
final class SessionRosterRow {
  /// Creates a display row.
  const SessionRosterRow({
    required this.session,
    required this.key,
    required this.rootKey,
    required this.depth,
    required this.effectiveStatus,
    required this.childCount,
    required this.childrenRevealed,
  });

  /// Canonical broker row, unmodified.
  final SessionInfo session;

  /// Stable row identity (`machine/tool/id`).
  final String key;

  /// Identity of the logical root this row hangs from.
  final String rootKey;

  /// Display depth; `0` for a logical root.
  final int depth;

  /// Status this row displays. Equals [SessionInfo.status] unless this row is a
  /// root whose subtree contains a higher-priority descendant.
  final SessionStatus effectiveStatus;

  /// Resolved direct children, including ones currently hidden.
  final int childCount;

  /// Whether at least one direct child of this row is displayed right now.
  ///
  /// Derived from what the projection actually emitted — the global preference,
  /// any explicit override and a search reveal all feed it — so the row's
  /// expand/collapse affordance can never contradict what is on screen.
  final bool childrenRevealed;

  /// Whether this row is a logical root: the unit project totals count.
  bool get isRoot => depth == 0;
}

/// Machine- and tool-safe parent/child forest over one authoritative roster.
///
/// Built once per roster snapshot or delta rebuild. Every pass is linear in the
/// roster size, identity is `(machine, tool, nativeId)`, self-links and cycles
/// are cut so a malformed roster fails open as top-level rows, and traversal is
/// iterative so a deep or hostile tree cannot exhaust the stack.
final class SessionRosterLineage {
  /// Builds the forest from the full authoritative roster, before any origin or
  /// filter narrowing.
  factory SessionRosterLineage.build(List<SessionInfo> sessions) {
    final sessionByKey = <String, SessionInfo>{};
    final orderedKeys = <String>[];
    for (final session in sessions) {
      final key = sessionCompositeRosterKey(session);
      if (!sessionByKey.containsKey(key)) orderedKeys.add(key);
      sessionByKey[key] = session;
    }

    final keyByNativeIdentity = <(String, String, String), String>{};
    for (final key in orderedKeys) {
      final session = sessionByKey[key]!;
      final nativeId = session.nativeId;
      if (nativeId == null || nativeId.isEmpty) continue;
      keyByNativeIdentity[_nativeIdentity(session, nativeId)] = key;
    }

    // Raw links first. A row naming itself is never linked to itself.
    final parentKeyByKey = <String, String>{};
    final namesAParent = <String>{};
    for (final key in orderedKeys) {
      final session = sessionByKey[key]!;
      final parentThreadId = session.parentThreadId;
      if (parentThreadId == null || parentThreadId.isEmpty) continue;
      namesAParent.add(key);
      final parentKey =
          keyByNativeIdentity[_nativeIdentity(session, parentThreadId)];
      if (parentKey == null || parentKey == key) continue;
      parentKeyByKey[key] = parentKey;
    }

    // Cut cycles so every remaining chain terminates at a root. Each key is
    // coloured at most twice, so the whole sweep stays linear.
    const unvisited = 0;
    const onPath = 1;
    const settled = 2;
    final colour = <String, int>{};
    for (final start in orderedKeys) {
      if ((colour[start] ?? unvisited) != unvisited) continue;
      final path = <String>[];
      var cursor = start;
      while (true) {
        final state = colour[cursor] ?? unvisited;
        if (state == settled) break;
        if (state == onPath) {
          // Re-entering the path being walked means this edge closes a cycle.
          // Drop it and let the row stand at top level rather than recurse.
          parentKeyByKey.remove(cursor);
          break;
        }
        colour[cursor] = onPath;
        path.add(cursor);
        final parentKey = parentKeyByKey[cursor];
        if (parentKey == null) break;
        cursor = parentKey;
      }
      for (final key in path) {
        colour[key] = settled;
      }
    }

    // Provisional sibling lists, in input order. They exist only so the rollup
    // pass below can read each parent's children; both this map and
    // `keysByDepth` are re-derived from the banded key order once the rollup is
    // known, so no structure downstream inherits the broker's order.
    final childKeysByParentKey = <String, List<String>>{};
    for (final key in orderedKeys) {
      final parentKey = parentKeyByKey[key];
      if (parentKey == null) continue;
      childKeysByParentKey.putIfAbsent(parentKey, () => <String>[]).add(key);
    }

    final depthByKey = <String, int>{};
    final rootKeyByKey = <String, String>{};
    for (final start in orderedKeys) {
      if (depthByKey.containsKey(start)) continue;
      final chain = <String>[];
      var cursor = start;
      while (true) {
        if (depthByKey.containsKey(cursor)) break;
        final parentKey = parentKeyByKey[cursor];
        if (parentKey == null) {
          depthByKey[cursor] = 0;
          rootKeyByKey[cursor] = cursor;
          break;
        }
        chain.add(cursor);
        cursor = parentKey;
      }
      for (final key in chain.reversed) {
        final parentKey = parentKeyByKey[key]!;
        depthByKey[key] = depthByKey[parentKey]! + 1;
        rootKeyByKey[key] = rootKeyByKey[parentKey]!;
      }
    }

    var maxDepth = 0;
    for (final depth in depthByKey.values) {
      if (depth > maxDepth) maxDepth = depth;
    }
    final keysByDepth = List<List<String>>.generate(
      maxDepth + 1,
      (_) => <String>[],
    );
    for (final key in orderedKeys) {
      keysByDepth[depthByKey[key]!].add(key);
    }

    // Deepest-first, so every child's subtree priority is known before its
    // parent reads it. One pass, no recursion.
    final subtreePriority = <String, int>{};
    for (var depth = maxDepth; depth >= 0; depth -= 1) {
      for (final key in keysByDepth[depth]) {
        var priority = _statusPriority(sessionByKey[key]!.status);
        for (final childKey in childKeysByParentKey[key] ?? const <String>[]) {
          final childPriority = subtreePriority[childKey] ?? 0;
          if (childPriority > priority) priority = childPriority;
        }
        subtreePriority[key] = priority;
      }
    }

    // ONE comparator for the whole forest (working-band order). It is applied
    // here, not to the raw input, because the bands are judged on the DISPLAY
    // status — rolled up for a logical root, canonical for every other row —
    // and that is only known once the pass above has run.
    SessionStatus effectiveStatusOf(String key) => depthByKey[key] == 0
        ? _statusForPriority(subtreePriority[key] ?? 0)
        : sessionByKey[key]!.status;
    orderedKeys.sort(
      (a, b) => compareRosterSessions(
        sessionByKey[a]!,
        sessionByKey[b]!,
        effectiveStatusOfA: effectiveStatusOf(a),
        effectiveStatusOfB: effectiveStatusOf(b),
      ),
    );

    // Re-derive every order-carrying structure from the banded key order, so
    // roots and sibling lists are ordered by that one comparator and nothing
    // downstream sorts again. `orderedKeys` is deduplicated by composite
    // identity and the comparator's last tie-break IS that identity, so the
    // order is total and reproduces exactly across rebuilds.
    childKeysByParentKey.clear();
    for (final key in orderedKeys) {
      final parentKey = parentKeyByKey[key];
      if (parentKey == null) continue;
      childKeysByParentKey.putIfAbsent(parentKey, () => <String>[]).add(key);
    }
    for (final keys in keysByDepth) {
      keys.clear();
    }
    for (final key in orderedKeys) {
      keysByDepth[depthByKey[key]!].add(key);
    }

    return SessionRosterLineage._(
      List<String>.unmodifiable(orderedKeys),
      Map<String, SessionInfo>.unmodifiable(sessionByKey),
      Map<String, String>.unmodifiable(parentKeyByKey),
      Map<String, List<String>>.unmodifiable({
        for (final entry in childKeysByParentKey.entries)
          entry.key: List<String>.unmodifiable(entry.value),
      }),
      Map<String, int>.unmodifiable(depthByKey),
      Map<String, String>.unmodifiable(rootKeyByKey),
      Map<String, int>.unmodifiable(subtreePriority),
      List<List<String>>.unmodifiable([
        for (final keys in keysByDepth) List<String>.unmodifiable(keys),
      ]),
      Set<String>.unmodifiable(namesAParent),
    );
  }

  const SessionRosterLineage._(
    this.orderedKeys,
    this._sessionByKey,
    this._parentKeyByKey,
    this._childKeysByParentKey,
    this._depthByKey,
    this._rootKeyByKey,
    this._subtreePriority,
    this._keysByDepth,
    this._namesAParent,
  );

  /// Every roster key in working-band order, deduplicated by identity.
  ///
  /// See [compareRosterSessions]: attention rows first by recency, then the
  /// working band by creation anchor, then everything settled by recency.
  final List<String> orderedKeys;

  final Map<String, SessionInfo> _sessionByKey;
  final Map<String, String> _parentKeyByKey;
  final Map<String, List<String>> _childKeysByParentKey;
  final Map<String, int> _depthByKey;
  final Map<String, String> _rootKeyByKey;
  final Map<String, int> _subtreePriority;
  final List<List<String>> _keysByDepth;
  final Set<String> _namesAParent;

  /// Deepest display depth present, used to drive bottom-up passes.
  int get maxDepth => _keysByDepth.length - 1;

  /// Keys at [depth], in working-band order.
  List<String> keysAtDepth(int depth) =>
      depth < 0 || depth >= _keysByDepth.length
      ? const <String>[]
      : _keysByDepth[depth];

  /// Logical roots in working-band order.
  Iterable<String> get rootKeys => keysAtDepth(0);

  /// Canonical row for [key].
  SessionInfo? sessionForKey(String key) => _sessionByKey[key];

  /// Resolved parent key for [key], or null when [key] is a logical root.
  String? parentKeyOf(String key) => _parentKeyByKey[key];

  /// Resolved children of [key], in stable sibling order.
  List<String> childKeysOf(String key) =>
      _childKeysByParentKey[key] ?? const <String>[];

  /// Display depth of [key]; `0` when it is a root or unknown.
  int depthOfKey(String key) => _depthByKey[key] ?? 0;

  /// Root identity for [key].
  String rootKeyOf(String key) => _rootKeyByKey[key] ?? key;

  /// Display status for [key].
  ///
  /// Roots roll their whole subtree up as needs-input > working > idle; every
  /// other row keeps its own canonical status.
  SessionStatus effectiveStatusOfKey(String key) {
    final session = _sessionByKey[key];
    if (session == null) return SessionStatus.idle;
    if (depthOfKey(key) != 0) return session.status;
    return _statusForPriority(_subtreePriority[key] ?? 0);
  }

  /// Whether [key] named a parent the roster does not contain, or one that was
  /// dropped as a self-link or cycle. Such rows stay top level.
  bool isOrphanChildKey(String key) =>
      _namesAParent.contains(key) && !_parentKeyByKey.containsKey(key);

  /// Resolved parent row for [child], if the broker supplied enough ids.
  SessionInfo? parentFor(SessionInfo child) {
    final parentKey = _parentKeyByKey[sessionCompositeRosterKey(child)];
    return parentKey == null ? null : _sessionByKey[parentKey];
  }

  /// Resolved direct children of [parent], including hidden ones.
  int childCountFor(SessionInfo parent) =>
      childKeysOf(sessionCompositeRosterKey(parent)).length;

  /// Display depth of [session].
  int depthFor(SessionInfo session) =>
      depthOfKey(sessionCompositeRosterKey(session));

  /// Display status of [session]. See [effectiveStatusOfKey].
  SessionStatus effectiveStatusFor(SessionInfo session) =>
      effectiveStatusOfKey(sessionCompositeRosterKey(session));

  /// Whether [session] is a logical root.
  bool isRoot(SessionInfo session) => depthFor(session) == 0;
}

/// One directory-backed project group in the visible roster.
///
/// Every counter below is over *logical roots*, so a parent promoted by a
/// working child and that child are one workload, and expanding or collapsing
/// a child subtree never moves a number.
final class SessionProjectGroup {
  /// Creates a project group.
  const SessionProjectGroup({
    required this.key,
    required this.cwd,
    required this.label,
    required this.rows,
    required this.rootCount,
    required this.summaryStatus,
    required this.needsInputCount,
    required this.workingCount,
    required this.idleCount,
    required this.readyCount,
  });

  /// Stable group key. The real cwd is used when available.
  final String key;

  /// Real broker-provided directory, or null when unavailable.
  final String? cwd;

  /// Display alias or path basename.
  final String label;

  /// Visible rows, parent-first: each child subtree follows its parent.
  final List<SessionRosterRow> rows;

  /// Visible logical roots. This is the project total.
  final int rootCount;

  /// Highest-priority root status: needs-input, then working, then idle.
  final SessionStatus summaryStatus;

  /// Visible roots awaiting input.
  final int needsInputCount;

  /// Visible working roots.
  final int workingCount;

  /// Visible idle roots.
  final int idleCount;

  /// Visible roots with an observed completion not yet opened.
  final int readyCount;

  /// Visible rows as canonical sessions, in the same parent-first order.
  List<SessionInfo> get sessions => [for (final row in rows) row.session];
}

/// Filtered roster plus generic parent/child linkage.
final class SessionRosterProjection {
  /// Builds a projection from authoritative broker fields only.
  ///
  /// Child-subtree expansion is two maps on purpose, mirroring how R1b splits
  /// project expansion: [childExpansion] is the saved state and applies only
  /// while nothing narrows the roster, and [revealChildExpansion] is the
  /// transient state that fully replaces it while [filters] narrow. A search
  /// therefore cannot be blocked by a saved collapse, and a toggle made during
  /// the reveal cannot leak into the saved state.
  factory SessionRosterProjection.build({
    required List<SessionInfo> sessions,
    required SessionVisibilityPreferences preferences,
    Map<String, SessionChildExpansion> childExpansion = const {},
    Map<String, SessionChildExpansion> revealChildExpansion = const {},
    SessionRosterFilters filters = const SessionRosterFilters(),
    Set<String> readyToReviewKeys = const {},
    String ungroupedLabel = 'Other sessions',
    DateTime? now,
    SessionRosterLineage? lineage,
  }) {
    // One forest per rebuild, over the full authoritative roster and before any
    // origin or filter narrowing, so a hidden descendant still rolls up.
    final tree = lineage ?? SessionRosterLineage.build(sessions);
    final resolvedNow = now ?? DateTime.now();

    // Filter each row once, judging status by its display status.
    final matches = <String, bool>{};
    for (final key in tree.orderedKeys) {
      matches[key] = _matchesFilters(
        tree.sessionForKey(key)!,
        filters,
        resolvedNow,
        tree.effectiveStatusOfKey(key),
      );
    }
    // A subtree survives narrowing when it or any descendant matches, so a
    // matching child never loses the parent it has to render beneath.
    final kept = <String, bool>{};
    for (var depth = tree.maxDepth; depth >= 0; depth -= 1) {
      for (final key in tree.keysAtDepth(depth)) {
        var keep = matches[key]!;
        if (!keep) {
          for (final childKey in tree.childKeysOf(key)) {
            if (kept[childKey] ?? false) {
              keep = true;
              break;
            }
          }
        }
        kept[key] = keep;
      }
    }

    // Structural visibility decides *whether* a subtree shows, never where.
    bool shown(String key) {
      final session = tree.sessionForKey(key)!;
      final parentKey = tree.parentKeyOf(key);
      if (parentKey == null) {
        // A child naming a parent the roster does not contain (pruned, not yet
        // discovered, under another tool, or dropped as a self-link/cycle) can
        // never be revealed by a parent toggle. Surface it at top level instead
        // of letting the origin filter hide it out of reach.
        return tree.isOrphanChildKey(key) ||
            _originVisible(session.origin, preferences);
      }
      // While the user is actively searching, the saved overrides are ignored
      // outright and only the transient map is consulted, exactly like R1b's
      // project expansion. A saved collapse therefore cannot defeat the
      // reveal, and nothing written during the reveal touches the saved
      // state. The standing activity window is not a search: with only the
      // window set, the saved map and the closed default govern as usual.
      final override = filters.isSearching
          ? revealChildExpansion[parentKey]
          : childExpansion[parentKey];
      return switch (override ?? SessionChildExpansion.auto) {
        SessionChildExpansion.expanded => true,
        SessionChildExpansion.collapsed => false,
        // With no override in force, narrowing reveals the path down to a
        // matching descendant — only kept keys reach here, so that is the match
        // path and nothing else. Otherwise a SUBAGENT subtree defaults CLOSED:
        // the global background preference decides whether child rows are
        // reachable at all, not whether every parent starts open — a roster
        // where each delegating session unfolds its children by default is all
        // children. The parent's child-count affordance is the reveal, and an
        // explicit expansion is saved per parent. Other child origins keep the
        // preference as their default.
        SessionChildExpansion.auto =>
          filters.isSearching ||
              (session.origin != SessionOrigin.subagent &&
                  _originVisible(session.origin, preferences)),
      };
    }

    // What the roster is actually about to draw, so the row affordance states
    // the truth in every mode instead of echoing the override alone.
    bool childrenRevealed(String key) {
      for (final childKey in tree.childKeysOf(key)) {
        if ((kept[childKey] ?? false) && shown(childKey)) return true;
      }
      return false;
    }

    SessionRosterRow rowFor(String key) => SessionRosterRow(
      session: tree.sessionForKey(key)!,
      key: key,
      rootKey: tree.rootKeyOf(key),
      depth: tree.depthOfKey(key),
      effectiveStatus: tree.effectiveStatusOfKey(key),
      childCount: tree.childKeysOf(key).length,
      childrenRevealed: childrenRevealed(key),
    );

    // Pre-order walk from each visible root: a child subtree is only reachable
    // through an emitted parent, so a row can never sort above or away from it.
    final rows = <SessionRosterRow>[];
    for (final rootKey in tree.rootKeys) {
      if (!(kept[rootKey] ?? false) || !shown(rootKey)) continue;
      final stack = <String>[rootKey];
      while (stack.isNotEmpty) {
        final key = stack.removeLast();
        rows.add(rowFor(key));
        final children = tree.childKeysOf(key);
        for (var index = children.length - 1; index >= 0; index -= 1) {
          final childKey = children[index];
          if ((kept[childKey] ?? false) && shown(childKey)) {
            stack.add(childKey);
          }
        }
      }
    }

    return SessionRosterProjection._(
      lineage: tree,
      allSessions: List<SessionInfo>.unmodifiable(sessions),
      visibleRows: List<SessionRosterRow>.unmodifiable(rows),
      groups: _groupRows(tree, rows, readyToReviewKeys, ungroupedLabel),
    );
  }

  const SessionRosterProjection._({
    required this.lineage,
    required this.allSessions,
    required this.visibleRows,
    required this.groups,
  });

  /// Machine/tool-safe forest this projection was flattened from.
  final SessionRosterLineage lineage;

  /// Full authoritative roster.
  final List<SessionInfo> allSessions;

  /// Visible rows in parent-first display order, with depth and display status.
  final List<SessionRosterRow> visibleRows;

  /// Visible rows grouped by the real cwd of their logical root.
  final List<SessionProjectGroup> groups;

  /// Visible rows as canonical sessions, in the same parent-first order.
  List<SessionInfo> get visibleSessions => [
    for (final row in visibleRows) row.session,
  ];

  /// Returns the linked parent for [child], if the broker supplied enough ids.
  SessionInfo? parentFor(SessionInfo child) => lineage.parentFor(child);

  /// Returns the number of linked children for [parent].
  int childCountFor(SessionInfo parent) => lineage.childCountFor(parent);

  /// Returns the display status [session] shows in the roster.
  SessionStatus effectiveStatusFor(SessionInfo session) =>
      lineage.effectiveStatusFor(session);
}

/// Stable roster identity. Titles are deliberately excluded.
String sessionRosterKey(SessionInfo session) => '${session.tool}/${session.id}';

/// Cross-machine roster identity used for grouping and live projection.
String sessionCompositeRosterKey(SessionInfo session) =>
    '${session.machine ?? ''}/${session.tool}/${session.id}';

/// Sort band a roster row falls into. Lower sorts first.
const int _bandAttention = 0;
const int _bandWorking = 1;
const int _bandSettled = 2;

int _rosterBand(SessionStatus status) => switch (status) {
  SessionStatus.needsInput => _bandAttention,
  SessionStatus.working => _bandWorking,
  SessionStatus.idle => _bandSettled,
};

/// Orders two roster rows into a stable working band.
///
/// Three bands, in this order:
///
/// * **attention** (`needsInput`) — `updatedAt` descending. A row awaiting
///   input is not running, so its `updatedAt` is frozen and cannot churn.
/// * **working** — `createdAt` descending, newest-created first. `updatedAt` is
///   NOT consulted here, and that is the whole point: `updatedAt` is a
///   live-turn timestamp that every adapter advances on each write, so ordering
///   the working band by it made running sessions compete for the top on every
///   publish. `createdAt` is immutable for the life of a session, so nothing in
///   a working row's sort key can move while it works — the band holds its
///   order across every activity update, delta and rebuild, and a row entering
///   or leaving the band moves no other row.
/// * **settled** (`idle`) — `updatedAt` descending: the "N minutes ago"
///   temporal order. A finishing row re-enters this band at the `updatedAt` the
///   turn just advanced, so it lands at or near the top of the settled rows.
///
/// Every band tie-breaks on [sessionCompositeRosterKey] ascending, and a row
/// missing its band anchor sorts after every row that has one (the dsh case for
/// `createdAt`), so the total order is reproducible from the rows alone — no
/// client-side memory of any kind, which is what makes it survive a rebuild, an
/// invalidate, a reconnect and a full reload identically.
///
/// [effectiveStatusOfA] / [effectiveStatusOfB] supply the display status the
/// bands are judged on. [SessionRosterLineage.build] passes the rolled-up
/// status for a logical root and the canonical one for every other row; callers
/// that only know canonical status may omit them, because the lineage re-sorts
/// on effective status downstream.
int compareRosterSessions(
  SessionInfo a,
  SessionInfo b, {
  SessionStatus? effectiveStatusOfA,
  SessionStatus? effectiveStatusOfB,
}) {
  final band = _rosterBand(effectiveStatusOfA ?? a.status);
  final otherBand = _rosterBand(effectiveStatusOfB ?? b.status);
  if (band != otherBand) return band.compareTo(otherBand);
  final byAnchor = band == _bandWorking
      ? _compareAnchorDescending(a.createdAt, b.createdAt)
      : _compareAnchorDescending(a.updatedAt, b.updatedAt);
  if (byAnchor != 0) return byAnchor;
  return sessionCompositeRosterKey(a).compareTo(sessionCompositeRosterKey(b));
}

/// Returns [sessions] in working-band order. The input is never mutated.
///
/// [statusOf] supplies the display status each row is banded by; it defaults to
/// the row's own canonical status.
List<SessionInfo> orderRosterSessions(
  List<SessionInfo> sessions, {
  SessionStatus Function(SessionInfo session)? statusOf,
}) => List<SessionInfo>.of(sessions)
  ..sort(
    (a, b) => compareRosterSessions(
      a,
      b,
      effectiveStatusOfA: statusOf?.call(a),
      effectiveStatusOfB: statusOf?.call(b),
    ),
  );

/// Newest anchor first, with an absent anchor sorting after every present one.
///
/// Absent on both sides is a tie, so the caller's identity tie-break decides —
/// which is what keeps rows with no `createdAt` in a stable order rather than
/// falling back to `updatedAt` and re-introducing the churn this rule removes.
int _compareAnchorDescending(int? a, int? b) {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return b.compareTo(a);
}

bool _originVisible(
  SessionOrigin? origin,
  SessionVisibilityPreferences preferences,
) => switch (origin) {
  SessionOrigin.subagent ||
  SessionOrigin.exec => preferences.showBackgroundSessions,
  SessionOrigin.vscode => preferences.showVscodeSessions,
  SessionOrigin.unknown || null => true,
};

(String, String, String) _nativeIdentity(
  SessionInfo session,
  String nativeId,
) => (session.machine ?? '', session.tool, nativeId);

/// Groups already-flattened rows, keeping their parent-first order.
///
/// A resolved child inherits the project of its logical root, so a subtree is
/// never split across two headers even if a child reports a different cwd.
List<SessionProjectGroup> _groupRows(
  SessionRosterLineage tree,
  List<SessionRosterRow> rows,
  Set<String> readyToReviewKeys,
  String ungroupedLabel,
) {
  final rowsByKey = <String, List<SessionRosterRow>>{};
  final cwdByKey = <String, String?>{};
  final labelByKey = <String, String>{};
  for (final row in rows) {
    final root = tree.sessionForKey(row.rootKey) ?? row.session;
    final cwd = _nonEmpty(root.cwd);
    final directoryKey = cwd ?? '__ungrouped__';
    final machine = _nonEmpty(root.machine);
    final key = machine == null ? directoryKey : '$machine\u0000$directoryKey';
    rowsByKey.putIfAbsent(key, () => <SessionRosterRow>[]).add(row);
    cwdByKey[key] = cwd;
    labelByKey.putIfAbsent(
      key,
      () =>
          _nonEmpty(root.projectName) ??
          (cwd == null ? ungroupedLabel : _pathBasename(cwd)),
    );
  }
  return List<SessionProjectGroup>.unmodifiable([
    for (final entry in rowsByKey.entries)
      _projectGroup(
        key: entry.key,
        cwd: cwdByKey[entry.key],
        label: labelByKey[entry.key]!,
        rows: entry.value,
        readyToReviewKeys: readyToReviewKeys,
      ),
  ]);
}

/// Builds one group, counting logical roots only.
///
/// Counting roots is what keeps a promoted parent and its displayed working
/// child one workload, and stops expanding a subtree from moving any number.
SessionProjectGroup _projectGroup({
  required String key,
  required String? cwd,
  required String label,
  required List<SessionRosterRow> rows,
  required Set<String> readyToReviewKeys,
}) {
  final roots = [
    for (final row in rows)
      if (row.isRoot) row,
  ];
  return SessionProjectGroup(
    key: key,
    cwd: cwd,
    label: label,
    rows: List<SessionRosterRow>.unmodifiable(rows),
    rootCount: roots.length,
    summaryStatus: _summaryStatus(roots),
    needsInputCount: roots
        .where((row) => row.effectiveStatus == SessionStatus.needsInput)
        .length,
    workingCount: roots
        .where((row) => row.effectiveStatus == SessionStatus.working)
        .length,
    idleCount: roots
        .where((row) => row.effectiveStatus == SessionStatus.idle)
        .length,
    readyCount: roots
        .where((row) => readyToReviewKeys.contains(row.key))
        .length,
  );
}

SessionStatus _summaryStatus(List<SessionRosterRow> roots) {
  if (roots.any((row) => row.effectiveStatus == SessionStatus.needsInput)) {
    return SessionStatus.needsInput;
  }
  if (roots.any((row) => row.effectiveStatus == SessionStatus.working)) {
    return SessionStatus.working;
  }
  return SessionStatus.idle;
}

/// Rollup priority: needs input, then working, then idle.
int _statusPriority(SessionStatus status) => switch (status) {
  SessionStatus.needsInput => 2,
  SessionStatus.working => 1,
  SessionStatus.idle => 0,
};

SessionStatus _statusForPriority(int priority) => switch (priority) {
  2 => SessionStatus.needsInput,
  1 => SessionStatus.working,
  _ => SessionStatus.idle,
};

bool _matchesFilters(
  SessionInfo session,
  SessionRosterFilters filters,
  DateTime now,
  SessionStatus effectiveStatus,
) {
  final query = filters.query.trim().toLowerCase();
  if (query.isNotEmpty) {
    final values = [
      session.title,
      session.projectName,
      session.cwd,
      session.tool,
      session.model,
      session.currentModel?.label,
      session.currentModel?.modelID,
      session.currentAgent,
      session.status.name,
      session.attachMode.name,
    ];
    if (!values.whereType<String>().any(
      (value) => value.toLowerCase().contains(query),
    )) {
      return false;
    }
  }
  // The status filter reads the display status, so a filter for Working keeps
  // an idle root whose descendant is working.
  if (filters.status != null && effectiveStatus != filters.status) return false;
  if (filters.tool != null && session.tool != filters.tool) return false;
  final timestamp = session.updatedAt ?? session.createdAt;
  final age = timestamp == null
      ? const Duration(days: 365000)
      : now.difference(DateTime.fromMillisecondsSinceEpoch(timestamp));
  final activityMatches = switch (filters.activity) {
    SessionActivityWindow.any => true,
    SessionActivityWindow.today => age <= const Duration(days: 1),
    SessionActivityWindow.last7Days => age <= const Duration(days: 7),
    SessionActivityWindow.last30Days => age <= const Duration(days: 30),
    SessionActivityWindow.older7Days => age > const Duration(days: 7),
    SessionActivityWindow.older30Days => age > const Duration(days: 30),
  };
  if (!activityMatches) return false;
  final olderThanDays = filters.olderThanDays;
  return olderThanDays == null || age > Duration(days: olderThanDays);
}

String _pathBasename(String path) {
  final normalized = path.replaceAll(r'\', '/');
  final segments = normalized.split('/').where((part) => part.isNotEmpty);
  return segments.isEmpty ? path : segments.last;
}

String? _nonEmpty(String? value) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}
