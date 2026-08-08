/// Title resolution for session surfaces that render before the broker's
/// authoritative `SessionInfo` arrives.
///
/// Every pre-authoritative title source in the client — the opened-sessions
/// working set, its persisted snapshot, the bounded N3 roster snapshot — writes
/// the session id into its own title slot when it has nothing better. That
/// placeholder is fine to *store* (it is stable, locale-free identity) and
/// wrong to *show*: a native id is a fingerprint the user cannot recognise, and
/// flashing it where a name belongs is the U3 defect.
///
/// So display code asks this for a title it actually knows, and substitutes a
/// localized neutral label when the answer is null. Titles are display only;
/// routing, grouping and control decisions stay on `tool`/`sessionId`.
library;

/// Returns the first genuinely known human title among [candidates], or null.
///
/// A candidate is skipped when it is null, blank, or equal to [sessionId] —
/// the last because that is precisely the placeholder every unresolved source
/// writes. The one false negative is a session a user really did name after its
/// own id; it shows the neutral label until the authoritative frame lands,
/// which is strictly better than showing a fingerprint. Authoritative titles do
/// not come through here: callers take `SessionInfo.title` first, so a broker
/// that genuinely reports the id as the title still renders it.
String? knownSessionTitle(
  Iterable<String?> candidates, {
  required String sessionId,
}) {
  for (final candidate in candidates) {
    final trimmed = candidate?.trim();
    if (trimmed == null || trimmed.isEmpty) continue;
    if (trimmed == sessionId.trim()) continue;
    return trimmed;
  }
  return null;
}
