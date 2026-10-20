import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Serializes visibility intents across the roster and Status surfaces.
final sessionVisibilityPendingProvider = StateProvider<Set<String>>(
  (ref) => {},
);

/// Shared reason for a disabled visibility action, including older brokers.
String? sessionVisibilityDisabledReason(
  AppLocalizations l10n,
  SessionInfo info, {
  required bool connected,
}) {
  if (!connected) return l10n.sessionVisibilityConnect;
  if (info.appHidden == null) return l10n.sessionVisibilityUnsupported;
  if (info.appHiddenByAncestor ?? false) return l10n.sessionVisibilityParent;
  return null;
}

/// Persists first, then updates only visibility metadata. Never closes a tab.
Future<void> changeSessionVisibility(
  BuildContext context,
  SessionInfo info, {
  required bool hidden,
  bool offerUndo = true,
}) async {
  final container = ProviderScope.containerOf(context, listen: false);
  final source = RosterSource.of(container.read(activeBrokerProfileProvider));
  if (source == null) return;
  final key = '${source.storageKey}/${info.tool}/${info.id}';
  final pending = container.read(sessionVisibilityPendingProvider);
  if (pending.contains(key)) return;
  final messenger = ScaffoldMessenger.of(context);
  final actionContext = Navigator.of(context).context;
  final l10n = AppLocalizations.of(context);
  final accessibleNavigation = MediaQuery.accessibleNavigationOf(context);
  bool current() =>
      RosterSource.of(container.read(activeBrokerProfileProvider)) == source;
  container.read(sessionVisibilityPendingProvider.notifier).state = {
    ...pending,
    key,
  };
  try {
    final client = await container.read(brokerClientProvider.future);
    if (!current() || client == null) return;
    final accepted = await client.setSessionVisibility(
      info.tool,
      info.id,
      hidden: hidden,
    );
    if (!current()) return;
    container
        .read(sessionListControllerProvider.notifier)
        .acceptSessionVisibility(accepted);
    for (final session in accepted) {
      final provider = sessionDetailControllerProvider(
        SessionDetailKey(tool: session.tool, sessionId: session.id),
      );
      if (container.exists(provider)) {
        container
            .read(provider.notifier)
            .acceptSessionVisibility(source, session);
      }
    }
    if (!messenger.mounted) return;
    messenger
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          content: Text(hidden ? l10n.sessionHidden : l10n.sessionUnhidden),
          persist: offerUndo && accessibleNavigation,
          showCloseIcon: true,
          action: offerUndo
              ? SnackBarAction(
                  label: l10n.sessionVisibilityUndo,
                  onPressed: () {
                    if (!current() || !actionContext.mounted) return;
                    unawaited(
                      changeSessionVisibility(
                        actionContext,
                        info,
                        hidden: !hidden,
                        offerUndo: false,
                      ),
                    );
                  },
                )
              : null,
        ),
      );
  } on Object {
    if (current() && messenger.mounted) {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.sessionVisibilityFailed)),
      );
    }
  } finally {
    container.read(sessionVisibilityPendingProvider.notifier).state = {
      ...container.read(sessionVisibilityPendingProvider),
    }..remove(key);
  }
}

/// The same visibility action above Detach in Status.
class SessionVisibilityTile extends ConsumerWidget {
  /// Broker-owned visibility action for the current session.
  const SessionVisibilityTile({
    required this.session,
    required this.connected,
    super.key,
  });

  /// Current session metadata.
  final SessionInfo session;

  /// Whether this broker connection permits visibility changes.
  final bool connected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final source = RosterSource.of(ref.watch(activeBrokerProfileProvider));
    final pending = ref
        .watch(sessionVisibilityPendingProvider)
        .contains('${source?.storageKey}/${session.tool}/${session.id}');
    final reason = sessionVisibilityDisabledReason(
      l10n,
      session,
      connected: connected,
    );
    return ListTile(
      key: const Key('session-detail-hide-button'),
      leading: Icon(
        session.appHidden ?? false
            ? Icons.visibility_outlined
            : Icons.visibility_off_outlined,
        size: 18,
      ),
      title: Text(
        session.appHidden ?? false ? l10n.sessionUnhide : l10n.sessionHide,
      ),
      subtitle: reason == null ? null : Text(reason),
      enabled: !pending && reason == null,
      onTap: pending || reason != null
          ? null
          : () => unawaited(
              changeSessionVisibility(
                context,
                session,
                hidden: session.appHidden != true,
              ),
            ),
    );
  }
}
