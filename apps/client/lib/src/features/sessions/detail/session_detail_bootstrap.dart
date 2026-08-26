// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of 'session_detail_controller.dart';

/// Max wait for the first authoritative history event after attach.
final sessionDetailInitialHistoryTimeoutProvider = Provider<Duration>(
  (ref) => const Duration(seconds: 10),
);

extension _SessionDetailBootstrap on SessionDetailController {
  Future<void> _attachOnce(SessionDetailAttachIntent intent) {
    final cancellation = _TransportAttachCancellation();
    _transportAttachCancellations.add(cancellation);
    final body = _attachOnceBody(intent);
    return cancellation.settle(body).whenComplete(() {
      _transportAttachCancellations.remove(cancellation);
    });
  }

  Future<void> _attachOnceBody(SessionDetailAttachIntent intent) async {
    final attempt = ++_bootstrapAttempt;
    _abortBootstrapActionRefresh();
    final actionAbort = Completer<void>();
    _bootstrapActionAbort = actionAbort;
    _cancelInitialHistoryTimeout();
    final hasVisibleTranscript =
        state.bootstrapState.hasCachedMessages ||
        state.messageEvents.isNotEmpty;
    state = state.copyWith(
      bootstrapState: const SessionDetailBootstrapState()
          .resolvingProfile(
            attempt: attempt,
            hasCachedMessages: hasVisibleTranscript,
          )
          .copyWith(clearFailure: true),
    );

    final profile = ref.read(activeBrokerProfileProvider);
    if (profile == null) {
      _connectionSource = null;
      await _resetConnectionForProfileSwitch();
      state = state.copyWith(
        connectionStatus: SessionDetailConnectionStatus.disconnected,
        bootstrapState: const SessionDetailBootstrapState().failure(
          attempt: attempt,
          kind: FailureKind.unknown,
          source: SessionDetailBootstrapFailureSource.noProfile,
          hasCachedMessages: hasVisibleTranscript,
        ),
        error: const LocalizedFailure.notice(FailureLead.attachRequiresServer),
        clearSessionInfo: true,
      );
      return;
    }

    // The broker this attach is for: (profile, endpoint), not the profile id
    // alone. Re-pointing a profile at another machine keeps its id, so
    // comparing ids reused the connection to the OLD broker and let its frames
    // land as the new one's. This is the value every guard below compares
    // against — it is read ONCE, so a switch mid-attach cannot make an earlier
    // step believe it is still current.
    final source = RosterSource.ofProfile(profile);
    final connectedSource = _connectionSource;
    final transcriptScope = _transcriptScopeKey;
    final brokerChanged =
        (connectedSource != null && connectedSource != source) ||
        (transcriptScope != null && transcriptScope != source.storageKey);
    if (brokerChanged) {
      await _resetConnectionForProfileSwitch();
      _transcriptScopeKey = null;
      // DR1: drafts are profile-scoped; the previous profile's cached row and
      // any pending conflict/surface must never bleed into the new profile.
      _resetLocalDraftForProfileSwitch();
      state = SessionDetailState(
        tool: arg.tool,
        sessionId: arg.sessionId,
        bootstrapState: const SessionDetailBootstrapState().resolvingProfile(
          attempt: attempt,
          hasCachedMessages: false,
        ),
      );
    }

    Object? clientError;
    final client = await ref.read(brokerClientProvider.future).catchError((
      Object error,
      StackTrace _,
    ) {
      clientError = error;
      return null;
    });

    if (!_isCurrentBootstrapAttempt(attempt) ||
        RosterSource.of(ref.read(activeBrokerProfileProvider)) != source) {
      await _retireBootstrapAfterProfileChange(attempt);
      return;
    }

    if (client == null) {
      _connectionSource = null;
      await _resetConnectionForProfileSwitch();
      state = state.copyWith(
        connectionStatus: SessionDetailConnectionStatus.disconnected,
        bootstrapState: const SessionDetailBootstrapState().failure(
          attempt: attempt,
          kind: clientError == null
              ? FailureKind.unknown
              : classifyFailure(clientError!),
          source: SessionDetailBootstrapFailureSource.attach,
          hasCachedMessages: hasVisibleTranscript,
        ),
        error: clientError == null
            ? const LocalizedFailure.notice(FailureLead.attachRequiresServer)
            : LocalizedFailure.from(
                clientError!,
                lead: FailureLead.connectSession,
              ),
        clearSessionInfo: true,
      );
      return;
    }

    state = state.copyWith(
      // Provenance is stamped before anything this broker reports can land, so
      // every later session frame is attributable. Consumers use it to refuse
      // the previous broker's frame during the window between a switch and the
      // reset below completing.
      source: source,
      bootstrapState: state.bootstrapState.hydratingCache(
        attempt: attempt,
        hasCachedMessages: !brokerChanged && hasVisibleTranscript,
      ),
      clearError: true,
      clearTransientRetryStatus: true,
    );

    // The one broker this attach is bound to. Every authoritative status this
    // connection later observes is published against THIS source, so an
    // endpoint edit that keeps the profile id cannot relabel the old broker's
    // frames as the new one's.
    _connectionSource = source;
    final hasCachedMessages = await _hydrateTranscript(
      source.storageKey,
      attempt,
    );

    if (!_isCurrentBootstrapAttempt(attempt) ||
        RosterSource.of(ref.read(activeBrokerProfileProvider)) != source) {
      await _retireBootstrapAfterProfileChange(attempt);
      return;
    }

    final existingConnection = _connection;
    final connection = _connection ??=
        ref.read(sessionDetailConnectionFactoryProvider)(
          resolver: client.resolver,
          tool: arg.tool,
          sessionId: arg.sessionId,
        );
    final reconnectCursor = state.historyCursor;
    final historyConnection = connection is SessionHistoryConnection
        ? connection as SessionHistoryConnection
        : null;
    if (existingConnection == null &&
        reconnectCursor != null &&
        historyConnection != null) {
      historyConnection.seedHistoryCursor(reconnectCursor);
    }

    try {
      // The broker's one-shot create instruction wins; otherwise local
      // provenance may authorize an automatic restore. Both are local facts —
      // the ownership decision itself is the broker's atomic reason-tagged
      // attach, so no roster or transcript is fetched here.
      // A background attach asks for no authority, which is NOT the same as
      // being unable to receive any: it still opens a bare socket, and a bare
      // socket is full-authority on some adapters. So the unreadable-mode check
      // applies here too — it is a fact about the session, not about what this
      // attach wanted.
      final attachRequest =
          intent == SessionDetailAttachIntent.backgroundObserve
          ? _InteractiveAttachRequest(readOnly: _rosterAttachModeUnreadable)
          : await _interactiveAttachRequest(source);
      if (!_isCurrentBootstrapAttempt(attempt) ||
          RosterSource.of(ref.read(activeBrokerProfileProvider)) != source) {
        await _retireBootstrapAfterProfileChange(attempt);
        return;
      }

      _requestedDriveReason = attachRequest.reason;
      _liveAttachArmed = attachRequest.mode == 'live';
      state = state.copyWith(
        bootstrapState: state.bootstrapState.attachingSocket(
          attempt: attempt,
          hasCachedMessages: hasCachedMessages,
        ),
        driveRestorePhase: attachRequest.reason == null
            ? state.driveRestorePhase
            : SessionDriveRestorePhase.restoring,
        clearDriveRestoreConflict: attachRequest.reason != null,
        clearError: true,
      );
      await _listen(connection, attempt);
      if (!_isCurrentBootstrapAttempt(attempt) ||
          RosterSource.of(ref.read(activeBrokerProfileProvider)) != source) {
        await _retireBootstrapAfterProfileChange(attempt);
        return;
      }

      if (attachRequest.mode != null) {
        // Restoring Drive is the same ownership boundary as an explicit Take
        // over, and an explicit live attach also changes mutation authority.
        // Never let a retryable prompt from the previous owner replay into the
        // new owner (Claude would fork on that first send). Done BEFORE the
        // recheck below so nothing awaits between that check and the dispatch.
        await _retireRetryableOutboxForControlChange();
      }

      // Re-read IMMEDIATELY before dispatch, with NO await between this check,
      // requireReadOnly(), and the attach below.
      //
      // The decision above was taken before `_listen`, and on the restore path
      // before an async provenance lookup. A roster refresh during either
      // window can turn a readable row unreadable, and acting on the stale
      // answer would dispatch live/resume declaring nothing — the exact outcome
      // this path exists to prevent. Fail closed on the LATEST answer. The
      // latch is raised before connecting, never after, so a session this
      // client cannot read never has a mutable socket at all.
      final readOnly = attachRequest.readOnly || _rosterAttachModeUnreadable;
      final attachMode = readOnly ? null : attachRequest.mode;
      final attachReason = readOnly ? null : attachRequest.reason;
      if (readOnly) {
        connection.requireReadOnly();
        // Retract what the pre-recheck decision armed, or the controller keeps
        // waiting for a restore this attach is no longer making.
        _requestedDriveReason = null;
        _liveAttachArmed = false;
        if (state.driveRestorePhase == SessionDriveRestorePhase.restoring) {
          state = state.copyWith(
            driveRestorePhase: SessionDriveRestorePhase.idle,
          );
        }
      }

      if (attachMode != null) {
        await connection.reattach(mode: attachMode, reason: attachReason);
      } else if (existingConnection != null) {
        // Reset a reused connection to the bare Observe/shared-owner attach.
        // SessionConnection deliberately preserves its mode across network
        // reconnects, so a manual attach must explicitly clear old resume.
        await connection.reattach();
      } else {
        await connection.connect();
      }
      if (!_isCurrentBootstrapAttempt(attempt) ||
          RosterSource.of(ref.read(activeBrokerProfileProvider)) != source) {
        await _retireBootstrapAfterProfileChange(attempt);
        return;
      }
      final establishedIntent = _establishedAttachIntent;
      if (establishedIntent == null || establishedIntent.index < intent.index) {
        _establishedAttachIntent = intent;
      }

      final bootstrapState = state.bootstrapState;
      if (bootstrapState.readiness == SessionDetailBootstrapReadiness.ready) {
        state = state.copyWith(connectionStatus: connection.state);
      } else {
        state = state.copyWith(
          connectionStatus: connection.state,
          bootstrapState: bootstrapState.awaitingInitialHistory(
            attempt: attempt,
            hasCachedMessages: hasCachedMessages,
          ),
        );
        _startInitialHistoryTimeout(attempt);
      }
      await _refreshAgentActions(
        loadAgents: client.listAgents,
        bootstrapAttempt: attempt,
        source: source,
        abort: actionAbort.future,
      );
      if (identical(_bootstrapActionAbort, actionAbort)) {
        _bootstrapActionAbort = null;
      }
    } on Object catch (error) {
      if (attempt == _bootstrapAttempt &&
          RosterSource.of(ref.read(activeBrokerProfileProvider)) != source) {
        await _retireBootstrapAfterProfileChange(attempt);
      } else if (_isCurrentBootstrapAttempt(attempt)) {
        _cancelInitialHistoryTimeout();
        state = state.copyWith(
          connectionStatus: SessionDetailConnectionStatus.closed,
          bootstrapState: state.bootstrapState.failure(
            attempt: attempt,
            kind: classifyFailure(error),
            source: SessionDetailBootstrapFailureSource.attach,
            hasCachedMessages: state.bootstrapState.hasCachedMessages,
          ),
          // A transient attach failure ends the bounded Restoring claim but
          // preserves provenance; the next attach re-runs arbitration.
          driveRestorePhase: SessionDriveRestorePhase.idle,
          error: LocalizedFailure.from(error, lead: FailureLead.connectSession),
        );
        _abandonBootstrapConnection(connection, attempt);
      }
    }
  }

  bool _isCurrentBootstrapAttempt(int attempt) =>
      attempt == _bootstrapAttempt &&
      _bootstrapAttempt != 0 &&
      state.bootstrapState.attempt == attempt;

  Future<void> _retireBootstrapAfterProfileChange(int attempt) async {
    if (attempt != _bootstrapAttempt) return;
    _abortBootstrapActionRefresh(attempt: attempt);
    _connectionSource = null;
    _transcriptScopeKey = null;
    _transcriptCacheTailMessages = const [];
    _transcriptCacheTailOlderCursor = null;
    _transcriptCacheTailHasEarlier = false;
    _historyViewportAnchorKey = null;
    _establishedAttachIntent = null;
    state = SessionDetailState(tool: arg.tool, sessionId: arg.sessionId);
    await _resetConnectionForProfileSwitch();
  }

  Future<bool> _hydrateTranscript(
    String brokerProfileId,
    int attempt,
  ) async {
    if (!_isCurrentBootstrapAttempt(attempt) || state.events.isNotEmpty) {
      return state.bootstrapState.hasCachedMessages ||
          state.messageEvents.isNotEmpty;
    }
    try {
      final snapshot = await ref
          .read(sessionTranscriptRepositoryProvider)
          .load(brokerProfileId: brokerProfileId, sessionKey: arg);
      if (snapshot == null || _brokerScopeKey != brokerProfileId) {
        return false;
      }
      if (!_isCurrentBootstrapAttempt(attempt)) {
        return false;
      }
      _transcriptScopeKey = brokerProfileId;
      _transcriptCacheTailMessages = List<AgentMessage>.unmodifiable(
        snapshot.messages,
      );
      _transcriptCacheTailOlderCursor = snapshot.olderCursor;
      _transcriptCacheTailHasEarlier =
          snapshot.hasEarlier && snapshot.olderCursor != null;
      final history = HistoryWireEvent(
        messages: snapshot.messages,
        reset: true,
        cursor: snapshot.cursor,
        olderCursor: snapshot.olderCursor,
        hasEarlier: snapshot.hasEarlier,
        gap: snapshot.gap,
        truncated: snapshot.truncation,
      );
      state = state.copyWith(
        events: appendSessionDetailEventLog(const [], history),
        transcriptWindow: TranscriptHistoryWindow.fromHistory(history),
        // Hydrating the durable snapshot replaces the transcript just like a
        // broker replay does; keep the local replacement generation in step.
        transcriptResetGeneration: state.transcriptResetGeneration + 1,
        historyStartReached:
            !snapshot.hasEarlier && snapshot.truncation == null,
      );
      return snapshot.messages.isNotEmpty;
    } on Object {
      // A corrupt/unavailable cache must never block a fresh broker attach.
      return false;
    }
  }

  void _advanceBootstrapStateForHistoryEvent(
    WireEvent event,
    int attempt,
  ) {
    final bootstrapState = state.bootstrapState;
    final acceptsInitialHistory =
        bootstrapState.readiness ==
            SessionDetailBootstrapReadiness.attachingSocket ||
        bootstrapState.isWaitingForInitialHistory;
    if (attempt != bootstrapState.attempt ||
        !acceptsInitialHistory ||
        event is! HistoryWireEvent ||
        !_isCurrentBootstrapAttempt(attempt)) {
      return;
    }

    _cancelInitialHistoryTimeout();
    final hasVisibleMessages = event.reset
        ? event.messages.isNotEmpty
        : bootstrapState.hasCachedMessages ||
              state.messageEvents.isNotEmpty ||
              event.messages.isNotEmpty;
    state = state.copyWith(
      bootstrapState: bootstrapState.ready(
        attempt: attempt,
        hasCachedMessages: hasVisibleMessages,
      ),
      clearError: true,
    );
  }

  void _startInitialHistoryTimeout(int attempt) {
    _initialHistoryTimeout?.cancel();
    final timeout = ref.read(sessionDetailInitialHistoryTimeoutProvider);
    _initialHistoryTimeout = Timer(
      timeout,
      () => _onInitialHistoryTimeout(attempt),
    );
  }

  void _cancelInitialHistoryTimeout() {
    _initialHistoryTimeout?.cancel();
    _initialHistoryTimeout = null;
  }

  void _onInitialHistoryTimeout(int attempt) {
    final bootstrapState = state.bootstrapState;
    if (attempt != bootstrapState.attempt ||
        bootstrapState.readiness !=
            SessionDetailBootstrapReadiness.awaitingInitialHistory ||
        !_isCurrentBootstrapAttempt(attempt)) {
      return;
    }

    state = state.copyWith(
      connectionStatus: SessionDetailConnectionStatus.closed,
      bootstrapState: bootstrapState.failure(
        attempt: attempt,
        kind: FailureKind.offline,
        source: SessionDetailBootstrapFailureSource.historyTimeout,
        hasCachedMessages: bootstrapState.hasCachedMessages,
        timeout: true,
      ),
      // The attach/history deadline is also the bound on the temporary
      // Restoring Drive claim. Keep provenance for retry, but never leave a
      // disconnected page claiming that arbitration is still in flight.
      driveRestorePhase: SessionDriveRestorePhase.idle,
    );
    _requestedDriveReason = null;
    _liveAttachArmed = false;
    _cancelInitialHistoryTimeout();
    _abortBootstrapActionRefresh(attempt: attempt);
    final connection = _connection;
    if (connection != null) {
      connection.disarmDriveAuthority();
      _abandonBootstrapConnection(connection, attempt);
    }
  }

  void _abandonBootstrapConnection(
    SessionDetailConnection connection,
    int attempt,
  ) {
    if (attempt != _bootstrapAttempt || !identical(_connection, connection)) {
      return;
    }
    final stateSub = _stateSub;
    final eventSub = _eventSub;
    _stateSub = null;
    _eventSub = null;
    _connection = null;
    _establishedAttachIntent = null;
    // The abandoned socket's hello no longer describes anything: the next
    // handshake has to negotiate the draft capability from scratch.
    _forgetNegotiatedContract();
    unawaited(
      _disposeAbandonedBootstrapConnection(
        connection,
        stateSub,
        eventSub,
      ),
    );
  }

  Future<void> _disposeAbandonedBootstrapConnection(
    SessionDetailConnection connection,
    StreamSubscription<SessionDetailConnectionStatus>? stateSub,
    StreamSubscription<WireEvent>? eventSub,
  ) async {
    try {
      await stateSub?.cancel();
      await eventSub?.cancel();
      await connection.dispose();
    } on Object {
      // Cleanup must not replace the modeled timeout/failure state.
    }
  }

  void _stopBootstrapForManualDisconnect() {
    _cancelInitialHistoryTimeout();
    _abortBootstrapActionRefresh();
    _bootstrapAttempt++;
    state = state.copyWith(
      bootstrapState: SessionDetailBootstrapState(
        hasCachedMessages:
            state.bootstrapState.hasCachedMessages ||
            state.messageEvents.isNotEmpty,
      ),
    );
  }
}

final class _TransportAttachCancellation {
  final Completer<void> _requested = Completer<void>();
  final Completer<void> _completed = Completer<void>();

  void request() {
    if (!_requested.isCompleted) _requested.complete();
  }

  void complete() {
    if (!_completed.isCompleted) _completed.complete();
  }

  Future<void> settle(Future<void> body) async {
    final bodyOutcome = body.then<_TransportAttachOutcome>(
      (_) => const _TransportAttachOutcome.body(),
      onError: _TransportAttachOutcome.error,
    );
    final first = await Future.any<_TransportAttachOutcome>([
      bodyOutcome,
      _requested.future.then(
        (_) => const _TransportAttachOutcome.cancellation(),
      ),
    ]);
    if (first.cancelled || _requested.isCompleted) {
      await _completed.future;
      return;
    }
    if (first.error case final error?) {
      Error.throwWithStackTrace(error, first.stackTrace!);
    }
  }
}

final class _TransportAttachOutcome {
  const _TransportAttachOutcome.body()
    : cancelled = false,
      error = null,
      stackTrace = null;

  const _TransportAttachOutcome.cancellation()
    : cancelled = true,
      error = null,
      stackTrace = null;

  const _TransportAttachOutcome.error(this.error, this.stackTrace)
    : cancelled = false;

  final bool cancelled;
  final Object? error;
  final StackTrace? stackTrace;
}
