import 'dart:async';

import 'package:flutter/widgets.dart';

/// Normalized app lifecycle states for broker clients that do not depend on
/// Flutter UI types.
enum BrokerAppLifecycleState {
  /// App is visible and interactive.
  resumed,

  /// App is visible but not currently in the foreground.
  inactive,

  /// App is not visible to the user.
  hidden,

  /// App is in the background and not active.
  paused,

  /// App has detached from the host platform.
  detached,
}

/// Abstraction over app lifecycle observation for broker-client code.
abstract interface class BrokerAppLifecycleMonitor {
  /// Current normalized lifecycle state.
  BrokerAppLifecycleState get currentState;

  /// Lifecycle transition stream (distinct consecutive values are
  /// deduplicated).
  Stream<BrokerAppLifecycleState> get stateChanges;

  /// Stops observing lifecycle changes and releases resources.
  void dispose();
}

/// Flutter implementation of [BrokerAppLifecycleMonitor].
///
/// Exposes normalized [BrokerAppLifecycleState] values to app/client consumers
/// while keeping raw [AppLifecycleState] observations internal.
final class FlutterBrokerAppLifecycleMonitor
    with WidgetsBindingObserver
    implements BrokerAppLifecycleMonitor {
  /// Creates a monitor using an initial state fallback while attaching to
  /// `WidgetsBinding` immediately.
  ///
  /// If [initialState] is null, derives the initial state from
  /// `WidgetsBinding.instance.lifecycleState` when available. If that value is
  /// unavailable, this defaults to [BrokerAppLifecycleState.resumed].
  FlutterBrokerAppLifecycleMonitor({BrokerAppLifecycleState? initialState})
    : _currentState = initialState ?? _initialStateFromWidgetsBinding(),
      _stateStreamController =
          StreamController<BrokerAppLifecycleState>.broadcast() {
    WidgetsBinding.instance.addObserver(this);
  }

  final StreamController<BrokerAppLifecycleState> _stateStreamController;
  BrokerAppLifecycleState _currentState;
  bool _isDisposed = false;

  /// Current normalized lifecycle state.
  @override
  BrokerAppLifecycleState get currentState => _currentState;

  /// Stream of lifecycle transitions with identical consecutive states
  /// suppressed.
  @override
  Stream<BrokerAppLifecycleState> get stateChanges =>
      _stateStreamController.stream;

  @override
  void dispose() {
    if (_isDisposed) {
      return;
    }
    _isDisposed = true;
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_stateStreamController.close());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final next = _normalizeFlutterState(state);
    if (_isDisposed || next == _currentState) {
      return;
    }
    _currentState = next;
    _stateStreamController.add(next);
  }

  static BrokerAppLifecycleState _initialStateFromWidgetsBinding() {
    return _normalizeNullableFlutterState(
          WidgetsBinding.instance.lifecycleState,
        ) ??
        BrokerAppLifecycleState.resumed;
  }

  static BrokerAppLifecycleState _normalizeFlutterState(
    AppLifecycleState state,
  ) {
    return switch (state) {
      AppLifecycleState.resumed => BrokerAppLifecycleState.resumed,
      AppLifecycleState.inactive => BrokerAppLifecycleState.inactive,
      AppLifecycleState.hidden => BrokerAppLifecycleState.hidden,
      AppLifecycleState.paused => BrokerAppLifecycleState.paused,
      AppLifecycleState.detached => BrokerAppLifecycleState.detached,
    };
  }

  static BrokerAppLifecycleState? _normalizeNullableFlutterState(
    AppLifecycleState? state,
  ) {
    if (state == null) {
      return null;
    }
    return _normalizeFlutterState(state);
  }
}
