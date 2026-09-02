import 'dart:async';
import 'dart:collection';
import 'dart:ui' show PointerDeviceKind;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/app/shortcuts/app_shortcuts.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/attention/view/visible_attention_session_scope.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_schedule_diagnostics.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_scheduled_message_controller.dart';
import 'package:cosyncing_client/src/features/schedules/view/inline_schedule_action_message.dart';
import 'package:cosyncing_client/src/features/schedules/view/inline_scheduled_message_card.dart';
import 'package:cosyncing_client/src/features/schedules/view/schedule_message_sheet.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_html_handoff.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_viewer_pane.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_presenter.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_result.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_transfer.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_transfer_worker.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_clipboard.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_intake.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_picker.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_cache.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_context_meter.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_control_preferences_store.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_control_view.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_bootstrap_state.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_connection.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_retirement_ledger.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_drive_intent_store.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_live_state.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_live_state_view_store.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_telemetry.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_tab_strip.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_freshness.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_presentation.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_model_preference_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/features/sessions/requests/session_command_args_codec.dart';
import 'package:cosyncing_client/src/features/sessions/requests/session_request_action_helpers.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_conversation_turns.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_draft_store.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_file_link_scope.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_progress.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_body.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/session_viewport_registry.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/debug_views_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/tool_display_controller.dart';
import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_controller.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_rate_controller.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:cosyncing_client/src/features/voice/model/voice_transcript_insertion.dart';
import 'package:cosyncing_client/src/features/voice/view/read_aloud_action.dart';
import 'package:cosyncing_client/src/features/voice/view/voice_input_panel.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_hold.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/foundation.dart' show ValueListenable, kIsWeb;
import 'package:flutter/gestures.dart' show PointerScrollEvent;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart'
    show
        RenderAbstractViewport,
        ScrollCacheExtent,
        SelectedContent,
        SelectionStatus;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

part 'session_detail_action_copy.dart';
part 'session_detail_agent_control.dart';
part 'session_detail_attachment_intake.dart';
part 'session_detail_bootstrap_view.dart';
part 'session_detail_chat_live.dart';
part 'session_detail_chrome.dart';
part 'session_detail_composer.dart';
part 'session_detail_conversation_turn.dart';
part 'session_detail_debug.dart';
part 'session_detail_files_terminal.dart';
part 'session_detail_live_cards.dart';
part 'session_detail_message_actions.dart';
part 'session_detail_model_label.dart';
part 'session_detail_slash_palette.dart';
part 'session_detail_transcript.dart';
part 'session_detail_transfers_artifacts.dart';
part 'session_detail_view_chrome.dart';
part 'session_detail_view_menu.dart';

/// Live attach shell for one broker session.
///
/// Module G5 adds artifact descriptor-driven download/fetch affordances.
/// Module G6 adds artifact persistence/export wiring.
/// Module G7 adds HTML artifact preview plumbing.
/// Module J29 adds in-page Chat/Terminal/Artifacts/Debug tabs for session work surfaces.
/// Module K11 adds read-only terminal-tab polishing (bounded latest output,
/// show-all/show-latest toggle, and copy-visible).
/// Module N2 adds capability-driven fork and clone session actions.
/// Module N5 adds the read-only remote Files tab.
///
/// References:
/// - `docs/protocol/contract-sync.md`
/// - `docs/architecture/client-ui.md`
class SessionDetailPage extends ConsumerStatefulWidget {
  /// Creates the [SessionDetailPage].
  const SessionDetailPage({
    required this.tool,
    required this.sessionId,
    this.embedded = false,
    super.key,
  });

  /// Broker tool id.
  final String tool;

  /// Session id within [tool].
  final String sessionId;

  /// Whether this page is hosted inside the expanded Sessions workspace.
  ///
  /// Embedded detail keeps its body scaffold but omits the redundant inner
  /// app bar; the workspace's session strip is already above it.
  final bool embedded;

  @override
  ConsumerState<SessionDetailPage> createState() => _SessionDetailPageState();
}

/// The session body's five destinations. Chat is primary; the rest are reached
/// from the strip's `⋮` menu (Variant C).
enum _SessionDetailView { chat, status, terminal, files, debug }

/// Fixed slot order for the body's view switcher.
///
/// Terminal keeps its slot even while hidden, so the surrounding views do not
/// change index — and lose their state — when terminal output first arrives.
const List<_SessionDetailView> _kSessionViewOrder = [
  _SessionDetailView.chat,
  _SessionDetailView.status,
  _SessionDetailView.terminal,
  _SessionDetailView.files,
  _SessionDetailView.debug,
];

final class _SubmittedPromptSnapshot {
  const _SubmittedPromptSnapshot(this.text);
  final String text;
}

class _SessionDetailPageState extends ConsumerState<SessionDetailPage>
    with WidgetsBindingObserver {
  static const int _maxArchivedLiveStateEntries = 32;
  late final SessionDetailKey _key;
  late final TextEditingController _promptController;
  late final TextEditingController _commandArgsController;
  late final FocusNode _promptFocusNode;
  bool _isSendingPrompt = false;
  bool _isSendingCommand = false;
  bool _isPickingAttachments = false;
  int _attachmentIntakeGeneration = 0;
  final Set<_SessionAttachmentIntakeLease> _attachmentIntakeLeases = {};
  void _updateAttachmentIntake(VoidCallback update) => setState(update);
  bool _isRetryingBootstrap = false;
  String? _selectedCommandName;
  String? _commandArgsError;
  Map<String, dynamic>? _parsedCommandArgs;
  SessionCurrentModel? _selectedModelOverride;
  String? _selectedPermissionModeOverride;
  SessionModelPreferenceKey? _modelPreferenceKey;
  SessionCurrentModel? _persistedModelCandidate;
  bool _modelPreferenceLoadScheduled = false;
  bool _modelPreferenceApplyScheduled = false;
  bool _modelSelectionTouched = false;
  ProviderContainer? _providerContainer;
  bool _tabEnsureScheduled = false;
  String? _suppressedSessionTabKey;
  Timer? _draftSyncTimer;

  /// Removes this composer from the web-update handoff registry (N3b).
  VoidCallback? _releaseHandoffParticipation;

  /// The composer value frozen for a web-update commit, or null when free.
  ///
  /// Non-null means the composer is locked: the handoff has captured this exact
  /// text, is persisting it, and is about to move the tab. Accepting an edit
  /// now would produce a value nothing has saved.
  String? _handoffLockedText;
  int _lastLocalDraftEditAt = 0;
  int _lastAppliedRemoteDraftAt = -1;
  String? _lastAppliedRemoteDraftText;
  int _scheduledRemoteDraftAt = -1;
  String? _scheduledRemoteDraftText;
  bool _applyingRemoteDraft = false;
  int _lastAppliedDraftSurfaceToken = 0;
  ({SessionDraftSurface value, int generation})? _stagedComposingDraftSurface;
  ({DraftWireEvent value, int generation})? _stagedComposingRemoteDraft;
  int? _stagedCompositionDrainGeneration;
  Map<String, String> _archivedLiveState = const {};
  bool _liveStateArchiveLoaded = false;
  bool _terminalFresh = false;
  bool _terminalTabVisible = false;
  bool _terminalTabUpdateScheduled = false;
  bool _fileLinkGateProbeScheduled = false;
  _SessionDetailView _view = _SessionDetailView.chat;
  final GlobalKey _statusTabFlightTargetKey = GlobalKey(
    debugLabel: 'session-detail-status-flight-target',
  );
  String? _lastAuthoritativePermissionMode;
  bool _permissionModeObserved = false;
  bool _permissionModeReconcileScheduled = false;
  bool _reportView = false;
  bool _toolsExpanded = false;
  int _toolExpansionRevision = 0;
  int _promptRevision = 0;
  ({String text, int revision})? _pendingPromptClear;
  _SubmittedPromptSnapshot? _lastSubmittedPrompt;
  int _profileTransitionGeneration = 0;

  /// True while a previous incarnation is still retiring this session's
  /// transport.
  ///
  /// The credential gate can remount this page before the outgoing subtree's
  /// supervisor finishes retiring the same session. While the ledger holds
  /// that retirement, `build` must not subscribe to the session's detail
  /// provider: Riverpod rebuilds an invalidated-but-watched notifier on the
  /// SAME instance, so a subscription held across the retirement's closing
  /// invalidate would resurrect the retired controller — disposed flag set,
  /// pre-credential connection still referenced — instead of letting a fresh
  /// one be built. [_attachInitialSession] clears the flag once the key is
  /// free.
  bool _awaitingRetirementHandoff = false;

  /// The controller state, qualified against the active broker profile.
  ///
  /// Every read outside `build` goes through here for the same reason `build`
  /// does: after a profile switch the controller keeps the previous profile's
  /// session frame until its queued attach finishes tearing the old connection
  /// down, and acting on that frame means showing, saving, or keying on the
  /// wrong broker's session. See [SessionDetailState.forActiveSource].
  SessionDetailState get _sessionState => readQualifiedDetail(ref, _key);
  @override
  void initState() {
    super.initState();
    _key = SessionDetailKey(
      tool: widget.tool,
      sessionId: widget.sessionId,
    );
    _awaitingRetirementHandoff =
        ref.read(sessionDetailRetirementLedgerProvider).pendingFor(_key) !=
        null;
    _promptController = TextEditingController()..addListener(_onPromptChanged);
    _commandArgsController = TextEditingController()
      ..addListener(_onCommandArgsChanged);
    _promptFocusNode = FocusNode(debugLabel: 'session-detail-prompt')
      ..addListener(_onPromptFocusChanged);
    // While the previous incarnation's retirement is pending, even a plain
    // read of the detail provider is off limits: in the window between the
    // retirement's invalidate and Riverpod's dispose pass, a read would flush
    // the invalidated element and rebuild the retired notifier in place.
    // [_attachInitialSession] derives this from the fresh controller instead.
    if (!_awaitingRetirementHandoff) {
      _terminalTabVisible = _sessionState.terminalOutputMessages.isNotEmpty;
      _terminalFresh = _terminalTabVisible;
    }
    WidgetsBinding.instance.addObserver(this);
    unawaited(_loadLiveStateArchive());
    // N3b: this composer is the app's durable device-local state on the web, so
    // it is what decides whether the tab may be moved through a web-update
    // handoff. Registering also installs the browser hook; while no composer is
    // mounted the tab has nothing to lose and the page moves it immediately.
    _releaseHandoffParticipation = WebHandoffParticipants.instance.register(
      WebHandoffParticipant(
        isBusy: _isActivelyEditing,
        flush: _flushForHandoff,
        lock: _lockForHandoff,
        release: _releaseForHandoff,
      ),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _providerContainer = ProviderScope.containerOf(context);
        unawaited(_attachInitialSession());
      }
    });
  }

  /// Runs the mount-time attach once this session's key is free to own.
  ///
  /// This page can remount while the previous Sessions subtree is still
  /// retiring the same session's transport: the credential gate swaps the
  /// subtree on a gate refresh, and the outgoing supervisor's retirements are
  /// asynchronous. Attaching before that handoff completes would revive the
  /// outgoing controller's connection — with the resolver captured before the
  /// credential change — and the retirement's closing invalidate would then
  /// rebuild the provider out from under this page's attach. Wait for the
  /// ledger to clear, then attach the freshly built controller.
  Future<void> _attachInitialSession() async {
    final ledger = ref.read(sessionDetailRetirementLedgerProvider);
    var retirement = ledger.pendingFor(_key);
    while (retirement != null) {
      await retirement;
      if (!mounted) return;
      retirement = ledger.pendingFor(_key);
    }
    if (_awaitingRetirementHandoff) {
      // Let the handoff-clearing rebuild establish both the page's production
      // watch and the supervisor's resident lease before starting transport
      // work. Reading the notifier immediately creates an unlistened family
      // element in the retirement callback; autoDispose can reap it while its
      // async interactive attach is resolving, after which the supervisor
      // builds a second controller that attaches only in background Observe.
      setState(() => _awaitingRetirementHandoff = false);
      await WidgetsBinding.instance.endOfFrame;
      if (!mounted) return;
      // First provider contact since mount now reads the controller retained
      // by the rebuilt page. Terminal visibility was deliberately not
      // initialized from the retiring one in initState.
      final refreshed = _sessionState;
      setState(() {
        _terminalTabVisible = refreshed.terminalOutputMessages.isNotEmpty;
        _terminalFresh = _terminalTabVisible;
      });
    }
    final controller = ref.read(
      sessionDetailControllerProvider(_key).notifier,
    );
    unawaited(controller.attach());
    // DR1b: an open session is resident, so this composer may be brand new
    // while the controller behind it never disconnected and will therefore
    // never hydrate again. Ask for the durable row explicitly; the offer is
    // restore-if-empty, so it cannot disturb a composer with content.
    unawaited(controller.offerDurableDraftToComposer());
  }

  /// Whether the user is mid-edit, so this tab must not be moved (N3b).
  ///
  /// Focus alone is not enough — an empty focused composer has nothing to
  /// interrupt — and text alone is not enough either, because an unfocused
  /// draft is exactly what the flush below makes durable. Both together mean
  /// someone is typing, and taking the document away mid-sentence is worse than
  /// staying on the previous build for another minute.
  bool _isActivelyEditing() =>
      _hasUnsavedCommandArgs() ||
      (_promptFocusNode.hasFocus && _promptController.text.trim().isNotEmpty);

  /// Whether the slash-command arguments field holds something (N3b).
  ///
  /// Unlike the prompt, these are not durable: nothing persists them, and
  /// returning to this route after a handoff would present an empty field with
  /// no trace of what was typed. So they defer the handoff outright, focused or
  /// not, and clearing them announces readiness through the args listener.
  bool _hasUnsavedCommandArgs() => _commandArgsController.text.isNotEmpty;

  /// Freezes the composer and captures the exact value to persist (N3b).
  ///
  /// Runs synchronously inside the page's commit call, which is what makes the
  /// handoff lossless. Several seconds separate this composer agreeing to move
  /// from being told to go, and the user keeps typing throughout: a value
  /// flushed at the start of that window is not the value on screen at the end
  /// of it. Freezing first, in one uninterrupted turn of the event loop, means
  /// no keystroke can land between the capture and the navigation.
  ///
  /// Refuses outright while the composer has focus and content — the same
  /// mid-sentence case [_isActivelyEditing] covers, re-asked at the last
  /// possible moment because the user may have started typing since.
  bool _lockForHandoff() {
    if (_isActivelyEditing()) return false;
    _draftSyncTimer?.cancel();
    _draftSyncTimer = null;
    _handoffLockedText = _promptController.text;
    _promptFocusNode.unfocus();
    if (mounted) setState(() {});
    return true;
  }

  /// Unfreezes the composer after an abandoned round (N3b).
  void _releaseForHandoff() {
    if (_handoffLockedText == null) return;
    _handoffLockedText = null;
    if (mounted) setState(() {});
  }

  /// Makes this composer's value durable before the tab leaves the page (N3b).
  ///
  /// Persists the frozen capture when one exists, then proves nothing slipped
  /// past: if the live controller no longer matches what was captured, a
  /// keystroke landed inside the freeze and this reports failure so the round
  /// is abandoned rather than navigating away from text it did not save.
  /// Declining a handoff is recoverable; losing an unsent prompt is not.
  ///
  /// Runs through the shared coalescing path, so an unchanged value is a true
  /// no-op.
  Future<bool> _flushForHandoff() async {
    final container = _providerContainer;
    if (container == null) return true; // nothing has been typed into it yet
    _draftSyncTimer?.cancel();
    _draftSyncTimer = null;
    final captured = _handoffLockedText ?? _promptController.text;
    final result = await _transferDraftPersistence(container, captured);
    if (!result.isDurable) return false;
    return _promptController.text == captured;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // N3b: leave the handoff registry before the controllers below are torn
    // down, so a prepare that arrives during teardown can never read a disposed
    // FocusNode or TextEditingController.
    _releaseHandoffParticipation?.call();
    _releaseHandoffParticipation = null;
    _cancelAttachmentIntakeForDispose();
    _draftSyncTimer?.cancel();
    // DR1: flush the durable local draft one last time before the composer
    // leaves the tree. Uses the captured container (never `ref` during
    // dispose); the controller swallows any late-lifecycle error internally.
    // Skipped while the retirement handoff is pending: this page never owned
    // the session (the composer never rendered, so there is no draft to
    // save), and reading the retiring provider here could flush an
    // invalidated element back to life.
    final container = _providerContainer;
    if (container != null && !_awaitingRetirementHandoff) {
      unawaited(_transferDraftPersistence(container, _promptController.text));
    }
    // The auto-disposed speech-input provider cancels recognition when the
    // composer leaves the tree. Do not read Riverpod ref during dispose.
    _promptController
      ..removeListener(_onPromptChanged)
      ..dispose();
    _commandArgsController
      ..removeListener(_onCommandArgsChanged)
      ..dispose();
    _promptFocusNode
      ..removeListener(_onPromptFocusChanged)
      ..dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Background/inactive/hidden/detached lifecycle cancels ASR (discard partial)
    // and releases the mic. It must not continue recording silently.
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      unawaited(ref.read(voiceInputControllerProvider.notifier).cancel());
      // DR1: app backgrounding (and web pagehide, which surfaces as hidden)
      // is a durability boundary — flush the coalesced local draft now.
      _flushLocalDraftNow();
    }
  }

  bool get _composerEnabled {
    // N3b: a web-update commit has captured this exact text and is about to
    // move the tab. An edit accepted now would be a value nothing has saved,
    // so the composer is closed for the fraction of a second the freeze lasts.
    if (_handoffLockedText != null) return false;
    final state = _sessionState;
    final connected =
        state.connectionStatus == SessionDetailConnectionStatus.connected;
    // The composer only sends prompt-class kinds, so it rides the narrow gate
    // (canPrompt) — read-only Observe and answer-only sync both block it. Cards
    // ride the broader canMutate and are handled in the transcript surface.
    return connected &&
        !state.compatibilityReadOnly &&
        SessionControlView.fromSessionDetailState(state).canPrompt;
  }

  void _onPromptChanged() {
    if (!mounted) {
      return;
    }

    // Count every controller mutation, including remote/programmatic changes
    // and edits that return to the same empty value. A Stop completion may
    // restore an accepted prompt only while it still owns this exact revision.
    _promptRevision++;
    setState(() {});
    _scheduleStagedCompositionDrain();
    if (_applyingRemoteDraft) {
      return;
    }
    ref
        .read(sessionDetailControllerProvider(_key).notifier)
        .stageLocalDraft(_promptController.text);
    _lastLocalDraftEditAt = DateTime.now().millisecondsSinceEpoch;
    _scheduleLocalDraftSync();
  }

  bool get _promptHasActiveComposition {
    final composing = _promptController.value.composing;
    return composing.isValid && !composing.isCollapsed;
  }

  void _scheduleStagedCompositionDrain() {
    final generation = _profileTransitionGeneration;
    if (_stagedComposingDraftSurface case final staged?
        when staged.generation != generation) {
      _stagedComposingDraftSurface = null;
    }
    if (_stagedComposingRemoteDraft case final staged?
        when staged.generation != generation) {
      _stagedComposingRemoteDraft = null;
    }
    if (_promptHasActiveComposition ||
        _stagedCompositionDrainGeneration == generation ||
        (_stagedComposingDraftSurface == null &&
            _stagedComposingRemoteDraft == null)) {
      return;
    }
    _stagedCompositionDrainGeneration = generation;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_stagedCompositionDrainGeneration == generation) {
        _stagedCompositionDrainGeneration = null;
      }
      if (!mounted ||
          generation != _profileTransitionGeneration ||
          _promptHasActiveComposition) {
        return;
      }
      final surface = _stagedComposingDraftSurface;
      final remote = _stagedComposingRemoteDraft;
      if (surface?.generation == generation) {
        _stagedComposingDraftSurface = null;
      }
      if (remote?.generation == generation) {
        _stagedComposingRemoteDraft = null;
      }
      if (surface case (
        :final value,
        generation: final stagedGeneration,
      ) when stagedGeneration == generation) {
        _applyDraftSurfaceNow(value, generation: generation);
      } else if (remote case (
        :final value,
        generation: final stagedGeneration,
      ) when stagedGeneration == generation) {
        _applyRemoteDraftNow(
          value,
          generation: generation,
          stagedDuringComposition: true,
        );
      }
    });
  }

  void _scheduleLocalDraftSync() {
    _draftSyncTimer?.cancel();
    _draftSyncTimer = Timer(const Duration(milliseconds: 300), () {
      _draftSyncTimer = null;
      if (!mounted) return;
      final text = _promptController.text;
      // DR1: the edit is persisted to the device-local durable draft whether
      // or not the session is connected; the broker relay happens inside the
      // same coalesced call when the transport is ready.
      unawaited(
        ref
            .read(sessionDetailControllerProvider(_key).notifier)
            .recordLocalDraft(text),
      );
    });
  }

  /// Immediate durable flush for lifecycle boundaries (focus loss, app
  /// backgrounding, route disposal). Coalesced with the debounce inside the
  /// controller — never a per-keystroke write.
  void _flushLocalDraftNow() {
    final container = _providerContainer ?? ProviderScope.containerOf(context);
    unawaited(_transferDraftPersistence(container, _promptController.text));
  }

  /// Keeps the auto-disposed controller alive until this exact value has
  /// crossed Drift or returned an explicit persistence failure.
  Future<SessionDraftPersistenceResult> _transferDraftPersistence(
    ProviderContainer container,
    String text,
  ) async {
    final provider = sessionDetailControllerProvider(_key);
    final lease = container.listen(
      provider,
      (previous, next) {},
      fireImmediately: true,
    );
    try {
      return await container.read(provider.notifier).flushLocalDraft(text);
    } finally {
      lease.close();
    }
  }

  /// Cancels the debounce and waits until this exact composer value has crossed
  /// the durable repository boundary before route-owned navigation tears the
  /// page down.
  Future<bool> _establishDraftDurabilityBarrier() async {
    _draftSyncTimer?.cancel();
    _draftSyncTimer = null;
    final result = await _transferDraftPersistence(
      _providerContainer ?? ProviderScope.containerOf(context),
      _promptController.text,
    );
    if (result.isDurable) return true;
    if (mounted) {
      final l10n = AppLocalizations.of(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            result == SessionDraftPersistenceResult.tooLarge
                ? l10n.sessionDraftTooLongStatus
                : l10n.sessionDraftSaveFailed,
          ),
        ),
      );
    }
    return false;
  }

  void _onPromptFocusChanged() {
    if (!_promptFocusNode.hasFocus && mounted) {
      _flushLocalDraftNow();
      // N3b: blurring is the moment a tab that deferred a web update becomes
      // movable again. Without this the tab would sit out the retry cadence
      // after the user stops typing instead of updating as soon as it can.
      WebHandoffParticipants.instance.notifyReadinessChanged();
    }
  }

  /// Applies controller-decided composer content (DR1) exactly once per
  /// token: durable hydration, clean shared adoption, and failure restore.
  void _applyDraftSurface(SessionDraftSurface? surface) {
    if (surface == null || surface.token <= _lastAppliedDraftSurfaceToken) {
      return;
    }
    final generation = _profileTransitionGeneration;
    _lastAppliedDraftSurfaceToken = surface.token;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _applyDraftSurfaceNow(surface, generation: generation);
    });
  }

  void _applyDraftSurfaceNow(
    SessionDraftSurface surface, {
    required int generation,
  }) {
    // Scheduling is not application: an older staged surface can drain after
    // a newer build callback has already applied. Revalidate the monotone
    // controller token and broker generation at the final mutation boundary.
    if (generation != _profileTransitionGeneration ||
        surface.token < _lastAppliedDraftSurfaceToken) {
      return;
    }
    final current = _promptController.text;
    if (_wouldEraseNewerPendingDraft(surface.text)) {
      return;
    }
    if (surface.text == current) {
      _confirmDraftSurfaceApplied(surface.token);
      return;
    }
    if (_promptHasActiveComposition) {
      final staged = _stagedComposingDraftSurface;
      if (staged == null ||
          staged.generation != generation ||
          surface.token >= staged.value.token) {
        _stagedComposingDraftSurface = (
          value: surface,
          generation: generation,
        );
      }
      return;
    }
    switch (surface.kind) {
      case SessionDraftSurfaceKind.restoreIfEmpty:
        if (current.isNotEmpty) return;
      case SessionDraftSurfaceKind.replace:
        final now = DateTime.now().millisecondsSinceEpoch;
        if (current.isNotEmpty &&
            _promptFocusNode.hasFocus &&
            now - _lastLocalDraftEditAt < 1500) {
          return;
        }
      case SessionDraftSurfaceKind.forceReplace:
        break;
    }
    _draftSyncTimer?.cancel();
    _draftSyncTimer = null;
    _applyingRemoteDraft = true;
    _promptController.value = TextEditingValue(
      text: surface.text,
      selection: TextSelection.collapsed(offset: surface.text.length),
    );
    _applyingRemoteDraft = false;
    _confirmDraftSurfaceApplied(surface.token);
  }

  /// Tells the controller this surface token demonstrably reached the
  /// composer. A recovered failed prompt's outbox row — its only durable copy
  /// — is deleted on this confirmation and never on mere scheduling, so a
  /// guard rejection, unmount, or crash before this point keeps the row
  /// recoverable.
  void _confirmDraftSurfaceApplied(int token) {
    unawaited(
      ref
          .read(sessionDetailControllerProvider(_key).notifier)
          .confirmDraftSurfaceApplied(token),
    );
  }

  void _scheduleRemoteDraftApply(DraftWireEvent? draft) {
    if (draft == null ||
        draft.at < _lastAppliedRemoteDraftAt ||
        (draft.at == _lastAppliedRemoteDraftAt &&
            draft.text == _lastAppliedRemoteDraftText) ||
        draft.at < _scheduledRemoteDraftAt ||
        (draft.at == _scheduledRemoteDraftAt &&
            draft.text == _scheduledRemoteDraftText)) {
      return;
    }
    _scheduledRemoteDraftAt = draft.at;
    _scheduledRemoteDraftText = draft.text;
    final generation = _profileTransitionGeneration;
    final scheduledDuringComposition = _promptHasActiveComposition;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          generation != _profileTransitionGeneration ||
          draft.at < _lastAppliedRemoteDraftAt ||
          (draft.at == _lastAppliedRemoteDraftAt &&
              draft.text == _lastAppliedRemoteDraftText) ||
          draft.at < _scheduledRemoteDraftAt ||
          (draft.at == _scheduledRemoteDraftAt &&
              draft.text != _scheduledRemoteDraftText)) {
        return;
      }
      _applyRemoteDraftNow(
        draft,
        generation: generation,
        stagedDuringComposition: scheduledDuringComposition,
      );
    });
  }

  void _applyRemoteDraftNow(
    DraftWireEvent draft, {
    required int generation,
    bool stagedDuringComposition = false,
  }) {
    // A composition drain may run a frame after a newer callback. Freshness
    // and source generation must be checked again here, not only when the
    // callback was scheduled.
    if (generation != _profileTransitionGeneration ||
        draft.at < _lastAppliedRemoteDraftAt ||
        (draft.at == _lastAppliedRemoteDraftAt &&
            draft.text == _lastAppliedRemoteDraftText) ||
        draft.at < _scheduledRemoteDraftAt ||
        (draft.at == _scheduledRemoteDraftAt &&
            draft.text != _scheduledRemoteDraftText)) {
      return;
    }
    final text = draft.text;
    if (_wouldEraseNewerPendingDraft(text)) {
      return;
    }
    if (text == _promptController.text) {
      _lastAppliedRemoteDraftAt = draft.at;
      _lastAppliedRemoteDraftText = text;
      return;
    }
    if (_promptHasActiveComposition) {
      final staged = _stagedComposingRemoteDraft;
      if (staged == null ||
          staged.generation != generation ||
          draft.at >= staged.value.at) {
        _stagedComposingRemoteDraft = (
          value: draft,
          generation: generation,
        );
      }
      return;
    }
    final now = DateTime.now().millisecondsSinceEpoch;
    if (!stagedDuringComposition &&
        _promptFocusNode.hasFocus &&
        now - _lastLocalDraftEditAt < 1500) {
      return;
    }
    _lastAppliedRemoteDraftAt = draft.at;
    _lastAppliedRemoteDraftText = text;
    _draftSyncTimer?.cancel();
    _draftSyncTimer = null;
    _applyingRemoteDraft = true;
    _promptController.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _applyingRemoteDraft = false;
    unawaited(
      ref
          .read(sessionDetailControllerProvider(_key).notifier)
          .adoptLegacySharedDraft(text),
    );
  }

  void _onCommandArgsChanged() {
    if (!mounted) {
      return;
    }

    final parsed = parseSessionCommandArgs(
      _commandArgsController.text,
      hasModelOverride: _selectedModelOverride != null,
    );
    setState(() {
      _commandArgsError = parsed.error;
      _parsedCommandArgs = parsed.args;
    });
    // Clearing the field is one of the two ways this tab stops deferring a
    // web-update handoff, and nothing else would notice it (N3b).
    if (!_hasUnsavedCommandArgs()) {
      WebHandoffParticipants.instance.notifyReadinessChanged();
    }
  }

  void _setCommandArgsFromSelection(SlashCommand? command) {
    // Governed by docs/architecture/client-ui.md:
    // command defaults prefill the editable args surface on selection changes.
    final prettyArgs = formatSessionCommandArgs(command?.args);
    _setCommandArgsText(prettyArgs);
    final parsed = parseSessionCommandArgs(
      prettyArgs,
      hasModelOverride: _selectedModelOverride != null,
    );
    _commandArgsError = parsed.error;
    _parsedCommandArgs = parsed.args;
  }

  void _setCommandArgsText(String text) {
    _commandArgsController
      ..removeListener(_onCommandArgsChanged)
      ..text = text
      ..addListener(_onCommandArgsChanged);
    // The listener is deliberately silenced above, so the readiness signal that
    // clearing the field would otherwise produce has to be sent here (N3b).
    if (!_hasUnsavedCommandArgs()) {
      WebHandoffParticipants.instance.notifyReadinessChanged();
    }
  }

  void _clearCommandSelection() {
    _selectedCommandName = null;
    _setCommandArgsText('');
    _commandArgsError = null;
    _parsedCommandArgs = null;
  }

  SlashCommand? _resolveSelectedCommand(List<SlashCommand> commands) {
    final selected = _selectedCommandName;
    if (selected == null) {
      return null;
    }
    for (final command in commands) {
      if (command.name == selected) {
        return command;
      }
    }
    return null;
  }

  Future<void> _sendPrompt() async {
    final submittedText = _promptController.text;
    final submittedRevision = _promptRevision;
    final trimmedPrompt = submittedText.trim();
    final state = _sessionState;
    if ((trimmedPrompt.isEmpty && state.stagedAttachments.isEmpty) ||
        _attachmentIntakeBlocksSend ||
        !_composerEnabled ||
        state.interruptPhase != SessionInterruptPhase.idle) {
      return;
    }

    final controller = ref.read(sessionDetailControllerProvider(_key).notifier);
    // A pending draft debounce must not fire after the prompt itself. The
    // broker clears shared draft state as part of accepting the prompt.
    _draftSyncTimer?.cancel();
    _draftSyncTimer = null;
    _pendingPromptClear = (
      text: submittedText,
      revision: submittedRevision,
    );
    setState(() => _isSendingPrompt = true);
    final success = await controller.sendPrompt(
      trimmedPrompt,
      model: _selectedModelOverride,
      // The same selection slash commands already carry. It is null whenever
      // the pick equals the session's authoritative mode, so an ordinary
      // prompt never re-asserts a mode — which would quietly outrank one the
      // server changed underneath it.
      permissionMode: _selectedPermissionModeOverride,
    );
    if (!mounted) {
      return;
    }

    if (success) {
      _lastSubmittedPrompt = _SubmittedPromptSnapshot(trimmedPrompt);
      // The composer stays editable while the prompt waits for its terminal
      // receipt. Only the exact submitted revision owns this clear; a later
      // draft must survive a slow adapter or reconnect-delayed ACK.
      if (_promptRevision == submittedRevision &&
          _promptController.text == submittedText) {
        _cancelAttachmentIntakeForAcceptedSend();
        // The draft row was already associated with the durable outbox prompt
        // inside sendPrompt. Suppress an empty draft write for this clear.
        _applyingRemoteDraft = true;
        _promptController.clear();
        _applyingRemoteDraft = false;
      }
    } else {
      _scheduleLocalDraftSync();
      _pendingPromptClear = null;
    }
    setState(() => _isSendingPrompt = false);
    if (success) {
      _releasePendingPromptClearAfterReceiptBuild();
    }
  }

  bool _wouldEraseNewerPendingDraft(String incomingText) {
    final pending = _pendingPromptClear;
    if (pending == null || incomingText.isNotEmpty) {
      return false;
    }
    return _promptRevision != pending.revision ||
        _promptController.text != pending.text;
  }

  void _releasePendingPromptClearAfterReceiptBuild() {
    final pending = _pendingPromptClear;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _pendingPromptClear == pending) {
          _pendingPromptClear = null;
        }
      });
    });
  }

  Future<void> _interruptCurrentTurn() async {
    final restore = _lastSubmittedPrompt;
    final restoreRevision = _promptRevision;
    final outcome = await ref
        .read(sessionDetailControllerProvider(_key).notifier)
        .interruptCurrentTurn();
    if (!mounted) return;

    if (outcome == SessionInterruptOutcome.sent) {
      // A newer accepted send replaces the snapshot while this Stop is in
      // flight. Preserve it and never restore the older prompt over it.
      final stillOwnsSnapshot = identical(_lastSubmittedPrompt, restore);
      if (stillOwnsSnapshot) {
        _lastSubmittedPrompt = null;
      }
      // Revision ownership catches every intervening composer mutation,
      // including type-then-delete. An empty-text check alone cannot do that.
      if (restore != null &&
          stillOwnsSnapshot &&
          _promptRevision == restoreRevision &&
          _promptController.text.isEmpty) {
        _promptController.value = TextEditingValue(
          text: restore.text,
          selection: TextSelection.collapsed(offset: restore.text.length),
        );
        _promptFocusNode.requestFocus();
      }
      return;
    }
    if (outcome == SessionInterruptOutcome.failed) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context).sessionComposerInterruptFailed,
          ),
        ),
      );
    }
  }

  bool _interruptFromShortcut() {
    final route = ModalRoute.of(context);
    if (route == null || !route.isCurrent) return false;

    // A focused editor outside the composer (for example inline rename) owns
    // Escape. The prompt's own palette gets first refusal in its Focus node.
    final primaryFocus = FocusManager.instance.primaryFocus;
    final focusContext = primaryFocus?.context;
    final anotherEditableOwnsEscape =
        primaryFocus != null &&
        primaryFocus != _promptFocusNode &&
        (focusContext?.widget is EditableText ||
            focusContext?.findAncestorStateOfType<EditableTextState>() != null);
    if (anotherEditableOwnsEscape) return false;
    unawaited(_interruptCurrentTurn());
    return true;
  }

  void _focusPromptComposer() {
    _promptFocusNode.requestFocus();
  }

  /// Sends the picked slash command. Resolves true when the broker accepted
  /// it, so the command sheet knows whether to close.
  Future<bool> _sendCommand(List<SlashCommand> availableCommands) async {
    if (_isSendingCommand || !_composerEnabled) {
      return false;
    }

    final selectedCommand = _resolveSelectedCommand(availableCommands);
    if (selectedCommand == null) {
      return false;
    }

    if (_commandArgsError != null) {
      return false;
    }

    final argsText = _commandArgsController.text.trim();
    final argsToSend = argsText.isEmpty ? null : _parsedCommandArgs;

    final controller = ref.read(sessionDetailControllerProvider(_key).notifier);
    setState(() => _isSendingCommand = true);
    final success = await controller.sendCommand(
      selectedCommand.name,
      args: argsToSend,
      model: _selectedModelOverride,
      permissionMode: _selectedPermissionModeOverride,
    );
    if (!mounted) {
      return false;
    }

    if (success) {
      setState(_clearCommandSelection);
    }
    setState(() => _isSendingCommand = false);
    return success;
  }

  Future<void> _pickAttachments() async {
    if (_isPickingAttachments || _isSendingPrompt) return;
    final controller = ref.read(sessionDetailControllerProvider(_key).notifier);
    setState(() => _isPickingAttachments = true);
    await controller.pickAttachments();
    if (!mounted) {
      return;
    }
    setState(() => _isPickingAttachments = false);
  }

  Future<void> _replaceAttachment(String localId) async {
    if (_isPickingAttachments || _isSendingPrompt) return;
    final controller = ref.read(sessionDetailControllerProvider(_key).notifier);
    setState(() => _isPickingAttachments = true);
    await controller.replaceAttachment(localId);
    if (!mounted) {
      return;
    }
    setState(() => _isPickingAttachments = false);
  }

  void _removeAttachment(String localId) {
    if (_isSendingPrompt) return;
    unawaited(
      ref
          .read(sessionDetailControllerProvider(_key).notifier)
          .removeAttachment(localId),
    );
  }

  Future<void> _retryBootstrap() async {
    if (_isRetryingBootstrap) return;
    setState(() => _isRetryingBootstrap = true);
    try {
      await ref.read(sessionDetailControllerProvider(_key).notifier).attach();
    } finally {
      if (mounted) setState(() => _isRetryingBootstrap = false);
    }
  }

  Future<void> _startTranscriptExport() async {
    final controller = ref.read(sessionDetailControllerProvider(_key).notifier);
    final preflight = await controller.prepareTranscriptExport();
    if (!mounted || preflight == null) {
      return;
    }

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => _TranscriptExportConfirmDialog(
        preflight: preflight,
      ),
    );
    if (!mounted || confirmed != true) {
      return;
    }

    await controller.exportTranscript(nonce: preflight.nonce);
  }

  Future<void> _forkSession({String? messageId}) async {
    final controller = ref.read(sessionDetailControllerProvider(_key).notifier);
    final created = await controller.forkSession(messageId: messageId);
    if (!mounted) {
      return;
    }
    if (created == null) {
      // The refusal's only home is the Status panel's fork status line, and
      // every caller that can reach the backstop — a restored intent, a deep
      // link, a stale Chat-tab widget — is somewhere else when it fires, so the
      // failure is silent where it happened. Surface it transiently on the
      // active page too. Localized HERE because the controller carries a typed
      // refusal rather than a sentence, and `AppLocalizations` only exists in
      // the widget tree.
      if (_sessionState.forkSessionActionState.refusal ==
          SessionActionRefusal.agentOwnedSession) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              AppLocalizations.of(context).sessionForkAgentOwnedRefusal,
            ),
          ),
        );
      }
      return;
    }

    if (GoRouter.maybeOf(context) == null) {
      return;
    }
    if (!await _establishDraftDurabilityBarrier() || !mounted) return;

    context.go(
      sessionDetailLocation(
        tool: created.tool,
        sessionId: created.id,
      ),
    );
  }

  Future<void> _cloneSession() async {
    final controller = ref.read(sessionDetailControllerProvider(_key).notifier);
    final created = await controller.cloneSession();
    if (!mounted || created == null) {
      return;
    }

    if (GoRouter.maybeOf(context) == null) {
      return;
    }
    if (!await _establishDraftDurabilityBarrier() || !mounted) return;

    context.go(
      sessionDetailLocation(
        tool: created.tool,
        sessionId: created.id,
      ),
    );
  }

  Future<void> _downloadArtifact(SessionArtifactDescriptor descriptor) async {
    await ref
        .read(sessionDetailControllerProvider(_key).notifier)
        .downloadArtifact(descriptor);
  }

  Future<void> _previewArtifact(SessionArtifactDescriptor descriptor) async {
    final controller = ref.read(sessionDetailControllerProvider(_key).notifier);
    final l10n = AppLocalizations.of(context);
    if (!isSessionArtifactPreviewAvailable) {
      controller.recordArtifactPreviewResult(
        descriptor,
        opened: false,
        message: l10n.sessionArtifactPreviewUnsupported,
      );
      return;
    }

    final cached = await controller.prepareArtifactPreview(descriptor);
    if (!mounted || cached == null) {
      return;
    }

    final result = await showSessionArtifactPreview(context, cached);
    if (!mounted) {
      return;
    }
    final previewCompleted = result.completed;
    controller.recordArtifactPreviewResult(
      descriptor,
      opened: previewCompleted,
      message: switch (result.status) {
        SessionArtifactPreviewPresentationStatus.opened =>
          l10n.sessionArtifactPreviewOpened,
        SessionArtifactPreviewPresentationStatus.unsupported =>
          l10n.sessionArtifactPreviewUnsupported,
        SessionArtifactPreviewPresentationStatus.blockedNavigation =>
          l10n.sessionArtifactPreviewBlocked,
        SessionArtifactPreviewPresentationStatus.externalOpenFallback =>
          l10n.sessionArtifactPreviewExternalStarted,
        SessionArtifactPreviewPresentationStatus.externalOpenFailed =>
          l10n.sessionArtifactPreviewExternalFailed,
      },
    );
  }

  Future<void> _downloadSessionFile(FsDirEntry entry) async {
    final result = await ref
        .read(sessionArtifactTransferWorkerProvider)
        .downloadSessionFile(
          sessionKey: _key,
          path: entry.path,
          fileName: entry.name,
          byteLength: entry.size,
          hasActiveBrokerClient: ref
              .read(brokerClientProvider)
              .maybeWhen(data: (client) => client != null, orElse: () => false),
        );
    if (!mounted) {
      return;
    }
    if (!result.succeeded ||
        result.outcome ==
            SessionArtifactTransferWorkerOutcome.enqueuedInBackground) {
      // Surface both foreground failures and the background-started notice so
      // the user knows a native download continues in the transfer manager.
      final l10n = AppLocalizations.of(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            result.outcome ==
                    SessionArtifactTransferWorkerOutcome.enqueuedInBackground
                ? l10n.sessionFileDownloadStartedInBackground
                : l10n.sessionFileDownloadFailed,
          ),
        ),
      );
    }
  }

  /// This session's file browser on the broker that is active RIGHT NOW.
  ///
  /// Read at every use rather than cached on the state: the gate verdict and
  /// the listing are facts about a host, so a profile switch has to land on
  /// that host's browser instead of the retired one's.
  SessionFileBrowserKey get _fileBrowserKey =>
      ref.read(sessionFileBrowserKeyProvider(_key));

  Future<void> _previewSessionFile(FsDirEntry entry) async {
    // With the split available the file becomes its own pane beside the
    // browser, so the listing stays where the reader left it. Otherwise the
    // read lands in browser state and the Files slot renders it in place.
    if (_openInFilePane(entry.path, null)) return;
    await ref
        .read(sessionFileBrowserControllerProvider(_fileBrowserKey).notifier)
        .previewFile(entry);
  }

  /// Stable identity so the link scope only notifies on a real gate change.
  void _onOpenFileReference(SessionFileReference reference) {
    unawaited(_openFileReference(reference));
  }

  /// Opens one transcript file mention in this session's Files surface.
  ///
  /// The view switches only once the broker has actually resolved the path. A
  /// failure is stated in place, where the tap happened, and the transcript
  /// keeps its scroll position — switching to an empty Files tab to show an
  /// error would cost the reader their place for nothing.
  Future<void> _openFileReference(SessionFileReference reference) async {
    final browserKey = _fileBrowserKey;
    await ref
        .read(sessionFileBrowserControllerProvider(browserKey).notifier)
        .openReference(reference);
    if (!mounted) return;
    final browser = ref.read(sessionFileBrowserControllerProvider(browserKey));
    if (browser.phase == SessionFileBrowserPhase.error ||
        browser.phase == SessionFileBrowserPhase.remoteDisabled) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          key: const Key('session-file-link-failed'),
          content: Text(
            _sessionFileBrowserNotice(AppLocalizations.of(context), browser),
          ),
        ),
      );
      return;
    }
    // Where the file lands depends on whether there is room to show it beside
    // the transcript. With the split available it opens as its own pane and
    // the reader keeps their place; without it, the Files slot is the only
    // surface there is, so the view has to switch.
    final preview = ref
        .read(sessionFileBrowserControllerProvider(browserKey))
        .preview;
    if (preview != null && _openInFilePane(preview.path, reference.line)) {
      return;
    }
    // `maybeOf`, not `of`: the drill-in needs a router, and this page is also
    // mounted without one. Where there is no route to push, the Files slot is
    // the only surface there is and switching to it stays correct.
    final router = GoRouter.maybeOf(context);
    if (preview != null && router != null) {
      // No room for a second pane, so the file is a pushed route instead --
      // the transcript stays on the stack underneath rather than being
      // swapped away, which is what switching to the Files slot used to cost.
      // The browser's own preview is closed on the way out: the drill-in is
      // now the surface showing this file, and leaving a second copy behind
      // the route would greet the reader on Back.
      ref
          .read(sessionFileBrowserControllerProvider(browserKey).notifier)
          .closePreview();
      unawaited(
        router.push(
          sessionFileLocation(
            tool: _key.tool,
            sessionId: _key.sessionId,
            path: preview.path,
            line: reference.line,
          ),
        ),
      );
      return;
    }
    _selectView(_SessionDetailView.files);
  }

  /// Opens [path] as a file pane, when the window is wide enough to show one.
  ///
  /// Returns false at narrower widths, where the caller keeps the in-place
  /// behaviour rather than opening a pane the layout will not render.
  bool _openInFilePane(String path, int? line) {
    final width = MediaQuery.sizeOf(context).width;
    if (WindowSizeClass.fromWidth(width) != WindowSizeClass.expanded) {
      return false;
    }
    final pane = FilePaneKey(session: _key, path: path);
    if (line != null) {
      ref
          .read(filePaneAnchorProvider.notifier)
          .update(
            (anchors) => {...anchors, pane.key: line},
          );
    }
    unawaited(
      ref.read(filePanesControllerProvider.notifier).open(_key, path),
    );
    return true;
  }

  /// Probes the workspace-file gate once per attach.
  ///
  /// The gate is a property of this session's host connection, not of any one
  /// mention, so it is asked once and cached — never per link, and never again
  /// on scroll. Until it answers, mentions stay plain text. Raised by the first
  /// mention that reaches the screen: a session that shows none never spends a
  /// request learning whether links it will not draw would have worked.
  void _probeFileLinkGate() {
    if (!mounted || _fileLinkGateProbeScheduled) return;
    _fileLinkGateProbeScheduled = true;
    unawaited(
      ref
          .read(sessionFileBrowserControllerProvider(_fileBrowserKey).notifier)
          .probeGate(),
    );
  }

  /// Commits an inline title edit. The strip's title *is* the rename control
  /// now, so there is no dialog to confirm — Enter or focus loss lands here.
  Future<void> _renameSession(String title) async {
    await ref
        .read(sessionDetailControllerProvider(_key).notifier)
        .renameSession(title);
  }

  void _selectModelAndEffort(ModelOption option, String? selectedEffort) {
    if (!mounted) {
      return;
    }
    final sessionModel = _sessionState.sessionInfo?.currentModel;
    final current = _selectedModelOverride ?? sessionModel;
    final efforts = option.reasoningEfforts ?? const <ReasoningEffort>[];
    final String? nextEffort;
    if (selectedEffort != null) {
      nextEffort = selectedEffort;
    } else if (_sameModel(option, current)) {
      nextEffort = current?.reasoningEffort;
    } else if (_sameModel(option, sessionModel)) {
      // Returning from a temporary override restores the session's live
      // effort instead of the catalog default.
      nextEffort = sessionModel?.reasoningEffort;
    } else {
      nextEffort =
          option.defaultReasoningEffort ??
          (efforts.isEmpty ? null : efforts.first.effort);
    }
    final selected = SessionCurrentModel(
      providerID: option.providerID,
      modelID: option.modelID,
      reasoningEffort: nextEffort,
      variant: option.variant,
    );
    final parsedArgs = parseSessionCommandArgs(
      _commandArgsController.text,
      hasModelOverride: true,
    );
    setState(() {
      _modelSelectionTouched = true;
      _selectedModelOverride = selected;
      _commandArgsError = parsedArgs.error;
      _parsedCommandArgs = parsedArgs.args;
    });
    _persistModelSelection(selected);
  }

  void _selectPermissionMode(ModeOption mode) {
    if (!mounted) return;
    final authoritative = _sessionState.sessionInfo?.currentMode;
    setState(() {
      _permissionModeObserved = true;
      _lastAuthoritativePermissionMode = authoritative;
      _selectedPermissionModeOverride = mode.value == authoritative
          ? null
          : mode.value;
    });
  }

  void _schedulePermissionModeReconciliation(String? authoritative) {
    if (!_permissionModeObserved) {
      _permissionModeObserved = true;
      _lastAuthoritativePermissionMode = authoritative;
      return;
    }
    if (authoritative == _lastAuthoritativePermissionMode ||
        _permissionModeReconcileScheduled) {
      return;
    }
    _permissionModeReconcileScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _permissionModeReconcileScheduled = false;
      if (!mounted) return;
      final latest = _sessionState.sessionInfo?.currentMode;
      if (latest == _lastAuthoritativePermissionMode) return;
      setState(() {
        _lastAuthoritativePermissionMode = latest;
        _selectedPermissionModeOverride = null;
      });
    });
  }

  Future<void> _loadLiveStateArchive() async {
    final archived = await ref
        .read(sessionLiveStateViewStoreProvider)
        .loadArchived(_key);
    if (!mounted) return;
    setState(() {
      _archivedLiveState = archived;
      _liveStateArchiveLoaded = true;
    });
  }

  void _archiveLiveStateItem(_LiveStateItem item) {
    final next = <String, String>{
      ..._archivedLiveState,
      item.id: item.archiveIdentity,
    };
    while (next.length > _maxArchivedLiveStateEntries) {
      next.remove(next.keys.first);
    }
    setState(() => _archivedLiveState = Map.unmodifiable(next));
    unawaited(
      ref
          .read(sessionLiveStateViewStoreProvider)
          .saveArchived(_key, next)
          .catchError((Object _, StackTrace _) {}),
    );
  }

  void _scheduleArchivedLiveStateReconciliation(
    List<_LiveStateItem> items,
  ) {
    if (!_liveStateArchiveLoaded || _archivedLiveState.isEmpty) return;
    final current = {for (final item in items) item.id: item};
    final staleKeys = <String>{
      for (final entry in _archivedLiveState.entries)
        if (current[entry.key] case final item?)
          if (item.actionRequired || entry.value != item.archiveIdentity)
            entry.key,
    };
    if (staleKeys.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final next = Map<String, String>.of(_archivedLiveState)
        ..removeWhere((key, _) => staleKeys.contains(key));
      if (next.length == _archivedLiveState.length) return;
      setState(() => _archivedLiveState = Map.unmodifiable(next));
      unawaited(
        ref
            .read(sessionLiveStateViewStoreProvider)
            .saveArchived(_key, next)
            .catchError((Object _, StackTrace _) {}),
      );
    });
  }

  void _scheduleTerminalTabUpdate(bool shouldShow) {
    if (shouldShow == _terminalTabVisible || _terminalTabUpdateScheduled) {
      return;
    }
    _terminalTabUpdateScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _terminalTabUpdateScheduled = false;
      if (!mounted) return;
      final latestShouldShow = _sessionState.terminalOutputMessages.isNotEmpty;
      if (latestShouldShow == _terminalTabVisible) return;
      setState(() {
        _terminalTabVisible = latestShouldShow;
        if (latestShouldShow) {
          _terminalFresh = true;
        } else if (_view == _SessionDetailView.terminal) {
          // The destination just disappeared from under the user.
          _view = _SessionDetailView.status;
        }
      });
    });
  }

  /// Switches the body to [view] and marks it built.
  ///
  /// Opening Terminal clears its fresh-output dot — on-view means seen, the
  /// same rule the old tab followed.
  void _selectView(_SessionDetailView view) {
    if (!mounted) return;
    setState(() {
      _view = view;
      if (view == _SessionDetailView.terminal) _terminalFresh = false;
    });
  }

  String _viewLabel(AppLocalizations l10n, _SessionDetailView view) {
    return switch (view) {
      _SessionDetailView.chat => l10n.sessionViewChat,
      _SessionDetailView.status => l10n.sessionViewStatus,
      _SessionDetailView.terminal => l10n.sessionViewTerminal,
      _SessionDetailView.files => l10n.sessionViewFiles,
      _SessionDetailView.debug => l10n.sessionViewDebug,
    };
  }

  /// Leaves the session for the sessions list, when there is somewhere to go.
  ///
  /// Variant C drops the `AppBar`, and with it the automatic back button the
  /// pushed single-pane route relied on. Null in the embedded workspace, where
  /// the roster is already beside the detail pane.
  VoidCallback? _popRouteCallback() {
    if (widget.embedded) return null;
    final router = GoRouter.maybeOf(context);
    if (router != null && router.canPop()) {
      return () => unawaited(_popRouteAfterDraftBarrier(router.pop));
    }
    final navigator = Navigator.maybeOf(context);
    if (navigator != null && navigator.canPop()) {
      return () => unawaited(_popRouteAfterDraftBarrier(navigator.pop));
    }
    return null;
  }

  Future<void> _popRouteAfterDraftBarrier(VoidCallback pop) async {
    if (!await _establishDraftDurabilityBarrier() || !mounted) return;
    pop();
  }

  /// Builds [view] only while it is the active destination.
  ///
  /// Destinations are visited and left, not swiped between, so an inactive one
  /// is torn down rather than parked off-screen. That matters beyond memory:
  /// the chat panel drives a periodic scheduled-message poll, and a panel kept
  /// alive behind another view would keep polling for a session the user is no
  /// longer looking at.
  Widget _viewSlot(
    _SessionDetailView view, {
    required _SessionDetailView active,
    required bool showTerminalTab,
    required Widget Function() builder,
  }) {
    // Compare against the effective (possibly debug-redirected) view so the
    // shown slot is never blank for a frame while `_view` is still catching up.
    if (view != active) return const SizedBox.shrink();
    if (view == _SessionDetailView.terminal && !showTerminalTab) {
      return const SizedBox.shrink();
    }
    return builder();
  }

  void _scheduleModelPreferenceRestore(
    SessionDetailState state,
    List<ModelOption> models,
  ) {
    // The full broker source: a model preference recorded against one broker's
    // session must not preselect — or be overwritten by — an identically-named
    // session on the machine the profile was re-pointed at.
    final scope = RosterSource.of(
      ref.read(activeBrokerProfileProvider),
    )?.storageKey;
    final info = state.sessionInfo;
    if (scope == null || info == null) return;
    final lineage = info.lineageId?.trim();
    final key = SessionModelPreferenceKey(
      brokerProfileId: scope,
      tool: info.tool,
      lineageId: lineage == null || lineage.isEmpty ? info.id : lineage,
    );
    if (_modelPreferenceKey != key) {
      _modelPreferenceKey = key;
      _persistedModelCandidate = null;
      _modelPreferenceLoadScheduled = false;
      _modelPreferenceApplyScheduled = false;
      _modelSelectionTouched = false;
    }
    if (!_modelPreferenceLoadScheduled) {
      _modelPreferenceLoadScheduled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (!mounted || _modelPreferenceKey != key) return;
        final candidate = await ref
            .read(sessionModelPreferenceStoreProvider)
            .load(key);
        if (!mounted || _modelPreferenceKey != key || _modelSelectionTouched) {
          return;
        }
        _persistedModelCandidate = candidate;
        final latest = _sessionState;
        _schedulePersistedModelApply(
          latest.models,
          latest.sessionInfo?.currentModel,
        );
      });
    }
    _schedulePersistedModelApply(models, info.currentModel);
  }

  void _schedulePersistedModelApply(
    List<ModelOption> models,
    SessionCurrentModel? authoritativeCurrent,
  ) {
    final candidate = _persistedModelCandidate;
    if (candidate == null ||
        _modelSelectionTouched ||
        _selectedModelOverride != null ||
        _modelPreferenceApplyScheduled) {
      return;
    }
    if (_resolvePersistedModel(
          candidate,
          models,
          authoritativeCurrent,
        ) ==
        null) {
      return;
    }
    final key = _modelPreferenceKey;
    if (key == null) {
      return;
    }
    _modelPreferenceApplyScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _modelPreferenceApplyScheduled = false;
      if (!mounted ||
          _modelSelectionTouched ||
          _selectedModelOverride != null ||
          _modelPreferenceKey != key) {
        return;
      }
      // The controller can receive a newer session/options frame after this
      // restore was scheduled but before the frame callback runs. Re-resolve
      // against that latest authoritative state so a stale saved effort never
      // becomes an override merely because an older build approved it.
      final latest = _sessionState;
      final restored = _resolvePersistedModel(
        candidate,
        latest.models,
        latest.sessionInfo?.currentModel,
      );
      if (restored == null) {
        return;
      }
      setState(() => _selectedModelOverride = restored);
    });
  }

  SessionCurrentModel? _resolvePersistedModel(
    SessionCurrentModel candidate,
    List<ModelOption> models,
    SessionCurrentModel? authoritativeCurrent,
  ) {
    ModelOption? advertised;
    for (final option in models) {
      if (_sameModel(option, candidate)) {
        advertised = option;
        break;
      }
    }
    if (advertised == null) {
      // Exact broker ids only. A gated Fable or stale/future model remains
      // dormant until the broker advertises it again; no client name matching.
      return null;
    }
    final savedEffort = candidate.reasoningEffort;
    if (savedEffort != null) {
      final effortIsAdvertised =
          advertised.reasoningEfforts?.any(
            (effort) => effort.effort == savedEffort,
          ) ??
          false;
      final effortIsAuthoritative =
          _sameModel(advertised, authoritativeCurrent) &&
          authoritativeCurrent?.reasoningEffort == savedEffort;
      if (!effortIsAdvertised && !effortIsAuthoritative) {
        // A stored opaque effort can outlive the catalog that supported it.
        // Keep that preference dormant instead of overriding the live model
        // with an unsupported value. A later catalog that advertises the
        // exact effort will schedule this candidate again.
        return null;
      }
    }
    final restored = SessionCurrentModel(
      providerID: advertised.providerID,
      modelID: advertised.modelID,
      variant: advertised.variant,
      // An advertised saved effort is safe to restore. If a partial catalog
      // omits the live effort, the guard above also preserves it when the
      // authoritative session reports the exact same model and effort.
      reasoningEffort: savedEffort ?? advertised.defaultReasoningEffort,
    );
    return restored;
  }

  void _persistModelSelection(SessionCurrentModel model) {
    final key = _modelPreferenceKey;
    if (key == null) return;
    _persistedModelCandidate = model;
    final store = ref.read(sessionModelPreferenceStoreProvider);
    unawaited(
      store.save(key, model).catchError((Object _, StackTrace _) {}),
    );
    // Per-tool fallback: lets a brand-new session (whose lineage key cannot
    // match yet) inherit the last model picked for this tool on this broker.
    unawaited(
      store
          .saveToolDefault(
            brokerProfileId: key.brokerProfileId,
            tool: key.tool,
            model: model,
          )
          .catchError((Object _, StackTrace _) {}),
    );
  }

  /// This session's title from the last-known roster identity snapshot (N3).
  ///
  /// Not every route into Session Detail passes through the working set: the
  /// compact list routes straight to the location, and a deep link or a cold
  /// restart has no tab yet either. In all of those the cached roster still
  /// holds the exact identity the user just tapped, so reading the title from
  /// it is what keeps a named session from arriving as its own id. Identity
  /// only — the snapshot stores no status, and none is inferred here.
  String? _cachedRosterTitle() {
    final roster = _activeProfileRoster();
    final cached = roster?.cachedRoster;
    if (roster == null || cached == null) return null;
    // The snapshot carries its own owner. The controller's `source` guard
    // above is the primary check; this one holds even if a snapshot were ever
    // published under a source it did not come from.
    if (cached.snapshot.brokerProfileId != roster.source?.profileId) {
      return null;
    }
    for (final row in cached.snapshot.rows) {
      if (row.tool == widget.tool && row.sessionId == widget.sessionId) {
        return row.title.isEmpty ? null : row.title;
      }
    }
    return null;
  }

  /// The roster state, but only while it belongs to the ACTIVE broker profile.
  ///
  /// `SessionListController` invalidates its rows when the source changes, but
  /// it learns about the change through a Riverpod listener, which is delivered
  /// asynchronously — so there is a real window in which the state still holds
  /// the previous broker's sessions. Two brokers can carry the same native
  /// session id, so reading a title across that window would put profile A's
  /// name on a page showing profile B's session. Comparing the roster's own
  /// `source` against the live profile closes it.
  SessionListState? _activeProfileRoster() {
    final state = ref.read(sessionListControllerProvider);
    final active = RosterSource.of(ref.read(activeBrokerProfileProvider));
    if (active == null || state.source != active) return null;
    return state;
  }

  /// This session's title from the authoritative roster this client already
  /// loaded, if it resolved before the session frame did.
  ///
  /// Compact navigation routes straight from the roster row to this location,
  /// so the exact row the user tapped is in memory from the first frame — long
  /// before the socket attaches. Read rather than watched on purpose: this is a
  /// fallback for a title the session frame is about to supply authoritatively,
  /// and the roster is not worth rebuilding the whole detail page for. Reading
  /// the controller starts no fetch; its `build` only seeds the source.
  String? _rosterTitle() {
    final roster = _activeProfileRoster();
    if (roster == null) return null;
    for (final session in roster.sessions) {
      if (session.tool == widget.tool && session.id == widget.sessionId) {
        return session.title;
      }
    }
    return null;
  }

  /// This session's title in the opened-sessions working set, if it has a tab.
  String? _openSessionTitle(OpenSessionsState? open) {
    if (open == null) return null;
    final currentTabKey = '${widget.tool}/${widget.sessionId}';
    for (final item in open.refs) {
      if (item.key == currentTabKey) return item.title;
    }
    return null;
  }

  /// The best title this client actually knows for the routed session, or null.
  ///
  /// The session frame is the only source of truth. Once one exists its title
  /// is the answer — taken verbatim when it happens to equal the id, and taken
  /// as *no title* when it is empty. The local sources are consulted ONLY
  /// before that frame arrives: a broker that clears a title is stating a fact,
  /// and letting a stale tab or roster row answer over it would resurrect a
  /// name the session no longer has.
  ///
  /// Before the frame, precedence is:
  ///
  /// 1. the opened-sessions working set, which carries the title the tab was
  ///    opened (and persisted) with;
  /// 2. the loaded roster, which is what compact navigation just tapped; and
  /// 3. the bounded N3 identity snapshot.
  ///
  /// All three use the session id as their own "no title yet" placeholder (see
  /// `knownSessionTitle`), so one that reads as the id falls through rather
  /// than being displayed. Null means nothing is known — a direct deep link —
  /// and the caller substitutes the localized neutral label.
  ///
  /// Every source belongs to the ACTIVE broker profile: [open] is passed only
  /// when its hydration has settled on the current profile, and the roster
  /// lookups re-check the roster's own source. Two profiles can carry the same
  /// native session id, and answering from the wrong one would put another
  /// broker's name on this page.
  ///
  /// Local only. Every source is already-hydrated client state: no broker
  /// request, history fetch, poll, timer, or subscription is added, and none of
  /// this is identity.
  String? _knownSessionTitle(
    SessionDetailState state,
    OpenSessionsState? open,
  ) {
    final info = state.sessionInfo;
    if (info != null) {
      final authoritative = info.title.trim();
      return authoritative.isEmpty ? null : authoritative;
    }
    return knownSessionTitle(
      [_openSessionTitle(open), _rosterTitle(), _cachedRosterTitle()],
      sessionId: widget.sessionId,
    );
  }

  void _ensureCurrentSessionTab(
    OpenSessionsState open,
    SessionDetailState session,
  ) {
    final currentTabKey = '${widget.tool}/${widget.sessionId}';
    if (_suppressedSessionTabKey == currentTabKey || _tabEnsureScheduled) {
      return;
    }
    final info = session.sessionInfo;
    final SessionRef entry;
    if (info != null) {
      entry = SessionRef.fromSession(info);
    } else {
      // No authoritative metadata yet — a row opened from the bounded local
      // snapshot, or a detail page entered before the roster resolved. The tab
      // keeps the identity it was opened with (the cached title) and makes NO
      // status claim; inventing `idle` here is how a working session gets drawn
      // as finished, and overwriting the title with the raw id is how a named
      // session becomes a fingerprint the user cannot recognise.
      //
      // The durable placeholder stays the id, not the localized neutral label
      // the page displays: the working set is persisted, and freezing one
      // locale's words into it would read like a title the broker had actually
      // supplied. Display substitutes the label; storage keeps the identity.
      entry = SessionRef.cachedIdentity(
        tool: widget.tool,
        id: widget.sessionId,
        title: _knownSessionTitle(session, open) ?? widget.sessionId,
      );
    }
    // Matched on the ENTRY's key, which is the row `open` will write: a
    // session whose authoritative identity differs from the route's would
    // otherwise never match its own tab, and this would reschedule forever.
    SessionRef? existing;
    for (final item in open.refs) {
      if (item.key == entry.key) {
        existing = item;
        break;
      }
    }
    if (existing == entry && open.activeKey == entry.key) {
      return;
    }
    _tabEnsureScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _tabEnsureScheduled = false;
      if (!mounted || _suppressedSessionTabKey == currentTabKey) {
        return;
      }
      ref.read(openSessionsControllerProvider.notifier).open(entry);
    });
  }

  Future<void> _selectOpenSession(String key, List<SessionRef> refs) async {
    SessionRef? selected;
    for (final item in refs) {
      if (item.key == key) {
        selected = item;
        break;
      }
    }
    if (selected == null) {
      return;
    }
    if (!await _establishDraftDurabilityBarrier() || !mounted) return;
    _suppressedSessionTabKey = null;
    ref.read(openSessionsControllerProvider.notifier).activate(key);
    if (GoRouter.maybeOf(context) != null) {
      context.go(
        sessionDetailLocation(tool: selected.tool, sessionId: selected.id),
      );
    }
  }

  Future<void> _closeOpenSession(String key) async {
    final currentKey = '${widget.tool}/${widget.sessionId}';
    if (key == currentKey) {
      // Kept even though `close` now barriers too: only this page can read the
      // live composer, and only this page can REPORT a refused write and
      // abandon the close. The controller's own barrier coalesces with this
      // one — the value it flushes is already durable, so it writes nothing.
      if (!await _establishDraftDurabilityBarrier() || !mounted) return;
    }
    await ref.read(openSessionsControllerProvider.notifier).close(key);
    if (key != currentKey || !mounted) {
      return;
    }
    _suppressedSessionTabKey = currentKey;
    final next = ref.read(openSessionsControllerProvider).valueOrNull?.active;
    if (GoRouter.maybeOf(context) == null) {
      return;
    }
    if (next == null) {
      context.go(sessionsRoute);
      return;
    }
    context.go(sessionDetailLocation(tool: next.tool, sessionId: next.id));
  }

  /// Whether an opened-sessions chord may act right now.
  ///
  /// Mirrors [_interruptFromShortcut]'s modal guard: a sheet or dialog over
  /// this page owns the keyboard, and a keystroke behind it must not tear the
  /// view down.
  bool _sessionTabShortcutAllowed() {
    final route = ModalRoute.of(context);
    return route != null && route.isCurrent;
  }

  /// Closes THIS session's tab from the keyboard.
  ///
  /// Routed through [_closeOpenSession] rather than the controller so the
  /// keystroke gets exactly what the close button gets: the draft-durability
  /// barrier first (a chord must never silently drop an unsent prompt), then
  /// the `_suppressedSessionTabKey` handshake that stops
  /// [_ensureCurrentSessionTab] re-adding the tab on the next frame.
  void _closeSessionFromShortcut() {
    if (!_sessionTabShortcutAllowed()) return;
    unawaited(_closeOpenSession('${widget.tool}/${widget.sessionId}'));
  }

  void _activateOrdinalFromShortcut(OpenSessionsState open, int index) {
    if (!_sessionTabShortcutAllowed()) return;
    if (index < 0 || index >= open.refs.length) return;
    unawaited(_selectOpenSession(open.refs[index].key, open.refs));
  }

  void _activateLastSessionFromShortcut(OpenSessionsState open) {
    if (!_sessionTabShortcutAllowed()) return;
    if (open.refs.isEmpty) return;
    unawaited(_selectOpenSession(open.refs.last.key, open.refs));
  }

  void _cycleSessionFromShortcut(OpenSessionsState open, int delta) {
    if (!_sessionTabShortcutAllowed()) return;
    if (open.refs.length < 2) return;
    final current = open.refs.indexWhere(
      (entry) => entry.key == open.activeKey,
    );
    final from = current < 0 ? 0 : current;
    // Dart's `%` is non-negative for a positive divisor, so this wraps both
    // ways without a sign fix.
    final next = (from + delta) % open.refs.length;
    unawaited(_selectOpenSession(open.refs[next].key, open.refs));
  }

  /// The opened-sessions chords for the compact single-pane layout.
  ///
  /// Same registry specs as `SessionsWorkspace`, different handlers: here
  /// every selection also flushes the draft and routes, because the tab strip
  /// and the detail are the same screen.
  Map<ShortcutActivator, AppShortcutHandler> _openSessionShortcuts(
    OpenSessionsState open,
  ) => {
    ...appShortcutBindings(
      specs: appShortcutsForScope(AppShortcutScope.workspace),
      handlers: {
        AppShortcutId.closeSession: _closeSessionFromShortcut,
        AppShortcutId.nextSession: () => _cycleSessionFromShortcut(open, 1),
        AppShortcutId.previousSession: () =>
            _cycleSessionFromShortcut(open, -1),
        AppShortcutId.jumpToLastSession: () =>
            _activateLastSessionFromShortcut(open),
      },
    ),
    ...appShortcutOrdinalBindings(
      kSessionOrdinalActivators,
      (index) => _activateOrdinalFromShortcut(open, index),
    ),
  };

  @override
  Widget build(BuildContext context) {
    // Ownership handoff: no watch, listen, or notifier read of this session's
    // detail provider may happen while a previous incarnation's retirement is
    // pending — see [_awaitingRetirementHandoff]. The shell carries no session
    // state on purpose; the handoff resolves within the retirement of one
    // transport close.
    if (_awaitingRetirementHandoff) {
      return const Scaffold(
        key: Key('session-detail-retirement-handoff'),
        body: Center(child: CircularProgressIndicator()),
      );
    }
    // Keep the TTS owner alive for the lifetime of Session Detail, not merely
    // while the footer that started playback remains mounted. Transcript rows
    // are virtualized; scrolling a speaking footer off-screen must not dispose
    // the speech output and stop playback. Watching only the notifier avoids
    // rebuilding the whole page for every speaking/paused state transition.
    ref
      ..watch(readAloudControllerProvider.notifier)
      // The exact broker SOURCE — (profile, endpoint) — not the profile id.
      // A profile is an editable pointer: re-pointing it at another machine
      // keeps the id, and an id-keyed listener saw no change, so the mounted
      // page never re-attached and stayed on the retired machine's socket.
      ..listen<RosterSource?>(
        activeBrokerProfileProvider.select(RosterSource.of),
        (previous, next) {
          if (previous == next) return;
          // At the production branch boundary the supervisor publishes this
          // key's retirement before descendant source listeners run. The
          // outgoing page must not race that owner by reattaching its retiring
          // provider to the new source; the replacement page attaches after
          // the ledger clears. A standalone detail has no pending retirement
          // and retains its existing self-rebind behavior.
          if (ref
                  .read(sessionDetailRetirementLedgerProvider)
                  .pendingFor(_key) !=
              null) {
            return;
          }
          unawaited(_changeProfileAfterDraftBarrier());
        },
      )
      // Session Detail can remain mounted behind the credential gate. A
      // successful save/removal does not change its RosterSource, but its live
      // connection owns the resolver from before that credential mutation.
      // Rebind from the controller's committed outcome, after secure storage
      // and the active-profile transaction have both succeeded.
      ..listen<BrokerCredentialsState>(
        brokerCredentialsControllerProvider,
        (previous, next) {
          final committed =
              (previous?.isBusy ?? false) &&
              !next.isBusy &&
              (next.notice == BrokerCredentialNotice.tokenSaved ||
                  next.notice == BrokerCredentialNotice.tokenRemoved ||
                  next.notice == BrokerCredentialNotice.signedOut);
          if (!committed) return;
          unawaited(
            ref
                .read(sessionDetailControllerProvider(_key).notifier)
                .rebindBrokerClient(),
          );
        },
      )
      ..listen<SessionStatus?>(
        sessionDetailControllerProvider(
          _key,
        ).select((detail) => detail.sessionInfo?.status),
        (previous, next) {
          if (previous == SessionStatus.working &&
              next != SessionStatus.working) {
            // A normally completed turn has nothing left to restore. Without
            // this, stopping a later externally-started turn could resurrect
            // an unrelated old prompt.
            _lastSubmittedPrompt = null;
          }
        },
      )
      ..listen<SessionDetailConnectionStatus>(
        sessionDetailControllerProvider(
          _key,
        ).select((detail) => detail.connectionStatus),
        (previous, next) {
          if (previous == SessionDetailConnectionStatus.connected ||
              next != SessionDetailConnectionStatus.connected) {
            return;
          }
          unawaited(
            ref
                .read(sessionDetailControllerProvider(_key).notifier)
                .promoteBackgroundObserveToInteractive(),
          );
        },
      );
    // Broker-qualified by (profile, endpoint): a session frame stamped with
    // another broker is dropped here rather than displayed, persisted, or keyed
    // on while that broker's connection is still being torn down.
    final state = watchQualifiedDetail(ref, _key);
    // DR1: versioned drafts are reconciled by the controller and arrive as
    // surface directives; only legacy (unversioned) frames use the page's
    // last-writer-wins path.
    _applyDraftSurface(state.draftSurface);
    if (state.latestDraft?.revision == null) {
      _scheduleRemoteDraftApply(state.latestDraft);
    }
    final controller = ref.read(sessionDetailControllerProvider(_key).notifier);
    final isConnected =
        state.connectionStatus == SessionDetailConnectionStatus.connected;
    final hasActiveBrokerClient = ref
        .watch(brokerClientProvider)
        .maybeWhen(data: (client) => client != null, orElse: () => false);
    // "Once per attach": losing the connection re-arms the probe, so a session
    // that reattaches asks its host again rather than trusting an answer that
    // belonged to a previous connection.
    if (!isConnected) _fileLinkGateProbeScheduled = false;
    // Only the gate is selected: the browser's listings and previews change
    // often, and rebuilding the whole page for a directory listing would be a
    // needless cost on a surface that only needs the yes/no.
    final fileLinkGate = ref.watch(
      sessionFileBrowserControllerProvider(
        ref.watch(sessionFileBrowserKeyProvider(_key)),
      ).select((it) => it.gate),
    );
    final commands = state.commands;
    final models = state.models;
    _scheduleModelPreferenceRestore(state, models);
    final effectiveModel =
        _selectedModelOverride ?? state.sessionInfo?.currentModel;
    final selectedCommand = _resolveSelectedCommand(commands);
    // Inline transfers are shown for the EXACT broker this page is attached
    // to: rows are stamped with the worker's scope key, and a row stamped by
    // the same profile at a retired endpoint belongs to that machine, not
    // this one. (Transfer Manager still lists every row for cleanup.)
    final activeBrokerScopeKey = ref.watch(
      activeBrokerProfileProvider.select(
        (profile) => RosterSource.of(profile)?.storageKey,
      ),
    );
    final artifactTransfers = ref
        .watch(sessionArtifactTransferControllerProvider)
        .where(
          (transfer) =>
              activeBrokerScopeKey != null &&
              transfer.sessionKey == _key &&
              transfer.brokerProfileId == activeBrokerScopeKey,
        )
        .toList(growable: false);
    final transferWorkerProvider = sessionArtifactTransferWorkerProvider;
    final showSinglePaneSessionStrip =
        !WindowSizeClass.of(context).showListDetail && !widget.embedded;
    // Settled data only — never loading-with-previous. `OpenSessionsController`
    // watches the active profile, so switching brokers rebuilds it, and
    // Riverpod keeps serving the OLD profile's working set through
    // `valueOrNull` until the new hydration finishes. Reading across that
    // window would show profile A's tab (and its title) on profile B, and
    // `_ensureCurrentSessionTab` would then persist it there.
    final openSessionsAsync = ref.watch(openSessionsControllerProvider);
    final openSessions =
        openSessionsAsync.isLoading || openSessionsAsync.hasError
        ? null
        : openSessionsAsync.valueOrNull;
    if (showSinglePaneSessionStrip && openSessions != null) {
      _ensureCurrentSessionTab(openSessions, state);
    }

    final hasTerminalOutput = state.terminalOutputMessages.isNotEmpty;
    _scheduleTerminalTabUpdate(hasTerminalOutput);
    // The cached flag is reconciled post-frame, which is one frame too late
    // when a profile switch drops the whole transcript at once: the tab (and
    // its unseen-output dot) would still advertise the previous profile's
    // terminal. Anding with the current state only ever hides it sooner.
    final showTerminalTab = _terminalTabVisible && hasTerminalOutput;
    // D1: read-only Debug is gated behind a default-off developer preference.
    // Turning it off while Debug is open returns to Chat immediately — the
    // effective view falls back to Chat this frame and the selection is reset
    // post-frame so no blank Debug slot flashes.
    final showDebugViews =
        ref.watch(debugViewsControllerProvider).value ?? false;
    final debugRedirect = !showDebugViews && _view == _SessionDetailView.debug;
    final effectiveView = debugRedirect ? _SessionDetailView.chat : _view;
    if (debugRedirect) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _view == _SessionDetailView.debug) {
          _selectView(_SessionDetailView.chat);
        }
      });
    }
    final l10n = AppLocalizations.of(context);
    final liveItems = _liveStateItemsFromParts(
      l10n,
      state.liveState,
      state.commandProgress,
    );
    _scheduleArchivedLiveStateReconciliation(liveItems);
    final archivedLiveState = _liveStateArchiveLoaded
        ? _archivedLiveState
        : const <String, String>{};
    final archivedCount = liveItems
        .where(
          (item) =>
              !item.actionRequired &&
              archivedLiveState[item.id] == item.archiveIdentity,
        )
        .length;
    final attentionCount = liveItems
        .where((item) => item.actionRequired)
        .length;
    final statusBadgeCount = attentionCount > 0
        ? attentionCount
        : archivedCount;
    final progressBadge = _primaryLiveStateProgress(liveItems);
    final canRename =
        hasActiveBrokerClient && (state.agentActions?.canRenameNative ?? false);
    _schedulePermissionModeReconciliation(state.sessionInfo?.currentMode);

    // U3: the strip shows the title this client already knows from the first
    // frame — the tab, the roster row just tapped, or the N3 snapshot — and a
    // neutral label when it knows none. It never shows `widget.sessionId`: a
    // native fingerprint where the session's name belongs is unreadable, and
    // it flashed on every open until the session frame arrived.
    //
    // The two neutral labels are not interchangeable. Before the session frame
    // arrives the page genuinely is still opening; after it arrives with an
    // empty title the session is resolved and simply has no name, and calling
    // that "opening" would be a spinner that never ends.
    final knownTitle = _knownSessionTitle(state, openSessions);
    final visibleTitle =
        knownTitle ??
        (state.sessionInfo == null
            ? l10n.sessionDetailTitleOpening
            : l10n.sessionDetailTitleUntitled);
    final control = SessionControlView.fromSessionDetailState(state);
    final detailFreshness = SessionDetailFreshnessPresentation.fromState(state);
    final isSubView = _view != _SessionDetailView.chat;

    final page = AppCallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyK, control: true):
            appShortcutAlways(_focusPromptComposer),
        const SingleActivator(LogicalKeyboardKey.keyK, meta: true):
            appShortcutAlways(_focusPromptComposer),
        const SingleActivator(LogicalKeyboardKey.escape):
            _interruptFromShortcut,
        // Only the compact single-pane layout owns the working set here. When
        // embedded, `SessionsWorkspace` is the layout owner and binds these
        // itself; binding them twice would give one keystroke two handlers.
        if (showSinglePaneSessionStrip && openSessions != null)
          ..._openSessionShortcuts(openSessions),
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          body: SafeArea(
            child: Column(
              children: [
                if (showSinglePaneSessionStrip && openSessions != null)
                  OpenSessionsTabStrip(
                    refs: openSessions.refs,
                    activeKey: openSessions.activeKey,
                    onSelect: (key) =>
                        unawaited(_selectOpenSession(key, openSessions.refs)),
                    onClose: (key) => unawaited(_closeOpenSession(key)),
                  ),
                _SessionTopStrip(
                  title: visibleTitle,
                  // The rename field edits the real title, never the neutral
                  // placeholder: committing "Opening session" as a name would
                  // be the loading state writing itself into the broker.
                  editableTitle: knownTitle ?? '',
                  tool: state.tool,
                  canRename: canRename,
                  renameBusy: state.renameSessionActionState.isBusy,
                  onRename: (value) => unawaited(_renameSession(value)),
                  control: control,
                  freshness: detailFreshness,
                  telemetry: state.telemetry,
                  restoringDrive:
                      state.driveRestorePhase ==
                      SessionDriveRestorePhase.restoring,
                  badgeLabel: progressBadge,
                  onStatusTap: () => _selectView(_SessionDetailView.status),
                  viewLabel: isSubView ? _viewLabel(l10n, _view) : null,
                  onBack: isSubView
                      ? () => _selectView(_SessionDetailView.chat)
                      : null,
                  onPopRoute: _popRouteCallback(),
                  menu: _SessionViewMenu(
                    view: effectiveView,
                    showTerminal: showTerminalTab,
                    showDebug: showDebugViews,
                    statusBadgeCount: statusBadgeCount,
                    terminalFresh: _terminalFresh,
                    reportView: _reportView,
                    toolsExpanded: _toolsExpanded,
                    onSelectView: _selectView,
                    onReportViewChanged: (value) =>
                        setState(() => _reportView = value),
                    onToolsExpandedChanged: (value) => setState(() {
                      _toolsExpanded = value;
                      _toolExpansionRevision++;
                    }),
                  ),
                ),
                if (state.activeTransientRetryStatus case final retry?)
                  _OpenCodeRetryStatusBand(retry: retry),
                if (state.error != null && !state.bootstrapState.hasFailed)
                  _PageTabContent(
                    bottomPadding: 0,
                    child: _ErrorBanner(failure: state.error!),
                  ),
                if (state.draftConflict != null)
                  _PageTabContent(
                    bottomPadding: 0,
                    child: _DraftConflictBanner(
                      conflict: state.draftConflict!,
                      onKeepLocal: () => unawaited(
                        controller.resolveDraftConflictKeepLocal(),
                      ),
                      onUseShared: () => unawaited(
                        controller.resolveDraftConflictUseShared(),
                      ),
                    ),
                  ),
                Expanded(
                  child: IndexedStack(
                    index: _kSessionViewOrder.indexOf(effectiveView),
                    sizing: StackFit.expand,
                    children: [
                      _viewSlot(
                        _SessionDetailView.chat,
                        active: effectiveView,
                        showTerminalTab: showTerminalTab,
                        builder: () => _PageTabContent(
                          // Full-bleed so the transcript scrollbar reaches
                          // the window edge; the composer sits directly above
                          // the page SafeArea, so it only needs a hair of
                          // bottom inset (see [kComposerBottomInset]).
                          fullBleed: true,
                          bottomPadding: kComposerBottomInset,
                          // Per-session, never a global opener: the workspace
                          // can hold two session pages at once, and a global
                          // would send this transcript's tap to the other
                          // session's Files surface.
                          child: SessionFileLinkScope(
                            sessionKey: _key,
                            gate: fileLinkGate,
                            onOpen: _onOpenFileReference,
                            onProbeNeeded: _probeFileLinkGate,
                            child: _ChatPanel(
                              key: const Key('session-detail-tab-panel-chat'),
                              sessionKey: _key,
                              state: state,
                              controller: controller,
                              commands: commands,
                              models: models,
                              modes: state.modes,
                              effectiveModel: effectiveModel,
                              selectedPermissionMode:
                                  _selectedPermissionModeOverride ??
                                  state.sessionInfo?.currentMode,
                              selectedCommand: selectedCommand,
                              isConnected: isConnected,
                              hasActiveBrokerClient: hasActiveBrokerClient,
                              commandArgsController: _commandArgsController,
                              hasModelOverride: _selectedModelOverride != null,
                              isSendingPrompt: _isSendingPrompt,
                              isPickingAttachments: _isPickingAttachments,
                              isAttachmentIntakeBusy:
                                  _attachmentIntakeLeases.isNotEmpty,
                              promptController: _promptController,
                              promptFocusNode: _promptFocusNode,
                              stagedAttachments: state.stagedAttachments,
                              archivedLiveState: archivedLiveState,
                              onArchiveLiveState: _archiveLiveStateItem,
                              archiveTargetKey: _statusTabFlightTargetKey,
                              reportView: _reportView,
                              toolsExpanded: _toolsExpanded,
                              toolExpansionRevision: _toolExpansionRevision,
                              onSendCommand: () => _sendCommand(commands),
                              onCommandSelected: (name) {
                                setState(() {
                                  _selectedCommandName = name;
                                  _setCommandArgsFromSelection(
                                    _resolveSelectedCommand(commands),
                                  );
                                });
                              },
                              onAttachFiles: _pickAttachments,
                              onBeginAttachmentIntake: _beginAttachmentIntake,
                              onReplaceAttachment: _replaceAttachment,
                              onRemoveAttachment: _removeAttachment,
                              onSendPrompt: _sendPrompt,
                              onInterrupt: _interruptCurrentTurn,
                              bootstrapRetrying: _isRetryingBootstrap,
                              onRetryBootstrap: _retryBootstrap,
                              onAttach: () => unawaited(controller.attach()),
                              onForkFromMessage: (messageId) =>
                                  unawaited(_forkSession(messageId: messageId)),
                              onModelAndEffortSelected: _selectModelAndEffort,
                              onPermissionModeSelected: _selectPermissionMode,
                            ),
                          ),
                        ),
                      ),
                      _viewSlot(
                        _SessionDetailView.status,
                        active: effectiveView,
                        showTerminalTab: showTerminalTab,
                        builder: () => _PageTabContent(
                          child: _StatusTabPanel(
                            key: const Key('session-detail-tab-panel-status'),
                            sessionKey: _key,
                            draftController: _promptController,
                            hasActiveBrokerClient: hasActiveBrokerClient,
                            onAttach: () => unawaited(controller.attach()),
                            onDetach: () => unawaited(controller.disconnect()),
                            onExportTranscript: () =>
                                unawaited(_startTranscriptExport()),
                            onForkSession: () => unawaited(_forkSession()),
                            onCloneSession: () => unawaited(_cloneSession()),
                          ),
                        ),
                      ),
                      _viewSlot(
                        _SessionDetailView.terminal,
                        active: effectiveView,
                        showTerminalTab: showTerminalTab,
                        builder: () => _PageTabContent(
                          child: _TerminalPanel(
                            key: const Key(
                              'session-detail-tab-panel-terminal',
                            ),
                            messages: state.terminalOutputMessages,
                          ),
                        ),
                      ),
                      _viewSlot(
                        _SessionDetailView.files,
                        active: effectiveView,
                        showTerminalTab: showTerminalTab,
                        builder: () => _PageTabContent(
                          child: _FilesPanel(
                            key: const Key('session-detail-tab-panel-files'),
                            sessionKey: _key,
                            sessionLabel: '${_key.tool} · $visibleTitle',
                            isConnected: isConnected,
                            descriptors: state.fileArtifactDescriptors,
                            actionStates: state.artifactActionStates,
                            hasActiveBrokerClient: hasActiveBrokerClient,
                            transfers: artifactTransfers,
                            onRetryTransfer: (id) => ref
                                .read(transferWorkerProvider)
                                .retryTransfer(
                                  id,
                                  hasActiveBrokerClient: hasActiveBrokerClient,
                                ),
                            onCancelTransfer: (id) => ref
                                .read(transferWorkerProvider)
                                .cancelTransfer(id),
                            onDownloadArtifact: _downloadArtifact,
                            onPreviewArtifact: _previewArtifact,
                            onPreviewFile: _previewSessionFile,
                            onDownloadFile: _downloadSessionFile,
                          ),
                        ),
                      ),
                      _viewSlot(
                        _SessionDetailView.debug,
                        active: effectiveView,
                        showTerminalTab: showTerminalTab,
                        // Gated off: render nothing so Debug incurs no build
                        // cost and is unreachable, while the fixed slot order
                        // (and other views' state) is preserved.
                        builder: () => showDebugViews
                            ? _PageTabContent(
                                child: _DebugPanel(
                                  key: const Key(
                                    'session-detail-tab-panel-debug',
                                  ),
                                  state: state,
                                ),
                              )
                            : const SizedBox.shrink(),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    return VisibleAttentionSessionScope(
      tool: widget.tool,
      sessionId: widget.sessionId,
      child: page,
    );
  }

  Future<void> _changeProfileAfterDraftBarrier() async {
    final generation = ++_profileTransitionGeneration;
    _cancelAttachmentIntakeForSourceChange();
    // Every scheduled/staged draft belongs to the source generation that
    // admitted it. Retire profile A synchronously, before awaiting its
    // durability barrier, so ending composition under profile B cannot drain
    // A into B's composer.
    _lastAppliedRemoteDraftAt = -1;
    _lastAppliedRemoteDraftText = null;
    _scheduledRemoteDraftAt = -1;
    _scheduledRemoteDraftText = null;
    _lastAppliedDraftSurfaceToken = 0;
    _stagedComposingDraftSurface = null;
    _stagedComposingRemoteDraft = null;
    _stagedCompositionDrainGeneration = null;
    if (!await _establishDraftDurabilityBarrier() ||
        !mounted ||
        generation != _profileTransitionGeneration) {
      return;
    }
    // Profile isolation clears only after the previous source's exact text is
    // durable. The new profile's row hydrates through its draft surface.
    _applyingRemoteDraft = true;
    _promptController.clear();
    _applyingRemoteDraft = false;
    await ref.read(sessionDetailControllerProvider(_key).notifier).attach();
  }
}
