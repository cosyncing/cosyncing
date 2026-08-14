import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/sessions/list/relative_time.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_presentation.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/cached_roster_pane.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_window_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_visibility_controller.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
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
    this.now,
    super.key,
  });

  /// The full authoritative broker roster.
  final List<SessionInfo> sessions;

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

  /// Fetch failure text when [status] is [SessionListStatus.error].
  final String? error;

  /// Optional widget shown when the authoritative roster is empty.
  final Widget? emptyState;

  /// Broker query window represented by [sessions].
  final SessionRosterQueryWindow queryWindow;

  /// Requests a durable query-window change.
  final ValueChanged<SessionRosterQueryWindow>? onQueryWindowChanged;

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

  final ReadyToReviewTracker _reviewTracker = ReadyToReviewTracker();
  final TextEditingController _searchController = TextEditingController();
  SessionRosterFilters _filters = const SessionRosterFilters(
    activity: SessionActivityWindow.last7Days,
  );
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

  /// Forest built by the most recent [build], reused by callbacks that need the
  /// same display statuses without rebuilding it.
  SessionRosterLineage _lineage = SessionRosterLineage.build(const []);

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
      now: _now,
    );
    _relativeTimeLabels[epochMs] = label;
    return label;
  }

  @override
  Widget build(BuildContext context) {
    _relativeTimeLabels.clear();
    final queryActivity = _activityWindow(widget.queryWindow);
    if (_filters.activity != queryActivity) {
      _filters = _filters.copyWith(activity: queryActivity);
    }
    // One forest per rebuild, shared by the ready tracker and the projection so
    // both read the same display statuses without a second pass.
    final lineage = SessionRosterLineage.build(widget.sessions);
    _lineage = lineage;
    _readyToReviewKeys = _reviewTracker.observe(
      widget.sessions,
      activeKey: widget.activeKey,
      statusOf: lineage.effectiveStatusFor,
    );
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
      ungroupedLabel: l10n.sessionRosterOtherSessions,
      lineage: lineage,
    );
    // A failed refresh over retained rows is stated ONCE, by the shared roster
    // freshness slot in the header — the same surface Compact uses. This pane
    // used to add its own Retry banner, which existed in Expanded only and gave
    // the same fact two owners in one layout and none in the other.
    final list = Column(
      children: [
        _RosterFiltersBar(
          filters: _filters,
          tools: widget.sessions.map((session) => session.tool).toSet().toList()
            ..sort(),
          searchController: _searchController,
          onChanged: (filters) {
            final activityChanged = filters.activity != _filters.activity;
            setState(() {
              _filters = filters;
              // Leaving the reveal restores the saved presentation exactly,
              // for projects and for child subtrees alike.
              if (!filters.isNarrowing) {
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
          child: ListView(
            key: const Key('session-roster-list'),
            padding: const EdgeInsets.symmetric(vertical: 4),
            children: [
              if (projection.groups.isEmpty)
                const _FilteredEmptyMessage()
              else
                for (final group in projection.groups)
                  _ProjectGroup(
                    group: group,
                    projection: projection,
                    activeKey: widget.activeKey,
                    onOpen: widget.onOpen,
                    onNewProject: widget.onNewProject,
                    onRenameProject: widget.onRenameProject,
                    onToggleChildren: _toggleChildren,
                    collapsed: _projectCollapsed(group.key),
                    onToggleCollapsed: () => _toggleProject(group.key),
                    readyToReviewKeys: _readyToReviewKeys,
                    onMarkOpened: _markOpened,
                    relativeTimeFor: _relativeTimeFor,
                  ),
            ],
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
    _reviewTracker.markOpened(session);
    setState(() {
      _readyToReviewKeys = _reviewTracker.observe(
        widget.sessions,
        activeKey: sessionRosterKey(session),
        statusOf: _lineage.effectiveStatusFor,
      );
    });
    widget.onOpen(session);
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
      final target = _filters.isNarrowing
          ? _revealChildExpansion
          : _childExpansion;
      target[key] = revealed
          ? SessionChildExpansion.collapsed
          : SessionChildExpansion.expanded;
    });
  }

  /// Whether [key]'s rows are hidden right now.
  ///
  /// Unknown keys are collapsed, so both initial and newly discovered projects
  /// start closed. While a search/filter narrows the roster, every surviving
  /// group is revealed unless the user closed it again during that reveal;
  /// neither path reads or writes the saved expansion set.
  bool _projectCollapsed(String key) => _filters.isNarrowing
      ? _revealCollapsedProjectKeys.contains(key)
      : !_expandedProjectKeys.contains(key);

  void _toggleProject(String key) {
    setState(() {
      final target = _filters.isNarrowing
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

  final String? message;
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
              message ?? l10n.sessionRosterLoadFailed,
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

class _RosterFiltersBar extends StatelessWidget {
  const _RosterFiltersBar({
    required this.filters,
    required this.tools,
    required this.searchController,
    required this.onChanged,
  });

  final SessionRosterFilters filters;
  final List<String> tools;
  final TextEditingController searchController;
  final ValueChanged<SessionRosterFilters> onChanged;

  bool get _hasFilters => filters.isNarrowing;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final textTheme = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 4),
      child: Column(
        children: [
          SizedBox(
            height: 40,
            child: TextField(
              key: const Key('session-roster-search'),
              controller: searchController,
              onChanged: (query) => onChanged(filters.copyWith(query: query)),
              textInputAction: TextInputAction.search,
              style: textTheme.bodySmall,
              decoration: InputDecoration(
                hintText: l10n.sessionRosterSearchHint,
                prefixIcon: const Icon(Icons.search, size: 18),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
              ),
            ),
          ),
          const SizedBox(height: 4),
          SizedBox(
            height: 40,
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: [
                _FilterDropdown<SessionStatus?>(
                  key: const Key('session-roster-status-filter'),
                  tooltip: l10n.sessionRosterFilterStatus,
                  value: filters.status,
                  items: [
                    DropdownMenuItem(
                      child: Text(l10n.sessionRosterAllStatuses),
                    ),
                    DropdownMenuItem(
                      value: SessionStatus.needsInput,
                      child: Text(l10n.sessionRosterStatusNeedsInput),
                    ),
                    DropdownMenuItem(
                      value: SessionStatus.working,
                      child: Text(l10n.sessionRosterStatusWorking),
                    ),
                    DropdownMenuItem(
                      value: SessionStatus.idle,
                      child: Text(l10n.sessionRosterStatusIdle),
                    ),
                  ],
                  onChanged: (value) => onChanged(
                    filters.copyWith(
                      status: value,
                      clearStatus: value == null,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                _FilterDropdown<String?>(
                  key: const Key('session-roster-agent-filter'),
                  tooltip: l10n.sessionRosterFilterAgent,
                  value: filters.tool,
                  items: [
                    DropdownMenuItem(
                      child: Text(l10n.sessionRosterAllAgents),
                    ),
                    for (final tool in tools)
                      DropdownMenuItem(
                        value: tool,
                        child: Text(_toolLabel(l10n, tool)),
                      ),
                  ],
                  onChanged: (value) => onChanged(
                    filters.copyWith(tool: value, clearTool: value == null),
                  ),
                ),
                const SizedBox(width: 8),
                _FilterDropdown<SessionActivityWindow>(
                  key: const Key('session-roster-activity-filter'),
                  tooltip: l10n.sessionRosterFilterActivity,
                  value: filters.activity,
                  items: [
                    DropdownMenuItem(
                      value: SessionActivityWindow.any,
                      child: Text(l10n.sessionRosterActivityAny),
                    ),
                    DropdownMenuItem(
                      value: SessionActivityWindow.today,
                      child: Text(l10n.sessionRosterActivityToday),
                    ),
                    DropdownMenuItem(
                      value: SessionActivityWindow.last7Days,
                      child: Text(l10n.sessionRosterActivityLast7Days),
                    ),
                    DropdownMenuItem(
                      value: SessionActivityWindow.last30Days,
                      child: Text(l10n.sessionRosterActivityLast30Days),
                    ),
                  ],
                  onChanged: (value) => onChanged(
                    filters.copyWith(activity: value),
                  ),
                ),
                if (_hasFilters) ...[
                  const SizedBox(width: 4),
                  IconButton(
                    key: const Key('session-roster-clear-filters'),
                    tooltip: l10n.sessionRosterClearFilters,
                    onPressed: () {
                      searchController.clear();
                      onChanged(
                        const SessionRosterFilters(
                          activity: SessionActivityWindow.last7Days,
                        ),
                      );
                    },
                    icon: const Icon(Icons.filter_alt_off_outlined, size: 18),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FilterDropdown<T> extends StatelessWidget {
  const _FilterDropdown({
    required this.tooltip,
    required this.value,
    required this.items,
    required this.onChanged,
    super.key,
  });

  final String tooltip;
  final T value;
  final List<DropdownMenuItem<T>> items;
  final ValueChanged<T?> onChanged;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: DropdownButtonHideUnderline(
        child: DropdownButton<T>(
          value: value,
          items: items,
          onChanged: onChanged,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: context.tokens.textPrimary,
          ),
          borderRadius: BorderRadius.circular(context.tokens.radiusSm),
        ),
      ),
    );
  }
}

class _ProjectGroup extends StatelessWidget {
  const _ProjectGroup({
    required this.group,
    required this.projection,
    required this.activeKey,
    required this.onOpen,
    required this.onNewProject,
    required this.onRenameProject,
    required this.onToggleChildren,
    required this.collapsed,
    required this.onToggleCollapsed,
    required this.readyToReviewKeys,
    required this.onMarkOpened,
    required this.relativeTimeFor,
  });

  final SessionProjectGroup group;
  final SessionRosterProjection projection;
  final String? activeKey;
  final ValueChanged<SessionInfo> onOpen;
  final ValueChanged<SessionProjectGroup>? onNewProject;
  final ValueChanged<SessionProjectGroup>? onRenameProject;
  final void Function(SessionInfo parent, {required bool revealed})
  onToggleChildren;

  /// Whether this group's session rows are hidden.
  final bool collapsed;

  /// Toggles [collapsed].
  final VoidCallback onToggleCollapsed;
  final Set<String> readyToReviewKeys;
  final ValueChanged<SessionInfo> onMarkOpened;
  final String Function(int epochMs) relativeTimeFor;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Column(
      key: ValueKey('session-project-${group.key}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _ProjectHeader(
          group: group,
          collapsed: collapsed,
          onToggleCollapsed: onToggleCollapsed,
          onNew: group.cwd == null || onNewProject == null
              ? null
              : () => onNewProject!(group),
          onRename: group.cwd == null || onRenameProject == null
              ? null
              : () => onRenameProject!(group),
        ),
        if (!collapsed)
          for (var index = 0; index < group.rows.length; index++) ...[
            if (index > 0)
              Divider(height: 1, thickness: 1, color: tokens.separator),
            _SessionRow(
              key: Key(
                'session-row-${sessionRosterKey(group.rows[index].session)}',
              ),
              row: group.rows[index],
              readyToReview: readyToReviewKeys.contains(group.rows[index].key),
              selected:
                  sessionRosterKey(group.rows[index].session) == activeKey,
              parent: projection.parentFor(group.rows[index].session),
              onTap: () => onMarkOpened(group.rows[index].session),
              onToggleChildren: onToggleChildren,
              relativeTimeFor: relativeTimeFor,
            ),
          ],
        const SizedBox(height: 8),
      ],
    );
  }
}

class _ProjectHeader extends StatelessWidget {
  const _ProjectHeader({
    required this.group,
    required this.collapsed,
    required this.onToggleCollapsed,
    required this.onNew,
    required this.onRename,
  });

  final SessionProjectGroup group;
  final bool collapsed;
  final VoidCallback onToggleCollapsed;
  final VoidCallback? onNew;
  final VoidCallback? onRename;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final projectCounts = <({String id, Color color, int count, String label})>[
      if (group.needsInputCount > 0)
        (
          id: 'needs-input',
          color: tokens.statusNeedsInput,
          count: group.needsInputCount,
          label: l10n.sessionRosterProjectNeedsInputCount(
            group.needsInputCount,
          ),
        ),
      if (group.workingCount > 0)
        (
          id: 'working',
          color: tokens.statusWorking,
          count: group.workingCount,
          label: l10n.sessionRosterProjectWorkingCount(
            group.workingCount,
          ),
        ),
      if (group.idleCount > 0)
        (
          id: 'idle',
          color: tokens.statusIdle,
          count: group.idleCount,
          label: l10n.sessionRosterProjectIdleCount(group.idleCount),
        ),
    ];
    final projectCountSummary = projectCounts
        .map((projectCount) => projectCount.label)
        .join(' · ');
    return Material(
      color: tokens.surface2,
      // Projects are collapsed by default, so the open/closed state has to be
      // announced, not just drawn as a chevron.
      child: Semantics(
        expanded: !collapsed,
        child: InkWell(
          key: ValueKey('project-header-${group.key}'),
          onTap: onToggleCollapsed,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
            child: Row(
              children: [
                Icon(
                  collapsed ? Icons.chevron_right : Icons.expand_more,
                  key: ValueKey('project-collapse-icon-${group.key}'),
                  size: 20,
                  color: tokens.textSecondary,
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: group.cwd == null
                      ? Text(
                          group.label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.labelLarge?.copyWith(
                            color: tokens.textPrimary,
                            fontWeight: FontWeight.w700,
                          ),
                        )
                      // A project header states where the project is; it is not
                      // a command to run. The copy affordance this used to
                      // carry put an interactive island inside a row whose
                      // only job is to expand, and its tooltip opened a card
                      // over the roster. The path is now non-selectable roster
                      // metadata: a plain `Text`, with no copy affordance and
                      // no selection region anywhere above it.
                      : Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              group.label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.labelLarge?.copyWith(
                                color: tokens.textPrimary,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            Text(
                              group.cwd!,
                              key: ValueKey('project-cwd-${group.key}'),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: tokens.textSecondary,
                                fontFamily: 'monospace',
                              ),
                            ),
                          ],
                        ),
                ),
                Text(
                  '${group.rootCount}',
                  key: ValueKey('project-total-${group.key}'),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: tokens.textSecondary,
                  ),
                ),
                const SizedBox(width: 8),
                Tooltip(
                  key: ValueKey('project-counts-tooltip-${group.key}'),
                  message: projectCountSummary,
                  excludeFromSemantics: true,
                  child: Semantics(
                    key: ValueKey('project-counts-${group.key}'),
                    label: projectCountSummary,
                    container: true,
                    excludeSemantics: true,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        StatusDot(
                          key: ValueKey('project-summary-${group.key}'),
                          color: switch (group.summaryStatus) {
                            SessionStatus.needsInput => tokens.statusNeedsInput,
                            SessionStatus.working => tokens.statusWorking,
                            SessionStatus.idle => tokens.statusIdle,
                          },
                        ),
                        for (
                          var index = 0;
                          index < projectCounts.length;
                          index++
                        ) ...[
                          SizedBox(width: index == 0 ? 8 : 4),
                          _ProjectCount(
                            key: ValueKey(
                              'project-count-${group.key}-'
                              '${projectCounts[index].id}',
                            ),
                            color: projectCounts[index].color,
                            count: projectCounts[index].count,
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
                if (group.readyCount > 0) ...[
                  const SizedBox(width: 8),
                  Tooltip(
                    message: l10n.sessionRosterReadyCount(group.readyCount),
                    child: StatusDot(
                      key: ValueKey('project-ready-${group.key}'),
                      color: tokens.statusError,
                      size: 8,
                    ),
                  ),
                ],
                if (onNew != null || onRename != null)
                  // Opaque so a boundary tap in the 4dp gaps between the
                  // 40x40 targets dies here instead of falling through to the
                  // header collapse toggle. The region stays inside the row —
                  // no invisible slop outside it.
                  GestureDetector(
                    key: ValueKey('project-actions-${group.key}'),
                    behavior: HitTestBehavior.opaque,
                    excludeFromSemantics: true,
                    onTap: () {},
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (onNew != null) ...[
                          const SizedBox(width: 4),
                          _ProjectHeaderIconButton(
                            key: ValueKey('project-new-${group.key}'),
                            tooltip: l10n.sessionRosterNewInProject(
                              group.label,
                            ),
                            icon: Icons.add,
                            iconSize: 20,
                            onPressed: onNew,
                          ),
                        ],
                        if (onRename != null) ...[
                          const SizedBox(width: 4),
                          if (WindowSizeClass.of(context) ==
                              WindowSizeClass.compact)
                            _ProjectHeaderOverflowButton(
                              groupKey: group.key,
                              onRename: onRename!,
                            )
                          else
                            _ProjectHeaderIconButton(
                              key: ValueKey('project-rename-${group.key}'),
                              tooltip: l10n.sessionProjectRename,
                              icon: Icons.edit_outlined,
                              iconSize: 18,
                              onPressed: onRename,
                            ),
                        ],
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A Compact-density project-header action with a contained 40x40 hit target.
///
/// The visual glyph keeps its 18-20px size; the target meets the 40x40 touch
/// minimum (and the 28x28 desktop minimum) without invisible slop outside the
/// box, so stacked collapsed headers can never share tap space.
class _ProjectHeaderIconButton extends StatelessWidget {
  const _ProjectHeaderIconButton({
    required this.tooltip,
    required this.icon,
    required this.iconSize,
    required this.onPressed,
    super.key,
  });

  final String tooltip;
  final IconData icon;
  final double iconSize;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 40,
      height: 40,
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        icon: Icon(icon, size: iconSize),
        style: IconButton.styleFrom(
          padding: EdgeInsets.zero,
          minimumSize: const Size(40, 40),
          maximumSize: const Size(40, 40),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ),
    );
  }
}

/// The single visible overflow for rare project actions on Compact windows.
///
/// Narrow layouts move rename here so `+` keeps clear space, per the reviewed
/// refinement: a visible `⋮` affordance, never swipe or long-press discovery.
class _ProjectHeaderOverflowButton extends StatelessWidget {
  const _ProjectHeaderOverflowButton({
    required this.groupKey,
    required this.onRename,
  });

  final String groupKey;
  final VoidCallback onRename;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return SizedBox(
      width: 40,
      height: 40,
      child: PopupMenuButton<VoidCallback>(
        key: ValueKey('project-overflow-$groupKey'),
        tooltip: l10n.sessionProjectActionsOverflow,
        padding: EdgeInsets.zero,
        position: PopupMenuPosition.under,
        onSelected: (action) => action(),
        itemBuilder: (context) => [
          PopupMenuItem<VoidCallback>(
            key: ValueKey('project-overflow-rename-$groupKey'),
            value: onRename,
            child: Row(
              children: [
                Icon(
                  Icons.edit_outlined,
                  size: 18,
                  color: context.tokens.textSecondary,
                ),
                const SizedBox(width: 12),
                Text(l10n.sessionProjectRename),
              ],
            ),
          ),
        ],
        icon: const Icon(Icons.more_vert, size: 20),
      ),
    );
  }
}

class _ProjectCount extends StatelessWidget {
  const _ProjectCount({
    required this.color,
    required this.count,
    super.key,
  });

  final Color color;
  final int count;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        StatusDot(color: color, size: 8),
        const SizedBox(width: 4),
        Text('$count', style: Theme.of(context).textTheme.labelSmall),
      ],
    );
  }
}

/// Child rows step in by this much per display depth, on the 4-point grid.
const double _kSessionRowIndentStep = 12;

/// Deepest indent a nested row may draw. At the reviewed 320 dp compact-phone
/// width, 3 x 12 dp on top of the 12 dp row inset still leaves the title,
/// status pill and ready dot their room, so deeper trees keep stepping in the
/// data model but stop consuming roster width.
const int _kSessionRowMaxIndentDepth = 3;

class _SessionRow extends StatelessWidget {
  const _SessionRow({
    required this.row,
    required this.readyToReview,
    required this.selected,
    required this.parent,
    required this.onTap,
    required this.onToggleChildren,
    required this.relativeTimeFor,
    super.key,
  });

  final SessionRosterRow row;
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
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final title = session.title.isNotEmpty ? session.title : session.id;
    final indentDepth = row.depth < _kSessionRowMaxIndentDepth
        ? row.depth
        : _kSessionRowMaxIndentDepth;
    final resolvedParent = parent;
    // Adjacency replaced the parent chip, so the relationship is carried in the
    // row's own semantics instead of a second tappable target.
    final lineageLabel = row.depth > 0 && resolvedParent != null
        ? l10n.sessionRosterChildOf(
            resolvedParent.title.isEmpty
                ? resolvedParent.id
                : resolvedParent.title,
          )
        : null;
    final content = Material(
      type: selected ? MaterialType.canvas : MaterialType.transparency,
      color: selected ? tokens.surface2 : null,
      child: InkWell(
        onTap: onTap,
        child: Container(
          decoration: selected
              ? BoxDecoration(
                  border: Border(
                    left: BorderSide(
                      width: 3,
                      color: tokens.accent,
                    ),
                  ),
                )
              : null,
          // The inset lives inside the ink response, so the whole row stays
          // tappable and the tap target still spans the full width.
          padding: EdgeInsets.fromLTRB(
            12 + _kSessionRowIndentStep * indentDepth,
            8,
            12,
            8,
          ),
          child: Row(
            children: [
              StatusDot(
                color: tokens.toolColor(session.tool),
                ringColor: row.effectiveStatus == SessionStatus.needsInput
                    ? tokens.statusNeedsInput
                    : null,
                ringGapColor: row.effectiveStatus == SessionStatus.needsInput
                    ? tokens.surface
                    : null,
                pulse: row.effectiveStatus == SessionStatus.working,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // The roster is navigation, not a document. It carries no
                    // selection machinery at all: no region, and no per-row
                    // island. The row's own InkWell owns the tap, and nothing
                    // here competes with it in the gesture arena.
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: tokens.textPrimary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 4),
                        _subtitle(context, session),
                        if (session.currentAgent case final agent?) ...[
                          const SizedBox(height: 4),
                          Text(
                            agent,
                            key: ValueKey(
                              'session-agent-${sessionRosterKey(session)}',
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: tokens.textSecondary,
                            ),
                          ),
                        ],
                      ],
                    ),
                    if (childCount > 0) ...[
                      const SizedBox(height: 4),
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        children: [
                          ActionChip(
                            key: ValueKey(
                              'session-children-${sessionRosterKey(session)}',
                            ),
                            visualDensity: VisualDensity.compact,
                            tooltip: row.childrenRevealed
                                ? l10n.sessionRosterHideChildren(childCount)
                                : l10n.sessionRosterShowChildren(childCount),
                            avatar: Icon(
                              row.childrenRevealed
                                  ? Icons.expand_less
                                  : Icons.account_tree_outlined,
                            ),
                            label: Text('$childCount'),
                            onPressed: () => onToggleChildren(
                              session,
                              revealed: row.childrenRevealed,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 12),
              if (readyToReview) ...[
                Tooltip(
                  message: l10n.sessionRosterReadyToReview,
                  child: StatusDot(
                    key: ValueKey(
                      'session-ready-${sessionCompositeRosterKey(session)}',
                    ),
                    color: tokens.statusError,
                    size: 8,
                  ),
                ),
                const SizedBox(width: 8),
              ],
              sessionStatusPill(context, row.effectiveStatus),
            ],
          ),
        ),
      ),
    );
    return Semantics(
      key: lineageLabel == null
          ? null
          : ValueKey('session-lineage-${sessionRosterKey(session)}'),
      label: lineageLabel,
      button: true,
      child: content,
    );
  }

  Widget _subtitle(BuildContext context, SessionInfo session) {
    final l10n = AppLocalizations.of(context);
    final parts = <String>[_toolLabel(l10n, session.tool)];
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
    final child = Text(
      parts.join(' · '),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: Theme.of(context).textTheme.bodySmall?.copyWith(
        color: context.tokens.textSecondary,
      ),
    );
    final technicalId = sessionModelTechnicalId(session);
    if (technicalId == null) return child;
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
    return Tooltip(message: tooltip, child: child);
  }
}

String _toolLabel(AppLocalizations l10n, String tool) =>
    switch (tool.toLowerCase()) {
      'claude' => l10n.sessionRosterAgentClaude,
      'codex' => l10n.sessionRosterAgentCodex,
      'opencode' => l10n.sessionRosterAgentOpenCode,
      'pi' => l10n.sessionRosterAgentPi,
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
StatusPill sessionStatusPill(BuildContext context, SessionStatus status) {
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
  return StatusPill(label: label, color: color);
}

class _FilteredEmptyMessage extends StatelessWidget {
  const _FilteredEmptyMessage();

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
