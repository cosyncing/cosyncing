import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/nav_badge_label.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/components/cosyncing_brand_mark.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_freshness.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_pane.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/list/sessions_empty_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_freshness_slot.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_reveal_request.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_window_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_overview.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Which top-level destination the sidebar marks as current.
enum WorkspaceDestination {
  /// A session tab, or nothing the sidebar names.
  none,

  /// The Sessions Overview.
  overview,

  /// The Notifications inbox.
  notifications,

  /// Settings.
  settings,
}

/// The workspace sidebar: brand header, primary destinations, the session
/// roster, and one server-and-settings footer row.
///
/// Metrics follow the approved workspace demo on the 4pt grid. The header row
/// is exactly as tall as the session tab strip beside it so the two read as
/// one band.
class WorkspaceSidebar extends ConsumerWidget {
  /// Creates the sidebar.
  const WorkspaceSidebar({
    required this.width,
    required this.destination,
    required this.drawer,
    required this.unreadCount,
    required this.settingsAttention,
    required this.canCreateSession,
    required this.searchFocusNode,
    required this.onCollapse,
    required this.onNewSession,
    required this.onOverview,
    required this.onNotifications,
    required this.onSettings,
    required this.onServer,
    required this.onOpenSession,
    required this.onRefresh,
    super.key,
  });

  /// Header row height; equal to the tab strip's so the bands line up.
  static const double headerHeight = 52;

  /// Primary destination row height.
  static const double navRowHeight = 40;

  /// Below this width the brand mark drops out of the header.
  static const double compactWidth = 208;

  /// The sidebar's current width.
  final double width;

  /// The destination to mark as current.
  final WorkspaceDestination destination;

  /// Whether the sidebar is shown as a modal drawer.
  final bool drawer;

  /// Unread notification count.
  final int unreadCount;

  /// Whether Settings carries an available client update.
  final bool settingsAttention;

  /// Whether New session can start now.
  final bool canCreateSession;

  /// The roster search field's focus node, owned by the frame.
  final FocusNode searchFocusNode;

  /// Hides the sidebar (collapses it, or closes the drawer).
  final VoidCallback onCollapse;

  /// Starts New session, optionally inside a project.
  final void Function({SessionProjectGroup? project}) onNewSession;

  /// Shows the Overview.
  final VoidCallback onOverview;

  /// Opens Notifications.
  final VoidCallback onNotifications;

  /// Opens Settings.
  final VoidCallback onSettings;

  /// Opens the server settings.
  final VoidCallback onServer;

  /// Opens a roster session.
  final ValueChanged<SessionRef> onOpenSession;

  /// The freshness slot's explicit refresh.
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final listState = ref.watch(sessionListControllerProvider);
    return Material(
      color: tokens.sidebar,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: headerHeight,
              child: Row(
                children: [
                  const SizedBox(width: 4),
                  if (width >= compactWidth) ...[
                    const CosyncingBrandMark(),
                    const SizedBox(width: 8),
                  ],
                  Expanded(
                    child: Text(
                      'cosyncing',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.8,
                        color: tokens.textPrimary,
                      ),
                    ),
                  ),
                  // R0b: the same slot, in the same top-right position, that
                  // Compact renders — so a rotation or resize never moves it
                  // and never leaves two indicators describing one transition.
                  RosterFreshnessSlot(
                    presentation: RosterFreshnessPresentation.fromListState(
                      listState,
                    ),
                    onRefresh: onRefresh,
                  ),
                  _SidebarIconButton(
                    key: const Key('workspace-roster-collapse'),
                    tooltip: l10n.workspaceHideSidebar,
                    glyph: StrokeGlyph.panel,
                    onPressed: onCollapse,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            _SidebarNavRow(
              key: const Key('sessions-workspace-global-new'),
              glyph: StrokeGlyph.compose,
              label: l10n.newSessionTitle,
              emphasized: true,
              onTap: canCreateSession ? onNewSession : null,
            ),
            const SizedBox(height: 4),
            _SidebarNavRow(
              key: const Key('sessions-workspace-overview'),
              glyph: StrokeGlyph.overview,
              label: l10n.workspaceOverview,
              selected: destination == WorkspaceDestination.overview,
              onTap: onOverview,
            ),
            const SizedBox(height: 4),
            _SidebarNavRow(
              key: const Key('sessions-workspace-attention'),
              glyph: StrokeGlyph.bell,
              label: l10n.notificationsTitle,
              selected: destination == WorkspaceDestination.notifications,
              trailing: unreadCount > 0 ? navBadgeLabel(unreadCount) : null,
              onTap: onNotifications,
            ),
            const SizedBox(height: 16),
            Expanded(
              child: _SidebarRoster(
                listState: listState,
                searchFocusNode: searchFocusNode,
                canCreateSession: canCreateSession,
                onNewSession: onNewSession,
                onOpenSession: onOpenSession,
                onRefresh: onRefresh,
              ),
            ),
            _SidebarFooter(
              settingsAttention: settingsAttention,
              selected: destination == WorkspaceDestination.settings,
              onServer: onServer,
              onSettings: onSettings,
            ),
          ],
        ),
      ),
    );
  }
}

/// The roster region: search, filters and the project list.
class _SidebarRoster extends ConsumerWidget {
  const _SidebarRoster({
    required this.listState,
    required this.searchFocusNode,
    required this.canCreateSession,
    required this.onNewSession,
    required this.onOpenSession,
    required this.onRefresh,
  });

  final SessionListState listState;
  final FocusNode searchFocusNode;
  final bool canCreateSession;
  final void Function({SessionProjectGroup? project}) onNewSession;
  final ValueChanged<SessionRef> onOpenSession;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final hasActiveBrokerClient = ref
        .watch(brokerClientProvider)
        .maybeWhen(data: (client) => client != null, orElse: () => false);
    final source = RosterSource.of(ref.watch(activeBrokerProfileProvider));
    final creationAvailability = ref
        .watch(sessionCreationReadyProvider)
        .availabilityFor(source);
    // Null while the stored preference rehydrates — never the shipped default.
    // Substituting it here named a window the reader had already changed.
    final queryWindow = ref.watch(sessionRosterWindowProvider).valueOrNull;
    // A narrowing window owns the sentence. "No sessions on this server yet"
    // is a claim about the server, and the roster asked about seven days — so
    // on a machine whose newest session is three weeks old that sentence was
    // simply false, and it pointed at New Session instead of at the filter
    // that was hiding everything.
    final emptyWindowMessage = sessionsEmptyWindowBody(l10n, queryWindow);
    final emptyRosterMessage =
        emptyWindowMessage ??
        switch (creationAvailability) {
          SessionCreationAvailability.checking =>
            l10n.sessionsWorkspaceEmptyCreationChecking,
          SessionCreationAvailability.available => l10n.sessionsWorkspaceEmpty,
          SessionCreationAvailability.unavailable =>
            l10n.sessionsWorkspaceEmptyCreationUnavailable,
          SessionCreationAvailability.failed =>
            l10n.sessionsWorkspaceEmptyCreationCheckFailed,
        };
    final onShowAllSessions = emptyWindowMessage == null
        ? null
        : () => unawaited(
            ref
                .read(sessionRosterWindowProvider.notifier)
                .setWindow(SessionRosterQueryWindow.any),
          );
    final activeKey = ref.watch(
      openSessionsControllerProvider.select(
        (open) => open.valueOrNull?.activeKey,
      ),
    );
    final revealRequest = ref.watch(sessionRosterRevealRequestProvider);
    return SessionListPane(
      unreadCompletionKeys: ref.watch(workspaceUnreadCompletionKeysProvider),
      searchFocusNode: searchFocusNode,
      // The activity control displays its default while loading. The
      // explanatory copy waits for the actual query window.
      queryWindow: queryWindow ?? SessionRosterQueryWindow.last7Days,
      onQueryWindowChanged: (window) => unawaited(
        ref.read(sessionRosterWindowProvider.notifier).setWindow(window),
      ),
      sessions: ref.watch(rosterSessionsProvider),
      status: listState.status,
      error: listState.error,
      cachedRoster: listState.cachedRoster,
      activeKey: activeKey,
      revealRequest:
          revealRequest?.sourceKey == source?.storageKey &&
              revealRequest?.sessionKey == activeKey
          ? revealRequest
          : null,
      onOpen: (session) => onOpenSession(SessionRef.fromSession(session)),
      // A cached row opens on its exact identity, with the tab's status left
      // explicitly UNKNOWN — the snapshot stores no activity, so there is
      // nothing truthful to put there. `refreshMetadata` fills it in as soon
      // as the authoritative roster lands.
      onOpenCached: (identity) => onOpenSession(
        SessionRef.cachedIdentity(
          tool: identity.tool,
          id: identity.sessionId,
          title: identity.title.isNotEmpty
              ? identity.title
              : identity.sessionId,
        ),
      ),
      onNewProject: canCreateSession
          ? (project) => onNewSession(project: project)
          : null,
      onRenameProject: (project) =>
          unawaited(renameProjectAliasFromList(context, ref, project)),
      onRetry: onRefresh,
      emptyState: _RosterMessage(
        icon: Icons.inbox_outlined,
        message: !hasActiveBrokerClient
            ? l10n.sessionsEmptyBody
            : emptyRosterMessage,
        // Offered only when a window is what emptied the roster, and only
        // against a live server: with no client there is nothing to widen the
        // query against.
        actionLabel: hasActiveBrokerClient && onShowAllSessions != null
            ? l10n.sessionsEmptyWindowAction
            : null,
        onAction: hasActiveBrokerClient ? onShowAllSessions : null,
      ),
    );
  }
}

/// One primary destination row.
class _SidebarNavRow extends StatelessWidget {
  const _SidebarNavRow({
    required this.glyph,
    required this.label,
    required this.onTap,
    this.selected = false,
    this.emphasized = false,
    this.trailing,
    super.key,
  });

  final StrokeGlyph glyph;
  final String label;
  final VoidCallback? onTap;
  final bool selected;
  final bool emphasized;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final enabled = onTap != null;
    final color = !enabled
        ? tokens.textTertiary
        : selected || emphasized
        ? tokens.textPrimary
        : tokens.textSecondary;
    final radius = BorderRadius.circular(tokens.radiusMd);
    final badge = trailing;
    return Semantics(
      button: true,
      selected: selected,
      enabled: enabled,
      child: Material(
        color: selected ? tokens.surfaceHover : Colors.transparent,
        borderRadius: radius,
        child: InkWell(
          borderRadius: radius,
          hoverColor: tokens.surfaceHover,
          onTap: onTap,
          child: SizedBox(
            height: WorkspaceSidebar.navRowHeight,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  StrokeIcon(glyph, color: color),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: color,
                        fontWeight: selected ? FontWeight.w700 : null,
                      ),
                    ),
                  ),
                  if (badge != null)
                    Text(
                      badge,
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: tokens.textSecondary,
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The footer: the server this client is showing, and Settings, on one row.
class _SidebarFooter extends ConsumerWidget {
  const _SidebarFooter({
    required this.settingsAttention,
    required this.selected,
    required this.onServer,
    required this.onSettings,
  });

  final bool settingsAttention;
  final bool selected;
  final VoidCallback onServer;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final profile = ref.watch(activeBrokerProfileProvider);
    final status = ref.watch(
      sessionListControllerProvider.select((state) => state.status),
    );
    final sessionCount = ref.watch(
      rosterSessionsProvider.select((sessions) => sessions.length),
    );
    final subtitle = profile == null
        ? null
        : switch (status) {
            SessionListStatus.loaded => l10n.workspaceServerSessionCount(
              sessionCount,
            ),
            SessionListStatus.error => l10n.sessionControlUnavailable,
            _ => l10n.connectionConnecting,
          };
    final radius = BorderRadius.circular(tokens.radiusMd);
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 12),
      child: Row(
        children: [
          Expanded(
            child: Material(
              color: Colors.transparent,
              borderRadius: radius,
              child: InkWell(
                key: const Key('workspace-server-row'),
                borderRadius: radius,
                hoverColor: tokens.surfaceHover,
                onTap: onServer,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 44),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 4,
                    ),
                    child: Row(
                      children: [
                        StrokeIcon(
                          StrokeGlyph.monitor,
                          color: tokens.textPrimary,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                profile?.displayName ?? l10n.workspaceNoMachine,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.labelMedium?.copyWith(
                                  color: tokens.textPrimary,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              if (subtitle != null)
                                Text(
                                  subtitle,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.labelSmall?.copyWith(
                                    color: tokens.textTertiary,
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 4),
          _SidebarIconButton(
            key: const Key('sessions-workspace-settings'),
            tooltip: l10n.settingsTitle,
            glyph: StrokeGlyph.settings,
            selected: selected,
            badge: settingsAttention,
            semanticLabel: settingsAttention
                ? l10n.settingsClientUpdateAvailableSemantics
                : null,
            onPressed: onSettings,
          ),
        ],
      ),
    );
  }
}

/// A 32dp line-icon button for sidebar chrome.
class _SidebarIconButton extends StatelessWidget {
  const _SidebarIconButton({
    required this.tooltip,
    required this.glyph,
    required this.onPressed,
    this.selected = false,
    this.badge = false,
    this.semanticLabel,
    super.key,
  });

  final String tooltip;
  final StrokeGlyph glyph;
  final VoidCallback? onPressed;
  final bool selected;
  final bool badge;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      style: IconButton.styleFrom(
        padding: EdgeInsets.zero,
        visualDensity: VisualDensity.standard,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        minimumSize: const Size.square(32),
        maximumSize: const Size.square(32),
        backgroundColor: selected ? tokens.surfaceHover : null,
        hoverColor: tokens.surfaceHover,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(tokens.radiusMd),
        ),
      ),
      icon: Semantics(
        label: semanticLabel,
        child: Badge(
          isLabelVisible: badge,
          child: StrokeIcon(
            glyph,
            color: selected ? tokens.textPrimary : tokens.textSecondary,
          ),
        ),
      ),
    );
  }
}

/// A centered icon + message for the roster's empty state.
class _RosterMessage extends StatelessWidget {
  const _RosterMessage({
    required this.icon,
    required this.message,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String message;

  /// Optional way out of the state the message describes. Rendered only when
  /// both this and [onAction] are present.
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final label = actionLabel;
    final action = onAction;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: tokens.textTertiary),
            const SizedBox(height: 12),
            SelectableText(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: tokens.textSecondary),
            ),
            if (label != null && action != null) ...[
              const SizedBox(height: 12),
              FilledButton.tonalIcon(
                key: const Key('workspace-empty-show-all'),
                onPressed: action,
                icon: const Icon(Icons.history),
                label: Text(label),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
