/// Client disposition for one broker contract registry entry.
enum BrokerContractAdoptionDisposition {
  /// The Flutter client has a typed production path for this entry.
  adopted,

  /// The entry is intentionally not yet exposed, with a documented reason.
  deferred,

  /// The route belongs to broker/adapter/deployment plumbing, not this client.
  brokerInternal,
}

/// One auditable contract adoption decision.
final class BrokerContractAdoption {
  /// Creates a disposition entry.
  const BrokerContractAdoption(this.disposition, this.reason);

  /// Current client disposition.
  final BrokerContractAdoptionDisposition disposition;

  /// Stable explanation for adoption or deferment.
  final String reason;
}

const _adopted = BrokerContractAdoption(
  BrokerContractAdoptionDisposition.adopted,
  'Typed production client path exists.',
);

/// Declared Flutter-client disposition for every broker REST route.
const Map<String, BrokerContractAdoption> brokerRouteAdoption = {
  '/api/agents': _adopted,
  '/api/agents/{id}/models': _adopted,
  '/api/agents/codex/sync': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.deferred,
    'Managed Codex sync/setup remains a broker-first lifecycle feature.',
  ),
  '/api/agent-runtime-updates': _adopted,
  '/api/agent-runtime-update-policy': _adopted,
  '/api/agent-runtime-updates/{id}/restart': _adopted,
  '/api/attention-events': _adopted,
  '/api/attention-events/dismiss-batch': _adopted,
  '/api/attention-events/{id}/ack': _adopted,
  '/api/attention-events/{id}/dismiss': _adopted,
  '/api/broker/health': _adopted,
  '/api/broker/update': _adopted,
  '/api/broker/restart': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.deferred,
    'The client exposes targeted runtime restart and confirmed restart-all.',
  ),
  '/api/broker/restart-all': _adopted,
  '/api/health': _adopted,
  '/api/machines': _adopted,
  '/api/machines/resolve': _adopted,
  '/api/projects/rename': _adopted,
  '/api/push/wake': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.brokerInternal,
    'Deployment push senders call this opaque-wake ingress.',
  ),
  '/api/push/wake-tokens': _adopted,
  '/api/push/wake-tokens/{id}': _adopted,
  '/api/schedules': _adopted,
  '/api/schedules/{id}': _adopted,
  '/api/schedules/{id}/actions': _adopted,
  '/api/claude/hooks': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.brokerInternal,
    'Claude hook/adapter traffic does not originate in the Flutter client.',
  ),
  '/api/session-roster-deltas': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.adopted,
    'The foreground roster controller consumes typed revision-delta waits.',
  ),
  '/api/sessions': _adopted,
  '/api/sessions/{id}': _adopted,
  '/api/sessions/{id}/{id}/artifact/{id}': _adopted,
  '/api/sessions/{id}/{id}/fs': _adopted,
  '/api/sessions/{id}/{id}/fs/read': _adopted,
  '/api/sessions/{id}/{id}/fs/download': _adopted,
  '/api/sessions/{id}/{id}/uploads': _adopted,
  '/api/sessions/{id}/{id}/uploads/{id}': _adopted,
  '/api/sessions/{id}/{id}/uploads/{id}/complete': _adopted,
  '/api/sessions/{id}/{id}/cache': _adopted,
  '/api/sessions/{id}/{id}/clone': _adopted,
  '/api/sessions/{id}/{id}/export': _adopted,
  '/api/sessions/{id}/{id}/export/preflight': _adopted,
  '/api/sessions/{id}/{id}/fork': _adopted,
  '/api/sessions/{id}/{id}/rename': _adopted,
  '/api/sessions/{id}/{id}/stream': _adopted,
  '/api/tokdash/usage': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.deferred,
    'The client uses reviewed quota APIs; raw usage has no product surface.',
  ),
  '/api/tokdash/quota': _adopted,
  '/api/tokdash/quota-preference': _adopted,
  '/api/tool/send_file': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.brokerInternal,
    'Tool adapter ingress is not a native-client upload path.',
  ),
  '/api/transport/envelopes': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.deferred,
    'Encrypted-envelope adoption follows scoped peer credentials.',
  ),
  '/api/transport/peers': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.deferred,
    'Peer roster/revoke UI follows scoped peer credentials.',
  ),
  '/api/transport/peers/{id}': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.deferred,
    'Peer revoke/rotation UI follows scoped peer credentials.',
  ),
  '/api/transport/pairings': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.brokerInternal,
    'The broker/web setup surface creates one-time pairing offers.',
  ),
  '/api/transport/pairings/{id}': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.brokerInternal,
    'Terminal setup polls one-time pairing status; '
    'the app accepts the offer directly.',
  ),
  '/api/transport/pairings/{id}/accept': _adopted,
  '/api/transport/session-control': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.deferred,
    'Encrypted session control follows envelope and scoped-token adoption.',
  ),
};

/// Declared Flutter-client disposition for every broker wire frame kind.
const Map<String, BrokerContractAdoption> brokerWireFrameAdoption = {
  'hello': _adopted,
  'session': _adopted,
  'history': _adopted,
  'history-page': _adopted,
  'message': _adopted,
  'commands': _adopted,
  'options': _adopted,
  'notice': _adopted,
  'draft': _adopted,
  'ended': _adopted,
  'error': _adopted,
  'ack': _adopted,
  'nack': _adopted,
  'attach-conflict': _adopted,
};

/// Declared Flutter-client disposition for every client-to-broker frame kind.
const Map<String, BrokerContractAdoption> brokerClientMessageAdoption = {
  'prompt': _adopted,
  'draft': _adopted,
  'history-page': _adopted,
  'plan-action': _adopted,
  'artifact-interaction': BrokerContractAdoption(
    BrokerContractAdoptionDisposition.deferred,
    'Typed durable transport exists; trusted WebView bridge is not yet wired.',
  ),
  'file': _adopted,
  'approve': _adopted,
  'answer': _adopted,
  'reject-question': _adopted,
  'command': _adopted,
  'set-agent': _adopted,
  'handoff': _adopted,
  'ack': _adopted,
  'nack': _adopted,
};
