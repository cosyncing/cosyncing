import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

void main() {
  /// Runs one hello through a connection that has DECLARED itself read-only,
  /// and returns whatever reached the durable per-profile store.
  Future<HelloWireEvent?> persistedFromReadOnlySocket(
    BrokerClientCompatibilityStatus status,
  ) async {
    const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
    final connection = FakeSessionDetailConnection();
    final identityStore = RecordingBrokerIdentityStore();
    final container = buildControllerContainerWithNotificationHooks(
      key: key,
      connection: connection,
      picker: FakeControllerAttachmentPicker(),
      brokerIdentityStore: identityStore,
    );
    addTearDown(container.dispose);
    keepSessionDetailAlive(container, key);
    await container
        .read(sessionDetailControllerProvider(key).notifier)
        .attach();
    connection.requireReadOnly();

    const broker = BrokerContractIdentity(
      revision: 15,
      minimumClientRevision: 2,
      surfaceHash: 'fnv1a32:abcdef12',
    );
    connection.emitEvent(
      HelloWireEvent(
        brokerVersion: '1.3.0',
        brokerContract: broker,
        clientVersion: '1.2.0',
        compatibility: BrokerClientCompatibility(
          status: status,
          readOnly: true,
          reason: 'reason',
          broker: broker,
          client: const ClientContractIdentity(
            revision: 2,
            minimumBrokerRevision: 2,
          ),
        ),
      ),
    );
    await drainSessionDetailMicrotasks();
    return identityStore.helloByProfile[fakeControllerBrokerScope()];
  }

  test(
    'a session-local read-only declaration never marks the whole broker '
    'read-only',
    () async {
      // The store is keyed by broker profile. One unreadable session must not
      // publish its own posture as a fact about the pairing — every other
      // socket to that broker is writable, and the same record feeds global
      // client-update guidance.
      expect(
        await persistedFromReadOnlySocket(
          BrokerClientCompatibilityStatus.compatible,
        ),
        isNull,
      );
    },
  );
}
