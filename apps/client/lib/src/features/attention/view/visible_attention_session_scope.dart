import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Owns the duplicate-terminal suppression claim for one Session Detail page.
///
/// Stateful navigation keeps inactive branches mounted. Mount state therefore
/// cannot answer whether Session Detail is actually visible; [TickerMode] is
/// the production shell's onstage boundary. Provider publication remains
/// frame-safe, while the claim's synchronous visibility lease closes the gap
/// before a deferred release is committed.
class VisibleAttentionSessionScope extends ConsumerStatefulWidget {
  /// Creates a visibility owner around one Session Detail surface.
  const VisibleAttentionSessionScope({
    required this.tool,
    required this.sessionId,
    required this.child,
    super.key,
  });

  /// Agent tool key.
  final String tool;

  /// Agent session id.
  final String sessionId;

  /// Session Detail content.
  final Widget child;

  @override
  ConsumerState<VisibleAttentionSessionScope> createState() =>
      _VisibleAttentionSessionScopeState();
}

class _VisibleAttentionSessionScopeState
    extends ConsumerState<VisibleAttentionSessionScope> {
  final Object _owner = Object();
  ProviderContainer? _container;
  RosterSource? _source;
  bool _tickerEnabled = false;
  bool _disposed = false;
  bool _syncScheduled = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _container = ProviderScope.containerOf(context);
  }

  @override
  void didUpdateWidget(VisibleAttentionSessionScope oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tool != widget.tool ||
        oldWidget.sessionId != widget.sessionId) {
      _scheduleSync();
    }
  }

  @override
  Widget build(BuildContext context) {
    final source = ref.watch(
      activeBrokerProfileProvider.select(RosterSource.of),
    );
    final tickerEnabled = TickerMode.valuesOf(context).enabled;
    if (_source != source || _tickerEnabled != tickerEnabled) {
      _source = source;
      _tickerEnabled = tickerEnabled;
      _scheduleSync();
    }
    return widget.child;
  }

  @override
  void dispose() {
    _disposed = true;
    _tickerEnabled = false;
    _releaseCapturedClaim();
    super.dispose();
  }

  void _scheduleSync() {
    if (_syncScheduled) return;
    _syncScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _syncScheduled = false;
      if (!mounted) return;
      _syncClaim();
    });
  }

  void _syncClaim() {
    final notifier = ref.read(visibleAttentionSessionProvider.notifier);
    final source = _source;
    if (!_disposed && _tickerEnabled && source != null) {
      final tool = widget.tool;
      final sessionId = widget.sessionId;
      final current = notifier.state;
      if (identical(current?.owner, _owner) &&
          current?.source == source &&
          current?.tool == tool &&
          current?.sessionId == sessionId) {
        return;
      }
      notifier.state = VisibleAttentionSession(
        source: source,
        tool: tool,
        sessionId: sessionId,
        owner: _owner,
        isStillVisible: () => _ownsVisibleSurface(source, tool, sessionId),
      );
      return;
    }
    if (identical(notifier.state?.owner, _owner)) {
      notifier.state = null;
    }
  }

  bool _ownsVisibleSurface(
    RosterSource source,
    String tool,
    String sessionId,
  ) {
    final container = _container;
    return !_disposed &&
        _tickerEnabled &&
        _source == source &&
        container != null &&
        RosterSource.of(container.read(activeBrokerProfileProvider)) ==
            source &&
        widget.tool == tool &&
        widget.sessionId == sessionId;
  }

  void _releaseCapturedClaim() {
    final container = _container;
    if (container == null) return;
    final notifier = container.read(visibleAttentionSessionProvider.notifier);

    void release() {
      if (!notifier.mounted) return;
      if (identical(notifier.state?.owner, _owner)) {
        notifier.state = null;
      }
    }

    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.idle) {
      release();
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) => release());
    }
  }
}
