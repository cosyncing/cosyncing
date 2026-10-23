import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components/contextual_details.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_transfer.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_transfer_worker.dart';
import 'package:cosyncing_client/src/features/storage/data/managed_file_access.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

/// Native share boundary. File-backed XFiles keep large files out of memory.
typedef CachedFileShare = Future<void> Function(SessionArtifactCachedFile file);

/// Injectable Android share sheet.
final cachedFileShareProvider = Provider<CachedFileShare>(
  (ref) => (file) async {
    await SharePlus.instance.share(
      ShareParams(
        files: [
          XFile(
            file.cachedFilePath,
            mimeType: file.contentType,
            name: file.fileName,
          ),
        ],
        fileNameOverrides: [file.fileName],
      ),
    );
  },
);

/// Shared Save/Share controls for every Android surface with a cached copy.
class CachedTransferActions extends ConsumerStatefulWidget {
  /// Creates controls with the enclosing surface's stable key scheme.
  CachedTransferActions({
    required this.transfer,
    required this.keyPrefix,
    String? actionId,
    super.key,
  }) : actionId = actionId ?? transfer.id;

  /// Cached ledger row, including canceled and failed exports.
  final SessionArtifactTransfer transfer;

  /// Surface prefix, e.g. session-detail-transfer.
  final String keyPrefix;

  /// Row id, or source id for an artifact card.
  final String actionId;

  @override
  ConsumerState<CachedTransferActions> createState() =>
      _CachedTransferActionsState();
}

class _CachedTransferActionsState extends ConsumerState<CachedTransferActions> {
  bool _busy = false;

  Future<void> _act({required bool share}) async {
    setState(() => _busy = true);
    final worker = ref.read(sessionArtifactTransferWorkerProvider);
    final l10n = AppLocalizations.of(context);
    final shareFile = ref.read(cachedFileShareProvider);
    try {
      if (share) {
        final release = ManagedFileAccess.shared.acquire(
          widget.transfer.cachedFilePath!,
        );
        try {
          await shareFile(worker.cachedFileForTransfer(widget.transfer.id));
        } finally {
          release();
        }
      } else {
        final result = await worker.saveCachedTransfer(widget.transfer.id);
        if (mounted &&
            result.outcome == SessionArtifactTransferWorkerOutcome.failed) {
          _showError(result.message, result.detail);
        }
      }
    } on Object catch (error) {
      if (mounted) {
        final message =
            error is StateError &&
                error.message == worker.cachedCopyRemovedMessage
            ? l10n.transferCachedCopyRemoved
            : l10n.transferShareFailed;
        _showError(message, describeFailure(error, lead: message).detail);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showError(String message, String? detail) {
    final l10n = AppLocalizations.of(context);
    if (ModalRoute.of(context)?.opaque == false) {
      // Dialog actions need a surface above their own barrier, rather than a
      // snackbar on the page underneath it. Raw details remain opt-in.
      unawaited(
        showDialog<void>(
          context: context,
          builder: (errorContext) => AlertDialog(
            title: Text(widget.transfer.fileName),
            content: Text(message),
            actions: [
              if (detail != null)
                TextButton(
                  onPressed: () => showContextualDetails(
                    errorContext,
                    label: widget.transfer.fileName,
                    detail: detail,
                  ),
                  child: Text(l10n.technicalDetails),
                ),
              TextButton(
                onPressed: () => Navigator.of(errorContext).pop(),
                child: Text(l10n.close),
              ),
            ],
          ),
        ),
      );
      return;
    }
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          action: detail == null
              ? null
              : SnackBarAction(
                  label: l10n.technicalDetails,
                  onPressed: () => showContextualDetails(
                    context,
                    label: widget.transfer.fileName,
                    detail: detail,
                  ),
                ),
        ),
      );
  }

  @override
  Widget build(BuildContext context) {
    if (kIsWeb ||
        defaultTargetPlatform != TargetPlatform.android ||
        !widget.transfer.hasSettledCachedCopy) {
      return const SizedBox.shrink();
    }
    final l10n = AppLocalizations.of(context);
    return Wrap(
      spacing: 8,
      runSpacing: 4,
      children: [
        TextButton.icon(
          key: ValueKey('${widget.keyPrefix}-save-${widget.actionId}'),
          onPressed: _busy ? null : () => _act(share: false),
          icon: const Icon(Icons.save_alt, size: 18),
          label: Text(l10n.save),
        ),
        TextButton.icon(
          key: ValueKey('${widget.keyPrefix}-share-${widget.actionId}'),
          onPressed: _busy ? null : () => _act(share: true),
          icon: const Icon(Icons.share_outlined, size: 18),
          label: Text(l10n.share),
        ),
      ],
    );
  }
}

/// Keeps cached-file controls usable on a phone without compressing the name.
class TransferLocalFileActions extends StatelessWidget {
  /// Creates the local path label and existing filesystem actions.
  const TransferLocalFileActions({
    required this.label,
    required this.actions,
    super.key,
  });

  /// Localized path or saved-to-device label.
  final String label;

  /// Existing Copy/Open/Reveal/Preview buttons.
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final text = SelectionArea(
      child: Text(
        label,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    );
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          text,
          Wrap(spacing: 4, runSpacing: 4, children: actions),
        ],
      );
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(child: text),
        const SizedBox(width: 8),
        ...actions,
      ],
    );
  }
}

/// Shared labels used by session rows, the transfer manager and its search.
extension TransferPresentation on SessionArtifactTransfer {
  /// Localized status also used by transfer-list search.
  String localizedStatus(AppLocalizations l10n) => switch (status) {
    SessionArtifactTransferStatus.queued => l10n.transferStatusQueued,
    SessionArtifactTransferStatus.running => l10n.transferStatusRunning,
    SessionArtifactTransferStatus.cached =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android
          ? l10n.transferStatusDownloaded
          : l10n.transferStatusCached,
    SessionArtifactTransferStatus.completed =>
      !kIsWeb &&
              defaultTargetPlatform == TargetPlatform.android &&
              exportedToContentUri
          ? l10n.transferStatusSaved
          : l10n.transferStatusComplete,
    SessionArtifactTransferStatus.canceled => l10n.transferStatusCanceled,
    SessionArtifactTransferStatus.failed => l10n.transferStatusFailed,
  };

  /// Distinct friendly and technical lines for explicit error disclosure.
  String technicalDetail(String? detail) => <String?>[message, detail ?? error]
      .whereType<String>()
      .where((value) => value.trim().isNotEmpty)
      .toSet()
      .join('\n');

  /// Destination label while filesystem actions keep using the cached copy.
  String? localizedLocalPath(AppLocalizations l10n) {
    final path = localFilePath;
    if (path == null) return null;
    if (exportedPath?.trim().isNotEmpty ?? false) {
      return exportedToContentUri
          ? l10n.transferSavedToDevice(savedFileName)
          : l10n.transferSavedPath(path);
    }
    return l10n.transferCachedPath(path);
  }
}
