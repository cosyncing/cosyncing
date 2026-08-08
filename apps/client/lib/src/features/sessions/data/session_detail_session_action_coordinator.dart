// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of 'session_detail_controller.dart';

/// Broker error code for a refused fork of an agent-spawned session.
///
/// Matched on the machine-readable `code`, never on `BrokerException.message`:
/// the sentence is broker-authored English that this client must not surface as
/// primary UI copy, and it is free to change without a contract revision.
const String kAgentOwnedForkRefusalCode = 'SESSION_AGENT_OWNED';

/// Whether [error] is the broker's typed agent-owned fork refusal (409).
bool isAgentOwnedForkRefusal(Object error) =>
    error is BrokerException && error.error?.code == kAgentOwnedForkRefusalCode;

extension _SessionDetailSessionActions on SessionDetailController {
  Future<bool> _renameSessionCoordinated(String title) async {
    final client = await ref.read(brokerClientProvider.future);
    if (client == null) {
      const message = 'Connect to a broker before renaming this session.';
      state = state.copyWith(
        error: message,
        renameSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return false;
    }

    if (state.agentActions?.canRenameNative != true) {
      const message = 'Rename is not available for this agent.';
      state = state.copyWith(
        error: message,
        renameSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return false;
    }

    if (state.renameSessionActionState.isBusy) {
      return false;
    }

    state = state.copyWith(
      renameSessionActionState: const SessionActionState(
        phase: SessionActionPhase.inProgress,
        message: 'Renaming session...',
      ),
      clearError: true,
    );

    try {
      final normalized = title.trim();
      final response = await client.renameSession(
        arg.tool,
        arg.sessionId,
        normalized.isEmpty ? null : normalized,
      );
      if (!response.ok) {
        throw const BrokerException(
          message: 'Broker rejected the rename.',
          statusCode: 400,
        );
      }

      final current = state.sessionInfo;
      final updated =
          response.session ??
          (current == null
              ? null
              : SessionInfo.fromJson({
                  ...current.toJson(),
                  'title': response.title ?? '',
                }));
      state = state.copyWith(
        sessionInfo: updated,
        renameSessionActionState: const SessionActionState(
          phase: SessionActionPhase.success,
          message: 'Session title updated.',
        ),
        clearError: true,
      );
      return true;
    } on Object catch (error) {
      final message = userFacingMessage(
        error,
        lead: "Couldn't rename this session.",
      );
      state = state.copyWith(
        error: message,
        renameSessionActionState: SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return false;
    }
  }

  /// Forks the current session via the broker capability-gated fork API.
  Future<SessionInfo?> _forkSessionCoordinated({String? messageId}) async {
    final client = await ref.read(brokerClientProvider.future);
    if (client == null) {
      const message = 'Connect to a broker before forking this session.';
      state = state.copyWith(
        error: message,
        forkSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return null;
    }

    if (state.agentActions?.canFork != true) {
      const message = 'Fork is not available for this agent.';
      state = state.copyWith(
        error: message,
        forkSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return null;
    }

    // Per-session refusal, matching the broker's SESSION_AGENT_OWNED gate. The
    // affordances are already hidden for this shape; this keeps a programmatic
    // caller (a restored intent, a deep link, a stale widget) from posting a
    // fork the broker will only reject.
    //
    // Refused with a TYPED reason rather than a message, because the copy is
    // new and must exist in every shipped language (`AppLocalizations`). A
    // controller has no `AppLocalizations` to resolve — the locale lives in the
    // widget tree — and a string frozen into state here would keep the language
    // it was written in across a language switch. The view resolves it, exactly
    // as `SessionDetailBootstrapState.failureSource` is resolved. It also does
    // not write `state.error`: that channel is a bare string with no typed
    // companion, so it has nothing to localize from, and the fork status line
    // beneath the (withheld) Fork tile is where fork outcomes already report.
    // The standing refusal is a second gate on the SAME condition. When the
    // broker refused (below) but the local roster row never said `subagent` —
    // stale, absent, or served by a peer — `isAgentOwnedSession` is false, so
    // without this every retry would re-post a request that can only ever come
    // back 409. It is not permanent: an authoritative session frame that no
    // longer classifies the session as `subagent` clears it (see the
    // SessionWireEvent branch in the controller's event fold).
    if (state.forkBlockedAsAgentOwned) {
      _recordAgentOwnedForkRefusal();
      return null;
    }

    if (state.forkSessionActionState.isBusy) {
      const message = 'Fork is already in progress.';
      state = state.copyWith(
        error: message,
        forkSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return null;
    }

    state = state.copyWith(
      forkSessionActionState: const SessionActionState(
        phase: SessionActionPhase.inProgress,
        message: 'Creating forked session...',
      ),
      clearError: true,
    );

    try {
      final response = await client.forkSession(
        arg.tool,
        arg.sessionId,
        messageId: messageId,
      );
      final created = response.session;
      if (created == null) {
        const message = 'Fork returned no new session.';
        state = state.copyWith(
          error: message,
          forkSessionActionState: const SessionActionState(
            phase: SessionActionPhase.failed,
            message: message,
          ),
        );
        return null;
      }

      final title = created.title.isNotEmpty ? created.title : created.id;
      state = state.copyWith(
        forkSessionActionState: SessionActionState(
          phase: SessionActionPhase.success,
          message: 'Forked session: $title',
          createdSessionId: created.id,
          createdSessionTitle: created.title,
        ),
        clearError: true,
      );
      return created;
    } on Object catch (e) {
      // The broker's `409 SESSION_AGENT_OWNED` is the SAME permanent answer the
      // local gate above gives, reached whenever the local lineage was missing
      // or stale. Falling through to `userFacingMessage` would write the
      // broker's English sentence into `state.error` as primary UI copy, in a
      // client that ships two languages. Convert it to the typed refusal the
      // view already localizes.
      if (isAgentOwnedForkRefusal(e)) {
        _recordAgentOwnedForkRefusal();
        return null;
      }
      final message = userFacingMessage(
        e,
        lead: "Couldn't fork this session.",
      );
      state = state.copyWith(
        error: message,
        forkSessionActionState: SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return null;
    }
  }

  /// Records the typed agent-owned fork refusal, from either refuser.
  ///
  /// One writer for both the local `origin` gate and the broker's 409 so the
  /// two paths cannot drift. Deliberately carries no `message`: the copy is
  /// resolved by the view in the current locale (`SessionActionRefusal`), and a
  /// string frozen here would keep the language it was written in across a
  /// language switch.
  ///
  /// `clearError` is load-bearing. A previous failure's English sentence is
  /// still sitting in `state.error`, rendered as a page-level banner above the
  /// status line; leaving it would pair the localized refusal with stale,
  /// unrelated, unlocalized text.
  void _recordAgentOwnedForkRefusal() {
    state = state.copyWith(
      forkSessionActionState: const SessionActionState(
        phase: SessionActionPhase.failed,
        refusal: SessionActionRefusal.agentOwnedSession,
      ),
      clearError: true,
    );
  }

  /// Clones the current session via the broker capability-gated clone API.
  Future<SessionInfo?> _cloneSessionCoordinated() async {
    final client = await ref.read(brokerClientProvider.future);
    if (client == null) {
      const message = 'Connect to a broker before cloning this session.';
      state = state.copyWith(
        error: message,
        cloneSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return null;
    }

    if (state.agentActions?.canClone != true) {
      const message = 'Clone is not available for this agent.';
      state = state.copyWith(
        error: message,
        cloneSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return null;
    }

    if (state.cloneSessionActionState.isBusy) {
      const message = 'Clone is already in progress.';
      state = state.copyWith(
        error: message,
        cloneSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return null;
    }

    state = state.copyWith(
      cloneSessionActionState: const SessionActionState(
        phase: SessionActionPhase.inProgress,
        message: 'Creating cloned session...',
      ),
      clearError: true,
    );

    try {
      final response = await client.cloneSession(arg.tool, arg.sessionId);
      final created = response.session;
      if (created == null) {
        const message = 'Clone returned no new session.';
        state = state.copyWith(
          error: message,
          cloneSessionActionState: const SessionActionState(
            phase: SessionActionPhase.failed,
            message: message,
          ),
        );
        return null;
      }

      final title = created.title.isNotEmpty ? created.title : created.id;
      state = state.copyWith(
        cloneSessionActionState: SessionActionState(
          phase: SessionActionPhase.success,
          message: 'Cloned session: $title',
          createdSessionId: created.id,
          createdSessionTitle: created.title,
        ),
        clearError: true,
      );
      return created;
    } on Object catch (e) {
      final message = userFacingMessage(
        e,
        lead: "Couldn't clone this session.",
      );
      state = state.copyWith(
        error: message,
        cloneSessionActionState: SessionActionState(
          phase: SessionActionPhase.failed,
          message: message,
        ),
      );
      return null;
    }
  }

  void _appendTranscriptExportArtifact(SessionArtifact artifact) {
    final raw = Map<String, Object?>.from(artifact.toJson())
      ..removeWhere((_, value) => value == null)
      ..['type'] = AgentMessageType.fileArtifact.wireValue;
    final message = AgentMessage(
      type: AgentMessageType.fileArtifact,
      raw: raw,
    );
    state = state.copyWith(
      events: appendSessionDetailEventLog(
        state.events,
        MessageWireEvent(seq: 0, message: message),
      ),
      transcriptWindow: state.activeTranscriptWindow.applyLiveMessage(message),
    );
  }

  _TranscriptExportFailure _transcriptExportFailure(Object error) {
    if (error is BrokerException) {
      final code = error.error?.code;
      final message = switch (code) {
        'CONFIRMATION_STALE' =>
          'Transcript export confirmation expired or changed. Try again.',
        'RATE_LIMITED' => 'Transcript export is rate limited. Try again later.',
        'R2_DISABLED' =>
          'Transcript export is disabled for this broker or client.',
        'BAD_PARAM' => 'Transcript export request was rejected by the broker.',
        _ when error.statusCode == 501 =>
          'Transcript export is not available for this agent.',
        _ => userFacingMessage(
          error,
          lead: "Couldn't export this transcript.",
        ),
      };
      return _TranscriptExportFailure(message: message, code: code);
    }

    return _TranscriptExportFailure(
      message: userFacingMessage(
        error,
        lead: "Couldn't export this transcript.",
      ),
    );
  }

  /// Sends a permission decision for a permission-request message.
  ///
  /// The request id must be non-empty and the session must be connected.
  /// Returns `true` only when the decision was accepted by the transport.
}
