part of 'session_detail_page.dart';

class _ArtifactTransferSurface extends StatelessWidget {
  const _ArtifactTransferSurface({
    required this.transfers,
    required this.onRetryTransfer,
    required this.onCancelTransfer,
  });

  static const _maxVisibleTransfers = 5;

  final List<SessionArtifactTransfer> transfers;
  final void Function(String id) onRetryTransfer;
  final void Function(String id) onCancelTransfer;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final visibleTransfers = transfers.length <= _maxVisibleTransfers
        ? transfers
        : transfers.sublist(0, _maxVisibleTransfers);
    final hiddenCount = transfers.length - visibleTransfers.length;

    return Card(
      key: const Key('session-detail-artifact-transfer-surface'),
      color: theme.colorScheme.surfaceContainerLowest,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.sync_alt_outlined),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    l10n.sessionTransfersCount(transfers.length),
                    style: theme.textTheme.titleSmall,
                  ),
                ),
              ],
            ),
            if (hiddenCount > 0) ...[
              const SizedBox(height: 8),
              SelectableText(
                l10n.showingLatestEarlier(
                  visibleTransfers.length,
                  hiddenCount,
                ),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            const SizedBox(height: 8),
            for (var index = 0; index < visibleTransfers.length; index++) ...[
              if (index > 0) const Divider(height: 1),
              _ArtifactTransferRow(
                transfer: visibleTransfers[index],
                onRetryTransfer: onRetryTransfer,
                onCancelTransfer: onCancelTransfer,
                key: ValueKey(
                  'session-detail-artifact-transfer-'
                  '${visibleTransfers[index].id}',
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ArtifactTransferRow extends ConsumerStatefulWidget {
  const _ArtifactTransferRow({
    required this.transfer,
    required this.onRetryTransfer,
    required this.onCancelTransfer,
    required super.key,
  });

  final SessionArtifactTransfer transfer;
  final void Function(String id) onRetryTransfer;
  final void Function(String id) onCancelTransfer;

  @override
  ConsumerState<_ArtifactTransferRow> createState() =>
      _ArtifactTransferRowState();
}

class _ArtifactTransferRowState extends ConsumerState<_ArtifactTransferRow> {
  late final FocusNode _focusNode;
  var _hasFocus = false;

  @override
  void initState() {
    super.initState();
    _focusNode = FocusNode(
      debugLabel: 'artifact-transfer-${widget.transfer.id}',
    );
  }

  @override
  void dispose() {
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final transfer = widget.transfer;
    final isFailed = transfer.status == SessionArtifactTransferStatus.failed;
    final isWorkerActionable =
        transfer.direction != SessionArtifactTransferDirection.upload;
    final canRetry =
        isWorkerActionable &&
        (transfer.status == SessionArtifactTransferStatus.queued ||
            transfer.status == SessionArtifactTransferStatus.failed ||
            transfer.status == SessionArtifactTransferStatus.canceled);
    final canCancel =
        isWorkerActionable &&
        (transfer.status == SessionArtifactTransferStatus.queued ||
            transfer.status == SessionArtifactTransferStatus.running ||
            transfer.status == SessionArtifactTransferStatus.cached);
    final localTransferFileOpener = ref.read(localTransferFileOpenerProvider);
    final localPath = _sessionDetailTransferLocalPath(transfer);
    final localPathLabel = _sessionDetailTransferLocalPathLabel(
      l10n,
      transfer,
      localPath,
    );
    final progressLabel = _sessionDetailTransferProgressLabel(l10n, transfer);
    final statusLabel = _sessionDetailTransferStatusLabel(
      l10n,
      transfer.status,
    );
    final detailLabel = switch ((isFailed, progressLabel.isEmpty)) {
      (true, true) => '$statusLabel — ${l10n.transferFailed}',
      (true, false) => '$statusLabel — ${l10n.transferFailed} — $progressLabel',
      (false, true) => statusLabel,
      (false, false) => '$statusLabel — $progressLabel',
    };
    final detailStyle = theme.textTheme.bodySmall?.copyWith(
      color: isFailed
          ? theme.colorScheme.error
          : theme.colorScheme.onSurfaceVariant,
    );
    final focusBorderColor = _hasFocus
        ? theme.colorScheme.primary
        : Colors.transparent;

    return Focus(
      focusNode: _focusNode,
      onFocusChange: (hasFocus) => setState(() => _hasFocus = hasFocus),
      onKeyEvent: (node, event) {
        if (event is! KeyDownEvent || !canCancel) {
          return KeyEventResult.ignored;
        }
        if (event.logicalKey == LogicalKeyboardKey.escape ||
            event.logicalKey == LogicalKeyboardKey.delete) {
          widget.onCancelTransfer(transfer.id);
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: _focusNode.requestFocus,
        child: DecoratedBox(
          decoration: BoxDecoration(
            border: Border.all(color: focusBorderColor),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _TransferStatusIcon(status: transfer.status),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SelectionArea(
                        child: Text(
                          '${_sessionDetailTransferDirectionLabel(
                            l10n,
                            transfer.direction,
                          )}: ${transfer.fileName}',
                          style: theme.textTheme.bodyMedium,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(height: 2),
                      SelectionArea(
                        child: Text(
                          detailLabel,
                          style: detailStyle,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (localPathLabel != null) ...[
                        const SizedBox(height: 4),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: SelectionArea(
                                child: Text(
                                  localPathLabel,
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    color: theme.colorScheme.onSurfaceVariant,
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ),
                            const SizedBox(width: 6),
                            IconButton(
                              key: ValueKey(
                                'session-detail-transfer-copy-${transfer.id}',
                              ),
                              tooltip: l10n.copyPath,
                              icon: const Icon(Icons.content_copy, size: 18),
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(
                                minWidth: 48,
                                minHeight: 48,
                              ),
                              onPressed: () => _copyTransferLocalPath(
                                context,
                                localPath,
                              ),
                            ),
                            IconButton(
                              key: ValueKey(
                                'session-detail-transfer-open-${transfer.id}',
                              ),
                              tooltip: l10n.openFile,
                              icon: const Icon(Icons.open_in_new, size: 18),
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(
                                minWidth: 48,
                                minHeight: 48,
                              ),
                              onPressed: () => _openTransferLocalPath(
                                context,
                                localTransferFileOpener,
                                localPath!,
                              ),
                            ),
                            IconButton(
                              key: ValueKey(
                                'session-detail-transfer-reveal-${transfer.id}',
                              ),
                              tooltip: l10n.revealInFolder,
                              icon: const Icon(
                                Icons.folder_open_outlined,
                                size: 18,
                              ),
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(
                                minWidth: 48,
                                minHeight: 48,
                              ),
                              onPressed: () => _revealTransferLocalPath(
                                context,
                                localTransferFileOpener,
                                localPath!,
                              ),
                            ),
                            IconButton(
                              key: ValueKey(
                                'session-detail-transfer-preview-'
                                '${transfer.id}',
                              ),
                              tooltip: l10n.previewText,
                              icon: const Icon(
                                Icons.text_snippet_outlined,
                                size: 18,
                              ),
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(
                                minWidth: 48,
                                minHeight: 48,
                              ),
                              onPressed: () => _previewTransferLocalText(
                                context,
                                localTransferFileOpener,
                                localPath!,
                                transfer,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
                if (canRetry) ...[
                  const SizedBox(width: 8),
                  TextButton(
                    key: ValueKey(
                      'session-detail-transfer-retry-${transfer.id}',
                    ),
                    onPressed: () => widget.onRetryTransfer(transfer.id),
                    child: Text(l10n.retry),
                  ),
                ],
                if (canCancel) ...[
                  const SizedBox(width: 8),
                  TextButton(
                    key: ValueKey(
                      'session-detail-transfer-cancel-${transfer.id}',
                    ),
                    onPressed: () => widget.onCancelTransfer(transfer.id),
                    child: Text(l10n.cancel),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

Future<void> _copyTransferLocalPath(
  BuildContext context,
  String? localPath,
) async {
  final path = localPath;
  if (path == null) {
    return;
  }

  await Clipboard.setData(ClipboardData(text: path));
  if (!context.mounted) {
    return;
  }

  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(AppLocalizations.of(context).transferPathCopied),
    ),
  );
}

Future<void> _openTransferLocalPath(
  BuildContext context,
  LocalTransferFileOpener localTransferFileOpener,
  String localPath,
) async {
  final l10n = AppLocalizations.of(context);
  final result = await localTransferFileOpener.openFile(localPath);
  if (!context.mounted) {
    return;
  }

  if (result.isSuccess) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(l10n.transferOpenedFile)),
    );
    return;
  }

  final message = result.isUnsupported
      ? l10n.transferOpenUnsupported
      : l10n.transferOpenFailed;
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(message)),
  );
}

Future<void> _revealTransferLocalPath(
  BuildContext context,
  LocalTransferFileOpener localTransferFileOpener,
  String localPath,
) async {
  final l10n = AppLocalizations.of(context);
  final result = await localTransferFileOpener.revealInFolder(localPath);
  if (!context.mounted) {
    return;
  }

  if (result.isSuccess) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(l10n.transferRevealedInFolder)),
    );
    return;
  }

  final message = result.isUnsupported
      ? l10n.transferRevealUnsupported
      : l10n.transferRevealFailed;
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(message)),
  );
}

Future<void> _previewTransferLocalText(
  BuildContext context,
  LocalTransferFileOpener localTransferFileOpener,
  String localPath,
  SessionArtifactTransfer transfer,
) async {
  final result = await localTransferFileOpener.previewTextFile(localPath);
  if (!context.mounted) {
    return;
  }

  if (result.isSuccess) {
    await _showSessionTransferTextPreviewDialog(
      context,
      transfer,
      localPath,
      result,
    );
    return;
  }

  final l10n = AppLocalizations.of(context);
  final message = switch ((
    result.isUnsupported,
    result.isBinary,
    result.isFailure,
  )) {
    (true, _, _) => l10n.transferPreviewUnsupported,
    (_, true, _) => l10n.transferPreviewBinary,
    (_, _, true) => l10n.transferPreviewFailed,
    _ => l10n.transferPreviewUnavailable,
  };
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(message)),
  );
}

Future<void> _showSessionTransferTextPreviewDialog(
  BuildContext context,
  SessionArtifactTransfer transfer,
  String localPath,
  LocalTransferTextPreviewResult result,
) async {
  final l10n = AppLocalizations.of(context);
  await showDialog<void>(
    context: context,
    builder: (context) {
      return AlertDialog(
        title: Text(
          l10n.transferPreviewTitle(transfer.fileName),
          key: ValueKey('session-detail-transfer-preview-title-${transfer.id}'),
        ),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: SelectionArea(
              child: DefaultTextStyle(
                style: Theme.of(context).textTheme.bodySmall!,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '${l10n.fileNameLabel}: ${transfer.fileName}',
                      key: ValueKey(
                        'session-detail-transfer-preview-filename-'
                        '${transfer.id}',
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '${l10n.pathLabel}: $localPath',
                      key: ValueKey(
                        'session-detail-transfer-preview-path-${transfer.id}',
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      result.content,
                      key: ValueKey(
                        'session-detail-transfer-preview-content-'
                        '${transfer.id}',
                      ),
                      style: const TextStyle(fontFamily: 'monospace'),
                    ),
                    if (result.isTruncated) ...[
                      const SizedBox(height: 8),
                      Text(
                        l10n.transferPreviewTruncated,
                        key: ValueKey(
                          'session-detail-transfer-preview-truncated-'
                          '${transfer.id}',
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(l10n.close),
          ),
        ],
      );
    },
  );
}

Future<void> _showSessionFilePreviewDialog(
  BuildContext context,
  SessionFilePreview preview,
) async {
  await showDialog<void>(
    context: context,
    builder: (context) => _SessionFilePreviewDialog(preview: preview),
  );
}

/// Lines the viewer materializes at once.
///
/// `/fs/read` caps at 1 MiB, which is ~20k lines of source — building all of
/// them costs a visibly slow first frame for content nobody scrolls to. The
/// window is CENTERED on the line anchor when there is one, so a mention at
/// line 12,000 still lands on line 12,000 and the gutter numbers stay absolute.
const int _sessionFilePreviewWindowLines = 2000;

/// The read-only file viewer, with a line gutter and a scroll-to-line anchor.
class _SessionFilePreviewDialog extends StatefulWidget {
  const _SessionFilePreviewDialog({required this.preview});

  final SessionFilePreview preview;

  @override
  State<_SessionFilePreviewDialog> createState() =>
      _SessionFilePreviewDialogState();
}

class _SessionFilePreviewDialogState extends State<_SessionFilePreviewDialog> {
  final ScrollController _vertical = ScrollController();
  final GlobalKey _anchorKey = GlobalKey(
    debugLabel: 'session-file-preview-anchor',
  );
  late final List<String> _lines = widget.preview.text.isEmpty
      ? const <String>[]
      : widget.preview.text.split('\n');
  late final int _windowStart = _resolveWindowStart();
  bool _anchorSettled = false;

  /// 1-based line the mention asked for, when the broker actually delivered it.
  int? get _anchorLine {
    final line = widget.preview.anchorLine;
    if (line == null || line < 1 || line > _lines.length) return null;
    return line;
  }

  int _resolveWindowStart() {
    if (_lines.length <= _sessionFilePreviewWindowLines) return 0;
    final anchor = widget.preview.anchorLine;
    if (anchor == null || anchor < 1 || anchor > _lines.length) return 0;
    final centered = anchor - 1 - _sessionFilePreviewWindowLines ~/ 2;
    final last = _lines.length - _sessionFilePreviewWindowLines;
    if (centered < 0) return 0;
    return centered > last ? last : centered;
  }

  int get _windowEnd {
    final end = _windowStart + _sessionFilePreviewWindowLines;
    return end > _lines.length ? _lines.length : end;
  }

  @override
  void initState() {
    super.initState();
    if (_anchorLine != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _revealAnchor());
    }
  }

  @override
  void dispose() {
    _vertical.dispose();
    super.dispose();
  }

  void _revealAnchor() {
    if (!mounted || _anchorSettled) return;
    final target = _anchorKey.currentContext;
    if (target == null) return;
    _anchorSettled = true;
    // No animation: the reader asked for a specific line, so the viewer opens
    // there rather than scrolling past everything above it.
    unawaited(Scrollable.ensureVisible(target, alignment: 0.25));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final preview = widget.preview;
    final start = _windowStart;
    final end = _windowEnd;
    // Gutter width from the widest number actually rendered, so a file at line
    // 4 and one at line 120,000 both align without a fixed guess.
    final gutterSample = end == 0 ? '' : '$end';
    final anchor = _anchorLine;
    final mono = theme.textTheme.bodySmall?.copyWith(
      fontFamily: 'monospace',
      height: 1.35,
    );

    return AlertDialog(
      title: Text(
        l10n.transferPreviewTitle(preview.displayName),
        key: ValueKey('session-detail-files-preview-title-${preview.path}'),
      ),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: SelectionArea(
            child: DefaultTextStyle(
              style: theme.textTheme.bodySmall!,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    '${l10n.fileNameLabel}: ${preview.displayName}',
                    key: ValueKey(
                      'session-detail-files-preview-filename-${preview.path}',
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '${l10n.pathLabel}: ${preview.path}',
                    key: ValueKey(
                      'session-detail-files-preview-path-${preview.path}',
                    ),
                  ),
                  if (preview.mimeType != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      '${l10n.mimeTypeLabel}: ${preview.mimeType}',
                      key: ValueKey(
                        'session-detail-files-preview-mime-${preview.path}',
                      ),
                    ),
                  ],
                  if (anchor != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      l10n.sessionFilePreviewAnchorLine(anchor),
                      key: ValueKey(
                        'session-detail-files-preview-anchor-${preview.path}',
                      ),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.primary,
                      ),
                    ),
                  ],
                  // The anchor is past what the Server delivered. Saying so is
                  // the whole point: silently landing on line 1 would read as
                  // "the mention was wrong" rather than "the read was bounded".
                  if (preview.anchorBeyondPreview) ...[
                    const SizedBox(height: 8),
                    Text(
                      l10n.sessionFilePreviewAnchorBeyond(
                        preview.anchorLine!,
                        _lines.length,
                      ),
                      key: ValueKey(
                        'session-detail-files-preview-anchor-beyond-'
                        '${preview.path}',
                      ),
                    ),
                  ],
                  if (start > 0 || end < _lines.length) ...[
                    const SizedBox(height: 8),
                    Text(
                      l10n.sessionFilePreviewLineWindow(start + 1, end),
                      key: ValueKey(
                        'session-detail-files-preview-window-${preview.path}',
                      ),
                    ),
                  ],
                  const SizedBox(height: 8),
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: IntrinsicWidth(
                      child: Column(
                        key: ValueKey(
                          'session-detail-files-preview-content-'
                          '${preview.path}',
                        ),
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          for (var index = start; index < end; index++)
                            _SessionFilePreviewLine(
                              key: index + 1 == anchor ? _anchorKey : null,
                              number: index + 1,
                              text: _lines[index],
                              gutterSample: gutterSample,
                              style: mono,
                              highlighted: index + 1 == anchor,
                              column: index + 1 == anchor
                                  ? preview.anchorColumn
                                  : null,
                            ),
                        ],
                      ),
                    ),
                  ),
                  if (preview.truncated) ...[
                    const SizedBox(height: 8),
                    Text(
                      l10n.sessionFilesPreviewTruncated(
                        preview.limit.toString(),
                      ),
                      key: ValueKey(
                        'session-detail-files-preview-truncated-'
                        '${preview.path}',
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.close),
        ),
      ],
    );
  }
}

/// One numbered viewer row, optionally the anchored line.
class _SessionFilePreviewLine extends StatelessWidget {
  const _SessionFilePreviewLine({
    required this.number,
    required this.text,
    required this.gutterSample,
    required this.style,
    this.highlighted = false,
    this.column,
    super.key,
  });

  final int number;
  final String text;

  /// Widest number in this window; sizes the gutter so digits stay aligned.
  final String gutterSample;
  final TextStyle? style;
  final bool highlighted;

  /// 1-based column to mark inside [text], when the mention carried one.
  final int? column;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final mark = column;
    final body = mark == null || mark < 1 || mark > text.length
        ? Text(text, style: style, softWrap: false)
        : Text.rich(
            TextSpan(
              children: [
                TextSpan(text: text.substring(0, mark - 1)),
                TextSpan(
                  text: text.substring(mark - 1, mark),
                  style: style?.copyWith(
                    backgroundColor: theme.colorScheme.primary.withValues(
                      alpha: 0.35,
                    ),
                  ),
                ),
                TextSpan(text: text.substring(mark)),
              ],
            ),
            style: style,
            softWrap: false,
          );
    return ColoredBox(
      color: highlighted
          ? theme.colorScheme.primary.withValues(alpha: 0.12)
          : Colors.transparent,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (gutterSample.isNotEmpty) ...[
            SizedBox(
              width: gutterSample.length * 8.0,
              child: Text(
                // A line number, not copy: formatted, never localized.
                number.toString(),
                textAlign: TextAlign.right,
                style: style?.copyWith(color: tokens.textTertiary),
              ),
            ),
            const SizedBox(width: 8),
          ],
          body,
        ],
      ),
    );
  }
}

String? _sessionDetailTransferLocalPath(SessionArtifactTransfer transfer) {
  final exportedPath = transfer.exportedPath?.trim();
  if (exportedPath != null && exportedPath.isNotEmpty) {
    return exportedPath;
  }

  final cachedPath = transfer.cachedFilePath?.trim();
  if (cachedPath != null && cachedPath.isNotEmpty) {
    return cachedPath;
  }

  return null;
}

String? _sessionDetailTransferLocalPathLabel(
  AppLocalizations l10n,
  SessionArtifactTransfer transfer,
  String? path,
) {
  final exportedPath = transfer.exportedPath?.trim();
  if (path == null) {
    return null;
  }
  if (exportedPath != null && exportedPath.isNotEmpty) {
    return l10n.transferSavedPath(path);
  }
  return l10n.transferCachedPath(path);
}

String _sessionDetailTransferDirectionLabel(
  AppLocalizations l10n,
  SessionArtifactTransferDirection direction,
) => switch (direction) {
  SessionArtifactTransferDirection.download => l10n.transferDirectionDownload,
  SessionArtifactTransferDirection.preview => l10n.transferDirectionPreview,
  SessionArtifactTransferDirection.upload => l10n.transferDirectionUpload,
};

String _sessionDetailTransferStatusLabel(
  AppLocalizations l10n,
  SessionArtifactTransferStatus status,
) => switch (status) {
  SessionArtifactTransferStatus.queued => l10n.transferStatusQueued,
  SessionArtifactTransferStatus.running => l10n.transferStatusRunning,
  SessionArtifactTransferStatus.cached => l10n.transferStatusCached,
  SessionArtifactTransferStatus.completed => l10n.transferStatusComplete,
  SessionArtifactTransferStatus.canceled => l10n.transferStatusCanceled,
  SessionArtifactTransferStatus.failed => l10n.transferStatusFailed,
};

String _sessionDetailTransferProgressLabel(
  AppLocalizations l10n,
  SessionArtifactTransfer transfer,
) {
  final transferred = transfer.bytesTransferred;
  final total = transfer.totalBytes;
  if (transferred == null && total == null) {
    return '';
  }
  if (transferred != null && total != null) {
    return l10n.transferProgressBytes(transferred, total);
  }
  if (transferred != null) {
    return l10n.transferProgressTransferredBytes(transferred);
  }
  return l10n.transferProgressBytes(0, total!);
}

SessionArtifactTransfer? _sessionDetailTransferForArtifactSummary(
  SessionArtifactDescriptor descriptor,
  List<SessionArtifactTransfer> transfers,
) {
  final actionKey = descriptor.actionStateKey;
  SessionArtifactTransfer? newest;
  for (final transfer in transfers) {
    if (transfer.actionKey != actionKey) {
      continue;
    }
    if (transfer.direction != SessionArtifactTransferDirection.download &&
        transfer.direction != SessionArtifactTransferDirection.preview) {
      continue;
    }
    if (_sessionDetailTransferLocalPath(transfer) == null) {
      continue;
    }
    if (newest == null ||
        transfer.updatedAt.isAfter(newest.updatedAt) ||
        (transfer.updatedAt == newest.updatedAt &&
            transfer.createdAt.isAfter(newest.createdAt))) {
      newest = transfer;
    }
  }
  return newest;
}

class _TransferStatusIcon extends StatelessWidget {
  const _TransferStatusIcon({required this.status});

  final SessionArtifactTransferStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final icon = switch (status) {
      SessionArtifactTransferStatus.queued => Icons.schedule_outlined,
      SessionArtifactTransferStatus.running => Icons.downloading_outlined,
      SessionArtifactTransferStatus.cached => Icons.inventory_2_outlined,
      SessionArtifactTransferStatus.completed => Icons.check_circle_outline,
      SessionArtifactTransferStatus.canceled => Icons.cancel_outlined,
      SessionArtifactTransferStatus.failed => Icons.error_outline,
    };
    final color = switch (status) {
      SessionArtifactTransferStatus.completed => theme.colorScheme.primary,
      SessionArtifactTransferStatus.failed => theme.colorScheme.error,
      _ => theme.colorScheme.onSurfaceVariant,
    };

    return Icon(icon, color: color, size: 20);
  }
}

class _ArtifactSurface extends StatelessWidget {
  const _ArtifactSurface({
    required this.descriptors,
    required this.transfers,
    required this.actionStates,
    required this.hasActiveBrokerClient,
    required this.onDownloadArtifact,
    required this.onPreviewArtifact,
  });

  static const _maxVisibleMessages = 5;

  final List<SessionArtifactDescriptor> descriptors;
  final List<SessionArtifactTransfer> transfers;
  final Map<String, SessionArtifactActionState> actionStates;
  final bool hasActiveBrokerClient;
  final Future<void> Function(SessionArtifactDescriptor descriptor)
  onDownloadArtifact;
  final Future<void> Function(SessionArtifactDescriptor descriptor)
  onPreviewArtifact;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final visibleDescriptors = descriptors.length <= _maxVisibleMessages
        ? descriptors
        : descriptors.sublist(descriptors.length - _maxVisibleMessages);
    final hiddenCount = descriptors.length - visibleDescriptors.length;
    final hiddenLabel = l10n.showingLatestEarlier(
      visibleDescriptors.length,
      hiddenCount,
    );

    return Card(
      key: const Key('session-detail-artifact-surface'),
      color: theme.colorScheme.surface,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.folder_open_outlined),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    l10n.sessionArtifactsCount(descriptors.length),
                    style: theme.textTheme.titleSmall,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (hiddenCount > 0) ...[
              SelectableText(
                hiddenLabel,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 8),
            ],
            for (var index = 0; index < visibleDescriptors.length; index++) ...[
              if (index > 0) const Divider(height: 1),
              _ArtifactSurfaceMessage(
                descriptor: visibleDescriptors[index],
                transfers: transfers,
                actionState: _stateForDescriptor(
                  visibleDescriptors[index],
                  actionStates,
                ),
                hasActiveBrokerClient: hasActiveBrokerClient,
                onDownloadArtifact: onDownloadArtifact,
                onPreviewArtifact: onPreviewArtifact,
                sourceId:
                    '$index-${visibleDescriptors[index].name ?? 'artifact'}',
                key: ValueKey('session-detail-artifact-summary-item-$index'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ArtifactSurfaceMessage extends ConsumerWidget {
  const _ArtifactSurfaceMessage({
    required this.descriptor,
    required this.transfers,
    required this.actionState,
    required this.hasActiveBrokerClient,
    required this.onDownloadArtifact,
    required this.onPreviewArtifact,
    required this.sourceId,
    required super.key,
  });

  final SessionArtifactDescriptor descriptor;
  final List<SessionArtifactTransfer> transfers;
  final SessionArtifactActionState actionState;
  final bool hasActiveBrokerClient;
  final Future<void> Function(SessionArtifactDescriptor descriptor)
  onDownloadArtifact;
  final Future<void> Function(SessionArtifactDescriptor descriptor)
  onPreviewArtifact;
  final String sourceId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final name =
        descriptor.name ?? descriptor.path ?? l10n.sessionArtifactUntitled;
    final path = descriptor.path ?? '';
    final artifactKey = descriptor.artifactKey ?? '';
    final contentHash = descriptor.contentHash ?? '';
    final size = descriptor.size;
    final hasDownloadOrFetch = descriptor.isDownloadable;
    final hasPreview = descriptor.isHtmlPreviewCandidate;
    final isBusy = _artifactActionIsBusy(actionState.phase);
    final exportAttachmentMetadata = _artifactExportAttachmentMetadata(
      l10n,
      descriptor,
    );
    final canDownload =
        hasDownloadOrFetch &&
        !isBusy &&
        (descriptor.isInlineDataUrl || hasActiveBrokerClient);
    final canPreview =
        hasPreview &&
        isSessionArtifactPreviewAvailable &&
        hasDownloadOrFetch &&
        !isBusy &&
        (descriptor.isInlineDataUrl || hasActiveBrokerClient);
    final actionHint = _artifactActionLabel(l10n, actionState.phase);
    final shouldShowActionHint =
        actionState.phase != SessionArtifactActionPhase.idle &&
        actionHint.isNotEmpty;

    final matchingTransfer = _sessionDetailTransferForArtifactSummary(
      descriptor,
      transfers,
    );
    // Governed by docs/architecture/client-ui.md:
    // artifact rows reuse the transfer-row local action policy.
    final localPath = matchingTransfer == null
        ? null
        : _sessionDetailTransferLocalPath(matchingTransfer);
    final localTransferFileOpener = ref.read(localTransferFileOpenerProvider);
    final localTransfer = matchingTransfer;
    final localPathLabel = localTransfer == null
        ? null
        : _sessionDetailTransferLocalPathLabel(
            l10n,
            localTransfer,
            localPath,
          );

    return Padding(
      key: ValueKey('session-detail-artifact-summary-item-$sourceId'),
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (name.isNotEmpty)
            SelectionArea(
              child: Text(
                name,
                style: theme.textTheme.bodyMedium,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          if (path.isNotEmpty)
            SelectableText(
              path,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          if (artifactKey.isNotEmpty)
            SelectableText(
              '${l10n.artifactKeyLabel}: $artifactKey',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          if (contentHash.isNotEmpty)
            SelectableText(
              '${l10n.hashLabel}: $contentHash',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          if (exportAttachmentMetadata.isNotEmpty) ...[
            const SizedBox(height: 8),
            SelectionArea(
              child: Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  for (
                    var metadataIndex = 0;
                    metadataIndex < exportAttachmentMetadata.length;
                    metadataIndex++
                  )
                    _ArtifactMetadataChip(
                      key: ValueKey(
                        'session-detail-artifact-metadata-$sourceId-'
                        '${_artifactMetadataKey(
                          exportAttachmentMetadata[metadataIndex],
                        )}',
                      ),
                      label: exportAttachmentMetadata[metadataIndex],
                    ),
                ],
              ),
            ),
          ],
          if (size != null)
            SelectableText(
              '${l10n.sizeLabel}: ${l10n.bytesCount(size)}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          const SizedBox(height: 10),
          if (localPathLabel != null && localTransfer != null) ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: SelectionArea(
                    child: Text(
                      localPathLabel,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                IconButton(
                  key: ValueKey(
                    'session-detail-artifact-local-copy-$sourceId',
                  ),
                  tooltip: l10n.copyLocalPath,
                  icon: const Icon(Icons.content_copy, size: 18),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 48,
                    minHeight: 48,
                  ),
                  onPressed: () => _copyTransferLocalPath(context, localPath),
                ),
                IconButton(
                  key: ValueKey(
                    'session-detail-artifact-local-open-$sourceId',
                  ),
                  tooltip: l10n.openFile,
                  icon: const Icon(Icons.open_in_new, size: 18),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 48,
                    minHeight: 48,
                  ),
                  onPressed: () => _openTransferLocalPath(
                    context,
                    localTransferFileOpener,
                    localPath!,
                  ),
                ),
                IconButton(
                  key: ValueKey(
                    'session-detail-artifact-local-reveal-$sourceId',
                  ),
                  tooltip: l10n.revealInFolder,
                  icon: const Icon(Icons.folder_open_outlined, size: 18),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 48,
                    minHeight: 48,
                  ),
                  onPressed: () => _revealTransferLocalPath(
                    context,
                    localTransferFileOpener,
                    localPath!,
                  ),
                ),
                IconButton(
                  key: ValueKey(
                    'session-detail-artifact-local-preview-$sourceId',
                  ),
                  tooltip: l10n.previewText,
                  icon: const Icon(Icons.text_snippet_outlined, size: 18),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 48,
                    minHeight: 48,
                  ),
                  onPressed: () => _previewTransferLocalText(
                    context,
                    localTransferFileOpener,
                    localPath!,
                    localTransfer,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
          ],
          if (hasDownloadOrFetch || hasPreview)
            Wrap(
              spacing: 8,
              children: [
                if (hasDownloadOrFetch)
                  OutlinedButton(
                    key: ValueKey(
                      'session-detail-artifact-action-download-$sourceId',
                    ),
                    onPressed: canDownload
                        ? () => onDownloadArtifact(descriptor)
                        : null,
                    child: Text(
                      descriptor.isInlineDataUrl
                          ? l10n.fetchDataUrl
                          : l10n.download,
                    ),
                  ),
                if (hasPreview)
                  OutlinedButton(
                    key: ValueKey(
                      'session-detail-artifact-action-preview-$sourceId',
                    ),
                    onPressed: canPreview
                        ? () => onPreviewArtifact(descriptor)
                        : null,
                    child: Text(l10n.preview),
                  ),
              ],
            )
          else
            SelectableText(
              l10n.sessionArtifactNoActions,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          if (shouldShowActionHint) ...[
            const SizedBox(height: 8),
            SelectableText(
              actionHint,
              style: theme.textTheme.bodySmall?.copyWith(
                color: actionState.phase == SessionArtifactActionPhase.error
                    ? theme.colorScheme.error
                    : theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
          if (actionState.phase == SessionArtifactActionPhase.error &&
              actionState.message.trim().isNotEmpty)
            Material(
              type: MaterialType.transparency,
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: Text(l10n.technicalDetails),
                children: [SelectableText(actionState.message)],
              ),
            ),
        ],
      ),
    );
  }
}

bool _artifactActionIsBusy(SessionArtifactActionPhase phase) {
  return phase == SessionArtifactActionPhase.loading ||
      phase == SessionArtifactActionPhase.previewing;
}

String _artifactActionLabel(
  AppLocalizations l10n,
  SessionArtifactActionPhase phase,
) => switch (phase) {
  SessionArtifactActionPhase.idle => '',
  SessionArtifactActionPhase.loading => l10n.sessionArtifactDownloading,
  SessionArtifactActionPhase.previewing => l10n.sessionArtifactOpeningPreview,
  SessionArtifactActionPhase.saved => l10n.sessionArtifactSaved,
  SessionArtifactActionPhase.previewed => l10n.sessionArtifactPreviewOpened,
  SessionArtifactActionPhase.error => l10n.sessionArtifactActionFailed,
};

// Governed by docs/architecture/client-ui.md:
// export-attachment artifacts surface concise metadata for safe
// transcript-export visibility while remaining download-only.
List<String> _artifactExportAttachmentMetadata(
  AppLocalizations l10n,
  SessionArtifactDescriptor descriptor,
) {
  if (descriptor.deliveryClass !=
      SessionArtifactDeliveryClass.exportAttachment) {
    return const [];
  }

  final metadata = <String>[l10n.sessionArtifactDownloadOnly];

  final format = descriptor.format?.trim();
  if (format != null && format.isNotEmpty) {
    metadata.add('${l10n.format}: $format');
  }

  final redactionSummary = descriptor.redactionSummary?.trim();
  if (redactionSummary != null && redactionSummary.isNotEmpty) {
    metadata.add('${l10n.redaction}: $redactionSummary');
  }

  final expiresAt = descriptor.expiresAt;
  if (expiresAt != null) {
    metadata.add('${l10n.expires}: ${_formatArtifactExpiration(expiresAt)}');
  }

  return metadata;
}

String _formatArtifactExpiration(int expiresAt) {
  try {
    return DateTime.fromMillisecondsSinceEpoch(
      expiresAt,
      isUtc: true,
    ).toUtc().toIso8601String();
  } on Object catch (_) {
    return expiresAt.toString();
  }
}

String _artifactMetadataKey(String label) {
  final sanitized = label
      .trim()
      .toLowerCase()
      .replaceAll(RegExp('[^a-z0-9]+'), '-')
      .replaceAll(RegExp(r'^-+|-+$'), '');
  return sanitized.isEmpty ? 'metadata' : sanitized;
}

SessionArtifactActionState _stateForDescriptor(
  SessionArtifactDescriptor descriptor,
  Map<String, SessionArtifactActionState> states,
) {
  return states[descriptor.actionStateKey] ??
      const SessionArtifactActionState(phase: SessionArtifactActionPhase.idle);
}
