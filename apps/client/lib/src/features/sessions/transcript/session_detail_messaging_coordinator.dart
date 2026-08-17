// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of '../detail/session_detail_controller.dart';

extension _SessionDetailMessaging on SessionDetailController {
  /// Sends the advertised stop/abort action directly over the live transport.
  ///
  /// Interrupt is deliberately excluded from the durable outbox. Replaying a
  /// stale stop after reconnect could cancel a later, unrelated turn.
  Future<SessionInterruptOutcome> _interruptCurrentTurnCoordinated() async {
    if (state.interruptPhase != SessionInterruptPhase.idle) {
      return SessionInterruptOutcome.alreadyRequested;
    }

    final command = state.interruptCommand;
    if (command == null) {
      return SessionInterruptOutcome.unsupported;
    }
    if (state.sessionInfo?.status != SessionStatus.working) {
      return SessionInterruptOutcome.notWorking;
    }

    final connection = _connection;
    final mutable =
        connection != null &&
        state.connectionStatus == SessionDetailConnectionStatus.connected &&
        !state.compatibilityReadOnly &&
        SessionControlView.fromSessionDetailState(state).canPrompt;
    if (!mutable) {
      return SessionInterruptOutcome.unavailable;
    }

    // Set this before the first await so repeated taps share one turn-level
    // guard even when the transport write is still pending.
    state = state.copyWith(interruptPhase: SessionInterruptPhase.sending);
    final clientMessageId = _nextClientMessageId();
    final turnGeneration = _interruptTurnGeneration;
    _interruptClientMessageId = clientMessageId;
    try {
      await connection.sendCommand(
        command.name,
        clientMessageId: clientMessageId,
      );
      // The agent may have finished while the write was in flight. Do not
      // leave a stale requested phase attached to the next turn, or overwrite
      // a second interrupt that started after the first turn finished.
      final sameWorkingTurn =
          _interruptClientMessageId == clientMessageId &&
          _interruptTurnGeneration == turnGeneration &&
          state.sessionInfo?.status == SessionStatus.working;
      if (_interruptClientMessageId == clientMessageId) {
        state = state.copyWith(
          interruptPhase: sameWorkingTurn
              ? SessionInterruptPhase.requested
              : SessionInterruptPhase.idle,
          clearError: true,
        );
      }
      return sameWorkingTurn
          ? SessionInterruptOutcome.sent
          : SessionInterruptOutcome.notWorking;
    } on Object {
      if (_interruptClientMessageId == clientMessageId) {
        _interruptClientMessageId = null;
        state = state.copyWith(interruptPhase: SessionInterruptPhase.idle);
      }
      return SessionInterruptOutcome.failed;
    }
  }

  Future<bool> _sendPromptCoordinated(
    String text, {
    SessionCurrentModel? model,
    String? permissionMode,
  }) async {
    final trimmedPrompt = text.trim();
    // Normalized ONCE, here, so the durable row and the wire frame carry a
    // byte-identical value. The broker fingerprints every field of a mutating
    // frame except the client message id, so a replay that re-derived this —
    // or dropped it — would hash differently and come back as a conflicting
    // reuse of the id rather than the original acknowledgement.
    final trimmedMode = permissionMode?.trim();
    final promptPermissionMode = trimmedMode == null || trimmedMode.isEmpty
        ? null
        : trimmedMode;
    final attachmentSnapshot = state.stagedAttachments;
    if (trimmedPrompt.isEmpty && attachmentSnapshot.isEmpty) {
      return false;
    }
    if (attachmentSnapshot.isNotEmpty &&
        state.agentActions?.canAttachFiles != true) {
      state = state.copyWith(
        error: sessionAttachmentUnsupportedErrorKey,
      );
      return false;
    }

    final connection = _connection;
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      state = state.copyWith(
        error: 'Cannot send prompt until the session is connected.',
      );
      return false;
    }

    final List<SessionStagedAttachment> stagedAttachments;
    try {
      stagedAttachments = attachmentSnapshot.isEmpty
          ? const <SessionStagedAttachment>[]
          : await _stageAttachmentsForPrompt();
    } on Object {
      return false;
    }
    final promptFiles = stagedAttachments
        .map((attachment) => attachment.toPromptFile())
        .toList(growable: false);
    final inlineDecodedBytes = stagedAttachments
        .where((attachment) => attachment.isInline)
        .fold<int>(0, (sum, item) => sum + item.attachment.byteLength);
    final inlineEncodedBytes = stagedAttachments
        .where((attachment) => attachment.isInline)
        .fold<int>(0, (sum, item) => sum + item.attachment.data!.length);
    if (promptFiles.length > promptAttachmentMaxFiles ||
        inlineDecodedBytes > promptAttachmentInlineDecodedMaxBytes ||
        inlineEncodedBytes > promptAttachmentInlineEncodedMaxBytes) {
      state = state.copyWith(error: sessionAttachmentLimitErrorKey);
      return false;
    }

    // DR1 handoff: the draft stays durable until the exact prompt is durable
    // in the outbox. Flush any pending coalesced edit first so the durable
    // draft always covers the value being sent.
    await flushLocalDraft(trimmedPrompt);

    // DR1: open the handoff. This captures, as one synchronous snapshot, both
    // the identity of the draft being sent and the ownership pair the prompt
    // reports — clear only the shared draft this device was looking at, never
    // newer text another device typed, and still clear its OWN draft when the
    // flush above is awaiting its echo, which the update token proves.
    //
    // The pair is captured ONCE and used for the durable payload and the wire
    // frame alike. The broker fingerprints every field of a mutating frame
    // except the client message id, so a replay that omitted these — or
    // recomputed them from state that has since moved — would hash differently
    // and come back as CLIENT_MESSAGE_ID_CONFLICT instead of the cached
    // acknowledgement, turning an already-executed prompt into a terminal
    // failure. That is exactly the crash path the pending clear must survive.
    final handoff = _beginDraftHandoff();
    final draftRevision = handoff.revision;
    final draftUpdateId = handoff.updateId;

    String? optimisticId;
    try {
      await _sendOutboxMessage(
        kind: SessionOutboxMessageKind.prompt,
        payload: {
          'text': trimmedPrompt,
          if (model != null) 'model': model.toJson(),
          // Durable, so a retry after a reconnect asks for the SAME approval
          // mode the user chose. Recomputing it at replay would read whatever
          // the composer holds by then — a mode the user has since changed, or
          // none at all — and send a request they never made.
          if (promptPermissionMode != null)
            'permissionMode': promptPermissionMode,
          if (stagedAttachments.isNotEmpty)
            'files': stagedAttachments
                .map((attachment) => attachment.toOutboxJson())
                .toList(growable: false),
          if (draftRevision != null) 'draftRevision': draftRevision,
          if (draftUpdateId != null) 'draftUpdateId': draftUpdateId,
        },
        // The durable outbox row exists, so the draft can be bound to it —
        // and must be, before the frame goes out. Binding afterwards would
        // associate whatever row the awaits left current, which a foreign
        // draft frame can replace: this prompt's own acknowledgement would
        // then delete another device's newer unsent text. A binding that
        // cannot be persisted aborts the dispatch and leaves the row retryable
        // rather than sending a prompt whose draft nothing can settle.
        beforeDispatch: (clientMessageId) async {
          final bound = await _bindSubmittedDraft(
            clientMessageId,
            // Bound only when the row actually CONTAINS the prompt being
            // sent. The flush above normally guarantees that; when it could
            // not (an oversized value the durable row refuses, a durability
            // hiccup) the row still holds OLDER text, and associating it
            // would let this prompt's delivery erase — or its failure
            // "restore" — a draft it never carried.
            expectedText: handoff.text == trimmedPrompt ? handoff.text : null,
            expectedLocalRevision: handoff.localRevision,
          );
          if (!bound) {
            throw StateError('The draft could not be bound to this prompt.');
          }
        },
        send: (clientMessageId) => connection.sendPrompt(
          trimmedPrompt,
          model: model,
          files: promptFiles,
          clientMessageId: clientMessageId,
          draftRevision: draftRevision,
          draftUpdateId: draftUpdateId,
          permissionMode: promptPermissionMode,
        ),
        onPersisted: (clientMessageId) {
          optimisticId = clientMessageId;
          if (stagedAttachments.isNotEmpty) {
            _attachmentPromptClientMessageId = clientMessageId;
            _attachmentPromptResult = Completer<bool>();
          }
          final queued =
              state.sessionInfo?.status == SessionStatus.working ||
              state.liveState.activities.isNotEmpty;
          state = state.copyWith(
            optimisticPrompts: [
              ...state.optimisticPrompts,
              SessionOptimisticPrompt(
                clientMessageId: clientMessageId,
                text: trimmedPrompt,
                sentAt: DateTime.now().millisecondsSinceEpoch,
                queued: queued,
                // Captured once at acceptance: the row keeps this logical
                // boundary while output/status/summary frames stream in after
                // it, instead of trailing the whole transcript.
                anchorMessageKey: state.transcriptAnchorKey,
              ),
            ],
          );
        },
      );
      state = state.copyWith(clearError: true);
      if (stagedAttachments.isNotEmpty) {
        return await _attachmentPromptResult!.future;
      }
      return true;
    } on Object catch (e) {
      final failedOptimisticId = optimisticId;
      if (failedOptimisticId != null) {
        _removeOptimisticPrompt(failedOptimisticId);
      }
      // A transport failure after the durable insert still owns the handoff:
      // the row was bound before dispatch, so the retryable outbox row replays
      // the prompt and its terminal receipt settles the draft.
      state = state.copyWith(
        error: stagedAttachments.isEmpty
            ? userFacingMessage(e, lead: "Couldn't send the prompt.")
            : sessionAttachmentDeliveryErrorKey,
        stagedAttachments: state.stagedAttachments
            .map(
              (attachment) => attachment.copyWith(
                phase: SessionAttachmentUploadPhase.error,
              ),
            )
            .toList(growable: false),
      );
      if (!(_attachmentPromptResult?.isCompleted ?? true)) {
        _attachmentPromptResult?.complete(false);
      }
      return false;
    } finally {
      _endDraftHandoff();
    }
  }

  /// Sends a semantic plan lifecycle action over the authenticated stream.
  ///
  /// Plan detection belongs to the broker contract. Callers must never infer
  /// it from a task title, source label, agent, or tool name.
  Future<bool> _sendPlanActionCoordinated(PlanActionRequest request) async {
    if (request.planKey.trim().isEmpty || request.planRevision.trim().isEmpty) {
      state = state.copyWith(error: 'Plan action is missing plan identity.');
      return false;
    }
    if (request.action == PlanActionKind.edit &&
        (request.text == null || request.text!.trim().isEmpty)) {
      state = state.copyWith(error: 'A plan revision cannot be empty.');
      return false;
    }
    if (!request.isValidBrokerRequest) {
      state = state.copyWith(
        error: 'Plan action does not match the current server policy.',
      );
      return false;
    }
    final connection = _connection;
    final control = SessionControlView.fromSessionDetailState(state);
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected ||
        !control.canPrompt) {
      state = state.copyWith(
        error: 'Plan actions require a prompt-capable Drive or sync session.',
      );
      return false;
    }
    try {
      await _sendOutboxMessage(
        kind: SessionOutboxMessageKind.planAction,
        payload: request.toJson(),
        send: (clientMessageId) => connection.sendPlanAction(
          request,
          clientMessageId: clientMessageId,
        ),
      );
      state = state.copyWith(clearError: true);
      return true;
    } on Object catch (error) {
      state = state.copyWith(
        error: userFacingMessage(error, lead: "Couldn't update the plan."),
      );
      return false;
    }
  }

  /// Sends a structured interaction from a broker-sandboxed HTML artifact.
  Future<bool> _sendArtifactInteractionCoordinated(
    ArtifactInteractionRequest request,
  ) async {
    if (request.artifactKey.trim().isEmpty ||
        request.interactionRef.trim().isEmpty ||
        request.interaction.isEmpty) {
      state = state.copyWith(
        error: 'Artifact interaction is missing trusted artifact context.',
      );
      return false;
    }
    final connection = _connection;
    final control = SessionControlView.fromSessionDetailState(state);
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected ||
        !control.canPrompt) {
      state = state.copyWith(
        error:
            'Artifact interactions require a prompt-capable Drive or '
            'sync session.',
      );
      return false;
    }
    try {
      await _sendOutboxMessage(
        kind: SessionOutboxMessageKind.artifactInteraction,
        payload: request.toJson(),
        send: (clientMessageId) => connection.sendArtifactInteraction(
          request,
          clientMessageId: clientMessageId,
        ),
      );
      state = state.copyWith(clearError: true);
      return true;
    } on Object catch (error) {
      state = state.copyWith(
        error: userFacingMessage(
          error,
          lead: "Couldn't send the artifact interaction.",
        ),
      );
      return false;
    }
  }

  /// Sends an explicit receipt for a broker-issued attach ticket.
  ///
  /// History attach tickets are acknowledged automatically after the durable
  /// transcript transaction commits. This method remains available for an
  /// explicit retry or test boundary.
  Future<bool> _sendAttachTicketReceiptCoordinated(
    String attachTicket, {
    required bool accepted,
  }) async {
    final ticket = attachTicket.trim();
    final connection = _connection;
    if (ticket.isEmpty ||
        connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      return false;
    }
    try {
      if (accepted) {
        await connection.sendAck(ticket);
      } else {
        await connection.sendNack(ticket);
      }
      return true;
    } on Object catch (error) {
      state = state.copyWith(
        error: userFacingMessage(
          error,
          lead: "Couldn't acknowledge the attached history.",
        ),
      );
      return false;
    }
  }

  void _clearHistoryPageTracking() {
    _historyPageRequestId = null;
    _historyPageCursorInFlight = null;
    _historyPageTimeout?.cancel();
    _historyPageTimeout = null;
  }

  /// Bounds one in-flight `history-page` request so a broker that accepts the
  /// frame but never replies and never nacks cannot pin `historyPageLoading`
  /// true until the next reconnect. On expiry the cursor and `hasEarlier` are
  /// left untouched (both derive from the projection), so retry stays possible.
  void _startHistoryPageTimeout(String clientMessageId) {
    _historyPageTimeout?.cancel();
    final timeout = ref.read(sessionHistoryPageTimeoutProvider);
    _historyPageTimeout = Timer(timeout, () {
      _historyPageTimeout = null;
      if (_historyPageRequestId != clientMessageId) return;
      _clearHistoryPageTracking();
      state = state.copyWith(
        historyPageLoading: false,
        historyPageErrorCode: 'HISTORY_PAGE_TIMEOUT',
        historyPageError:
            'Loading earlier history timed out. Reconnect or try again.',
      );
    });
  }

  /// Loads one broker-retained page before the current transcript tail.
  Future<bool> _loadEarlierHistoryCoordinated({
    int limit = kTranscriptHistoryPageMessages,
    String? cursor,
  }) async {
    if (state.historyPageLoading) return false;
    if (isTerminalHistoryPageErrorCode(state.historyPageErrorCode)) {
      return false;
    }
    final requestedCursor = cursor ?? state.olderHistoryCursor;
    final pageConnection = _connection;
    if (requestedCursor == null || requestedCursor.trim().isEmpty) return false;
    if (_historyPageCursorInFlight == requestedCursor) return false;
    final historyConnection = switch (pageConnection) {
      final SessionHistoryConnection value => value,
      _ => null,
    };
    if (historyConnection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      state = state.copyWith(
        historyPageErrorCode: 'HISTORY_PAGE_OFFLINE',
        historyPageError: 'Reconnect before loading earlier history.',
      );
      return false;
    }
    final clientMessageId = _nextClientMessageId();
    _historyPageRequestId = clientMessageId;
    _historyPageCursorInFlight = requestedCursor;
    _startHistoryPageTimeout(clientMessageId);
    state = state.copyWith(
      historyPageLoading: true,
      clearHistoryPageError: true,
    );
    try {
      await historyConnection.requestHistoryPage(
        cursor: requestedCursor,
        limit: limit,
        clientMessageId: clientMessageId,
      );
      return true;
    } on Object catch (error) {
      if (_historyPageRequestId == clientMessageId) {
        _clearHistoryPageTracking();
        state = state.copyWith(
          historyPageLoading: false,
          historyPageErrorCode: 'HISTORY_PAGE_TRANSPORT',
          historyPageError: userFacingMessage(
            error,
            lead: "Couldn't load earlier history.",
          ),
        );
      }
      return false;
    }
  }

  /// Sends a slash command through the active session connection.
  ///
  /// The command name must be non-empty and the session must be connected.
  /// Returns `true` only when the command was accepted by the transport.
  Future<bool> _sendCommandCoordinated(
    String name, {
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? permissionMode,
  }) => _sendCommand(
    name,
    args: args,
    model: model,
    permissionMode: permissionMode,
    outboxKind: SessionOutboxMessageKind.command,
  );

  /// Sends a capability-advertised action command.
  ///
  /// The semantic command kind prevents widgets from guessing from names.
  /// The current broker still gates every `command` frame as prompt-class, so
  /// action commands require [SessionControlView.canPrompt] as well as an
  /// advertised `action` kind.
  Future<bool> _sendActionCommandCoordinated(
    String name, {
    Map<String, dynamic>? args,
  }) async {
    final trimmedName = name.trim();
    final normalizedName = trimmedName.startsWith('/')
        ? trimmedName.substring(1)
        : trimmedName;
    final advertised = state.commands.any((command) {
      final candidate = command.name.startsWith('/')
          ? command.name.substring(1)
          : command.name;
      return candidate == normalizedName &&
          command.kind == SlashCommandKind.action;
    });
    if (normalizedName.isEmpty || !advertised) {
      state = state.copyWith(
        error: 'This session does not advertise that action command.',
      );
      return false;
    }
    if (!SessionControlView.fromSessionDetailState(state).canPrompt) {
      state = state.copyWith(
        error:
            'Action commands require a prompt-capable Drive or sync session.',
      );
      return false;
    }
    return _sendCommand(
      trimmedName,
      args: args,
      outboxKind: SessionOutboxMessageKind.actionCommand,
    );
  }

  Future<bool> _sendCommand(
    String name, {
    required SessionOutboxMessageKind outboxKind,
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? permissionMode,
  }) async {
    final trimmedName = name.trim();
    if (trimmedName.isEmpty) {
      state = state.copyWith(
        error: 'Cannot send an empty command name.',
      );
      return false;
    }

    final modelArgError = validateSessionCommandModelArg(
      args,
      hasModelOverride: model != null,
    );
    if (modelArgError != null) {
      state = state.copyWith(error: modelArgError);
      return false;
    }
    final normalizedPermissionMode = permissionMode?.trim();
    if (normalizedPermissionMode != null &&
        normalizedPermissionMode.isNotEmpty &&
        (args?.containsKey('permissionMode') ?? false)) {
      state = state.copyWith(
        error:
            'Remove "permissionMode" from command arguments. Use the '
            'permission selector instead.',
      );
      return false;
    }
    final transportArgs = <String, dynamic>{
      if (args != null) ...args,
      if (normalizedPermissionMode != null &&
          normalizedPermissionMode.isNotEmpty)
        'permissionMode': normalizedPermissionMode,
    };
    final effectiveArgs = transportArgs.isEmpty ? null : transportArgs;

    final connection = _connection;
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      state = state.copyWith(
        error: 'Cannot send command until the session is connected.',
      );
      return false;
    }

    final normalizedCommand = trimmedName.startsWith('/')
        ? trimmedName.substring(1)
        : trimmedName;
    final tracksProgress = normalizedCommand == 'compact';
    if (tracksProgress) {
      _startCommandProgress(normalizedCommand);
    }
    try {
      await _sendOutboxMessage(
        kind: outboxKind,
        payload: {
          'name': trimmedName,
          if (effectiveArgs != null) 'args': effectiveArgs,
          if (model != null) 'model': model.toJson(),
        },
        send: (clientMessageId) => connection.sendCommand(
          trimmedName,
          args: effectiveArgs,
          model: model,
          clientMessageId: clientMessageId,
        ),
      );
      state = state.copyWith(clearError: true);
      return true;
    } on Object catch (e) {
      if (tracksProgress) {
        _clearCommandProgress();
      }
      state = state.copyWith(
        error: userFacingMessage(e, lead: "Couldn't send the command."),
      );
      return false;
    }
  }

  /// Picks one local file and sends it over the active session connection.
  ///
  /// Uses the current broker `file` WebSocket frame, so this is intentionally
  /// separate from the future remote file-browser API.
}
