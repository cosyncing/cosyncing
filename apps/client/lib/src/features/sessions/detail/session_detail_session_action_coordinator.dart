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
    final source = _connectionSource;
    if (!_canPublishRenameFor(source)) return false;

    try {
      final client = await ref.read(brokerClientProvider.future);
      if (!_canPublishRenameFor(source)) return false;
      if (client == null) {
        const lead = FailureLead.renameRequiresServer;
        const refusal = SessionActionRefusal.renameRequiresServer;
        state = state.copyWith(
          error: const LocalizedFailure.notice(lead),
          renameSessionActionState: const SessionActionState(
            phase: SessionActionPhase.failed,
            refusal: refusal,
          ),
        );
        return false;
      }

      if (state.agentActions?.canRenameNative != true) {
        const lead = FailureLead.renameUnsupported;
        const refusal = SessionActionRefusal.renameUnsupported;
        state = state.copyWith(
          error: const LocalizedFailure.notice(lead),
          renameSessionActionState: const SessionActionState(
            phase: SessionActionPhase.failed,
            refusal: refusal,
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
        ),
        clearError: true,
      );

      final normalized = title.trim();
      final response = await client.renameSession(
        arg.tool,
        arg.sessionId,
        normalized.isEmpty ? null : normalized,
      );
      if (!_canPublishRenameFor(source)) return false;
      if (!response.ok) {
        throw const BrokerException(
          message: 'Server rejected the rename.',
          statusCode: 400,
        );
      }

      final current = state.sessionInfo;
      final acceptedTitle =
          response.session?.title ??
          response.title ??
          (normalized.isEmpty ? '' : null);
      final updated = current == null
          ? response.session
          : SessionInfo.fromJson({
              ...current.toJson(),
              'title': acceptedTitle ?? current.title,
            });
      state = state.copyWith(
        sessionInfo: updated,
        renameSessionActionState: const SessionActionState(
          phase: SessionActionPhase.success,
        ),
        clearError: true,
      );
      if (acceptedTitle != null) {
        ref
            .read(sessionListControllerProvider.notifier)
            .renameSessionTitle(arg.tool, arg.sessionId, acceptedTitle);
        // The durable open-tab set may still be hydrating when a compact
        // detail route accepts the rename. Patch after hydration so a stored
        // old title cannot win merely because the mutation returned quickly.
        unawaited(
          ref
              .read(openSessionsControllerProvider.future)
              .then((_) {
                if (!_canPublishRenameFor(source)) return;
                ref
                    .read(openSessionsControllerProvider.notifier)
                    .renameSessionTitle(
                      arg.tool,
                      arg.sessionId,
                      acceptedTitle,
                    );
              })
              .catchError((Object _) {
                // Local tab persistence cannot turn a successful native rename
                // into a failed user action. Roster/native truth heals it.
              }),
        );
      }
      return true;
    } on Object catch (error) {
      if (!_canPublishRenameFor(source)) return false;
      final failure = LocalizedFailure.from(
        error,
        lead: FailureLead.renameSession,
      );
      state = state.copyWith(
        error: failure,
        renameSessionActionState: SessionActionState(
          phase: SessionActionPhase.failed,
          failure: failure,
        ),
      );
      return false;
    }
  }

  /// Whether a rename owned by the mounted [source] may proceed or publish.
  ///
  /// The active profile chooses which client would receive a mutation, while
  /// [_connectionSource] owns the session frame and capabilities currently on
  /// screen. Both must name the same exact profile, endpoint and incarnation
  /// at admission and after every await. This prevents stale facts from broker
  /// A from authorizing a rename sent to newly active broker B.
  bool _canPublishRenameFor(RosterSource? source) =>
      source != null &&
      !_disposed &&
      _connectionSource == source &&
      RosterSource.of(ref.read(activeBrokerProfileProvider)) == source;

  /// Forks the current session via the broker capability-gated fork API.
  Future<SessionInfo?> _forkSessionCoordinated({String? messageId}) async {
    final client = await ref.read(brokerClientProvider.future);
    if (client == null) {
      const lead = FailureLead.forkRequiresServer;
      const refusal = SessionActionRefusal.forkRequiresServer;
      state = state.copyWith(
        error: const LocalizedFailure.notice(lead),
        forkSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          refusal: refusal,
        ),
      );
      return null;
    }

    if (state.agentActions?.canFork != true) {
      const lead = FailureLead.forkUnsupported;
      const refusal = SessionActionRefusal.forkUnsupported;
      state = state.copyWith(
        error: const LocalizedFailure.notice(lead),
        forkSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          refusal: refusal,
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
      const lead = FailureLead.forkAlreadyRunning;
      const refusal = SessionActionRefusal.forkAlreadyRunning;
      state = state.copyWith(
        error: const LocalizedFailure.notice(lead),
        forkSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          refusal: refusal,
        ),
      );
      return null;
    }

    state = state.copyWith(
      forkSessionActionState: const SessionActionState(
        phase: SessionActionPhase.inProgress,
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
        const lead = FailureLead.forkReturnedNothing;
        const refusal = SessionActionRefusal.forkReturnedNothing;
        state = state.copyWith(
          error: const LocalizedFailure.notice(lead),
          forkSessionActionState: const SessionActionState(
            phase: SessionActionPhase.failed,
            refusal: refusal,
          ),
        );
        return null;
      }

      state = state.copyWith(
        forkSessionActionState: SessionActionState(
          phase: SessionActionPhase.success,
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
      // client that ships multiple locales. Convert it to the typed refusal the
      // view already localizes.
      if (isAgentOwnedForkRefusal(e)) {
        _recordAgentOwnedForkRefusal();
        return null;
      }
      final failure = LocalizedFailure.from(e, lead: FailureLead.forkSession);
      state = state.copyWith(
        error: failure,
        forkSessionActionState: SessionActionState(
          phase: SessionActionPhase.failed,
          failure: failure,
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
      const lead = FailureLead.cloneRequiresServer;
      const refusal = SessionActionRefusal.cloneRequiresServer;
      state = state.copyWith(
        error: const LocalizedFailure.notice(lead),
        cloneSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          refusal: refusal,
        ),
      );
      return null;
    }

    if (state.agentActions?.canClone != true) {
      const lead = FailureLead.cloneUnsupported;
      const refusal = SessionActionRefusal.cloneUnsupported;
      state = state.copyWith(
        error: const LocalizedFailure.notice(lead),
        cloneSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          refusal: refusal,
        ),
      );
      return null;
    }

    if (state.cloneSessionActionState.isBusy) {
      const lead = FailureLead.cloneAlreadyRunning;
      const refusal = SessionActionRefusal.cloneAlreadyRunning;
      state = state.copyWith(
        error: const LocalizedFailure.notice(lead),
        cloneSessionActionState: const SessionActionState(
          phase: SessionActionPhase.failed,
          refusal: refusal,
        ),
      );
      return null;
    }

    state = state.copyWith(
      cloneSessionActionState: const SessionActionState(
        phase: SessionActionPhase.inProgress,
      ),
      clearError: true,
    );

    try {
      final response = await client.cloneSession(arg.tool, arg.sessionId);
      final created = response.session;
      if (created == null) {
        const lead = FailureLead.cloneReturnedNothing;
        const refusal = SessionActionRefusal.cloneReturnedNothing;
        state = state.copyWith(
          error: const LocalizedFailure.notice(lead),
          cloneSessionActionState: const SessionActionState(
            phase: SessionActionPhase.failed,
            refusal: refusal,
          ),
        );
        return null;
      }

      state = state.copyWith(
        cloneSessionActionState: SessionActionState(
          phase: SessionActionPhase.success,
          createdSessionId: created.id,
          createdSessionTitle: created.title,
        ),
        clearError: true,
      );
      return created;
    } on Object catch (e) {
      final failure = LocalizedFailure.from(e, lead: FailureLead.cloneSession);
      state = state.copyWith(
        error: failure,
        cloneSessionActionState: SessionActionState(
          phase: SessionActionPhase.failed,
          failure: failure,
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
        'CONFIRMATION_STALE' => const LocalizedFailure.notice(
          FailureLead.exportConfirmationStale,
        ),
        'RATE_LIMITED' => const LocalizedFailure.notice(
          FailureLead.exportRateLimited,
        ),
        'R2_DISABLED' => const LocalizedFailure.notice(
          FailureLead.exportDisabled,
        ),
        'BAD_PARAM' => const LocalizedFailure.notice(
          FailureLead.exportBadParam,
        ),
        _ when error.statusCode == 501 => const LocalizedFailure.notice(
          FailureLead.exportUnsupported,
        ),
        _ => LocalizedFailure.from(error, lead: FailureLead.exportTranscript),
      };
      return _TranscriptExportFailure(message: message, code: code);
    }

    return _TranscriptExportFailure(
      message: LocalizedFailure.from(error, lead: FailureLead.exportTranscript),
    );
  }

  /// Sends a permission decision for a permission-request message.
  ///
  /// The request id must be non-empty and the session must be connected.
  /// Returns `true` only when the decision was accepted by the transport.
}
