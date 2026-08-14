part of 'session_detail_page.dart';

/// Status line for a fork action, or `null` when there is none.
///
/// A typed [SessionActionState.refusal] wins over broker-authored detail so the
/// client can render the refusal in the active locale.
String? _forkActionStatusText(
  AppLocalizations l10n,
  SessionActionState action,
) {
  final refusal = action.refusal;
  if (refusal != null) {
    return switch (refusal) {
      SessionActionRefusal.agentOwnedSession =>
        l10n.sessionForkAgentOwnedRefusal,
    };
  }
  return switch (action.phase) {
    SessionActionPhase.idle => null,
    SessionActionPhase.inProgress => l10n.sessionForkCreating,
    SessionActionPhase.success => l10n.sessionForkCreated(
      _sessionActionCreatedTitle(action),
    ),
    SessionActionPhase.failed => l10n.sessionForkFailed,
  };
}

String? _cloneActionStatusText(
  AppLocalizations l10n,
  SessionActionState action,
) => switch (action.phase) {
  SessionActionPhase.idle => null,
  SessionActionPhase.inProgress => l10n.sessionCloneCreating,
  SessionActionPhase.success => l10n.sessionCloneCreated(
    _sessionActionCreatedTitle(action),
  ),
  SessionActionPhase.failed => l10n.sessionCloneFailed,
};

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

/// Exact text copied by the one-tap retained-transcript action.
///
/// It consumes the same bounded canonical and optimistic rows the Chat view
/// renders. It does not fetch older pages, expand tools, or reuse rendered
/// widget text, so lazy history and structured rendering stay untouched while
/// Markdown source — including fences — remains byte-for-byte faithful within
/// each message. Explicit markers prevent discontiguous retained runs from
/// being flattened into a falsely continuous transcript.
String buildRetainedTranscriptCopyText({
  required List<List<AgentMessage>> segments,
  required String omissionMarker,
  required bool hasLeadingOmission,
}) {
  final parts = <String>[];
  if (hasLeadingOmission) parts.add(omissionMarker);
  var hasCopiedSegment = false;
  for (final messages in segments) {
    final segment = messages
        .map(_messageCopyText)
        .where((text) => text.isNotEmpty)
        .join('\n\n');
    if (segment.isEmpty) continue;
    if (hasCopiedSegment) parts.add(omissionMarker);
    parts.add(segment);
    hasCopiedSegment = true;
  }
  return parts.join('\n\n');
}

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

/// Copies the bounded retained transcript from the Status panel.
class _SessionTranscriptCopyTile extends StatelessWidget {
  const _SessionTranscriptCopyTile({required this.state});

  final SessionDetailState state;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      key: const Key('session-detail-copy-transcript-button'),
      leading: const Icon(Icons.copy_all_outlined, size: 18),
      title: Text(l10n.sessionCopyTranscript),
      subtitle: Text(l10n.sessionCopyTranscriptDescription),
      enabled: state.transcriptMessageEvents.isNotEmpty,
      onTap: state.transcriptMessageEvents.isEmpty
          ? null
          : () => unawaited(_copyTranscript(context)),
    );
  }

  Future<void> _copyTranscript(BuildContext context) async {
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final text = buildRetainedTranscriptCopyText(
      segments: state.transcriptMessageSegments,
      omissionMarker: l10n.sessionTranscriptCopyOmissionMarker,
      hasLeadingOmission:
          state.hasEarlierHistory || state.leadingTranscriptHistoryGap != null,
    );
    if (text.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: text));
    messenger.showSnackBar(
      SnackBar(content: Text(l10n.sessionTranscriptCopied)),
    );
  }
}

/// The labeled Local data zone: rebuildable cache actions behind a restrained
/// dashed error boundary. Rows stay low-emphasis; only the confirmation button
/// carries the destructive fill.
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
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final danger = tokens.statusError;
    return CustomPaint(
      foregroundPainter: _DashedRRectBorderPainter(
        color: danger.withValues(alpha: 0.45),
        radius: tokens.radiusLg,
      ),
      child: Card(
        key: const Key('session-actions-group-local-data'),
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(tokens.radiusLg),
        ),
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: Text(
                  l10n.sessionActionsLocalDataCaption,
                  key: const Key('session-actions-local-data-caption'),
                  style: theme.textTheme.labelSmall?.copyWith(color: danger),
                ),
              ),
            ),
            ListTile(
              key: const Key('session-detail-clear-current-cache-button'),
              leading: Icon(
                Icons.delete_sweep_outlined,
                size: 18,
                color: danger,
              ),
              title: Text(
                l10n.sessionClearCurrentCache,
                style: TextStyle(color: danger),
              ),
              subtitle: Text(l10n.sessionClearCurrentCacheDescription),
              enabled: !_pending,
              onTap: _pending ? null : () => unawaited(_clearCurrentCache()),
            ),
            const Divider(height: 1),
            ListTile(
              key: const Key('session-detail-clear-all-cache-button'),
              leading: Icon(
                Icons.delete_forever_outlined,
                size: 18,
                color: danger,
              ),
              title: Text(
                l10n.sessionClearAllCache,
                style: TextStyle(color: danger),
              ),
              subtitle: Text(l10n.sessionClearAllCacheDescription),
              trailing: MetadataChip(
                key: const Key('session-detail-clear-all-cache-scope-chip'),
                label: l10n.sessionActionsAllProfilesChip,
              ),
              enabled: !_pending,
              onTap: _pending ? null : () => unawaited(_clearAllCache()),
            ),
          ],
        ),
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

  Future<void> _clearAllCache() async {
    if (_pending) return;
    final l10n = AppLocalizations.of(context);
    final confirmed = await _confirm(
      title: l10n.sessionClearAllCacheConfirmTitle,
      body: l10n.sessionClearAllCacheConfirmBody,
      label: l10n.sessionClearAllCacheConfirm,
      key: const Key('session-detail-clear-all-cache-confirm'),
    );
    if (!mounted || confirmed != true) return;
    setState(() => _pending = true);
    var succeeded = false;
    try {
      await ref.read(sessionCacheManagementProvider).clearAll();
      succeeded = true;
    } on Object {
      succeeded = false;
    } finally {
      if (mounted) setState(() => _pending = false);
    }
    if (!mounted) return;
    _showResult(
      succeeded ? l10n.sessionAllCacheCleared : l10n.sessionAllCacheClearFailed,
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

/// The Status tab's three purposeful action groups: Session, Transcript, and
/// the labeled Local data zone.
class _SessionActionGroups extends StatelessWidget {
  const _SessionActionGroups({
    required this.sessionKey,
    required this.state,
    required this.canDetach,
    required this.canFork,
    required this.canClone,
    required this.canExport,
    required this.hasActiveBrokerClient,
    required this.onDetach,
    required this.onForkSession,
    required this.onCloneSession,
    required this.onExportTranscript,
  });

  final SessionDetailKey sessionKey;
  final SessionDetailState state;
  final bool canDetach;
  final bool canFork;
  final bool canClone;
  final bool canExport;
  final bool hasActiveBrokerClient;
  final VoidCallback onDetach;
  final VoidCallback onForkSession;
  final VoidCallback onCloneSession;
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
                enabled: canFork,
                onTap: canFork ? onForkSession : null,
              ),
              const Divider(height: 1),
              ListTile(
                key: const Key('session-detail-clone-button'),
                leading: const Icon(Icons.difference_outlined, size: 18),
                title: Text(l10n.sessionDuplicate),
                subtitle: switch (_disabledActionReason(
                  l10n,
                  enabled: canClone,
                  busy: state.cloneSessionActionState.isBusy,
                  connected: connected,
                  compatibleControls: compatibleControls,
                  capability: state.agentActions?.canClone,
                  capabilityLoaded: state.agentActions?.loaded ?? false,
                  unsupported: l10n.sessionDuplicateDisabledUnsupported,
                  brokerClientAvailable: hasActiveBrokerClient,
                )) {
                  null => null,
                  final reason => Text(
                    reason,
                    key: const Key('session-detail-clone-disabled-reason'),
                  ),
                },
                enabled: canClone,
                onTap: canClone ? onCloneSession : null,
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
              const Divider(height: 1),
              _SessionTranscriptCopyTile(state: state),
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

/// 1dp dashed rounded border for the Local data zone.
///
/// Deliberately quieter than a solid error outline: the boundary marks a
/// blast-radius zone around rebuildable cache actions without spending the
/// solid-red emphasis reserved for irreversible operations.
class _DashedRRectBorderPainter extends CustomPainter {
  const _DashedRRectBorderPainter({
    required this.color,
    required this.radius,
  });

  final Color color;
  final double radius;

  static const double _dash = 4;
  static const double _gap = 4;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    final path = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(0.5, 0.5, size.width - 1, size.height - 1),
          Radius.circular(radius),
        ),
      );
    for (final metric in path.computeMetrics()) {
      var distance = 0.0;
      while (distance < metric.length) {
        canvas.drawPath(
          metric.extractPath(
            distance,
            (distance + _dash).clamp(0, metric.length),
          ),
          paint,
        );
        distance += _dash + _gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedRRectBorderPainter oldDelegate) =>
      oldDelegate.color != color || oldDelegate.radius != radius;
}
