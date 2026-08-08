import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_contract_adoption.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('every broker registry entry has exactly one client disposition', () {
    expect(brokerRouteAdoption.keys.toSet(), brokerRoutes.toSet());
    expect(brokerWireFrameAdoption.keys.toSet(), brokerWireFrameKinds.toSet());
    expect(
      brokerClientMessageAdoption.keys.toSet(),
      brokerClientMessageKinds.toSet(),
    );

    final entries = [
      ...brokerRouteAdoption.values,
      ...brokerWireFrameAdoption.values,
      ...brokerClientMessageAdoption.values,
    ];
    expect(entries.every((entry) => entry.reason.trim().isNotEmpty), isTrue);
  });

  test('launch boundaries remain explicit', () {
    expect(
      brokerRouteAdoption['/api/machines']?.disposition,
      BrokerContractAdoptionDisposition.adopted,
    );
    expect(
      brokerClientMessageAdoption['plan-action']?.disposition,
      BrokerContractAdoptionDisposition.adopted,
    );
    expect(
      brokerClientMessageAdoption['artifact-interaction']?.disposition,
      BrokerContractAdoptionDisposition.deferred,
    );
    expect(
      brokerRouteAdoption['/api/machines/resolve']?.disposition,
      BrokerContractAdoptionDisposition.adopted,
    );
    expect(
      brokerRouteAdoption['/api/session-roster-deltas']?.disposition,
      BrokerContractAdoptionDisposition.adopted,
    );
    expect(
      brokerWireFrameAdoption['history-page']?.disposition,
      BrokerContractAdoptionDisposition.adopted,
    );
    expect(
      brokerRouteAdoption['/api/claude/hooks']?.disposition,
      BrokerContractAdoptionDisposition.brokerInternal,
    );
  });
}
