import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox_presentation.dart';
import 'package:cosyncing_client/src/features/attention/view/attention_event_copy.dart';
import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/relative_time.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_presentation.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_frame.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_logo.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Durable, multi-broker Attention inbox.
///
/// See `docs/architecture/client-ui.md`.
class AttentionPage extends ConsumerStatefulWidget {
  /// Creates the Attention destination.
  const AttentionPage({this.showSessionsBack = false, super.key});

  /// Shows contextual navigation back to the wide Sessions workspace.
  final bool showSessionsBack;

  @override
  ConsumerState<AttentionPage> createState() => _AttentionPageState();
}

enum _PendingFilter { all, input, completion, urgent }

enum _ActivityAction { read, clear, refresh }

class _AttentionPageState extends ConsumerState<AttentionPage> {
  bool _clearing = false;
  bool _reading = false;
  bool _unreadOnly = false;
  _PendingFilter _pendingFilter = _PendingFilter.all;
  final GlobalKey<State<StatefulWidget>> _activityKey = GlobalKey();
  final _activityFocus = FocusNode();
  final Set<String> _hiddenSnapshots = {};

  @override
  void dispose() {
    _activityFocus.dispose();
    super.dispose();
  }

  static String _snapshotKey(AttentionInboxEntry entry) =>
      '${RosterSource.ofProfile(entry.profile).storageKey}/${entry.event.id}/${entry.event.revision}';

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final inbox = ref.watch(attentionInboxProvider);
    ref.watch(attentionInboxSeenRuntimeProvider);
    return Scaffold(
      appBar: AppBar(
        leading: widget.showSessionsBack
            ? IconButton(
                key: const Key('attention-back-to-sessions'),
                tooltip: l10n.attentionPageBackToSessions,
                onPressed: () => context.go(sessionsRoute),
                icon: const Icon(Icons.arrow_back),
              )
            : WorkspaceFrameScope.menuButton(context),
        title: SelectionArea(child: Text(l10n.attentionPageTitle)),
        actions: [
          IconButton(
            tooltip: l10n.settingsCategoryNotificationsTitle,
            onPressed: () => context.push(notificationSettingsRoute),
            icon: const Icon(Icons.settings_outlined),
          ),
          IconButton(
            key: const Key('attention-refresh'),
            tooltip: l10n.attentionPageRefresh,
            onPressed: () => ref.invalidate(attentionInboxProvider),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: inbox.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => _AttentionError(
          message: localizedFailureMessage(
            l10n,
            error,
            lead: l10n.attentionInboxLoadFailed,
          ),
          onRetry: () => ref.invalidate(attentionInboxProvider),
        ),
        data: _buildInbox,
      ),
    );
  }

  Widget _buildInbox(AttentionInboxSections sections) {
    final l10n = AppLocalizations.of(context);
    final t = context.tokens;
    if (sections.all.isEmpty) return const _EmptyAttentionInbox();
    final groups = AttentionInboxPresentation(sections);
    final activity = groups.activity
        .where(
          (entry) =>
              !_hiddenSnapshots.contains(_snapshotKey(entry)) &&
              (!_unreadOnly || entry.isUnread),
        )
        .toList(growable: false);
    final activityUnread = groups.activity
        .where(
          (entry) =>
              entry.isUnread && !_hiddenSnapshots.contains(_snapshotKey(entry)),
        )
        .length;
    final showInput =
        _pendingFilter == _PendingFilter.all ||
        _pendingFilter == _PendingFilter.input;
    final showCompletion =
        _pendingFilter == _PendingFilter.all ||
        _pendingFilter == _PendingFilter.completion;
    final showUrgent =
        _pendingFilter == _PendingFilter.all ||
        _pendingFilter == _PendingFilter.urgent;
    // One name per bucket, shared with the Overview's counts: waiting for you,
    // unread completions, and problems (failed runs and security or server
    // alerts, never requests).
    final pendingLabels = {
      _PendingFilter.all: l10n.inboxEnhancementAllPending,
      _PendingFilter.input: l10n.inboxEnhancementInput,
      _PendingFilter.completion: l10n.inboxEnhancementCompletions,
      _PendingFilter.urgent: l10n.attentionPageProblems,
    };
    return RefreshIndicator(
      onRefresh: () async {
        ref.invalidate(attentionInboxProvider);
        await ref.read(attentionInboxProvider.future);
      },
      child: SingleChildScrollView(
        key: const Key('attention-inbox-list'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: EdgeInsets.fromLTRB(
          MediaQuery.sizeOf(context).width < 600 ? 12 : 24,
          16,
          MediaQuery.sizeOf(context).width < 600 ? 12 : 24,
          32,
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 960),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Align(
                  alignment: AlignmentDirectional.centerEnd,
                  child: TextButton.icon(
                    key: const Key('attention-jump-activity'),
                    onPressed: () {
                      final target = _activityKey.currentContext;
                      if (target != null) {
                        Scrollable.ensureVisible(target);
                        _activityFocus.requestFocus();
                      }
                    },
                    label: Text(l10n.inboxEnhancementJumpActivity),
                    icon: const Icon(Icons.south, size: 16),
                  ),
                ),
                Wrap(
                  alignment: WrapAlignment.spaceBetween,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 16,
                  runSpacing: 8,
                  children: [
                    // The selected filter and its count, as the Overview's
                    // queue heading reads: no union name of its own.
                    SectionHeader(
                      l10n.inboxEnhancementPendingHeader(
                        pendingLabels[_pendingFilter]!,
                        switch (_pendingFilter) {
                          _PendingFilter.all => groups.pendingCount,
                          _PendingFilter.input => groups.requests.length,
                          _PendingFilter.completion =>
                            groups.completions.length,
                          _PendingFilter.urgent => groups.urgent.length,
                        },
                      ),
                      color: t.textPrimary,
                      padding: EdgeInsets.zero,
                    ),
                    SizedBox(
                      width: 280,
                      child: DropdownButton<_PendingFilter>(
                        isExpanded: true,
                        key: const Key('attention-pending-filter'),
                        value: _pendingFilter,
                        underline: const SizedBox.shrink(),
                        onChanged: (value) {
                          if (value != null) {
                            setState(() => _pendingFilter = value);
                          }
                        },
                        items: [
                          for (final entry in pendingLabels.entries)
                            DropdownMenuItem(
                              value: entry.key,
                              child: Text(
                                entry.value,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                if (groups.pendingCount == 0)
                  Text(
                    l10n.inboxEnhancementNoPending,
                    style: Theme.of(
                      context,
                    ).textTheme.bodyMedium?.copyWith(color: t.textSecondary),
                  ),
                if (showInput && groups.requests.isNotEmpty)
                  _AttentionSection(
                    title: l10n.inboxEnhancementInput,
                    entries: groups.requests,
                    accent: t.statusNeedsInput,
                  ),
                if (showCompletion && groups.completions.isNotEmpty)
                  _AttentionSection(
                    title: l10n.inboxEnhancementCompletions,
                    entries: groups.completions,
                    accent: t.statusError,
                  ),
                if (showUrgent && groups.urgent.isNotEmpty)
                  _AttentionSection(
                    title: l10n.attentionPageProblems,
                    entries: groups.urgent,
                    accent: t.statusError,
                  ),
                const SizedBox(height: 24),
                Focus(
                  key: _activityKey,
                  focusNode: _activityFocus,
                  child: Semantics(
                    header: true,
                    child: SectionHeader(
                      l10n.inboxEnhancementRecentActivity(activityUnread),
                      color: t.textPrimary,
                      padding: EdgeInsets.zero,
                    ),
                  ),
                ),
                Wrap(
                  alignment: WrapAlignment.spaceBetween,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 8,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Checkbox(
                          key: const Key('attention-unread-filter'),
                          value: _unreadOnly,
                          onChanged: (value) =>
                              setState(() => _unreadOnly = value ?? false),
                        ),
                        GestureDetector(
                          onTap: () =>
                              setState(() => _unreadOnly = !_unreadOnly),
                          child: Text(l10n.inboxEnhancementUnread),
                        ),
                      ],
                    ),
                    PopupMenuButton<_ActivityAction>(
                      key: const Key('attention-activity-actions'),
                      tooltip: l10n.inboxEnhancementActivityActions,
                      onSelected: (action) {
                        switch (action) {
                          case _ActivityAction.read:
                            _markRead(activity);
                          case _ActivityAction.clear:
                            _clearActivity(activity);
                          case _ActivityAction.refresh:
                            ref.invalidate(attentionInboxProvider);
                        }
                      },
                      itemBuilder: (_) => [
                        PopupMenuItem(
                          value: _ActivityAction.read,
                          enabled:
                              !_reading &&
                              activity.any((entry) => entry.isUnread),
                          child: Text(l10n.inboxEnhancementMarkAllRead),
                        ),
                        PopupMenuItem(
                          key: const Key('attention-clear-all'),
                          value: _ActivityAction.clear,
                          enabled: !_clearing && activity.isNotEmpty,
                          child: Text(l10n.inboxEnhancementClearActivity),
                        ),
                        PopupMenuItem(
                          value: _ActivityAction.refresh,
                          child: Text(l10n.attentionPageRefresh),
                        ),
                      ],
                      icon: const Icon(Icons.more_horiz),
                    ),
                  ],
                ),
                if (activity.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    child: Text(
                      l10n.inboxEnhancementNoActivity,
                      style: Theme.of(
                        context,
                      ).textTheme.bodyMedium?.copyWith(color: t.textSecondary),
                    ),
                  ),
                for (final entry in activity)
                  _AttentionEventCard(
                    entry: entry,
                    accent: t.accent,
                    activity: true,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _markRead(List<AttentionInboxEntry> snapshot) async {
    if (_reading) return;
    setState(() => _reading = true);
    final actions = ref.read(attentionInboxActionsProvider);
    var pendingSync = false;
    for (final entry in snapshot.where((entry) => entry.isUnread)) {
      try {
        await actions.acknowledge(entry);
      } on Object {
        pendingSync = true;
      }
    }
    if (!mounted) return;
    setState(() => _reading = false);
    if (pendingSync) {
      _showMessage(
        AppLocalizations.of(context).attentionSavedLocallySyncPending,
      );
    }
  }

  Future<void> _clearActivity(List<AttentionInboxEntry> snapshot) async {
    if (_clearing || snapshot.isEmpty) return;
    final l10n = AppLocalizations.of(context);
    final actions = ref.read(attentionInboxActionsProvider);
    final keys = snapshot.map(_snapshotKey).toSet();
    setState(() {
      _clearing = true;
      _hiddenSnapshots.addAll(keys);
    });
    // Delay durable dismissal until Undo expires. The existing broker API has
    // no undismiss operation; reversing a completed sync would be dishonest.
    var undone = false;
    final notice = ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(l10n.inboxEnhancementActivityCleared),
        duration: const Duration(seconds: 5),
        persist: MediaQuery.accessibleNavigationOf(context),
        showCloseIcon: true,
        action: SnackBarAction(
          label: l10n.inboxEnhancementUndo,
          onPressed: () {
            undone = true;
          },
        ),
      ),
    );
    await notice.closed;
    if (undone) {
      if (mounted) {
        setState(() {
          _hiddenSnapshots.removeAll(keys);
          _clearing = false;
        });
      }
      return;
    }
    try {
      final result = await actions.clearAll(
        AttentionInboxSections(
          actionRequired: const [],
          maintenance: const [],
          resolved: snapshot,
        ),
      );
      if (mounted && result.hasPendingSync) {
        _showMessage(
          AppLocalizations.of(context).attentionSavedLocallySyncPending,
        );
      }
    } on Object {
      if (mounted) {
        _showMessage(AppLocalizations.of(context).attentionPageClearFailed);
      }
    } finally {
      if (mounted) {
        setState(() {
          _hiddenSnapshots.removeAll(keys);
          _clearing = false;
        });
      }
    }
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }
}

class _AttentionSection extends StatelessWidget {
  const _AttentionSection({
    required this.title,
    required this.entries,
    required this.accent,
  });
  final String title;
  final List<AttentionInboxEntry> entries;
  final Color accent;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            StatusDot(color: accent, size: 8),
            const SizedBox(width: 8),
            Expanded(
              child: SectionHeader(
                title,
                padding: EdgeInsets.zero,
                color: context.tokens.textPrimary,
              ),
            ),
            Text(
              '${entries.length}',
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ],
        ),
        const SizedBox(height: 12),
        for (final entry in entries)
          _AttentionEventCard(entry: entry, accent: accent),
      ],
    ),
  );
}

class _AttentionEventCard extends ConsumerWidget {
  const _AttentionEventCard({
    required this.entry,
    required this.accent,
    this.activity = false,
  });

  final AttentionInboxEntry entry;
  final Color accent;
  final bool activity;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final event = entry.event;
    final tokens = context.tokens;
    final metadata = _metadata(context, ref);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        key: Key('attention-event-${event.id}'),
        color: tokens.canvas,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(tokens.radiusMd),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(tokens.radiusMd),
          onTap: () => _open(context, ref),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: event.agent != null
                      ? UsageAgentLogo(tool: event.agent!, size: 20)
                      : Icon(
                          Icons.notifications_outlined,
                          color: accent,
                          size: 20,
                        ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SelectionArea(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    _eventTitle(context, event),
                                    style:
                                        Theme.of(
                                          context,
                                        ).textTheme.bodyMedium?.copyWith(
                                          fontWeight: FontWeight.w600,
                                        ),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  _relativeTime(context, event.updatedAt),
                                  style: Theme.of(context).textTheme.labelSmall
                                      ?.copyWith(color: tokens.textSecondary),
                                ),
                              ],
                            ),
                            const SizedBox(height: 4),
                            Text(
                              metadata,
                              style:
                                  Theme.of(
                                    context,
                                  ).textTheme.labelMedium?.copyWith(
                                    color: tokens.textSecondary,
                                  ),
                            ),
                            if (event.summary?.trim().isNotEmpty ?? false) ...[
                              const SizedBox(height: 8),
                              Text(
                                event.summary!.trim(),
                                maxLines: 3,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context).textTheme.bodyMedium,
                              ),
                            ],
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          TextButton.icon(
                            onPressed: () => _open(context, ref),
                            icon: const Icon(Icons.open_in_new, size: 16),
                            label: Text(
                              event.isQuestionRequired ||
                                      event.isPermissionRequired
                                  ? AppLocalizations.of(
                                      context,
                                    ).inboxEnhancementReply
                                  : event.isRunFinished || event.isGoalFinished
                                  ? AppLocalizations.of(
                                      context,
                                    ).inboxEnhancementReview
                                  : AppLocalizations.of(
                                      context,
                                    ).foregroundAttentionOpen,
                            ),
                          ),
                          if (activity && entry.isUnread)
                            TextButton.icon(
                              onPressed: () => _markRead(context, ref),
                              icon: const Icon(Icons.done, size: 16),
                              label: Text(
                                AppLocalizations.of(
                                  context,
                                ).inboxEnhancementMarkRead,
                              ),
                            ),
                          if (activity)
                            TextButton.icon(
                              onPressed: () => _dismiss(context, ref),
                              icon: const Icon(Icons.close, size: 16),
                              label: Text(
                                AppLocalizations.of(
                                  context,
                                ).attentionPageDismiss,
                              ),
                            ),
                        ],
                      ),
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

  String _metadata(BuildContext context, WidgetRef ref) {
    final event = entry.event;
    final parts = <String>[];
    String? parentTitle;
    // Reuse an already-owned roster; opening the inbox must not start another
    // roster client merely to decorate notifications from other servers.
    final container = ProviderScope.containerOf(context, listen: false);
    if (container.exists(sessionListControllerProvider)) {
      final roster = ref.watch(sessionListControllerProvider);
      if (roster.source == RosterSource.ofProfile(entry.profile)) {
        final tool = event.action.tool ?? event.agent;
        final id = event.action.sessionId ?? event.sessionId;
        final session = roster.sessions
            .where((row) => row.tool == tool && row.id == id)
            .firstOrNull;
        if (session != null) {
          if (session.projectName?.trim().isNotEmpty ?? false) {
            parts.add(session.projectName!.trim());
          }
          final parent = SessionRosterLineage.build(
            roster.sessions,
          ).parentFor(session);
          if (parent != null) {
            parentTitle = knownSessionTitle([
              parent.title,
            ], sessionId: parent.id);
          }
        } else {
          final rows = roster.cachedRoster?.snapshot.rows;
          final cached = rows
              ?.where((row) => row.tool == tool && row.sessionId == id)
              .firstOrNull;
          if (cached != null) {
            if (cached.projectName?.trim().isNotEmpty ?? false) {
              parts.add(cached.projectName!.trim());
            }
            final parentId = cached.parentThreadId;
            if (parentId != null) {
              final parent = rows
                  ?.where(
                    (row) =>
                        row.tool == tool &&
                        row.machine == cached.machine &&
                        (row.nativeId == parentId || row.sessionId == parentId),
                  )
                  .firstOrNull;
              if (parent != null) {
                parentTitle = knownSessionTitle([
                  parent.title,
                ], sessionId: parent.sessionId);
              }
            }
          }
        }
      }
    }
    if (event.agent?.trim().isNotEmpty ?? false) {
      final l10n = AppLocalizations.of(context);
      parts.add(switch (event.agent!.toLowerCase()) {
        'codex' => l10n.sessionRosterAgentCodex,
        'claude' => l10n.sessionRosterAgentClaude,
        'opencode' => l10n.sessionRosterAgentOpenCode,
        'pi' => l10n.sessionRosterAgentPi,
        'agy' => l10n.sessionRosterAgentAntigravity,
        _ => event.agent!,
      });
    }
    parts.add(entry.profile.displayName);
    if (parentTitle != null) {
      parts.add(
        AppLocalizations.of(context).inboxEnhancementSubagentOf(parentTitle),
      );
    }
    return parts.join(' · ');
  }

  Future<void> _open(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(attentionInboxActionsProvider).acknowledge(entry);
    } on Object catch (_) {
      if (context.mounted) _showSyncWarning(context);
    }
    if (!context.mounted) return;
    await ref
        .read(brokerProfileManagerControllerProvider)
        .setActiveProfile(
          entry.profile.id,
          expectedProfile: entry.profile,
        );
    if (!context.mounted) return;
    final action = entry.event.action;
    if (action.isOpenSession &&
        action.tool != null &&
        action.sessionId != null) {
      context.go(
        sessionDetailLocation(
          tool: action.tool!,
          sessionId: action.sessionId!,
        ),
      );
      return;
    }
    if (action.isOpenRuntimeSettings || action.isOpenQuotaSettings) {
      context.go(agentsSettingsRoute);
    } else if (action.isOpenBrokerHealth) {
      context.go(brokerDevicesSettingsRoute);
    }
  }

  Future<void> _markRead(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(attentionInboxActionsProvider).acknowledge(entry);
    } on Object {
      if (context.mounted) _showSyncWarning(context);
    }
  }

  Future<void> _dismiss(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(attentionInboxActionsProvider).dismiss(entry);
    } on Object catch (_) {
      if (context.mounted) _showSyncWarning(context);
    }
  }

  void _showSyncWarning(BuildContext context) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          AppLocalizations.of(context).attentionSavedLocallySyncPending,
        ),
      ),
    );
  }

  static String _fallbackTitle(BuildContext context, String kind) {
    final l10n = AppLocalizations.of(context);
    return switch (kind) {
      'scheduled-send' => l10n.attentionPageScheduledSent,
      'scheduled-send-failed' => l10n.attentionPageScheduledFailed,
      'unknown' || '' => l10n.attentionPageFallbackTitle,
      _ => l10n.attentionPageFallbackTitle,
    };
  }

  static String _eventTitle(BuildContext context, AttentionEvent event) {
    final sessionId = event.action.sessionId ?? event.sessionId;
    if (sessionId != null &&
        sessionId.trim().isNotEmpty &&
        (event.isPermissionRequired ||
            event.isQuestionRequired ||
            event.isGoalFinished ||
            event.isRunFinished ||
            event.isRunFailed ||
            event.isSyncDegraded)) {
      return attentionSessionEventTitle(event, AppLocalizations.of(context));
    }
    return event.title.trim().isEmpty
        ? _fallbackTitle(context, event.kind)
        : event.title.trim();
  }

  static String _relativeTime(BuildContext context, int epochMs) {
    final l10n = AppLocalizations.of(context);
    return relativeTimeLabel(
      context,
      l10n,
      epochMs,
      now: DateTime.now(),
    );
  }
}

class _EmptyAttentionInbox extends StatelessWidget {
  const _EmptyAttentionInbox();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.notifications_none_rounded,
                size: 52,
                color: tokens.accent,
              ),
              const SizedBox(height: 16),
              SelectionArea(
                child: Column(
                  children: [
                    Text(
                      l10n.attentionPageEmptyTitle,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      l10n.attentionPageEmptyBody,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: tokens.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AttentionError extends StatelessWidget {
  const _AttentionError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 40),
            const SizedBox(height: 12),
            SelectableText(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            FilledButton(onPressed: onRetry, child: Text(l10n.retry)),
          ],
        ),
      ),
    );
  }
}
