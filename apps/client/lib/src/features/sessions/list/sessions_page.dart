import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/app/shortcuts/app_shortcuts.dart';
import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_sheet.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_freshness.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_pane.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/sessions_empty_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/machine_roster_controller.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_freshness_slot.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_window_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Session list screen.
///
/// Displays broker sessions with status badges, loading/empty/error states,
/// and pull-to-refresh. Consumes [SessionListController] for state.
///
/// References:
/// - `docs/architecture/monorepo.md`
/// - `docs/protocol/contract-sync.md`
/// - `docs/architecture/client-ui.md`
class SessionsPage extends ConsumerStatefulWidget {
  /// Creates the [SessionsPage].
  const SessionsPage({super.key});

  @override
  ConsumerState<SessionsPage> createState() => _SessionsPageState();
}

class _SessionsPageState extends ConsumerState<SessionsPage> {
  NewSessionLaunchRequest? _newSessionLaunch;

  /// Owned here, handed to the roster pane, so the search chord has something
  /// to focus. The pane rebuilds constantly; a node owned by it would be
  /// unreachable from the binding site.
  final FocusNode _searchFocusNode = FocusNode(debugLabel: 'roster-search');

  @override
  void dispose() {
    _searchFocusNode.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    // Trigger initial load after the first frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        ref.read(sessionListControllerProvider.notifier).load();
        ref.read(machineRosterControllerProvider.notifier).load();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    // The active broker profile hydrates asynchronously — notably the web
    // same-origin "this server" default (selectSameOriginBrokerProfile). The
    // initial post-frame load() can win the race against it and read a
    // still-null broker client, falling back to the empty in-memory roster and
    // never retrying. Reload once a real client is available so the roster
    // fills in without a manual refresh.
    ref.listen(brokerClientProvider, (previous, next) {
      final hadClient = previous?.valueOrNull != null;
      final hasClient = next.valueOrNull != null;
      if (!hadClient && hasClient && mounted) {
        ref.read(sessionListControllerProvider.notifier).load();
        ref.read(machineRosterControllerProvider.notifier).load();
      }
    });

    final state = ref.watch(sessionListControllerProvider);
    // R0b: membership/metadata from the list controller, Working/Idle from the
    // single status owner — the same rows the Expanded workspace renders.
    final sessions = ref.watch(rosterSessionsProvider);
    final freshness = RosterFreshnessPresentation.fromListState(state);
    final machineState = ref.watch(machineRosterControllerProvider);
    final hasActiveBrokerClient = ref
        .watch(brokerClientProvider)
        .maybeWhen(data: (client) => client != null, orElse: () => false);
    final activeSource = RosterSource.of(
      ref.watch(activeBrokerProfileProvider),
    );
    final creationAvailability = ref
        .watch(sessionCreationReadyProvider)
        .availabilityFor(activeSource);
    final canCreateSession =
        creationAvailability == SessionCreationAvailability.available;

    return AppCallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.f5): appShortcutAlways(
          _loadSessions,
        ),
        const SingleActivator(LogicalKeyboardKey.keyR, control: true):
            appShortcutAlways(_loadSessions),
        const SingleActivator(LogicalKeyboardKey.keyR, meta: true):
            appShortcutAlways(_loadSessions),
        ...appShortcutBindings(
          specs: appShortcutsForScope(AppShortcutScope.sessionList),
          handlers: {AppShortcutId.focusRosterSearch: _focusRosterSearch},
        ),
        // The compact roster is a place a new session is started from, so it
        // binds the registry's new-session chord to the same sheet the button
        // opens. The wide workspace already did; compact advertised the chord
        // on the help page and did nothing with it.
        ...appShortcutBindings(
          specs: appShortcutsForScope(AppShortcutScope.workspace),
          handlers: {
            if (canCreateSession && _newSessionLaunch == null)
              AppShortcutId.newSession: () => unawaited(_openNewSession()),
          },
        ),
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          appBar: AppBar(
            title: Text(l10n.sessionsTitle),
            actions: [
              IconButton(
                key: const Key('sessions-machines'),
                tooltip: l10n.sessionsMachineTitle,
                onPressed: () => unawaited(_showMachines()),
                icon: Badge(
                  isLabelVisible: machineState.machines.length > 1,
                  label: Text('${machineState.machines.length}'),
                  child: const Icon(Icons.dns_outlined),
                ),
              ),
              TextButton.icon(
                key: const Key('sessions-global-new'),
                onPressed: canCreateSession && _newSessionLaunch == null
                    ? () => unawaited(_openNewSession())
                    : null,
                icon: const Icon(Icons.add),
                label: Text(l10n.sessionsNewAction),
              ),
              RosterFreshnessSlot(
                presentation: freshness,
                onRefresh: _loadSessions,
              ),
            ],
          ),
          body: _newSessionLaunch != null
              ? NewSessionLaunchPage(
                  key: ValueKey<NewSessionLaunchRequest>(_newSessionLaunch!),
                  request: _newSessionLaunch!,
                  onCreate: (request) =>
                      ref.read(newSessionLaunchServiceProvider).create(request),
                  onOpen: _prepareCreatedSessionDestination,
                  onConnect: _prepareCreatedSessionConnection,
                  onComplete: _openCreatedSession,
                  onBack: _finishNewSessionLaunch,
                )
              // Cached identity rows (N3) take precedence over the whole-page
              // spinner and error view while the authoritative roster is
              // pending or unreachable, so a cold start shows the real roster
              // shape instead of an empty page. They are never shown once
              // `state.sessions` is populated.
              : switch ((state.status, state.cachedRoster)) {
                  (_, final cached?) when sessions.isEmpty => _SessionList(
                    sessions: const [],
                    status: state.status,
                    cachedRoster: cached,
                    onNewProject: canCreateSession
                        ? (project) =>
                              unawaited(_openNewSession(project: project))
                        : null,
                    onRetry: _loadSessions,
                    searchFocusNode: _searchFocusNode,
                  ),
                  (SessionListStatus.loading, _) => const _LoadingView(),
                  // A failed refresh never discards rows the user can still
                  // read and act on. Compact used to replace them with a full
                  // error page while Expanded kept them, so the same failure
                  // meant two different things depending on the width.
                  (SessionListStatus.error, _) when sessions.isNotEmpty =>
                    _SessionList(
                      sessions: sessions,
                      status: state.status,
                      onNewProject: canCreateSession
                          ? (project) =>
                                unawaited(_openNewSession(project: project))
                          : null,
                      onRetry: _loadSessions,
                      searchFocusNode: _searchFocusNode,
                    ),
                  (SessionListStatus.error, _) => _ErrorView(
                    onRetry: _loadSessions,
                  ),
                  (SessionListStatus.loaded, _) ||
                  (SessionListStatus.refreshing, _) =>
                    sessions.isEmpty
                        ? SessionsEmptyState(
                            hasActiveBrokerClient: hasActiveBrokerClient,
                            creationAvailability: creationAvailability,
                          )
                        : _SessionList(
                            sessions: sessions,
                            status: state.status,
                            onNewProject: canCreateSession
                                ? (project) => unawaited(
                                    _openNewSession(project: project),
                                  )
                                : null,
                            onRetry: _loadSessions,
                            searchFocusNode: _searchFocusNode,
                          ),
                },
        ),
      ),
    );
  }

  /// Puts the caret in the roster's search field.
  ///
  /// Focus only — the query is never cleared. A user reaching for search
  /// mid-filter wants to refine what they typed, not start over.
  void _focusRosterSearch() {
    if (!mounted) return;
    _searchFocusNode.requestFocus();
  }

  void _loadSessions() {
    ref.read(sessionListControllerProvider.notifier).load();
    ref.read(machineRosterControllerProvider.notifier).load();
    unawaited(ref.read(sessionCreationReadyProvider.notifier).refresh());
  }

  Future<void> _showMachines() {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => _MachineSessionsSheet(
        onOpen: (roster, session) {
          Navigator.of(context).pop();
          unawaited(_openMachineSession(roster, session));
        },
      ),
    );
  }

  Future<void> _openMachineSession(
    MachineRoster roster,
    MachineSessionInfo machineSession,
  ) async {
    final l10n = AppLocalizations.of(context);
    if (!roster.canRoute(machineSession)) {
      _showMessage(l10n.sessionsMachineStale);
      return;
    }
    final resolution = await ref
        .read(machineRosterControllerProvider.notifier)
        .resolve(machineSession.identity);
    if (!mounted) return;
    if (resolution == null) {
      _showMessage(l10n.sessionsMachineOwnerUnknown);
      return;
    }
    if (!resolution.canConnect) {
      _showMessage(_machineResolutionFailure(l10n, resolution.status));
      return;
    }
    final owner = resolution.owner!;
    if (owner.role == MachineRosterRole.local) {
      context.go(
        sessionDetailLocation(
          tool: resolution.identity.tool,
          sessionId: resolution.identity.sessionId,
        ),
      );
      return;
    }

    final ownerBaseUrl = owner.baseUrl;
    if (ownerBaseUrl == null) {
      _showMessage(l10n.sessionsMachineNoRoute);
      return;
    }
    final ownerProfile = await _profileForOwner(ownerBaseUrl);
    if (!mounted) return;
    if (ownerProfile == null || ownerProfile.credentialKey == null) {
      await _showOwnerSetupRequired(owner.machine, ownerBaseUrl);
      return;
    }
    final credential = await ref
        .read(credentialStoreProvider)
        .readBrokerToken(ownerProfile.credentialKey!);
    if (!mounted) return;
    if (credential == null || credential.trim().isEmpty) {
      await _showOwnerSetupRequired(owner.machine, ownerBaseUrl);
      return;
    }

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.sessionsMachineConnectTitle(owner.machine)),
        content: SelectableText(
          l10n.sessionsMachineConnectBody(ownerProfile.displayName),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.cancel),
          ),
          FilledButton(
            key: const Key('machine-owner-connect'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.connectionConnect),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await ref
          .read(brokerProfileManagerControllerProvider)
          .setActiveProfile(ownerProfile.id, expectedProfile: ownerProfile);
    } on BrokerProfileManagerException {
      if (mounted) _showMessage(l10n.brokerProfileActivateFailed);
      return;
    }
    if (!mounted) return;
    context.go(
      sessionDetailLocation(
        tool: resolution.identity.tool,
        sessionId: resolution.identity.sessionId,
      ),
    );
  }

  Future<BrokerProfile?> _profileForOwner(String baseUrl) async {
    final normalized = _normalizedBrokerUrl(baseUrl);
    if (normalized == null) return null;
    final profiles = await ref.read(brokerProfileRepositoryProvider).getAll();
    for (final profile in profiles) {
      if (_normalizedBrokerUrl(profile.baseUri.toString()) == normalized) {
        return profile;
      }
    }
    return null;
  }

  Future<void> _showOwnerSetupRequired(String machine, String baseUrl) async {
    final l10n = AppLocalizations.of(context);
    final openProfiles = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.sessionsMachinePairTitle),
        content: SelectableText(l10n.sessionsMachinePairBody(machine, baseUrl)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.close),
          ),
          FilledButton(
            key: const Key('machine-owner-open-profiles'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.sessionsMachineOpenProfiles),
          ),
        ],
      ),
    );
    if ((openProfiles ?? false) && mounted) {
      await context.push<void>('/settings/broker-profiles');
    }
  }

  void _showMessage(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _openNewSession({SessionProjectGroup? project}) async {
    final result = await showNewSessionSheet(
      context,
      initialDirectory: project?.cwd ?? '',
      projectName: project?.label,
      onImmediateLaunch: _beginNewSessionLaunch,
    );
    if (!mounted || result == null) return;
    switch (result) {
      case ImmediateNewSessionResult():
        // The callback already started this before the sheet's exit animation.
        // Replaying the result could create a duplicate if a very fast launch
        // completed before the bottom-sheet route finished dismissing.
        return;
      case ScheduledNewSessionResult(:final schedule):
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              AppLocalizations.of(context).sessionsScheduledConfirmation(
                '${DateTime.fromMillisecondsSinceEpoch(schedule.at)}',
              ),
            ),
          ),
        );
    }
  }

  void _beginNewSessionLaunch(NewSessionLaunchRequest request) {
    if (!mounted || _newSessionLaunch != null) return;
    setState(() => _newSessionLaunch = request);
  }

  Future<void> _prepareCreatedSessionDestination(SessionInfo _) =>
      Future<void>.value();

  Future<NewSessionConnectionHandoff> _prepareCreatedSessionConnection(
    SessionInfo session,
  ) => ref.read(newSessionConnectionPreparerProvider)(
    ProviderScope.containerOf(context, listen: false),
    session,
  );

  void _openCreatedSession(SessionInfo session) {
    if (!mounted) return;
    setState(() => _newSessionLaunch = null);
    // Navigation is independent from the roster request. The newly-created
    // identity opens now; the list catches up silently in the background.
    context.go(
      sessionDetailLocation(tool: session.tool, sessionId: session.id),
    );
    unawaited(
      ref.read(sessionListControllerProvider.notifier).load(silent: true),
    );
  }

  void _finishNewSessionLaunch() {
    if (!mounted || _newSessionLaunch == null) return;
    setState(() => _newSessionLaunch = null);
  }
}

String? _normalizedBrokerUrl(String raw) {
  try {
    return normalizeBrokerUrl(raw).toString();
  } on FormatException {
    return null;
  }
}

String _machineResolutionFailure(
  AppLocalizations l10n,
  MachineSessionResolutionStatus status,
) {
  return switch (status) {
    MachineSessionResolutionStatus.ownerUnreachable =>
      l10n.sessionsMachineOwnerUnreachable,
    MachineSessionResolutionStatus.ambiguous =>
      l10n.sessionsMachineOwnerAmbiguous,
    MachineSessionResolutionStatus.notFound =>
      l10n.sessionsMachineOwnerNotFound,
    MachineSessionResolutionStatus.stale ||
    MachineSessionResolutionStatus.unknown ||
    MachineSessionResolutionStatus.resolved => l10n.sessionsMachineOwnerUnknown,
  };
}

String _machineRoleLabel(AppLocalizations l10n, MachineRosterRole role) {
  return switch (role) {
    MachineRosterRole.local => l10n.sessionsMachineRoleLocal,
    MachineRosterRole.peer => l10n.sessionsMachineRolePeer,
    MachineRosterRole.unknown => l10n.sessionsMachineRoleUnknown,
  };
}

String _machineFreshnessLabel(
  AppLocalizations l10n,
  MachineRosterFreshness freshness,
) {
  return switch (freshness) {
    MachineRosterFreshness.fresh => l10n.sessionsMachineFresh,
    MachineRosterFreshness.stale => l10n.sessionsMachineStaleStatus,
    MachineRosterFreshness.unknown => l10n.sessionsMachineFreshnessUnknown,
  };
}

String _machineRouteLabel(
  AppLocalizations l10n,
  MachineSessionRouteState route,
) {
  return switch (route) {
    MachineSessionRouteState.local => l10n.sessionsMachineRouteLocal,
    MachineSessionRouteState.direct => l10n.sessionsMachineRouteDirect,
    MachineSessionRouteState.stale ||
    MachineSessionRouteState.ambiguous ||
    MachineSessionRouteState.unknown => l10n.sessionsMachineRouteUnavailable,
  };
}

class _MachineSessionsSheet extends ConsumerWidget {
  const _MachineSessionsSheet({required this.onOpen});

  final void Function(MachineRoster, MachineSessionInfo) onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final state = ref.watch(machineRosterControllerProvider);
    return SafeArea(
      child: FractionallySizedBox(
        heightFactor: 0.85,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      l10n.sessionsMachineTitle,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  IconButton(
                    tooltip: l10n.sessionsMachineRefresh,
                    onPressed: state.loading
                        ? null
                        : () => unawaited(
                            ref
                                .read(machineRosterControllerProvider.notifier)
                                .load(),
                          ),
                    icon: const Icon(Icons.refresh),
                  ),
                ],
              ),
            ),
            if (state.loading) const LinearProgressIndicator(),
            if (state.error != null)
              Padding(
                padding: const EdgeInsets.all(16),
                child: SelectableText(
                  l10n.sessionsMachineLoadFailed,
                  key: const Key('machine-roster-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            Expanded(
              child: state.machines.isEmpty && !state.loading
                  ? Center(child: SelectableText(l10n.sessionsMachineNone))
                  // No selection region: like the other two rosters this list
                  // is navigation, and a `SelectionArea` here would reintroduce
                  // the web platform view of flutter/flutter#122680.
                  : ListView(
                      key: const Key('machine-roster-list'),
                      padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                      children: [
                        for (final roster in state.machines)
                          _MachineRosterCard(roster: roster, onOpen: onOpen),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MachineRosterCard extends StatelessWidget {
  const _MachineRosterCard({required this.roster, required this.onOpen});

  final MachineRoster roster;
  final void Function(MachineRoster, MachineSessionInfo) onOpen;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final detail = <String>[
      _machineRoleLabel(l10n, roster.role),
      _machineFreshnessLabel(l10n, roster.freshness),
      if (roster.status != MachineRosterStatus.ok) l10n.sessionsMachineDegraded,
      if ((roster.invalidSessionCount ?? 0) > 0)
        l10n.sessionsMachineInvalidCount(roster.invalidSessionCount!),
    ].join(' · ');
    return Card(
      key: ValueKey('machine-roster-${roster.machineId}'),
      child: ExpansionTile(
        initiallyExpanded: roster.sessions.isNotEmpty,
        title: SelectableText(roster.machine),
        subtitle: SelectableText(detail),
        children: [
          if (roster.error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: SelectableText(l10n.sessionsMachineDegraded),
              ),
            ),
          for (final session in roster.sessions)
            ListTile(
              key: ValueKey('machine-session-${session.identity.key}'),
              enabled: roster.canRoute(session),
              leading: Icon(
                roster.canRoute(session)
                    ? Icons.cloud_outlined
                    : Icons.lock_outline,
              ),
              // Plain text: this row is navigation, so the ListTile's own
              // onTap is the single handler and nothing here selects.
              title: Text(
                session.title.isEmpty ? session.id : session.title,
              ),
              subtitle: Text(
                '${session.tool} · '
                '${_machineRouteLabel(l10n, session.owner.route)}',
              ),
              trailing: roster.canRoute(session)
                  ? const Icon(Icons.chevron_right)
                  : Text(l10n.sessionsMachineReadOnly),
              onTap: roster.canRoute(session)
                  ? () => onOpen(roster, session)
                  : null,
            ),
        ],
      ),
    );
  }
}

/// Adaptive session list with max-width constraint on desktop.
class _SessionList extends ConsumerWidget {
  const _SessionList({
    required this.sessions,
    required this.onNewProject,
    this.status = SessionListStatus.loaded,
    this.cachedRoster,
    this.onRetry,
    this.searchFocusNode,
  });

  final List<SessionInfo> sessions;
  final ValueChanged<SessionProjectGroup>? onNewProject;
  final SessionListStatus status;
  final CachedRosterPresentation? cachedRoster;
  final VoidCallback? onRetry;
  final FocusNode? searchFocusNode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final retry = onRetry;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 720),
        child: SessionListPane(
          searchFocusNode: searchFocusNode,
          queryWindow:
              ref.watch(sessionRosterWindowProvider).valueOrNull ??
              SessionRosterQueryWindow.last7Days,
          onQueryWindowChanged: (window) => unawaited(
            ref.read(sessionRosterWindowProvider.notifier).setWindow(window),
          ),
          sessions: sessions,
          status: status,
          cachedRoster: cachedRoster,
          activeKey: null,
          onNewProject: onNewProject,
          onRenameProject: (project) =>
              unawaited(renameProjectAliasFromList(context, ref, project)),
          onOpen: (session) => context.go(
            sessionDetailLocation(tool: session.tool, sessionId: session.id),
          ),
          // A cached row routes on its exact identity; Session Detail then
          // attaches and owns every live/control surface itself.
          onOpenCached: (identity) => context.go(
            sessionDetailLocation(
              tool: identity.tool,
              sessionId: identity.sessionId,
            ),
          ),
          onRetry: retry == null
              ? null
              : () async {
                  retry();
                },
          onRefresh: () => ProviderScope.containerOf(
            context,
          ).read(sessionListControllerProvider.notifier).load(),
        ),
      ),
    );
  }
}

/// Loading spinner for initial load.
class _LoadingView extends StatelessWidget {
  const _LoadingView();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 16),
          SelectableText(l10n.sessionsLoading),
        ],
      ),
    );
  }
}

/// Error state with retry.
class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.onRetry});

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
            Icon(
              Icons.error_outline,
              size: 64,
              color: Theme.of(context).colorScheme.error,
            ),
            const SizedBox(height: 16),
            SelectableText(
              l10n.sessionsLoadFailedTitle,
              style: Theme.of(context).textTheme.titleMedium,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            SelectableText(
              l10n.sessionsLoadFailedBody,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: Text(l10n.retry),
            ),
          ],
        ),
      ),
    );
  }
}
