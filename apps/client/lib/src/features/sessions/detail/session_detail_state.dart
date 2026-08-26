import 'dart:collection';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_picker.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_bootstrap_state.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_connection.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_live_state.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_telemetry.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/requests/session_request_action_helpers.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_conversation_turns.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:flutter/foundation.dart';

/// How a controller-decided draft value should reach the composer (DR1).
enum SessionDraftSurfaceKind {
  /// Replace the composer content (multi-client sync / hydration), subject to
  /// the page's recent-typing guard.
  replace,

  /// Restore a failed send's text only while the composer is still empty.
  restoreIfEmpty,

  /// Replace the composer content unconditionally.
  ///
  /// Reserved for EXPLICIT user resolutions (a conflict banner choice). The
  /// recent-typing guard exists to stop remote content from stealing a
  /// composer the user is typing in — but a resolution IS the user acting,
  /// and rejecting it can be destructive: restoring a recovered failed prompt
  /// deletes its outbox row, so a surface that never applies would discard
  /// the only remaining copy.
  forceReplace,
}

/// Controller-decided composer content the page applies exactly once (DR1).
@immutable
final class SessionDraftSurface {
  /// Creates a surface directive.
  const SessionDraftSurface({
    required this.text,
    required this.token,
    required this.kind,
  });

  /// Text the composer should hold.
  final String text;

  /// Monotone application token; the page applies each token at most once and
  /// never replays a stale one.
  final int token;

  /// Replacement policy for non-empty local content.
  final SessionDraftSurfaceKind kind;
}

/// What produced a preserved two-version draft state (DR1).
enum SessionDraftConflictKind {
  /// This device's draft and the shared broker draft changed independently
  /// while apart. Resolution republishes or adopts the shared revision.
  sharedDivergence,

  /// A prompt whose send failed terminally, preserved beside newer composer
  /// text that arrived after it. Resolution is purely local — the recovered
  /// prompt has no broker revision to arbitrate against.
  unsentPrompt,
}

/// Preserved two-version draft state awaiting user resolution (DR1).
///
/// Both versions are durable on the local draft row; nothing is chosen by
/// wall-clock time or text similarity.
@immutable
final class SessionDraftConflict {
  /// Creates a conflict descriptor.
  const SessionDraftConflict({
    required this.localText,
    required this.sharedText,
    this.sharedRevision,
    this.kind = SessionDraftConflictKind.sharedDivergence,
    this.recoveredPromptId,
  });

  /// This device's unsynchronized draft text.
  final String localText;

  /// The preserved other version: the newer shared draft published while this
  /// device was away, or the text of a terminally failed send.
  final String sharedText;

  /// Broker revision of [sharedText], or null for a
  /// [SessionDraftConflictKind.unsentPrompt] (a failed local send never had
  /// one).
  final int? sharedRevision;

  /// Why both versions are being preserved.
  final SessionDraftConflictKind kind;

  /// Outbox client message id backing [sharedText], when this offer recovers
  /// a terminally failed prompt straight from its outbox row — the case where
  /// the durable draft row cannot hold the text (over the size cap).
  ///
  /// Travels with the banner so resolving it can remove the outbox row
  /// (retention: resolved failed rows are deleted) and so no controller state
  /// can outlive the offer it belongs to.
  final String? recoveredPromptId;
}

/// Stable identity for one session detail controller.
@immutable
class SessionDetailKey {
  /// Creates a [SessionDetailKey].
  const SessionDetailKey({
    required this.tool,
    required this.sessionId,
  });

  /// Broker tool id.
  final String tool;

  /// Session id within [tool].
  final String sessionId;

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is SessionDetailKey &&
            other.tool == tool &&
            other.sessionId == sessionId;
  }

  @override
  int get hashCode => Object.hash(tool, sessionId);
}

/// One live-only OpenCode retry observation for the current attach.
@immutable
final class SessionTransientRetryStatus {
  /// Creates an attach-qualified retry observation.
  const SessionTransientRetryStatus({
    required this.providerDetail,
    required this.source,
    required this.sessionId,
    required this.attachGeneration,
    required this.eventSequence,
  });

  /// Bounded opaque provider prose from the adapter.
  final String providerDetail;

  /// Exact broker profile and endpoint that emitted the retry.
  final RosterSource source;

  /// Exact native session within [source].
  final String sessionId;

  /// Controller attach generation that admitted the event.
  final int attachGeneration;

  /// Monotone live-event order within the controller.
  final int eventSequence;
}

/// Stable presentation keys for attachment failures translated by the view.
const sessionAttachmentUnsupportedErrorKey =
    'session-attachment-error:unsupported';

/// File-picker failure presentation key.
const sessionAttachmentSelectionErrorKey = 'session-attachment-error:selection';

/// Paste/drop materialization failure presentation key.
const sessionAttachmentIntakeErrorKey = 'session-attachment-error:intake';

/// Single-file replacement failure presentation key.
const sessionAttachmentReplacementErrorKey =
    'session-attachment-error:replacement';

/// Count or byte-limit failure presentation key.
const sessionAttachmentLimitErrorKey = 'session-attachment-error:limit';

/// Chunked staging failure presentation key.
const sessionAttachmentStagingErrorKey = 'session-attachment-error:staging';

/// Terminal prompt receipt failure presentation key.
const sessionAttachmentDeliveryErrorKey = 'session-attachment-error:delivery';

/// Immutable state for the session detail lifecycle shell.
@immutable
final class SessionStagedAttachment {
  /// Creates one composer-owned attachment.
  const SessionStagedAttachment({
    required this.localId,
    required this.attachment,
    this.phase = SessionAttachmentUploadPhase.selected,
    this.message,
    this.uploadId,
    this.stagedRef,
    this.expiresAt,
  });

  /// Client-local identity used by remove/replace and outbox replay.
  final String localId;

  /// Live-only inline bytes or a re-openable staged source plus picker
  /// metadata.
  ///
  /// Neither source capabilities nor inline base64 are written to the outbox.
  final SessionAttachment attachment;

  /// Current staging/delivery phase.
  final SessionAttachmentUploadPhase phase;

  /// Localized presentation detail supplied by the view.
  final String? message;

  /// Chunked-upload id retained for explicit discard.
  final String? uploadId;

  /// Opaque broker-issued prompt reference for a large file.
  final String? stagedRef;

  /// Epoch milliseconds when [stagedRef] expires.
  final int? expiresAt;

  /// Whether this file rides inline on the bounded prompt frame.
  bool get isInline => attachment.isInline;

  /// Produces the exact prompt wire entry.
  PromptFileAttachment toPromptFile() {
    final reference = stagedRef;
    if (isInline) {
      return PromptFileAttachment.inline(
        name: attachment.name,
        mimeType: attachment.mimeType ?? 'application/octet-stream',
        size: attachment.byteLength,
        data: attachment.data!,
      );
    }
    if (reference == null || reference.isEmpty) {
      throw StateError('Large attachment has not finished staging.');
    }
    return PromptFileAttachment.staged(
      name: attachment.name,
      mimeType: attachment.mimeType ?? 'application/octet-stream',
      size: attachment.byteLength,
      stagedRef: reference,
    );
  }

  /// Metadata safe for durable outbox persistence (no bytes or paths).
  Map<String, dynamic> toOutboxJson() => {
    'localId': localId,
    'name': attachment.name,
    'mimeType': attachment.mimeType ?? 'application/octet-stream',
    'size': attachment.byteLength,
    if (uploadId != null) 'uploadId': uploadId,
    if (stagedRef != null) 'stagedRef': stagedRef,
    if (expiresAt != null) 'expiresAt': expiresAt,
  };

  /// Returns a copy with lifecycle overrides.
  SessionStagedAttachment copyWith({
    SessionAttachment? attachment,
    SessionAttachmentUploadPhase? phase,
    String? message,
    String? uploadId,
    String? stagedRef,
    int? expiresAt,
    bool clearMessage = false,
    bool clearUpload = false,
  }) {
    return SessionStagedAttachment(
      localId: localId,
      attachment: attachment ?? this.attachment,
      phase: phase ?? this.phase,
      message: clearMessage ? null : message ?? this.message,
      uploadId: clearUpload ? null : uploadId ?? this.uploadId,
      stagedRef: clearUpload ? null : stagedRef ?? this.stagedRef,
      expiresAt: clearUpload ? null : expiresAt ?? this.expiresAt,
    );
  }
}

/// Immutable controller state for one Session Detail surface.
class SessionDetailState {
  /// Creates a [SessionDetailState].
  const SessionDetailState({
    required this.tool,
    required this.sessionId,
    this.source,
    this.connectionStatus = SessionDetailConnectionStatus.disconnected,
    this.bootstrapState = const SessionDetailBootstrapState(),
    this.events = const [],
    this.transcriptWindow = const TranscriptHistoryWindow.uninitialized(),
    this.sessionInfo,
    this.connectionAuthority,
    this.joinExisting,
    this.agentActions,
    this.error,
    this.renameSessionActionState = const SessionActionState.idle(),
    this.forkSessionActionState = const SessionActionState.idle(),
    this.cloneSessionActionState = const SessionActionState.idle(),
    this.artifactActionStates = const {},
    this.transcriptExportActionState = const TranscriptExportActionState.idle(),
    this.stagedAttachments = const [],
    this.optimisticPrompts = const [],
    this.transcriptClientKeys = const {},
    this.interruptPhase = SessionInterruptPhase.idle,
    this.commandProgress,
    this.historyPageLoading = false,
    this.historyPageError,
    this.historyPageErrorCode,
    this.historyStartReached = false,
    this.transcriptResetGeneration = 0,
    this.driveRestorePhase = SessionDriveRestorePhase.idle,
    this.driveRestoreConflict,
    this.draftSurface,
    this.draftConflict,
    this.transientRetryStatus,
  });

  /// Broker tool id.
  final String tool;

  /// Session id within [tool].
  final String sessionId;

  /// Broker this state's authoritative content belongs to.
  ///
  /// Stamped when the bootstrap resolves a profile, so everything the broker
  /// then reports — [sessionInfo] above all — carries provenance. Null before
  /// the first attach resolves a profile, and in direct state fixtures.
  ///
  /// A broker's identity is (profile, endpoint), never the profile id alone: a
  /// profile is an editable pointer, so re-pointing one at another machine
  /// keeps its id while changing which broker answers. Session ids are native
  /// to their broker, so two brokers can hold the same `tool`/`sessionId` pair
  /// and mean different sessions. Without the endpoint, the id compared equal
  /// across that edit and the retired broker's content stayed on screen.
  ///
  /// Clearing is asynchronous, so this is what every consumer qualifies
  /// against rather than trusting the controller to have cleared it already
  /// (see [forActiveSource]).
  final RosterSource? source;

  /// Current attach status.
  final SessionDetailConnectionStatus connectionStatus;

  /// Initial transcript bootstrap lifecycle state.
  final SessionDetailBootstrapState bootstrapState;

  /// Bounded control events and summary-only transcript events for Debug.
  ///
  /// Transcript bodies live only in [transcriptWindow]; keeping them out of
  /// this immutable log avoids a second unbounded decoded-history owner.
  final List<WireEvent> events;

  /// Explicit bounded transcript pages and reloadable gaps.
  ///
  /// Controller-owned states initialize this on the first history/message
  /// frame. The uninitialized sentinel keeps direct legacy state fixtures that
  /// provide only [events] working without putting event-log reduction back on
  /// the live controller path.
  final TranscriptHistoryWindow transcriptWindow;

  /// Most recent session info frame, if received.
  final SessionInfo? sessionInfo;

  /// Broker-derived authority of this Session Detail socket.
  final SessionConnectionAuthority? connectionAuthority;

  /// Revision-conditional existing-Drive action offered to this socket.
  final SessionJoinExistingAction? joinExisting;

  /// Capability-gated REST actions available for this session's agent.
  final SessionAgentActions? agentActions;

  /// Last controller-level error, if any.
  final LocalizedFailure? error;

  /// Current native session rename action state.
  final SessionActionState renameSessionActionState;

  /// Current fork session action state.
  final SessionActionState forkSessionActionState;

  /// Current clone session action state.
  final SessionActionState cloneSessionActionState;

  /// Per-artifact UI action states.
  ///
  /// Keys come from `SessionArtifactDescriptor.actionStateKey`.
  final Map<String, SessionArtifactActionState> artifactActionStates;

  /// Current transcript-export command state.
  final TranscriptExportActionState transcriptExportActionState;

  /// Ordered, bounded composer attachment staging state.
  final List<SessionStagedAttachment> stagedAttachments;

  /// Locally accepted prompts awaiting a canonical broker user-message echo.
  final List<SessionOptimisticPrompt> optimisticPrompts;

  /// Display-identity map for legacy (unstamped) echoes: canonical echo stable
  /// key → the app send's `clientMessageId` it delivered.
  ///
  /// A stamped echo carries `clientKey` in its own raw payload; a legacy no-id
  /// echo gets it only from the state-layer reconcile. Recording that
  /// association here lets the projection keep decorating the canonical row
  /// after its position holder retires, so the bubble's display identity never
  /// changes. Insertion-ordered and bounded by
  /// [kMaxRetainedTranscriptClientKeys].
  final Map<String, String> transcriptClientKeys;

  /// Lifecycle of the non-replayable interrupt action for the current turn.
  final SessionInterruptPhase interruptPhase;

  /// Current long-running slash-command feedback, if any.
  final SessionCommandProgress? commandProgress;

  /// Whether an older transcript page is currently in flight.
  final bool historyPageLoading;

  /// Typed paging failure for the current cursor chain.
  final LocalizedFailure? historyPageError;

  /// Machine-readable paging failure. Resource/source failures are terminal
  /// for this cursor epoch; transport/malformed failures remain retryable.
  final String? historyPageErrorCode;

  /// Whether an authoritative history response reached the native beginning.
  final bool historyStartReached;

  /// Local generation of authoritative transcript replacements (U5).
  ///
  /// Advances by exactly one each time the controller accepts a
  /// `HistoryWireEvent(reset: true)` — the initial attach replay, a cached
  /// snapshot hydration, and any reconnect replay whose cursor was invalid,
  /// gone, diverged, or capped. It is a local counter, not derived from the
  /// summary-only debug log. Incremental history frames, live messages, older
  /// pages, notices, and tool projections never advance it. The transcript
  /// reveal gate re-arms only on this boundary.
  final int transcriptResetGeneration;

  /// Bounded lifecycle of an automatic Drive restoration attempt.
  ///
  /// `restoring` covers only the arbitration window between a reason-tagged
  /// resume attach and the broker's answer (a Driving session frame, an
  /// `attach-conflict`, or a connection change). Prompting stays gated on the
  /// broker's own control frame, never on this display state.
  final SessionDriveRestorePhase driveRestorePhase;

  /// Structured broker conflict from the last denied Drive restoration, if
  /// any. Preserved provenance means the manual Take over path stays open.
  final SessionDriveRestoreConflict? driveRestoreConflict;

  /// Latest controller-decided composer content (DR1 durable drafts), if any.
  final SessionDraftSurface? draftSurface;

  /// Unresolved local-vs-shared draft conflict (DR1), if any.
  final SessionDraftConflict? draftConflict;

  /// Current live OpenCode retry, never reconstructed from replayed history.
  final SessionTransientRetryStatus? transientRetryStatus;

  /// Retry detail only while every admission qualifier still matches.
  ///
  /// This fail-closed read covers the short asynchronous window where a source
  /// or attach replacement has begun but its clearing mutation has not reached
  /// the widget tree yet.
  SessionTransientRetryStatus? get activeTransientRetryStatus {
    final retry = transientRetryStatus;
    if (tool != 'opencode' ||
        retry == null ||
        retry.source != source ||
        retry.sessionId != sessionId ||
        retry.attachGeneration != bootstrapState.attempt) {
      return null;
    }
    return retry;
  }

  /// Human-readable event summaries for the debug timeline.
  List<String> get eventSummaries => _projection.eventSummaries;

  /// Canonical message events available for renderer-driven rendering.
  ///
  /// Includes both live `MessageWireEvent` frames and replayed history
  /// messages from `HistoryWireEvent`.
  List<AgentMessage> get messageEvents => _activeTranscript.canonicalMessages;

  /// Gap metadata from the latest history epoch, if the broker had to send a
  /// full replay instead of the requested delta.
  HistoryGap? get latestHistoryGap => _activeTranscript.latestHistoryGap;

  /// Tail-window metadata from the latest history epoch, if it was capped.
  HistoryTruncation? get latestHistoryTruncation =>
      _activeTranscript.latestHistoryTruncation;

  /// Cursor for the next older page.
  String? get olderHistoryCursor => _activeTranscript.olderHistoryCursor;

  /// Latest reconnect cursor represented by the durable transcript snapshot.
  String? get historyCursor => _activeTranscript.historyCursor;

  /// Whether another retained older page can be requested.
  ///
  /// A failed page request does not consume its cursor. Keeping this true lets
  /// the UI offer an explicit retry and prevents unrelated transcript commits
  /// from persisting a false end-of-history marker.
  bool get hasEarlierHistory => _activeTranscript.hasEarlierHistory;

  /// Current keyed goal/task state for the pinned Session Detail surface.
  SessionLiveState get liveState =>
      _activeTranscript.liveState ?? SessionLiveState.fromMessages(const []);

  /// Latest cost and context reading, coalesced out of the transcript.
  SessionTelemetry get telemetry => _activeTranscript.telemetry;

  /// Durable transcript messages after state-only goal/task frames are routed
  /// to [liveState].
  List<AgentMessage> get transcriptMessageEvents =>
      _activeTranscript.transcriptMessagesWith(
        optimisticPrompts,
        transcriptClientKeys,
      );

  /// Contiguous transcript runs for rendering. Adjacent entries are separated
  /// by [transcriptHistoryGaps], so turn grouping never crosses an evicted
  /// middle range.
  List<List<AgentMessage>> get transcriptMessageSegments =>
      _activeTranscript.transcriptMessageSegmentsWith(
        optimisticPrompts,
        transcriptClientKeys,
      );

  /// Cached contiguous-run descriptors consumed by the transcript widget.
  ///
  /// Unchanged older pages retain their cached run and turn identities across
  /// a live tail update, so rendering work stays bounded to the recent page
  /// plus its single logical-turn boundary.
  List<TranscriptConversationSegment> transcriptConversationSegments(
    ToolDisplayMode mode, {
    TranscriptHistoryWorkCounter? work,
  }) => _activeTranscript.transcriptConversationSegmentsWith(
    optimisticPrompts,
    transcriptClientKeys,
    mode: mode,
    work: work,
  );

  /// Whether any retained page contains a renderable transcript row.
  bool get hasTranscriptMessages => _activeTranscript.hasTranscriptMessages;

  /// Latest canonical request resolution by request id.
  ///
  /// This folds page-local maps and never walks all transcript messages during
  /// a live rebuild.
  Map<String, String?> get resolvedRequestDecisions =>
      _activeTranscript.resolvedRequestDecisions;

  /// Explicit gap rows between [transcriptMessageSegments].
  List<TranscriptHistoryGapSegment> get transcriptHistoryGaps =>
      _activeTranscript.gaps;

  /// Omitted range before the first retained segment, when an oversized local
  /// snapshot had no opaque boundary for the rows it dropped.
  TranscriptHistoryGapSegment? get leadingTranscriptHistoryGap =>
      _activeTranscript.leadingGap;

  /// Canonical transcript rows only — no optimistic rows, no decoration.
  ///
  /// This is the list optimistic slots index into; holder retirement measures
  /// echo/anchor adjacency against it.
  List<AgentMessage> get canonicalTranscriptMessages =>
      _activeTranscript.transcriptMessages;

  /// Insertion boundary a prompt accepted right now would pin itself after:
  /// the newest canonical transcript message with a stable key.
  ///
  /// Canonical only — pending optimistic rows are not anchors; concurrent
  /// pending prompts share a boundary and keep send order.
  String? get transcriptAnchorKey =>
      latestTranscriptAnchorKey(_activeTranscript.transcriptMessages);

  /// Terminal output messages from live and replayed history frames.
  List<AgentMessage> get terminalOutputMessages =>
      _activeTranscript.terminalOutputMessages;

  /// File artifact messages from live and replayed history frames.
  List<AgentMessage> get fileArtifactMessages =>
      _activeTranscript.fileArtifactMessages;

  /// File artifact descriptors for UI affordance calculation.
  List<SessionArtifactDescriptor> get fileArtifactDescriptors =>
      _activeTranscript.fileArtifactDescriptors;

  /// Latest slash commands from the most recent `CommandsWireEvent`.
  List<SlashCommand> get commands => _projection.commands;

  /// Advertised action that can interrupt the current agent turn.
  ///
  /// Prefer `stop` when both spellings are present, while preserving the
  /// broker's exact command name for invocation.
  SlashCommand? get interruptCommand {
    SlashCommand? abort;
    for (final command in commands) {
      if (command.kind != SlashCommandKind.action) continue;
      final name = command.name.startsWith('/')
          ? command.name.substring(1)
          : command.name;
      switch (name.toLowerCase()) {
        case 'stop':
          return command;
        case 'abort':
          abort ??= command;
      }
    }
    return abort;
  }

  /// Latest model catalog from the most recent `OptionsWireEvent`.
  List<ModelOption> get models => _projection.models;

  /// Latest agent/mode catalog (e.g. build/plan) from the most recent
  /// `OptionsWireEvent`. Empty when the adapter advertises none — the mode
  /// control renders nothing then.
  List<AgentOption> get agents => _projection.agents;

  /// Latest permission-mode catalog from the most recent `OptionsWireEvent`.
  List<ModeOption> get modes => _projection.modes;

  /// Broker/client identity negotiation from the first stream frame.
  HelloWireEvent? get hello => events.whereType<HelloWireEvent>().lastOrNull;

  /// Whether every mutating control must remain disabled.
  bool get compatibilityReadOnly => hello?.compatibility.readOnly ?? false;

  /// Whether this session was spawned by another agent session rather than by a
  /// person.
  ///
  /// Read off [SessionInfo.origin], the same protocol field the broker's fork
  /// gate uses, so the affordance and the refusal cannot drift and no tool name
  /// is ever named here. Only `subagent` counts: `exec`/`vscode` are automated
  /// or IDE launches with no owning parent.
  bool get isAgentOwnedSession => sessionInfo?.origin == SessionOrigin.subagent;

  /// Whether forking this session is refused as agent-owned right now.
  ///
  /// The single predicate every fork gate answers — the controller's own gate
  /// and both visible affordances. It folds the local lineage fact together
  /// with a STANDING refusal, because the broker's typed 409 exists precisely
  /// for the case where local lineage is missing, stale, or peer-served: there
  /// [isAgentOwnedSession] is false, so a gate reading only that would keep
  /// offering an action the controller has already refused, turning every tap
  /// into another refusal SnackBar.
  ///
  /// Not permanent: an authoritative session frame that no longer classifies
  /// the session as `subagent` clears the refusal (see the `SessionWireEvent`
  /// branch of the controller's event fold), and both affordances return.
  bool get forkBlockedAsAgentOwned =>
      isAgentOwnedSession ||
      forkSessionActionState.refusal == SessionActionRefusal.agentOwnedSession;

  /// Latest broker-relayed shared composer draft, if one was received.
  DraftWireEvent? get latestDraft => _projection.latestDraft;

  _SessionDetailProjection get _projection {
    final cached = _sessionDetailProjectionCache[events];
    if (cached != null) return cached;
    final projection = _SessionDetailProjection.fromEvents(events);
    _sessionDetailProjectionCache[events] = projection;
    return projection;
  }

  TranscriptHistoryWindow get _activeTranscript {
    if (transcriptWindow.initialized) return transcriptWindow;
    final cached = _legacyTranscriptWindowCache[events];
    if (cached != null) return cached;
    final window = TranscriptHistoryWindow.fromEvents(events);
    _legacyTranscriptWindowCache[events] = window;
    return window;
  }

  /// Explicit active page table, including the legacy-fixture adapter.
  TranscriptHistoryWindow get activeTranscriptWindow => _activeTranscript;

  /// This state as the active broker is entitled to see it.
  ///
  /// Returns `this` unless the stamped [source] contradicts [activeSource], in
  /// which case NOTHING broker-owned survives: the result is the neutral state
  /// this session starts from. Every payload here — the session frame,
  /// transcript, drafts, terminal output, commands and models, errors,
  /// optimistic prompts, action states — was reported by the other broker
  /// about its own session, and none of it may be displayed, applied to the
  /// composer, persisted, or keyed on. Dropping the session frame alone would
  /// leave the rest of that broker's content on screen.
  ///
  /// Qualification is by (profile, endpoint). Comparing profile ids alone let
  /// an endpoint edit keep its id and therefore keep the previous machine's
  /// content and control state on screen.
  ///
  /// This exists because retirement is not synchronous. Switching brokers
  /// queues an attach, and that attach awaits a connection reset — two stream
  /// cancellations and a socket close — before it replaces the state, so the
  /// old broker's content survives well past the frame that switched.
  ///
  /// An unstamped state (null [source]) predates any resolved profile and is
  /// passed through; it cannot carry a broker's content.
  SessionDetailState forActiveSource(RosterSource? activeSource) {
    final owner = source;
    if (owner == null || owner == activeSource) return this;
    return SessionDetailState(tool: tool, sessionId: sessionId);
  }

  /// Returns a copy with optional overrides.
  SessionDetailState copyWith({
    RosterSource? source,
    SessionDetailConnectionStatus? connectionStatus,
    SessionDetailBootstrapState? bootstrapState,
    List<WireEvent>? events,
    TranscriptHistoryWindow? transcriptWindow,
    SessionInfo? sessionInfo,
    SessionConnectionAuthority? connectionAuthority,
    SessionJoinExistingAction? joinExisting,
    SessionAgentActions? agentActions,
    LocalizedFailure? error,
    SessionActionState? renameSessionActionState,
    SessionActionState? forkSessionActionState,
    SessionActionState? cloneSessionActionState,
    Map<String, SessionArtifactActionState>? artifactActionStates,
    TranscriptExportActionState? transcriptExportActionState,
    List<SessionStagedAttachment>? stagedAttachments,
    List<SessionOptimisticPrompt>? optimisticPrompts,
    Map<String, String>? transcriptClientKeys,
    SessionInterruptPhase? interruptPhase,
    SessionCommandProgress? commandProgress,
    bool? historyPageLoading,
    LocalizedFailure? historyPageError,
    String? historyPageErrorCode,
    bool? historyStartReached,
    int? transcriptResetGeneration,
    SessionDriveRestorePhase? driveRestorePhase,
    SessionDriveRestoreConflict? driveRestoreConflict,
    SessionDraftSurface? draftSurface,
    SessionDraftConflict? draftConflict,
    SessionTransientRetryStatus? transientRetryStatus,
    bool clearError = false,
    bool clearSessionInfo = false,
    bool clearConnectionAuthority = false,
    bool clearJoinExisting = false,
    bool clearArtifactActionStates = false,
    bool clearStagedAttachments = false,
    bool clearOptimisticPrompts = false,
    bool clearCommandProgress = false,
    bool clearHistoryPageError = false,
    bool clearDriveRestoreConflict = false,
    bool clearDraftConflict = false,
    bool clearTransientRetryStatus = false,
  }) {
    return SessionDetailState(
      tool: tool,
      sessionId: sessionId,
      source: source ?? this.source,
      connectionStatus: connectionStatus ?? this.connectionStatus,
      bootstrapState: bootstrapState ?? this.bootstrapState,
      events: events == null ? this.events : List.unmodifiable(events),
      transcriptWindow: transcriptWindow ?? this.transcriptWindow,
      sessionInfo: clearSessionInfo ? null : sessionInfo ?? this.sessionInfo,
      connectionAuthority: clearSessionInfo || clearConnectionAuthority
          ? null
          : connectionAuthority ?? this.connectionAuthority,
      joinExisting: clearSessionInfo || clearJoinExisting
          ? null
          : joinExisting ?? this.joinExisting,
      agentActions: agentActions ?? this.agentActions,
      error: clearError ? null : error ?? this.error,
      renameSessionActionState:
          renameSessionActionState ?? this.renameSessionActionState,
      forkSessionActionState:
          forkSessionActionState ?? this.forkSessionActionState,
      cloneSessionActionState:
          cloneSessionActionState ?? this.cloneSessionActionState,
      artifactActionStates: clearArtifactActionStates
          ? const {}
          : Map.unmodifiable(artifactActionStates ?? this.artifactActionStates),
      transcriptExportActionState:
          transcriptExportActionState ?? this.transcriptExportActionState,
      stagedAttachments: clearStagedAttachments
          ? const []
          : List.unmodifiable(stagedAttachments ?? this.stagedAttachments),
      optimisticPrompts: clearOptimisticPrompts
          ? const []
          : optimisticPrompts == null
          ? this.optimisticPrompts
          : List.unmodifiable(optimisticPrompts),
      transcriptClientKeys: transcriptClientKeys == null
          ? this.transcriptClientKeys
          : Map.unmodifiable(transcriptClientKeys),
      interruptPhase: interruptPhase ?? this.interruptPhase,
      commandProgress: clearCommandProgress
          ? null
          : commandProgress ?? this.commandProgress,
      historyPageLoading: historyPageLoading ?? this.historyPageLoading,
      historyPageError: clearHistoryPageError
          ? null
          : historyPageError ?? this.historyPageError,
      historyPageErrorCode: clearHistoryPageError
          ? null
          : historyPageErrorCode ?? this.historyPageErrorCode,
      historyStartReached: historyStartReached ?? this.historyStartReached,
      transcriptResetGeneration:
          transcriptResetGeneration ?? this.transcriptResetGeneration,
      driveRestorePhase: driveRestorePhase ?? this.driveRestorePhase,
      driveRestoreConflict: clearDriveRestoreConflict
          ? null
          : driveRestoreConflict ?? this.driveRestoreConflict,
      draftSurface: draftSurface ?? this.draftSurface,
      draftConflict: clearDraftConflict
          ? null
          : draftConflict ?? this.draftConflict,
      transientRetryStatus: clearTransientRetryStatus
          ? null
          : transientRetryStatus ?? this.transientRetryStatus,
    );
  }

  /// Returns action state for a specific descriptor.
  SessionArtifactActionState actionStateFor(String actionKey) {
    return artifactActionStates[actionKey] ??
        const SessionArtifactActionState(
          phase: SessionArtifactActionPhase.idle,
        );
  }
}

/// Lifecycle of an agent-turn interrupt request.
enum SessionInterruptPhase {
  /// No interrupt is in flight for the current turn.
  idle,

  /// The stop/abort command is being written to the live transport.
  sending,

  /// The transport accepted the command; wait for the run to leave working.
  requested,
}

/// Result of asking the live session to interrupt its current turn.
enum SessionInterruptOutcome {
  /// The advertised stop/abort command was sent.
  sent,

  /// This session did not advertise a stop/abort action.
  unsupported,

  /// The turn finished before interrupt dispatch was accepted.
  notWorking,

  /// The live connection or session ownership does not allow mutation.
  unavailable,

  /// This turn already has an interrupt in flight or accepted.
  alreadyRequested,

  /// The transport rejected or failed to send the command.
  failed,
}

/// Bounded lifecycle of an automatic Drive restoration attempt.
enum SessionDriveRestorePhase {
  /// No restoration is in flight.
  idle,

  /// A reason-tagged drive attach was sent; waiting for the broker's
  /// arbitration answer.
  restoring,

  /// The broker denied the restore with a structured `attach-conflict`; the
  /// socket continued as Observe and local provenance was preserved.
  conflict,
}

/// Structured result of a denied automatic Drive restoration.
class SessionDriveRestoreConflict {
  /// Creates a conflict record.
  const SessionDriveRestoreConflict({
    required this.reason,
    required this.code,
    required this.message,
  });

  /// The drive-attach reason the client sent.
  final String reason;

  /// Stable machine code from the broker (`DRIVE_OWNERSHIP_CONFLICT`,
  /// `DRIVE_OWNERSHIP_UNKNOWN`, `DRIVE_NATIVE_SESSION_UNRESUMABLE`, or
  /// `DRIVE_RESTORE_FAILED`), or the client-local `DRIVE_RESTORE_TIMEOUT` for
  /// a takeover the broker never confirmed.
  final String code;

  /// Human-readable broker/adapter detail.
  final String message;
}

final Expando<TranscriptHistoryWindow> _legacyTranscriptWindowCache =
    Expando<TranscriptHistoryWindow>('legacy transcript window');
final Expando<_TranscriptHistoryDerived> _transcriptHistoryDerivedCache =
    Expando<_TranscriptHistoryDerived>('transcript history derived');
final Expando<_TranscriptHistoryPresentation>
_transcriptHistoryPresentationCache = Expando<_TranscriptHistoryPresentation>(
  'transcript history presentation',
);
final Expando<_TranscriptHistoryPageDerived> _transcriptHistoryPageCache =
    Expando<_TranscriptHistoryPageDerived>('transcript history page derived');
final Expando<_TranscriptHistoryRunCache> _transcriptHistoryRunCache =
    Expando<_TranscriptHistoryRunCache>('transcript history run derived');
final Expando<_ConversationTurnsByMode> _conversationTurnsByMessages =
    Expando<_ConversationTurnsByMode>('conversation turns by page messages');

/// Test-only counter for proving live-message work is independent of loaded
/// history depth.
final class TranscriptHistoryWorkCounter {
  /// Number of messages inspected while finding an identity.
  int inspectedMessages = 0;

  /// Number of decoded-size estimates performed.
  int estimatedMessages = 0;

  /// Messages scanned to build page-local and contiguous-run canonical state.
  int derivedMessages = 0;

  /// Canonical run messages scanned by optimistic/client-key projection.
  int projectedMessages = 0;

  /// Presented run messages scanned to build conversation turns.
  int conversationMessages = 0;

  /// Contiguous canonical run projections reused without rescanning messages.
  int reusedDerivedRuns = 0;

  /// Conversation-turn lists reused without rebuilding display entries.
  int reusedConversationSegments = 0;
}

/// One decoded, cursor-bounded native history page.
@immutable
final class TranscriptHistoryPage {
  /// Creates one immutable page with optional precomputed byte accounting.
  TranscriptHistoryPage({
    required List<AgentMessage> messages,
    required this.olderCursor,
    required this.newerCursor,
    required this.isTail,
    int? estimatedBytes,
  }) : messages = List<AgentMessage>.unmodifiable(messages),
       estimatedBytes =
           estimatedBytes ??
           messages.fold<int>(
             0,
             (sum, message) => sum + estimatedAgentMessageDecodedBytes(message),
           );

  /// Canonical messages in native chronological order.
  final List<AgentMessage> messages;

  /// Opaque cursor immediately before this page, when more history exists.
  final String? olderCursor;

  /// Opaque cursor immediately after this page; null for the recent tail.
  final String? newerCursor;

  /// Whether this is the separately retained newest tail.
  final bool isTail;

  /// Conservative decoded-size estimate maintained at mutation time.
  final int estimatedBytes;

  /// Whether this page contains [key], with optional work instrumentation.
  bool containsStableKey(String key, {TranscriptHistoryWorkCounter? work}) {
    for (final message in messages) {
      work?.inspectedMessages += 1;
      if (stableTranscriptMessageKey(message) == key) return true;
    }
    return false;
  }
}

/// Why a decoded range is absent between two retained transcript segments.
enum TranscriptHistoryGapKind {
  /// The newer segment carries an opaque boundary that can reload the gap.
  reloadable,

  /// Locally evicted live rows require a fresh attach to recover.
  reconnectRequired,
}

/// Explicit UI/model boundary for omitted decoded messages.
@immutable
final class TranscriptHistoryGapSegment {
  /// Creates an explicit omitted-range boundary.
  const TranscriptHistoryGapSegment({
    required this.id,
    required this.kind,
    this.reloadCursor,
  });

  /// Stable row identity.
  final String id;

  /// Whether this gap can be filled with a page or needs reattach.
  final TranscriptHistoryGapKind kind;

  /// Opaque newer-edge cursor for one backward reload page.
  final String? reloadCursor;
}

/// One cached cursor-contiguous conversation run plus any omitted range before
/// it.
///
/// Page identities survive live tail replacement, so unchanged older
/// [turns] are reused by the production transcript widget rather than rebuilt
/// from the complete active history window.
@immutable
final class TranscriptConversationSegment {
  /// Creates one renderable contiguous-run projection.
  const TranscriptConversationSegment({
    required this.turns,
    this.gapBefore,
  });

  /// Cached conversation turns for this contiguous page run and display mode.
  final List<ConversationTurn> turns;

  /// Explicit missing range before this run.
  final TranscriptHistoryGapSegment? gapBefore;
}

/// Result of accepting one older page into the active decoded window.
@immutable
final class TranscriptHistoryPageMutation {
  /// Creates an insertion result.
  const TranscriptHistoryPageMutation({
    required this.window,
    required this.accepted,
  });

  /// Updated window. Identical to the input when [accepted] is false.
  final TranscriptHistoryWindow window;

  /// Whether the page fit and matched an existing opaque boundary.
  final bool accepted;
}

/// Explicit bounded transcript page table.
///
/// Pages stay in chronological order. Cursor equality proves adjacency.
/// Eviction keeps an active contiguous browsing run plus the recent tail and
/// leaves a reloadable gap instead of flattening non-contiguous rows into one
/// ordinary transcript.
@immutable
final class TranscriptHistoryWindow {
  /// Sentinel used before the first transcript-bearing frame.
  const TranscriptHistoryWindow.uninitialized()
    : initialized = false,
      pages = const [],
      historyCursor = null,
      latestHistoryGap = null,
      latestHistoryTruncation = null,
      liveState = null,
      telemetry = SessionTelemetry.empty,
      tailPrefixEvicted = false;

  const TranscriptHistoryWindow._({
    required this.pages,
    required this.historyCursor,
    required this.latestHistoryGap,
    required this.latestHistoryTruncation,
    required this.liveState,
    required this.telemetry,
    required this.tailPrefixEvicted,
  }) : initialized = true;

  /// Builds a bounded tail from one authoritative history frame.
  factory TranscriptHistoryWindow.fromHistory(HistoryWireEvent event) {
    final tailMessages = List<AgentMessage>.of(event.messages);
    var tailBytes = tailMessages.fold<int>(
      0,
      (sum, message) => sum + estimatedAgentMessageDecodedBytes(message),
    );
    var prefixEvicted = false;
    while (tailMessages.length > kRetainedTranscriptTailMessages ||
        tailBytes > kMaxActiveTranscriptDecodedBytes) {
      if (tailMessages.isEmpty) break;
      tailBytes -= estimatedAgentMessageDecodedBytes(tailMessages.removeAt(0));
      prefixEvicted = true;
    }
    final tail = TranscriptHistoryPage(
      messages: tailMessages,
      olderCursor: event.olderCursor,
      newerCursor: null,
      isTail: true,
      estimatedBytes: tailBytes,
    );
    return TranscriptHistoryWindow._(
      pages: List.unmodifiable([tail]),
      historyCursor: event.cursor,
      latestHistoryGap: event.gap,
      latestHistoryTruncation: prefixEvicted
          ? HistoryTruncation(
              shown: tailMessages.length,
              total: event.truncated?.total ?? event.messages.length,
            )
          : event.truncated,
      liveState: SessionLiveState.fromMessages(tailMessages),
      telemetry: SessionTelemetry.fromMessages(tailMessages),
      tailPrefixEvicted: prefixEvicted,
    );
  }

  /// Legacy fixture adapter. Production controller state never reduces its
  /// transcript from the event log.
  factory TranscriptHistoryWindow.fromEvents(List<WireEvent> events) {
    var window = const TranscriptHistoryWindow.uninitialized();
    for (final event in events) {
      switch (event) {
        case HistoryWireEvent():
          window = window.applyHistory(event);
        case HistoryPageWireEvent():
          final requestedCursor = window.olderHistoryCursor;
          if (requestedCursor != null) {
            window = window
                .prependPage(event, requestedCursor: requestedCursor)
                .window;
          }
        case MessageWireEvent(:final message):
          window = window.applyLiveMessage(message);
        case _:
          break;
      }
    }
    return window.initialized
        ? window
        : TranscriptHistoryWindow._(
            pages: const [],
            historyCursor: null,
            latestHistoryGap: null,
            latestHistoryTruncation: null,
            liveState: SessionLiveState.fromMessages(const []),
            telemetry: SessionTelemetry.empty,
            tailPrefixEvicted: false,
          );
  }

  /// Whether this table has consumed at least one transcript frame.
  final bool initialized;

  /// Retained pages in chronological order.
  final List<TranscriptHistoryPage> pages;

  /// Latest reconnect cursor represented by the recent tail.
  final String? historyCursor;

  /// Latest authoritative reconnect-gap metadata.
  final HistoryGap? latestHistoryGap;

  /// Latest authoritative initial-tail truncation metadata.
  final HistoryTruncation? latestHistoryTruncation;

  /// Incremental latest-wins state projection.
  final SessionLiveState? liveState;

  /// Incremental latest telemetry projection.
  final SessionTelemetry telemetry;

  /// The retained tail discarded older local rows that have no opaque native
  /// boundary. This is surfaced as reconnect-required, never hidden.
  final bool tailPrefixEvicted;

  _TranscriptHistoryDerived get _derived {
    final cached = _transcriptHistoryDerivedCache[this];
    if (cached != null) return cached;
    final derived = _TranscriptHistoryDerived.fromWindow(this);
    _transcriptHistoryDerivedCache[this] = derived;
    return derived;
  }

  /// Identity-deduplicated canonical messages, built lazily for rendering.
  List<AgentMessage> get canonicalMessages => _derived.canonicalMessages;

  /// Canonical transcript rows excluding state/telemetry frames.
  List<AgentMessage> get transcriptMessages => _derived.transcriptMessages;

  /// Active terminal-output rows.
  List<AgentMessage> get terminalOutputMessages =>
      List<AgentMessage>.unmodifiable(
        pages.expand(
          (page) => _pageDerived(page).terminalOutputMessages,
        ),
      );

  /// Active file-artifact rows.
  List<AgentMessage> get fileArtifactMessages =>
      List<AgentMessage>.unmodifiable(
        pages.expand(
          (page) => _pageDerived(page).fileArtifactMessages,
        ),
      );

  /// Active file-artifact descriptors.
  List<SessionArtifactDescriptor> get fileArtifactDescriptors =>
      List<SessionArtifactDescriptor>.unmodifiable(
        pages.expand(
          (page) => _pageDerived(page).fileArtifactDescriptors,
        ),
      );

  /// Explicit omitted ranges between retained contiguous runs.
  List<TranscriptHistoryGapSegment> get gaps => _derived.gaps;

  /// Explicit gap before the first segment, if local tail trimming created one.
  TranscriptHistoryGapSegment? get leadingGap =>
      tailPrefixEvicted && (pages.isEmpty || pages.first.isTail)
      ? const TranscriptHistoryGapSegment(
          id: 'history-gap-leading-local',
          kind: TranscriptHistoryGapKind.reconnectRequired,
        )
      : null;

  /// Whether any retained page has a renderable transcript message.
  bool get hasTranscriptMessages {
    for (final page in pages) {
      if (_pageDerived(page).transcriptMessages.isNotEmpty) return true;
    }
    return false;
  }

  /// Latest request resolutions folded from page-local projections.
  Map<String, String?> get resolvedRequestDecisions {
    final result = <String, String?>{};
    for (final page in pages) {
      result.addAll(_pageDerived(page).resolvedRequestDecisions);
    }
    return Map<String, String?>.unmodifiable(result);
  }

  /// Cursor immediately before the oldest retained browsing run.
  String? get olderHistoryCursor {
    if (pages.isEmpty) return null;
    return pages.first.olderCursor;
  }

  /// Whether the oldest retained run has another native page before it.
  bool get hasEarlierHistory => olderHistoryCursor != null;

  /// Total estimated decoded bytes retained by all pages.
  int get estimatedBytes =>
      pages.fold<int>(0, (sum, page) => sum + page.estimatedBytes);

  /// Total raw message slots retained by all pages.
  int get messageCount =>
      pages.fold<int>(0, (sum, page) => sum + page.messages.length);

  /// Flat optimistic/decorated transcript projection.
  List<AgentMessage> transcriptMessagesWith(
    List<SessionOptimisticPrompt> optimisticPrompts,
    Map<String, String> clientKeys,
  ) => _presentation(optimisticPrompts, clientKeys).messages;

  /// Optimistic/decorated transcript runs that never cross a decoded gap.
  List<List<AgentMessage>> transcriptMessageSegmentsWith(
    List<SessionOptimisticPrompt> optimisticPrompts,
    Map<String, String> clientKeys,
  ) => _presentation(optimisticPrompts, clientKeys).segments;

  /// Builds cached production conversation descriptors for contiguous runs.
  ///
  /// Each immutable page owns its canonical projection. A run projection
  /// preserves conversation/tool grouping across adjacent page boundaries,
  /// while a prewarmed prefix excluding the mutable tail lets the next live
  /// update reuse every older turn descriptor.
  List<TranscriptConversationSegment> transcriptConversationSegmentsWith(
    List<SessionOptimisticPrompt> optimisticPrompts,
    Map<String, String> clientKeys, {
    required ToolDisplayMode mode,
    TranscriptHistoryWorkCounter? work,
  }) {
    if (pages.isEmpty) return const [];
    final pageRuns = <List<TranscriptHistoryPage>>[];
    final gapsBeforeRuns = <TranscriptHistoryGapSegment?>[];
    for (final page in pages) {
      if (pageRuns.isEmpty) {
        pageRuns.add([page]);
        gapsBeforeRuns.add(null);
        continue;
      }
      final gap = _historyGapBetween(
        pageRuns.last.last,
        page,
        tailPrefixEvicted: tailPrefixEvicted,
      );
      // The recent tail is a presentation checkpoint even when its cursor is
      // adjacent. Only that page changes under streaming; keeping the older
      // run separate lets it retain canonical/turn identity. A partial first
      // tail turn is stitched to the older run below without inventing a gap.
      if (gap == null && !page.isTail) {
        pageRuns.last.add(page);
      } else {
        pageRuns.add([page]);
        gapsBeforeRuns.add(gap);
      }
    }

    // Release first: a page that just stopped owning a run still holds the run
    // it owned last frame, whose pages may already be evicted.
    _releaseNonOwnerRunCaches(pages, pageRuns);
    final derivedRuns = [
      for (final run in pageRuns) _runDerived(run, work: work),
    ];
    final promptBuckets = List<List<SessionOptimisticPrompt>?>.filled(
      pageRuns.length,
      null,
    );
    var runFloor = 0;
    for (final prompt in optimisticPrompts) {
      final deliveredKey = prompt.deliveredMessageKey;
      final anchorKey = prompt.anchorMessageKey;
      final int target;
      if (deliveredKey != null) {
        final runIndex = derivedRuns.indexWhere(
          (run) => run.stableKeys.contains(deliveredKey),
        );
        // A delivered holder whose echo no run carries renders nothing (the
        // run projection skips it). Bucketing it to the last run would only
        // drag every later prompt down through the monotonic floor.
        if (runIndex < 0) continue;
        target = runIndex;
      } else if (anchorKey != null) {
        final runIndex = derivedRuns.indexWhere(
          (run) => run.stableKeys.contains(anchorKey),
        );
        // A pending prompt has no canonical row; when its anchor is gone the
        // last run is the reserved fallback.
        target = runIndex < 0 ? pageRuns.length - 1 : runIndex;
      } else {
        target = 0;
      }
      final resolved = target < runFloor ? runFloor : target;
      runFloor = resolved;
      (promptBuckets[resolved] ??= <SessionOptimisticPrompt>[]).add(prompt);
    }

    final result = <TranscriptConversationSegment>[];
    for (var index = 0; index < pageRuns.length; index++) {
      final messages = derivedRuns[index].present(
        optimisticPrompts: promptBuckets[index] ?? const [],
        clientKeys: clientKeys,
        work: work,
      );
      final turns = _conversationTurnsForRun(
        messages,
        mode: mode,
        work: work,
      );
      var presentedTurns = turns;
      if (index > 0 &&
          gapsBeforeRuns[index] == null &&
          turns.isNotEmpty &&
          turns.first.isPartial &&
          result.last.turns.isNotEmpty) {
        final stitched = _stitchConversationBoundary(
          result.last.turns,
          turns,
        );
        final previous = result.last;
        result[result.length - 1] = TranscriptConversationSegment(
          turns: stitched.previous,
          gapBefore: previous.gapBefore,
        );
        presentedTurns = stitched.current;
      }
      result.add(
        TranscriptConversationSegment(
          turns: presentedTurns,
          gapBefore: gapsBeforeRuns[index],
        ),
      );
    }
    return List<TranscriptConversationSegment>.unmodifiable(result);
  }

  _TranscriptHistoryPresentation _presentation(
    List<SessionOptimisticPrompt> optimisticPrompts,
    Map<String, String> clientKeys,
  ) {
    final cached = _transcriptHistoryPresentationCache[this];
    if (cached != null &&
        identical(cached.optimisticPrompts, optimisticPrompts) &&
        identical(cached.clientKeys, clientKeys)) {
      return cached;
    }
    final projected = projectOptimisticTranscriptMessages(
      transcriptMessages,
      optimisticPrompts,
      clientKeys,
    );
    final boundaryKeys = _derived.segmentStartKeys.skip(1).toSet();
    final result = <List<AgentMessage>>[];
    var current = <AgentMessage>[];
    for (final message in projected) {
      final key = stableTranscriptMessageKey(message);
      if (current.isNotEmpty && key != null && boundaryKeys.contains(key)) {
        result.add(List.unmodifiable(current));
        current = <AgentMessage>[];
      }
      current.add(message);
    }
    if (current.isNotEmpty || result.isEmpty) {
      result.add(List.unmodifiable(current));
    }
    final presentation = _TranscriptHistoryPresentation(
      optimisticPrompts: optimisticPrompts,
      clientKeys: clientKeys,
      messages: projected,
      segments: List.unmodifiable(result),
    );
    _transcriptHistoryPresentationCache[this] = presentation;
    return presentation;
  }

  /// Applies an authoritative replay/delta. A reset starts a new cursor epoch;
  /// an incremental frame reconciles the recent tail into the frame's
  /// native/source order (see [_applyHistoryDelta]).
  TranscriptHistoryWindow applyHistory(
    HistoryWireEvent event, {
    String? preserveMessageKey,
  }) {
    if (!initialized) {
      return TranscriptHistoryWindow.fromHistory(event);
    }
    if (event.reset) {
      final replacement = TranscriptHistoryWindow.fromHistory(event);
      if (preserveMessageKey == null ||
          replacement.pages.any(
            (page) => page.containsStableKey(preserveMessageKey),
          )) {
        return replacement;
      }
      final anchorPageIndex = pages.indexWhere(
        (page) => page.containsStableKey(preserveMessageKey),
      );
      if (anchorPageIndex < 0) return replacement;

      // A reconnect reset authoritatively replaces the live tail, but browser
      // suspension must not discard the bounded page the user is reading.
      // Keep that one payload page as a disconnected history run until the
      // viewport remount settles or explicitly moves its protection.
      final replacementKeys = <String>{};
      for (final page in replacement.pages) {
        for (final message in page.messages) {
          final key = stableTranscriptMessageKey(message);
          if (key != null) replacementKeys.add(key);
        }
      }
      final anchorMessages = <AgentMessage>[];
      for (final message in pages[anchorPageIndex].messages) {
        final key = stableTranscriptMessageKey(message);
        if (key == null || !replacementKeys.contains(key)) {
          anchorMessages.add(message);
        }
      }
      var protectedIndex = anchorMessages.indexWhere(
        (message) => stableTranscriptMessageKey(message) == preserveMessageKey,
      );
      if (protectedIndex < 0) {
        return replacement;
      }
      final oldAnchorPage = pages[anchorPageIndex];
      var anchorBytes = anchorMessages.fold<int>(
        0,
        (sum, message) => sum + estimatedAgentMessageDecodedBytes(message),
      );
      final availableBytes =
          kMaxActiveTranscriptDecodedBytes - replacement.estimatedBytes;
      while (anchorBytes > availableBytes && anchorMessages.length > 1) {
        final removeFromStart =
            protectedIndex > anchorMessages.length - protectedIndex - 1;
        final removed = removeFromStart
            ? anchorMessages.removeAt(0)
            : anchorMessages.removeLast();
        if (removeFromStart) protectedIndex--;
        anchorBytes -= estimatedAgentMessageDecodedBytes(removed);
      }
      if (anchorBytes > availableBytes) return replacement;
      final retainedAnchorPage = TranscriptHistoryPage(
        messages: anchorMessages,
        olderCursor: oldAnchorPage.olderCursor,
        newerCursor: oldAnchorPage.newerCursor,
        isTail: false,
        estimatedBytes: anchorBytes,
      );
      return TranscriptHistoryWindow._(
        pages: List.unmodifiable([
          retainedAnchorPage,
          ...replacement.pages,
        ]),
        historyCursor: replacement.historyCursor,
        latestHistoryGap: replacement.latestHistoryGap,
        latestHistoryTruncation: replacement.latestHistoryTruncation,
        liveState: replacement.liveState,
        telemetry: replacement.telemetry,
        tailPrefixEvicted: true,
      );
    }
    var next = this;
    if (event.messages.isNotEmpty) {
      next = next._applyHistoryDelta(event.messages);
    }
    var nextPages = next.pages;
    if (event.olderCursor != null && nextPages.isNotEmpty) {
      final tailIndex = nextPages.lastIndexWhere((page) => page.isTail);
      final tail = nextPages[tailIndex];
      nextPages = List.unmodifiable([
        ...nextPages.take(tailIndex),
        TranscriptHistoryPage(
          messages: tail.messages,
          olderCursor: event.olderCursor,
          newerCursor: null,
          isTail: true,
          estimatedBytes: tail.estimatedBytes,
        ),
        ...nextPages.skip(tailIndex + 1),
      ]);
    }
    return TranscriptHistoryWindow._(
      pages: nextPages,
      historyCursor: event.cursor ?? next.historyCursor,
      latestHistoryGap: event.gap,
      latestHistoryTruncation: event.truncated ?? next.latestHistoryTruncation,
      liveState: next.liveState,
      telemetry: next.telemetry,
      tailPrefixEvicted: next.tailPrefixEvicted,
    );
  }

  /// This window, guaranteed to hold at least one writable tail page.
  ///
  /// An INITIALIZED window can still hold zero pages — the legacy event
  /// reduce yields one when no transcript-bearing frame ever arrived, which
  /// is exactly the state a transcript export appends its artifact into. Both
  /// that and the uninitialized sentinel need a tail page to append through,
  /// or the tail lookup below indexes an empty list and throws. Carry the
  /// window's own metadata over so bootstrapping never discards a cursor,
  /// gap, or telemetry the window already established.
  TranscriptHistoryWindow get _tailWritableBase =>
      initialized && pages.isNotEmpty
      ? this
      : TranscriptHistoryWindow._(
          pages: [
            TranscriptHistoryPage(
              messages: const [],
              olderCursor: null,
              newerCursor: null,
              isTail: true,
              estimatedBytes: 0,
            ),
          ],
          historyCursor: historyCursor,
          latestHistoryGap: latestHistoryGap,
          latestHistoryTruncation: latestHistoryTruncation,
          liveState: liveState ?? SessionLiveState.fromMessages(const []),
          telemetry: telemetry,
          tailPrefixEvicted: tailPrefixEvicted,
        );

  /// Applies one live message by inspecting at most the 100-message tail in
  /// the common append/stream-update path.
  TranscriptHistoryWindow applyLiveMessage(
    AgentMessage message, {
    TranscriptHistoryWorkCounter? work,
  }) {
    final base = _tailWritableBase;
    final tailIndex = base.pages.lastIndexWhere((page) => page.isTail);
    final safeTailIndex = tailIndex < 0 ? base.pages.length - 1 : tailIndex;
    final tail = base.pages[safeTailIndex];
    final nextTailMessages = List<AgentMessage>.of(tail.messages);
    final key = stableTranscriptMessageKey(message);
    var existingIndex = -1;
    if (key != null) {
      for (var index = 0; index < nextTailMessages.length; index++) {
        work?.inspectedMessages += 1;
        if (stableTranscriptMessageKey(nextTailMessages[index]) == key) {
          existingIndex = index;
          break;
        }
      }
    }
    var nextBytes = tail.estimatedBytes;
    if (existingIndex >= 0) {
      final previous = nextTailMessages[existingIndex];
      final merged = mergeStableTranscriptMessage(previous, message);
      work?.estimatedMessages += 2;
      nextBytes -= estimatedAgentMessageDecodedBytes(previous);
      nextBytes += estimatedAgentMessageDecodedBytes(merged);
      nextTailMessages[existingIndex] = merged;
    } else {
      work?.estimatedMessages += 1;
      nextTailMessages.add(message);
      nextBytes += estimatedAgentMessageDecodedBytes(message);
    }
    var prefixEvicted = base.tailPrefixEvicted;
    while (nextTailMessages.length > kRetainedTranscriptTailMessages ||
        nextBytes > kMaxActiveTranscriptDecodedBytes) {
      if (nextTailMessages.isEmpty) break;
      work?.estimatedMessages += 1;
      nextBytes -= estimatedAgentMessageDecodedBytes(
        nextTailMessages.removeAt(0),
      );
      prefixEvicted = true;
    }
    final nextTail = TranscriptHistoryPage(
      messages: nextTailMessages,
      olderCursor: tail.olderCursor,
      newerCursor: null,
      isTail: true,
      estimatedBytes: nextBytes,
    );
    final nextPages = List<TranscriptHistoryPage>.of(base.pages);
    if (nextPages.isEmpty) {
      nextPages.add(nextTail);
    } else {
      nextPages[safeTailIndex] = nextTail;
    }
    return TranscriptHistoryWindow._(
      pages: List.unmodifiable(nextPages),
      historyCursor: base.historyCursor,
      latestHistoryGap: base.latestHistoryGap,
      latestHistoryTruncation: base.latestHistoryTruncation,
      liveState: (base.liveState ?? SessionLiveState.fromMessages(const []))
          .applyMessage(message),
      telemetry: base.telemetry.applyMessage(message),
      tailPrefixEvicted: prefixEvicted,
    );
  }

  /// Applies one authoritative incremental history frame to the recent tail.
  ///
  /// Unlike live delivery, the frame carries native/source order, so it can
  /// REPAIR order, not just extend it: a row the tail never retained (missed
  /// live delivery, cache restore) returns to its authoritative position
  /// among the rows the frame shares with the tail instead of appending
  /// behind an already-retained later row. Older pages, cursor identity, and
  /// the H1/H1c bounds are untouched — the reconciliation writes only the
  /// bounded tail page.
  TranscriptHistoryWindow _applyHistoryDelta(List<AgentMessage> messages) {
    final base = _tailWritableBase;
    final tailIndex = base.pages.lastIndexWhere((page) => page.isTail);
    final safeTailIndex = tailIndex < 0 ? base.pages.length - 1 : tailIndex;
    final tail = base.pages[safeTailIndex];
    final nextTailMessages = List<AgentMessage>.of(
      reconcileTranscriptHistoryDelta(
        retained: tail.messages,
        frame: messages,
      ),
    );
    var nextBytes = nextTailMessages.fold<int>(
      0,
      (sum, message) => sum + estimatedAgentMessageDecodedBytes(message),
    );
    var prefixEvicted = base.tailPrefixEvicted;
    while (nextTailMessages.length > kRetainedTranscriptTailMessages ||
        nextBytes > kMaxActiveTranscriptDecodedBytes) {
      if (nextTailMessages.isEmpty) break;
      nextBytes -= estimatedAgentMessageDecodedBytes(
        nextTailMessages.removeAt(0),
      );
      prefixEvicted = true;
    }
    final nextTail = TranscriptHistoryPage(
      messages: nextTailMessages,
      olderCursor: tail.olderCursor,
      newerCursor: null,
      isTail: true,
      estimatedBytes: nextBytes,
    );
    final nextPages = List<TranscriptHistoryPage>.of(base.pages);
    nextPages[safeTailIndex] = nextTail;
    var liveState = base.liveState ?? SessionLiveState.fromMessages(const []);
    var telemetry = base.telemetry;
    for (final message in messages) {
      liveState = liveState.applyMessage(message);
      telemetry = telemetry.applyMessage(message);
    }
    return TranscriptHistoryWindow._(
      pages: List.unmodifiable(nextPages),
      historyCursor: base.historyCursor,
      latestHistoryGap: base.latestHistoryGap,
      latestHistoryTruncation: base.latestHistoryTruncation,
      liveState: liveState,
      telemetry: telemetry,
      tailPrefixEvicted: prefixEvicted,
    );
  }

  /// Inserts one page at the exact requested opaque boundary.
  TranscriptHistoryPageMutation prependPage(
    HistoryPageWireEvent event, {
    required String requestedCursor,
    String? preserveMessageKey,
    TranscriptHistoryWorkCounter? work,
  }) {
    if (!initialized || requestedCursor.isEmpty) {
      return TranscriptHistoryPageMutation(window: this, accepted: false);
    }
    final pageBytes = event.messages.fold<int>(0, (sum, message) {
      work?.estimatedMessages += 1;
      return sum + estimatedAgentMessageDecodedBytes(message);
    });
    if (pageBytes > kMaxActiveTranscriptDecodedBytes) {
      return TranscriptHistoryPageMutation(window: this, accepted: false);
    }
    final insertionIndex = pages.indexWhere(
      (page) => page.olderCursor == requestedCursor,
    );
    if (insertionIndex < 0) {
      return TranscriptHistoryPageMutation(window: this, accepted: false);
    }
    final inserted = TranscriptHistoryPage(
      messages: event.messages,
      olderCursor: event.hasMore ? event.cursor : null,
      newerCursor: requestedCursor,
      isTail: false,
      estimatedBytes: pageBytes,
    );
    final candidate = <TranscriptHistoryPage>[
      ...pages.take(insertionIndex),
      inserted,
      ...pages.skip(insertionIndex),
    ];
    final insertedIndex = insertionIndex;
    var anchorIndex = -1;
    if (preserveMessageKey != null) {
      anchorIndex = candidate.indexWhere(
        (page) => page.containsStableKey(preserveMessageKey, work: work),
      );
    }
    if (anchorIndex < 0) {
      anchorIndex = (insertedIndex + 1).clamp(0, candidate.length - 1);
    }

    final required = <int>{
      insertedIndex,
      anchorIndex,
      candidate.lastIndexWhere((page) => page.isTail),
    }..remove(-1);
    var retainedBytes = required.fold<int>(
      0,
      (sum, index) => sum + candidate[index].estimatedBytes,
    );
    var retainedMessages = required.fold<int>(
      0,
      (sum, index) => sum + candidate[index].messages.length,
    );
    if (retainedBytes > kMaxActiveTranscriptDecodedBytes ||
        retainedMessages > kMaxActiveTranscriptMessages) {
      return TranscriptHistoryPageMutation(window: this, accepted: false);
    }

    final priority = <int>[];
    for (var distance = 1; distance < candidate.length; distance++) {
      for (final center in [insertedIndex, anchorIndex]) {
        final older = center - distance;
        final newer = center + distance;
        if (older >= 0 && !priority.contains(older)) priority.add(older);
        if (newer < candidate.length && !priority.contains(newer)) {
          priority.add(newer);
        }
      }
    }
    for (final index in priority) {
      if (required.contains(index) ||
          required.length >= kMaxActiveTranscriptPages) {
        continue;
      }
      final page = candidate[index];
      if (retainedBytes + page.estimatedBytes >
              kMaxActiveTranscriptDecodedBytes ||
          retainedMessages + page.messages.length >
              kMaxActiveTranscriptMessages) {
        continue;
      }
      required.add(index);
      retainedBytes += page.estimatedBytes;
      retainedMessages += page.messages.length;
    }
    final ordered = required.toList()..sort();
    return TranscriptHistoryPageMutation(
      accepted: true,
      window: TranscriptHistoryWindow._(
        pages: List.unmodifiable([
          for (final index in ordered) candidate[index],
        ]),
        historyCursor: historyCursor,
        latestHistoryGap: latestHistoryGap,
        // The attach-tail count no longer describes the active page table once
        // one older page is present. Explicit gaps carry the truthful scope.
        latestHistoryTruncation: null,
        liveState: liveState,
        telemetry: telemetry,
        tailPrefixEvicted: tailPrefixEvicted,
      ),
    );
  }
}

_TranscriptHistoryPageDerived _pageDerived(
  TranscriptHistoryPage page, {
  TranscriptHistoryWorkCounter? work,
}) {
  final cached = _transcriptHistoryPageCache[page];
  if (cached != null) return cached;
  final derived = _TranscriptHistoryPageDerived.fromPage(page, work: work);
  _transcriptHistoryPageCache[page] = derived;
  return derived;
}

final class _TranscriptHistoryPageDerived {
  _TranscriptHistoryPageDerived({
    required this.canonicalMessages,
    required this.transcriptMessages,
    required this.resolvedRequestDecisions,
    required this.terminalOutputMessages,
    required this.fileArtifactMessages,
    required this.fileArtifactDescriptors,
  });

  factory _TranscriptHistoryPageDerived.fromPage(
    TranscriptHistoryPage page, {
    TranscriptHistoryWorkCounter? work,
  }) {
    work?.derivedMessages += page.messages.length;
    final canonical = <AgentMessage>[];
    final indexByKey = <String, int>{};
    for (final message in page.messages) {
      final key = stableTranscriptMessageKey(message);
      final existingIndex = key == null ? null : indexByKey[key];
      if (existingIndex == null) {
        if (key != null) indexByKey[key] = canonical.length;
        canonical.add(message);
      } else {
        canonical[existingIndex] = mergeStableTranscriptMessage(
          canonical[existingIndex],
          message,
        );
      }
    }
    final transcript = List<AgentMessage>.unmodifiable(
      canonical.where(
        (message) =>
            !isSessionLiveStateMessage(message) &&
            !isSessionTelemetryMessage(message),
      ),
    );
    final resolutions = <String, String?>{};
    for (final message in canonical) {
      if (message.type != AgentMessageType.permissionResolved &&
          message.type != AgentMessageType.questionResolved) {
        continue;
      }
      final requestId = extractRequestIdFromMessage(message);
      if (requestId == null) continue;
      resolutions[requestId] = message.raw['decision'] is String
          ? message.raw['decision'] as String
          : null;
    }
    return _TranscriptHistoryPageDerived(
      canonicalMessages: List<AgentMessage>.unmodifiable(canonical),
      transcriptMessages: transcript,
      resolvedRequestDecisions: Map<String, String?>.unmodifiable(resolutions),
      terminalOutputMessages: List<AgentMessage>.unmodifiable(
        canonical.where(
          (message) => message.type == AgentMessageType.terminalOutput,
        ),
      ),
      fileArtifactMessages: List<AgentMessage>.unmodifiable(
        canonical.where(
          (message) => message.type == AgentMessageType.fileArtifact,
        ),
      ),
      fileArtifactDescriptors: List<SessionArtifactDescriptor>.unmodifiable(
        canonical
            .where(
              (message) => message.type == AgentMessageType.fileArtifact,
            )
            .map(SessionArtifactDescriptor.fromMessage)
            .whereType<SessionArtifactDescriptor>(),
      ),
    );
  }

  final List<AgentMessage> canonicalMessages;
  final List<AgentMessage> transcriptMessages;
  final Map<String, String?> resolvedRequestDecisions;
  final List<AgentMessage> terminalOutputMessages;
  final List<AgentMessage> fileArtifactMessages;
  final List<SessionArtifactDescriptor> fileArtifactDescriptors;
}

_TranscriptHistoryRunDerived _runDerived(
  List<TranscriptHistoryPage> pages, {
  TranscriptHistoryWorkCounter? work,
}) {
  final owner = pages.first;
  final cache =
      _transcriptHistoryRunCache[owner] ?? _TranscriptHistoryRunCache();
  _transcriptHistoryRunCache[owner] = cache;
  final cached = cache.lookup(pages);
  if (cached != null) {
    work?.reusedDerivedRuns += 1;
    return cached;
  }
  final derived = _TranscriptHistoryRunDerived.fromPages(pages, work: work);
  cache.entry = derived;
  return derived;
}

/// Test-only count of derived run projections still reachable through [page]
/// as a run owner.
@visibleForTesting
int debugRetainedDerivedRunCount(TranscriptHistoryPage page) =>
    _transcriptHistoryRunCache[page]?.entry == null ? 0 : 1;

/// Test-only view of the pages a run cache keeps alive through [page].
///
/// This is the memory-contract surface: whatever these pages hold — messages,
/// canonical keys, presentation — stays resident, so the retained set must be
/// a subset of the active window rather than merely a bounded entry count.
@visibleForTesting
List<TranscriptHistoryPage> debugRetainedDerivedRunPages(
  TranscriptHistoryPage page,
) => _transcriptHistoryRunCache[page]?.entry?.pages ?? const [];

bool _samePageRun(
  List<TranscriptHistoryPage> left,
  List<TranscriptHistoryPage> right,
) {
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index++) {
    if (!identical(left[index], right[index])) return false;
  }
  return true;
}

/// The one derived run projection retained per owner page.
///
/// A run projection pins every page it spans, so caching more than the CURRENT
/// run would keep pages the active window has already evicted — H1's
/// five-page/4 MiB contract would then bound the window but not memory. One
/// owner can be asked for several page combinations (reloading and evicting a
/// middle gap keeps a run's oldest page alive while the rest of the run
/// changes), and every superseded combination is exactly the case that must
/// NOT survive. Holding a single entry keeps retention a strict subset of the
/// active window; [_releaseNonOwnerRunCaches] covers the other direction, a
/// page that stops being an owner at all.
final class _TranscriptHistoryRunCache {
  /// The current run projection. Assigning a new one releases the superseded
  /// run, and with it every page only that run still referenced.
  _TranscriptHistoryRunDerived? entry;

  /// Returns the derived projection for [pages] when it is the current one.
  _TranscriptHistoryRunDerived? lookup(List<TranscriptHistoryPage> pages) {
    final cached = entry;
    if (cached == null || !_samePageRun(cached.pages, pages)) return null;
    return cached;
  }
}

/// Drops the run cache of every active page that no longer owns a run.
///
/// Eviction and gap reloads reshape runs, so a page that was an owner one
/// frame ago can become a mid-run member the next. Its cached projection would
/// still span the run it owned back then — including pages since evicted — and
/// the page is still reachable from the window, so nothing else would ever
/// release it.
void _releaseNonOwnerRunCaches(
  List<TranscriptHistoryPage> pages,
  List<List<TranscriptHistoryPage>> pageRuns,
) {
  final owners = <TranscriptHistoryPage>{
    for (final run in pageRuns) run.first,
  };
  for (final page in pages) {
    if (owners.contains(page)) continue;
    _transcriptHistoryRunCache[page] = null;
  }
}

final class _TranscriptHistoryRunDerived {
  _TranscriptHistoryRunDerived({
    required this.pages,
    required this.transcriptMessages,
    required this.stableKeys,
  });

  factory _TranscriptHistoryRunDerived.fromPages(
    List<TranscriptHistoryPage> pages, {
    TranscriptHistoryWorkCounter? work,
  }) {
    final canonical = <AgentMessage>[];
    final indexByKey = <String, int>{};
    for (final page in pages) {
      final pageMessages = _pageDerived(page, work: work).canonicalMessages;
      work?.derivedMessages += pageMessages.length;
      for (final message in pageMessages) {
        final key = stableTranscriptMessageKey(message);
        final existingIndex = key == null ? null : indexByKey[key];
        if (existingIndex == null) {
          if (key != null) indexByKey[key] = canonical.length;
          canonical.add(message);
        } else {
          canonical[existingIndex] = mergeStableTranscriptMessage(
            canonical[existingIndex],
            message,
          );
        }
      }
    }
    return _TranscriptHistoryRunDerived(
      pages: List<TranscriptHistoryPage>.unmodifiable(pages),
      transcriptMessages: List<AgentMessage>.unmodifiable(
        canonical.where(
          (message) =>
              !isSessionLiveStateMessage(message) &&
              !isSessionTelemetryMessage(message),
        ),
      ),
      stableKeys: Set<String>.unmodifiable(indexByKey.keys),
    );
  }

  final List<TranscriptHistoryPage> pages;
  final List<AgentMessage> transcriptMessages;
  final Set<String> stableKeys;
  _TranscriptHistoryRunPresentation? _presentation;

  List<AgentMessage> present({
    required List<SessionOptimisticPrompt> optimisticPrompts,
    required Map<String, String> clientKeys,
    TranscriptHistoryWorkCounter? work,
  }) {
    final relevantClientKeys = <String, String>{
      for (final entry in clientKeys.entries)
        if (stableKeys.contains(entry.key)) entry.key: entry.value,
    };
    final cached = _presentation;
    if (cached != null &&
        listEquals(cached.optimisticPrompts, optimisticPrompts) &&
        mapEquals(cached.clientKeys, relevantClientKeys)) {
      return cached.messages;
    }
    work?.projectedMessages += transcriptMessages.length;
    final messages = projectOptimisticTranscriptMessages(
      transcriptMessages,
      optimisticPrompts,
      relevantClientKeys,
    );
    _presentation = _TranscriptHistoryRunPresentation(
      optimisticPrompts: List<SessionOptimisticPrompt>.unmodifiable(
        optimisticPrompts,
      ),
      clientKeys: Map<String, String>.unmodifiable(relevantClientKeys),
      messages: messages,
    );
    return messages;
  }
}

final class _TranscriptHistoryRunPresentation {
  const _TranscriptHistoryRunPresentation({
    required this.optimisticPrompts,
    required this.clientKeys,
    required this.messages,
  });

  final List<SessionOptimisticPrompt> optimisticPrompts;
  final Map<String, String> clientKeys;
  final List<AgentMessage> messages;
}

final class _ConversationTurnsByMode {
  final Map<ToolDisplayMode, List<ConversationTurn>> values = {};
}

List<ConversationTurn> _conversationTurnsForRun(
  List<AgentMessage> messages, {
  required ToolDisplayMode mode,
  TranscriptHistoryWorkCounter? work,
}) {
  final cache =
      _conversationTurnsByMessages[messages] ?? _ConversationTurnsByMode();
  _conversationTurnsByMessages[messages] = cache;
  final cached = cache.values[mode];
  if (cached != null) {
    work?.reusedConversationSegments += 1;
    return cached;
  }
  work?.conversationMessages += messages.length;
  final turns = buildConversationTurns(messages: messages, mode: mode);
  cache.values[mode] = turns;
  return turns;
}

({List<ConversationTurn> previous, List<ConversationTurn> current})
_stitchConversationBoundary(
  List<ConversationTurn> previous,
  List<ConversationTurn> current,
) {
  final left = previous.last;
  final right = current.first;
  final mergedModelText = left.modelText.isEmpty
      ? right.modelText
      : right.modelText.isEmpty
      ? left.modelText
      : '${left.modelText}\n\n${right.modelText}';
  final leftBoundary = left.content.isEmpty ? null : left.content.last;
  final rightBoundary = right.content.isEmpty ? null : right.content.first;
  final stitchedTool =
      leftBoundary is ToolTranscriptDisplayEntry &&
          rightBoundary is ToolTranscriptDisplayEntry &&
          leftBoundary.callId != null &&
          leftBoundary.callId == rightBoundary.callId
      ? ToolTranscriptDisplayEntry(
          call: leftBoundary.call ?? rightBoundary.call,
          result: rightBoundary.result ?? leftBoundary.result,
          sourceIndices: List<int>.unmodifiable([
            ...leftBoundary.sourceIndices,
            ...rightBoundary.sourceIndices,
          ]),
        )
      : null;
  final content = stitchedTool == null
      ? _CombinedImmutableList(left.content, right.content)
      : _StitchedToolContentList(
          left.content,
          stitchedTool,
          right.content,
        );
  final merged = ConversationTurn(
    index: left.index,
    turnKey: left.turnKey,
    userMessage: left.userMessage,
    content: content,
    modelText: mergedModelText,
    distinctToolCallCount:
        left.distinctToolCallCount +
        right.distinctToolCallCount -
        (stitchedTool == null ? 0 : 1),
    isPartial: left.isPartial,
    runSummary: right.runSummary ?? left.runSummary,
  );
  return (
    previous: _ReplaceLastImmutableList(previous, merged),
    current: _DropFirstImmutableList(current),
  );
}

final class _CombinedImmutableList<E> extends ListBase<E> {
  _CombinedImmutableList(this.left, this.right);

  final List<E> left;
  final List<E> right;

  @override
  int get length => left.length + right.length;

  @override
  set length(int value) => throw UnsupportedError('immutable list');

  @override
  E operator [](int index) =>
      index < left.length ? left[index] : right[index - left.length];

  @override
  void operator []=(int index, E value) =>
      throw UnsupportedError('immutable list');
}

final class _StitchedToolContentList
    extends ListBase<SessionTranscriptDisplayEntry> {
  _StitchedToolContentList(this.left, this.tool, this.right);

  final List<SessionTranscriptDisplayEntry> left;
  final ToolTranscriptDisplayEntry tool;
  final List<SessionTranscriptDisplayEntry> right;

  @override
  int get length => left.length + right.length - 1;

  @override
  set length(int value) => throw UnsupportedError('immutable list');

  @override
  SessionTranscriptDisplayEntry operator [](int index) {
    final leftPrefixLength = left.length - 1;
    if (index < leftPrefixLength) return left[index];
    if (index == leftPrefixLength) return tool;
    return right[index - left.length + 1];
  }

  @override
  void operator []=(int index, SessionTranscriptDisplayEntry value) =>
      throw UnsupportedError('immutable list');
}

final class _ReplaceLastImmutableList<E> extends ListBase<E> {
  _ReplaceLastImmutableList(this.source, this.replacement);

  final List<E> source;
  final E replacement;

  @override
  int get length => source.length;

  @override
  set length(int value) => throw UnsupportedError('immutable list');

  @override
  E operator [](int index) =>
      index == source.length - 1 ? replacement : source[index];

  @override
  void operator []=(int index, E value) =>
      throw UnsupportedError('immutable list');
}

final class _DropFirstImmutableList<E> extends ListBase<E> {
  _DropFirstImmutableList(this.source);

  final List<E> source;

  @override
  int get length => source.isEmpty ? 0 : source.length - 1;

  @override
  set length(int value) => throw UnsupportedError('immutable list');

  @override
  E operator [](int index) => source[index + 1];

  @override
  void operator []=(int index, E value) =>
      throw UnsupportedError('immutable list');
}

TranscriptHistoryGapSegment? _historyGapBetween(
  TranscriptHistoryPage previous,
  TranscriptHistoryPage page, {
  required bool tailPrefixEvicted,
}) {
  final connected =
      previous.newerCursor == page.olderCursor &&
      !(page.isTail && tailPrefixEvicted);
  if (connected) return null;
  final reloadCursor = page.isTail && tailPrefixEvicted
      ? null
      : page.olderCursor;
  return TranscriptHistoryGapSegment(
    id:
        'history-gap-${previous.newerCursor ?? 'local'}-'
        '${page.olderCursor ?? 'tail'}',
    kind: reloadCursor == null
        ? TranscriptHistoryGapKind.reconnectRequired
        : TranscriptHistoryGapKind.reloadable,
    reloadCursor: reloadCursor,
  );
}

final class _TranscriptHistoryDerived {
  _TranscriptHistoryDerived({
    required this.canonicalMessages,
    required this.transcriptMessages,
    required this.gaps,
    required this.segmentStartKeys,
  });

  factory _TranscriptHistoryDerived.fromWindow(
    TranscriptHistoryWindow window,
  ) {
    final pageGroups = <List<TranscriptHistoryPage>>[];
    final gaps = <TranscriptHistoryGapSegment>[];
    for (final page in window.pages) {
      if (pageGroups.isEmpty) {
        pageGroups.add([page]);
        continue;
      }
      final previous = pageGroups.last.last;
      final gap = _historyGapBetween(
        previous,
        page,
        tailPrefixEvicted: window.tailPrefixEvicted,
      );
      if (gap == null) {
        pageGroups.last.add(page);
      } else {
        gaps.add(gap);
        pageGroups.add([page]);
      }
    }

    final canonicalGroups = <List<AgentMessage>>[
      for (final _ in pageGroups) <AgentMessage>[],
    ];
    final locationByKey = <String, ({int group, int index})>{};
    for (var groupIndex = 0; groupIndex < pageGroups.length; groupIndex++) {
      for (final page in pageGroups[groupIndex]) {
        for (final message in _pageDerived(page).canonicalMessages) {
          final key = stableTranscriptMessageKey(message);
          final existing = key == null ? null : locationByKey[key];
          if (existing != null) {
            canonicalGroups[existing.group][existing.index] =
                mergeStableTranscriptMessage(
                  canonicalGroups[existing.group][existing.index],
                  message,
                );
            continue;
          }
          if (key != null) {
            locationByKey[key] = (
              group: groupIndex,
              index: canonicalGroups[groupIndex].length,
            );
          }
          canonicalGroups[groupIndex].add(message);
        }
      }
    }
    final transcriptGroups = <List<AgentMessage>>[
      for (final group in canonicalGroups)
        List<AgentMessage>.unmodifiable(
          group.where(
            (message) =>
                !isSessionLiveStateMessage(message) &&
                !isSessionTelemetryMessage(message),
          ),
        ),
    ];
    final canonical = List<AgentMessage>.unmodifiable(
      canonicalGroups.expand((group) => group),
    );
    final transcript = List<AgentMessage>.unmodifiable(
      transcriptGroups.expand((group) => group),
    );
    return _TranscriptHistoryDerived(
      canonicalMessages: canonical,
      transcriptMessages: transcript,
      gaps: List.unmodifiable(gaps),
      segmentStartKeys: List.unmodifiable(
        [
          for (final group in transcriptGroups)
            if (group.isNotEmpty) stableTranscriptMessageKey(group.first),
        ].whereType<String>(),
      ),
    );
  }

  final List<AgentMessage> canonicalMessages;
  final List<AgentMessage> transcriptMessages;
  final List<TranscriptHistoryGapSegment> gaps;
  final List<String> segmentStartKeys;
}

final class _TranscriptHistoryPresentation {
  const _TranscriptHistoryPresentation({
    required this.optimisticPrompts,
    required this.clientKeys,
    required this.messages,
    required this.segments,
  });

  final List<SessionOptimisticPrompt> optimisticPrompts;
  final Map<String, String> clientKeys;
  final List<AgentMessage> messages;
  final List<List<AgentMessage>> segments;
}

final Expando<_SessionDetailProjection> _sessionDetailProjectionCache =
    Expando<_SessionDetailProjection>('session detail event projection');

/// One immutable reduction shared by every event-derived state getter.
///
/// `SessionDetailState` treats `events` as immutable. Keying this projection by
/// list identity lets metadata-only `copyWith` calls reuse the same reduction
/// while allowing the old state/list to be garbage-collected normally.
final class _SessionDetailProjection {
  _SessionDetailProjection({
    required this.eventSummaries,
    required this.commands,
    required this.models,
    required this.agents,
    required this.modes,
    required this.latestDraft,
  });

  factory _SessionDetailProjection.fromEvents(List<WireEvent> events) {
    final eventSummaries = <String>[];
    var latestCommands = const <SlashCommand>[];
    var latestModels = const <ModelOption>[];
    var latestAgents = const <AgentOption>[];
    var latestModes = const <ModeOption>[];
    DraftWireEvent? latestDraft;

    for (final event in events) {
      eventSummaries.add(describeWireEvent(event));
      switch (event) {
        case CommandsWireEvent(commands: final nextCommands):
          latestCommands = List.unmodifiable(nextCommands);
        case OptionsWireEvent(
          models: final nextModels,
          agents: final nextAgents,
          modes: final nextModes,
        ):
          latestModels = List.unmodifiable(nextModels);
          latestAgents = List.unmodifiable(nextAgents);
          latestModes = List.unmodifiable(nextModes ?? const <ModeOption>[]);
        case DraftWireEvent():
          if (latestDraft == null || event.at >= latestDraft.at) {
            latestDraft = event;
          }
        case _:
          continue;
      }
    }

    return _SessionDetailProjection(
      eventSummaries: List<String>.unmodifiable(eventSummaries),
      commands: latestCommands,
      models: latestModels,
      agents: latestAgents,
      modes: latestModes,
      latestDraft: latestDraft,
    );
  }

  final List<String> eventSummaries;
  final List<SlashCommand> commands;
  final List<ModelOption> models;
  final List<AgentOption> agents;
  final List<ModeOption> modes;
  final DraftWireEvent? latestDraft;
}

/// Adds optimistic position holders to one canonical transcript projection.
List<AgentMessage> projectOptimisticTranscriptMessages(
  List<AgentMessage> transcriptMessages,
  List<SessionOptimisticPrompt> optimisticPrompts,
  Map<String, String> clientKeys,
) {
  if (optimisticPrompts.isEmpty && clientKeys.isEmpty) {
    return transcriptMessages;
  }
  final indexByKey = <String, int>{};
  for (var i = 0; i < transcriptMessages.length; i++) {
    final key = stableTranscriptMessageKey(transcriptMessages[i]);
    if (key != null) indexByKey[key] = i;
  }
  final suppressedIndices = <int>{};
  final rowsBySlot = <int, List<AgentMessage>>{};
  var slotFloor = -1;
  for (final prompt in optimisticPrompts) {
    final AgentMessage row;
    final int? deliveredIndex;
    if (prompt.deliveredMessageKey case final String deliveredKey?) {
      final index = indexByKey[deliveredKey];
      if (index == null) continue;
      deliveredIndex = index;
      suppressedIndices.add(index);
      final delivered = transcriptMessages[index];
      row = delivered.raw['clientKey'] is String
          ? delivered
          : AgentMessage(
              type: delivered.type,
              id: delivered.id,
              seq: delivered.seq,
              parentId: delivered.parentId,
              timestamp: delivered.timestamp,
              raw: <String, dynamic>{
                ...delivered.raw,
                'clientKey': prompt.clientMessageId,
              },
            );
    } else {
      deliveredIndex = null;
      row = prompt.toAgentMessage();
    }
    final anchorKey = prompt.anchorMessageKey;
    // A delivered holder whose anchored boundary has left the window falls
    // back to its echo's canonical index — the only position still known to
    // be correct. Falling back to the tail instead would displace the echo
    // behind rows it precedes and, through the monotonic floor, drag every
    // later prompt down with it. The last-index fallback is reserved for
    // pending prompts that genuinely have no canonical row.
    final slot = anchorKey == null
        ? -1
        : indexByKey[anchorKey] ??
              deliveredIndex ??
              transcriptMessages.length - 1;
    final resolved = slot < slotFloor ? slotFloor : slot;
    slotFloor = resolved;
    (rowsBySlot[resolved] ??= []).add(row);
  }

  AgentMessage canonicalRow(int index) {
    final message = transcriptMessages[index];
    if (clientKeys.isEmpty ||
        message.type != AgentMessageType.userMessage ||
        message.raw['clientKey'] is String) {
      return message;
    }
    final key = stableTranscriptMessageKey(message);
    final clientKey = key == null ? null : clientKeys[key];
    if (clientKey == null) return message;
    return AgentMessage(
      type: message.type,
      id: message.id,
      seq: message.seq,
      parentId: message.parentId,
      timestamp: message.timestamp,
      raw: <String, dynamic>{...message.raw, 'clientKey': clientKey},
    );
  }

  return List<AgentMessage>.unmodifiable([
    ...?rowsBySlot[-1],
    for (var i = 0; i < transcriptMessages.length; i++) ...[
      if (!suppressedIndices.contains(i)) canonicalRow(i),
      ...?rowsBySlot[i],
    ],
  ]);
}

/// Upper bound before the lightweight debug/control event log is compacted.
const int kMaxRetainedSessionDetailEvents = 256;

/// Recent debug summaries retained after compaction.
const int kRetainedSessionDetailDebugEvents = 32;

/// Whether a paging failure cannot be resolved by retrying the same source.
///
/// `HISTORY_PAGE_SOURCE_CHANGED` is deliberately absent (H1b): a session that
/// was still writing while its history was indexed is the ordinary condition
/// for an active agent, and the next attempt reads a newer prefix. Only
/// measured resource limits and an unversionable source are terminal.
bool isTerminalHistoryPageErrorCode(String? code) => const {
  'HISTORY_PAGE_RESOURCE_LIMIT',
  'HISTORY_PAGE_SOURCE_UNVERSIONED',
  'HISTORY_PAGE_CLIENT_RESOURCE_LIMIT',
}.contains(code);

/// Whether a history gap says the broker could not READ this history, rather
/// than that it replaced a stale cursor with a replay.
///
/// These two used to be presented identically, which is how one attach could
/// claim a full replay, the start of the session, and no messages at the same
/// time (H1c). A gap carrying one of these codes is a statement about the
/// broker's bounded readers — never about how much history the session has —
/// so it can neither prove the transcript is empty nor prove its start was
/// reached.
bool isHistoryUnavailableGapCode(String? code) => const {
  'HISTORY_PAGE_RESOURCE_LIMIT',
  'HISTORY_PAGE_SOURCE_CHANGED',
  'HISTORY_PAGE_SOURCE_UNVERSIONED',
}.contains(code);

/// Broker and client history page size used by H1.
const int kTranscriptHistoryPageMessages = 100;

/// Maximum decoded history pages retained by one active Session Detail.
const int kMaxActiveTranscriptPages = 5;

/// Hard active canonical-message count derived from the page budget.
const int kMaxActiveTranscriptMessages =
    kTranscriptHistoryPageMessages * kMaxActiveTranscriptPages;

/// Estimated decoded object/string budget for one active transcript window.
const int kMaxActiveTranscriptDecodedBytes = 4 * 1024 * 1024;

/// The newest tail is always a first-class retained segment so Jump to latest
/// never has to download the intervening transcript.
const int kRetainedTranscriptTailMessages = kTranscriptHistoryPageMessages;

/// Conservative decoded-memory estimate without JSON-encoding the transcript.
///
/// The estimate counts UTF-16 string storage plus collection/object overhead.
/// It is deterministic and intentionally errs high; it is a budget gate, not
/// a VM heap profiler.
int estimatedAgentMessageDecodedBytes(AgentMessage message) =>
    _estimatedDecodedValueBytes(message.raw);

int _estimatedDecodedValueBytes(Object? value) {
  if (value == null) return 8;
  if (value is bool || value is num) return 16;
  if (value is String) return 24 + value.length * 2;
  if (value is List<Object?>) {
    var bytes = 32 + value.length * 8;
    for (final item in value) {
      bytes += _estimatedDecodedValueBytes(item);
    }
    return bytes;
  }
  if (value is Map<Object?, Object?>) {
    var bytes = 64 + value.length * 24;
    for (final entry in value.entries) {
      bytes += _estimatedDecodedValueBytes(entry.key);
      bytes += _estimatedDecodedValueBytes(entry.value);
    }
    return bytes;
  }
  return 32 + value.toString().length * 2;
}

/// Appends one event to the lightweight debug/control log.
///
/// Transcript-bearing frames become summary-only placeholders immediately.
/// The canonical payload lives only in [TranscriptHistoryWindow], preventing
/// every older page from also being retained by the debug timeline.
List<WireEvent> appendSessionDetailEventLog(
  List<WireEvent> events,
  WireEvent event,
) => compactSessionDetailEvents([
  ...events,
  _sessionDetailDebugEvent(event),
]);

/// Compacts the debug/control log without rebuilding a transcript projection.
///
/// The newest debug summaries plus the latest compatibility, command, option,
/// and draft control frames survive. This function never walks message bodies,
/// estimates transcript bytes, or creates a synthetic non-contiguous history.
List<WireEvent> compactSessionDetailEvents(List<WireEvent> events) {
  if (events.length <= kMaxRetainedSessionDetailEvents) {
    return events;
  }

  final retainedIndexes = <int>{};
  final tailStart = (events.length - kRetainedSessionDetailDebugEvents).clamp(
    0,
    events.length,
  );
  for (var index = tailStart; index < events.length; index++) {
    retainedIndexes.add(index);
  }

  int? helloIndex;
  int? commandsIndex;
  int? optionsIndex;
  int? draftIndex;
  for (var index = 0; index < events.length; index++) {
    final event = events[index];
    switch (event) {
      case HelloWireEvent():
        helloIndex = index;
      case CommandsWireEvent():
        commandsIndex = index;
      case OptionsWireEvent():
        optionsIndex = index;
      case DraftWireEvent():
        final current = draftIndex == null
            ? null
            : events[draftIndex] as DraftWireEvent;
        if (current == null || event.at >= current.at) {
          draftIndex = index;
        }
      case _:
        break;
    }
  }
  retainedIndexes.addAll([
    if (helloIndex != null) helloIndex,
    if (commandsIndex != null) commandsIndex,
    if (optionsIndex != null) optionsIndex,
    if (draftIndex != null) draftIndex,
  ]);
  final ordered = retainedIndexes.toList()..sort();
  return List<WireEvent>.unmodifiable(<WireEvent>[
    for (final index in ordered) _sessionDetailDebugEvent(events[index]),
  ]);
}

WireEvent _sessionDetailDebugEvent(WireEvent event) {
  final sourceKind = switch (event) {
    HistoryWireEvent() => 'history',
    HistoryPageWireEvent() => 'history-page',
    MessageWireEvent() => 'message',
    _ => null,
  };
  if (sourceKind == null) return event;
  return UnknownWireEvent(
    kind: 'debug-$sourceKind',
    raw: <String, dynamic>{
      'kind': 'debug-$sourceKind',
      'sourceKind': sourceKind,
      'summary': describeWireEvent(event),
    },
  );
}

/// Stable reduction identity for one canonical message, or `null` when the
/// message carries no upsertable identity.
///
/// This is the key the projection dedupes/merges by, and the key optimistic
/// prompts anchor their insertion boundary to. `clientKey` is deliberately not
/// part of it: echo correlation is not canonical identity.
String? stableTranscriptMessageKey(AgentMessage message) {
  String? nonEmpty(Object? value) =>
      value is String && value.isNotEmpty ? value : null;

  // Preserve the raw discriminator for forward-compatible messages. Mapping
  // every future type to `unknown` would otherwise merge unrelated messages
  // that happen to reuse the same key/id namespace.
  final typeKey = nonEmpty(message.raw['type']) ?? message.type.wireValue;
  final rawKey = nonEmpty(message.raw['key']);
  if (rawKey != null) return '$typeKey:key:$rawKey';
  final requestId = nonEmpty(message.raw['requestId']);
  if (requestId != null) {
    return '$typeKey:request:$requestId';
  }
  final callId = nonEmpty(message.raw['callId']);
  if (callId != null) return '$typeKey:call:$callId';
  if (message.type == AgentMessageType.fileArtifact) {
    final artifactIdentity =
        nonEmpty(message.raw['artifactKey']) ??
        nonEmpty(message.raw['contentHash']) ??
        nonEmpty(message.raw['path']) ??
        nonEmpty(message.raw['name']);
    if (artifactIdentity != null) {
      return '$typeKey:artifact:$artifactIdentity';
    }
  }
  final id = nonEmpty(message.id);
  return id == null ? null : '$typeKey:id:$id';
}

/// Reconciles one authoritative incremental history frame into a retained
/// tail, returning the merged sequence in native/source order.
///
/// The frame's order is the adapter's native order. A retained row whose
/// stable key the frame shares is merged (see [mergeStableTranscriptMessage])
/// at its FRAME position, so a malformed retained order is repaired rather
/// than preserved. A frame row the retained tail never saw — missed live
/// delivery, cache restore — returns to its authoritative position between
/// the shared neighbors instead of appending behind an already-retained
/// later row. A retained row the frame does not cover keeps its relative
/// order and its position after the same shared predecessor; the frame
/// carries no evidence about it, and order is never inferred from
/// timestamps, text, or arrival timing. Rows without stable keys cannot be
/// related across the sequences and keep frame/arrival order.
///
/// When the frame shares no stable key with the retained tail there is no
/// authoritative anchor relating the two sequences, so the frame appends —
/// the same outcome live delivery would have produced.
List<AgentMessage> reconcileTranscriptHistoryDelta({
  required List<AgentMessage> retained,
  required List<AgentMessage> frame,
}) {
  if (frame.isEmpty) return List<AgentMessage>.of(retained);
  final frameIndexByKey = <String, int>{};
  for (var index = 0; index < frame.length; index++) {
    final key = stableTranscriptMessageKey(frame[index]);
    if (key != null) frameIndexByKey.putIfAbsent(key, () => index);
  }
  final retainedByKey = <String, AgentMessage>{};
  // Uncovered retained rows grouped by the frame index of their nearest
  // covered predecessor (-1 when no covered row precedes them).
  final uncoveredAfter = <int, List<AgentMessage>>{};
  var anchored = false;
  var lastCoveredFrameIndex = -1;
  for (final row in retained) {
    final key = stableTranscriptMessageKey(row);
    final frameIndex = key == null ? null : frameIndexByKey[key];
    if (key == null || frameIndex == null) {
      (uncoveredAfter[lastCoveredFrameIndex] ??= <AgentMessage>[]).add(row);
      continue;
    }
    anchored = true;
    retainedByKey[key] = row;
    lastCoveredFrameIndex = frameIndex;
  }
  if (!anchored) {
    return List<AgentMessage>.unmodifiable([...retained, ...frame]);
  }
  final merged = <AgentMessage>[];
  final mergedIndexByKey = <String, int>{};
  void emitUncovered(int frameIndex) {
    final rows = uncoveredAfter[frameIndex];
    if (rows != null) merged.addAll(rows);
  }

  emitUncovered(-1);
  for (var index = 0; index < frame.length; index++) {
    final message = frame[index];
    final key = stableTranscriptMessageKey(message);
    final existingMergedIndex = key == null ? null : mergedIndexByKey[key];
    if (existingMergedIndex != null) {
      merged[existingMergedIndex] = mergeStableTranscriptMessage(
        merged[existingMergedIndex],
        message,
      );
    } else {
      final previous = key == null ? null : retainedByKey[key];
      if (key != null) mergedIndexByKey[key] = merged.length;
      merged.add(
        previous == null
            ? message
            : mergeStableTranscriptMessage(previous, message),
      );
    }
    emitUncovered(index);
  }
  return List<AgentMessage>.unmodifiable(merged);
}

/// Merges two canonical emissions with the same non-text identity.
AgentMessage mergeStableTranscriptMessage(
  AgentMessage previous,
  AgentMessage incoming,
) {
  if (incoming.type == AgentMessageType.userMessage) {
    // A delivered/replayed re-emit of the same user row can lack the app-send
    // correlation its first (stamped) emission carried; dropping it would
    // change the row's display identity mid-transition. Carry it forward.
    final previousClientKey = previous.raw['clientKey'];
    if (previousClientKey is String &&
        previousClientKey.isNotEmpty &&
        incoming.raw['clientKey'] is! String) {
      return AgentMessage(
        type: incoming.type,
        id: incoming.id ?? previous.id,
        seq: incoming.seq ?? previous.seq,
        parentId: incoming.parentId ?? previous.parentId,
        timestamp: incoming.timestamp ?? previous.timestamp,
        raw: <String, dynamic>{...incoming.raw, 'clientKey': previousClientKey},
      );
    }
    return incoming;
  }
  if (incoming.type != AgentMessageType.modelOutput &&
      incoming.type != AgentMessageType.thinking) {
    return incoming;
  }

  final incomingText = incoming.raw['text'];
  if (incomingText is String) return _withCarriedFinality(previous, incoming);

  final delta = incoming.raw['delta'];
  if (delta is! String) {
    final previousText = previous.raw['text'];
    if (previousText is! String) return incoming;
    final raw = <String, dynamic>{...previous.raw, ...incoming.raw}
      ..['text'] = previousText
      ..remove('delta');
    return AgentMessage(
      type: incoming.type,
      id: incoming.id ?? previous.id,
      seq: incoming.seq ?? previous.seq,
      parentId: incoming.parentId ?? previous.parentId,
      timestamp: incoming.timestamp ?? previous.timestamp,
      raw: raw,
    );
  }

  final previousText = previous.raw['text'];
  final previousDelta = previous.raw['delta'];
  final accumulated = StringBuffer(
    previousText is String
        ? previousText
        : previousDelta is String
        ? previousDelta
        : '',
  )..write(delta);
  final raw = <String, dynamic>{...previous.raw, ...incoming.raw}
    ..['text'] = accumulated.toString()
    ..remove('delta');
  return AgentMessage(
    type: incoming.type,
    id: incoming.id ?? previous.id,
    seq: incoming.seq ?? previous.seq,
    parentId: incoming.parentId ?? previous.parentId,
    timestamp: incoming.timestamp ?? previous.timestamp,
    raw: raw,
  );
}

/// [incoming] carrying the completion [previous] established, if it dropped it.
///
/// A catch-up copy of a still-live buffer restates a message that has already
/// completed, without repeating the `final` marker. Adopting it verbatim would
/// take a finished answer back out of read-aloud and Copy aggregation and out
/// of the turn projection's completed set, even though nothing about the
/// message changed. No adapter walks a completed message back to streaming, so
/// keeping the completion is the direction that cannot lose information.
AgentMessage _withCarriedFinality(
  AgentMessage previous,
  AgentMessage incoming,
) {
  if (previous.raw['final'] != true || incoming.raw['final'] == true) {
    return incoming;
  }
  return AgentMessage(
    type: incoming.type,
    id: incoming.id ?? previous.id,
    seq: incoming.seq ?? previous.seq,
    parentId: incoming.parentId ?? previous.parentId,
    timestamp: incoming.timestamp ?? previous.timestamp,
    raw: <String, dynamic>{...incoming.raw, 'final': true},
  );
}

/// Latest anchorable transcript identity in [messages], or `null` when none.
///
/// Scans backward for the newest message that renders in the transcript (state
/// and telemetry frames are routed elsewhere) and carries a stable reduction
/// key. This is the insertion boundary a newly accepted optimistic prompt
/// pins itself after.
String? latestTranscriptAnchorKey(List<AgentMessage> messages) {
  for (var i = messages.length - 1; i >= 0; i--) {
    final message = messages[i];
    if (isSessionLiveStateMessage(message) ||
        isSessionTelemetryMessage(message)) {
      continue;
    }
    final key = stableTranscriptMessageKey(message);
    if (key != null) return key;
  }
  return null;
}

/// Hard cap on retained delivered position holders.
///
/// A holder normally retires as soon as its echo's canonical position matches
/// the anchored slot (the common in-order delivery). Only an echo that arrived
/// out of order keeps its holder — and a session can't accumulate more than
/// this many of those before the oldest is released to its canonical position.
const int kMaxDeliveredOptimisticHolders = 8;

/// Upper bound on retained legacy echo → clientMessageId display-identity
/// associations ([SessionDetailState.transcriptClientKeys]).
const int kMaxRetainedTranscriptClientKeys = 64;

/// Retires delivered position holders whose work is done, oldest first.
///
/// A delivered holder is redundant once rendering without it produces the same
/// order — its canonical echo sits immediately after its anchored slot. It is
/// equally redundant once its anchored boundary has left the window: the
/// projection renders such an echo at its canonical index with or without the
/// holder, so keeping it would change nothing while blocking every later
/// holder from retiring behind it. Rows behind a retiring holder that were
/// anchored before its echo are re-pinned to that echo, which is exactly the
/// boundary the holder was enforcing for them, so the projected order never
/// changes. A holder whose echo vanished from the canonical transcript renders
/// nothing and is dropped outright.
///
/// Out-of-order echoes keep their holders (that IS the display guarantee), but
/// never more than [kMaxDeliveredOptimisticHolders]: beyond the cap the oldest
/// delivered holder is released even unsettled, snapping that old echo to its
/// canonical position. Display identity survives retirement in all cases —
/// stamped echoes carry `clientKey` natively and legacy ones stay decorated
/// via [SessionDetailState.transcriptClientKeys].
///
/// Returns [prompts] (identical) when nothing retires.
List<SessionOptimisticPrompt> retireSettledOptimisticHolders(
  List<SessionOptimisticPrompt> prompts,
  List<AgentMessage> canonicalMessages,
) {
  if (!prompts.any((p) => p.isDelivered)) return prompts;
  final indexByKey = <String, int>{};
  for (var i = 0; i < canonicalMessages.length; i++) {
    final key = stableTranscriptMessageKey(canonicalMessages[i]);
    if (key != null) indexByKey[key] = i;
  }
  int slotOf(SessionOptimisticPrompt p) {
    final anchorKey = p.anchorMessageKey;
    if (anchorKey == null) return -1;
    return indexByKey[anchorKey] ?? canonicalMessages.length - 1;
  }

  var result = prompts;
  var mutated = false;

  // Removes result[index]; rows behind it anchored before the released echo
  // re-pin to the echo so they cannot jump in front of it.
  void release(int index) {
    final victim = result[index];
    final echoKey = victim.deliveredMessageKey!;
    final echoIndex = indexByKey[echoKey];
    result = [
      ...result.sublist(0, index),
      for (final p in result.sublist(index + 1))
        if (echoIndex != null && slotOf(p) < echoIndex)
          p.reAnchoredTo(echoKey)
        else
          p,
    ];
    mutated = true;
  }

  // Oldest-first: a pending (or unsettled) head blocks retirement behind it,
  // preserving send order among the rendered rows.
  while (result.isNotEmpty) {
    final head = result.first;
    if (!head.isDelivered) break;
    final echoIndex = indexByKey[head.deliveredMessageKey!];
    if (echoIndex != null) {
      final anchorKey = head.anchorMessageKey;
      final anchorIndex = anchorKey == null ? -1 : indexByKey[anchorKey];
      // An anchor the window no longer carries gives the holder nothing left
      // to enforce: the echo renders at its canonical index either way. Only
      // a resolved anchor with a displaced echo is still doing work.
      if (anchorIndex != null && echoIndex != anchorIndex + 1) break;
    }
    release(0);
  }

  var delivered = result.where((p) => p.isDelivered).length;
  while (delivered > kMaxDeliveredOptimisticHolders) {
    release(result.indexWhere((p) => p.isDelivered));
    delivered--;
  }
  return mutated ? List<SessionOptimisticPrompt>.unmodifiable(result) : prompts;
}

/// One locally accepted prompt holding a stable logical transcript position.
///
/// The row exists from local acceptance until the transcript is replaced by an
/// authoritative replay. While pending it renders its own optimistic bubble;
/// once its canonical echo arrives it stays as a *position holder*: the echo's
/// canonical content renders at this row's anchored boundary even when the
/// echo reached the client after its own answer started streaming.
@immutable
final class SessionOptimisticPrompt {
  /// Creates an optimistic prompt row.
  const SessionOptimisticPrompt({
    required this.clientMessageId,
    required this.text,
    required this.sentAt,
    required this.queued,
    this.anchorMessageKey,
    this.deliveredMessageKey,
  });

  /// Durable outbox correlation id.
  final String clientMessageId;

  /// Exact user-entered prompt text.
  final String text;

  /// Local send timestamp in epoch milliseconds.
  final int sentAt;

  /// Whether broker state said a turn was already working at send time.
  final bool queued;

  /// Stable key of the canonical transcript message this prompt inserts after.
  ///
  /// Captured once when the send is accepted, so later appends cannot move the
  /// row. `null` means the transcript was empty at send time.
  final String? anchorMessageKey;

  /// Stable key of the canonical echo that delivered this send, once known.
  ///
  /// While set, the projection renders that canonical message here (at the
  /// anchored boundary) instead of at its live arrival position, which is what
  /// keeps a delayed echo in front of its own answer.
  final String? deliveredMessageKey;

  /// Whether the canonical echo for this send has arrived.
  bool get isDelivered => deliveredMessageKey != null;

  /// Returns this prompt pinned to a new insertion boundary.
  ///
  /// Used only for canonical convergence after a full history replacement.
  SessionOptimisticPrompt reAnchoredTo(String? anchorMessageKey) =>
      SessionOptimisticPrompt(
        clientMessageId: clientMessageId,
        text: text,
        sentAt: sentAt,
        queued: queued,
        anchorMessageKey: anchorMessageKey,
        deliveredMessageKey: deliveredMessageKey,
      );

  /// Returns this row converted into a position holder for its canonical echo.
  SessionOptimisticPrompt deliveredBy(String messageKey) =>
      SessionOptimisticPrompt(
        clientMessageId: clientMessageId,
        text: text,
        sentAt: sentAt,
        queued: queued,
        anchorMessageKey: anchorMessageKey,
        deliveredMessageKey: messageKey,
      );

  /// Creates the canonical renderer input without leaking transport concerns
  /// into widgets.
  ///
  /// `clientKey` carries the same correlation the canonical echo will, so the
  /// rendered row keeps one display identity across optimistic → queued →
  /// delivered.
  AgentMessage toAgentMessage() => AgentMessage.fromJson({
    'type': AgentMessageType.userMessage.wireValue,
    'key': 'optimistic:$clientMessageId',
    'clientKey': clientMessageId,
    'text': text,
    'sentAt': sentAt,
    if (queued) 'queued': true,
  });
}

/// Visible progress for one locally dispatched long-running slash command.
@immutable
final class SessionCommandProgress {
  /// Creates command progress.
  const SessionCommandProgress({
    required this.name,
    required this.startedAt,
  });

  /// Normalized command name without a leading slash.
  final String name;

  /// Local dispatch timestamp in epoch milliseconds.
  final int startedAt;
}

/// Capability-gated REST actions exposed by `/api/agents` for a session tool.
class SessionAgentActions {
  /// Creates [SessionAgentActions].
  const SessionAgentActions({
    required this.canRenameNative,
    required this.canFork,
    required this.canClone,
    required this.canTranscriptExport,
    required this.canAttachFiles,
    this.loaded = true,
  });

  /// Builds action capabilities from broker [AgentInfo].
  factory SessionAgentActions.fromAgentInfo(AgentInfo agent) {
    return SessionAgentActions(
      canRenameNative: agent.canRenameNative,
      canFork: agent.canFork,
      canClone: agent.canClone,
      canTranscriptExport: agent.canTranscriptExport,
      canAttachFiles: agent.capabilities.supportsNativeFileInput,
    );
  }

  /// Whether native rename is available.
  final bool canRenameNative;

  /// Whether native fork is available.
  final bool canFork;

  /// Whether native clone is available.
  final bool canClone;

  /// Whether transcript export is available.
  final bool canTranscriptExport;

  /// Whether the adapter truthfully accepts prompt attachments.
  final bool canAttachFiles;

  /// Whether these flags were read from a broker agent registry entry.
  ///
  /// False for the substituted all-false set applied when `/api/agents`
  /// failed or omitted the tool. Those flags keep every action disabled, but
  /// they mean "nothing is known" — copy must not present them as a
  /// permanent agent-type limitation.
  final bool loaded;
}

/// Transcript-export command phase.
enum TranscriptExportActionPhase {
  /// No export action in progress.
  idle,

  /// Calling broker preflight.
  preflighting,

  /// Preflight succeeded and the UI should confirm with the user.
  awaitingConfirmation,

  /// Calling broker export execution.
  exporting,

  /// Export succeeded and the returned artifact is available in Files.
  exported,

  /// Export failed.
  error,
}

/// State for the transcript export command.
class TranscriptExportActionState {
  /// Creates [TranscriptExportActionState].
  const TranscriptExportActionState({
    required this.phase,
    this.preflight,
    this.failure,
    this.errorCode,
  });

  /// Idle transcript export state.
  const TranscriptExportActionState.idle()
    : phase = TranscriptExportActionPhase.idle,
      preflight = null,
      failure = null,
      errorCode = null;

  /// Current phase.
  final TranscriptExportActionPhase phase;

  /// Last successful preflight response, if confirmation is pending.
  final TranscriptExportPreflightResponse? preflight;

  /// Classified failure behind an error phase, or null.
  ///
  /// Typed rather than a finished sentence: the status line is derived from
  /// [phase] by the export status mapper, and this carries the diagnostic
  /// for the "Technical details" disclosure.
  final LocalizedFailure? failure;

  /// Broker machine-readable error code, if any.
  final String? errorCode;

  /// Whether an export-related network action is in progress.
  bool get isBusy =>
      phase == TranscriptExportActionPhase.preflighting ||
      phase == TranscriptExportActionPhase.exporting;
}

/// Session action phase for rename/fork/clone affordances.
enum SessionActionPhase {
  /// No action in progress.
  idle,

  /// Broker request is in progress.
  inProgress,

  /// The action completed successfully.
  success,

  /// The action failed.
  failed,
}

/// A refusal this client decided for itself, before any broker request.
///
/// Carried instead of a message so the copy is resolved by the view, in the
/// user's current language, at build time. A controller cannot produce
/// localized text without resolving a locale outside the widget tree, and text
/// baked into state at refusal time would keep the language it was written in
/// after the user switches languages. Broker-relayed text keeps using
/// `SessionActionState.failure`, which carries a caught exception.
enum SessionActionRefusal {
  /// The session was spawned by another agent session, so it has no
  /// user-initiated fork point — its only writer is the parent session's run.
  ///
  /// Mirrors the broker's `SESSION_AGENT_OWNED` fork gate.
  agentOwnedSession,

  /// Rename attempted with no server connection.
  renameRequiresServer,

  /// The session's agent does not support native rename.
  renameUnsupported,

  /// The broker refused the rename.
  renameRejected,

  /// Fork attempted with no server connection.
  forkRequiresServer,

  /// The session's agent does not support fork.
  forkUnsupported,

  /// A fork is already running for this session.
  forkAlreadyRunning,

  /// The broker accepted the fork but named no new session.
  forkReturnedNothing,

  /// Clone attempted with no server connection.
  cloneRequiresServer,

  /// The session's agent does not support clone.
  cloneUnsupported,

  /// A clone is already running for this session.
  cloneAlreadyRunning,

  /// The broker accepted the clone but named no new session.
  cloneReturnedNothing,
}

/// Session action lifecycle for rename/fork/clone session operations.
class SessionActionState {
  /// Creates a [SessionActionState].
  const SessionActionState({
    required this.phase,
    this.failure,
    this.refusal,
    this.createdSessionId,
    this.createdSessionTitle,
  });

  /// Creates an idle action state.
  const SessionActionState.idle()
    : phase = SessionActionPhase.idle,
      failure = null,
      refusal = null,
      createdSessionId = null,
      createdSessionTitle = null;

  /// Current action phase.
  final SessionActionPhase phase;

  /// Classified failure behind a [SessionActionPhase.failed] action.
  ///
  /// Typed rather than a finished sentence so the view renders it in the
  /// active locale. Anything this client decides itself belongs in [refusal];
  /// this field is only for a caught exception.
  final LocalizedFailure? failure;

  /// Typed reason this action was refused locally, if it was.
  ///
  /// Takes precedence over [failure] when the view renders a status line.
  final SessionActionRefusal? refusal;

  /// Created session id from fork/clone actions.
  final String? createdSessionId;

  /// Created session title from fork/clone actions.
  final String? createdSessionTitle;

  /// Whether the action is currently in flight.
  bool get isBusy => phase == SessionActionPhase.inProgress;

  /// Whether the action completed successfully.
  bool get isSuccess => phase == SessionActionPhase.success;
}

/// Debug description for a typed [WireEvent].
String describeWireEvent(WireEvent event) {
  return switch (event) {
    HelloWireEvent(:final brokerVersion, :final compatibility) =>
      'hello: broker $brokerVersion (${compatibility.status.wireValue})',
    SessionWireEvent(:final info) =>
      'session: ${info.title.isNotEmpty ? info.title : info.id}',
    HistoryWireEvent(:final messages) =>
      'history: ${_countLabel(messages.length, 'message')}'
          '${_historicalResolutionLabel(messages)}',
    HistoryPageWireEvent(:final messages) =>
      'history page: ${_countLabel(messages.length, 'message')}',
    MessageWireEvent(:final message) => 'message: ${_describeMessage(message)}',
    CommandsWireEvent(:final commands) =>
      'commands: ${_countLabel(commands.length, 'command')}',
    OptionsWireEvent(:final models, :final agents, :final modes) =>
      'options: ${models.length} models, ${agents.length} agents, '
          '${modes?.length ?? 0} modes',
    NoticeWireEvent(:final message) => 'notice: $message',
    EndedWireEvent(:final reason) => 'ended: ${reason ?? 'no reason'}',
    ErrorWireEvent(:final message) => 'error: $message',
    DraftWireEvent(:final text) => 'draft: ${_describeDraft(text)}',
    AckWireEvent(:final ackKind) => 'ack: $ackKind',
    NackWireEvent(:final code) => 'nack: $code',
    AttachConflictWireEvent(:final reason, :final code) =>
      'attach conflict: $reason ($code)',
    UnknownWireEvent(:final kind, :final raw) =>
      raw['summary'] is String
          ? raw['summary']! as String
          : 'unknown: ${kind ?? 'missing kind'}',
  };
}

/// Identity evidence for one canonical message, for the gated Debug timeline.
///
/// Enough to tell whether two rows are one message or two — which is the whole
/// question when saved history and a still-live copy overlap at an attach
/// boundary — without putting transcript text on screen. Text is represented by
/// its size and a fingerprint only, so two rows can be compared for equality
/// and nothing else. Adding the text itself here would leak the transcript into
/// screenshots and bug reports.
String _describeMessage(AgentMessage message) {
  final parts = <String>[message.type.wireValue];
  void add(String label, Object? value) {
    final text = value is String ? value : value?.toString();
    if (text != null && text.isNotEmpty) parts.add('$label=$text');
  }

  add('key', message.raw['key']);
  add('id', message.id);
  add('seq', message.seq);
  add('turn', message.raw['turnId']);
  final text = message.raw['text'];
  if (text is String) parts.add('text=${_textEvidence(text)}');
  return parts.join(' ');
}

/// Redacted evidence for the shared composer draft, for the same timeline.
///
/// A draft is not transcript content, but it is still a body — the user's
/// unsent words — and this surface ends up in screenshots and bug reports.
/// Size plus the fingerprint is what the draft lane actually needs read off it:
/// whether two clients hold the same revision, and whether a send cleared it.
/// An empty draft stays spelled out, because "cleared" is a different fact from
/// "short".
String _describeDraft(String text) =>
    text.isEmpty ? 'cleared' : _textEvidence(text);

/// Size and fingerprint of a text body, never the body.
///
/// The size is in UTF-16 code units because that is what `String.length`
/// counts and what the fingerprint below walks; calling it bytes would be wrong
/// for anything outside the BMP.
String _textEvidence(String text) =>
    '${text.length}cu/${_textFingerprint(text)}';

/// Short non-reversible fingerprint of a text body (FNV-1a over code units).
///
/// A comparison aid, deliberately not a security primitive: it exists so the
/// Debug timeline can show that two rows carry the same body without carrying
/// it. Local to this file so no caller can mistake it for content.
String _textFingerprint(String text) {
  var hash = 0x811c9dc5;
  for (final unit in text.codeUnits) {
    hash = ((hash ^ unit) * 0x01000193) & 0xffffffff;
  }
  return hash.toRadixString(16).padLeft(8, '0');
}

String _historicalResolutionLabel(List<AgentMessage> messages) {
  final resolutions = messages.where(
    (message) =>
        message.type == AgentMessageType.permissionResolved ||
        message.type == AgentMessageType.questionResolved,
  );
  if (resolutions.isEmpty) return '';
  final labels = resolutions
      .map((message) => message.type.wireValue)
      .join(', ');
  return ' ($labels)';
}

String _countLabel(int count, String noun) {
  final suffix = count == 1 ? '' : 's';
  return '$count $noun$suffix';
}
