import 'dart:convert';

import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Key prefix for a broker source's persisted file panes.
///
/// Deliberately its own namespace rather than another `kind` inside the
/// opened-sessions rows. `OpenSessionsSnapshot.fromJsonString` calls
/// `SessionRef.fromJson` on every entry with no discriminator check, so a file
/// row sharing that array would decode into a *session tab* on any client that
/// predates this union — a phantom tab pointing at a session the user never
/// opened. Unknown-kind tolerance protects a reader that looks for it; only a
/// separate namespace protects one that does not, and that reader is already
/// shipped.
const String openFilePanesSettingKeyPrefix = 'open_file_panes_v1:';

/// One broker source's open file panes.
@immutable
class FilePanesState {
  /// Creates a working set.
  const FilePanesState({
    this.panes = const [],
    this.activeBySession = const {},
    this.pinned = const {},
    this.modes = const {},
  });

  /// Decodes a persisted working set, empty on anything malformed.
  factory FilePanesState.fromJsonString(String value) {
    try {
      final decoded = jsonDecode(value);
      if (decoded is! Map<String, dynamic>) return empty;
      final rawPanes = decoded['panes'];
      final panes = <SidePaneKey>[
        if (rawPanes is List)
          for (final entry in rawPanes)
            if (entry is Map<String, dynamic>)
              if (WorkspacePaneKey.fromJson(entry) case final SidePaneKey pane)
                pane,
      ];
      final rawActive = decoded['active'];
      final active = <String, String>{
        if (rawActive is Map)
          for (final entry in rawActive.entries)
            if (entry.key is String && entry.value is String)
              entry.key as String: entry.value as String,
      };
      // Bounded on the way in as well as on the way out. `opened` is the only
      // mutation that grows the set, but `closed`, `reordered` and `activated`
      // all rebuild and re-serialize whatever they were given, so a row
      // written by a client that predates the bound would otherwise stay
      // oversized until the reader happened to open a file.
      final rawModes = decoded['modes'];
      final modes = <String, String>{
        if (rawModes is Map)
          for (final e in rawModes.entries)
            if (e.key is String &&
                (e.value == 'source' || e.value == 'rendered'))
              e.key as String: e.value as String,
      };
      final rawPinned = decoded['pinned'];
      final pins = rawPinned is List
          ? rawPinned.whereType<String>().toSet()
          : <String>{};
      final retained = _bounded(panes, active, pins);
      final keys = retained.map((p) => p.key).toSet();
      return FilePanesState(
        modes: {
          for (final e in modes.entries)
            if (keys.contains(e.key)) e.key: e.value,
        },
        pinned: pins.intersection(keys),
        panes: List.unmodifiable(retained),
        activeBySession: active,
      );
    } on Object {
      return empty;
    }
  }

  /// No file panes open.
  static const FilePanesState empty = FilePanesState();

  /// Every open file pane, in strip order, across all sessions.
  final List<SidePaneKey> panes;

  /// Documents explicitly retained by the reader.
  final Set<String> pinned;

  /// Explicit reader mode choices for open documents.
  final Map<String, String> modes;

  /// Session key to the pane key active within that session's strip.
  final Map<String, String> activeBySession;

  /// The panes belonging to [session], in order.
  ///
  /// File working sets are per session: switching the session tab swaps the
  /// strip's contents rather than carrying one session's files into another.
  List<SidePaneKey> forSession(SessionDetailKey session) => [
    for (final pane in panes)
      if (pane.session == session) pane,
  ];

  /// The active pane within [session], or null when that session has none.
  SidePaneKey? activeFor(SessionDetailKey session) {
    final wanted = activeBySession[_sessionKey(session)];
    for (final pane in panes) {
      if (pane.session == session && pane.key == wanted) return pane;
    }
    // A session with files open but no recorded active pane shows its first.
    for (final pane in panes) {
      if (pane.session == session) return pane;
    }
    return null;
  }

  /// Whether any file pane is open at all.
  ///
  /// The second pane and its sash exist precisely while this is true: no
  /// phantom pane, and no empty third column.
  bool get isEmpty => panes.isEmpty;

  /// Opens [path] in [session], or activates it when already open.
  FilePanesState opened(SessionDetailKey session, String path) {
    return openedPane(FilePaneKey(session: session, path: path));
  }

  /// Opens or activates any right-panel tab.
  FilePanesState openedPane(SidePaneKey pane) {
    if (panes.any((p) => p.key == pane.key)) return activated(pane);
    final session = pane.session;
    if (!panes.any((p) => p.key == pane.key) &&
        panes.length >= workingSetLimit &&
        panes.every(
          (p) => pinned.contains(p.key) || _active.containsValue(p.key),
        )) {
      return this;
    }
    final next = <SidePaneKey>[
      for (final existing in panes)
        if (existing.key != pane.key) existing,
      pane,
    ];
    final active = <String, String>{..._active, _sessionKey(session): pane.key};
    final retained = _bounded(next, active, pinned);
    final keys = retained.map((p) => p.key).toSet();
    return FilePanesState(
      panes: List.unmodifiable(retained),
      activeBySession: active,
      pinned: pinned,
      modes: {
        for (final e in modes.entries)
          if (keys.contains(e.key)) e.key: e.value,
      },
    );
  }

  /// How many file panes the working set keeps.
  ///
  /// Closing a session deliberately keeps its files so they come back with it,
  /// and nothing else prunes them — so without a cap the persisted row grows
  /// once for every file ever opened in every session that ever existed under
  /// one broker. 200 is far past any working set a person maintains by hand,
  /// and reaching it costs the oldest tab in strip order, never one that is
  /// some session's active file.
  static const int workingSetLimit = 200;

  /// [next] trimmed to [workingSetLimit], oldest first, active tabs spared.
  static List<SidePaneKey> _bounded(
    List<SidePaneKey> next,
    Map<String, String> active,
    Set<String> pinned,
  ) {
    if (next.length <= workingSetLimit) return next;
    final spared = {...active.values, ...pinned};
    final trimmed = [...next];
    var index = 0;
    while (trimmed.length > workingSetLimit && index < trimmed.length) {
      if (spared.contains(trimmed[index].key)) {
        index++;
        continue;
      }
      trimmed.removeAt(index);
    }
    return trimmed.take(workingSetLimit).toList();
  }

  /// Closes one file pane.
  FilePanesState closed(SidePaneKey pane) {
    final remaining = [
      for (final existing in panes)
        if (existing.key != pane.key) existing,
    ];
    final active = {..._active};
    final sessionKey = _sessionKey(pane.session);
    if (active[sessionKey] == pane.key) {
      // Falls to the session's next remaining file rather than clearing: a
      // close must not collapse the split under the user while that session
      // still has files open.
      final siblings = remaining
          .where((existing) => existing.session == pane.session)
          .toList();
      if (siblings.isEmpty) {
        active.remove(sessionKey);
      } else {
        final prior = forSession(pane.session);
        final index = prior.indexWhere((p) => p.key == pane.key);
        active[sessionKey] = siblings[index.clamp(0, siblings.length - 1)].key;
      }
    }
    return FilePanesState(
      pinned: pinned.difference({pane.key}),
      modes: {...modes}..remove(pane.key),
      panes: List.unmodifiable(remaining),
      activeBySession: active,
    );
  }

  /// Makes [pane] active within its own session.
  FilePanesState activated(SidePaneKey pane) => FilePanesState(
    panes: panes,
    pinned: pinned,
    modes: modes,
    activeBySession: {..._active, _sessionKey(pane.session): pane.key},
  );

  /// Moves one of [session]'s file tabs from [oldIndex] to [newIndex].
  ///
  /// Indices are into that session's own strip, not the flat list, because the
  /// strip is what the user is dragging.
  FilePanesState reordered(
    SessionDetailKey session,
    int oldIndex,
    int newIndex,
  ) {
    final mine = forSession(session);
    if (oldIndex < 0 || oldIndex >= mine.length || mine.length < 2) return this;
    final target = newIndex.clamp(0, mine.length - 1);
    final moved = [...mine];
    moved.insert(target, moved.removeAt(oldIndex));
    // Splice the reordered run back over this session's positions, leaving
    // every other session's order untouched.
    var next = 0;
    return FilePanesState(
      panes: List.unmodifiable([
        for (final pane in panes)
          if (pane.session == session) moved[next++] else pane,
      ]),
      activeBySession: _active,
      pinned: pinned,
      modes: modes,
    );
  }

  Map<String, String> get _active => activeBySession;

  static String _sessionKey(SessionDetailKey session) =>
      '${session.tool}/${session.sessionId}';

  /// Encodes for persistence.
  String toJsonString() => jsonEncode(<String, dynamic>{
    'panes': [for (final pane in panes) pane.toJson()],
    'active': activeBySession,
    'pinned': pinned.toList(),
    'modes': modes,
  });

  /// Returns a copy with [panes] and [activeBySession] replaced.
  FilePanesState copyWith({
    List<SidePaneKey>? panes,
    Map<String, String>? activeBySession,
    Set<String>? pinned,
    Map<String, String>? modes,
  }) => FilePanesState(
    panes: panes ?? this.panes,
    pinned: pinned ?? this.pinned,
    modes: modes ?? this.modes,
    activeBySession: activeBySession ?? this.activeBySession,
  );
}

/// Durable, per-broker-source store for open file panes.
abstract interface class FilePanesStore {
  /// Loads the working set for [sourceKey].
  Future<FilePanesState> load(String sourceKey);

  /// Persists the working set for [sourceKey].
  Future<void> save(String sourceKey, FilePanesState state);
}

/// Drift-backed store on the shared settings KV table.
class DriftFilePanesStore implements FilePanesStore {
  /// Creates the store.
  DriftFilePanesStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<FilePanesState> load(String sourceKey) async {
    final row =
        await (database.select(database.appSettingRows)..where(
              (table) =>
                  table.key.equals('$openFilePanesSettingKeyPrefix$sourceKey'),
            ))
            .getSingleOrNull();
    if (row == null) return FilePanesState.empty;
    return FilePanesState.fromJsonString(row.value);
  }

  @override
  Future<void> save(String sourceKey, FilePanesState state) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: '$openFilePanesSettingKeyPrefix$sourceKey',
            value: state.toJsonString(),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Provider for the file-pane store.
final filePanesStoreProvider = Provider<FilePanesStore>((ref) {
  return DriftFilePanesStore(ref.watch(appDatabaseProvider));
});
