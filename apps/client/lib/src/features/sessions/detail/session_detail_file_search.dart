part of 'session_detail_page.dart';

extension _SessionDetailFileSearch on _SessionDetailPageState {
  void _onFindFileReference(SessionFileReference reference) {
    unawaited(_findFileReference(reference));
  }

  void _onFindFileParentReference(SessionFileReference reference) {
    unawaited(_findFileReference(reference, openParent: true));
  }

  Future<void> _findFileReference(
    SessionFileReference reference, {
    bool openParent = false,
  }) async {
    if (_findingFile) return;
    _findingFile = true;
    final browserKey = _fileBrowserKey;
    final repositoryFuture = ref.read(
      sessionFileBrowserRepositoryProvider.future,
    );
    final known = <SessionFileReference>[
      for (final message in _sessionState.messageEvents.reversed)
        ...fileReferencesForToolRow(
          call: message.type == AgentMessageType.toolCall ? message : null,
          result: message.type == AgentMessageType.toolResult ? message : null,
        ),
      for (final message in _sessionState.messageEvents.reversed)
        if (message.type == AgentMessageType.fsEdit) ...[
          if (message.raw['path'] case final String path)
            if (SessionFileReference.parse(path) case final reference?)
              reference,
          ...fileChangeReferences(message.raw['fileChanges']),
        ],
      for (final artifact in _sessionState.fileArtifactDescriptors)
        if (SessionFileReference.parse(artifact.path) case final path?) path,
    ];
    try {
      final selected = await showDialog<SessionFileReference>(
        context: context,
        builder: (context) => _SessionFileSearchDialog(
          reference: reference,
          resolve: () async {
            final repository = await repositoryFuture;
            if (repository == null) {
              throw StateError('No active file repository');
            }
            return resolveTranscriptFile(
              reference: reference,
              knownReferences: known,
              stat: (path) =>
                  repository.listPath(browserKey.session, path: path),
              search: (query) {
                if (repository is! SessionFileSearchRepository) {
                  throw StateError('File search unavailable');
                }
                return (repository as SessionFileSearchRepository).searchFiles(
                  browserKey.session,
                  query: query,
                );
              },
            );
          },
        ),
      );
      if (selected != null && mounted && _fileBrowserKey == browserKey) {
        await _openFileReference(openParent ? selected.parent : selected);
      }
    } finally {
      _findingFile = false;
    }
  }
}

class _SessionFileSearchDialog extends StatefulWidget {
  const _SessionFileSearchDialog({
    required this.reference,
    required this.resolve,
  });

  final SessionFileReference reference;
  final Future<FsSearchResult> Function() resolve;

  @override
  State<_SessionFileSearchDialog> createState() =>
      _SessionFileSearchDialogState();
}

class _SessionFileSearchDialogState extends State<_SessionFileSearchDialog> {
  FsSearchResult? _result;
  Object? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_resolve());
  }

  SessionFileReference _reference(FsNodeInfo match) => SessionFileReference(
    rawPath: match.path,
    line: widget.reference.line,
    column: widget.reference.column,
    kind: match.isDirectory
        ? SessionFileReferenceKind.directory
        : SessionFileReferenceKind.file,
  );

  Future<void> _resolve() async {
    try {
      final result = await widget.resolve();
      if (!mounted) return;
      if (result.matches.length == 1 && !result.truncated) {
        Navigator.of(context).pop(_reference(result.matches.single));
        return;
      }
      setState(() => _result = result);
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final result = _result;
    final error = _error;
    return AlertDialog(
      key: const Key('session-file-search-dialog'),
      title: Text(l10n.sessionSelectionFindFile),
      content: SizedBox(
        width: 560,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.5,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                widget.reference.displayPath,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 16),
              if (error != null)
                Text(switch (error) {
                  BrokerException(
                    error: BrokerError(code: 'FS_REMOTE_DISABLED'),
                  ) =>
                    l10n.sessionFilesRemoteDisabled,
                  BrokerException(error: BrokerError(code: 'PATH_ESCAPE')) =>
                    l10n.sessionFilesPathOutsideWorkspace,
                  BrokerException(error: BrokerError(code: 'PATH_SYMLINK')) =>
                    l10n.sessionFilesSymlinkNotReadable,
                  _ => l10n.sessionFilesFailed,
                })
              else if (result == null) ...[
                const LinearProgressIndicator(),
                const SizedBox(height: 12),
                Text(l10n.sessionFileSearchLoading),
              ] else ...[
                if (result.truncated) ...[
                  Text(l10n.sessionFileSearchPartial),
                  const SizedBox(height: 12),
                ],
                if (result.matches.isEmpty)
                  Text(l10n.sessionFileSearchNoMatches)
                else ...[
                  Text(l10n.sessionFileSearchChoose),
                  const SizedBox(height: 8),
                  Flexible(
                    child: ListView(
                      shrinkWrap: true,
                      children: [
                        for (final match in result.matches)
                          ListTile(
                            key: ValueKey(
                              'session-file-search-match-${match.path}',
                            ),
                            dense: true,
                            title: Text(match.path),
                            onTap: () =>
                                Navigator.of(context).pop(_reference(match)),
                          ),
                      ],
                    ),
                  ),
                ],
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.cancel),
        ),
      ],
    );
  }
}
