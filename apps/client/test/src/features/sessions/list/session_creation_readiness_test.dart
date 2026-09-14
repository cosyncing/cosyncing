import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Creation readiness must not state, as a fact about the server, something it
/// learned from its own client not being ready.
///
/// `SessionCreationAvailability.unavailable` is documented as "a successful
/// read confirmed that no registered agent can create sessions". Every surface
/// that renders a reason reads it that way. So the ONLY thing allowed to
/// produce it is a completed `listAgents` that came back without a creatable
/// agent.
void main() {
  final profile = BrokerProfile(
    id: 'profile-a',
    displayName: 'Test',
    baseUri: Uri.parse('http://127.0.0.1:7734'),
    createdAt: DateTime.utc(2026),
  );

  ProviderContainer containerWith(Future<BrokerClient?> Function() client) {
    final container = ProviderContainer(
      overrides: [
        activeBrokerProfileProvider.overrideWith((ref) => profile),
        brokerClientProvider.overrideWith((ref) => client()),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  SessionCreationAvailability availabilityOf(ProviderContainer container) =>
      container
          .read(sessionCreationReadyProvider)
          .availabilityFor(RosterSource.of(profile));

  test(
    'an absent broker client is never reported as a confirmed answer',
    () async {
      // `brokerClientProvider` resolving to null means "no client yet",
      // which is not a read of the server at all. Reporting `unavailable`
      // for it asserts
      // the server was asked and said no. Measured consequence on the installed
      // client: the workspace "+" sat disabled with the settled-negative copy
      // while the broker was merely still answering -- `/api/sessions` takes
      // 13.4s cold at ~4000 sessions on this host.
      final container = containerWith(() async => null);
      // `refresh()` awaits the load, so the assertion lands on a COMPLETED read
      // rather than on whatever `checking` the build happened to leave behind.
      await container.read(sessionCreationReadyProvider.notifier).refresh();

      expect(
        availabilityOf(container),
        isNot(SessionCreationAvailability.unavailable),
        reason: 'no read happened, so nothing was confirmed',
      );
    },
  );

  test('a failed capability read is not a confirmed answer either', () async {
    final container = containerWith(() async => throw Exception('offline'));
    await container.read(sessionCreationReadyProvider.notifier).refresh();

    expect(
      availabilityOf(container),
      SessionCreationAvailability.failed,
      reason: 'a throw is a failure, never a settled negative',
    );
  });
}
