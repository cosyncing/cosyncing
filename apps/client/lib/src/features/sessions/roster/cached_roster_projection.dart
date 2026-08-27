import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:flutter/foundation.dart';

/// One cached identity row placed in the display tree.
///
/// There is no `effectiveStatus` here and there never will be. R1c's rollup is
/// a function of authoritative status, and this projection has none: rolling up
/// anything from cached rows would manufacture exactly the current-activity
/// claim the cache is forbidden to make. Status returns when the authoritative
/// roster arrives and replaces these rows wholesale.
@immutable
final class CachedRosterRow {
  /// Creates a cached display row.
  const CachedRosterRow({
    required this.identity,
    required this.depth,
    required this.parent,
  });

  /// The cached identity this row renders.
  final SessionRosterIdentity identity;

  /// Display depth; `0` for a logical root.
  final int depth;

  /// Resolved parent identity, when linkage survived the cache bounds.
  final SessionRosterIdentity? parent;

  /// Stable row identity, matching the authoritative composite key.
  String get key => identity.compositeKey;
}

/// One project group over cached identity rows.
///
/// Carries a total but NO status counts, ready dots or summary status: those
/// are all derived from activity the cache does not hold.
@immutable
final class CachedRosterGroup {
  /// Creates a cached project group.
  const CachedRosterGroup({
    required this.key,
    required this.cwd,
    required this.label,
    required this.rows,
    required this.rootCount,
  });

  /// Stable group key, matching the authoritative grouping key.
  final String key;

  /// Real broker-provided directory, or null when unavailable.
  final String? cwd;

  /// Display alias or path basename.
  final String label;

  /// Rows in parent-first display order.
  final List<CachedRosterRow> rows;

  /// Logical roots in this group.
  final int rootCount;
}

/// Identity-only roster projection used while authoritative hydration is
/// pending or unreachable (N3).
///
/// Mirrors the authoritative projection's SHAPE rules so the roster does not
/// visibly rearrange when real data lands:
///
/// * linkage identity is `(machine, tool, nativeId)` and never crosses a
///   machine or tool boundary;
/// * self-links and cycles fail open as roots;
/// * roots and sibling lists are ordered by [compareRosterIdentities], which is
///   the authoritative settled-band rule;
/// * children are emitted directly beneath their parent, parent-first;
/// * a resolved child inherits its logical root's project group;
/// * groups key on the root's `machine` + real `cwd`, labelled by
///   `projectName` or the path basename.
///
/// It deliberately does NOT mirror the parts that depend on activity: no status
/// rollup, no status counts, no ready-to-review tracking, no status filter.
@immutable
final class CachedRosterProjection {
  /// Builds a projection from cached identity rows.
  factory CachedRosterProjection.build({
    required List<SessionRosterIdentity> rows,
    required SessionVisibilityPreferences preferences,
    String ungroupedLabel = 'Other sessions',
  }) {
    final byKey = <String, SessionRosterIdentity>{};
    final order = <String>[];
    for (final identity in rows) {
      if (!byKey.containsKey(identity.compositeKey)) {
        order.add(identity.compositeKey);
      }
      byKey[identity.compositeKey] = identity;
    }

    final keyByNativeIdentity = <String, String>{};
    for (final key in order) {
      final identity = byKey[key]!;
      final nativeId = identity.nativeId;
      if (nativeId == null || nativeId.isEmpty) continue;
      keyByNativeIdentity[_nativeIdentity(identity, nativeId)] = key;
    }

    final parentKeyByKey = <String, String>{};
    for (final key in order) {
      final identity = byKey[key]!;
      final parentThreadId = identity.parentThreadId;
      if (parentThreadId == null || parentThreadId.isEmpty) continue;
      final parentKey =
          keyByNativeIdentity[_nativeIdentity(identity, parentThreadId)];
      if (parentKey == null || parentKey == key) continue;
      parentKeyByKey[key] = parentKey;
    }

    // Cut cycles so every chain terminates at a root; iterative, so a hostile
    // or truncated cache cannot exhaust the stack.
    const unvisited = 0;
    const onPath = 1;
    const settled = 2;
    final colour = <String, int>{};
    for (final start in order) {
      if ((colour[start] ?? unvisited) != unvisited) continue;
      final path = <String>[];
      var cursor = start;
      while (true) {
        final state = colour[cursor] ?? unvisited;
        if (state == settled) break;
        if (state == onPath) {
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

    // Order is DERIVED here, not inherited from the stored row sequence.
    //
    // The stored sequence is a retention ranking: `boundRosterSnapshotPayload`
    // inserts a parent immediately ahead of the child that pulled it in, so a
    // parent lands wherever its child ranked rather than where its own recency
    // puts it, and the byte budget then truncates from the end. Rendering that
    // sequence made the cached pane disagree with the live pane about rows
    // neither of them considers active. Sorting here is what removes the
    // disagreement; the residual cached -> live jump is the status bands, which
    // this projection has no way to know and no business guessing.
    order.sort((a, b) => compareRosterIdentities(byKey[a]!, byKey[b]!));

    final childKeysByParentKey = <String, List<String>>{};
    for (final key in order) {
      final parentKey = parentKeyByKey[key];
      if (parentKey == null) continue;
      childKeysByParentKey.putIfAbsent(parentKey, () => <String>[]).add(key);
    }

    final depthByKey = <String, int>{};
    final rootKeyByKey = <String, String>{};
    for (final start in order) {
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

    // Origin visibility is the user's setting, and it applies to every cached
    // row including an orphan.
    //
    // The authoritative projection deliberately surfaces an orphaned child
    // regardless of the preference, because there it would otherwise be
    // unreachable — no parent to reveal it, and a search can still find it.
    // Neither justification holds here: this pane has no search, and the
    // retention pass now keeps a child and its available parent as a pair, so
    // an orphan means the parent genuinely is not in the roster. Overriding
    // "hide background sessions" for that case would show the user rows they
    // asked not to see, in the one view that cannot be filtered back.
    bool visible(String key) => _originVisible(byKey[key]!.origin, preferences);

    final emitted = <CachedRosterRow>[];
    for (final rootKey in order) {
      if (depthByKey[rootKey] != 0) continue;
      if (!visible(rootKey)) continue;
      final stack = <String>[rootKey];
      while (stack.isNotEmpty) {
        final key = stack.removeLast();
        final parentKey = parentKeyByKey[key];
        emitted.add(
          CachedRosterRow(
            identity: byKey[key]!,
            depth: depthByKey[key] ?? 0,
            parent: parentKey == null ? null : byKey[parentKey],
          ),
        );
        final children = childKeysByParentKey[key] ?? const <String>[];
        for (var index = children.length - 1; index >= 0; index -= 1) {
          final childKey = children[index];
          // A subagent subtree defaults CLOSED in the authoritative roster,
          // and this pane has no toggle to open one — emitting the children
          // here would flash rows the live projection is about to fold away.
          if (byKey[childKey]!.origin == SessionOrigin.subagent) continue;
          if (visible(childKey)) stack.add(childKey);
        }
      }
    }

    return CachedRosterProjection._(
      rows: List<CachedRosterRow>.unmodifiable(emitted),
      groups: _groupRows(
        emitted,
        rootKeyByKey,
        byKey,
        ungroupedLabel,
      ),
    );
  }

  const CachedRosterProjection._({required this.rows, required this.groups});

  /// Visible rows in parent-first order.
  final List<CachedRosterRow> rows;

  /// Visible rows grouped by their logical root's project.
  final List<CachedRosterGroup> groups;

  /// Whether anything is left to show after origin filtering.
  bool get isEmpty => rows.isEmpty;
}

List<CachedRosterGroup> _groupRows(
  List<CachedRosterRow> rows,
  Map<String, String> rootKeyByKey,
  Map<String, SessionRosterIdentity> byKey,
  String ungroupedLabel,
) {
  final rowsByKey = <String, List<CachedRosterRow>>{};
  final cwdByKey = <String, String?>{};
  final labelByKey = <String, String>{};
  for (final row in rows) {
    final rootKey = rootKeyByKey[row.key] ?? row.key;
    final root = byKey[rootKey] ?? row.identity;
    final cwd = _nonEmpty(root.cwd);
    final directoryKey = cwd ?? '__ungrouped__';
    final machine = _nonEmpty(root.machine);
    // NUL separator, byte-for-byte the authoritative grouping key, so a cached
    // group and the authoritative one that replaces it are the same group.
    final key = machine == null ? directoryKey : '$machine\u0000$directoryKey';
    rowsByKey.putIfAbsent(key, () => <CachedRosterRow>[]).add(row);
    cwdByKey[key] = cwd;
    labelByKey.putIfAbsent(
      key,
      () =>
          _nonEmpty(root.projectName) ??
          (cwd == null ? ungroupedLabel : _pathBasename(cwd)),
    );
  }
  return List<CachedRosterGroup>.unmodifiable([
    for (final entry in rowsByKey.entries)
      CachedRosterGroup(
        key: entry.key,
        cwd: cwdByKey[entry.key],
        label: labelByKey[entry.key]!,
        rows: List<CachedRosterRow>.unmodifiable(entry.value),
        rootCount: entry.value.where((row) => row.depth == 0).length,
      ),
  ]);
}

String _nativeIdentity(SessionRosterIdentity identity, String nativeId) =>
    '${identity.machine ?? ''}\u0000${identity.tool}\u0000$nativeId';

bool _originVisible(
  SessionOrigin? origin,
  SessionVisibilityPreferences preferences,
) => switch (origin) {
  SessionOrigin.subagent ||
  SessionOrigin.exec => preferences.showBackgroundSessions,
  SessionOrigin.vscode => preferences.showVscodeSessions,
  SessionOrigin.unknown || null => true,
};

String _pathBasename(String path) {
  final normalized = path.replaceAll(r'\', '/');
  final segments = normalized.split('/').where((part) => part.isNotEmpty);
  return segments.isEmpty ? path : segments.last;
}

String? _nonEmpty(String? value) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}
