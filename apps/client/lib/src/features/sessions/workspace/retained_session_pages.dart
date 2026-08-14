import 'dart:async';

import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
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
/// cached page is kept mounted under [Offstage], while [TickerMode] and a focus
/// gate make only the active page interactive. Membership can exceed
/// [retainedSessionPageBudget]; least-recent page trees are disposed without
/// closing their durable tab or resident controller.
class RetainedSessionPages extends ConsumerStatefulWidget {
  /// Creates the retained page host.
  const RetainedSessionPages({
    required this.source,
    required this.open,
    required this.builder,
    super.key,
  });

  /// Exact broker source that owns every page in this host.
  final RosterSource? source;

  /// Current durable open-tab membership and active key.
  final OpenSessionsState open;

  /// Detail page builder.
  final RetainedSessionPageBuilder builder;

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
  }

  @override
  void didUpdateWidget(covariant RetainedSessionPages oldWidget) {
    super.didUpdateWidget(oldWidget);
    final sourceChanged = oldWidget.source != widget.source;
    final activeChanged = oldWidget.open.activeKey != widget.open.activeKey;
    if (sourceChanged) _lru.clear();
    if (sourceChanged || activeChanged) _silenceInteractiveMedia();
    _synchronizeCache();
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
    final activeKey = widget.open.activeKey;
    if (activeKey != null && openKeys.contains(activeKey)) {
      _lru
        ..remove(activeKey)
        ..add(activeKey);
    }
    while (_lru.length > retainedSessionPageBudget) {
      _lru.removeAt(0);
    }
  }

  void _silenceInteractiveMedia() {
    final container = _container;
    if (container == null) return;
    if (container.exists(readAloudControllerProvider)) {
      unawaited(
        container.read(readAloudControllerProvider.notifier).stop(),
      );
    }
    if (container.exists(voiceInputControllerProvider)) {
      unawaited(
        container.read(voiceInputControllerProvider.notifier).cancel(),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final activeKey = widget.open.activeKey;
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
              active: _branchVisible && key == activeKey,
              child: widget.builder(context, session),
            ),
      ],
    );
  }
}

class _RetainedSessionPageSlot extends StatefulWidget {
  const _RetainedSessionPageSlot({
    required this.pageKey,
    required this.active,
    required this.child,
    super.key,
  });

  final String pageKey;
  final bool active;
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
      skipTraversal: !widget.active,
      descendantsAreFocusable: widget.active,
    );
  }

  @override
  void didUpdateWidget(covariant _RetainedSessionPageSlot oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active == widget.active) return;
    _focusGate
      ..skipTraversal = !widget.active
      ..descendantsAreFocusable = widget.active;
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
      offstage: !widget.active,
      child: TickerMode(
        enabled: widget.active,
        child: Focus(
          focusNode: _focusGate,
          canRequestFocus: false,
          skipTraversal: !widget.active,
          descendantsAreFocusable: widget.active,
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
