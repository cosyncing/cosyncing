part of 'session_detail_page.dart';

/// Localized text for a typed local refusal, or null when there is none.
///
/// Shared by the rename, fork, and clone status lines so one refusal cannot
/// read differently depending on which action surfaced it.
String? _sessionActionRefusalText(
  AppLocalizations l10n,
  SessionActionRefusal refusal,
) => switch (refusal) {
  SessionActionRefusal.agentOwnedSession => l10n.sessionForkAgentOwnedRefusal,
  SessionActionRefusal.renameRequiresServer => l10n.sessionRenameRequiresServer,
  SessionActionRefusal.renameUnsupported => l10n.sessionRenameUnsupported,
  SessionActionRefusal.renameRejected => l10n.sessionRenameRejected,
  SessionActionRefusal.forkRequiresServer => l10n.sessionForkRequiresServer,
  SessionActionRefusal.forkUnsupported => l10n.sessionForkUnsupported,
  SessionActionRefusal.forkAlreadyRunning => l10n.sessionForkAlreadyRunning,
  SessionActionRefusal.forkReturnedNothing => l10n.sessionForkReturnedNothing,
  SessionActionRefusal.cloneRequiresServer => l10n.sessionCloneRequiresServer,
  SessionActionRefusal.cloneUnsupported => l10n.sessionCloneUnsupported,
  SessionActionRefusal.cloneAlreadyRunning => l10n.sessionCloneAlreadyRunning,
  SessionActionRefusal.cloneReturnedNothing => l10n.sessionCloneReturnedNothing,
};

/// Status line for a fork action, or `null` when there is none.
///
/// A typed [SessionActionState.refusal] wins over broker-authored detail so the
/// client can render the refusal in the active locale.
String? _forkActionStatusText(
  AppLocalizations l10n,
  SessionActionState action,
) {
  final refusal = action.refusal;
  if (refusal != null) return _sessionActionRefusalText(l10n, refusal);
  final failure = action.failure;
  if (failure != null) return localizedFailureText(l10n, failure);
  return switch (action.phase) {
    SessionActionPhase.idle => null,
    SessionActionPhase.inProgress => l10n.sessionForkCreating,
    SessionActionPhase.success => l10n.sessionForkCreated(
      _sessionActionCreatedTitle(action),
    ),
    SessionActionPhase.failed => l10n.sessionForkFailed,
  };
}

String _sessionActionCreatedTitle(SessionActionState action) {
  final title = action.createdSessionTitle?.trim();
  if (title != null && title.isNotEmpty) return title;
  return action.createdSessionId ?? '';
}

String? _transcriptExportStatusText(
  AppLocalizations l10n,
  TranscriptExportActionState action,
) => switch (action.phase) {
  TranscriptExportActionPhase.idle ||
  TranscriptExportActionPhase.awaitingConfirmation => null,
  TranscriptExportActionPhase.preflighting => l10n.sessionExportPreparing,
  TranscriptExportActionPhase.exporting => l10n.sessionExportInProgress,
  TranscriptExportActionPhase.exported => l10n.sessionExportReady,
  TranscriptExportActionPhase.error => l10n.sessionExportFailed,
};

/// Localized subtitle for a disabled Status action, or null when the action is
/// enabled or already reporting progress through its status line.
///
/// Every disabled cause names itself so the subtitle can never contradict the
/// session's actual state: a capability confirmed absent by a loaded agent
/// registry entry first, then a disconnected session, a missing broker
/// connection, read-only compatibility, a capability read still in flight,
/// and finally a capability read that failed. A connected session is never
/// told to connect, and a transient `/api/agents` failure is never presented
/// as a permanent agent-type limitation.
String? _disabledActionReason(
  AppLocalizations l10n, {
  required bool enabled,
  required bool busy,
  required bool connected,
  required bool compatibleControls,
  required bool? capability,
  required bool capabilityLoaded,
  required String unsupported,
  bool brokerClientAvailable = true,
}) {
  if (enabled || busy) return null;
  if (capabilityLoaded && capability == false) return unsupported;
  if (!connected) return l10n.sessionActionDisabledOffline;
  if (!brokerClientAvailable) return l10n.sessionActionDisabledNoBroker;
  if (!compatibleControls) return l10n.sessionActionDisabledReadOnly;
  if (capability == null) return l10n.sessionActionDisabledCapabilityPending;
  return l10n.sessionActionDisabledCapabilityUnknown;
}

/// Session-scoped cache cleanup, with confirmation and broker-source fencing.
class _SessionLocalDataZone extends ConsumerStatefulWidget {
  const _SessionLocalDataZone({
    required this.sessionKey,
    required this.state,
  });

  final SessionDetailKey sessionKey;
  final SessionDetailState state;

  @override
  ConsumerState<_SessionLocalDataZone> createState() =>
      _SessionLocalDataZoneState();
}

class _SessionLocalDataZoneState extends ConsumerState<_SessionLocalDataZone> {
  bool _pending = false;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final danger = context.tokens.statusError;
    return Material(
      type: MaterialType.transparency,
      child: ListTile(
        key: const Key('session-detail-clear-current-cache-button'),
        leading: Icon(Icons.delete_sweep_outlined, size: 18, color: danger),
        title: Text(
          l10n.sessionClearCurrentCache,
          style: TextStyle(color: danger),
        ),
        subtitle: Text(l10n.sessionClearCurrentCacheDescription),
        enabled: !_pending,
        onTap: _pending ? null : () => unawaited(_clearCurrentCache()),
      ),
    );
  }

  Future<void> _clearCurrentCache() async {
    if (_pending) return;
    final key = widget.sessionKey;
    final source = RosterSource.of(ref.read(activeBrokerProfileProvider));
    if (source == null ||
        ref.read(sessionDetailControllerProvider(key)).source != source) {
      return;
    }
    final l10n = AppLocalizations.of(context);
    final confirmed = await _confirm(
      title: l10n.sessionClearCurrentCacheConfirmTitle,
      body: l10n.sessionClearCurrentCacheConfirmBody,
      label: l10n.sessionClearCurrentCacheConfirm,
      key: const Key('session-detail-clear-current-cache-confirm'),
    );
    if (!mounted || confirmed != true || !_isCurrentSource(source)) return;
    setState(() => _pending = true);
    var localCleared = false;
    var brokerCleared = false;
    try {
      try {
        await ref
            .read(sessionCacheManagementProvider)
            .clearCurrentSession(
              brokerSourceKey: source.storageKey,
              sessionKey: key,
            );
        localCleared = true;
      } on Object {
        localCleared = false;
      }
      if (localCleared && _isCurrentSource(source)) {
        try {
          final client = await ref.read(brokerClientProvider.future);
          if (client != null && _isCurrentSource(source)) {
            brokerCleared = (await client.clearSessionCache(
              key.tool,
              key.sessionId,
            )).ok;
          }
        } on Object {
          brokerCleared = false;
        }
      }
    } finally {
      if (mounted) setState(() => _pending = false);
    }
    if (!mounted ||
        RosterSource.of(ref.read(activeBrokerProfileProvider)) != source) {
      return;
    }
    _showResult(
      !localCleared
          ? l10n.sessionCurrentCacheClearFailed
          : brokerCleared
          ? l10n.sessionCurrentCacheCleared
          : l10n.sessionCurrentCacheClearedLocally,
    );
  }

  bool _isCurrentSource(RosterSource source) =>
      RosterSource.of(ref.read(activeBrokerProfileProvider)) == source &&
      ref.read(sessionDetailControllerProvider(widget.sessionKey)).source ==
          source;

  Future<bool?> _confirm({
    required String title,
    required String body,
    required String label,
    required Key key,
  }) => showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: SelectionArea(child: Text(body)),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(AppLocalizations.of(context).cancel),
        ),
        FilledButton(
          key: key,
          style: FilledButton.styleFrom(
            backgroundColor: context.tokens.statusError,
            foregroundColor: Theme.of(context).colorScheme.onError,
          ),
          onPressed: () => Navigator.of(context).pop(true),
          child: Text(label),
        ),
      ],
    ),
  );

  void _showResult(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }
}

/// Session actions, transcript export and session-scoped cache cleanup.
class _SessionActionGroups extends StatelessWidget {
  const _SessionActionGroups({
    required this.sessionKey,
    required this.state,
    required this.canDetach,
    required this.canFork,
    required this.canExport,
    required this.hasActiveBrokerClient,
    required this.onDetach,
    required this.onForkSession,
    required this.onExportTranscript,
  });

  final SessionDetailKey sessionKey;
  final SessionDetailState state;
  final bool canDetach;
  final bool canFork;
  final bool canExport;
  final bool hasActiveBrokerClient;
  final VoidCallback onDetach;
  final VoidCallback onForkSession;
  final VoidCallback onExportTranscript;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final connected =
        state.connectionStatus == SessionDetailConnectionStatus.connected;
    final compatibleControls = !state.compatibilityReadOnly;
    // The approved Status-surface hierarchy (session-topbar spec §7.1): action
    // rows are quiet 40dp list rows with `bodySmall` labels and 18px leading
    // icons. Without an explicit role the Material ListTile default renders
    // every row title at `bodyLarge` — visibly larger than the SectionHeader
    // above it and every explanation around it. One scoped theme keeps all
    // three groups (and any future row) on the same hierarchy.
    return ListTileTheme(
      data: ListTileThemeData(
        titleTextStyle: theme.textTheme.bodySmall,
        subtitleTextStyle: theme.textTheme.bodySmall?.copyWith(
          color: context.tokens.textSecondary,
        ),
        minTileHeight: 40,
      ),
      child: _buildGroups(context, l10n, connected, compatibleControls),
    );
  }

  Widget _buildGroups(
    BuildContext context,
    AppLocalizations l10n,
    bool connected,
    bool compatibleControls,
  ) {
    return Column(
      children: [
        Card(
          key: const Key('session-actions-group-session'),
          margin: EdgeInsets.zero,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(context.tokens.radiusLg),
          ),
          child: Column(
            children: [
              if (state.sessionInfo != null) ...[
                SessionVisibilityTile(
                  session: state.sessionInfo!,
                  connected: hasActiveBrokerClient && compatibleControls,
                ),
                const Divider(height: 1),
              ],
              ListTile(
                key: const Key('session-detail-detach-button'),
                leading: const Icon(Icons.link_off, size: 18),
                title: Text(l10n.sessionDetach),
                subtitle: Text(l10n.sessionDetachDescription),
                enabled: canDetach,
                onTap: canDetach ? onDetach : null,
              ),
              const Divider(height: 1),
              ListTile(
                key: const Key('session-detail-fork-button'),
                leading: const Icon(Icons.call_split, size: 18),
                title: Text(l10n.sessionForkLatest),
                subtitle: switch (state.forkBlockedAsAgentOwned
                    ? l10n.sessionForkAgentOwnedRefusal
                    : _disabledActionReason(
                        l10n,
                        enabled: canFork,
                        busy: state.forkSessionActionState.isBusy,
                        connected: connected,
                        compatibleControls: compatibleControls,
                        brokerClientAvailable: hasActiveBrokerClient,
                        capability: state.agentActions?.canFork,
                        capabilityLoaded: state.agentActions?.loaded ?? false,
                        unsupported: l10n.sessionForkUnsupported,
                      )) {
                  null => null,
                  final reason => Text(reason),
                },
                enabled: canFork,
                onTap: canFork ? onForkSession : null,
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Card(
          key: const Key('session-actions-group-transcript'),
          margin: EdgeInsets.zero,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(context.tokens.radiusLg),
          ),
          child: Column(
            children: [
              ListTile(
                key: const Key('session-detail-export-transcript-button'),
                leading: const Icon(Icons.download_outlined, size: 18),
                title: Text(l10n.sessionExportTranscript),
                // `hasActiveBrokerClient` stays at its default: the export
                // predicate does not gate on it, so it is never export's
                // disabling cause.
                subtitle: switch (_disabledActionReason(
                  l10n,
                  enabled: canExport,
                  busy: state.transcriptExportActionState.isBusy,
                  connected: connected,
                  compatibleControls: compatibleControls,
                  capability: state.agentActions?.canTranscriptExport,
                  capabilityLoaded: state.agentActions?.loaded ?? false,
                  unsupported: l10n.sessionExportDisabledUnsupported,
                )) {
                  null => null,
                  final reason => Text(
                    reason,
                    key: const Key('session-detail-export-disabled-reason'),
                  ),
                },
                enabled: canExport,
                onTap: canExport ? onExportTranscript : null,
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        _SessionLocalDataZone(
          sessionKey: sessionKey,
          state: state,
        ),
      ],
    );
  }
}
