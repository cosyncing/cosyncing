import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/list/relative_time.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_harness_logo.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_presentation.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/cached_roster_pane.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_reveal_request.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_window_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_visibility_controller.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Runs the shared display-only project-alias flow from either roster layout.
Future<void> renameProjectAliasFromList(
  BuildContext context,
  WidgetRef ref,
  SessionProjectGroup project,
) async {
  final cwd = project.cwd;
  if (cwd == null || cwd.isEmpty) return;
  final l10n = AppLocalizations.of(context);
  // The alias exists only in this modal until the broker accepts it. An open
  // rename therefore defers a web-update handoff even before the user types;
  // closing it releases the hold and announces readiness.
  final next = await WebHandoffParticipants.instance.holdOpen(
    () => showDialog<String>(
      context: context,
      builder: (context) => _ProjectRenameDialog(initialName: project.label),
    ),
  );
  if (!context.mounted || next == null) return;
  final renamed = await ref
      .read(sessionListControllerProvider.notifier)
      .renameProject(cwd: cwd, name: next);
  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(
        renamed
            ? next.trim().isEmpty
                  ? l10n.sessionProjectNameReset
                  : l10n.sessionProjectRenamed
            : l10n.sessionProjectRenameFailed,
      ),
    ),
  );
}

/// Display-alias editor for one project.
///
/// Save stays disabled only while the trimmed value equals the trimmed initial
/// label, so a no-op rename cannot submit. Trimmed-empty input is a valid
/// reset to the directory name — the helper copy discloses it — and submits
/// normally.
class _ProjectRenameDialog extends StatefulWidget {
  const _ProjectRenameDialog({required this.initialName});

  /// The current display label the dialog opens with.
  final String initialName;

  @override
  State<_ProjectRenameDialog> createState() => _ProjectRenameDialogState();
}

class _ProjectRenameDialogState extends State<_ProjectRenameDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initialName,
  );

  bool get _changed => _controller.text.trim() != widget.initialName.trim();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return AlertDialog(
      title: Text(l10n.sessionProjectRename),
      content: TextFormField(
        key: const Key('project-rename-input'),
        controller: _controller,
        autofocus: true,
        decoration: InputDecoration(
          labelText: l10n.sessionProjectName,
          helperText: l10n.sessionProjectRenameHelp,
          helperMaxLines: 2,
        ),
        onChanged: (_) => setState(() {}),
        onFieldSubmitted: (value) {
          if (_changed) Navigator.of(context).pop(value);
        },
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.cancel),
        ),
        FilledButton(
          key: const Key('project-rename-confirm'),
          onPressed: _changed
              ? () => Navigator.of(context).pop(_controller.text)
              : null,
          child: Text(l10n.save),
        ),
      ],
    );
  }
}

/// The broker session roster as an embeddable, project-grouped pane.
///
/// Origin filtering and parent linkage use only exported [SessionInfo] fields.
/// Governing doc: `docs/architecture/client-ui.md`.
class SessionListPane extends ConsumerStatefulWidget {
  /// Creates a session list pane.
  const SessionListPane({
    required this.sessions,
    required this.activeKey,
    required this.onOpen,
    this.status = SessionListStatus.loaded,
    this.visibilityPreferences,
    this.onNewProject,
    this.onRenameProject,
    this.onRefresh,
    this.onRetry,
    this.error,
    this.emptyState,
    this.cachedRoster,
    this.onOpenCached,
    this.queryWindow = SessionRosterQueryWindow.any,
    this.onQueryWindowChanged,
    this.searchFocusNode,
    this.now,
    this.unreadCompletionKeys,
    this.revealRequest,
    super.key,
  });

  /// The full authoritative broker roster.
  final List<SessionInfo> sessions;

  /// Durable unread completions, source-qualified by the owner. Empty means
  /// every completion is read, including acknowledgements on another client.
  /// Only legacy embeddings without an inbox feed may pass null to use local
  /// Working -> Idle tracking. Loading/error states of a supported feed must
  /// pass its current set (or empty), never opt into the legacy fallback.
  final Set<String>? unreadCompletionKeys;

  /// Current roster fetch lifecycle.
  final SessionListStatus status;

  /// Bounded last-known identity rows to stand in while [sessions] is empty and
  /// authoritative hydration is pending or unreachable (N3).
  ///
  /// Never merged into [sessions]: cached identity has no status, and the two
  /// are rendered by different widgets so a cached row cannot borrow the
  /// authoritative row's activity surfaces.
  final CachedRosterPresentation? cachedRoster;

  /// Opens one cached row by its exact identity.
  final ValueChanged<SessionRosterIdentity>? onOpenCached;

  /// Active `tool/id` key, if any.
  final String? activeKey;

  /// Latest explicit open, qualified to this pane's broker by its owner.
  /// A fresh request reveals the same active child again; a retained request
  /// lets subsequent deliberate collapses survive ordinary rebuilds.
  final SessionRosterRevealRequest? revealRequest;

  /// Opens one session row.
  final ValueChanged<SessionInfo> onOpen;

  /// Optional deterministic preference source for embedded/test surfaces.
  ///
  /// When omitted, the device-global persisted setting is used.
  final SessionVisibilityPreferences? visibilityPreferences;

  /// Opens New Session scoped to a directory-backed project.
  final ValueChanged<SessionProjectGroup>? onNewProject;

  /// Requests a display-only alias edit for a directory-backed project.
  final ValueChanged<SessionProjectGroup>? onRenameProject;

  /// Optional pull-to-refresh callback.
  final Future<void> Function()? onRefresh;

  /// Retries a failed initial fetch.
  final Future<void> Function()? onRetry;

  /// Fetch failure when [status] is [SessionListStatus.error].
  final LocalizedFailure? error;

  /// Optional widget shown when the authoritative roster is empty.
  final Widget? emptyState;

  /// Broker query window represented by [sessions].
  final SessionRosterQueryWindow queryWindow;

  /// Requests a durable query-window change.
  final ValueChanged<SessionRosterQueryWindow>? onQueryWindowChanged;

  /// Focus node for the roster's search field, owned by the mounting surface.
  ///
  /// Exposed rather than kept private because the search shortcut
  /// (`AppShortcutId.focusRosterSearch`) is bound one layer up, where the
  /// roster's chords live — and a shortcut that cannot reach the field it
  /// names is a help-page row that does nothing. Optional: a surface that
  /// binds no chord passes nothing and the field manages its own focus.
  final FocusNode? searchFocusNode;

  /// Clock override for deterministic relative-time tests.
  final DateTime Function()? now;

  @override
  ConsumerState<SessionListPane> createState() => _SessionListPaneState();
}

class _SessionListPaneState extends ConsumerState<SessionListPane> {
  static const _clockInterval = Duration(seconds: 30);

  Timer? _clock;
  AppLifecycleListener? _lifecycle;
  bool _appVisible = true;
  bool _tickerEnabled = false;
  DateTime? _relativeTimeNow;
  final Map<int, String> _relativeTimeLabels = <int, String>{};

  /// Saved per-parent child-subtree choices. Absent means "follow the global
  /// background-session preference", which is what lets an explicit collapse
  /// close a subtree that preference is already revealing.
  final Map<String, SessionChildExpansion> _childExpansion = {};

  /// Child-subtree choices made *while* a search/filter reveal is running. It
  /// fully replaces the saved map during the reveal and is discarded when the
  /// filters clear, so a saved collapse never blocks a search and a toggle made
  /// mid-search never rewrites the saved state.
  final Map<String, SessionChildExpansion> _revealChildExpansion = {};

  ReadyToReviewTracker? _reviewTracker;
  final TextEditingController _searchController = TextEditingController();
  SessionRosterFilters _filters = _kDefaultRosterFilters;
  Set<String> _readyToReviewKeys = const {};

  /// Project keys the user has explicitly expanded. Projects default to
  /// collapsed, so an initial or newly discovered key is closed until it is
  /// opened here. In-memory for the mounted workspace, like the per-parent
  /// child choices above.
  final Set<String> _expandedProjectKeys = <String>{};

  /// Project keys the user collapsed again *while* a search/filter reveal was
  /// showing them. Discarded when the filters clear, so the saved expansion set
  /// above survives the reveal untouched.
  final Set<String> _revealCollapsedProjectKeys = <String>{};

  String? _revealedActiveKey;
  SessionRosterRevealRequest? _revealedRequest;
  final Set<String> _revealedActivePath = {};
  final Set<String> _navigationRevealKeys = {};

  DateTime get _now => widget.now?.call() ?? DateTime.now();

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(
      onHide: () {
        _appVisible = false;
        _syncClock();
      },
      onShow: () {
        _appVisible = true;
        _syncClock();
        _tick(force: true);
      },
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final enabled = TickerMode.valuesOf(context).enabled;
    if (_tickerEnabled == enabled) return;
    _tickerEnabled = enabled;
    _syncClock();
  }

  @override
  void dispose() {
    _clock?.cancel();
    _lifecycle?.dispose();
    _searchController.dispose();
    super.dispose();
  }

  void _syncClock() {
    _clock?.cancel();
    _clock = null;
    if (!_appVisible || !_tickerEnabled) return;
    _clock = Timer.periodic(_clockInterval, (_) => _tick());
  }

  void _tick({bool force = false}) {
    if (!mounted || !_appVisible || !_tickerEnabled) return;
    final l10n = AppLocalizations.of(context);
    final now = _now;
    final changed =
        force ||
        _relativeTimeLabels.entries.any(
          (entry) =>
              relativeTimeLabel(context, l10n, entry.key, now: now) !=
              entry.value,
        );
    if (changed) setState(() {});
  }

  String _relativeTimeFor(int epochMs) {
    final label = relativeTimeLabel(
      context,
      AppLocalizations.of(context),
      epochMs,
      now: _relativeTimeNow ?? _now,
    );
    _relativeTimeLabels[epochMs] = label;
    return label;
  }

  @override
  Widget build(BuildContext context) {
    if (_appVisible && _tickerEnabled) _relativeTimeNow = _now;
    _relativeTimeLabels.clear();
    final queryActivity = _activityWindow(widget.queryWindow);
    if (_filters.activity != queryActivity) {
      _filters = _filters.copyWith(activity: queryActivity);
    }
    // One forest per rebuild for navigation reveal and projection.
    final lineage = SessionRosterLineage.build(widget.sessions);
    final unread = widget.unreadCompletionKeys;
    if (unread == null) {
      _readyToReviewKeys = (_reviewTracker ??= ReadyToReviewTracker()).observe(
        widget.sessions,
        activeKey: widget.activeKey,
      );
    } else {
      // Discard fallback history when a feed is attached; it must not resurrect
      // an already acknowledged completion if the embedding later changes.
      _reviewTracker = null;
      _readyToReviewKeys = {
        for (final session in widget.sessions)
          if (unread.contains(sessionRosterKey(session)))
            sessionCompositeRosterKey(session),
      };
    }
    final revealActiveProject = _revealActiveAncestry(lineage);
    if (widget.sessions.isEmpty) {
      // Cached identity outranks both the spinner and the error pane, but only
      // while there is no authoritative roster: a successful response clears
      // `cachedRoster` in the same assignment that publishes its sessions, so
      // this branch cannot be reached with real rows available.
      final cached = widget.cachedRoster;
      final onOpenCached = widget.onOpenCached;
      if (cached != null &&
          onOpenCached != null &&
          cached.snapshot.rows.isNotEmpty) {
        return CachedRosterPane(
          presentation: cached,
          onOpen: onOpenCached,
          visibilityPreferences: widget.visibilityPreferences,
          onRetry: widget.onRetry,
        );
      }
      if (widget.status == SessionListStatus.loading ||
          widget.status == SessionListStatus.refreshing) {
        return const _RosterLoading();
      }
      if (widget.status == SessionListStatus.error) {
        return _RosterError(
          message: widget.error,
          onRetry: widget.onRetry,
        );
      }
      return widget.emptyState ?? const SizedBox.shrink();
    }
    final preferences =
        widget.visibilityPreferences ??
        ref.watch(sessionVisibilityControllerProvider).valueOrNull ??
        const SessionVisibilityPreferences();
    final l10n = AppLocalizations.of(context);
    final projection = SessionRosterProjection.build(
      sessions: widget.sessions,
      preferences: preferences,
      childExpansion: _childExpansion,
      revealChildExpansion: _revealChildExpansion,
      filters: _filters,
      readyToReviewKeys: _readyToReviewKeys,
      navigationRevealKeys: _navigationRevealKeys,
      ungroupedLabel: l10n.sessionRosterOtherSessions,
      lineage: lineage,
    );
    if (revealActiveProject) {
      for (final group in projection.groups) {
        if (group.rows.any(
          (row) => sessionRosterKey(row.session) == widget.activeKey,
        )) {
          if (_filters.isSearching) {
            _revealCollapsedProjectKeys.remove(group.key);
          } else {
            _expandedProjectKeys.add(group.key);
          }
        }
      }
    }
    // A failed refresh over retained rows is stated ONCE, by the shared roster
    // freshness slot in the header — the same surface Compact uses. This pane
    // used to add its own Retry banner, which existed in Expanded only and gave
    // the same fact two owners in one layout and none in the other.
    final liveStatus =
        widget.status != SessionListStatus.error && widget.cachedRoster == null;
    // One flat, lazily built list: only rows on screen are built, so a
    // 78-session project costs what is visible rather than its whole length.
    final entries = <_RosterEntry>[
      const _SectionEntry(),
      if (projection.groups.isEmpty) const _EmptyEntry(),
      for (var index = 0; index < projection.groups.length; index++) ...[
        _ProjectEntry(
          projection.groups[index],
          topGap: _projectTopGap(projection.groups, index),
        ),
        if (!_projectCollapsed(projection.groups[index].key))
          for (var row = 0; row < projection.groups[index].rows.length; row++)
            _RowEntry(projection.groups[index], row),
      ],
    ];
    final entryIndex = <Key, int>{};
    Key entryKey(_RosterEntry entry) => switch (entry) {
      _SectionEntry() => const Key('session-roster-section'),
      _EmptyEntry() => const Key('session-roster-empty'),
      _ProjectEntry(:final group) => ValueKey('session-project-${group.key}'),
      _RowEntry(:final group, :final index) => Key(
        'session-row-${sessionRosterKey(group.rows[index].session)}',
      ),
    };
    for (var index = 0; index < entries.length; index++) {
      entryIndex[entryKey(entries[index])] = index;
    }
    Widget buildEntry(_RosterEntry entry) => switch (entry) {
      _SectionEntry() => _RosterSectionLabel(
        key: entryKey(entry),
        activity: _filters.activity,
      ),
      _EmptyEntry() => _FilteredEmptyMessage(key: entryKey(entry)),
      _ProjectEntry(:final group, :final topGap) => _ProjectHeader(
        key: entryKey(entry),
        group: group,
        topGap: topGap,
        attention:
            liveStatus &&
            _projectNeedsAttention(
              group,
              projection.lineage,
              _readyToReviewKeys,
            ),
        collapsed: _projectCollapsed(group.key),
        onToggleCollapsed: () => _toggleProject(group.key),
        onNew: group.cwd == null || widget.onNewProject == null
            ? null
            : () => widget.onNewProject!(group),
        onRename: group.cwd == null || widget.onRenameProject == null
            ? null
            : () => widget.onRenameProject!(group),
      ),
      _RowEntry(:final group, :final index) => _SessionRow(
        key: entryKey(entry),
        row: group.rows[index],
        lineage: projection.lineage,
        liveStatus: liveStatus,
        readyKeys: _readyToReviewKeys,
        readyToReview: _readyToReviewKeys.contains(group.rows[index].key),
        selected:
            sessionRosterKey(group.rows[index].session) == widget.activeKey,
        parent: projection.parentFor(group.rows[index].session),
        onTap: () => _markOpened(group.rows[index].session),
        onToggleChildren: _toggleChildren,
        relativeTimeFor: _relativeTimeFor,
      ),
    };
    // A failed refresh over retained rows is stated ONCE, by the shared roster
    // freshness slot in the header — the same surface Compact uses. This pane
    // used to add its own Retry banner, which existed in Expanded only and gave
    // the same fact two owners in one layout and none in the other.
    final list = Column(
      children: [
        _RosterSearchBar(
          filters: _filters,
          tools: widget.sessions.map((session) => session.tool).toSet().toList()
            ..sort(),
          searchController: _searchController,
          searchFocusNode: widget.searchFocusNode,
          onChanged: (filters) {
            final activityChanged = filters.activity != _filters.activity;
            setState(() {
              _filters = filters;
              _navigationRevealKeys.clear();
              // Leaving the reveal restores the saved presentation exactly.
              // Projects and child subtrees reveal only under an active
              // search, never under the standing activity window alone.
              if (!filters.isSearching) {
                _revealCollapsedProjectKeys.clear();
                _revealChildExpansion.clear();
              }
            });
            if (activityChanged) {
              widget.onQueryWindowChanged?.call(
                _queryWindow(filters.activity),
              );
            }
          },
        ),
        Expanded(
          // No selection region here, and none per row. The roster is
          // navigation, not a document. Two separate reasons:
          //
          // On web every `SelectionArea` adds a platform view whose
          // `_PlatformViewPlaceholderBox` reads `localToGlobal` from a
          // post-frame callback with no `attached` guard; a scrolling viewport
          // that collects the placeholder first leaves it on a detached render
          // object and it throws — flutter/flutter#122680, fixed by #186840,
          // absent from the 3.44.3 branch we pin. No exception was captured
          // and there is no deterministic repro, so nothing is proven: the
          // release `RenderErrorBox` seen over this list is consistent with
          // that failure, and removing `SelectionArea` removes the mechanism.
          //
          // Selecting a row's text also fought the row's own purpose: it
          // painted a highlight across a control whose only job is to open.
          child: ListView.builder(
            key: const Key('session-roster-list'),
            padding: const EdgeInsets.only(bottom: 8),
            itemCount: entries.length,
            findChildIndexCallback: (key) => entryIndex[key],
            itemBuilder: (context, index) => buildEntry(entries[index]),
          ),
        ),
      ],
    );
    final onRefresh = widget.onRefresh;
    return onRefresh == null
        ? list
        : RefreshIndicator(onRefresh: onRefresh, child: list);
  }

  void _markOpened(SessionInfo session) {
    _reviewTracker?.markOpened(session);
    setState(() {});
    widget.onOpen(session);
  }

  /// Reveal once per selected child/path, including ancestors arriving during
  /// cold-link hydration. Ordinary rebuilds never undo a deliberate collapse.
  bool _revealActiveAncestry(SessionRosterLineage lineage) {
    final request = widget.revealRequest;
    final requestedAgain =
        request != null &&
        request.sessionKey == widget.activeKey &&
        !identical(request, _revealedRequest);
    if (_revealedActiveKey != widget.activeKey || requestedAgain) {
      _revealedActiveKey = widget.activeKey;
      _revealedActivePath.clear();
      _navigationRevealKeys.clear();
    }
    _revealedRequest = request;
    final active = widget.sessions
        .where((session) => sessionRosterKey(session) == widget.activeKey)
        .firstOrNull;
    if (active == null) return false;
    final activeKey = sessionCompositeRosterKey(active);
    if (lineage.parentKeyOf(activeKey) == null &&
        active.origin != SessionOrigin.subagent) {
      return false;
    }
    final path = <String>{activeKey};
    var parent = lineage.parentKeyOf(activeKey);
    while (parent != null) {
      path.add(parent);
      parent = lineage.parentKeyOf(parent);
    }
    if (_revealedActivePath.containsAll(path)) return false;
    _revealedActivePath
      ..clear()
      ..addAll(path);
    _navigationRevealKeys
      ..clear()
      ..addAll(path);
    final expansion = _filters.isSearching
        ? _revealChildExpansion
        : _childExpansion;
    for (final key in path.where((key) => key != activeKey)) {
      expansion[key] = SessionChildExpansion.expanded;
    }
    return true;
  }

  /// Flips a parent's child subtree against what is actually on screen, so the
  /// control works whether the rows are visible because of the global
  /// background-session preference, an earlier expansion, or a search reveal.
  ///
  /// While a reveal is running the choice lands in the transient map only, so
  /// clearing the search restores exactly the saved subtree state.
  void _toggleChildren(SessionInfo parent, {required bool revealed}) {
    final key = sessionCompositeRosterKey(parent);
    setState(() {
      final target = _filters.isSearching
          ? _revealChildExpansion
          : _childExpansion;
      target[key] = revealed
          ? SessionChildExpansion.collapsed
          : SessionChildExpansion.expanded;
    });
  }

  double _projectTopGap(List<SessionProjectGroup> groups, int index) {
    if (index == 0) return 0;
    final previous = groups[index - 1];
    final previousOpen =
        !_projectCollapsed(previous.key) && previous.rows.isNotEmpty;
    return previousOpen ? 16 : 4;
  }

  /// Whether [key]'s rows are hidden right now.
  ///
  /// Unknown keys are collapsed, so both initial and newly discovered projects
  /// start closed — including under the standing activity window, which
  /// always narrows the live roster and therefore must not count as a reveal.
  /// While a search, status or agent filter is active, every surviving group
  /// is revealed unless the user closed it again during that reveal; neither
  /// path reads or writes the saved expansion set.
  bool _projectCollapsed(String key) => _filters.isSearching
      ? _revealCollapsedProjectKeys.contains(key)
      : !_expandedProjectKeys.contains(key);

  void _toggleProject(String key) {
    setState(() {
      final target = _filters.isSearching
          ? _revealCollapsedProjectKeys
          : _expandedProjectKeys;
      if (!target.remove(key)) target.add(key);
    });
  }
}

class _RosterLoading extends StatelessWidget {
  const _RosterLoading();

  @override
  Widget build(BuildContext context) {
    return const Center(
      key: Key('session-roster-loading'),
      child: CircularProgressIndicator(),
    );
  }
}

class _RosterError extends StatelessWidget {
  const _RosterError({required this.message, required this.onRetry});

  final LocalizedFailure? message;
  final Future<void> Function()? onRetry;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    return Center(
      key: const Key('session-roster-error'),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_outlined, color: tokens.textTertiary),
            const SizedBox(height: 12),
            SelectableText(
              message == null
                  ? l10n.sessionRosterLoadFailed
                  : localizedFailureText(l10n, message!),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              TextButton.icon(
                key: const Key('session-roster-retry'),
                onPressed: () => onRetry!(),
                icon: const Icon(Icons.refresh, size: 18),
                label: Text(l10n.retry),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The roster's standing activity window, the default [SessionRosterFilters].
const SessionRosterFilters _kDefaultRosterFilters = SessionRosterFilters(
  activity: SessionActivityWindow.last7Days,
);

/// One borderless search row with the roster's filter menu beside it.
///
/// Drawn like a sidebar destination — icon, quiet label, a hover fill — so it
/// reads as part of the navigation it narrows rather than as a boxed form
/// field. Status, agent and activity choices live in one menu; a dot on the
/// filter glyph says when any of them differs from the standing window.
class _RosterSearchBar extends StatefulWidget {
  const _RosterSearchBar({
    required this.filters,
    required this.tools,
    required this.searchController,
    required this.searchFocusNode,
    required this.onChanged,
  });

  final SessionRosterFilters filters;
  final List<String> tools;
  final TextEditingController searchController;
  final FocusNode? searchFocusNode;
  final ValueChanged<SessionRosterFilters> onChanged;

  @override
  State<_RosterSearchBar> createState() => _RosterSearchBarState();
}

class _RosterSearchBarState extends State<_RosterSearchBar> {
  FocusNode? _ownedFocusNode;
  bool _hovered = false;

  FocusNode get _focusNode =>
      widget.searchFocusNode ?? (_ownedFocusNode ??= FocusNode());

  @override
  void initState() {
    super.initState();
    _focusNode.addListener(_onFocusChanged);
  }

  @override
  void didUpdateWidget(covariant _RosterSearchBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.searchFocusNode != widget.searchFocusNode) {
      (oldWidget.searchFocusNode ?? _ownedFocusNode)?.removeListener(
        _onFocusChanged,
      );
      _focusNode.addListener(_onFocusChanged);
    }
  }

  @override
  void dispose() {
    _focusNode.removeListener(_onFocusChanged);
    _ownedFocusNode?.dispose();
    super.dispose();
  }

  void _onFocusChanged() => setState(() {});

  bool get _hasMenuFilters =>
      widget.filters.status != null ||
      widget.filters.tool != null ||
      widget.filters.activity != _kDefaultRosterFilters.activity;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final textTheme = Theme.of(context).textTheme;
    final focused = _focusNode.hasFocus;
    final hasQuery = widget.searchController.text.isNotEmpty;
    final apple = switch (defaultTargetPlatform) {
      TargetPlatform.macOS || TargetPlatform.iOS => true,
      _ => false,
    };
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Container(
        height: 40,
        decoration: BoxDecoration(
          color: focused || _hovered ? tokens.surfaceHover : tokens.sidebar,
          borderRadius: BorderRadius.circular(tokens.radiusMd),
        ),
        padding: const EdgeInsets.only(left: 12, right: 4),
        child: Row(
          children: [
            StrokeIcon(StrokeGlyph.search, color: tokens.textSecondary),
            const SizedBox(width: 12),
            Expanded(
              child: TextField(
                key: const Key('session-roster-search'),
                controller: widget.searchController,
                focusNode: _focusNode,
                onChanged: (query) {
                  setState(() {});
                  widget.onChanged(widget.filters.copyWith(query: query));
                },
                textInputAction: TextInputAction.search,
                style: textTheme.bodyMedium?.copyWith(
                  color: tokens.textPrimary,
                ),
                cursorColor: tokens.accent,
                decoration: InputDecoration(
                  hintText: l10n.sessionRosterSearchHint,
                  hintStyle: textTheme.bodyMedium?.copyWith(
                    color: tokens.textSecondary,
                  ),
                  isDense: true,
                  filled: false,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  contentPadding: const EdgeInsets.symmetric(vertical: 8),
                ),
              ),
            ),
            if (hasQuery)
              _RosterBarButton(
                key: const Key('session-roster-search-clear'),
                tooltip: l10n.sessionRosterClearFilters,
                onPressed: () {
                  widget.searchController.clear();
                  setState(() {});
                  widget.onChanged(widget.filters.copyWith(query: ''));
                },
                child: StrokeIcon(
                  StrokeGlyph.close,
                  size: 14,
                  color: tokens.textTertiary,
                ),
              )
            else if (!focused)
              Padding(
                padding: const EdgeInsets.only(right: 4),
                child: Text(
                  apple ? '⌘ K' : 'Ctrl K',
                  style: textTheme.labelSmall?.copyWith(
                    color: tokens.textTertiary,
                  ),
                ),
              ),
            _RosterFilterMenu(
              filters: widget.filters,
              tools: widget.tools,
              active: _hasMenuFilters,
              onChanged: widget.onChanged,
              onClear: () {
                widget.searchController.clear();
                setState(() {});
                widget.onChanged(_kDefaultRosterFilters);
              },
            ),
          ],
        ),
      ),
    );
  }
}

/// A 32dp icon target inside the search row.
class _RosterBarButton extends StatelessWidget {
  const _RosterBarButton({
    required this.tooltip,
    required this.onPressed,
    required this.child,
    super.key,
  });

  final String tooltip;
  final VoidCallback? onPressed;
  final Widget child;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: tooltip,
    onPressed: onPressed,
    icon: child,
    style: IconButton.styleFrom(
      padding: EdgeInsets.zero,
      visualDensity: VisualDensity.standard,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      minimumSize: const Size.square(32),
      maximumSize: const Size.square(32),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(context.tokens.radiusSm),
      ),
    ),
  );
}

/// Status, agent and activity choices in one menu.
class _RosterFilterMenu extends StatelessWidget {
  const _RosterFilterMenu({
    required this.filters,
    required this.tools,
    required this.active,
    required this.onChanged,
    required this.onClear,
  });

  final SessionRosterFilters filters;
  final List<String> tools;
  final bool active;
  final ValueChanged<SessionRosterFilters> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final textTheme = Theme.of(context).textTheme;
    Widget heading(String label) => Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Text(
        label,
        style: textTheme.labelSmall?.copyWith(color: tokens.textTertiary),
      ),
    );
    Widget choice<T>({
      required Key key,
      required T value,
      required T current,
      required String label,
      required VoidCallback onSelected,
    }) => MenuItemButton(
      key: key,
      closeOnActivate: false,
      onPressed: onSelected,
      leadingIcon: SizedBox.square(
        dimension: 16,
        child: value == current
            ? Icon(Icons.check, size: 16, color: tokens.accent)
            : null,
      ),
      child: Text(label, style: textTheme.bodySmall),
    );
    return MenuAnchor(
      alignmentOffset: const Offset(-160, 4),
      menuChildren: [
        heading(l10n.sessionRosterFilterStatus),
        for (final (status, label) in <(SessionStatus?, String)>[
          (null, l10n.sessionRosterAllStatuses),
          (SessionStatus.needsInput, l10n.sessionRosterStatusNeedsInput),
          (SessionStatus.working, l10n.sessionRosterStatusWorking),
          (SessionStatus.idle, l10n.sessionRosterStatusIdle),
        ])
          choice<SessionStatus?>(
            key: Key('session-roster-filter-status-${status?.name ?? 'all'}'),
            value: status,
            current: filters.status,
            label: label,
            onSelected: () => onChanged(
              filters.copyWith(status: status, clearStatus: status == null),
            ),
          ),
        const Divider(height: 8),
        heading(l10n.sessionRosterFilterAgent),
        for (final tool in <String?>[null, ...tools])
          choice<String?>(
            key: Key('session-roster-filter-agent-${tool ?? 'all'}'),
            value: tool,
            current: filters.tool,
            label: tool == null
                ? l10n.sessionRosterAllAgents
                : sessionToolLabel(l10n, tool),
            onSelected: () => onChanged(
              filters.copyWith(tool: tool, clearTool: tool == null),
            ),
          ),
        const Divider(height: 8),
        heading(l10n.sessionRosterFilterActivity),
        for (final (window, label) in <(SessionActivityWindow, String)>[
          (SessionActivityWindow.today, l10n.sessionRosterActivityToday),
          (
            SessionActivityWindow.last7Days,
            l10n.sessionRosterActivityLast7Days,
          ),
          (
            SessionActivityWindow.last30Days,
            l10n.sessionRosterActivityLast30Days,
          ),
          (SessionActivityWindow.any, l10n.sessionRosterActivityAny),
        ])
          choice<SessionActivityWindow>(
            key: Key('session-roster-filter-activity-${window.name}'),
            value: window,
            current: filters.activity,
            label: label,
            onSelected: () => onChanged(filters.copyWith(activity: window)),
          ),
        if (active || filters.query.isNotEmpty) ...[
          const Divider(height: 8),
          MenuItemButton(
            key: const Key('session-roster-clear-filters'),
            onPressed: onClear,
            child: Text(
              l10n.sessionRosterClearFilters,
              style: textTheme.bodySmall,
            ),
          ),
        ],
      ],
      builder: (context, controller, _) => _RosterBarButton(
        key: const Key('session-roster-filter-button'),
        tooltip: l10n.sessionRosterFilters,
        onPressed: () =>
            controller.isOpen ? controller.close() : controller.open(),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            StrokeIcon(
              StrokeGlyph.filter,
              color: active ? tokens.accent : tokens.textSecondary,
            ),
            if (active)
              Positioned(
                right: -2,
                top: -2,
                child: StatusDot(
                  key: const Key('session-roster-filters-active'),
                  color: tokens.accent,
                  size: 6,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// The "Projects" caption, with the standing activity window beside it.
class _RosterSectionLabel extends StatelessWidget {
  const _RosterSectionLabel({required this.activity, super.key});

  final SessionActivityWindow activity;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final style = Theme.of(
      context,
    ).textTheme.labelMedium?.copyWith(color: tokens.textTertiary);
    final window = switch (activity) {
      SessionActivityWindow.any => l10n.sessionRosterActivityAny,
      SessionActivityWindow.today => l10n.sessionRosterActivityToday,
      SessionActivityWindow.last7Days => l10n.sessionRosterActivityLast7Days,
      SessionActivityWindow.last30Days => l10n.sessionRosterActivityLast30Days,
      SessionActivityWindow.older7Days => l10n.sessionRosterActivityOlder7Days,
      SessionActivityWindow.older30Days =>
        l10n.sessionRosterActivityOlder30Days,
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 20, 12, 8),
      child: Row(
        children: [
          Expanded(child: Text(l10n.sessionRosterProjectsLabel, style: style)),
          Text(
            window,
            key: const Key('session-roster-window-label'),
            style: style,
          ),
        ],
      ),
    );
  }
}

/// One entry of the flat, lazily built roster list.
sealed class _RosterEntry {
  const _RosterEntry();
}

final class _SectionEntry extends _RosterEntry {
  const _SectionEntry();
}

final class _ProjectEntry extends _RosterEntry {
  const _ProjectEntry(this.group, {required this.topGap});

  final SessionProjectGroup group;
  final double topGap;
}

final class _RowEntry extends _RosterEntry {
  const _RowEntry(this.group, this.index);

  final SessionProjectGroup group;
  final int index;
}

final class _EmptyEntry extends _RosterEntry {
  const _EmptyEntry();
}

/// Whether any session of [group] — subagents included, even under a
/// collapsed parent — needs input or has a finished run to review.
bool _projectNeedsAttention(
  SessionProjectGroup group,
  SessionRosterLineage lineage,
  Set<String> readyKeys,
) {
  final pending = <String>[for (final row in group.rows) row.key];
  final seen = <String>{};
  while (pending.isNotEmpty) {
    final key = pending.removeLast();
    if (!seen.add(key)) continue;
    if (readyKeys.contains(key)) return true;
    if (lineage.sessionForKey(key)?.status == SessionStatus.needsInput) {
      return true;
    }
    pending.addAll(lineage.childKeysOf(key));
  }
  return false;
}

/// A project row: folder, name, an attention dot, and a hover-only `+`.
///
/// The directory is a hover tooltip on pointer devices. Rename and New
/// session live behind a long press (a sheet on touch), a right-click or the
/// context-menu key (a menu), and the row's semantics actions — never a
/// permanent pencil beside every project.
class _ProjectHeader extends StatefulWidget {
  const _ProjectHeader({
    required this.group,
    required this.topGap,
    required this.attention,
    required this.collapsed,
    required this.onToggleCollapsed,
    required this.onNew,
    required this.onRename,
    super.key,
  });

  final SessionProjectGroup group;

  /// Space above the header: a group break after an expanded project's rows,
  /// a small step between collapsed headers, none for the first.
  final double topGap;

  /// Live attention: some session here needs input or has work to review.
  final bool attention;
  final bool collapsed;
  final VoidCallback onToggleCollapsed;
  final VoidCallback? onNew;
  final VoidCallback? onRename;

  @override
  State<_ProjectHeader> createState() => _ProjectHeaderState();
}

class _ProjectHeaderState extends State<_ProjectHeader> {
  bool _hovered = false;
  bool _focused = false;

  bool get _hasActions => widget.onNew != null || widget.onRename != null;

  Future<void> _showMenuAt(Offset position) async {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final overlay =
        Overlay.of(context).context.findRenderObject()! as RenderBox;
    final cwd = widget.group.cwd;
    final action = await showMenu<VoidCallback>(
      context: context,
      position: RelativeRect.fromRect(
        position & const Size(1, 1),
        Offset.zero & overlay.size,
      ),
      items: [
        if (cwd != null)
          PopupMenuItem<VoidCallback>(
            enabled: false,
            height: 32,
            child: Text(
              cwd,
              key: ValueKey('project-path-${widget.group.key}'),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: tokens.textTertiary,
              ),
            ),
          ),
        if (widget.onNew case final onNew?)
          PopupMenuItem<VoidCallback>(
            key: ValueKey('project-menu-new-${widget.group.key}'),
            value: onNew,
            child: Text(l10n.sessionRosterNewInProject(widget.group.label)),
          ),
        if (widget.onRename case final onRename?)
          PopupMenuItem<VoidCallback>(
            key: ValueKey('project-menu-rename-${widget.group.key}'),
            value: onRename,
            child: Text(l10n.sessionProjectRename),
          ),
      ],
    );
    action?.call();
  }

  Future<void> _showSheet() async {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final cwd = widget.group.cwd;
    final action = await showModalBottomSheet<VoidCallback>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          key: ValueKey('project-sheet-${widget.group.key}'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    widget.group.label,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  if (cwd != null)
                    Text(
                      cwd,
                      key: ValueKey('project-path-${widget.group.key}'),
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: tokens.textSecondary,
                      ),
                    ),
                ],
              ),
            ),
            if (widget.onNew case final onNew?)
              ListTile(
                key: ValueKey('project-menu-new-${widget.group.key}'),
                leading: const StrokeIcon(StrokeGlyph.plus),
                title: Text(l10n.sessionRosterNewInProject(widget.group.label)),
                onTap: () => Navigator.of(context).pop(onNew),
              ),
            if (widget.onRename case final onRename?)
              ListTile(
                key: ValueKey('project-menu-rename-${widget.group.key}'),
                leading: const Icon(Icons.edit_outlined, size: 18),
                title: Text(l10n.sessionProjectRename),
                onTap: () => Navigator.of(context).pop(onRename),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    action?.call();
  }

  void _openActions({Offset? at}) {
    if (!_hasActions) return;
    if (at != null) {
      unawaited(_showMenuAt(at));
      return;
    }
    final box = context.findRenderObject() as RenderBox?;
    if (box == null) return;
    unawaited(_showMenuAt(box.localToGlobal(box.size.bottomLeft(Offset.zero))));
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final group = widget.group;
    final touch = switch (theme.platform) {
      TargetPlatform.android || TargetPlatform.iOS => true,
      _ => false,
    };
    final showNew = widget.onNew != null && !touch && (_hovered || _focused);
    final compact = WindowSizeClass.of(context) == WindowSizeClass.compact;
    final radius = BorderRadius.circular(tokens.radiusMd);
    Widget row = Row(
      children: [
        StrokeIcon(StrokeGlyph.folder, color: tokens.textPrimary),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            group.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: tokens.textPrimary,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        if (widget.attention) ...[
          const SizedBox(width: 8),
          Tooltip(
            message: l10n.sessionRosterProjectAttention,
            child: StatusDot(
              key: ValueKey('project-attention-${group.key}'),
              color: tokens.statusError,
              size: 6,
            ),
          ),
        ],
        if (showNew) ...[
          const SizedBox(width: 4),
          SizedBox.square(
            dimension: 24,
            child: IconButton(
              key: ValueKey('project-new-${group.key}'),
              tooltip: l10n.sessionRosterNewInProject(group.label),
              onPressed: widget.onNew,
              icon: StrokeIcon(
                StrokeGlyph.plus,
                size: 14,
                color: tokens.textSecondary,
              ),
              style: IconButton.styleFrom(
                padding: EdgeInsets.zero,
                visualDensity: VisualDensity.standard,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                minimumSize: const Size.square(24),
                maximumSize: const Size.square(24),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(tokens.radiusSm),
                ),
              ),
            ),
          ),
        ],
        const SizedBox(width: 8),
        StrokeIcon(
          StrokeGlyph.chevronDown,
          key: ValueKey('project-collapse-icon-${group.key}'),
          size: 12,
          color: tokens.textTertiary,
          quarterTurns: widget.collapsed ? 3 : 0,
        ),
      ],
    );
    final cwd = group.cwd;
    if (cwd != null && !touch) {
      row = Tooltip(
        message: cwd,
        waitDuration: const Duration(milliseconds: 600),
        triggerMode: TooltipTriggerMode.manual,
        excludeFromSemantics: true,
        child: row,
      );
    }
    return Padding(
      key: ValueKey('session-project-${group.key}'),
      padding: EdgeInsets.only(top: widget.topGap),
      child: Semantics(
        expanded: !widget.collapsed,
        hint: cwd,
        customSemanticsActions: {
          if (widget.onNew case final onNew?)
            CustomSemanticsAction(
              label: l10n.sessionRosterNewInProject(group.label),
            ): onNew,
          if (widget.onRename case final onRename?)
            CustomSemanticsAction(label: l10n.sessionProjectRename): onRename,
        },
        child: CallbackShortcuts(
          bindings: {
            const SingleActivator(LogicalKeyboardKey.contextMenu): _openActions,
            const SingleActivator(LogicalKeyboardKey.f10, shift: true):
                _openActions,
          },
          child: GestureDetector(
            onSecondaryTapUp: _hasActions
                ? (details) => _openActions(at: details.globalPosition)
                : null,
            child: Material(
              color: tokens.sidebar,
              borderRadius: radius,
              child: InkWell(
                key: ValueKey('project-header-${group.key}'),
                borderRadius: radius,
                hoverColor: tokens.surfaceHover,
                onTap: widget.onToggleCollapsed,
                onLongPress: _hasActions
                    ? () => touch ? unawaited(_showSheet()) : _openActions()
                    : null,
                onHover: (hovered) => setState(() => _hovered = hovered),
                onFocusChange: (focused) => setState(() => _focused = focused),
                child: SizedBox(
                  // 40dp is the touch minimum; a pointer layout matches the
                  // 36dp session rows.
                  height: compact ? 40 : 36,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: row,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Child rows step in by this much per display depth, on the 4-point grid.
const double _kSessionRowIndentStep = 12;

/// Deepest indent a nested row may draw. At the reviewed 320 dp compact-phone
/// width, two 12 dp steps on top of the 28 dp row inset still leave the title,
/// status pill and ready dot their room, so deeper trees keep stepping in the
/// data model but stop consuming roster width.
const int _kSessionRowMaxIndentDepth = 2;

class _SessionRow extends StatelessWidget {
  const _SessionRow({
    required this.row,
    required this.lineage,
    required this.liveStatus,
    required this.readyKeys,
    required this.readyToReview,
    required this.selected,
    required this.parent,
    required this.onTap,
    required this.onToggleChildren,
    required this.relativeTimeFor,
    super.key,
  });

  final SessionRosterRow row;
  final SessionRosterLineage lineage;
  final bool liveStatus;
  final Set<String> readyKeys;
  final bool readyToReview;
  final bool selected;
  final SessionInfo? parent;
  final VoidCallback onTap;
  final void Function(SessionInfo parent, {required bool revealed})
  onToggleChildren;
  final String Function(int epochMs) relativeTimeFor;

  SessionInfo get session => row.session;

  int get childCount => row.childCount;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final compact = WindowSizeClass.of(context) == WindowSizeClass.compact;
    final title =
        knownSessionTitle([session.title], sessionId: session.id) ??
        l10n.sessionDetailTitleUntitled;
    final indentDepth = row.depth.clamp(0, _kSessionRowMaxIndentDepth);
    final lineageLabel = row.depth > 0 && parent != null
        ? l10n.sessionRosterChildOf(
            knownSessionTitle([parent!.title], sessionId: parent!.id) ??
                l10n.sessionDetailTitleUntitled,
          )
        : null;
    final radius = BorderRadius.circular(tokens.radiusMd);
    return Semantics(
      key: lineageLabel == null
          ? null
          : ValueKey('session-lineage-${sessionRosterKey(session)}'),
      label: lineageLabel,
      button: true,
      selected: selected,
      child: Material(
        color: selected ? tokens.surfaceHover : tokens.sidebar,
        borderRadius: radius,
        child: InkWell(
          onTap: onTap,
          borderRadius: radius,
          hoverColor: tokens.surfaceHover,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: compact ? 40 : 36),
            child: Padding(
              padding: EdgeInsets.only(
                left: 28 + _kSessionRowIndentStep * indentDepth,
                right: 12,
              ),
              child: Row(
                children: [
                  SessionHarnessLogo(tool: session.tool, tooltip: false),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Tooltip(
                      message: [
                        title,
                        if (session.currentAgent != null) session.currentAgent!,
                        _subtitle(context, session),
                      ].join('\n'),
                      waitDuration: const Duration(milliseconds: 600),
                      child: Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        // 13dp between the body roles, matching the reviewed
                        // roster density.
                        style: theme.textTheme.bodySmall?.copyWith(
                          fontSize: 13,
                          color: selected
                              ? tokens.textPrimary
                              : tokens.textSecondary,
                          fontWeight: selected
                              ? FontWeight.w700
                              : FontWeight.w400,
                        ),
                      ),
                    ),
                  ),
                  if (childCount > 0) _childDisclosure(context),
                  if (liveStatus && readyToReview) ...[
                    const SizedBox(width: 4),
                    Tooltip(
                      message: l10n.sessionRosterReadyToReview,
                      child: Padding(
                        padding: const EdgeInsets.all(4),
                        child: StatusDot(
                          key: ValueKey(
                            'session-ready-'
                            '${sessionCompositeRosterKey(session)}',
                          ),
                          color: tokens.statusError,
                          size: 6,
                        ),
                      ),
                    ),
                  ],
                  if (!liveStatus)
                    Text(
                      l10n.sessionRosterCachedRowLabel,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: tokens.textTertiary,
                      ),
                    ),
                  if (liveStatus && session.status != SessionStatus.idle) ...[
                    const SizedBox(width: 4),
                    sessionStatusPill(context, session.status, dense: true),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _childDisclosure(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final compact = WindowSizeClass.of(context) == WindowSizeClass.compact;
    final descendants = <String>[];
    final pending = [...lineage.childKeysOf(row.key)];
    while (pending.isNotEmpty) {
      final key = pending.removeLast();
      descendants.add(key);
      pending.addAll(lineage.childKeysOf(key));
    }
    final waiting = descendants
        .where(
          (key) =>
              lineage.sessionForKey(key)?.status == SessionStatus.needsInput,
        )
        .length;
    final ready = descendants.where(readyKeys.contains).length;
    final childColor = !liveStatus
        ? tokens.textTertiary
        : waiting > 0
        ? tokens.statusNeedsInput
        : ready > 0
        ? tokens.statusError
        : tokens.textTertiary;
    final disclosureLabel = row.childrenRevealed
        ? l10n.sessionRosterHideChildren(childCount)
        : l10n.sessionRosterShowChildren(childCount);
    final childAttention = liveStatus
        ? l10n.workspaceChildAttention(descendants.length, waiting, ready)
        : l10n.workspaceStateUnavailable;
    final linkedLabel = '$disclosureLabel. $childAttention';
    return Tooltip(
      message: linkedLabel,
      excludeFromSemantics: true,
      child: SizedBox(
        width: compact ? 40 : 28,
        height: compact ? 40 : 36,
        child: TextButton(
          key: ValueKey('session-children-${sessionRosterKey(session)}'),
          style: TextButton.styleFrom(
            padding: EdgeInsets.zero,
            minimumSize: Size.zero,
            foregroundColor: childColor,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(tokens.radiusSm),
            ),
          ),
          onPressed: () =>
              onToggleChildren(session, revealed: row.childrenRevealed),
          child: Semantics(
            label: linkedLabel,
            expanded: row.childrenRevealed,
            excludeSemantics: true,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  '$childCount',
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: childColor,
                    fontSize: 10,
                  ),
                ),
                const SizedBox(width: 2),
                StrokeIcon(
                  StrokeGlyph.chevronDown,
                  size: 10,
                  color: childColor,
                  quarterTurns: row.childrenRevealed ? 0 : 3,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _subtitle(BuildContext context, SessionInfo session) {
    final l10n = AppLocalizations.of(context);
    final parts = <String>[sessionToolLabel(l10n, session.tool)];
    if (sessionModelLabel(session) case final model?) parts.add(model);
    if (session.origin case final origin?) {
      final label = switch (origin) {
        SessionOrigin.subagent => l10n.sessionRosterOriginSubagent,
        SessionOrigin.exec => l10n.sessionRosterOriginAutomation,
        SessionOrigin.vscode => l10n.sessionRosterOriginVscode,
        SessionOrigin.unknown => null,
      };
      if (label != null) parts.add(label);
    }
    if (session.updatedAt != null) {
      parts.add(relativeTimeFor(session.updatedAt!));
    }
    final label = parts.join(' · ');
    final technicalId = sessionModelTechnicalId(session);
    if (technicalId == null) return label;
    final model = session.currentModel;
    final tooltip = switch ((model?.variant, model?.reasoningEffort)) {
      (final String variant, final String effort) =>
        l10n.sessionRosterModelTooltipFull(technicalId, variant, effort),
      (final String variant, null) => l10n.sessionRosterModelTooltipVariant(
        technicalId,
        variant,
      ),
      (null, final String effort) => l10n.sessionRosterModelTooltipEffort(
        technicalId,
        effort,
      ),
      _ => l10n.sessionRosterModelTooltip(technicalId),
    };
    return '$label\n$tooltip';
  }
}

/// The display name of the harness behind [tool], or [tool] itself when this
/// client has no name for it.
String sessionToolLabel(AppLocalizations l10n, String tool) =>
    switch (tool.toLowerCase()) {
      'claude' => l10n.sessionRosterAgentClaude,
      'codex' => l10n.sessionRosterAgentCodex,
      'opencode' => l10n.sessionRosterAgentOpenCode,
      'pi' => l10n.sessionRosterAgentPi,
      'omp' => l10n.sessionRosterAgentOmp,
      'reasonix' => l10n.sessionRosterAgentReasonix,
      'grok' => l10n.sessionRosterAgentGrok,
      'cline' => l10n.sessionRosterAgentCline,
      'kilo' => l10n.sessionRosterAgentKilo,
      // The backend id and the product name differ here, so the fallback below
      // would render the command (`agy`) where every other row renders a name.
      'agy' => l10n.sessionRosterAgentAntigravity,
      _ => tool,
    };

SessionActivityWindow _activityWindow(SessionRosterQueryWindow window) =>
    switch (window) {
      SessionRosterQueryWindow.any => SessionActivityWindow.any,
      SessionRosterQueryWindow.today => SessionActivityWindow.today,
      SessionRosterQueryWindow.last7Days => SessionActivityWindow.last7Days,
      SessionRosterQueryWindow.last30Days => SessionActivityWindow.last30Days,
    };

SessionRosterQueryWindow _queryWindow(SessionActivityWindow window) =>
    switch (window) {
      SessionActivityWindow.any ||
      SessionActivityWindow.older7Days ||
      SessionActivityWindow.older30Days => SessionRosterQueryWindow.any,
      SessionActivityWindow.today => SessionRosterQueryWindow.today,
      SessionActivityWindow.last7Days => SessionRosterQueryWindow.last7Days,
      SessionActivityWindow.last30Days => SessionRosterQueryWindow.last30Days,
    };

/// A [StatusPill] for a session's [SessionStatus], colored from the active
/// semantic tokens (working / needs-input / idle).
StatusPill sessionStatusPill(
  BuildContext context,
  SessionStatus status, {
  bool dense = false,
}) {
  final tokens = context.tokens;
  final l10n = AppLocalizations.of(context);
  final (label, color) = switch (status) {
    SessionStatus.working => (
      l10n.sessionRosterStatusWorking,
      tokens.statusWorking,
    ),
    SessionStatus.needsInput => (
      l10n.sessionRosterStatusNeedsInput,
      tokens.statusNeedsInput,
    ),
    SessionStatus.idle => (l10n.sessionRosterStatusIdle, tokens.statusIdle),
  };
  return StatusPill(label: label, color: color, dense: dense);
}

class _FilteredEmptyMessage extends StatelessWidget {
  const _FilteredEmptyMessage({super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Text(
        AppLocalizations.of(context).sessionRosterFilteredEmpty,
        textAlign: TextAlign.center,
      ),
    );
  }
}
