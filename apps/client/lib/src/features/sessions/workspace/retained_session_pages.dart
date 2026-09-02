import 'dart:async';

import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_focus.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_controller.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Maximum retained Session Detail page trees: active plus four recent pages.
const int retainedSessionPageBudget = 5;

/// Builds one embedded Session Detail page.
typedef RetainedSessionPageBuilder =
    Widget Function(BuildContext context, SessionRef session);

/// A source-qualified, bounded LRU of expanded Session Detail page trees.
///
/// Open-session controllers and transports remain owned by
/// `OpenSessionSyncSupervisor`; this host retains presentation state only. A
/// cached page is kept mounted under [Offstage], while [TickerMode] follows the
/// *visible set* and the focus gate follows the *focused* page.
///
/// Those two were one `activeKey` until the split pane needed them apart, and
/// they answer different questions. [Offstage] and [TickerMode] ask "is this on
/// screen" — a visible-but-unfocused pane is being read, so it must keep
/// ticking and keep suppressing its own notifications. The focus gate asks
/// "does this take the keystrokes", and exactly one page may answer yes or two
/// composers compete for the same text.
///
/// Membership can exceed [retainedSessionPageBudget]; least-recent page trees
/// are disposed without closing their durable tab or resident controller, and
/// a page that is on screen is never the one evicted.
class RetainedSessionPages extends ConsumerStatefulWidget {
  /// Creates the retained page host.
  const RetainedSessionPages({
    required this.source,
    required this.open,
    required this.builder,
    this.visibleKeys,
    this.focusedKey,
    super.key,
  });

  /// Exact broker source that owns every page in this host.
  final RosterSource? source;

  /// Current durable open-tab membership and active key.
  final OpenSessionsState open;

  /// Detail page builder.
  final RetainedSessionPageBuilder builder;

  /// Keys whose page trees are onstage, or null for "the active tab alone".
  ///
  /// A set because the workspace can show more than one pane at a time. The
  /// default is what a single-pane workspace means, so a caller that has not
  /// grown a second pane yet passes nothing.
  final Set<String>? visibleKeys;

  /// The key that owns focus traversal, or null for "the active tab".
  ///
  /// Always a member of [visibleKeys] when both are given; a focused page that
  /// is not on screen is not a state this host will paint.
  final String? focusedKey;

  @override
  ConsumerState<RetainedSessionPages> createState() =>
      _RetainedSessionPagesState();
}

class _RetainedSessionPagesState extends ConsumerState<RetainedSessionPages>
    with WidgetsBindingObserver {
  /// Least recent to most recent.
  final List<String> _lru = <String>[];
  bool _branchVisible = true;
  ProviderContainer? _container;
  bool _focusPublishScheduled = false;

  /// Keys currently on screen, honouring the branch's own visibility.
  Set<String> get _visibleKeys {
    if (!_branchVisible) return const {};
    final declared = widget.visibleKeys;
    if (declared != null) return declared;
    final activeKey = widget.open.activeKey;
    return activeKey == null ? const {} : {activeKey};
  }

  /// The key that takes keystrokes, or null when nothing on screen does.
  String? get _focusedKey {
    final focused = widget.focusedKey ?? widget.open.activeKey;
    if (focused == null || !_visibleKeys.contains(focused)) return null;
    return focused;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _synchronizeCache();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _container = ProviderScope.containerOf(context);
    final visible = TickerMode.valuesOf(context).enabled;
    if (_branchVisible && !visible) _silenceInteractiveMedia();
    _branchVisible = visible;
    _publishFocusedPane();
  }

  @override
  void didUpdateWidget(covariant RetainedSessionPages oldWidget) {
    super.didUpdateWidget(oldWidget);
    final sourceChanged = oldWidget.source != widget.source;
    final previousFocus = _focusedKeyOf(oldWidget);
    final focusChanged = previousFocus != _focusedKey;
    if (sourceChanged) _lru.clear();
    // Media follows focus, not visibility: a pane that is merely on screen
    // beside the focused one has not lost the microphone it was holding.
    if (sourceChanged || focusChanged) {
      _silenceInteractiveMedia(retainOwner: sourceChanged ? null : _focusedKey);
    }
    _synchronizeCache();
    _publishFocusedPane();
  }

  /// [other]'s focused key under this state's current branch visibility.
  String? _focusedKeyOf(RetainedSessionPages other) {
    if (!_branchVisible) return null;
    final focused = other.focusedKey ?? other.open.activeKey;
    if (focused == null) return null;
    final visible =
        other.visibleKeys ??
        (other.open.activeKey == null ? const {} : {other.open.activeKey!});
    return visible.contains(focused) ? focused : null;
  }

  /// Publishes the focused pane after the frame, never during build.
  ///
  /// Riverpod forbids writes from build, and `didUpdateWidget` runs inside the
  /// parent's build; the frame boundary is the only safe moment, and no input
  /// can be dispatched before it.
  void _publishFocusedPane() {
    if (_focusPublishScheduled) return;
    _focusPublishScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _focusPublishScheduled = false;
      final container = _container;
      if (!mounted || container == null) return;
      final notifier = container.read(focusedPaneProvider.notifier);
      if (!notifier.mounted) return;
      final focused = _focusedKey;
      if (notifier.state != focused) notifier.state = focused;
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) _silenceInteractiveMedia();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _silenceInteractiveMedia();
    super.dispose();
  }

  void _synchronizeCache() {
    final openKeys = <String>{
      for (final session in widget.open.refs) session.key,
    };
    _lru.removeWhere((key) => !openKeys.contains(key));
    final onscreen = _visibleKeys;
    final focused = _focusedKey;
    // Most recent last, focused last of all: promoting every onscreen key is
    // what keeps a second pane out of the eviction window.
    for (final key in <String>[
      ...onscreen.where((key) => key != focused),
      if (focused != null) focused,
    ]) {
      if (!openKeys.contains(key)) continue;
      _lru
        ..remove(key)
        ..add(key);
    }
    while (_lru.length > retainedSessionPageBudget) {
      // Never evict a page that is on screen. With one pane this is always
      // index 0 and the eviction order is unchanged; with two it is the
      // difference between a budget overflow and a pane blanking mid-read.
      final evictable = _lru.indexWhere((key) => !onscreen.contains(key));
      if (evictable < 0) break;
      _lru.removeAt(evictable);
    }
  }

  /// Stops voice output and discards microphone input.
  ///
  /// [retainOwner] spares media the named pane started, so moving focus to a
  /// second pane silences the pane being left rather than the one arriving.
  /// Passing null silences everything — a source change, a hidden branch and a
  /// backgrounded app all revoke every claim.
  ///
  /// Ownership is also re-stamped here, so whatever starts next belongs to the
  /// pane that is focused now. The controllers stay global singletons: one
  /// voice and one microphone is the physically correct model.
  void _silenceInteractiveMedia({Object? retainOwner}) {
    final container = _container;
    if (container == null) return;
    if (container.exists(readAloudControllerProvider)) {
      final readAloud = container.read(readAloudControllerProvider.notifier);
      if (retainOwner == null || readAloud.owningPane != retainOwner) {
        unawaited(readAloud.stop());
      }
      readAloud.owningPane = retainOwner;
    }
    if (container.exists(voiceInputControllerProvider)) {
      final voiceInput = container.read(voiceInputControllerProvider.notifier);
      if (retainOwner == null || voiceInput.owningPane != retainOwner) {
        unawaited(voiceInput.cancel());
      }
      voiceInput.owningPane = retainOwner;
    }
  }

  @override
  Widget build(BuildContext context) {
    final onscreen = _visibleKeys;
    final focused = _focusedKey;
    final byKey = <String, SessionRef>{
      for (final session in widget.open.refs) session.key: session,
    };
    return Stack(
      key: const Key('retained-session-pages'),
      fit: StackFit.expand,
      children: [
        for (final key in _lru)
          if (byKey[key] case final session?)
            _RetainedSessionPageSlot(
              key: ValueKey<_RetainedPageIdentity>(
                _RetainedPageIdentity(widget.source, key),
              ),
              pageKey: key,
              visible: onscreen.contains(key),
              focused: key == focused,
              child: widget.builder(context, session),
            ),
      ],
    );
  }
}

class _RetainedSessionPageSlot extends StatefulWidget {
  const _RetainedSessionPageSlot({
    required this.pageKey,
    required this.visible,
    required this.focused,
    required this.child,
    super.key,
  });

  final String pageKey;

  /// Onstage: painted, ticking, and publishing its own Attention claim.
  final bool visible;

  /// Takes keyboard focus and traversal. At most one slot at a time.
  final bool focused;

  final Widget child;

  @override
  State<_RetainedSessionPageSlot> createState() =>
      _RetainedSessionPageSlotState();
}

class _RetainedSessionPageSlotState extends State<_RetainedSessionPageSlot> {
  late final FocusNode _focusGate;

  @override
  void initState() {
    super.initState();
    _focusGate = FocusNode(
      debugLabel: 'retained-session-${widget.pageKey}',
      canRequestFocus: false,
      skipTraversal: !widget.focused,
      descendantsAreFocusable: widget.focused,
    );
  }

  @override
  void didUpdateWidget(covariant _RetainedSessionPageSlot oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.focused == widget.focused) return;
    _focusGate
      ..skipTraversal = !widget.focused
      ..descendantsAreFocusable = widget.focused;
    // Updating descendantsAreFocusable during this widget update schedules
    // the old page's focus revocation for the same frame. Forcing the focus
    // manager to flush here is forbidden because didUpdateWidget runs during
    // build; no input event can be dispatched until the frame completes.
  }

  @override
  void dispose() {
    _focusGate.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Offstage(
      key: Key('retained-session-page-${widget.pageKey}'),
      offstage: !widget.visible,
      child: TickerMode(
        enabled: widget.visible,
        child: Focus(
          focusNode: _focusGate,
          canRequestFocus: false,
          skipTraversal: !widget.focused,
          descendantsAreFocusable: widget.focused,
          child: widget.child,
        ),
      ),
    );
  }
}

@immutable
final class _RetainedPageIdentity {
  const _RetainedPageIdentity(this.source, this.sessionKey);

  final RosterSource? source;
  final String sessionKey;

  @override
  bool operator ==(Object other) =>
      other is _RetainedPageIdentity &&
      other.source == source &&
      other.sessionKey == sessionKey;

  @override
  int get hashCode => Object.hash(source, sessionKey);
}
