import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Broker-facing read used by the usage surfaces.
///
/// One member today, and an interface anyway: it is the injection seam every
/// usage widget test substitutes, exactly as `ManagedRuntimeApi` is for
/// Settings. A top-level function would move that seam into each test's own
/// plumbing.
// ignore: one_member_abstracts
abstract interface class UsageReportApi {
  /// Reads the aggregated report for one inclusive date window.
  Future<UsageReportResponse> getReport({
    required String from,
    required String to,
  });
}

/// Synchronous dependency-injection seam used by tests.
final usageReportApiProvider = Provider<UsageReportApi?>((_) => null);

/// Identity-bound API context for the usage surfaces.
///
/// Scoped to the exact broker SOURCE — (profile, endpoint, incarnation) — for
/// the same reason the managed-runtime context is: a profile re-pointed at
/// another machine keeps its id, and usage figures are per-machine. An
/// id-stamped context would let one host's year render under another's name.
final usageReportApiContextProvider = FutureProvider<UsageReportApiContext?>((
  ref,
) async {
  final injected = ref.watch(usageReportApiProvider);
  final scopeKey = ref.watch(
    activeBrokerProfileProvider.select(
      (profile) => RosterSource.of(profile)?.storageKey,
    ),
  );
  if (injected != null) {
    return UsageReportApiContext(api: injected, brokerScopeKey: scopeKey);
  }

  final client = await ref.watch(brokerClientProvider.future);
  if (client == null) return null;
  return UsageReportApiContext(
    api: _BrokerUsageReportApi(client),
    brokerScopeKey: scopeKey,
  );
});

/// Context snapshot of usage-report API identity and broker selection.
final class UsageReportApiContext {
  /// Creates a context snapshot.
  const UsageReportApiContext({
    required this.api,
    required this.brokerScopeKey,
  });

  /// Client used for this snapshot.
  final UsageReportApi api;

  /// `RosterSource.storageKey` of the broker this API talks to.
  final String? brokerScopeKey;
}

/// Reference clock for window resolution, overridable so tests pin a date.
final usageNowProvider = Provider<DateTime Function()>((_) => DateTime.now);

/// The report for one period, or `null` when it is unavailable.
///
/// `null` means unavailable — no broker connected, or the read failed with a
/// [BrokerException] (Tokdash down, broker 502). The whole surface hides on it
/// rather than rendering zeros, because zero tokens and no reading are
/// different claims and only one of them is ever true here. Programming and
/// decoding errors are deliberately not swallowed.
///
/// Auto-disposed and keyed by period: leaving the report drops the
/// subscription, and switching periods keeps each window's result rather than
/// discarding it, which is what makes the broker's own window cache worth
/// having.
final AutoDisposeFutureProviderFamily<UsageReportResponse?, UsagePeriod>
usageReportProvider = FutureProvider.autoDispose
    .family<UsageReportResponse?, UsagePeriod>((ref, period) async {
      final context = await ref.watch(usageReportApiContextProvider.future);
      if (context == null) return null;
      final window = resolveUsageWindow(period, ref.watch(usageNowProvider)());
      try {
        return await context.api.getReport(from: window.from, to: window.to);
      } on BrokerException {
        return null;
      }
    });

final class _BrokerUsageReportApi implements UsageReportApi {
  const _BrokerUsageReportApi(this.client);

  final BrokerClient client;

  @override
  Future<UsageReportResponse> getReport({
    required String from,
    required String to,
  }) => client.getTokdashReport(from: from, to: to);
}
