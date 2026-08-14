/// Device-global transcript detail policy.
///
/// Governing doc: `docs/architecture/client-ui.md`.
enum ToolDisplayMode {
  /// Width-aware expansion: execute/edit expand at 700 logical pixels.
  responsive('responsive'),

  /// Keep every tool at its compact Tier-1 row until the user expands it.
  tier1Only('tier-1-only'),

  /// Keep user turns, final assistant messages, and safety surfaces only.
  finalMessagesOnly('final-messages-only');

  const ToolDisplayMode(this.token);

  /// Stable value stored in the app settings table.
  final String token;

  /// Parses a stored value, defaulting safely to [responsive].
  static ToolDisplayMode fromToken(String? token) => switch (token) {
    'tier-1-only' => ToolDisplayMode.tier1Only,
    'final-messages-only' => ToolDisplayMode.finalMessagesOnly,
    _ => ToolDisplayMode.responsive,
  };
}
