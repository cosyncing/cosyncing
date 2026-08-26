part of 'session_detail_page.dart';

/// Section heading inside a sub-view.
///
/// `titleSmall` w600 per `output/UI-design/session-topbar/spec.md` §7. These
/// were `titleMedium` (16px), two steps above the `bodySmall` rows underneath
/// them, which is what made the Files view read as a different app from the
/// strip and the ⋮ menu.
TextStyle? _sectionHeadingStyle(ThemeData theme) =>
    theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600);

class _TerminalPanel extends StatefulWidget {
  const _TerminalPanel({required this.messages, super.key});

  final List<AgentMessage> messages;

  @override
  State<_TerminalPanel> createState() => _TerminalPanelState();
}

class _TerminalPanelState extends State<_TerminalPanel> {
  static const _maxVisibleMessages = 3;

  bool _showAll = false;

  String _summaryLabel(
    AppLocalizations l10n,
    int totalCount,
    bool showAll,
  ) {
    final hiddenCount =
        totalCount -
        _clippedTerminalMessages(
          widget.messages,
          showAll,
        ).length;

    if (!showAll && hiddenCount > 0) {
      final visibleCount = totalCount - hiddenCount;
      return l10n.terminalShowingLatest(visibleCount, totalCount);
    }
    return l10n.terminalShowingAll(totalCount);
  }

  List<AgentMessage> _clippedTerminalMessages(
    List<AgentMessage> messages,
    bool showAll,
  ) {
    if (showAll || messages.length <= _maxVisibleMessages) {
      return messages;
    }
    return messages.sublist(messages.length - _maxVisibleMessages);
  }

  Future<void> _copyVisibleOutput(BuildContext context) async {
    // Keep terminal tooling read-only and visibility-scoped; see
    // `docs/architecture/client-ui.md`.
    final visibleMessages = _clippedTerminalMessages(
      widget.messages,
      _showAll,
    );
    final visibleText = _visibleTerminalOutputText(visibleMessages);
    await Clipboard.setData(ClipboardData(text: visibleText));
    if (!context.mounted) {
      return;
    }

    final l10n = AppLocalizations.of(context);
    final snackbarText = visibleText.isEmpty
        ? l10n.terminalNothingToCopy
        : l10n.terminalCopiedVisible;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(snackbarText)));
  }

  void _toggleShowAll() {
    setState(() => _showAll = !_showAll);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    if (widget.messages.isEmpty) {
      return Center(
        child: SelectableText(
          l10n.terminalEmpty,
          key: const Key('session-detail-terminal-empty-state'),
          style: theme.textTheme.bodyMedium,
        ),
      );
    }

    final canToggle = widget.messages.length > _maxVisibleMessages;
    final visibleMessages = _clippedTerminalMessages(
      widget.messages,
      _showAll,
    );
    final showAllLabel = _showAll ? l10n.showLatest : l10n.showAll;
    final toggleKey = _showAll
        ? const Key('session-detail-terminal-show-latest')
        : const Key('session-detail-terminal-show-all');

    return ListView(
      children: [
        _TerminalSurface(
          messages: visibleMessages,
          totalCount: widget.messages.length,
          onCopiedVisible: () => _copyVisibleOutput(context),
          canToggle: canToggle,
          summaryLabel: _summaryLabel(
            l10n,
            widget.messages.length,
            _showAll,
          ),
          copyLabel: l10n.copyVisible,
          showAllLabel: showAllLabel,
          onToggleShowAll: canToggle ? _toggleShowAll : null,
          toggleKey: toggleKey,
        ),
      ],
    );
  }
}

class _FilesPanel extends ConsumerStatefulWidget {
  const _FilesPanel({
    required this.sessionKey,
    required this.isConnected,
    required this.descriptors,
    required this.actionStates,
    required this.hasActiveBrokerClient,
    required this.transfers,
    required this.onRetryTransfer,
    required this.onCancelTransfer,
    required this.onDownloadArtifact,
    required this.onPreviewArtifact,
    required this.onPreviewFile,
    required this.onDownloadFile,
    super.key,
  });

  final SessionDetailKey sessionKey;
  final bool isConnected;
  final List<SessionArtifactDescriptor> descriptors;
  final Map<String, SessionArtifactActionState> actionStates;
  final bool hasActiveBrokerClient;
  final List<SessionArtifactTransfer> transfers;
  final void Function(String id) onRetryTransfer;
  final void Function(String id) onCancelTransfer;
  final Future<void> Function(SessionArtifactDescriptor descriptor)
  onDownloadArtifact;
  final Future<void> Function(SessionArtifactDescriptor descriptor)
  onPreviewArtifact;
  final Future<void> Function(FsDirEntry entry) onPreviewFile;
  final Future<void> Function(FsDirEntry entry) onDownloadFile;

  @override
  ConsumerState<_FilesPanel> createState() => _FilesPanelState();
}

class _FilesPanelState extends ConsumerState<_FilesPanel> {
  bool _started = false;

  @override
  void didUpdateWidget(covariant _FilesPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!oldWidget.isConnected && widget.isConnected) {
      _loadRoot();
    }
  }

  @override
  Widget build(BuildContext context) {
    // Source-qualified: a switch to another broker moves this panel onto that
    // host's browser rather than leaving the previous machine's listing up.
    final browserKey = ref.watch(
      sessionFileBrowserKeyProvider(widget.sessionKey),
    );
    if (widget.isConnected && !_started) {
      _started = true;
      // The once-per-attach gate probe already makes the workspace-root call,
      // so a browser that is no longer idle has (or is getting) its listing.
      // Re-loading here would cost a second round-trip and would clear a
      // preview a transcript file link just opened.
      final browsed =
          ref.read(sessionFileBrowserControllerProvider(browserKey)).phase !=
          SessionFileBrowserPhase.idle;
      if (!browsed) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) {
            ref
                .read(sessionFileBrowserControllerProvider(browserKey).notifier)
                .load();
          }
        });
      }
    }

    final state = widget.isConnected
        ? ref.watch(sessionFileBrowserControllerProvider(browserKey))
        : null;
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);

    return ListView(
      key: const Key('session-detail-files-list'),
      children: [
        Text(
          l10n.sessionFilesProduced,
          key: const Key('session-detail-files-produced-heading'),
          style: _sectionHeadingStyle(theme),
        ),
        const SizedBox(height: 8),
        if (widget.descriptors.isEmpty && widget.transfers.isEmpty)
          SelectableText(
            l10n.sessionFilesProducedEmpty,
            key: const Key('session-detail-files-produced-empty'),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          )
        else ...[
          if (widget.descriptors.isNotEmpty)
            _ArtifactSurface(
              descriptors: widget.descriptors,
              transfers: widget.transfers,
              actionStates: widget.actionStates,
              hasActiveBrokerClient: widget.hasActiveBrokerClient,
              onDownloadArtifact: widget.onDownloadArtifact,
              onPreviewArtifact: widget.onPreviewArtifact,
            ),
          if (widget.descriptors.isNotEmpty && widget.transfers.isNotEmpty)
            const SizedBox(height: 12),
          if (widget.transfers.isNotEmpty)
            _ArtifactTransferSurface(
              transfers: widget.transfers,
              onRetryTransfer: widget.onRetryTransfer,
              onCancelTransfer: widget.onCancelTransfer,
            ),
        ],
        const SizedBox(height: 20),
        const Divider(height: 1),
        const SizedBox(height: 16),
        Text(
          l10n.sessionFilesBrowse,
          key: const Key('session-detail-files-browse-heading'),
          style: _sectionHeadingStyle(theme),
        ),
        const SizedBox(height: 8),
        // The closed gate is stated exactly ONCE, here, where a reader who
        // noticed the transcript's paths are not links would come looking.
        // Never on a mention, never as a dialog, never per tap.
        if (_sessionFileLinksOffMessage(l10n, state?.gate)
            case final String message) ...[
          Text(
            message,
            key: const Key('session-detail-files-links-off'),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
        ],
        // Governed by docs/architecture/client-ui.md:
        // Files is read-only session work state, not raw broker endpoint UI.
        if (state == null)
          SelectableText(
            l10n.sessionFilesAttachToBrowse,
            key: const Key('session-detail-files-disconnected-state'),
          )
        else
          _SessionFilesSurface(
            state: state,
            onRefresh: () => _loadPath(state.currentPath),
            onOpenPath: _loadPath,
            onOpenEntry: (entry) {
              if (entry.type == 'directory') {
                _loadPath(entry.path);
              }
            },
            onPreviewFile: widget.onPreviewFile,
            onDownloadFile: widget.onDownloadFile,
          ),
      ],
    );
  }

  void _loadRoot() {
    _started = true;
    _loadPath('');
  }

  void _loadPath(String path) {
    ref
        .read(
          sessionFileBrowserControllerProvider(
            ref.read(sessionFileBrowserKeyProvider(widget.sessionKey)),
          ).notifier,
        )
        .load(path: path);
  }
}

class _SessionFilesSurface extends StatelessWidget {
  const _SessionFilesSurface({
    required this.state,
    required this.onRefresh,
    required this.onOpenPath,
    required this.onOpenEntry,
    required this.onPreviewFile,
    required this.onDownloadFile,
  });

  final SessionFileBrowserState state;
  final VoidCallback onRefresh;
  final void Function(String path) onOpenPath;
  final void Function(FsDirEntry entry) onOpenEntry;
  final Future<void> Function(FsDirEntry entry) onPreviewFile;
  final Future<void> Function(FsDirEntry entry) onDownloadFile;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    return Card(
      key: const Key('session-detail-files-surface'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.folder_open_outlined),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    l10n.sessionFilesTitle,
                    style: _sectionHeadingStyle(theme),
                  ),
                ),
                IconButton(
                  key: const Key('session-detail-files-refresh'),
                  tooltip: l10n.sessionFilesRefresh,
                  onPressed: onRefresh,
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            const SizedBox(height: 8),
            _SessionFileBreadcrumbs(
              breadcrumbs: state.breadcrumbs,
              onOpenPath: onOpenPath,
            ),
            if (state.phase == SessionFileBrowserPhase.ready &&
                state.notice != null) ...[
              const SizedBox(height: 8),
              _SessionFilesMessageBanner(
                message: _sessionFileBrowserNotice(l10n, state),
              ),
            ],
            const SizedBox(height: 12),
            switch (state.phase) {
              SessionFileBrowserPhase.idle ||
              SessionFileBrowserPhase.loading ||
              SessionFileBrowserPhase.previewing => _SessionFilesStatus(
                key: const Key('session-detail-files-loading-state'),
                icon: Icons.hourglass_empty,
                message: _sessionFileBrowserNotice(l10n, state),
              ),
              SessionFileBrowserPhase.remoteDisabled => _SessionFilesStatus(
                key: const Key(
                  'session-detail-files-remote-disabled-state',
                ),
                icon: Icons.lock_outline,
                message: _sessionFileBrowserNotice(l10n, state),
                technicalDetail: state.technicalDetail,
              ),
              SessionFileBrowserPhase.error => _SessionFilesStatus(
                key: const Key('session-detail-files-error-state'),
                icon: Icons.error_outline,
                message: _sessionFileBrowserNotice(l10n, state),
                technicalDetail: state.technicalDetail,
              ),
              SessionFileBrowserPhase.ready => _SessionFilesEntries(
                entries: state.groupedEntries,
                onOpenEntry: onOpenEntry,
                onPreviewFile: onPreviewFile,
                onDownloadFile: onDownloadFile,
              ),
            },
          ],
        ),
      ),
    );
  }
}

class _SessionFilesMessageBanner extends StatelessWidget {
  const _SessionFilesMessageBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      key: const Key('session-detail-files-message'),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: SelectableText(message),
      ),
    );
  }
}

/// The one line explaining why this session's transcript paths are plain text.
///
/// Null whenever links are live, still being probed, or failed for a reason
/// that is not a settled host posture — claiming "workspace browsing is off"
/// after a dropped connection would be a lie the reader cannot act on.
String? _sessionFileLinksOffMessage(
  AppLocalizations l10n,
  SessionFileLinkGate? gate,
) {
  return switch (gate) {
    SessionFileLinkGate.remoteDisabled => l10n.sessionFilesLinksOff,
    SessionFileLinkGate.noWorkspace => l10n.sessionFilesLinksOffNoWorkspace,
    _ => null,
  };
}

String _sessionFileBrowserNotice(
  AppLocalizations l10n,
  SessionFileBrowserState state,
) {
  return switch (state.notice) {
    SessionFileBrowserNotice.loadingWorkspace =>
      l10n.sessionFilesLoadingWorkspace,
    SessionFileBrowserNotice.loading => l10n.sessionFilesLoading,
    SessionFileBrowserNotice.connectToBrowse => l10n.sessionFilesConnectBrowse,
    SessionFileBrowserNotice.connectToPreview =>
      l10n.sessionFilesConnectPreview,
    SessionFileBrowserNotice.previewTextOnly =>
      l10n.sessionFilesPreviewTextOnly,
    SessionFileBrowserNotice.reading => l10n.sessionFilesReading(
      state.noticeArgument ?? l10n.sessionFilesUnnamed,
    ),
    SessionFileBrowserNotice.previewMimeUnavailable =>
      l10n.sessionFilesPreviewMimeUnavailable(
        state.noticeArgument ?? l10n.sessionFilesTitle,
      ),
    SessionFileBrowserNotice.previewTruncated =>
      l10n.sessionFilesPreviewTruncated(state.noticeArgument ?? '0'),
    SessionFileBrowserNotice.pathNotFound => l10n.sessionFilesPathNotFound,
    SessionFileBrowserNotice.noWorkingDirectory =>
      l10n.sessionFilesNoWorkingDirectory,
    SessionFileBrowserNotice.pathOutsideWorkspace =>
      l10n.sessionFilesPathOutsideWorkspace,
    SessionFileBrowserNotice.symlinkNotReadable =>
      l10n.sessionFilesSymlinkNotReadable,
    SessionFileBrowserNotice.notRegularFile => l10n.sessionFilesNotRegular,
    SessionFileBrowserNotice.notDirectory => l10n.sessionFilesNotDirectory,
    SessionFileBrowserNotice.invalidRequest => l10n.sessionFilesInvalidRequest,
    SessionFileBrowserNotice.downloadTooLarge =>
      l10n.sessionFilesDownloadTooLarge,
    SessionFileBrowserNotice.remoteDisabled => l10n.sessionFilesRemoteDisabled,
    SessionFileBrowserNotice.failed => l10n.sessionFilesFailed,
    null =>
      state.phase == SessionFileBrowserPhase.idle
          ? l10n.sessionFilesLoadingWorkspace
          : l10n.sessionFilesLoading,
  };
}

class _SessionFileBreadcrumbs extends StatelessWidget {
  const _SessionFileBreadcrumbs({
    required this.breadcrumbs,
    required this.onOpenPath,
  });

  final List<SessionFileBreadcrumb> breadcrumbs;
  final void Function(String path) onOpenPath;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Wrap(
      key: const Key('session-detail-files-breadcrumbs'),
      spacing: 4,
      runSpacing: 4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        for (var index = 0; index < breadcrumbs.length; index++) ...[
          if (index > 0) const Icon(Icons.chevron_right, size: 16),
          TextButton(
            key: ValueKey(
              'session-detail-files-breadcrumb-${breadcrumbs[index].path}',
            ),
            onPressed: () => onOpenPath(breadcrumbs[index].path),
            child: Text(
              breadcrumbs[index].path.isEmpty
                  ? l10n.workspace
                  : breadcrumbs[index].label,
            ),
          ),
        ],
      ],
    );
  }
}

class _SessionFilesEntries extends StatelessWidget {
  const _SessionFilesEntries({
    required this.entries,
    required this.onOpenEntry,
    required this.onPreviewFile,
    required this.onDownloadFile,
  });

  final List<FsDirEntry> entries;
  final void Function(FsDirEntry entry) onOpenEntry;
  final Future<void> Function(FsDirEntry entry) onPreviewFile;
  final Future<void> Function(FsDirEntry entry) onDownloadFile;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    if (entries.isEmpty) {
      return _SessionFilesStatus(
        key: const Key('session-detail-files-empty-state'),
        icon: Icons.folder_off_outlined,
        message: l10n.sessionFilesEmptyDirectory,
      );
    }

    return Column(
      key: const Key('session-detail-files-entries'),
      children: [
        for (final entry in entries)
          _SessionFileEntryRow(
            key: ValueKey('session-detail-files-entry-${entry.path}'),
            entry: entry,
            onOpenEntry: onOpenEntry,
            onPreviewFile: onPreviewFile,
            onDownloadFile: onDownloadFile,
          ),
      ],
    );
  }
}

class _SessionFileEntryRow extends StatelessWidget {
  const _SessionFileEntryRow({
    required this.entry,
    required this.onOpenEntry,
    required this.onPreviewFile,
    required this.onDownloadFile,
    super.key,
  });

  final FsDirEntry entry;
  final void Function(FsDirEntry entry) onOpenEntry;
  final Future<void> Function(FsDirEntry entry) onPreviewFile;
  final Future<void> Function(FsDirEntry entry) onDownloadFile;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final isDirectory = entry.type == 'directory';
    final isFile = entry.type == 'file';
    final isSymlink = entry.type == 'symlink';
    return ListTile(
      key: ValueKey('session-detail-files-row-${entry.path}'),
      leading: Icon(_iconForSessionFileEntry(entry)),
      title: SelectableText(
        entry.name.isEmpty ? l10n.sessionFilesUnnamed : entry.name,
        key: ValueKey('session-detail-files-name-${entry.path}'),
      ),
      subtitle: SelectableText(_sessionFileEntrySubtitle(l10n, entry)),
      enabled: !isSymlink,
      onTap: isDirectory ? () => onOpenEntry(entry) : null,
      trailing: isFile
          ? Wrap(
              spacing: 4,
              children: [
                IconButton(
                  key: ValueKey('session-detail-files-preview-${entry.path}'),
                  tooltip: l10n.sessionFilesPreviewFile,
                  icon: const Icon(Icons.visibility_outlined),
                  onPressed: () => onPreviewFile(entry),
                ),
                IconButton(
                  key: ValueKey('session-detail-files-download-${entry.path}'),
                  tooltip: l10n.sessionFilesDownloadFile,
                  icon: const Icon(Icons.download_outlined),
                  onPressed: () => onDownloadFile(entry),
                ),
              ],
            )
          : isSymlink
          ? Tooltip(
              message: l10n.sessionFilesSymlinkHint,
              child: const Icon(Icons.link_off_outlined),
            )
          : null,
    );
  }
}

class _SessionFilesStatus extends StatelessWidget {
  const _SessionFilesStatus({
    required this.icon,
    required this.message,
    this.technicalDetail,
    super.key,
  });

  final IconData icon;
  final String message;
  final String? technicalDetail;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Column(
        children: [
          Icon(icon, size: 32),
          const SizedBox(height: 8),
          SelectableText(
            message,
            textAlign: TextAlign.center,
          ),
          if (technicalDetail?.trim().isNotEmpty ?? false)
            Material(
              type: MaterialType.transparency,
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: Text(AppLocalizations.of(context).technicalDetails),
                children: [SelectableText(technicalDetail!)],
              ),
            ),
        ],
      ),
    );
  }
}

IconData _iconForSessionFileEntry(FsDirEntry entry) {
  return switch (entry.type) {
    'directory' => Icons.folder_outlined,
    'file' => Icons.insert_drive_file_outlined,
    'symlink' => Icons.link_off_outlined,
    _ => Icons.help_outline,
  };
}

String _sessionFileEntrySubtitle(
  AppLocalizations l10n,
  FsDirEntry entry,
) {
  final type = switch (entry.type) {
    'directory' => l10n.sessionFileTypeDirectory,
    'file' => l10n.sessionFileTypeFile,
    'symlink' => l10n.sessionFileTypeSymlink,
    _ => l10n.sessionFileTypeOther,
  };
  return l10n.sessionFileMetadata(type, entry.size);
}

class _DebugPanel extends StatelessWidget {
  const _DebugPanel({required this.state, super.key});

  final SessionDetailState state;

  @override
  Widget build(BuildContext context) {
    return ListView(
      children: [
        Card(
          key: const Key('session-detail-debug-identity'),
          child: ListTile(
            leading: const Icon(Icons.fingerprint_outlined),
            title: const Text('Session identity'),
            subtitle: SelectableText('${state.tool} / ${state.sessionId}'),
          ),
        ),
        const SizedBox(height: 8),
        _DebugInlineScheduleFreshness(state: state),
        const SizedBox(height: 8),
        _DebugTimeline(state: state),
      ],
    );
  }
}

/// U6: the freshness of this session's inline schedule rows, read from the
/// diagnostics store rather than the schedule controller.
///
/// Opening Debug unmounts Chat, which auto-disposes that controller and cancels
/// its poll timer — watching it here would either show nothing or, worse, keep
/// the polling alive off screen. Developer-facing copy, so it is not localized.
class _DebugInlineScheduleFreshness extends ConsumerWidget {
  const _DebugInlineScheduleFreshness({required this.state});

  final SessionDetailState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scopeKey = ref.watch(
      activeBrokerProfileProvider.select(
        (profile) => RosterSource.of(profile)?.storageKey,
      ),
    );
    // Source-qualified: this store outlives the controller that wrote it, two
    // brokers can hand out the same native tool/session id, and an endpoint
    // edit keeps the profile id — so an id-keyed lookup showed the previous
    // machine's reading as this one's.
    final diagnostics = scopeKey == null
        ? null
        : ref.watch(
            inlineScheduleDiagnosticsProvider.select(
              (readings) =>
                  readings[InlineScheduleDiagnosticsKey(
                    brokerScopeKey: scopeKey,
                    tool: state.tool,
                    sessionId: state.sessionId,
                  )],
            ),
          );
    final label = switch (diagnostics?.freshness) {
      null || InlineScheduleFreshness.unknown => 'no canonical read yet',
      InlineScheduleFreshness.fresh => 'fresh',
      InlineScheduleFreshness.stale => 'stale',
    };
    final failureKind = diagnostics?.passiveFailureKind;
    return Card(
      key: const Key('session-detail-debug-schedule-freshness'),
      child: ListTile(
        leading: const Icon(Icons.schedule_outlined),
        title: const Text('Inline schedule freshness'),
        subtitle: SelectableText(
          [
            '$label · ${diagnostics?.scheduleCount ?? 0} row(s)',
            if (failureKind != null)
              'last passive failure: ${failureKind.name}',
            if (diagnostics?.passiveFailureDetail case final detail?) detail,
          ].join('\n'),
        ),
      ),
    );
  }
}

class _TerminalSurface extends StatelessWidget {
  const _TerminalSurface({
    required this.messages,
    required this.totalCount,
    required this.onCopiedVisible,
    required this.canToggle,
    required this.summaryLabel,
    required this.copyLabel,
    required this.showAllLabel,
    required this.onToggleShowAll,
    required this.toggleKey,
  });

  final List<AgentMessage> messages;
  final int totalCount;
  final VoidCallback onCopiedVisible;
  final bool canToggle;
  final String summaryLabel;
  final String copyLabel;
  final String showAllLabel;
  final VoidCallback? onToggleShowAll;
  final Key toggleKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    return Card(
      key: const Key('session-detail-terminal-surface'),
      color: theme.colorScheme.surfaceContainerLowest,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: 8,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                const Icon(Icons.terminal_outlined),
                Text(
                  l10n.sessionTerminalOutputCount(totalCount),
                  style: theme.textTheme.titleSmall,
                ),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  summaryLabel,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                OutlinedButton(
                  key: const Key('session-detail-terminal-copy-visible'),
                  onPressed: onCopiedVisible,
                  child: Text(copyLabel),
                ),
                if (canToggle)
                  OutlinedButton(
                    key: toggleKey,
                    onPressed: onToggleShowAll,
                    child: Text(showAllLabel),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            for (var index = 0; index < messages.length; index++) ...[
              if (index > 0) const Divider(height: 1),
              _TerminalSurfaceMessage(
                message: messages[index],
                sourceId: '$index-${messages[index].id ?? 'live'}',
                key: ValueKey('session-detail-terminal-summary-item-$index'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

String _visibleTerminalOutputText(List<AgentMessage> messages) {
  return messages
      .map(_terminalOutputText)
      .where((value) => value.isNotEmpty)
      .join('\n');
}

class _TerminalSurfaceMessage extends StatelessWidget {
  const _TerminalSurfaceMessage({
    required this.message,
    required this.sourceId,
    required super.key,
  });

  final AgentMessage message;
  final String sourceId;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final summary = _terminalSummaryFromMessage(
      AppLocalizations.of(context),
      message,
    );
    final outputText = _terminalOutputText(message);

    return Padding(
      key: ValueKey('session-detail-terminal-summary-item-$sourceId'),
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (summary.isNotEmpty)
            SelectionArea(
              child: Text(
                summary,
                style: theme.textTheme.bodyMedium,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          if (outputText.isNotEmpty) ...[
            const SizedBox(height: 8),
            Container(
              key: ValueKey('session-detail-terminal-output-$sourceId'),
              width: double.infinity,
              decoration: BoxDecoration(
                color: theme.colorScheme.surface,
                border: Border.all(color: theme.colorScheme.outline),
                borderRadius: BorderRadius.circular(8),
              ),
              padding: const EdgeInsets.all(8),
              child: SelectableText(
                outputText,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontFamily: 'monospace',
                  height: 1.2,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
