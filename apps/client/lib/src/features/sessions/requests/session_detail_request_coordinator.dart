// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of '../detail/session_detail_controller.dart';

/// Session agent/mode control (e.g. opencode build/plan).
///
/// Public API deliberately lives here rather than on [SessionDetailController]:
/// that file sits above its boundary ceiling, and this is the part file that
/// already owns the request path it delegates to.
extension SessionDetailAgentControl on SessionDetailController {
  /// Switches the live session's agent/mode to a broker-advertised name.
  ///
  /// The mode control follows the broker's pushed `currentAgent` rather than
  /// any local optimistic state, so a switch made from the terminal side shows
  /// up the same way one made here does.
  Future<bool> setAgent(String agent) => _setAgentCoordinated(agent);
}

extension _SessionDetailRequestActions on SessionDetailController {
  Future<bool> _sendPermissionDecisionCoordinated({
    required String requestId,
    required String decision,
  }) async {
    final trimmedRequestId = requestId.trim();
    if (trimmedRequestId.isEmpty) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(
          FailureLead.permissionDecisionMissingRequestId,
        ),
      );
      return false;
    }

    final trimmedDecision = decision.trim();
    if (trimmedDecision.isEmpty) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(
          FailureLead.permissionDecisionEmpty,
        ),
      );
      return false;
    }

    final connection = _connection;
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(
          FailureLead.permissionDecisionDisconnected,
        ),
      );
      return false;
    }

    try {
      await _sendOutboxMessage(
        kind: SessionOutboxMessageKind.permissionDecision,
        payload: {
          'requestId': trimmedRequestId,
          'decision': trimmedDecision,
        },
        send: (clientMessageId) => connection.sendPermissionDecision(
          trimmedRequestId,
          trimmedDecision,
          clientMessageId: clientMessageId,
        ),
      );
      state = state.copyWith(clearError: true);
      return true;
    } on Object {
      // The request card owns the localized failure state. Setting the page's
      // global error here rebuilds virtualized transcript rows and destroys
      // that card state, including question text. The durable outbox retains
      // the bounded transport detail for retry and diagnostics.
      return false;
    }
  }

  /// Switches the session's active agent/mode (e.g. opencode build/plan).
  ///
  /// The name must be one the broker advertised in this session's `options`
  /// frame — the control never invents modes — and the session must allow
  /// mutation. The visible confirmation is the broker's own `session` frame
  /// carrying the updated `currentAgent`; no local override state is kept.
  Future<bool> _setAgentCoordinated(String agent) async {
    final trimmedAgent = agent.trim();
    if (trimmedAgent.isEmpty) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(FailureLead.agentSwitchEmptyName),
      );
      return false;
    }
    final advertised = state.agents.any(
      (option) => option.name == trimmedAgent,
    );
    if (!advertised) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(
          FailureLead.agentSwitchUnadvertised,
        ),
      );
      return false;
    }
    if (!SessionControlView.fromSessionDetailState(state).canMutate) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(
          FailureLead.agentSwitchRequiresDrive,
        ),
      );
      return false;
    }
    final connection = _connection;
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(
          FailureLead.agentSwitchDisconnected,
        ),
      );
      return false;
    }
    try {
      await _sendOutboxMessage(
        kind: SessionOutboxMessageKind.setAgent,
        payload: {'agent': trimmedAgent},
        send: (clientMessageId) => connection.sendSetAgent(
          trimmedAgent,
          clientMessageId: clientMessageId,
        ),
      );
      state = state.copyWith(clearError: true);
      return true;
    } on Object catch (e) {
      state = state.copyWith(
        error: LocalizedFailure.from(e, lead: FailureLead.changeSessionAgent),
      );
      return false;
    }
  }

  /// Sends an answer for a question-request message.
  ///
  /// The request id must be non-empty and the answers must include at least
  /// one non-empty answer list.
  /// Returns `true` only when the answers were accepted by the transport.
  Future<bool> _sendQuestionAnswerCoordinated({
    required String requestId,
    required List<List<String>> answers,
  }) async {
    final trimmedRequestId = requestId.trim();
    if (trimmedRequestId.isEmpty) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(
          FailureLead.questionAnswerMissingRequestId,
        ),
      );
      return false;
    }

    final normalizedAnswers = answers
        .map(
          (answer) => answer
              .map((item) => item.trim())
              .where((item) => item.isNotEmpty)
              .toList(),
        )
        .where((answer) => answer.isNotEmpty)
        .toList();
    if (normalizedAnswers.isEmpty) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(FailureLead.questionAnswerEmpty),
      );
      return false;
    }

    final connection = _connection;
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(
          FailureLead.questionAnswerDisconnected,
        ),
      );
      return false;
    }

    try {
      await _sendOutboxMessage(
        kind: SessionOutboxMessageKind.questionAnswer,
        payload: {
          'requestId': trimmedRequestId,
          'answers': normalizedAnswers,
        },
        send: (clientMessageId) => connection.sendQuestionAnswer(
          trimmedRequestId,
          normalizedAnswers,
          clientMessageId: clientMessageId,
        ),
      );
      state = state.copyWith(clearError: true);
      return true;
    } on Object {
      // Keep the typed/local request state alive; `_sendOutboxMessage` already
      // records the technical failure on the durable outbox entry.
      return false;
    }
  }

  /// Rejects (dismisses) a question request.
  ///
  /// The request id must be non-empty and the session must be connected.
  /// Returns `true` only when the reject was accepted by the transport.
  Future<bool> _rejectQuestionCoordinated(String requestId) async {
    final trimmedRequestId = requestId.trim();
    if (trimmedRequestId.isEmpty) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(
          FailureLead.questionRejectMissingRequestId,
        ),
      );
      return false;
    }

    final connection = _connection;
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(
          FailureLead.questionRejectDisconnected,
        ),
      );
      return false;
    }

    try {
      await _sendOutboxMessage(
        kind: SessionOutboxMessageKind.rejectQuestion,
        payload: {'requestId': trimmedRequestId},
        send: (clientMessageId) => connection.rejectQuestion(
          trimmedRequestId,
          clientMessageId: clientMessageId,
        ),
      );
      state = state.copyWith(clearError: true);
      return true;
    } on Object {
      // The request card reports this failure without leaking transport text.
      return false;
    }
  }

  /// Persists one mutating message, then dispatches it.
  ///
  /// [beforeDispatch] runs after the durable outbox row exists and before the
  /// frame is written, and a throw from it aborts the dispatch with the row
  /// left retryable. That boundary is where a send binds durable state it must
  /// own exactly once — binding afterwards would run against whatever state
  /// the awaits left behind.
  Future<void> _sendOutboxMessage({
    required SessionOutboxMessageKind kind,
    required Map<String, dynamic> payload,
    required Future<void> Function(String clientMessageId) send,
    void Function(String clientMessageId)? onPersisted,
    Future<void> Function(String clientMessageId)? beforeDispatch,
  }) async {
    final brokerProfileId = _brokerScopeKey;
    if (brokerProfileId == null) {
      throw StateError(
        'Cannot save a session action without an active server.',
      );
    }
    final repository = ref.read(sessionOutboxRepositoryProvider);
    final clientMessageId = _nextClientMessageId();
    await repository.upsert(
      SessionOutboxMessage.create(
        sessionKey: arg,
        brokerProfileId: brokerProfileId,
        clientMessageId: clientMessageId,
        kind: kind,
        payload: payload,
      ),
    );
    if (_brokerScopeKey != brokerProfileId) {
      throw StateError('The active server changed before the action was sent.');
    }
    onPersisted?.call(clientMessageId);
    try {
      await beforeDispatch?.call(clientMessageId);
      // Persist the attempt before the frame can produce a fast broker ack.
      // Otherwise a loopback ack can mark the row delivered and a later
      // markSending write can regress it back to in-flight.
      await repository.markSending(clientMessageId);
      if (_brokerScopeKey != brokerProfileId) {
        throw StateError(
          'The active server changed before the action was sent.',
        );
      }
      await send(clientMessageId);
    } on Object catch (e) {
      await repository.markRetryable(clientMessageId, e.toString());
      rethrow;
    }
    // Every durable mutating send routes through here, so this is the single
    // "real app mutation" signal that slides an existing takeover lease.
    _refreshDriveLeaseAfterMutation();
  }

  Future<void> _replayRetryableOutbox() async {
    if (_replayingOutbox) {
      return;
    }
    final connection = _connection;
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      return;
    }
    _replayingOutbox = true;
    try {
      final repository = ref.read(sessionOutboxRepositoryProvider);
      final brokerProfileId = _brokerScopeKey;
      if (brokerProfileId == null) return;
      final messages = await repository.loadRetryableForSession(
        arg,
        brokerProfileId: brokerProfileId,
      );
      for (final message in messages) {
        if (_brokerScopeKey != brokerProfileId ||
            !identical(_connection, connection) ||
            state.connectionStatus != SessionDetailConnectionStatus.connected) {
          return;
        }
        final payloadError = _outboxReplayPayloadError(message);
        if (payloadError != null) {
          await repository.markFailed(message.clientMessageId, payloadError);
          if (message.kind == SessionOutboxMessageKind.prompt) {
            await _restoreDraftForFailedSend(message.clientMessageId);
          }
          continue;
        }
        final control = SessionControlView.fromSessionDetailState(state);
        if (!_canReplayOutboxMessage(message, control)) {
          continue;
        }
        try {
          // DR1: an unsettled prompt gets the same pre-dispatch guarantee as
          // a fresh one. A row bound before the crash is already correct and
          // this is a no-op; a row whose binding never landed is bound now,
          // but only while it still holds the text this prompt carried. The
          // pre-crash local revision is not knowable here, so the text is what
          // remains verifiable — a row another device replaced will not match.
          if (message.kind == SessionOutboxMessageKind.prompt) {
            final bound = await _bindSubmittedDraft(
              message.clientMessageId,
              expectedText: message.payload['text'] as String?,
            );
            if (!bound) {
              await repository.markRetryable(
                message.clientMessageId,
                'The draft could not be bound to this prompt.',
              );
              continue;
            }
          }
          await repository.markSending(message.clientMessageId);
          if (_brokerScopeKey != brokerProfileId ||
              !identical(_connection, connection) ||
              state.connectionStatus !=
                  SessionDetailConnectionStatus.connected) {
            return;
          }
          await _sendPersistedOutboxMessage(connection, message);
        } on Object catch (e) {
          await repository.markRetryable(
            message.clientMessageId,
            e.toString(),
          );
        }
      }
    } finally {
      _replayingOutbox = false;
    }
  }

  bool _canReplayOutboxMessage(
    SessionOutboxMessage message,
    SessionControlView control,
  ) {
    return switch (message.kind) {
      SessionOutboxMessageKind.prompt ||
      SessionOutboxMessageKind.command ||
      SessionOutboxMessageKind.file ||
      SessionOutboxMessageKind.planAction ||
      SessionOutboxMessageKind.artifactInteraction ||
      SessionOutboxMessageKind.actionCommand => control.canPrompt,
      SessionOutboxMessageKind.permissionDecision ||
      SessionOutboxMessageKind.questionAnswer ||
      SessionOutboxMessageKind.rejectQuestion ||
      SessionOutboxMessageKind.setAgent => control.canMutate,
    };
  }

  String? _outboxReplayPayloadError(SessionOutboxMessage message) {
    try {
      switch (message.kind) {
        case SessionOutboxMessageKind.prompt:
          final rawFiles = message.payload['files'];
          if (rawFiles == null) return null;
          if (rawFiles is! List || rawFiles.length > promptAttachmentMaxFiles) {
            return 'Not replayed because attachment metadata is invalid.';
          }
          for (final raw in rawFiles) {
            if (raw is! Map<Object?, Object?>) {
              return 'Not replayed because attachment metadata is invalid.';
            }
            final file = Map<String, dynamic>.from(raw);
            if (file.containsKey('data') ||
                file.containsKey('path') ||
                file.containsKey('brokerPath')) {
              return 'Not replayed because attachment bytes or paths entered '
                  'the outbox.';
            }
            final stagedRef = file['stagedRef'] as String?;
            if (stagedRef != null && stagedRef.isNotEmpty) continue;
            final localId = file['localId'] as String?;
            final retained = state.stagedAttachments
                .where((item) => item.localId == localId)
                .firstOrNull;
            if (retained == null || !retained.isInline) {
              return 'Inline attachment bytes are no longer retained; select '
                  'the file again.';
            }
          }
          return null;
        case SessionOutboxMessageKind.planAction:
          final request = PlanActionRequest.fromJson(message.payload);
          if (request.planKey.trim().isEmpty ||
              request.planRevision.trim().isEmpty ||
              (request.action == PlanActionKind.edit &&
                  (request.text == null || request.text!.trim().isEmpty))) {
            return 'Not replayed because the plan identity is stale.';
          }
          return null;
        case SessionOutboxMessageKind.artifactInteraction:
          final request = ArtifactInteractionRequest.fromJson(message.payload);
          if (request.artifactKey.trim().isEmpty ||
              request.interactionRef.trim().isEmpty ||
              request.interaction.isEmpty) {
            return 'Not replayed because signed artifact context is missing.';
          }
          return null;
        case _:
          return null;
      }
    } on Object {
      return 'Not replayed because the durable payload is invalid.';
    }
  }

  Future<void> _sendPersistedOutboxMessage(
    SessionDetailConnection connection,
    SessionOutboxMessage message,
  ) {
    final payload = message.payload;
    final clientMessageId = message.clientMessageId;
    return switch (message.kind) {
      // DR1: the draft ownership tokens are replayed from the durable payload,
      // never recomputed. The broker fingerprints every field but the client
      // message id, so a replay that dropped them (or read a revision that has
      // moved since) would be rejected as a conflicting reuse of the id instead
      // of returning the original acknowledgement. Rows written before these
      // keys existed carry neither, and stay byte-identical to their first
      // send. The approval mode is replayed for both reasons at once: it is
      // part of that fingerprint, and it is the mode the user chose for THIS
      // prompt — reading the composer's current mode at replay time would send
      // a request they never made.
      SessionOutboxMessageKind.prompt => connection.sendPrompt(
        payload['text'] as String? ?? '',
        model: _decodeModel(payload['model']),
        files: _promptFilesFromOutbox(payload),
        clientMessageId: clientMessageId,
        draftRevision: (payload['draftRevision'] as num?)?.toInt(),
        draftUpdateId: payload['draftUpdateId'] as String?,
        permissionMode: payload['permissionMode'] as String?,
      ),
      SessionOutboxMessageKind.command => connection.sendCommand(
        payload['name'] as String? ?? '',
        args: (payload['args'] as Map?)?.cast<String, dynamic>(),
        model: _decodeModel(payload['model']),
        clientMessageId: clientMessageId,
      ),
      SessionOutboxMessageKind.actionCommand => connection.sendCommand(
        payload['name'] as String? ?? '',
        args: (payload['args'] as Map?)?.cast<String, dynamic>(),
        clientMessageId: clientMessageId,
      ),
      SessionOutboxMessageKind.planAction => connection.sendPlanAction(
        PlanActionRequest.fromJson(payload),
        clientMessageId: clientMessageId,
      ),
      SessionOutboxMessageKind.artifactInteraction =>
        connection.sendArtifactInteraction(
          ArtifactInteractionRequest.fromJson(payload),
          clientMessageId: clientMessageId,
        ),
      SessionOutboxMessageKind.permissionDecision =>
        connection.sendPermissionDecision(
          payload['requestId'] as String? ?? '',
          payload['decision'] as String? ?? '',
          clientMessageId: clientMessageId,
        ),
      SessionOutboxMessageKind.questionAnswer => connection.sendQuestionAnswer(
        payload['requestId'] as String? ?? '',
        _decodeAnswers(payload['answers']),
        clientMessageId: clientMessageId,
      ),
      SessionOutboxMessageKind.rejectQuestion => connection.rejectQuestion(
        payload['requestId'] as String? ?? '',
        clientMessageId: clientMessageId,
      ),
      SessionOutboxMessageKind.setAgent => connection.sendSetAgent(
        payload['agent'] as String? ?? '',
        clientMessageId: clientMessageId,
      ),
      SessionOutboxMessageKind.file => connection.sendFile(
        name: payload['name'] as String? ?? '',
        data: payload['data'] as String? ?? '',
        mimeType: payload['mimeType'] as String?,
        clientMessageId: clientMessageId,
      ),
    };
  }

  List<PromptFileAttachment> _promptFilesFromOutbox(
    Map<String, dynamic> payload,
  ) {
    final rawFiles = payload['files'];
    if (rawFiles is! List) return const [];
    return rawFiles
        .map((raw) {
          final file = Map<String, dynamic>.from(raw as Map);
          final stagedRef = file['stagedRef'] as String?;
          if (stagedRef != null && stagedRef.isNotEmpty) {
            return PromptFileAttachment.staged(
              name: file['name'] as String? ?? 'attachment',
              mimeType:
                  file['mimeType'] as String? ?? 'application/octet-stream',
              size: (file['size'] as num?)?.toInt() ?? 0,
              stagedRef: stagedRef,
            );
          }
          final localId = file['localId'] as String?;
          final retained = state.stagedAttachments.firstWhere(
            (item) => item.localId == localId,
          );
          return retained.toPromptFile();
        })
        .toList(growable: false);
  }
}
