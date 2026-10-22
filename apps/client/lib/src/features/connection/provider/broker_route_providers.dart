import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/controller/broker_route_coordinator.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_http_transport.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_profile_merge.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/pairing/data/transport_pairing_store.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_connection.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:cosyncing_client/src/platform/clock/app_clock.dart';
import 'package:cosyncing_client/src/platform/connection/broker_network_changes.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Only committed handoffs change this revision. Latency updates do not rebuild
/// session transports, move focus, or reset a transcript's scroll position.
/// Retain only the latest active server, so removed profile IDs do not
/// accumulate.
final brokerRouteRevisionProvider = StateProvider<Map<String, int>>(
  (ref) => const {},
);

/// App-scoped fair route coordinator and its foreground lifetime.
final brokerRouteCoordinatorProvider =
    ChangeNotifierProvider<BrokerRouteCoordinator>((ref) {
      final coordinator = BrokerRouteCoordinator(
        store: ref.watch(brokerRouteStoreProvider),
        credentials: ref.watch(credentialStoreProvider),
        httpOverride: ref.watch(brokerHttpTransportProvider),
        socketOverride: ref.watch(sessionSocketAdapterFactoryProvider),
        now: ref.watch(appClockProvider),
        monotonicNow: ref.watch(appMonotonicClockProvider),
        onSwitch: (profile) async {
          final current = await ref
              .read(brokerProfileRepositoryProvider)
              .getById(profile.id);
          if (current?.incarnationId != profile.incarnationId) return;
          ref.invalidate(brokerProfileListProvider);
          final active = ref.read(activeBrokerProfileProvider);
          if (active?.id == profile.id &&
              active?.incarnationId == profile.incarnationId) {
            if (active?.sourceIdentity != current?.sourceIdentity) {
              ref.read(activeBrokerProfileProvider.notifier).state = current;
            }
            ref.invalidate(brokerClientProvider);
            ref
                .read(brokerRouteRevisionProvider.notifier)
                .update(
                  (value) => {
                    profile.id: (value[profile.id] ?? 0) + 1,
                  },
                );
          }
        },
      )..selected(ref.read(activeBrokerProfileProvider));
      ref.listen(activeBrokerProfileProvider, (_, profile) {
        coordinator.selected(profile);
      });
      final lifecycle = ref.watch(sessionNotificationLifecycleMonitorProvider);
      coordinator.foreground(
        value: lifecycle.currentState == BrokerAppLifecycleState.resumed,
      );
      final subscription = lifecycle.stateChanges.listen(
        (state) {
          coordinator.foreground(
            value: state == BrokerAppLifecycleState.resumed,
          );
        },
      );
      Timer? networkChange;
      final networkSubscription = ref
          .watch(brokerNetworkChangesProvider)
          .listen(
            (_) {
              // Coalesce platform bursts into one generation, without polling
              // or
              // starting a separate probe for every interface notification.
              networkChange ??= Timer(const Duration(milliseconds: 100), () {
                networkChange = null;
                coordinator.networkChanged();
              });
            },
            onError: (Object _, StackTrace _) {
              // Unsupported platform monitors do not disable real liveness
              // checks.
            },
          );
      ref
        ..onDispose(() => unawaited(subscription.cancel()))
        ..onDispose(() {
          networkChange?.cancel();
          unawaited(networkSubscription.cancel());
        });
      return coordinator;
    });

/// Durable merge recovery shares the existing secure credential namespaces.
final brokerProfileMergeProvider = Provider<BrokerProfileMerge>(
  (ref) => BrokerProfileMerge(
    ref.watch(appDatabaseProvider),
    ref.watch(brokerRouteStoreProvider),
    ref.watch(credentialStoreProvider),
    ref.watch(transportPairingStoreProvider),
  ),
);
