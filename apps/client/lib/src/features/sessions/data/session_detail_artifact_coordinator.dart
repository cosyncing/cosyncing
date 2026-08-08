// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of 'session_detail_controller.dart';

extension _SessionDetailArtifactActions on SessionDetailController {
  void _reportAttachmentIntakeFailureCoordinated() {
    state = state.copyWith(error: sessionAttachmentIntakeErrorKey);
  }

  Future<bool> _pickAttachmentsCoordinated() async {
    if (state.agentActions?.canAttachFiles != true) {
      state = state.copyWith(
        error: sessionAttachmentUnsupportedErrorKey,
      );
      return false;
    }
    final List<SessionAttachment> selected;
    try {
      selected = await ref
          .read(sessionAttachmentPickerProvider)
          .pickAttachments();
    } on Object {
      state = state.copyWith(
        error: sessionAttachmentSelectionErrorKey,
      );
      return false;
    }
    if (selected.isEmpty) return false;
    return _admitAttachmentsCoordinated(selected);
  }

  Future<bool> _admitAttachmentsCoordinated(
    List<SessionAttachment> selected,
  ) async {
    if (state.agentActions?.canAttachFiles != true) {
      state = state.copyWith(error: sessionAttachmentUnsupportedErrorKey);
      return false;
    }
    if (selected.isEmpty) return false;
    final existing = state.stagedAttachments;
    final count = existing.length + selected.length;
    final bytes =
        existing.fold<int>(
          0,
          (sum, item) => sum + item.attachment.byteLength,
        ) +
        selected.fold<int>(0, (sum, item) => sum + item.byteLength);
    if (selected.any(
          (attachment) => attachment.byteLength > promptAttachmentMaxFileBytes,
        ) ||
        count > promptAttachmentMaxFiles ||
        bytes > promptAttachmentMaxPromptBytes) {
      state = state.copyWith(
        error: sessionAttachmentLimitErrorKey,
      );
      return false;
    }
    final added = selected
        .map(
          (attachment) => SessionStagedAttachment(
            localId: 'attachment-${++_attachmentCounter}',
            attachment: attachment,
          ),
        )
        .toList(growable: false);
    state = state.copyWith(
      stagedAttachments: [...existing, ...added],
      clearError: true,
    );
    return true;
  }

  Future<bool> _replaceAttachmentCoordinated(String localId) async {
    final index = state.stagedAttachments.indexWhere(
      (item) => item.localId == localId,
    );
    if (index < 0) return false;
    final List<SessionAttachment> selected;
    try {
      selected = await ref
          .read(sessionAttachmentPickerProvider)
          .pickAttachments(allowMultiple: false);
    } on Object {
      state = state.copyWith(
        error: sessionAttachmentReplacementErrorKey,
      );
      return false;
    }
    if (selected.isEmpty) return false;
    final replacement = selected.single;
    final retainedBytes =
        state.stagedAttachments.fold<int>(
          0,
          (sum, item) => sum + item.attachment.byteLength,
        ) -
        state.stagedAttachments[index].attachment.byteLength;
    if (retainedBytes + replacement.byteLength >
        promptAttachmentMaxPromptBytes) {
      state = state.copyWith(
        error: sessionAttachmentLimitErrorKey,
      );
      return false;
    }
    await _discardStagedUpload(state.stagedAttachments[index]);
    final next = [...state.stagedAttachments];
    next[index] = SessionStagedAttachment(
      localId: localId,
      attachment: replacement,
    );
    state = state.copyWith(stagedAttachments: next, clearError: true);
    return true;
  }

  Future<void> _removeAttachmentCoordinated(String localId) async {
    final attachment = state.stagedAttachments
        .where((item) => item.localId == localId)
        .firstOrNull;
    if (attachment == null) return;
    state = state.copyWith(
      stagedAttachments: state.stagedAttachments
          .where((item) => item.localId != localId)
          .toList(growable: false),
      clearError: true,
    );
    await _discardStagedUpload(attachment);
  }

  Future<void> _discardStagedUpload(SessionStagedAttachment attachment) async {
    final uploadId = attachment.uploadId;
    if (uploadId == null || uploadId.isEmpty) return;
    final client = ref.read(brokerClientProvider).valueOrNull;
    if (client == null) return;
    try {
      await client.discardUpload(arg.tool, arg.sessionId, uploadId);
    } on Object {
      // The broker TTL remains the bounded fallback cleanup.
    }
  }

  Future<List<SessionStagedAttachment>> _stageAttachmentsForPrompt() async {
    var attachments = state.stagedAttachments;
    for (final current in [...attachments]) {
      if (current.isInline) continue;
      final now = DateTime.now().millisecondsSinceEpoch;
      if (current.stagedRef != null &&
          (current.expiresAt == null || current.expiresAt! > now)) {
        continue;
      }
      final uploading = current.copyWith(
        phase: SessionAttachmentUploadPhase.uploading,
        clearMessage: true,
        clearUpload: current.expiresAt != null && current.expiresAt! <= now,
      );
      attachments = attachments
          .map((item) => item.localId == current.localId ? uploading : item)
          .toList(growable: false);
      state = state.copyWith(stagedAttachments: attachments);
      final result = await ref
          .read(sessionArtifactTransferWorkerProvider)
          .uploadSessionAttachment(
            sessionKey: arg,
            attachment: current.attachment,
          );
      final completed = result.stagedUpload;
      if (!result.succeeded || completed == null) {
        final failed = uploading.copyWith(
          phase: SessionAttachmentUploadPhase.error,
          message: result.message,
        );
        attachments = attachments
            .map((item) => item.localId == current.localId ? failed : item)
            .toList(growable: false);
        state = state.copyWith(
          stagedAttachments: attachments,
          error: sessionAttachmentStagingErrorKey,
        );
        throw StateError(result.message);
      }
      final staged = uploading.copyWith(
        phase: SessionAttachmentUploadPhase.sent,
        uploadId: completed.uploadId,
        stagedRef: completed.stagedRef,
        expiresAt: completed.expiresAt,
        clearMessage: true,
      );
      attachments = attachments
          .map((item) => item.localId == current.localId ? staged : item)
          .toList(growable: false);
      state = state.copyWith(stagedAttachments: attachments, clearError: true);
    }
    return attachments;
  }

  /// Caches and exports an artifact descriptor file.
  Future<bool> _downloadArtifactCoordinated(
    SessionArtifactDescriptor descriptor,
  ) async {
    final actionKey = descriptor.actionStateKey;
    _setArtifactActionState(
      actionKey,
      const SessionArtifactActionState(
        phase: SessionArtifactActionPhase.loading,
      ),
    );

    final result = await ref
        .read(sessionArtifactTransferWorkerProvider)
        .downloadArtifact(
          sessionKey: arg,
          descriptor: descriptor,
          hasActiveBrokerClient: _hasActiveBrokerClient(),
        );

    switch (result.outcome) {
      case SessionArtifactTransferWorkerOutcome.completed:
        final cached = result.cachedFile;
        _setArtifactActionState(
          actionKey,
          SessionArtifactActionState(
            phase: SessionArtifactActionPhase.saved,
            message: cached == null
                ? result.message
                : 'Saved ${cached.fileName} (${cached.byteLength} bytes)',
          ),
        );
        state = state.copyWith(clearError: true);
        return true;
      case SessionArtifactTransferWorkerOutcome.canceled:
        _setArtifactActionState(
          actionKey,
          const SessionArtifactActionState(
            phase: SessionArtifactActionPhase.idle,
          ),
        );
        return false;
      case SessionArtifactTransferWorkerOutcome.cached:
        return false;
      case SessionArtifactTransferWorkerOutcome.enqueuedInBackground:
        // Artifact downloads never route to the background engine; keep the
        // switch exhaustive and treat a background enqueue as started.
        state = state.copyWith(clearError: true);
        return true;
      case SessionArtifactTransferWorkerOutcome.failed:
        _setArtifactActionState(
          actionKey,
          SessionArtifactActionState(
            phase: SessionArtifactActionPhase.error,
            message: result.message,
          ),
        );
        state = state.copyWith(error: result.message);
        return false;
    }
  }

  /// Caches an HTML artifact and returns the local file for WebView preview.
  ///
  /// Presentation is handled by the view layer because embedded WebViews need
  /// widget context, but broker/cache access remains controller-owned.
  Future<SessionArtifactCachedFile?> _prepareArtifactPreviewCoordinated(
    SessionArtifactDescriptor descriptor,
  ) async {
    final actionKey = descriptor.actionStateKey;
    _setArtifactActionState(
      actionKey,
      const SessionArtifactActionState(
        phase: SessionArtifactActionPhase.previewing,
      ),
    );

    final result = await ref
        .read(sessionArtifactTransferWorkerProvider)
        .preparePreview(
          sessionKey: arg,
          descriptor: descriptor,
          hasActiveBrokerClient: _hasActiveBrokerClient(),
        );

    if (result.outcome == SessionArtifactTransferWorkerOutcome.cached) {
      state = state.copyWith(clearError: true);
      return result.cachedFile;
    }

    _setArtifactActionState(
      actionKey,
      SessionArtifactActionState(
        phase: SessionArtifactActionPhase.error,
        message: result.message,
      ),
    );
    state = state.copyWith(error: result.message);
    return null;
  }

  bool _hasActiveBrokerClient() {
    return ref
        .read(brokerClientProvider)
        .maybeWhen(data: (client) => client != null, orElse: () => false);
  }

  /// Records the result of a platform preview presentation attempt.
  void _recordArtifactPreviewResultCoordinated(
    SessionArtifactDescriptor descriptor, {
    required bool opened,
    required String message,
  }) {
    final transfers = ref.read(
      sessionArtifactTransferControllerProvider.notifier,
    );
    final transfer = transfers
        .transfersFor(arg)
        .where(
          (candidate) =>
              candidate.actionKey == descriptor.actionStateKey &&
              candidate.direction == SessionArtifactTransferDirection.preview,
        )
        .firstOrNull;
    if (transfer != null) {
      if (opened) {
        final cached = SessionArtifactCachedFile(
          cachedFilePath: transfer.cachedFilePath ?? '',
          fileName: transfer.fileName,
          contentType: transfer.contentType,
          byteLength: transfer.byteLength ?? 0,
          artifactKey: transfer.artifactKey,
          contentHash: transfer.contentHash,
        );
        transfers.markPreviewed(transfer.id, cached, message: message);
      } else {
        transfers.markFailed(transfer.id, message);
      }
    }

    _setArtifactActionState(
      descriptor.actionStateKey,
      SessionArtifactActionState(
        phase: opened
            ? SessionArtifactActionPhase.previewed
            : SessionArtifactActionPhase.error,
        message: message,
      ),
    );
    state = opened
        ? state.copyWith(clearError: true)
        : state.copyWith(error: message);
  }

  void _setArtifactActionState(
    String key,
    SessionArtifactActionState artifactActionState,
  ) {
    final next = Map<String, SessionArtifactActionState>.from(
      state.artifactActionStates,
    );
    next[key] = artifactActionState;
    state = state.copyWith(artifactActionStates: next);
  }

  /// Requests the broker's transcript-export confirmation payload.
  Future<TranscriptExportPreflightResponse?>
  _prepareTranscriptExportCoordinated() async {
    final client = await ref.read(brokerClientProvider.future);
    if (client == null) {
      const message = 'Connect to a broker before exporting transcripts.';
      state = state.copyWith(
        error: message,
        transcriptExportActionState: const TranscriptExportActionState(
          phase: TranscriptExportActionPhase.error,
          message: message,
        ),
      );
      return null;
    }

    if (state.agentActions?.canTranscriptExport != true) {
      const message = 'Transcript export is not available for this agent.';
      state = state.copyWith(
        error: message,
        transcriptExportActionState: const TranscriptExportActionState(
          phase: TranscriptExportActionPhase.error,
          message: message,
        ),
      );
      return null;
    }

    state = state.copyWith(
      transcriptExportActionState: const TranscriptExportActionState(
        phase: TranscriptExportActionPhase.preflighting,
        message: 'Preparing transcript export...',
      ),
      clearError: true,
    );

    try {
      final preflight = await client.prepareTranscriptExport(
        arg.tool,
        arg.sessionId,
      );
      state = state.copyWith(
        transcriptExportActionState: TranscriptExportActionState(
          phase: TranscriptExportActionPhase.awaitingConfirmation,
          preflight: preflight,
          message: preflight.confirm.message,
        ),
        clearError: true,
      );
      return preflight;
    } on Object catch (e) {
      final failure = _transcriptExportFailure(e);
      state = state.copyWith(
        error: failure.message,
        transcriptExportActionState: TranscriptExportActionState(
          phase: TranscriptExportActionPhase.error,
          message: failure.message,
          errorCode: failure.code,
        ),
      );
      return null;
    }
  }

  /// Executes transcript export using a broker confirmation nonce.
  Future<bool> _exportTranscriptCoordinated({required String nonce}) async {
    final client = await ref.read(brokerClientProvider.future);
    if (client == null) {
      const message = 'Connect to a broker before exporting transcripts.';
      state = state.copyWith(
        error: message,
        transcriptExportActionState: const TranscriptExportActionState(
          phase: TranscriptExportActionPhase.error,
          message: message,
        ),
      );
      return false;
    }

    final trimmedNonce = nonce.trim();
    if (trimmedNonce.isEmpty) {
      const message = 'Transcript export confirmation is missing.';
      state = state.copyWith(
        error: message,
        transcriptExportActionState: const TranscriptExportActionState(
          phase: TranscriptExportActionPhase.error,
          message: message,
        ),
      );
      return false;
    }

    state = state.copyWith(
      transcriptExportActionState: const TranscriptExportActionState(
        phase: TranscriptExportActionPhase.exporting,
        message: 'Exporting transcript...',
      ),
      clearError: true,
    );

    try {
      final response = await client.exportTranscript(
        arg.tool,
        arg.sessionId,
        nonce: trimmedNonce,
      );
      final artifact = response.artifact;
      if (artifact == null) {
        const message = 'Transcript export completed without an artifact.';
        state = state.copyWith(
          error: message,
          transcriptExportActionState: const TranscriptExportActionState(
            phase: TranscriptExportActionPhase.error,
            message: message,
          ),
        );
        return false;
      }

      _appendTranscriptExportArtifact(artifact);
      state = state.copyWith(
        transcriptExportActionState: const TranscriptExportActionState(
          phase: TranscriptExportActionPhase.exported,
          message: 'Transcript export ready in Files.',
        ),
        clearError: true,
      );
      return true;
    } on Object catch (e) {
      final failure = _transcriptExportFailure(e);
      state = state.copyWith(
        error: failure.message,
        transcriptExportActionState: TranscriptExportActionState(
          phase: TranscriptExportActionPhase.error,
          message: failure.message,
          errorCode: failure.code,
        ),
      );
      return false;
    }
  }

  /// Renames or clears the current session title through the native broker API.
  ///
  /// The visible title is updated only after the broker accepts the request.
}
