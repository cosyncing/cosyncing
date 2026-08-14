// Facade forwarding methods preserve the existing documented controller API.
// ignore_for_file: public_member_api_docs

import 'dart:async';
import 'dart:developer' as developer;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_identity_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/created_session_attach_intents.dart';
import 'package:cosyncing_client/src/features/sessions/data/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_transfer.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_transfer_worker.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_attachment_picker.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_cache_write_fence.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_control_view.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_bootstrap_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_connection.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_draft_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_drive_intent_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_local_maintenance.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_outbox.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_status_registry.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_transcript_store.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_command_args_codec.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

part 'session_detail_artifact_coordinator.dart';
part 'session_detail_draft_coordinator.dart';
part 'session_detail_messaging_coordinator.dart';
part 'session_detail_provider.dart';
part 'session_detail_bootstrap.dart';
part 'session_detail_request_coordinator.dart';
part 'session_detail_session_action_coordinator.dart';
part 'session_detail_state_helpers.dart';
part 'session_detail_transcript_persistence.dart';

/// How long an explicit takeover waits for the broker's authoritative answer
/// before it is declared unconfirmed. Overridden in tests so timeout proofs
/// stay fast and deterministic.
final sessionTakeoverConfirmTimeoutProvider = Provider<Duration>(
  (ref) => const Duration(seconds: 10),
);

/// Authority allowed during a Session Detail attach.
enum SessionDetailAttachIntent {
  /// Establish live synchronization only; never restore or acquire Drive.
  backgroundObserve,

  /// Selected-page attach, including locally authorized Drive restoration.
  interactive,
}

SessionInfo _admitSessionOwnerProjection(
  SessionInfo? previous,
  SessionInfo incoming,
) {
  final held = previous?.sessionOwner;
  final next = incoming.sessionOwner;
  if (held == null) return incoming;
  if (next != null &&
      (held.revision.epoch != next.revision.epoch ||
          next.revision.seq >= held.revision.seq)) {
    return incoming;
  }
  return SessionInfo.fromJson({
    ...incoming.toJson(),
    'sessionOwner': held.toJson(),
  });
}

bool _joinMatchesOwner(
  SessionJoinExistingAction? action,
  SessionOwnerProjection? owner,
) =>
    action != null &&
    owner != null &&
    action.ownerRevision.epoch == owner.revision.epoch &&
    action.ownerRevision.seq == owner.revision.seq;

/// Controller for one live session detail shell.
///
/// Owns the [SessionDetailConnection] lifecycle and exposes only typed
/// app state to screens.
///
/// References:
/// - `docs/protocol/contract-sync.md`
class SessionDetailController
    extends AutoDisposeFamilyNotifier<SessionDetailState, SessionDetailKey> {
  SessionDetailConnection? _connection;
  StreamSubscription<SessionDetailConnectionStatus>? _stateSub;
  StreamSubscription<WireEvent>? _eventSub;
  var _clientMessageCounter = 0;
  var _attachmentCounter = 0;
  var _replayingOutbox = false;
  String? _attachmentPromptClientMessageId;
  Completer<bool>? _attachmentPromptResult;

  /// The drive-attach reason of the in-flight/last resume request (`create`,
  /// `app-restore`, `lease-restore`, `join-existing`, or `takeover`); null when
  /// no Drive was requested. Settled by the broker's arbitration answer.
  String? _requestedDriveReason;
  String? _lastJoinExistingRevision;
  Completer<bool>? _takeoverResult;
  Completer<bool>? _handoffResult;
  String? _handoffClientMessageId;

  /// The exact broker — (profile, endpoint) — this connection was established
  /// against, and the ONE provenance this controller holds.
  ///
  /// A profile id alone is not the identity of a broker: editing a profile's
  /// endpoint keeps the id and changes the machine. Deriving or comparing by id
  /// therefore attributed the OLD endpoint's frames to the NEW one, reused the
  /// old machine's in-flight attach, and let its content stay on screen. Every
  /// admission, async guard, and publish in this controller compares THIS
  /// value; nothing re-derives a source when a frame lands (R0b).
  RosterSource? _connectionSource;

  /// [RosterSource.storageKey] of [_connectionSource] — the value every
  /// broker-bound local store call in this controller is scoped by.
  ///
  /// Broker-bound rows (transcript cache, drafts, Drive provenance, outbox,
  /// negotiated hello) record what ONE broker said or what the app may do to
  /// one. Keying them by profile id let an endpoint edit carry the previous
  /// machine's content and authority into the new one; keying by the full
  /// source makes every such row unreadable — fail closed — the moment the
  /// profile points elsewhere.
  String? get _brokerScopeKey => _connectionSource?.storageKey;
  String? _transcriptScopeKey;
  Timer? _commandProgressTimer;
  String? _historyPageRequestId;
  String? _historyPageCursorInFlight;
  String? _historyViewportAnchorKey;
  String? _interruptClientMessageId;
  var _interruptTurnGeneration = 0;
  Timer? _historyPageTimeout;
  Timer? _initialHistoryTimeout;
  var _bootstrapAttempt = 0;
  var _retryEventSequence = 0;
  var _disposed = false;
  Completer<void>? _bootstrapActionAbort;
  Future<void> _attachQueue = Future<void>.value();
  Future<void>? _attachInFlight;
  RosterSource? _attachInFlightSource;
  SessionDetailAttachIntent? _attachInFlightIntent;
  SessionDetailAttachIntent? _establishedAttachIntent;
  final Set<_TransportAttachCancellation> _transportAttachCancellations = {};
  late SessionCacheWriteFence _cacheWriteFence;
  SessionTranscriptSnapshot? _pendingTranscriptSnapshot;
  SessionCacheWriteAdmission? _pendingTranscriptAdmission;
  List<AgentMessage> _transcriptCacheTailMessages = const [];
  String? _transcriptCacheTailOlderCursor;
  bool _transcriptCacheTailHasEarlier = false;
  final List<_PendingAttachTicket> _pendingTranscriptTickets =
      <_PendingAttachTicket>[];
  var _transcriptCommitInFlight = false;

  // ── DR1 durable draft state ──────────────────────────────────────────────
  /// Cached device-local draft row for [_loadedDraftScopeKey].
  SessionLocalDraft? _localDraft;

  /// Profile the cached draft row belongs to; null until first load.
  String? _loadedDraftScopeKey;

  /// One exact-session Drift watch while this controller is mounted.
  ///
  /// It is replaced on a source switch and canceled on auto-dispose; closed
  /// sessions retain no controller or database subscription.
  StreamSubscription<SessionLocalDraft?>? _localDraftSubscription;
  String? _observedDraftScopeKey;

  /// Recently accepted row versions written by this controller.
  ///
  /// Drift may deliver an earlier write after a later controller mutation has
  /// already replaced the cache (notably bind-then-delete during Send). These
  /// versions let the observer discard that delayed self-echo instead of
  /// preserving it as another window's competing text.
  final Set<int> _ownedDraftMutationVersions = <int>{};

  /// Accepted deletes whose null Drift emission has not been consumed yet.
  var _ownedDraftDeletesAwaitingObservation = 0;

  /// Current composer value staged synchronously by the mounted page.
  ///
  /// This closes the 300 ms debounce window: an accepted write from another
  /// window can be compared with text already typed here before this window's
  /// durable write starts. Competing values become an explicit conflict rather
  /// than one replacing the other.
  String? _stagedLocalDraftText;

  /// The versioned draft publish awaiting its broker acknowledgement, if any.
  /// Convergence is driven by that answer, never by the socket write.
  _PendingDraftPublish? _pendingDraftPublish;

  /// Fires when a publish goes unacknowledged, so the dirty row retries instead
  /// of waiting for another keystroke.
  Timer? _draftPublishAckTimer;

  /// Bounded retries spent on one unchanged unacknowledged value.
  var _draftPublishRetries = 0;

  /// Update tokens this device published recently, oldest first.
  ///
  /// A publish slot is released without un-sending its frame, so the broker can
  /// still echo it. This keeps such a late echo recognizable as our own rather
  /// than another device's draft.
  final _recentDraftPublishIds = <String>{};

  /// Monotone token for controller-decided composer content.
  var _draftSurfaceToken = 0;

  /// Surface tokens whose text was NON-EMPTY, bounded to the recent tail.
  ///
  /// Confirming a surface is what tells this controller the composer holds the
  /// session's content — but an empty surface confirms the opposite, and the
  /// page confirms it too, because empty already matches an empty composer.
  /// Only a token in here may grant the authority to clear a durable row.
  final _nonEmptySurfaceTokens = <int, int>{};

  /// Whether the local durable value was already surfaced this controller
  /// lifetime (hydration surfaces at most once per profile).
  var _draftHydrated = false;

  /// Monotone identity of the composer currently attached to this controller.
  ///
  /// The controller is resident (OS1) but composers are not: they are built
  /// and destroyed by routing. Authority that outlives the composer which
  /// earned it is authority the NEXT composer never had, so every mounting
  /// composer announces itself and takes a new generation.
  var _composerGeneration = 0;

  /// The composer generation that demonstrably held this session's draft
  /// content (DR1b): its user typed into it, or an offered surface was
  /// confirmed applied. An empty composer of any OTHER generation is an
  /// unhydrated one, and clearing a non-empty durable row on its say-so
  /// destroys text nobody was ever shown.
  int? _composerHeldContentGeneration;

  /// Whether a composer announced itself during this attach, which decides how
  /// strongly connected hydration may claim the composer (DR1b).
  var _composerAnnouncedThisAttach = false;

  /// Guards the legacy (unversioned, unacknowledged) relay against re-entry.
  var _draftPublishInFlight = false;

  /// Set while a send is capturing and binding the draft it carries, so no new
  /// publish can move the shared record under a token the prompt cannot report.
  var _draftHandoffInFlight = false;

  /// Bumped whenever the cached draft row stops belonging to the controller's
  /// current profile, so an in-flight mutation that resolves afterwards cannot
  /// reinstall a row from the profile that was switched away from.
  var _draftCacheGeneration = 0;

  /// Tail of the serialized draft-mutation chain.
  ///
  /// Every read-modify-write of the durable draft row runs through it, because
  /// the cached row is only replaced once its database write completes: two
  /// overlapping mutations would otherwise both read the pre-write row and the
  /// later write would silently discard the earlier one.
  Future<void> _draftMutations = Future<void>.value();

  /// A recovered-prompt removal deferred until the page confirms it applied
  /// the surface carrying the text — identified by that exact surface token.
  ///
  /// The failed outbox row is the ONLY durable copy of an oversized prompt,
  /// and the page applies surfaces in a post-frame callback: deleting the row
  /// when the surface is merely emitted races an unmount or crash into losing
  /// the text before the composer ever showed it.
  ({int token, String clientMessageId})? _pendingRecoveredPromptRemoval;

  /// Last local edit time for the live-typing race guard (never used for
  /// cross-device ordering — that is what broker revisions are for).
  DateTime? _lastLocalDraftEditAt;

  /// Broker contract revision captured from the hello frame (the compacted
  /// event log can drop hello in long sessions, so capability must not be
  /// re-derived from the projection).
  int? _brokerContractRevision;

  @override
  SessionDetailState build(SessionDetailKey arg) {
    _cacheWriteFence = ref.read(sessionCacheWriteFenceProvider);
    ref.onDispose(() {
      _disposed = true;
      _cacheWriteFence.release(_pendingTranscriptAdmission);
      _pendingTranscriptAdmission = null;
      final transportCancellations = _requestTransportAttachCancellation();
      _abortBootstrapActionRefresh();
      _commandProgressTimer?.cancel();
      _historyPageTimeout?.cancel();
      _initialHistoryTimeout?.cancel();
      _draftPublishAckTimer?.cancel();
      if (!(_attachmentPromptResult?.isCompleted ?? true)) {
        _attachmentPromptResult?.complete(false);
      }
      unawaited(_localDraftSubscription?.cancel());
      _completeTakeover(false);
      _completeHandoff(false);
      unawaited(_stateSub?.cancel());
      unawaited(_eventSub?.cancel());
      final connection = _connection;
      if (connection != null) {
        unawaited(
          connection.dispose().whenComplete(
            () => _completeTransportAttachCancellation(
              transportCancellations,
            ),
          ),
        );
      } else {
        _completeTransportAttachCancellation(transportCancellations);
      }
    });

    return SessionDetailState(
      tool: arg.tool,
      sessionId: arg.sessionId,
    );
  }

  /// Attaches to the session stream, creating the connection if needed.
  ///
  /// Admission is keyed on the requested broker — (profile, endpoint) — so an
  /// endpoint edit that keeps the profile id starts a NEW attach instead of
  /// being coalesced onto the one still connecting to the retired machine.
  Future<void> attach({
    SessionDetailAttachIntent intent = SessionDetailAttachIntent.interactive,
    bool force = false,
  }) {
    final requestedSource = RosterSource.of(
      ref.read(activeBrokerProfileProvider),
    );
    final establishedIntent = _establishedAttachIntent;
    final connection = _connection;
    if (!force &&
        requestedSource != null &&
        requestedSource == _connectionSource &&
        connection != null &&
        connection.state != SessionDetailConnectionStatus.closed &&
        establishedIntent != null &&
        establishedIntent.index >= intent.index &&
        !state.bootstrapState.hasFailed) {
      return Future<void>.value();
    }
    final inFlight = _attachInFlight;
    final inFlightIntent = _attachInFlightIntent;
    final supersedes =
        inFlight != null &&
        (_attachInFlightSource != requestedSource ||
            (inFlightIntent != null && inFlightIntent.index < intent.index));
    if (supersedes) {
      _abortBootstrapActionRefresh();
    }
    if (inFlight != null && !supersedes && !state.bootstrapState.hasFailed) {
      return inFlight;
    }
    // A cross-source attach SUPERSEDES the in-flight lane instead of queuing
    // behind it. The queue serializes retries against one broker; an endpoint
    // edit is a different broker, and its attach must never wait on a socket
    // to the retired machine that may simply never answer. Starting the new
    // body bumps the bootstrap attempt synchronously, so every step of the
    // superseded body retires at its next guard instead of finishing.
    final canPromoteObserve =
        !force &&
        intent == SessionDetailAttachIntent.interactive &&
        requestedSource != null &&
        requestedSource == _connectionSource &&
        connection != null &&
        connection.state != SessionDetailConnectionStatus.closed &&
        establishedIntent == SessionDetailAttachIntent.backgroundObserve &&
        !state.bootstrapState.hasFailed;
    final operationBody = canPromoteObserve
        ? () => _promoteObserveConnection(requestedSource, connection)
        : () => _attachOnce(intent);
    final operation = supersedes
        ? operationBody()
        : _attachQueue.then((_) => operationBody());
    _attachInFlight = operation;
    _attachInFlightSource = requestedSource;
    _attachInFlightIntent = intent;
    unawaited(
      operation.then<void>(
        (_) => _clearAttachInFlight(operation),
        onError: (Object _, StackTrace _) => _clearAttachInFlight(operation),
      ),
    );
    _attachQueue = operation.catchError((Object _) {});
    return operation;
  }

  /// Promotes a resident background Observe attach when one owns this lane.
  ///
  /// A generic interactive attach is intentionally not used by connection
  /// status listeners: an explicit handoff also reconnects in Observe, and
  /// must not be mistaken for supervisor bootstrap. Intent is checked here,
  /// beside the source-aware attach admission state that owns it.
  Future<void> promoteBackgroundObserveToInteractive() {
    if (_attachInFlightIntent != SessionDetailAttachIntent.backgroundObserve &&
        _establishedAttachIntent !=
            SessionDetailAttachIntent.backgroundObserve) {
      return Future<void>.value();
    }
    return attach();
  }

  /// Recreates this session's transport after the active profile's
  /// credential changes without changing the broker source or draft scope.
  ///
  /// A connection captures its endpoint resolver when it is created. Saving
  /// a first token (or replacing/revoking one) rebuilds [brokerClientProvider],
  /// but an already-mounted Session Detail otherwise keeps reconnecting with
  /// the resolver that preceded that credential mutation. Supersede that
  /// same-source attach and create a fresh connection from the current client.
  Future<void> rebindBrokerClient() {
    final source = RosterSource.of(ref.read(activeBrokerProfileProvider));
    if (source == null || _disposed) return Future<void>.value();
    final intent =
        _establishedAttachIntent ??
        _attachInFlightIntent ??
        SessionDetailAttachIntent.interactive;

    _abortBootstrapActionRefresh();
    _bootstrapAttempt++;
    _attachInFlight = null;
    _attachInFlightSource = null;
    _attachInFlightIntent = null;
    _attachQueue = Future<void>.value();

    final operation = () async {
      await _resetConnectionForProfileSwitch();
      if (_disposed ||
          RosterSource.of(ref.read(activeBrokerProfileProvider)) != source) {
        return;
      }
      await _attachOnce(intent);
    }();
    _attachInFlight = operation;
    _attachInFlightSource = source;
    _attachInFlightIntent = intent;
    unawaited(
      operation.then<void>(
        (_) => _clearAttachInFlight(operation),
        onError: (Object _, StackTrace _) => _clearAttachInFlight(operation),
      ),
    );
    _attachQueue = operation.catchError((Object _) {});
    return operation;
  }

  void _clearAttachInFlight(Future<void> operation) {
    if (!identical(_attachInFlight, operation)) return;
    _attachInFlight = null;
    _attachInFlightSource = null;
    _attachInFlightIntent = null;
  }

  /// Stops background transport work without evicting bounded controller state.
  ///
  /// Browser lifecycle suspension uses this instead of releasing the provider
  /// lease. H1 pages, the semantic anchor, status, tool/question projection,
  /// and the window-local viewport record therefore remain resident while the
  /// socket and reconnect machinery are fully stopped.
  Future<void> suspendTransport() async {
    final cancellations = _requestTransportAttachCancellation();
    _cancelInitialHistoryTimeout();
    _abortBootstrapActionRefresh();
    _bootstrapAttempt++;
    _clearHistoryPageTracking();
    _requestedDriveReason = null;
    _establishedAttachIntent = null;
    _lastJoinExistingRevision = null;

    final previousStateSub = _stateSub;
    final previousEventSub = _eventSub;
    _stateSub = null;
    _eventSub = null;
    unawaited(previousStateSub?.cancel());
    unawaited(previousEventSub?.cancel());

    try {
      final connection = _connection;
      if (connection != null) {
        try {
          await connection.close();
        } on Object {
          // A failed graceful close cannot release the admission barrier. Fall
          // back to terminal disposal before declaring transport suspension.
          await connection.dispose();
          if (identical(_connection, connection)) _connection = null;
        }
      }
      if (!_disposed) {
        state = state.copyWith(
          connectionStatus: SessionDetailConnectionStatus.closed,
          bootstrapState: SessionDetailBootstrapState(
            hasCachedMessages:
                state.bootstrapState.hasCachedMessages ||
                state.messageEvents.isNotEmpty,
          ),
          historyPageLoading: false,
          driveRestorePhase: SessionDriveRestorePhase.idle,
          clearTransientRetryStatus: true,
        );
      }
    } finally {
      // Admission is released only after close has returned. A supervisor can
      // never replace a merely retired counter with two fresh cold attaches
      // while the retired socket attempt is still being cancelled.
      _completeTransportAttachCancellation(cancellations);
    }
  }

  Set<_TransportAttachCancellation> _requestTransportAttachCancellation() {
    final cancellations = Set<_TransportAttachCancellation>.of(
      _transportAttachCancellations,
    );
    for (final cancellation in cancellations) {
      cancellation.request();
    }
    return cancellations;
  }

  void _completeTransportAttachCancellation(
    Set<_TransportAttachCancellation> cancellations,
  ) {
    for (final cancellation in cancellations) {
      cancellation.complete();
    }
  }

  Future<void> _promoteObserveConnection(
    RosterSource source,
    SessionDetailConnection connection,
  ) async {
    final driveReason = await _interactiveDriveReason(source);
    if (_disposed ||
        _connectionSource != source ||
        !identical(_connection, connection)) {
      return;
    }
    if (driveReason == null) {
      // Visibility alone grants interaction with the already-open Observe
      // stream. It does not change broker authority and therefore needs no
      // socket reset, history bootstrap, or replay.
      _establishedAttachIntent = SessionDetailAttachIntent.interactive;
      final joinExisting = state.joinExisting;
      if (joinExisting != null) {
        await _joinExistingDriver(joinExisting);
      }
      return;
    }

    _requestedDriveReason = driveReason;
    state = state.copyWith(
      driveRestorePhase: SessionDriveRestorePhase.restoring,
      clearDriveRestoreConflict: true,
      clearError: true,
    );
    try {
      await _retireRetryableOutboxForControlChange();
      if (_disposed ||
          _connectionSource != source ||
          !identical(_connection, connection)) {
        return;
      }
      await connection.reattach(mode: 'resume', reason: driveReason);
      if (_disposed ||
          _connectionSource != source ||
          !identical(_connection, connection)) {
        return;
      }
      _establishedAttachIntent = SessionDetailAttachIntent.interactive;
      state = state.copyWith(connectionStatus: connection.state);
    } on Object catch (error) {
      if (_connectionSource != source || !identical(_connection, connection)) {
        return;
      }
      _requestedDriveReason = null;
      state = state.copyWith(
        connectionStatus: connection.state,
        driveRestorePhase: SessionDriveRestorePhase.idle,
        error: userFacingMessage(
          error,
          lead: "Couldn't restore control of this session.",
        ),
      );
    }
  }

  Future<String?> _interactiveDriveReason(RosterSource source) async =>
      ref
          .read(createdSessionAttachIntentsProvider)
          .takeResume(source.storageKey, arg)
      ? kDriveAttachReasonCreate
      : _driveRestoreReason(source.storageKey);

  Future<void> _joinExistingDriver(
    SessionJoinExistingAction action,
  ) async {
    final intent = _attachInFlightIntent ?? _establishedAttachIntent;
    final connection = _connection;
    final revision = action.ownerRevision;
    final revisionKey = '${revision.epoch}:${revision.seq}';
    if (_disposed ||
        intent != SessionDetailAttachIntent.interactive ||
        connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected ||
        state.compatibilityReadOnly ||
        (state.connectionAuthority?.canMutate ?? false) ||
        _lastJoinExistingRevision == revisionKey) {
      return;
    }
    _lastJoinExistingRevision = revisionKey;
    _requestedDriveReason = kDriveAttachReasonJoinExisting;
    state = state.copyWith(
      driveRestorePhase: SessionDriveRestorePhase.restoring,
      clearDriveRestoreConflict: true,
      clearError: true,
    );
    try {
      // Retryable mutations were authored under an earlier socket/owner
      // generation. They carry no owner revision, so replaying them after a
      // join could send an old prompt into another client's current driver.
      await _retireRetryableOutboxForControlChange();
      if (_disposed ||
          !identical(_connection, connection) ||
          (_attachInFlightIntent ?? _establishedAttachIntent) !=
              SessionDetailAttachIntent.interactive) {
        return;
      }
      await connection.reattach(
        mode: 'resume',
        reason: kDriveAttachReasonJoinExisting,
        ownerRevision: revision,
      );
      if (_disposed || !identical(_connection, connection)) return;
      state = state.copyWith(connectionStatus: connection.state);
    } on Object catch (error) {
      if (!identical(_connection, connection)) return;
      _requestedDriveReason = null;
      connection.disarmDriveAuthority();
      state = state.copyWith(
        connectionStatus: connection.state,
        driveRestorePhase: SessionDriveRestorePhase.idle,
        error: userFacingMessage(
          error,
          lead: "Couldn't restore control of this session.",
        ),
      );
    }
  }

  Future<void> _resetConnectionForProfileSwitch() async {
    // Fields are taken and cleared BEFORE any await for the same reason as in
    // `_listen`: a superseding attach may interleave with a superseded body,
    // and this teardown must only ever touch what it captured.
    final previousStateSub = _stateSub;
    final previousEventSub = _eventSub;
    final previousConnection = _connection;
    _stateSub = null;
    _eventSub = null;
    _connection = null;
    _establishedAttachIntent = null;
    _lastJoinExistingRevision = null;
    // Cancels are fire-and-forget. Removing a broadcast listener takes effect
    // synchronously; the returned future is only the RETIRED subscription's
    // teardown ceremony, and nothing owned by the retired broker may delay
    // the superseding attach.
    unawaited(previousStateSub?.cancel());
    unawaited(previousEventSub?.cancel());
    _cancelInitialHistoryTimeout();
    _forgetNegotiatedContract();
    _clearHistoryPageTracking();
    _requestedDriveReason = null;
    if (previousConnection != null) {
      // Fire-and-forget on purpose. This teardown belongs to the RETIRED
      // broker — often a machine that stopped answering — and a dead socket
      // can hold its dispose future open indefinitely. The subscriptions are
      // already cancelled, so nothing it still emits can land; the one thing
      // that must not happen is the NEW broker's attach waiting on it.
      unawaited(_disposeRetiredConnection(previousConnection));
    }
  }

  Future<void> _disposeRetiredConnection(
    SessionDetailConnection connection,
  ) async {
    try {
      await connection.dispose();
    } on Object {
      // A retired socket failing its own teardown changes nothing the new
      // broker sees.
    }
  }

  /// The restore reason authorized by local provenance, or `null`.
  ///
  /// Local facts only: the ownership decision itself moved into the broker's
  /// atomic reason-tagged attach, so reopening never fetches a roster or
  /// transcript to decide. An app-created preference authorizes `app-restore`
  /// at any later time; a terminal-takeover lease authorizes `lease-restore`
  /// only while fresh.
  Future<String?> _driveRestoreReason(String brokerProfileId) async {
    try {
      final provenance = await ref
          .read(sessionDriveIntentStoreProvider)
          .read(
            brokerProfileId: brokerProfileId,
            tool: arg.tool,
            sessionId: arg.sessionId,
          );
      return switch (provenance?.kind) {
        SessionDriveProvenanceKind.appCreated => kDriveAttachReasonAppRestore,
        SessionDriveProvenanceKind.terminalTakeover =>
          kDriveAttachReasonLeaseRestore,
        null => null,
      };
    } on Object {
      // Storage is an optimization, never authority. Fail safe to a bare
      // attach when persistence is unavailable or unreadable; the record (if
      // any) is preserved for a later attach.
      return null;
    }
  }

  Future<void> _refreshAgentActions({
    required Future<List<AgentInfo>> Function() loadAgents,
    required int bootstrapAttempt,
    required RosterSource source,
    required Future<void> abort,
  }) async {
    try {
      final agents = await Future.any<List<AgentInfo>?>([
        loadAgents(),
        abort.then<List<AgentInfo>?>((_) => null),
      ]);
      if (agents == null) return;
      if (!_canApplyAgentActions(bootstrapAttempt, source)) return;
      for (final agent in agents) {
        if (agent.id == arg.tool) {
          state = state.copyWith(
            agentActions: SessionAgentActions.fromAgentInfo(agent),
            clearError: true,
          );
          return;
        }
      }
      state = state.copyWith(agentActions: _unavailableAgentActions);
    } on Object {
      if (!_canApplyAgentActions(bootstrapAttempt, source)) return;
      state = state.copyWith(agentActions: _unavailableAgentActions);
    }
  }

  bool _canApplyAgentActions(int attempt, RosterSource source) =>
      !_disposed &&
      _isCurrentBootstrapAttempt(attempt) &&
      RosterSource.of(ref.read(activeBrokerProfileProvider)) == source &&
      !state.bootstrapState.hasFailed;

  void _abortBootstrapActionRefresh({int? attempt}) {
    if (attempt != null && attempt != _bootstrapAttempt) return;
    final abort = _bootstrapActionAbort;
    if (abort != null && !abort.isCompleted) abort.complete();
  }

  /// Closes the live session stream.
  ///
  /// This is the explicit Detach/Stop-driving action, so it clears the
  /// session's Drive provenance (unlike route disposal or a dropped socket,
  /// which preserve it).
  Future<void> disconnect() async {
    _stopBootstrapForManualDisconnect();
    _requestedDriveReason = null;
    _establishedAttachIntent = null;
    _lastJoinExistingRevision = null;
    await _clearDriveIntentBestEffort();
    final connection = _connection;
    if (connection == null) {
      state = state.copyWith(
        connectionStatus: SessionDetailConnectionStatus.closed,
        driveRestorePhase: SessionDriveRestorePhase.idle,
        clearDriveRestoreConflict: true,
      );
      return;
    }

    await connection.close();
    state = state.copyWith(
      connectionStatus: SessionDetailConnectionStatus.closed,
      driveRestorePhase: SessionDriveRestorePhase.idle,
      clearDriveRestoreConflict: true,
    );
  }

  /// Takes over the session from the terminal: re-attaches in `resume` (Drive)
  /// mode so the app becomes the mutating owner. When a live terminal owns the
  /// session the broker continues it single-owner-safe in a fork (Claude
  /// `willFork`); the caller must show the confirm first. No-op when detached.
  Future<bool> takeOver() async {
    final connection = _connection;
    final control = SessionControlView.fromSessionDetailState(state);
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      state = state.copyWith(
        error: 'Reconnect before taking over this session.',
      );
      return false;
    }
    if (!control.canTakeOver) {
      state = state.copyWith(
        error: 'Session control changed; review its current status first.',
      );
      return false;
    }
    // The explicit user action supersedes any earlier restore-denial note;
    // this attempt's own outcome sets fresh conflict state if it fails too.
    state = state.copyWith(
      clearError: true,
      driveRestorePhase:
          state.driveRestorePhase == SessionDriveRestorePhase.conflict
          ? SessionDriveRestorePhase.idle
          : state.driveRestorePhase,
      clearDriveRestoreConflict: true,
    );
    try {
      await _retireRetryableOutboxForControlChange();
      _requestedDriveReason = kDriveAttachReasonTakeover;
      final result = Completer<bool>();
      _takeoverResult = result;
      await connection.reattach(
        mode: 'resume',
        reason: kDriveAttachReasonTakeover,
      );
      if (connection.state != SessionDetailConnectionStatus.connected) {
        // A transient reconnect failure is not an explicit user exit; existing
        // provenance (if any) is preserved and no new lease is written. The
        // transport still holds the one-shot takeover request, and a later
        // automatic reconnect must not silently retry it.
        _requestedDriveReason = null;
        connection.disarmDriveAuthority();
        _completeTakeover(false);
        state = state.copyWith(error: 'Take over could not reconnect.');
        return false;
      }
      return await result.future.timeout(
        ref.read(sessionTakeoverConfirmTimeoutProvider),
        onTimeout: () async {
          if (!identical(_takeoverResult, result)) {
            return false;
          }
          _takeoverResult = null;
          _requestedDriveReason = null;
          connection.disarmDriveAuthority();
          // Surface the unconfirmed takeover through the structured
          // conflict channel so the note is localizable and persists until
          // ownership is genuinely restored or a new action supersedes it.
          state = state.copyWith(
            driveRestorePhase: SessionDriveRestorePhase.conflict,
            driveRestoreConflict: const SessionDriveRestoreConflict(
              reason: kDriveAttachReasonTakeover,
              code: 'DRIVE_RESTORE_TIMEOUT',
              message: 'The server did not confirm the takeover in time.',
            ),
          );
          // Disarming alone only shapes the NEXT reconnect; the armed
          // resume socket outlives the timeout, and a slow adapter (Codex
          // resume can legitimately exceed the window) could still deliver a
          // late Driving grant after the user was told the takeover failed —
          // half-applied, because the settled intent would persist no lease.
          // Make the reported outcome definitive: replace the armed socket
          // with a bare Observe attach on the SAME session.
          if (!_disposed &&
              identical(_connection, connection) &&
              state.connectionStatus ==
                  SessionDetailConnectionStatus.connected) {
            try {
              await connection.reattach();
            } on Object {
              // Best-effort: the disarmed transport already guarantees no
              // later automatic reconnect can claim Drive.
            }
          }
          return false;
        },
      );
    } on Object catch (e) {
      _requestedDriveReason = null;
      connection.disarmDriveAuthority();
      _completeTakeover(false);
      state = state.copyWith(
        error: userFacingMessage(e, lead: "Couldn't take over this session."),
      );
      return false;
    }
  }

  /// Hands control back to the terminal when this is the sole foreground
  /// Drive client. The broker refuses while a peer still shares the owner;
  /// on success it migrates this socket to Observe and closes Resume before
  /// publishing confirmation.
  Future<bool> handoffToTerminal() async {
    final connection = _connection;
    final control = SessionControlView.fromSessionDetailState(state);
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      state = state.copyWith(
        error: 'Reconnect before handing control back to the terminal.',
      );
      return false;
    }
    if (control.action != SessionControlAction.handoff) {
      state = state.copyWith(
        error: 'Session control changed; review its current status first.',
      );
      return false;
    }
    // Handing control back is an explicit exit from Drive: any pending
    // restore-denial note is moot from here on.
    state = state.copyWith(
      clearError: true,
      driveRestorePhase: SessionDriveRestorePhase.idle,
      clearDriveRestoreConflict: true,
    );
    try {
      await _retireRetryableOutboxForControlChange();
      _requestedDriveReason = null;
      final result = Completer<bool>();
      _handoffResult = result;
      final clientMessageId = _nextClientMessageId();
      _handoffClientMessageId = clientMessageId;
      await connection.sendHandoff(clientMessageId: clientMessageId);
      if (connection.state != SessionDetailConnectionStatus.connected) {
        _completeHandoff(false);
        state = state.copyWith(error: 'Terminal handoff could not reconnect.');
        return false;
      }
      final confirmed = await result.future.timeout(
        ref.read(sessionTakeoverConfirmTimeoutProvider),
        onTimeout: () {
          if (identical(_handoffResult, result)) {
            _handoffResult = null;
            _handoffClientMessageId = null;
          }
          return false;
        },
      );
      if (!confirmed) {
        state = state.copyWith(
          error: 'The server did not confirm terminal handoff.',
        );
        return false;
      }
      // The WebSocket itself was migrated in place. Disarm its prior Resume
      // query state so a later transport drop reconnects to bare Observe
      // instead of silently recreating Drive after a successful handoff.
      connection.disarmDriveAuthority();
      await _clearDriveIntentBestEffort();
      _establishedAttachIntent = null;
      return true;
    } on Object catch (e) {
      _completeHandoff(false);
      state = state.copyWith(
        error: userFacingMessage(
          e,
          lead: "Couldn't hand control back to the terminal.",
        ),
      );
      return false;
    }
  }

  /// Settles the pending drive-attach request against the broker's
  /// authoritative session frame.
  ///
  /// A confirmed Driving frame persists/refreshes the matching provenance: a
  /// takeover starts (or slides) the bounded lease, an app-created path keeps
  /// its durable preference. A non-driving answer merely ends the attempt —
  /// it never erases provenance, because only explicit Handoff, Observe,
  /// Detach, or End may do that.
  Future<void> _syncDriveIntent(SessionInfo info) async {
    final requestedReason = _requestedDriveReason;
    if (requestedReason == null) {
      return;
    }
    final control = info.control;
    final driving =
        control != null &&
        control.drive.supported &&
        control.drive.state == DriveState.driving;
    _requestedDriveReason = null;
    if (state.driveRestorePhase == SessionDriveRestorePhase.restoring) {
      state = state.copyWith(driveRestorePhase: SessionDriveRestorePhase.idle);
    }
    if (!driving) {
      _completeTakeover(false);
      return;
    }
    _completeTakeover(true);
    state = state.copyWith(
      driveRestorePhase: SessionDriveRestorePhase.idle,
      clearDriveRestoreConflict: true,
    );
    try {
      final brokerProfileId = _brokerScopeKey;
      if (brokerProfileId == null) {
        return;
      }
      final store = ref.read(sessionDriveIntentStoreProvider);
      if (requestedReason == kDriveAttachReasonJoinExisting) {
        // Joining another client's active Drive proves no local creation or
        // takeover provenance. Reconnect remains conditional on that exact
        // broker owner revision instead of creating an unbounded local claim.
        return;
      }
      if (requestedReason == kDriveAttachReasonTakeover ||
          requestedReason == kDriveAttachReasonLeaseRestore) {
        // Successful Drive attach: start or slide the takeover lease. The
        // store keeps a durable app-created record durable.
        await store.rememberTakeover(
          brokerProfileId: brokerProfileId,
          tool: arg.tool,
          sessionId: arg.sessionId,
        );
      } else {
        await store.rememberAppCreated(
          brokerProfileId: brokerProfileId,
          tool: arg.tool,
          sessionId: arg.sessionId,
        );
      }
    } on Object {
      // Persistence never controls transport ownership. The broker-published
      // session state remains authoritative when local storage is unavailable.
    }
  }

  void _completeTakeover(bool succeeded) {
    final result = _takeoverResult;
    _takeoverResult = null;
    if (result != null && !result.isCompleted) {
      result.complete(succeeded);
    }
  }

  void _completeHandoff(bool succeeded) {
    final result = _handoffResult;
    _handoffResult = null;
    _handoffClientMessageId = null;
    if (result != null && !result.isCompleted) {
      result.complete(succeeded);
    }
  }

  /// Slides the terminal-takeover lease after a real app mutation reached the
  /// transport.
  ///
  /// Only an existing takeover lease is refreshed — a session without one
  /// gains none, and the durable app-created preference needs no refresh.
  /// Timers, reconnects, and page views never call this.
  void _refreshDriveLeaseAfterMutation() {
    final brokerProfileId = _brokerScopeKey;
    if (brokerProfileId == null) return;
    unawaited(() async {
      try {
        final store = ref.read(sessionDriveIntentStoreProvider);
        final provenance = await store.read(
          brokerProfileId: brokerProfileId,
          tool: arg.tool,
          sessionId: arg.sessionId,
        );
        if (provenance?.kind == SessionDriveProvenanceKind.terminalTakeover) {
          await store.rememberTakeover(
            brokerProfileId: brokerProfileId,
            tool: arg.tool,
            sessionId: arg.sessionId,
          );
        }
      } on Object {
        // Lease upkeep is best-effort; the mutation itself already succeeded.
      }
    }());
  }

  Future<void> _clearDriveIntent() async {
    final brokerProfileId =
        _brokerScopeKey ??
        RosterSource.of(ref.read(activeBrokerProfileProvider))?.storageKey;
    if (brokerProfileId == null) {
      return;
    }
    await ref
        .read(sessionDriveIntentStoreProvider)
        .clear(
          brokerProfileId: brokerProfileId,
          tool: arg.tool,
          sessionId: arg.sessionId,
        );
  }

  Future<void> _clearDriveIntentBestEffort() async {
    try {
      await _clearDriveIntent();
    } on Object {
      // The ownership transition already failed. Preserve its primary error.
    }
  }

  Future<void> _retireRetryableOutboxForControlChange() async {
    final brokerProfileId = _brokerScopeKey;
    if (brokerProfileId == null) return;
    final repository = ref.read(sessionOutboxRepositoryProvider);
    final messages = await repository.loadRetryableForSession(
      arg,
      brokerProfileId: brokerProfileId,
    );
    for (final message in messages) {
      await repository.markFailed(
        message.clientMessageId,
        'Not replayed across a session ownership change.',
      );
      // A retired send is a permanent failure for exactly this row; without
      // this it would wait forever for an echo that can no longer arrive.
      _removeOptimisticPrompt(message.clientMessageId);
    }
  }

  void _updateTranscriptCacheTail(WireEvent event) {
    if (event is HistoryPageWireEvent) return;
    var next = event is HistoryWireEvent && event.reset
        ? <AgentMessage>[]
        : List<AgentMessage>.of(_transcriptCacheTailMessages);
    final indexByKey = <String, int>{};
    for (var index = 0; index < next.length; index++) {
      final key = stableTranscriptMessageKey(next[index]);
      if (key != null) indexByKey[key] = index;
    }

    void add(AgentMessage message) {
      final key = stableTranscriptMessageKey(message);
      final existingIndex = key == null ? null : indexByKey[key];
      if (existingIndex == null) {
        if (key != null) indexByKey[key] = next.length;
        next.add(message);
      } else {
        next[existingIndex] = mergeStableTranscriptMessage(
          next[existingIndex],
          message,
        );
      }
    }

    switch (event) {
      case HistoryWireEvent(:final messages):
        if (event.reset) {
          for (final message in messages) {
            add(message);
          }
        } else {
          // An incremental frame carries native/source order: recover rows the
          // persisted tail never saw into their authoritative positions and
          // repair any malformed order it previously persisted, instead of
          // appending every unseen key behind the final response.
          next = List<AgentMessage>.of(
            reconcileTranscriptHistoryDelta(retained: next, frame: messages),
          );
        }
        if (event.reset || event.olderCursor != null) {
          _transcriptCacheTailOlderCursor = event.olderCursor;
          _transcriptCacheTailHasEarlier =
              event.hasEarlier && event.olderCursor != null;
        }
      case MessageWireEvent(:final message):
        add(message);
      case _:
        return;
    }

    var retainedBytes = 0;
    final retainedReverse = <AgentMessage>[];
    for (var index = next.length - 1; index >= 0; index--) {
      if (retainedReverse.length >= maxPersistedTranscriptMessages) break;
      final message = next[index];
      final bytes = estimatedAgentMessageDecodedBytes(message);
      if (retainedBytes + bytes > maxPersistedTranscriptSnapshotBytes) {
        continue;
      }
      retainedReverse.add(message);
      retainedBytes += bytes;
    }
    _transcriptCacheTailMessages = List<AgentMessage>.unmodifiable(
      retainedReverse.reversed,
    );
  }

  void _enqueueTranscriptPersistence(WireEvent event) {
    if (event is! HistoryWireEvent && event is! MessageWireEvent) {
      return;
    }
    final brokerProfileId = _brokerScopeKey;
    if (brokerProfileId == null) return;

    // Coalesce persistence: a later snapshot fully supersedes earlier ones for
    // the same session, so keep only the latest pending snapshot rather than a
    // full-transcript serialize + row rewrite for every incoming message.
    _pendingTranscriptSnapshot = SessionTranscriptSnapshot(
      brokerProfileId: brokerProfileId,
      sessionKey: arg,
      messages: _transcriptCacheTailMessages,
      cursor: state.historyCursor,
      olderCursor: _transcriptCacheTailOlderCursor,
      hasEarlier: _transcriptCacheTailHasEarlier,
      gap: state.latestHistoryGap,
      truncation: state.latestHistoryTruncation,
      updatedAt: DateTime.now(),
    );
    _pendingTranscriptAdmission = _replaceTranscriptAdmission(
      brokerProfileId,
    );

    final attachTicket = event is HistoryWireEvent
        ? event.attachTicket?.trim()
        : null;
    if (attachTicket != null && attachTicket.isNotEmpty) {
      final receiptConnection = _connection;
      if (receiptConnection != null) {
        // Remember the connection and broker each ticket arrived on so a
        // coalesced ack is never sent to a different owner after a reattach or
        // broker switch (the broker reissues the ticket on reattach instead).
        _pendingTranscriptTickets.add(
          _PendingAttachTicket(
            ticket: attachTicket,
            connection: receiptConnection,
            brokerScopeKey: brokerProfileId,
          ),
        );
      }
    }

    _drainTranscriptPersistence();
  }

  Future<void> _commitTranscriptSnapshot(
    SessionTranscriptSnapshot snapshot, {
    required SessionCacheWriteAdmission admission,
    required List<_PendingAttachTicket> tickets,
  }) async {
    // Snapshots are profile-scoped. If the active profile already changed away
    // from this snapshot's profile, never write it or touch its tickets; the
    // original broker reissues any unacknowledged ticket on reattach.
    final writeFence = _cacheWriteFence;
    if (_brokerScopeKey != snapshot.brokerProfileId) {
      writeFence.release(admission);
      return;
    }
    if (!writeFence.claim(admission)) {
      return;
    }
    try {
      await ref.read(sessionTranscriptRepositoryProvider).upsert(snapshot);
    } on Object catch (error) {
      for (final ticket in tickets) {
        if (_brokerScopeKey == ticket.brokerScopeKey &&
            identical(_connection, ticket.connection)) {
          try {
            await ticket.connection.sendNack(ticket.ticket);
          } on Object {
            // The durable failure remains primary; reconnect can reissue it.
          }
        }
      }
      if (_brokerScopeKey == snapshot.brokerProfileId) {
        state = state.copyWith(
          error: userFacingMessage(
            error,
            lead: "Couldn't save this transcript on the device.",
          ),
        );
      }
      return;
    }

    // The durable transaction covering these tickets has committed. Because a
    // later snapshot supersedes earlier ones for the same session, acking every
    // accumulated ticket after this one commit is sound.
    for (final ticket in tickets) {
      if (_brokerScopeKey != ticket.brokerScopeKey ||
          !identical(_connection, ticket.connection)) {
        // Never forward an old profile/connection's ticket to a newly selected
        // broker. The original broker reissues an unacknowledged ticket on
        // reattach.
        continue;
      }
      try {
        await ticket.connection.sendAck(ticket.ticket);
      } on Object catch (error) {
        if (_brokerScopeKey == ticket.brokerScopeKey) {
          state = state.copyWith(
            error: userFacingMessage(
              error,
              lead:
                  'The transcript was saved, but its receipt could not be '
                  'sent.',
            ),
          );
        }
      }
    }
  }

  Future<void> _listen(
    SessionDetailConnection connection,
    int bootstrapAttempt,
  ) async {
    // Cancels are captured first and fired without awaiting: a cross-source
    // attach supersedes a hung lane rather than queuing behind it, so two
    // bodies can interleave at any await. Keeping this setup synchronous —
    // removing a broadcast listener takes effect immediately, and the cancel
    // future is only teardown ceremony — leaves no window in which a
    // superseded body could cancel or clobber the superseding lane's fresh
    // subscriptions.
    final previousStateSub = _stateSub;
    final previousEventSub = _eventSub;
    _stateSub = null;
    _eventSub = null;
    unawaited(previousStateSub?.cancel());
    unawaited(previousEventSub?.cancel());

    _stateSub = connection.stateStream.listen((status) {
      if (!_isCurrentBootstrapAttempt(bootstrapAttempt) ||
          !identical(_connection, connection)) {
        return;
      }
      if (status != SessionDetailConnectionStatus.connected) {
        _interruptTurnGeneration++;
        _interruptClientMessageId = null;
        _clearHistoryPageTracking();
        // The transport can no longer acknowledge an outstanding draft publish,
        // and whatever answers the NEXT connect may be a different broker
        // build. Forget the negotiated capability with it: the row stays dirty
        // and republishes only once the new socket's hello settles the
        // contract again.
        _forgetNegotiatedContract();
      } else {
        // DR1: one durable-draft hydration + dirty retry per connect, and one
        // bounded opportunistic maintenance pass — no polling, no keepalive.
        unawaited(_restoreLocalDraftForConnection());
        _scheduleLocalMaintenance();
      }
      state = state.copyWith(
        connectionStatus: status,
        interruptPhase: status == SessionDetailConnectionStatus.connected
            ? state.interruptPhase
            : SessionInterruptPhase.idle,
        historyPageLoading:
            status == SessionDetailConnectionStatus.connected &&
            state.historyPageLoading,
        // The Restoring window survives the reattach cycle's own
        // closed→connecting transitions (the pending reason still claims it,
        // and a reconnect re-sends the same reason-tagged attach). Once no
        // drive request is pending, a non-connected socket ends the claim
        // honestly. Provenance itself is untouched either way.
        driveRestorePhase:
            status != SessionDetailConnectionStatus.connected &&
                _requestedDriveReason == null &&
                state.driveRestorePhase == SessionDriveRestorePhase.restoring
            ? SessionDriveRestorePhase.idle
            : state.driveRestorePhase,
        clearError: true,
        clearSessionInfo: status != SessionDetailConnectionStatus.connected,
        clearTransientRetryStatus: true,
      );
    });
    _eventSub = connection.events.listen((event) {
      if (!_isCurrentBootstrapAttempt(bootstrapAttempt) ||
          !identical(_connection, connection)) {
        return;
      }
      // A timed-out or superseded page is no longer part of the active cursor
      // chain. Ignore it wholesale: merging its messages would advance the
      // projection behind a retry that is still using the prior cursor.
      if (event is HistoryPageWireEvent &&
          (_historyPageRequestId == null ||
              event.clientMessageId != _historyPageRequestId)) {
        return;
      }
      final brokerProfileId = _brokerScopeKey;
      if (brokerProfileId != null &&
          (event is HistoryWireEvent ||
              event is HistoryPageWireEvent ||
              event is MessageWireEvent)) {
        _transcriptScopeKey = brokerProfileId;
      }
      if (event is HelloWireEvent && brokerProfileId != null) {
        _brokerContractRevision = event.brokerContract.revision;
        // DR1: the draft capability is now known. A dirty row that deferred its
        // publish rather than risk the legacy last-writer-wins relay goes out
        // now, without another keystroke.
        _onDraftContractNegotiated();
        unawaited(_persistBrokerHello(brokerProfileId, event));
      }
      final optimisticAfterEvent = _optimisticPromptsAfterEvent(
        state.optimisticPrompts,
        state.transcriptClientKeys,
        event,
      );
      final retryMutation = _transientRetryMutation(
        event,
        bootstrapAttempt: bootstrapAttempt,
        eventSequence: ++_retryEventSequence,
      );
      final clearCommandProgress = _eventCompletesCommandProgress(event);
      if (clearCommandProgress) {
        _commandProgressTimer?.cancel();
        _commandProgressTimer = null;
      }
      final previousSessionStatus = state.sessionInfo?.status;
      final previousControl = SessionControlView.fromSessionDetail(
        info: state.sessionInfo,
        authority: state.connectionAuthority,
        joinExisting: state.joinExisting,
      );
      final sessionInfo = switch (event) {
        SessionWireEvent(:final info) => _admitSessionOwnerProjection(
          state.sessionInfo,
          info,
        ),
        MessageWireEvent(:final message) => _foldStatusMessage(
          state.sessionInfo,
          message,
        ),
        _ => state.sessionInfo,
      };
      final connectionAuthority = event is SessionWireEvent
          ? event.authority
          : state.connectionAuthority;
      final joinExisting =
          event is SessionWireEvent &&
              _joinMatchesOwner(event.joinExisting, sessionInfo?.sessionOwner)
          ? event.joinExisting
          : event is SessionWireEvent
          ? null
          : state.joinExisting;
      final nextControl = SessionControlView.fromSessionDetail(
        info: sessionInfo,
        authority: connectionAuthority,
        joinExisting: joinExisting,
      );
      if (event is SessionWireEvent) {
        if (previousControl.pill != nextControl.pill ||
            previousControl.canPrompt != nextControl.canPrompt) {
          final draft = _localDraft;
          developer.log(
            'session-control source=${_brokerScopeKey ?? 'none'} '
            'session=${arg.tool}/${arg.sessionId} '
            'socketGeneration=$bootstrapAttempt '
            'state=${sessionInfo?.status.name ?? 'unknown'} '
            'control=${previousControl.pill.name}->${nextControl.pill.name} '
            'driveState='
            '${sessionInfo?.control?.drive.state.name ?? 'unknown'} '
            'terminalSyncActive='
            '${sessionInfo?.control?.terminalSync.active ?? false} '
            'canPrompt=${nextControl.canPrompt} '
            'draftRevision=${draft?.baseBrokerRevision ?? -1} '
            'localMutationVersion=${draft?.mutationVersion ?? -1}',
            name: 'cosyncing.session-sync',
          );
        }
      }
      if (previousSessionStatus == SessionStatus.working &&
          sessionInfo?.status != SessionStatus.working) {
        _interruptTurnGeneration++;
      }
      // R0b: this socket observes the turn boundary before the roster journal
      // can round-trip it. Publishing here is what makes the roster and this
      // page converge on the same transition in the same frame.
      _publishAuthoritativeStatus(event, sessionInfo);
      final interruptPhase = sessionInfo?.status == SessionStatus.working
          ? state.interruptPhase
          : SessionInterruptPhase.idle;
      final interruptNack = switch (event) {
        NackWireEvent(:final clientMessageId) =>
          clientMessageId == _interruptClientMessageId,
        _ => false,
      };
      if (sessionInfo?.status != SessionStatus.working) {
        _interruptClientMessageId = null;
      } else if (interruptNack) {
        _interruptClientMessageId = null;
      }
      final effectiveInterruptPhase = interruptNack
          ? SessionInterruptPhase.idle
          : interruptPhase;
      _advanceBootstrapStateForHistoryEvent(event, bootstrapAttempt);
      _updateTranscriptCacheTail(event);
      final requestedHistoryCursor = _historyPageCursorInFlight;
      var historyPageLoading = state.historyPageLoading;
      String? historyPageError;
      String? historyPageErrorCode;
      var clearHistoryPageError = false;
      var transcriptWindow = state.transcriptWindow;
      var acceptedHistoryPage = true;
      switch (event) {
        case HistoryWireEvent():
          transcriptWindow = transcriptWindow.applyHistory(
            event,
            preserveMessageKey: _historyViewportAnchorKey,
          );
        case HistoryPageWireEvent() when requestedHistoryCursor != null:
          final mutation = transcriptWindow.prependPage(
            event,
            requestedCursor: requestedHistoryCursor,
            preserveMessageKey: _historyViewportAnchorKey,
          );
          transcriptWindow = mutation.window;
          acceptedHistoryPage = mutation.accepted;
        case MessageWireEvent(:final message):
          transcriptWindow = transcriptWindow.applyLiveMessage(message);
        case _:
          break;
      }
      if (event is HistoryWireEvent) {
        historyPageLoading = false;
        _clearHistoryPageTracking();
        clearHistoryPageError = true;
      } else if (event is HistoryPageWireEvent &&
          (_historyPageRequestId == null ||
              event.clientMessageId == _historyPageRequestId)) {
        historyPageLoading = false;
        _clearHistoryPageTracking();
        if (acceptedHistoryPage) {
          clearHistoryPageError = true;
        } else {
          historyPageErrorCode = 'HISTORY_PAGE_CLIENT_RESOURCE_LIMIT';
          historyPageError =
              'This history page exceeds the active decoded-memory budget.';
        }
      } else if (event is NackWireEvent &&
          event.clientMessageId != null &&
          event.clientMessageId == _historyPageRequestId) {
        historyPageLoading = false;
        _clearHistoryPageTracking();
        historyPageErrorCode = event.code;
        historyPageError = '${event.code}: ${event.message}';
      } else if (event is UnknownWireEvent &&
          event.kind == 'history-page' &&
          _historyPageRequestId != null) {
        historyPageLoading = false;
        _clearHistoryPageTracking();
        historyPageError = 'The server returned a malformed history page.';
      }
      // A standing agent-owned refusal is a claim about the session this frame
      // just re-described. `sessionInfo` is replaced wholesale here, so once an
      // AUTHORITATIVE session frame stops classifying the session as
      // `subagent`, the Fork tile re-enables (chrome reads
      // `state.isAgentOwnedSession`) while the refusal text underneath it would
      // otherwise survive — an enabled control sitting above a status line that
      // says it is impossible. It also still gates `forkSession()`, so a
      // reclassified session would refuse locally and never reach the broker.
      // Only `SessionWireEvent` counts: `_foldStatusMessage` derives info from
      // a status message and is not a re-classification.
      final clearAgentOwnedForkRefusal =
          event is SessionWireEvent &&
          state.forkSessionActionState.refusal ==
              SessionActionRefusal.agentOwnedSession &&
          event.info.origin != SessionOrigin.subagent;
      final historyStartReached = switch (event) {
        // A frame the broker could not read history for proves nothing about
        // where this session starts, whatever else it carries (H1c). This arm
        // is first on purpose: it also RETRACTS an earlier true marker, since a
        // source that has outgrown the bounded readers can no longer support
        // the claim that its start was reached.
        HistoryWireEvent(:final gap)
            when isHistoryUnavailableGapCode(gap?.code) =>
          false,
        HistoryWireEvent(:final reset, :final hasEarlier, :final truncated)
            when reset =>
          !hasEarlier && truncated == null,
        HistoryPageWireEvent(:final endOfHistory) when acceptedHistoryPage =>
          endOfHistory,
        _ => state.historyStartReached,
      };
      state = state.copyWith(
        events: appendSessionDetailEventLog(state.events, event),
        transcriptWindow: transcriptWindow,
        // U5: an accepted full replay is the ONLY local transcript-
        // replacement boundary; this covers automatic reconnect replays that
        // never go through attach() and therefore never advance the bootstrap
        // attempt.
        transcriptResetGeneration: event is HistoryWireEvent && event.reset
            ? state.transcriptResetGeneration + 1
            : null,
        sessionInfo: sessionInfo,
        connectionAuthority: connectionAuthority,
        clearConnectionAuthority:
            event is SessionWireEvent && connectionAuthority == null,
        joinExisting: joinExisting,
        clearJoinExisting: event is SessionWireEvent && joinExisting == null,
        interruptPhase: effectiveInterruptPhase,
        optimisticPrompts: optimisticAfterEvent.prompts,
        transcriptClientKeys: optimisticAfterEvent.clientKeys,
        clearCommandProgress: clearCommandProgress,
        historyPageLoading: historyPageLoading,
        historyPageError: historyPageError,
        historyPageErrorCode: historyPageErrorCode,
        clearHistoryPageError: clearHistoryPageError,
        historyStartReached: historyStartReached,
        clearError: true,
        forkSessionActionState: clearAgentOwnedForkRefusal
            ? const SessionActionState.idle()
            : null,
        transientRetryStatus: retryMutation.status,
        clearTransientRetryStatus:
            retryMutation.replace && retryMutation.status == null,
      );
      // Bounded-state pass: a delivered holder whose echo already sits at its
      // anchored boundary changes nothing by existing — release it (and never
      // keep more than the cap of out-of-order ones). Needs the post-event
      // canonical projection, hence after the state fold; reading the getter
      // here warms the same cache the UI reads.
      if (state.optimisticPrompts.any((p) => p.isDelivered)) {
        final retired = retireSettledOptimisticHolders(
          state.optimisticPrompts,
          state.canonicalTranscriptMessages,
        );
        if (!identical(retired, state.optimisticPrompts)) {
          state = state.copyWith(optimisticPrompts: retired);
        }
      }
      if (event is SessionWireEvent) {
        // Wait for the new attach's authoritative control frame before replay.
        // Replaying on the bare `connected` transition can race ahead of that
        // frame and send into Observe using stale pre-reattach ownership.
        unawaited(_replayRetryableOutbox());
        unawaited(_syncDriveIntent(sessionInfo!));
        if (_handoffResult != null) {
          final ownerState = sessionInfo.sessionOwner?.state;
          if (ownerState == SessionOwnerState.none ||
              ownerState == SessionOwnerState.terminalSync) {
            _completeHandoff(true);
          }
        }
        if (joinExisting != null) {
          unawaited(_joinExistingDriver(joinExisting));
        }
        if (!previousControl.canPrompt && nextControl.canPrompt) {
          _onDraftMutationAuthorityGained();
        }
        if (state.driveRestorePhase == SessionDriveRestorePhase.conflict &&
            nextControl.canMutate) {
          // The denial note must survive the broker's ordinary Observe
          // fallback frames (attach-conflict is immediately followed by the
          // fallback session frame). It clears only when the app genuinely
          // mutates again — Driving or active terminal sync — or when a user
          // action supersedes it.
          state = state.copyWith(
            driveRestorePhase: SessionDriveRestorePhase.idle,
            clearDriveRestoreConflict: true,
          );
        }
      } else if (event is NackWireEvent &&
          event.clientMessageId == _handoffClientMessageId) {
        _completeHandoff(false);
      } else if (event is AttachConflictWireEvent) {
        // Structured arbitration answer: the broker denied the restore and
        // continued this socket as Observe. Stop claiming Drive, keep the
        // provenance — only explicit user exits erase it — and surface the
        // machine reason so the manual Take over path stays discoverable.
        _requestedDriveReason = null;
        connection.disarmDriveAuthority();
        _completeTakeover(false);
        _completeHandoff(false);
        state = state.copyWith(
          driveRestorePhase: SessionDriveRestorePhase.conflict,
          driveRestoreConflict: SessionDriveRestoreConflict(
            reason: event.reason,
            code: event.code,
            message: event.message,
          ),
        );
      } else if (event is EndedWireEvent) {
        _requestedDriveReason = null;
        _completeHandoff(false);
        _establishedAttachIntent = null;
        unawaited(_clearDriveIntentBestEffort());
      } else if (event is ErrorWireEvent && _handoffResult != null) {
        _completeHandoff(false);
      }
      _enqueueTranscriptPersistence(event);
      if (event is DraftWireEvent) {
        unawaited(_handleSharedDraftEvent(event));
      }
      unawaited(_handleOutboxReceipt(event));
      _notifyForLiveEvent(event);
    });
  }

  /// Publishes an authoritative live status observation to the single owner.
  ///
  /// Only the two authoritative sources are published: the broker's own
  /// `session` frame, and a canonical `status` message that actually moved the
  /// cached [SessionInfo]. Every other frame leaves the registry alone, so a
  /// stream of tool output cannot restate a status this socket never observed.
  ///
  /// The observation is floored at the roster revision this client has already
  /// applied, which is what stops a roster snapshot generated *before* this
  /// frame from overwriting it later.
  void _publishAuthoritativeStatus(WireEvent event, SessionInfo? sessionInfo) {
    if (sessionInfo == null) return;
    final authoritative =
        event is SessionWireEvent ||
        (event is MessageWireEvent &&
            event.message.type == AgentMessageType.status);
    if (!authoritative) return;
    // Bind the observation to the source this SOCKET was opened against, not to
    // whatever profile happens to be active when the frame lands. A profile
    // whose endpoint was edited keeps its id, so a late frame from the retired
    // broker would otherwise be published as the new broker's truth.
    final source = _connectionSource;
    if (source == null) return;
    final rosterState = ref.read(sessionListControllerProvider);
    final currentSource =
        rosterState.source ??
        RosterSource.of(ref.read(activeBrokerProfileProvider));
    if (currentSource != null && currentSource != source) return;
    ref
        .read(sessionStatusRegistryProvider.notifier)
        .publishLive(
          source: source,
          tool: sessionInfo.tool,
          sessionId: sessionInfo.id,
          status: sessionInfo.status,
          rosterRevisionFloor: rosterState.revision,
        );
  }

  /// Folds a canonical `status` message into the cached [SessionInfo].
  ///
  /// The broker also pushes a `session` frame on a run-state transition, but an
  /// older broker does not — without this the cached info keeps reporting
  /// `working` for the rest of the attach.
  ///
  /// Deliberately narrow: `running` promotes to [SessionStatus.working], and
  /// `idle` only demotes a session that is currently `working`. A `needs-input`
  /// session is left alone because the detail state does not track pending
  /// permission/question requests, so it cannot tell that the block cleared —
  /// only the broker's own `session` frame can.
  static SessionInfo? _foldStatusMessage(SessionInfo? info, AgentMessage msg) {
    if (info == null) return null;
    final next = switch (msg.agentMessageStatus) {
      AgentMessageStatus.running => SessionStatus.working,
      AgentMessageStatus.idle when info.status == SessionStatus.working =>
        SessionStatus.idle,
      _ => null,
    };
    if (next == null || next == info.status) return info;
    // Round-trip rather than rebuild field-by-field: SessionInfo has no
    // copyWith, and enumerating 25 fields here would silently drop any field
    // added to the contract later.
    return SessionInfo.fromJson({
      ...info.toJson(),
      'status': _statusWireValue(next),
    });
  }

  static String _statusWireValue(SessionStatus status) => switch (status) {
    SessionStatus.working => 'working',
    SessionStatus.needsInput => 'needs-input',
    SessionStatus.idle => 'idle',
  };

  ({SessionTransientRetryStatus? status, bool replace}) _transientRetryMutation(
    WireEvent event, {
    required int bootstrapAttempt,
    required int eventSequence,
  }) {
    if (arg.tool != 'opencode') return (status: null, replace: false);
    final current = state.transientRetryStatus;
    switch (event) {
      case MessageWireEvent(:final message)
          when message.type == AgentMessageType.status:
        final detail = message.statusDetail;
        final source = _connectionSource;
        if (message.agentMessageStatus == AgentMessageStatus.running &&
            detail != null &&
            source != null &&
            state.source == source) {
          return (
            status: SessionTransientRetryStatus(
              providerDetail: detail,
              source: source,
              sessionId: arg.sessionId,
              attachGeneration: bootstrapAttempt,
              eventSequence: eventSequence,
            ),
            replace: true,
          );
        }
        return (status: null, replace: current != null);
      case MessageWireEvent(:final message)
          when message.type == AgentMessageType.modelOutput ||
              message.type == AgentMessageType.thinking ||
              message.type == AgentMessageType.toolCall ||
              message.type == AgentMessageType.toolResult ||
              message.type == AgentMessageType.agentActivity ||
              message.type == AgentMessageType.error:
        return (status: null, replace: current != null);
      case HistoryWireEvent(:final reset) when reset:
        return (status: null, replace: current != null);
      case SessionWireEvent(:final info)
          when info.status != SessionStatus.working:
        return (status: null, replace: current != null);
      case EndedWireEvent() || NackWireEvent():
        return (status: null, replace: current != null);
      case _:
        return (status: null, replace: false);
    }
  }

  /// Fires one coalesced maintenance pass; opportunistic cleanup must never
  /// break the session lifecycle, so every failure is contained here.
  void _scheduleLocalMaintenance() {
    try {
      final profileId = _brokerScopeKey;
      unawaited(
        ref.read(sessionLocalMaintenanceProvider).runOnce().then((report) {
          // Maintenance writes draft rows this controller caches, from outside
          // its serialized chain. When it touched THIS session's row the cache
          // is stale, and the row it wrote is usually a recovered prompt that
          // has to be offered back — so drop the cache and re-run hydration,
          // which reloads and surfaces the recovery banner.
          if (_disposed || profileId == null) return;
          final key = draftMutationKey(
            brokerProfileId: profileId,
            sessionKey: arg,
          );
          if (!report.mutatedDraftKeys.contains(key)) return;
          _draftCacheGeneration++;
          _loadedDraftScopeKey = null;
          _draftHydrated = false;
          unawaited(_restoreLocalDraftForConnection());
        }, onError: (Object _) {}),
      );
    } on Object {
      // Maintenance is opportunistic by contract.
    }
  }

  Future<void> _persistBrokerHello(
    String brokerProfileId,
    HelloWireEvent hello,
  ) async {
    try {
      await ref
          .read(brokerIdentityStoreProvider)
          .writeHello(brokerProfileId, hello);
      ref.invalidate(brokerHelloIdentityProvider(brokerProfileId));
    } on Object {
      // Compatibility enforcement remains live even if local identity history
      // cannot be written. A later hello or health refresh can retry storage.
    }
  }

  Future<void> _handleOutboxReceipt(WireEvent event) async {
    switch (event) {
      case AckWireEvent(
        ackKind: 'client-message',
        :final clientMessageId,
        :final pending,
        :final draftCleared,
        :final draftRevision,
      ):
        if (clientMessageId == null || clientMessageId.isEmpty || pending) {
          return;
        }
        // DR1: the prompt landed, but the handoff only completes when the
        // broker also confirms the shared draft was durably cleared; otherwise
        // the row becomes a conditional pending clear that retries.
        //
        // The draft transition is persisted BEFORE the outbox is marked
        // delivered, and the mark is skipped when it could not be. The reverse
        // order has a crash window: a delivered outbox row beside a
        // still-submitted draft row reconciles on reopen by deleting the draft,
        // so dying in between would silently discard the failed clear's retry.
        // Dying the other way round only replays the prompt, which the broker
        // deduplicates by client message id.
        final draftSettled = await _handleDraftAfterDelivered(
          clientMessageId,
          draftCleared: draftCleared,
          draftRevision: draftRevision,
        );
        if (!draftSettled) return;
        await ref
            .read(sessionOutboxRepositoryProvider)
            .markDelivered(clientMessageId);
        if (_attachmentPromptClientMessageId == clientMessageId) {
          state = state.copyWith(
            clearStagedAttachments: true,
            clearError: true,
          );
          if (!(_attachmentPromptResult?.isCompleted ?? true)) {
            _attachmentPromptResult?.complete(true);
          }
          _attachmentPromptClientMessageId = null;
          _attachmentPromptResult = null;
        }
        _scheduleLocalMaintenance();
      case NackWireEvent(:final clientMessageId, :final code, :final message):
        if (clientMessageId == null || clientMessageId.isEmpty) {
          return;
        }
        final detail = message.isEmpty ? code : message;
        // A broker nack is a completed, deduplicated result for this exact
        // clientMessageId. Replaying the same id can only return the cached
        // failure; only transport exceptions remain retryable.
        await ref
            .read(sessionOutboxRepositoryProvider)
            .markFailed(clientMessageId, detail);
        _removeOptimisticPrompt(clientMessageId);
        // DR1: terminal delivery failure restores/exposes the unsent text.
        await _restoreDraftForFailedSend(clientMessageId);
        final isAttachmentFailure =
            _attachmentPromptClientMessageId == clientMessageId;
        if (isAttachmentFailure) {
          final referenceExpired =
              code == 'STAGED_ATTACHMENT_EXPIRED' ||
              code == 'STAGED_ATTACHMENT_NOT_FOUND';
          state = state.copyWith(
            stagedAttachments: state.stagedAttachments
                .map(
                  (attachment) => attachment.copyWith(
                    phase: SessionAttachmentUploadPhase.error,
                    clearUpload: referenceExpired && !attachment.isInline,
                  ),
                )
                .toList(growable: false),
          );
          if (!(_attachmentPromptResult?.isCompleted ?? true)) {
            _attachmentPromptResult?.complete(false);
          }
          _attachmentPromptClientMessageId = null;
          _attachmentPromptResult = null;
        }
        _scheduleLocalMaintenance();
        state = state.copyWith(
          error: isAttachmentFailure
              ? sessionAttachmentDeliveryErrorKey
              : detail,
        );
      case _:
        return;
    }
  }

  void _notifyForLiveEvent(WireEvent event) {
    // Notification routing is PROFILE identity, not broker-bound storage: the
    // attention feed registers its workers per profile id, and suppression
    // must match whatever key those workers registered under.
    final brokerProfileId = _connectionSource?.profileId;
    if (brokerProfileId != null &&
        ref
            .read(attentionFeedDeliveryActiveProvider)
            .contains(brokerProfileId)) {
      return;
    }
    unawaited(
      ref
          .read(sessionNotificationPolicyProvider)
          .maybeNotifyForSessionEvent(
            tool: arg.tool,
            sessionId: arg.sessionId,
            event: event,
            brokerProfileId: brokerProfileId,
          )
          .catchError((error, stack) {}),
    );
  }

  /// Sends a user prompt through the active session connection.
  ///
  /// The trimmed prompt must be non-empty and the session must be connected.
  /// Returns `true` only when the prompt was accepted by the transport.
  Future<bool> sendPrompt(String text, {SessionCurrentModel? model}) =>
      _sendPromptCoordinated(text, model: model);

  Future<bool> sendDraft(String text) => _sendDraftCoordinated(text);

  /// Interrupts the current working turn via an advertised stop/abort action.
  Future<SessionInterruptOutcome> interruptCurrentTurn() =>
      _interruptCurrentTurnCoordinated();

  Future<bool> sendPlanAction(PlanActionRequest request) =>
      _sendPlanActionCoordinated(request);

  Future<bool> sendArtifactInteraction(ArtifactInteractionRequest request) =>
      _sendArtifactInteractionCoordinated(request);

  Future<bool> sendAttachTicketReceipt(
    String attachTicket, {
    required bool accepted,
  }) => _sendAttachTicketReceiptCoordinated(
    attachTicket,
    accepted: accepted,
  );

  Future<bool> loadEarlierHistory({
    int limit = kTranscriptHistoryPageMessages,
    String? cursor,
  }) => _loadEarlierHistoryCoordinated(limit: limit, cursor: cursor);

  /// Records the first visible canonical row so active-history eviction keeps
  /// that page plus the recent tail. This is local memory policy only.
  void protectHistoryViewportAnchor(String? stableMessageKey) {
    if (_historyViewportAnchorKey == stableMessageKey) return;
    _historyViewportAnchorKey = stableMessageKey;
  }

  Future<bool> sendCommand(
    String name, {
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? permissionMode,
  }) => _sendCommandCoordinated(
    name,
    args: args,
    model: model,
    permissionMode: permissionMode,
  );

  Future<bool> sendActionCommand(
    String name, {
    Map<String, dynamic>? args,
  }) => _sendActionCommandCoordinated(name, args: args);

  Future<bool> pickAttachments() => _pickAttachmentsCoordinated();

  /// Admits materialized paste/drop files through A1 without sending.
  Future<bool> admitAttachments(List<SessionAttachment> attachments) =>
      _admitAttachmentsCoordinated(attachments);

  void reportAttachmentIntakeFailure() =>
      _reportAttachmentIntakeFailureCoordinated();

  Future<bool> replaceAttachment(String localId) =>
      _replaceAttachmentCoordinated(localId);

  Future<void> removeAttachment(String localId) =>
      _removeAttachmentCoordinated(localId);

  Future<bool> downloadArtifact(SessionArtifactDescriptor descriptor) =>
      _downloadArtifactCoordinated(descriptor);

  Future<SessionArtifactCachedFile?> prepareArtifactPreview(
    SessionArtifactDescriptor descriptor,
  ) => _prepareArtifactPreviewCoordinated(descriptor);

  void recordArtifactPreviewResult(
    SessionArtifactDescriptor descriptor, {
    required bool opened,
    required String message,
  }) => _recordArtifactPreviewResultCoordinated(
    descriptor,
    opened: opened,
    message: message,
  );

  Future<TranscriptExportPreflightResponse?> prepareTranscriptExport() =>
      _prepareTranscriptExportCoordinated();

  Future<bool> exportTranscript({required String nonce}) =>
      _exportTranscriptCoordinated(nonce: nonce);

  Future<bool> renameSession(String title) => _renameSessionCoordinated(title);

  Future<SessionInfo?> forkSession({String? messageId}) =>
      _forkSessionCoordinated(messageId: messageId);

  Future<SessionInfo?> cloneSession() => _cloneSessionCoordinated();

  Future<bool> sendPermissionDecision({
    required String requestId,
    required String decision,
  }) => _sendPermissionDecisionCoordinated(
    requestId: requestId,
    decision: decision,
  );

  Future<bool> sendQuestionAnswer({
    required String requestId,
    required List<List<String>> answers,
  }) => _sendQuestionAnswerCoordinated(
    requestId: requestId,
    answers: answers,
  );

  Future<bool> rejectQuestion(String requestId) =>
      _rejectQuestionCoordinated(requestId);
}
