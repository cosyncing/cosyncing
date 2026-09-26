import 'dart:async';
import 'dart:js_interop';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/platform/lifecycle/web_lifecycle_state.dart';
import 'package:web/web.dart' as web;

/// The app's lifecycle monitor: read from the page itself in a browser.
BrokerAppLifecycleMonitor createAppLifecycleMonitor() =>
    WebAppLifecycleMonitor();

/// Lifecycle read from the document instead of from Flutter.
///
/// Flutter's web engine starts every page at `resumed` and changes state only
/// on a later focus, blur, or visibility event. A tab restored in the
/// background therefore reads `resumed`: its attention events become in-app
/// banners nobody sees instead of system notifications. Worse, when it is
/// first shown the engine reports nothing, because it believes it is already
/// resumed.
///
/// This monitor reads the document's real visibility and focus at start and on
/// each of the same events, so its state is always the page's.
final class WebAppLifecycleMonitor implements BrokerAppLifecycleMonitor {
  /// Starts observing the page.
  WebAppLifecycleMonitor({
    this.childFramePollInterval = const Duration(seconds: 1),
  }) : _currentState = _read() {
    web.window
      ..addEventListener('focus', _onFocus)
      ..addEventListener('blur', _onBlur);
    web.document.addEventListener('visibilitychange', _onVisibility);
  }

  /// How often focus is re-read while it is inside a child frame.
  final Duration childFramePollInterval;

  final StreamController<BrokerAppLifecycleState> _changes =
      StreamController<BrokerAppLifecycleState>.broadcast();
  BrokerAppLifecycleState _currentState;
  Timer? _childFramePoll;
  bool _isDisposed = false;

  late final JSFunction _onFocus = ((web.Event _) {
    _stopChildFramePoll();
    _update();
  }).toJS;

  late final JSFunction _onVisibility = ((web.Event _) => _update()).toJS;

  late final JSFunction _onBlur = ((web.Event _) {
    // Read once the blur has settled: focus may be moving to a child frame.
    scheduleMicrotask(() {
      _update();
      if (_isDisposed || _currentState != BrokerAppLifecycleState.resumed) {
        return;
      }
      // The window lost focus but the document kept it, so focus is in a
      // child frame (an HTML artifact). Leaving the browser from there sends
      // this page no event, so re-read until focus comes back or leaves.
      _childFramePoll ??= Timer.periodic(childFramePollInterval, (_) {
        _update();
        if (_currentState != BrokerAppLifecycleState.resumed) {
          _stopChildFramePoll();
        }
      });
    });
  }).toJS;

  @override
  BrokerAppLifecycleState get currentState => _currentState;

  @override
  Stream<BrokerAppLifecycleState> get stateChanges => _changes.stream;

  @override
  void dispose() {
    if (_isDisposed) return;
    _isDisposed = true;
    _stopChildFramePoll();
    web.window
      ..removeEventListener('focus', _onFocus)
      ..removeEventListener('blur', _onBlur);
    web.document.removeEventListener('visibilitychange', _onVisibility);
    unawaited(_changes.close());
  }

  void _stopChildFramePoll() {
    _childFramePoll?.cancel();
    _childFramePoll = null;
  }

  void _update() {
    if (_isDisposed) return;
    final next = _read();
    if (next == _currentState) return;
    _currentState = next;
    _changes.add(next);
  }

  static BrokerAppLifecycleState _read() => webLifecycleStateFor(
    hidden: web.document.visibilityState == 'hidden',
    focused: web.document.hasFocus(),
  );
}
