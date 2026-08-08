import 'dart:async';
import 'dart:js_interop';

/// Browser-side release update state published by `web/index.html`.
class WebClientUpdateState {
  /// Creates an immutable web-client update observation.
  const WebClientUpdateState({
    required this.updateReady,
    required this.handoffFailed,
  });

  /// Whether a complete, verified replacement worker is waiting.
  ///
  /// Routine on the web and deliberately invisible: the page's handoff
  /// coordinator moves this tab out of the app scope, lets the replacement
  /// activate, and returns the tab to its route. Nothing may render because of
  /// this alone.
  final bool updateReady;

  /// Whether a real handoff was attempted, repeatedly, and never landed.
  ///
  /// Distinct from [updateReady] on purpose: a waiting build is routine, a
  /// handoff that keeps failing is the one case where the user has to be told
  /// something. Set only after the bounded attempt budget in `web/index.html`
  /// is spent, or when this mount has no destination outside the worker's
  /// scope at all.
  final bool handoffFailed;
}

@JS('cosyncingWebUpdateReady')
external JSBoolean? get _updateReady;

@JS('cosyncingWebUpdateHandoffFailed')
external JSBoolean? get _handoffFailed;

WebClientUpdateState _readState() => WebClientUpdateState(
  updateReady: _updateReady?.toDart ?? false,
  handoffFailed: _handoffFailed?.toDart ?? false,
);

/// Watches the shell's service-worker state without mutating worker lifecycle.
///
/// The page publishes state synchronously when the handoff protocol changes it.
/// This bounded poll lets Dart observe those globals without adding a JS
/// callback bridge and is not involved in activation, the handoff itself, or
/// compatibility.
Stream<WebClientUpdateState> watchWebClientUpdates() {
  late StreamController<WebClientUpdateState> controller;
  Timer? timer;
  WebClientUpdateState? previous;

  void publish() {
    final next = _readState();
    if (next.updateReady == previous?.updateReady &&
        next.handoffFailed == previous?.handoffFailed) {
      return;
    }
    previous = next;
    controller.add(next);
  }

  controller = StreamController<WebClientUpdateState>(
    onListen: () {
      publish();
      timer = Timer.periodic(const Duration(seconds: 2), (_) => publish());
    },
    onCancel: () => timer?.cancel(),
  );
  return controller.stream;
}
