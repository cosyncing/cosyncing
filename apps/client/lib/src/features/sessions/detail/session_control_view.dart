import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';

/// The single ownership fact surfaced as one status pill (the oracle's §1
/// "what the user sees" row).
///
/// Source of truth: the broker repo's Agent Control Oracle,
/// `docs/architecture/client-ui.md`. Do NOT model this off
/// the historical `ui-ux/16-unified-session-control.md` — its matrix is
/// inverted.
enum SessionControlPill {
  /// `terminalSync.active` — app and terminal are co-clients of one live owner.
  synced,

  /// `drive.state == driving` — the app owns an app-side continuation.
  driving,

  /// A shareable app Drive owner exists, but this socket remains read-only.
  driverActive,

  /// `terminalSync.syncAvailable && !active` — joinable now or via one command.
  syncAvailable,

  /// `drive.supported && drive.state == observing` — terminal owns input.
  observing,

  /// Neither ownership fact is provable; `reason` is surfaced.
  unavailable,

  /// `control` absent — wait for the broker's fail-closed ownership fact.
  unknown,
}

/// The single auto-routed next action (the oracle's one-button model). Sync and
/// Take over deliberately share one slot but never one handler: Sync is a join
/// (no confirm), Take over is a takeover (confirm required).
enum SessionControlAction {
  /// Nothing to do — the composer is already live (or read-only answer-only).
  none,

  /// "Resume in terminal" handoff. Copying the command demotes the app to
  /// Observe so the broker-owned drive process cannot contest the terminal.
  handoff,

  /// Show the adapter's join command (`control.terminalSync.command`).
  join,

  /// Takeover, with the load-bearing confirm dialog.
  takeOver,

  /// Observe-only; the action button is disabled with a reason.
  disabled,
}

/// Client-side derivation of the unified session-control model from the
/// broker's [SessionControlState] (`SessionInfo.control`).
///
/// Encodes the oracle's **two gates**: [canMutate] (permission/question cards
/// are actionable) is `driving || syncActive`; [canPrompt] (the composer is
/// live) is that minus answer-only sync. A model with a single gate cannot
/// represent Claude hooks-sync, where cards are answerable but the composer is
/// not. The broker enforces both server-side; this view drives the UI only.
class SessionControlView {
  /// Creates a [SessionControlView].
  const SessionControlView({
    required this.pill,
    required this.action,
    required this.canMutate,
    required this.canPrompt,
    required this.willFork,
    required this.answerOnly,
    this.canTakeOver = false,
    this.takeoverMode,
    this.reason,
    this.command,
    this.launchSurface,
    this.terminalPresence,
    this.terminalBehind,
  });

  /// Derives the view from a [SessionInfo] (null-safe on `control`).
  factory SessionControlView.fromSessionInfo(SessionInfo? info) =>
      SessionControlView.fromControl(
        info?.control,
        launchSurface: info?.launchSurface,
        sessionOwner: info?.sessionOwner,
        attachMode: info?.attachMode,
      );

  /// Derives a detail view using broker-projected socket authority/action data.
  factory SessionControlView.fromSessionDetail({
    required SessionInfo? info,
    required SessionConnectionAuthority? authority,
    required SessionJoinExistingAction? joinExisting,
    bool socketReadOnly = false,
  }) => SessionControlView.fromControl(
    info?.control,
    launchSurface: info?.launchSurface,
    sessionOwner: info?.sessionOwner,
    authority: authority,
    joinExisting: joinExisting,
    attachMode: info?.attachMode,
    socketReadOnly: socketReadOnly,
  );

  /// Derives the complete Session Detail view from connection-qualified state.
  factory SessionControlView.fromSessionDetailState(SessionDetailState state) =>
      SessionControlView.fromSessionDetail(
        info: state.sessionInfo,
        authority: state.connectionAuthority,
        joinExisting: state.joinExisting,
        socketReadOnly: state.compatibilityReadOnly,
      );

  /// Derives the view from the raw [SessionControlState].
  ///
  /// When [control] is null (normally the short window before the first
  /// `session` frame) this fails closed, matching the broker gates. A missing
  /// ownership fact must never briefly enable mutation on an Observe attach.
  factory SessionControlView.fromControl(
    SessionControlState? control, {
    SessionLaunchSurface? launchSurface,
    SessionOwnerProjection? sessionOwner,
    SessionConnectionAuthority? authority,
    SessionJoinExistingAction? joinExisting,
    AttachMode? attachMode,
    bool socketReadOnly = false,
  }) {
    // An attach mode this contract revision does not know means the client
    // cannot say what attaching to this session grants. It renders read-only
    // immediately, without waiting for the broker's answer, so the window
    // between connecting and the read-only re-attach landing is never a window
    // where the composer is live. The broker enforcement is the authority; this
    // is what makes the UI agree with it from the first frame.
    if (control == null || attachMode == AttachMode.unknown) {
      return const SessionControlView(
        pill: SessionControlPill.unknown,
        action: SessionControlAction.disabled,
        canMutate: false,
        canPrompt: false,
        willFork: false,
        answerOnly: false,
      );
    }

    final drive = control.drive;
    final sync = control.terminalSync;
    final terminalAction = _deriveTerminalAction(sync.action);
    final driving = drive.state == DriveState.driving;
    // Mirror the broker's two gates exactly (packages/typescript/broker/src/main.ts —
    // canMutateSession / canPromptSession), including the `.supported &&`
    // guards. Prompt-class kinds (prompt/file/command) ride canPrompt;
    // card kinds (approve/answer/reject-question) ride the broader canMutate.
    final driveMutable = drive.supported && driving;
    final syncMutable = sync.supported && sync.active;
    final legacyAnswerOnly = syncMutable && sync.input == _answerOnly;
    final canMutate = authority?.canMutate ?? (driveMutable || syncMutable);
    final canPrompt = authority == null
        ? driveMutable || (syncMutable && !legacyAnswerOnly)
        : authority.canMutate &&
              authority.prompt == SessionPromptAuthority.full;
    final answerOnly = authority == null
        ? legacyAnswerOnly
        : authority.canMutate &&
              authority.prompt == SessionPromptAuthority.answerOnly;
    final syncActiveHere = syncMutable && (authority == null || canMutate);
    final driveActiveHere = driveMutable && (authority == null || canPrompt);
    final shareableDriverActive =
        !canMutate &&
        joinExisting != null &&
        sessionOwner?.state == SessionOwnerState.drive;

    // Whether THIS socket can take the session over, resolved before the
    // precedence cascade because the pill and the action have to agree with it.
    //
    // They used to be computed independently, and Kimi is where they disagreed:
    // a session this broker did not create publishes `supported: false` with
    // `state: observing`, so every branch below fell through to `unavailable` —
    // the header read "Unavailable" and the composer said the app could neither
    // take over nor sync, beside a Take over button that worked. The rule now
    // is simply that a takeable session is never described as untakeable.
    //
    // `takeoverAvailable` exists because a session can be legitimately takeable
    // while not drivable NOW: a demoted Kimi connection publishes
    // `supported: false, state: unavailable` deliberately — re-driving that
    // generation would fork the journal — so the historical
    // `supported && observing` rule can never fire there and re-takeover would
    // be unreachable without it. An ABSENT field is an older broker and keeps
    // exactly today's rule.
    //
    // An unknown `takeoverMode` fails closed. Taking over means attaching in a
    // specific mode, and a client that cannot name the mode would have to
    // guess; guessing `resume` on a session that requires `live` seizes Drive
    // the wrong way rather than not at all. `observe` fails closed for the same
    // reason from the other side: it is a mode this client understands
    // perfectly and it grants no authority, so a takeover performed in it could
    // only ever fail.
    final takeoverPossible =
        !socketReadOnly &&
        drive.takeoverMode != AttachMode.unknown &&
        drive.takeoverMode != AttachMode.observe &&
        !syncActiveHere &&
        !shareableDriverActive &&
        (drive.takeoverAvailable ??
            (drive.supported && drive.state == DriveState.observing));

    // Precedence (oracle): sync-active > driving > sync-available > observing
    // > neither. Sync and Drive are mutually exclusive display states.
    final SessionControlPill pill;
    final SessionControlAction action;
    if (syncActiveHere) {
      // Synced shows no button; the composer is live unless answer-only, in
      // which case the cards stay actionable but the composer is gated off.
      pill = SessionControlPill.synced;
      action = SessionControlAction.none;
    } else if (driveActiveHere) {
      pill = SessionControlPill.driving;
      // Older brokers omit the additive terminal action. Preserve the
      // established Drive behavior in that case: copying the resume command
      // hands ownership back to the terminal.
      final resolved = terminalAction ?? SessionControlAction.handoff;
      // `handoffAvailable: false` says this agent has no read-only session to
      // hand back to — dsh serves one undifferentiated client contract and
      // refuses every non-live attach — so the broker would refuse the call.
      // Offering a button that can only fail is worse than offering none. An
      // ABSENT field is an older broker, which must keep today's behavior.
      action =
          resolved == SessionControlAction.handoff &&
              drive.handoffAvailable == false
          ? SessionControlAction.none
          : resolved;
    } else if (shareableDriverActive) {
      pill = SessionControlPill.driverActive;
      action = SessionControlAction.none;
    } else if (sync.supported && sync.syncAvailable) {
      pill = SessionControlPill.syncAvailable;
      action = terminalAction ?? SessionControlAction.join;
    } else if (drive.state == DriveState.observing &&
        (drive.supported || takeoverPossible)) {
      // Observing covers two shapes: a session cosyncing could drive itself,
      // and one it will not drive on its own but the operator may authorize.
      // `supported` alone missed the second — the row is observing, and saying
      // "Unavailable" about a session with a live Take over button is false.
      pill = SessionControlPill.observing;
      // The session is drivable, but not BY THIS SOCKET: a read-only attach
      // renounced authority, and the read-only latch is monotone, so the
      // re-attach a takeover would issue is still read-only and cannot
      // succeed. The pill stays truthful about the session; the action does
      // not offer a control that can only fail.
      action = takeoverPossible
          ? SessionControlAction.takeOver
          : SessionControlAction.disabled;
    } else {
      // Includes the takeable-but-not-drivable shape: a demoted Kimi
      // generation publishes `state: unavailable` and means it — that
      // generation is finished and nothing reattaching to it can drive — so
      // both the pill and the auto-routed action go on describing it honestly.
      //
      // Takeover is NOT lost here. `canTakeOver` below is a separate
      // affordance with its own control (session_detail_composer, and the
      // header in session_detail_chrome), so a takeover that opens a fresh
      // generation stays one tap away without the primary slot having to
      // claim this session is drivable as it stands. Promoting the action
      // here would claim exactly that, and it is false.
      pill = SessionControlPill.unavailable;
      action = SessionControlAction.disabled;
    }

    return SessionControlView(
      pill: pill,
      action: action,
      canMutate: canMutate,
      canPrompt: canPrompt,
      willFork: drive.willFork ?? false,
      answerOnly: answerOnly,
      // Drive recovery must stay reachable on EVERY supported Observing
      // session — including when terminal sync is merely available (the pill
      // then reads "Sync available" and the primary action is Join). Sync
      // availability is a capability, not ownership; it must never leave
      // Join as the only path (CR1). Resolved above the cascade, which now has
      // to agree with it.
      canTakeOver: takeoverPossible,
      takeoverMode: drive.takeoverMode,
      reason: drive.reason ?? sync.reason,
      command: sync.command,
      launchSurface: launchSurface,
      terminalPresence: sync.presence,
      terminalBehind: sync.behind,
    );
  }

  static SessionControlAction? _deriveTerminalAction(
    TerminalSyncAction? terminalAction,
  ) => switch (terminalAction) {
    TerminalSyncAction.join => SessionControlAction.join,
    TerminalSyncAction.handoff => SessionControlAction.handoff,
    TerminalSyncAction.unknown || null => null,
  };

  static const _answerOnly = 'answer-only';

  /// The ownership fact to render as the status pill.
  final SessionControlPill pill;

  /// The single auto-routed action the control button offers.
  final SessionControlAction action;

  /// Whether the app may answer permission/question cards right now
  /// (`driving || syncActive`).
  final bool canMutate;

  /// Whether the composer may send a new prompt right now ([canMutate] minus
  /// answer-only sync).
  final bool canPrompt;

  /// Whether taking over will continue in a fork (Claude's live-owner probe;
  /// always false for Codex/OpenCode/Pi, which never fork).
  final bool willFork;

  /// Whether the session is synced but accepts answers only — cards are live,
  /// the composer stays read-only (Claude hooks-sync).
  final bool answerOnly;

  /// Whether the manual Take over recovery is reachable right now.
  ///
  /// True for every supported broker-confirmed Observing session that is not
  /// actively synced — independent of the pill, so `syncAvailable` (whose
  /// primary [action] is Join) still exposes Drive as a secondary action.
  final bool canTakeOver;

  /// Which attach mode a takeover must use, when the broker declares one.
  ///
  /// Carried beside [canTakeOver] rather than re-read at the call site so the
  /// decision and the mode it was made under cannot drift apart. Null means the
  /// broker declared nothing and the historical `resume` applies; while
  /// [canTakeOver] is true it is only ever [AttachMode.live] or
  /// [AttachMode.resume], because the two modes that cannot acquire authority
  /// — [AttachMode.unknown] and [AttachMode.observe] — fail that decision
  /// closed.
  final AttachMode? takeoverMode;

  /// The wire mode a takeover attach must request.
  ///
  /// Total over the values reachable when [canTakeOver] holds, so no call site
  /// has to guess at a mode it was not given.
  String get takeoverAttachMode =>
      takeoverMode == AttachMode.live ? 'live' : 'resume';

  /// Optional reason for a non-mutable state, surfaced to the user.
  final String? reason;

  /// The adapter's join/handoff command (`control.terminalSync.command`), used
  /// verbatim and never tool-branched.
  final String? command;

  /// The launch surface from broker telemetry, when available.
  final SessionLaunchSurface? launchSurface;

  /// Current terminal presence for this session.
  final TerminalSyncPresence? terminalPresence;

  /// Whether the terminal side is behind accepted app-side mutations.
  final bool? terminalBehind;
}
