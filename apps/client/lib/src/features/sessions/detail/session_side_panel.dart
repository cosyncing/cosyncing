part of 'session_detail_page.dart';

/// Actions owned by the retained session page, shared with its docked views.
/// This keeps a second panel from creating another connection or draft owner.
class _SidePanelBinding {
  const _SidePanelBinding({
    required this.source,
    required this.archivedIdentities,
    required this.onArchive,
    required this.draft,
    required this.onExport,
    required this.onFork,
    required this.onDownloadArtifact,
    required this.onPreviewArtifact,
    required this.onPreviewFile,
    required this.onDownloadFile,
  });
  final RosterSource? source;
  final Map<String, String> archivedIdentities;
  final ValueChanged<List<_LiveStateItem>> onArchive;
  final TextEditingController draft;
  final VoidCallback onExport;
  final VoidCallback onFork;
  final Future<void> Function(SessionArtifactDescriptor) onDownloadArtifact;
  final Future<void> Function(SessionArtifactDescriptor) onPreviewArtifact;
  final Future<void> Function(FsDirEntry) onPreviewFile;
  final Future<void> Function(FsDirEntry) onDownloadFile;
}

final StateProviderFamily<_SidePanelBinding?, SessionDetailKey>
_sidePanelBindingProvider =
    StateProvider.family<_SidePanelBinding?, SessionDetailKey>(
      (ref, key) => null,
    );

/// The same Status / Files content, docked beside the retained transcript.
class SessionSidePanel extends ConsumerWidget {
  /// Shows the selected session view without mounting a second session page.
  const SessionSidePanel({required this.pane, super.key});

  /// Session and view being shown.
  final SessionPanelKey pane;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final binding = ref.watch(_sidePanelBindingProvider(pane.session));
    final source = RosterSource.of(ref.watch(activeBrokerProfileProvider));
    if (binding == null || binding.source != source) {
      return const SizedBox.shrink();
    }
    final state = watchQualifiedDetail(ref, pane.session);
    final controller = ref.read(
      sessionDetailControllerProvider(pane.session).notifier,
    );
    final connected =
        state.connectionStatus == SessionDetailConnectionStatus.connected;
    final hasClient = ref.watch(brokerClientProvider).valueOrNull != null;
    if (pane.kind == SessionPanelKind.status) {
      return Padding(
        padding: const EdgeInsets.all(12),
        child: _StatusTabPanel(
          sessionKey: pane.session,
          archivedIdentities: binding.archivedIdentities,
          onArchive: binding.onArchive,
          draftController: binding.draft,
          hasActiveBrokerClient: hasClient,
          onAttach: () => unawaited(controller.attach()),
          onDetach: () => unawaited(controller.disconnect()),
          onExportTranscript: binding.onExport,
          onForkSession: binding.onFork,
        ),
      );
    }
    final transfers = ref
        .watch(sessionArtifactTransferControllerProvider)
        .where(
          (transfer) =>
              source != null &&
              transfer.sessionKey == pane.session &&
              transfer.brokerProfileId == source.storageKey,
        )
        .toList(growable: false);
    return Padding(
      padding: const EdgeInsets.all(12),
      child: _FilesPanel(
        sessionKey: pane.session,
        sessionLabel: workspaceSessionLabel(
          session: pane.session,
          open: ref.watch(openSessionsControllerProvider).valueOrNull,
          l10n: AppLocalizations.of(context),
        ),
        isConnected: connected,
        descriptors: state.fileArtifactDescriptors,
        actionStates: state.artifactActionStates,
        hasActiveBrokerClient: hasClient,
        transfers: transfers,
        onRetryTransfer: (id) => ref
            .read(sessionArtifactTransferWorkerProvider)
            .retryTransfer(id, hasActiveBrokerClient: hasClient),
        onCancelTransfer: (id) =>
            ref.read(sessionArtifactTransferWorkerProvider).cancelTransfer(id),
        onDownloadArtifact: binding.onDownloadArtifact,
        onPreviewArtifact: binding.onPreviewArtifact,
        onPreviewFile: binding.onPreviewFile,
        onDownloadFile: binding.onDownloadFile,
        showInlinePreview: false,
      ),
    );
  }
}
