/// Browser-side release update state. Native packages update through the
/// signed broker/runtime flow and therefore never surface this web-only state.
class WebClientUpdateState {
  /// Creates an immutable web-client update observation.
  const WebClientUpdateState({
    required this.updateReady,
    required this.handoffFailed,
  });

  /// Whether a complete, verified replacement worker is waiting.
  ///
  /// Routine on the web and deliberately invisible: `web/index.html` moves the
  /// tab through the handoff itself. Nothing may render because of this alone.
  final bool updateReady;

  /// Whether a real handoff was attempted, repeatedly, and never landed.
  ///
  /// The only state that may surface user-visible recovery copy.
  final bool handoffFailed;
}

/// Emits the native platform's permanent no-web-update state.
Stream<WebClientUpdateState> watchWebClientUpdates() => Stream.value(
  const WebClientUpdateState(updateReady: false, handoffFailed: false),
);
