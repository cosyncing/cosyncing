part of 'session_detail_page.dart';

final class _SessionAttachmentIntakeLease {
  _SessionAttachmentIntakeLease({
    required this.isCurrentCallback,
    required this.ownsComposerCallback,
    required this.stageCallback,
    required this.failCallback,
    required this.releaseCallback,
  });

  final bool Function() isCurrentCallback;
  final bool Function() ownsComposerCallback;
  final Future<void> Function(List<SessionAttachmentIntakeItem> items)
  stageCallback;
  final VoidCallback failCallback;
  final VoidCallback releaseCallback;
  bool _released = false;
  Timer? _deadline;
  final Completer<void> _done = Completer<void>();

  bool get isCurrent => !_released && isCurrentCallback();

  /// Whether this composer still owns the gesture's *text*.
  ///
  /// Deliberately survives release and deadline expiry: the paste chord was
  /// consumed on this composer's behalf, so an ordinary text representation is
  /// still owed once the gesture reaches the clipboard, even if the attachment
  /// lease itself is gone by then. An unmount, a source replacement, an
  /// accepted send that cleared the draft, or a disabled composer revokes it —
  /// and so does dying before the drain reaches this gesture at all, since a
  /// gesture that never read the clipboard has nothing to insert.
  bool get ownsComposer => ownsComposerCallback();

  Future<void> get done => _done.future;

  /// Starts this gesture's own deadline.
  ///
  /// Per lease, not per batch: a gesture acquired nine seconds after the first
  /// one must still get the full [timeout], not the remainder of an older
  /// gesture's clock.
  void startDeadline(Duration timeout) {
    _deadline ??= Timer(timeout, fail);
  }

  Future<void> stage(List<SessionAttachmentIntakeItem> items) =>
      stageCallback(items);

  void fail() {
    if (_released) return;
    failCallback();
  }

  void release() {
    if (_released) return;
    _released = true;
    _deadline?.cancel();
    _deadline = null;
    if (!_done.isCompleted) _done.complete();
    releaseCallback();
  }
}

/// Live paste point of a consumed chord whose clipboard answer is pending.
///
/// The gesture's selection is folded through each composer edit as it arrives
/// rather than diffed once at the end. That is what makes edits on both sides
/// of the paste point work: every notification carries a single contiguous
/// change, even when the finished text differs from the anchor in several
/// places at once. Only an edit that covers the paste point itself gives up.
final class _SessionComposerPasteAnchor {
  _SessionComposerPasteAnchor(TextEditingValue value)
    : _text = value.text,
      _start = value.selection.start,
      _end = value.selection.end,
      _valid = value.selection.isValid;

  String _text;
  int _start;
  int _end;
  bool _valid;

  /// Where the paste belongs, or `null` once the paste point was edited away.
  TextSelection? get selection =>
      _valid ? TextSelection(baseOffset: _start, extentOffset: _end) : null;

  /// Gives up on the tracked point, falling the paste back to the live caret.
  ///
  /// Used when the anchor's offsets stop describing the document being edited
  /// at all — a composer whose controller was swapped out from under it.
  void abandon() => _valid = false;

  /// Folds one composer edit into the tracked paste point.
  void applyEdit(String text) {
    if (_text == text) return;
    if (!_valid) {
      _text = text;
      return;
    }
    final start = mapSessionComposerOffset(_text, text, _start);
    final end = mapSessionComposerOffset(_text, text, _end);
    _text = text;
    if (start == null || end == null) {
      _valid = false;
      return;
    }
    _start = start;
    _end = end;
  }
}

extension on _SessionDetailPageState {
  bool get _attachmentIntakeBlocksSend =>
      _isSendingPrompt || _isPickingAttachments;

  _SessionAttachmentIntakeLease? _beginAttachmentIntake() {
    final pickerBusy = _isPickingAttachments && _attachmentIntakeLeases.isEmpty;
    if (pickerBusy || _isSendingPrompt || !_composerEnabled) return null;
    if (_attachmentIntakeLeases.length >= sessionAttachmentMaxPendingGestures) {
      ref
          .read(sessionDetailControllerProvider(_key).notifier)
          .reportAttachmentIntakeFailure();
      return null;
    }
    final generation = _attachmentIntakeGeneration;
    final profileGeneration = _profileTransitionGeneration;
    final releaseHandoff = WebHandoffParticipants.instance.hold();
    bool ownsComposer() =>
        mounted &&
        generation == _attachmentIntakeGeneration &&
        profileGeneration == _profileTransitionGeneration &&
        _composerEnabled;
    late final _SessionAttachmentIntakeLease lease;
    lease = _SessionAttachmentIntakeLease(
      isCurrentCallback: () =>
          ownsComposer() && _attachmentIntakeLeases.contains(lease),
      ownsComposerCallback: ownsComposer,
      stageCallback: (items) => _stageAttachmentIntake(lease, items),
      failCallback: () {
        if (lease.isCurrent) {
          ref
              .read(sessionDetailControllerProvider(_key).notifier)
              .reportAttachmentIntakeFailure();
        }
        lease.release();
      },
      releaseCallback: () {
        _attachmentIntakeLeases.remove(lease);
        releaseHandoff();
        if (mounted &&
            _attachmentIntakeLeases.isEmpty &&
            generation == _attachmentIntakeGeneration) {
          _updateAttachmentIntake(() => _isPickingAttachments = false);
        }
      },
    );
    _attachmentIntakeLeases.add(lease);
    lease.startDeadline(sessionAttachmentIntakeTimeout);
    if (!_isPickingAttachments) {
      _updateAttachmentIntake(() => _isPickingAttachments = true);
    }
    return lease;
  }

  Future<void> _stageAttachmentIntake(
    _SessionAttachmentIntakeLease lease,
    List<SessionAttachmentIntakeItem> items,
  ) async {
    try {
      final attachments = await const SessionAttachmentIntakeMaterializer()
          .materialize(items);
      if (!lease.isCurrent) return;
      await ref
          .read(sessionDetailControllerProvider(_key).notifier)
          .admitAttachments(attachments);
    } on Object {
      if (lease.isCurrent) {
        ref
            .read(sessionDetailControllerProvider(_key).notifier)
            .reportAttachmentIntakeFailure();
      }
    } finally {
      lease.release();
    }
  }

  void _releaseAttachmentIntakeHolds() {
    final leases = _attachmentIntakeLeases.toList(growable: false);
    for (final lease in leases) {
      lease.release();
    }
  }

  void _cancelAttachmentIntakeForDispose() {
    _attachmentIntakeGeneration++;
    _releaseAttachmentIntakeHolds();
  }

  void _cancelAttachmentIntakeForSourceChange() {
    _cancelAttachmentIntakeForDispose();
    if (mounted && _isPickingAttachments) {
      _updateAttachmentIntake(() => _isPickingAttachments = false);
    }
  }

  /// Revokes consumed-paste obligations once a prompt leaves the composer.
  ///
  /// [_SessionAttachmentIntakeLease.ownsComposer] deliberately outlives its
  /// lease so a slow clipboard answer still reaches the draft the chord was
  /// pressed against. An accepted send that *clears* the composer ends that
  /// draft, so a late answer would otherwise land in whatever the user typed
  /// next. Call it only on that branch: a send whose draft was deliberately
  /// kept — the user typed while the prompt was in flight — has not ended the
  /// draft, and the text it owes still belongs there.
  ///
  /// Live leases cannot exist here ([_attachmentIntakeBlocksSend] holds the
  /// send until they finish), but the release path is shared with source
  /// changes so an unexpected one cannot strand the picker flag either.
  void _cancelAttachmentIntakeForAcceptedSend() =>
      _cancelAttachmentIntakeForSourceChange();
}

mixin _SessionAttachmentIntakeComposerHost on ConsumerState<_PromptComposer> {
  int _dragDepth = 0;
  bool _dragCompatible = false;
  bool _pasteEventsRegistered = false;
  final Queue<
    ({
      Future<void> Function() operation,
      _SessionAttachmentIntakeLease lease,
      _SessionComposerPasteAnchor? anchor,
    })
  >
  _pasteQueue = Queue();
  bool _pasteQueueRunning = false;
  bool _dropLimitSent = false;
  final List<_SessionComposerPasteAnchor> _pasteAnchors = [];
  late final SessionAttachmentClipboard _attachmentClipboard;
  final SessionAttachmentEventMemory _handledPasteEvents =
      SessionAttachmentEventMemory();
  final SessionAttachmentEventMemory _handledDropEvents =
      SessionAttachmentEventMemory();

  void _initializeAttachmentIntake() {
    _attachmentClipboard = ref.read(sessionAttachmentClipboardProvider);
  }

  /// Hands the drop platform its delivery bound, once, per composer.
  ///
  /// Sent from [didChangeDependencies] rather than `initState` because the
  /// desktop test needs an inherited theme. What each platform does with the
  /// bound differs, and only Windows avoids the enumeration outright: macOS
  /// still materializes the URL array in one AppKit call and saves the
  /// per-item stat and security-scoped bookmark, and Linux receives the whole
  /// selection blob and cuts it. In every case nothing past the bound reaches
  /// this isolate. One entry past the snapshot limit is all A1 needs to prove
  /// overflow. The browser hands its whole `FileList` to the registrar, so the
  /// web path bounds itself where it claims files.
  void _syncAttachmentDropLimit() {
    if (_dropLimitSent ||
        !_desktopAttachmentIntakeEnabled ||
        _attachmentClipboard.usesWebDropEvents) {
      return;
    }
    _dropLimitSent = true;
    unawaited(
      DesktopDrop.instance.setFileLimit(sessionAttachmentMaxSnapshotFiles + 1),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncAttachmentPasteEvents();
    _syncAttachmentDropLimit();
  }

  void _syncAttachmentPasteEvents() {
    final shouldRegister =
        _desktopAttachmentIntakeEnabled &&
        _attachmentClipboard.usesWebPasteEvents;
    if (shouldRegister == _pasteEventsRegistered) return;
    if (shouldRegister) {
      _attachmentClipboard
        ..addWebPasteListener(_onWebPasteEvent)
        ..addWebDropListener(_onWebDropEvent);
    } else {
      _attachmentClipboard
        ..removeWebPasteListener(_onWebPasteEvent)
        ..removeWebDropListener(_onWebDropEvent);
    }
    _pasteEventsRegistered = shouldRegister;
  }

  void _disposeAttachmentIntake() {
    _attachmentClipboard
      ..removeWebPasteListener(_onWebPasteEvent)
      ..removeWebDropListener(_onWebDropEvent);
    _pasteEventsRegistered = false;
    if (_pasteAnchors.isNotEmpty) {
      _pasteAnchors.clear();
      widget.controller.removeListener(_onComposerEditedDuringPaste);
    }
  }

  /// Keeps [anchor] mapped through composer edits until its paste resolves.
  ///
  /// The listener exists only while a paste is outstanding, so an idle composer
  /// carries no per-keystroke work and no retained anchors.
  void _trackPasteAnchor(_SessionComposerPasteAnchor anchor) {
    if (_pasteAnchors.isEmpty) {
      widget.controller.addListener(_onComposerEditedDuringPaste);
    }
    _pasteAnchors.add(anchor);
  }

  void _untrackPasteAnchor(_SessionComposerPasteAnchor anchor) {
    if (!_pasteAnchors.remove(anchor)) return;
    if (_pasteAnchors.isEmpty) {
      widget.controller.removeListener(_onComposerEditedDuringPaste);
    }
  }

  /// Follows a composer whose controller was replaced mid-paste.
  ///
  /// Without this the listener would stay on [previous] for its lifetime —
  /// `_untrackPasteAnchor` only ever detaches from the current controller — and
  /// the tracked offsets, which describe a document this composer no longer
  /// edits, could still address a valid position in the new one and drop the
  /// paste at an unrelated point. The obligation survives the swap; the
  /// position does not.
  void _moveAttachmentPasteAnchors(TextEditingController previous) {
    if (_pasteAnchors.isEmpty) return;
    previous.removeListener(_onComposerEditedDuringPaste);
    for (final anchor in _pasteAnchors) {
      anchor.abandon();
    }
    widget.controller.addListener(_onComposerEditedDuringPaste);
  }

  void _onComposerEditedDuringPaste() {
    final text = widget.controller.text;
    for (final anchor in _pasteAnchors) {
      anchor.applyEdit(text);
    }
  }

  bool get _desktopAttachmentIntakeEnabled =>
      Theme.of(context).platform == TargetPlatform.macOS ||
      Theme.of(context).platform == TargetPlatform.windows ||
      Theme.of(context).platform == TargetPlatform.linux;

  bool get _attachmentIntakeMayContinue =>
      !widget.isPickingAttachments || widget.isAttachmentIntakeBusy;

  bool get _ownsAttachmentIntake {
    if (!_desktopAttachmentIntakeEnabled || !widget.focusNode.hasFocus) {
      return false;
    }
    final route = ModalRoute.of(context);
    if (route == null || !route.isCurrent) return false;
    final voiceState = ref.read(voiceInputControllerProvider);
    return widget.controlsEnabled &&
        widget.attachmentEnabled &&
        !widget.isSubmitting &&
        _attachmentIntakeMayContinue &&
        !voiceState.isActive;
  }

  bool get _dropActionable {
    final route = ModalRoute.of(context);
    return _desktopAttachmentIntakeEnabled &&
        route != null &&
        route.isCurrent &&
        widget.controlsEnabled &&
        widget.attachmentEnabled &&
        !widget.isSubmitting &&
        _attachmentIntakeMayContinue;
  }

  bool _isPlatformPasteChord(KeyEvent event) {
    if (event.logicalKey != LogicalKeyboardKey.keyV) return false;
    final keyboard = HardwareKeyboard.instance;
    if (Theme.of(context).platform == TargetPlatform.macOS) {
      return keyboard.isMetaPressed &&
          !keyboard.isControlPressed &&
          !keyboard.isAltPressed &&
          !keyboard.isShiftPressed;
    }
    return keyboard.isControlPressed &&
        !keyboard.isMetaPressed &&
        !keyboard.isAltPressed &&
        !keyboard.isShiftPressed;
  }

  KeyEventResult? _handleAttachmentPasteKey(KeyEvent event) {
    if (kIsWeb || !_isPlatformPasteChord(event) || !_ownsAttachmentIntake) {
      return null;
    }
    if (_promptHasComposition) return KeyEventResult.ignored;
    if (event is KeyRepeatEvent) return KeyEventResult.handled;
    if (event is! KeyDownEvent) return KeyEventResult.handled;
    // Claim the chord only once a lease exists. Without one there is nothing
    // to stage into and nothing that will insert text later, so EditableText
    // must keep its ordinary paste instead of losing the gesture.
    final lease = widget.onBeginAttachmentIntake();
    if (lease == null) return KeyEventResult.ignored;
    _onNativePasteGesture(lease);
    return KeyEventResult.handled;
  }

  void _onWebPasteEvent(SessionAttachmentWebPasteEvent event) {
    // Text and rich text never get claimed: browser/EditableText keeps its
    // normal paste behavior. Only an actual FileList enters A1b.
    if (!_ownsAttachmentIntake ||
        _promptHasComposition ||
        !event.hasFiles ||
        _handledPasteEvents.contains(event.identity)) {
      return;
    }
    final lease = widget.onBeginAttachmentIntake();
    if (lease == null) {
      event.rejectFiles();
      return;
    }
    _handledPasteEvents.admit(event.identity);
    final items = event.claimFiles();
    if (items.isEmpty) {
      lease.release();
      return;
    }
    _enqueuePaste(() => lease.stage(items), lease);
  }

  void _onNativePasteGesture(_SessionAttachmentIntakeLease lease) {
    // Anchor the gesture to the composer value it was made against so a text
    // representation that arrives after an edit still lands where the user
    // pasted rather than wherever the caret has since moved.
    final anchor = _SessionComposerPasteAnchor(widget.controller.value);
    _trackPasteAnchor(anchor);
    _enqueuePaste(() => _runNativePaste(lease, anchor), lease, anchor);
  }

  Future<void> _runNativePaste(
    _SessionAttachmentIntakeLease lease,
    _SessionComposerPasteAnchor anchor,
  ) async {
    try {
      await _readNativePaste(lease, anchor);
    } finally {
      _untrackPasteAnchor(anchor);
    }
  }

  Future<void> _readNativePaste(
    _SessionAttachmentIntakeLease lease,
    _SessionComposerPasteAnchor anchor,
  ) async {
    final SessionAttachmentClipboardRead read;
    try {
      read = await _attachmentClipboard.readNative(
        isActive: () => lease.isCurrent,
      );
    } on SessionAttachmentIntakeException {
      // The clipboard held files this composer refuses. There is no ordinary
      // text paste to preserve, and A1b forbids inserting the platform's
      // filename/URI fallback for a file gesture.
      lease.fail();
      return;
    } on Object {
      // The probe itself failed, so the clipboard contents stay unknown. The
      // chord was already consumed, which makes finishing the ordinary text
      // paste this composer's responsibility.
      await _recoverConsumedTextPaste(lease, anchor);
      return;
    }
    switch (read) {
      case SessionAttachmentClipboardFiles(:final items):
        if (!lease.isCurrent) return;
        await lease.stage(items);
      case SessionAttachmentClipboardText(:final text):
        // Not gated on `isCurrent`: the attachment lease may already have been
        // retired by its deadline while the platform was still answering, but
        // the chord was consumed, so the text is still owed.
        if (text != null && text.isNotEmpty && lease.ownsComposer) {
          // A refused insertion (IME composition, invalid selection) means the
          // consumed chord produced nothing. Report it rather than letting the
          // paste disappear without a word.
          if (!_insertPastedText(text, anchor)) {
            lease.fail();
            return;
          }
        }
        lease.release();
    }
  }

  Future<void> _recoverConsumedTextPaste(
    _SessionAttachmentIntakeLease lease,
    _SessionComposerPasteAnchor anchor,
  ) async {
    String? text;
    try {
      text = await _attachmentClipboard.readNativeText();
    } on Object {
      text = null;
    }
    if (!lease.ownsComposer) {
      lease.release();
      return;
    }
    if (text == null || text.isEmpty || !_insertPastedText(text, anchor)) {
      lease.fail();
      return;
    }
    lease.release();
  }

  bool _ownsWebDropPosition(SessionAttachmentWebDropEvent event) {
    final renderObject = context.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.hasSize) return false;
    final local = renderObject.globalToLocal(
      Offset(event.clientX, event.clientY),
    );
    return renderObject.paintBounds.contains(local);
  }

  void _onWebDropEvent(SessionAttachmentWebDropEvent event) {
    // Cleanup runs before the ownership filter. A leave, a drop that lands
    // outside the composer, and a transfer that stops exposing files are all
    // normal ways a drag ends over an unowned surface, and every one of them
    // must retire the overlay rather than strand it.
    if (event.phase == SessionAttachmentWebDragPhase.leave ||
        !_ownsWebDropPosition(event) ||
        !event.hasFiles) {
      _clearDropState();
      return;
    }
    if (!_dropActionable) {
      event.reject();
      _clearDropState();
      return;
    }
    if (event.hasDirectory) {
      event.reject();
      _clearDropState();
      if (event.phase == SessionAttachmentWebDragPhase.drop) {
        widget.onBeginAttachmentIntake()?.fail();
      }
      return;
    }
    if (event.phase != SessionAttachmentWebDragPhase.drop) {
      event.acceptOperation();
      if (_dragDepth == 0 || !_dragCompatible) {
        setState(() {
          _dragDepth = 1;
          _dragCompatible = true;
        });
      }
      return;
    }
    _clearDropState();
    if (_handledDropEvents.contains(event.identity)) return;
    final lease = widget.onBeginAttachmentIntake();
    if (lease == null) {
      event.reject();
      return;
    }
    _handledDropEvents.admit(event.identity);
    final items = event.claimFiles();
    if (items.isEmpty) {
      lease.fail();
      return;
    }
    unawaited(lease.stage(items));
  }

  void _enqueuePaste(
    Future<void> Function() operation,
    _SessionAttachmentIntakeLease lease, [
    _SessionComposerPasteAnchor? anchor,
  ]) {
    _pasteQueue.add((operation: operation, lease: lease, anchor: anchor));
    if (!_pasteQueueRunning) unawaited(_drainPasteQueue());
  }

  Future<void> _drainPasteQueue() async {
    _pasteQueueRunning = true;
    while (_pasteQueue.isNotEmpty) {
      final queued = _pasteQueue.removeFirst();
      if (!queued.lease.isCurrent) {
        // The gesture died before its turn, so its operation never runs and
        // never reaches the `finally` that would stop tracking its anchor.
        final anchor = queued.anchor;
        if (anchor != null) _untrackPasteAnchor(anchor);
        continue;
      }
      try {
        await Future.any([queued.operation(), queued.lease.done]);
      } on Object {
        queued.lease.fail();
      }
      // The head of the queue may have ended by hitting its own deadline. Let
      // every deadline already due fire before the next gesture starts, so an
      // expired lease never reaches the clipboard.
      if (_pasteQueue.isNotEmpty) await Future<void>.delayed(Duration.zero);
    }
    _pasteQueueRunning = false;
  }

  bool get _promptHasComposition {
    final composing = widget.controller.value.composing;
    return composing.isValid && !composing.isCollapsed;
  }

  /// Inserts a text representation for an already-consumed paste chord.
  ///
  /// [anchor] is the paste point the gesture was made against, kept current
  /// through every edit the user made while the clipboard was still answering,
  /// so the paste lands where it was made rather than trailing the later caret.
  /// An anchor edited away falls back to the live selection.
  ///
  /// Returns `false` when the editor refused the insertion, which the caller
  /// must report: the chord was consumed, so a refusal that says nothing loses
  /// the user's paste silently.
  bool _insertPastedText(String text, [_SessionComposerPasteAnchor? anchor]) {
    final value = widget.controller.value;
    final selection = anchor?.selection;
    // A mapped anchor can only address text that still exists; anything else
    // would throw inside `replaced` rather than paste.
    final target = selection == null || selection.end > value.text.length
        ? value
        : value.copyWith(selection: selection);
    final next = applySessionComposerTextPaste(target, text);
    // An unchanged result means the editor refused the paste (IME composition
    // or an invalid selection); writing `target` back would move the caret
    // without inserting anything.
    if (next == target) return false;
    widget.controller.value = next;
    return true;
  }

  void _onDropEnter(DropEventDetails event) {
    if (!_dropActionable) return;
    setState(() {
      _dragDepth += 1;
      _dragCompatible = true;
    });
  }

  void _onDropExit(DropEventDetails event) {
    if (_dragDepth == 0) return;
    setState(() {
      _dragDepth -= 1;
      if (_dragDepth == 0) _dragCompatible = false;
    });
  }

  void _clearDropState() {
    if (!mounted || (_dragDepth == 0 && !_dragCompatible)) return;
    setState(() {
      _dragDepth = 0;
      _dragCompatible = false;
    });
  }

  void _onDropDone(DropDoneDetails details) {
    _clearDropState();
    if (!_dropActionable || !_handledDropEvents.admit(details)) return;
    final lease = widget.onBeginAttachmentIntake();
    if (lease == null) return;
    unawaited(_stageDroppedFiles(lease, details.files));
  }

  Future<void> _stageDroppedFiles(
    _SessionAttachmentIntakeLease lease,
    List<DropItem> files,
  ) async {
    try {
      // Bound the drop before any per-file stat. A1 needs only one item past
      // the limit to prove overflow, so a folder-sized drop is refused without
      // touching every entry.
      //
      // A promised item is a virtual payload the platform would have to
      // materialize into app-owned temporary storage. The vendored macOS fork
      // already refuses promises before writing anything; this rejects any
      // that still arrive rather than adopting bytes nothing here cleans up.
      if (files.isEmpty ||
          files.length > sessionAttachmentMaxSnapshotFiles ||
          files.any((item) => item is DropItemDirectory || item.fromPromise)) {
        lease.fail();
        return;
      }
      final items = <SessionAttachmentIntakeItem>[];
      for (final file in files) {
        final pathUri = Uri.tryParse(file.path);
        final hasRemoteScheme =
            pathUri != null &&
            pathUri.hasScheme &&
            (pathUri.isScheme('http') || pathUri.isScheme('https'));
        final isWindowsPath = RegExp(
          r'^(?:[A-Za-z]:[\\/]|\\\\)',
        ).hasMatch(file.path);
        final hasUnsupportedNativeScheme =
            !kIsWeb &&
            !isWindowsPath &&
            pathUri != null &&
            pathUri.hasScheme &&
            !pathUri.isScheme('file');
        if (hasRemoteScheme || hasUnsupportedNativeScheme) {
          lease.fail();
          return;
        }
        final length = await _dropFileLength(file);
        if (!lease.isCurrent) return;
        items.add(
          CallbackSessionAttachmentIntakeItem(
            name: file.name,
            byteLength: length,
            mimeType: file.mimeType,
            openReadCallback: ({int start = 0, int? end}) =>
                _openDroppedFile(file, start: start, end: end),
          ),
        );
      }
      await lease.stage(items);
    } on Object {
      lease.fail();
    } finally {
      if (lease.isCurrent) lease.release();
    }
  }

  Future<int> _dropFileLength(DropItem file) async {
    final bookmark = file.extraAppleBookmark;
    final accessed =
        bookmark != null &&
        await DesktopDrop.instance.startAccessingSecurityScopedResource(
          bookmark: bookmark,
        );
    try {
      return await file.length().timeout(sessionAttachmentIntakeTimeout);
    } finally {
      if (accessed) {
        await DesktopDrop.instance.stopAccessingSecurityScopedResource(
          bookmark: bookmark,
        );
      }
    }
  }

  Stream<List<int>> _openDroppedFile(
    DropItem file, {
    required int start,
    required int? end,
  }) async* {
    final bookmark = file.extraAppleBookmark;
    final accessed =
        bookmark != null &&
        await DesktopDrop.instance.startAccessingSecurityScopedResource(
          bookmark: bookmark,
        );
    try {
      yield* file.openRead(start, end);
    } finally {
      if (accessed) {
        await DesktopDrop.instance.stopAccessingSecurityScopedResource(
          bookmark: bookmark,
        );
      }
    }
  }

  Widget _wrapAttachmentDropTarget(Widget composer) {
    if (!_desktopAttachmentIntakeEnabled) return composer;
    final content = _attachmentDropContent(composer);
    if (_attachmentClipboard.usesWebDropEvents) {
      return KeyedSubtree(
        key: const Key('session-detail-attachment-drop-region'),
        child: content,
      );
    }
    return DropTarget(
      key: const Key('session-detail-attachment-drop-region'),
      enable: _dropActionable,
      onDragEntered: _onDropEnter,
      onDragExited: _onDropExit,
      onDragDone: _onDropDone,
      child: content,
    );
  }

  Widget _attachmentDropContent(Widget composer) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    return Stack(
      children: [
        composer,
        if (_dragDepth > 0 && _dragCompatible)
          Positioned.fill(
            child: IgnorePointer(
              child: Semantics(
                container: true,
                liveRegion: true,
                label: l10n.sessionAttachmentDropLabel,
                child: DecoratedBox(
                  key: const Key('session-detail-attachment-drop-overlay'),
                  decoration: BoxDecoration(
                    color: tokens.surface2,
                    borderRadius: BorderRadius.circular(tokens.radiusLg),
                    border: Border.all(color: tokens.accent, width: 2),
                  ),
                  child: Center(
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.file_download_outlined,
                          color: tokens.accent,
                        ),
                        const SizedBox(width: 8),
                        Text(
                          l10n.sessionAttachmentDropLabel,
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: tokens.textPrimary,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
