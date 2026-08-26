import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_freshness.dart';
import 'package:flutter/material.dart';

/// The roster's one top-right refresh/status slot.
///
/// Compact and Expanded render this same widget in the same position, so a
/// rotation or resize between them never moves the affordance and never shows
/// two indicators for one transition. The slot has a fixed footprint, so
/// switching between Refresh, progress, and the failure affordance cannot shift
/// the header layout.
///
/// It states stale truth exactly once: while the presentation is busy the
/// action is replaced by one progress glyph with a localized tooltip, and no
/// other roster surface adds a second spinner or "Updating…" line for the same
/// fact.
class RosterFreshnessSlot extends StatelessWidget {
  /// Creates the shared roster freshness slot.
  const RosterFreshnessSlot({
    required this.presentation,
    required this.onRefresh,
    super.key,
  });

  /// Fixed slot footprint, on the 4pt grid, so no state changes the layout.
  static const double slotExtent = 40;

  /// The single typed roster freshness state.
  final RosterFreshnessPresentation presentation;

  /// Invoked by the Refresh/Retry affordance.
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final label = switch (presentation.freshness) {
      SessionFreshness.initialLoading => l10n.rosterFreshnessLoading,
      SessionFreshness.refreshing => l10n.rosterFreshnessRefreshing,
      SessionFreshness.reconnecting => l10n.rosterFreshnessReconnecting,
      SessionFreshness.failed => switch (presentation.error) {
        final failure? => localizedFailureText(l10n, failure),
        null => l10n.rosterFreshnessFailed,
      },
      SessionFreshness.current => l10n.rosterRefresh,
    };
    // A failure whose recovery belongs to the content on screen keeps the slot
    // footprint but offers nothing: the cached-roster banner and the empty
    // error page already state the reason and carry the only Retry.
    if (presentation.freshness == SessionFreshness.failed &&
        !presentation.slotOwnsRecovery) {
      return SizedBox(
        key: const Key('roster-freshness-slot'),
        width: slotExtent,
        height: slotExtent,
        child: Center(
          child: Semantics(
            key: const Key('roster-freshness-deferred'),
            label: label,
            child: Icon(
              Icons.cloud_off_outlined,
              size: 18,
              color: tokens.textTertiary,
            ),
          ),
        ),
      );
    }
    final child = presentation.freshness.isBusy
        ? Tooltip(
            message: label,
            child: Semantics(
              key: const Key('roster-freshness-busy'),
              label: label,
              liveRegion: true,
              child: SizedBox(
                width: slotExtent,
                height: slotExtent,
                child: Center(
                  child: SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: presentation.freshness.isStale
                          ? tokens.textSecondary
                          : tokens.accent,
                    ),
                  ),
                ),
              ),
            ),
          )
        : IconButton(
            key: Key(
              presentation.freshness == SessionFreshness.failed
                  ? 'roster-freshness-retry'
                  : 'roster-freshness-refresh',
            ),
            visualDensity: VisualDensity.compact,
            tooltip: label,
            onPressed: onRefresh,
            icon: Icon(
              Icons.refresh,
              size: 18,
              color: presentation.freshness == SessionFreshness.failed
                  ? tokens.statusError
                  : null,
            ),
          );
    return SizedBox(
      key: const Key('roster-freshness-slot'),
      width: slotExtent,
      height: slotExtent,
      child: Center(child: child),
    );
  }
}
