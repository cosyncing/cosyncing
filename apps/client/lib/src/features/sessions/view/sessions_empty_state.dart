import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/controller/new_session_controller.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// Broker-aware empty state shared by compact and expanded Sessions layouts.
class SessionsEmptyState extends StatelessWidget {
  /// Creates the Sessions empty state.
  const SessionsEmptyState({
    required this.hasActiveBrokerClient,
    required this.creationAvailability,
    super.key,
  });

  /// Whether a usable broker client is currently selected.
  final bool hasActiveBrokerClient;

  /// Source-qualified creation capability for the selected server.
  final SessionCreationAvailability creationAvailability;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final title = hasActiveBrokerClient
        ? l10n.sessionsEmptyActiveTitle
        : l10n.sessionsEmptyTitle;
    final body = !hasActiveBrokerClient
        ? l10n.sessionsEmptyBody
        : switch (creationAvailability) {
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
          ],
        ],
      ),
    );
  }
}
