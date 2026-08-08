import 'package:cosyncing_client/src/features/connection/controller/broker_gate_controller.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_connection_gate.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Blocks the entire UI while the broker has refused this device's credential.
///
/// Mounted in `MaterialApp.router`'s `builder`, so it covers every route
/// without the router needing to know about it.
///
/// Deliberately blocks on [BrokerGateStatus.unauthorized] ONLY:
///
/// * `loading`/`error` fall through to [child]. Blocking on an unresolved probe
///   would flash a barrier over every cold start, and a controller fault would
///   brick the app with no route out. Nothing leaks by rendering early — every
///   broker call is gated server-side and simply 401s.
/// * [BrokerGateStatus.unreachable] falls through as well. A stopped broker
///   or a dropped network is not an authorization failure, and the app has
///   connection-error surfaces for it; blocking here would let one transient
///   blip replace the whole UI.
///
/// Swapping the subtree is a lifecycle boundary: unmounting it starts every
/// open session's asynchronous retirement, and the remounted subtree must
/// wait those retirements out through the session retirement ledger. The
/// credential-gate lifecycle regression exercises this widget directly, so
/// its blocking/fall-through semantics stay pinned to production.
class BrokerAuthBarrier extends ConsumerWidget {
  /// Creates the barrier around [child].
  const BrokerAuthBarrier({required this.child, super.key});

  /// The whole routed app surface this barrier can replace.
  final Widget? child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final body = child ?? const SizedBox.shrink();
    // valueOrNull collapses loading and error to null — both fall through.
    final gate = ref.watch(brokerGateControllerProvider).valueOrNull;
    if (gate == null || gate.status != BrokerGateStatus.unauthorized) {
      return body;
    }
    return Scaffold(
      key: const Key('broker-auth-barrier'),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: const BrokerConnectionGate(),
            ),
          ),
        ),
      ),
    );
  }
}
