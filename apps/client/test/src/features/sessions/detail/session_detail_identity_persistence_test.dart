import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

void main() {
  test(
    'persists WebSocket hello compatibility for the active profile',
    () async {
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

      const broker = BrokerContractIdentity(
        revision: 3,
        minimumClientRevision: 2,
        surfaceHash: 'fnv1a32:abcdef12',
      );
      connection.emitEvent(
        const HelloWireEvent(
          brokerVersion: '1.3.0',
          brokerContract: broker,
          clientVersion: '1.2.0',
          compatibility: BrokerClientCompatibility(
            status: BrokerClientCompatibilityStatus.clientBehind,
            readOnly: false,
            reason: 'supported overlap',
            broker: broker,
            client: ClientContractIdentity(
              revision: 2,
              minimumBrokerRevision: 2,
            ),
          ),
        ),
      );
      await drainSessionDetailMicrotasks();

      final persisted =
          identityStore.helloByProfile[fakeControllerBrokerScope()];
      expect(persisted?.brokerVersion, '1.3.0');
      expect(
        persisted?.compatibility.status,
        BrokerClientCompatibilityStatus.clientBehind,
      );
    },
  );
}
