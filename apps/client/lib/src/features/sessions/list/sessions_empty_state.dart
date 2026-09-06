import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_window_controller.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// The empty-roster sentence for a narrowing query window, or `null` when the
/// window is unbounded and an empty roster really does mean an empty server.
///
/// The roster ships asking for seven days, so "no rows" is far more often "no
/// rows in the last week" than "no sessions on this server" — and the two
/// sentences send the reader to completely different places. Only
/// [SessionRosterQueryWindow.any] can support the second claim, because only it
/// asked the question that would answer it.
///
/// A null [window] means the stored preference has not resolved yet, which is
/// not the same as knowing it. The window provider is asynchronous and returns
/// to loading on a refresh, so a caller that substituted the shipped default
/// would name "the last 7 days" on a roster the reader had already widened to
/// all time — a specific, false sentence, flashed for exactly as long as the
/// rehydration takes. Say nothing about a window until the window is known.
String? sessionsEmptyWindowBody(
  AppLocalizations l10n,
  SessionRosterQueryWindow? window,
) => switch (window) {
  null => null,
  SessionRosterQueryWindow.any => null,
  SessionRosterQueryWindow.today => l10n.sessionsEmptyWindowToday,
  SessionRosterQueryWindow.last7Days => l10n.sessionsEmptyWindowLast7Days,
  SessionRosterQueryWindow.last30Days => l10n.sessionsEmptyWindowLast30Days,
};

/// Broker-aware empty state shared by compact and expanded Sessions layouts.
class SessionsEmptyState extends StatelessWidget {
  /// Creates the Sessions empty state.
  const SessionsEmptyState({
    required this.hasActiveBrokerClient,
    required this.creationAvailability,
    this.queryWindow = SessionRosterQueryWindow.any,
    this.onShowAllSessions,
    super.key,
  });

  /// Whether a usable broker client is currently selected.
  final bool hasActiveBrokerClient;

  /// Source-qualified creation capability for the selected server.
  final SessionCreationAvailability creationAvailability;

  /// The window the empty roster was fetched under, or null while the stored
  /// preference is still rehydrating.
  final SessionRosterQueryWindow? queryWindow;

  /// Widens [queryWindow] to all time. Absent surfaces show no widen action.
  final VoidCallback? onShowAllSessions;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final windowBody = hasActiveBrokerClient
        ? sessionsEmptyWindowBody(l10n, queryWindow)
        : null;
    final title = !hasActiveBrokerClient
        ? l10n.sessionsEmptyTitle
        : windowBody != null
        ? l10n.sessionsEmptyWindowTitle
        : l10n.sessionsEmptyActiveTitle;
    final body = !hasActiveBrokerClient
        ? l10n.sessionsEmptyBody
        : windowBody ??
              switch (creationAvailability) {
                SessionCreationAvailability.checking =>
                  l10n.sessionsEmptyCreationCheckingBody,
                SessionCreationAvailability.available =>
                  l10n.sessionsEmptyActiveBody,
                SessionCreationAvailability.unavailable =>
                  l10n.sessionsEmptyCreationUnavailableBody,
                SessionCreationAvailability.failed =>
                  l10n.sessionsEmptyCreationCheckFailedBody,
              };

    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.inbox_outlined, size: 64, color: tokens.textTertiary),
          const SizedBox(height: 16),
          SelectableText(
            key: const Key('sessions-empty-title'),
            title,
            style: Theme.of(context).textTheme.titleMedium,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          SelectableText(
            body,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: tokens.textSecondary),
            textAlign: TextAlign.center,
          ),
          if (!hasActiveBrokerClient) ...[
            const SizedBox(height: 16),
            FilledButton.tonalIcon(
              key: const Key('sessions-empty-connect'),
              onPressed: () => context.push(connectionRoute),
              icon: const Icon(Icons.link),
              label: Text(l10n.sessionsEmptyAction),
            ),
          ] else if (windowBody != null && onShowAllSessions != null) ...[
            const SizedBox(height: 16),
            // The way out of the window, in the empty state itself. The filter
            // bar that also changes it is not rendered while the roster is
            // empty, so without this the reader's only route back to their own
            // sessions is guessing that a filter exists somewhere.
            FilledButton.tonalIcon(
              key: const Key('sessions-empty-show-all'),
              onPressed: onShowAllSessions,
              icon: const Icon(Icons.history),
              label: Text(l10n.sessionsEmptyWindowAction),
            ),
          ],
        ],
      ),
    );
  }
}
