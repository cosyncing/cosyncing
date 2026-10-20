import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Latest local intent, with completion used to order requests for one session.
typedef PendingSessionVisibility = ({
  bool hidden,
  Future<void> settled,
  Set<String> visibleDescendants,
});

/// Overlays broker metadata until the latest visibility request settles.
final StateProvider<Map<String, PendingSessionVisibility>>
sessionVisibilityPendingProvider =
    StateProvider<Map<String, PendingSessionVisibility>>(
      (ref) {
        ref.listen(sessionListControllerProvider, (previous, roster) {
          final notifier = ref.read(sessionVisibilityPendingProvider.notifier);
          final pending = notifier.state;
          if (pending.isEmpty || roster.source == null) return;
          final hiddenRoots = [
            for (final session in roster.sessions)
              if ((session.appHidden ?? false) &&
                  !(session.appHiddenByAncestor ?? false))
                sessionCompositeRosterKey(session),
          ];
          if (hiddenRoots.isEmpty) return;
          final lineage = SessionRosterLineage.build(roster.sessions);
          var changed = false;
          final updated = <String, PendingSessionVisibility>{};
          for (final entry in pending.entries) {
            // Its own preceding Hide is the acknowledgement an Undo expects.
            // Independent hides of other roots must still prune whole subtrees.
            final remaining = [
              for (final key in hiddenRoots)
                if (sessionVisibilityKey(
                      roster.source,
                      lineage.sessionForKey(key)!,
                    ) !=
                    entry.key)
                  key,
            ];
            final explicitlyHidden = <String>{};
            while (remaining.isNotEmpty) {
              final key = remaining.removeLast();
              final session = lineage.sessionForKey(key)!;
              if (!explicitlyHidden.add(
                sessionVisibilityKey(roster.source, session),
              )) {
                continue;
              }
              remaining.addAll(lineage.childKeysOf(key));
            }
            final visible = entry.value.visibleDescendants;
            final retained = visible.difference(explicitlyHidden);
            changed |= retained.length != visible.length;
            updated[entry.key] = (
              hidden: entry.value.hidden,
              settled: entry.value.settled,
              visibleDescendants: retained,
            );
          }
          if (changed) notifier.state = updated;
        });
        return {};
      },
    );

/// Qualifies local visibility by the exact broker and session.
String sessionVisibilityKey(RosterSource? source, SessionInfo info) =>
    '${source?.storageKey}/${info.tool}/${info.id}';

/// Projects local intent without persisting it or inventing a broker revision.
SessionInfo projectPendingSessionVisibility(
  SessionInfo info,
  RosterSource? source,
  Map<String, PendingSessionVisibility> pending,
) {
  final key = sessionVisibilityKey(source, info);
  final intent = pending[key];
  // A completed parent hide can reach the roster while its Undo is queued.
  // Only restore descendants known visible before that hide: inherited broker
  // metadata does not reveal an independent hidden preference underneath it.
  final restoreDescendant =
      intent == null &&
      (info.appHiddenByAncestor ?? false) &&
      pending.values.any(
        (parent) => !parent.hidden && parent.visibleDescendants.contains(key),
      );
  final hidden = intent?.hidden ?? (restoreDescendant ? false : null);
  if (hidden == null || (info.appHidden == hidden && !restoreDescendant)) {
    return info;
  }
  return SessionInfo.fromJson({
    ...info.toJson(),
    'appHidden': hidden,
    if (restoreDescendant) 'appHiddenByAncestor': false,
  });
}

Set<String> _visibleDescendants(
  ProviderContainer container,
  RosterSource source,
  SessionInfo info,
) {
  if ((info.appHidden ?? true) || (info.appHiddenByAncestor ?? false)) {
    return {};
  }
  final roster = container.read(sessionListControllerProvider);
  if (roster.source != source) return {};
  final lineage = SessionRosterLineage.build(roster.sessions);
  final remaining = [...lineage.childKeysOf(sessionCompositeRosterKey(info))];
  final visible = <String>{};
  while (remaining.isNotEmpty) {
    final key = remaining.removeLast();
    final child = lineage.sessionForKey(key)!;
    if (child.appHidden == false) {
      visible.add(sessionVisibilityKey(source, child));
      remaining.addAll(lineage.childKeysOf(key));
    }
  }
  return visible;
}

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

/// Shows intent immediately, then persists in order. Never closes a tab.
Future<void> changeSessionVisibility(
  BuildContext context,
  SessionInfo info, {
  required bool hidden,
  bool offerUndo = true,
}) async {
  final container = ProviderScope.containerOf(context, listen: false);
  final source = RosterSource.of(container.read(activeBrokerProfileProvider));
  if (source == null) return;
  final key = sessionVisibilityKey(source, info);
  final pending = container.read(sessionVisibilityPendingProvider);
  final previous = pending[key];
  if (previous?.hidden == hidden) return;
  final settled = Completer<void>();
  final intent = (
    hidden: hidden,
    settled: settled.future,
    visibleDescendants:
        previous?.visibleDescendants ??
        _visibleDescendants(container, source, info),
  );
  final messenger = ScaffoldMessenger.of(context);
  final actionContext = Navigator.of(context).context;
  final l10n = AppLocalizations.of(context);
  final accessibleNavigation = MediaQuery.accessibleNavigationOf(context);
  bool current() =>
      RosterSource.of(container.read(activeBrokerProfileProvider)) == source;
  bool latest() =>
      container.read(sessionVisibilityPendingProvider)[key]?.settled ==
      settled.future;
  container.read(sessionVisibilityPendingProvider.notifier).state = {
    ...pending,
    key: intent,
  };
  try {
    if (messenger.mounted) {
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
                      // SnackBarAction dismisses its notice after this
                      // callback. Let that finish before showing Undo's notice:
                      // accessible navigation dismisses without an animation.
                      scheduleMicrotask(() {
                        if (!current() || !actionContext.mounted) return;
                        unawaited(
                          changeSessionVisibility(
                            actionContext,
                            info,
                            hidden: !hidden,
                            offerUndo: false,
                          ),
                        );
                      });
                    },
                  )
                : null,
          ),
        );
    }
    // Undo changes the overlay immediately but waits for the preceding write.
    // Superseded queued intents need no broker round trip of their own.
    if (previous != null) await previous.settled;
    if (!current() || !latest()) return;
    final client = await container.read(brokerClientProvider.future);
    if (!current() || !latest()) return;
    if (client == null) throw StateError('No broker client');
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
  } on Object {
    if (current() && latest() && messenger.mounted) {
      messenger
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(content: Text(l10n.sessionVisibilityFailed)),
        );
    }
  } finally {
    // Removing the overlay reveals current broker metadata, including activity
    // or visibility received while saving. Never restore an old whole row.
    if (latest()) {
      container.read(sessionVisibilityPendingProvider.notifier).state = {
        ...container.read(sessionVisibilityPendingProvider),
      }..remove(key);
    }
    settled.complete();
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
    final info = projectPendingSessionVisibility(
      session,
      source,
      ref.watch(sessionVisibilityPendingProvider),
    );
    final reason = sessionVisibilityDisabledReason(
      l10n,
      info,
      connected: connected,
    );
    return ListTile(
      key: const Key('session-detail-hide-button'),
      leading: Icon(
        info.appHidden ?? false
            ? Icons.visibility_outlined
            : Icons.visibility_off_outlined,
        size: 18,
      ),
      title: Text(
        info.appHidden ?? false ? l10n.sessionUnhide : l10n.sessionHide,
      ),
      subtitle: reason == null ? null : Text(reason),
      enabled: reason == null,
      onTap: reason != null
          ? null
          : () => unawaited(
              changeSessionVisibility(
                context,
                info,
                hidden: info.appHidden != true,
              ),
            ),
    );
  }
}
