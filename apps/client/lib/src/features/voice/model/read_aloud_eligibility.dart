import 'package:broker_contract/broker_contract.dart';

/// Resolves the stable read-aloud identity for a [message].
///
/// Returns the trimmed `modelOutputKey`, falling back to the trimmed
/// `AgentMessage.id`. Returns null when neither exists, in which case the
/// read-aloud action is hidden rather than inventing an unstable key.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Contract dependency" - stable identity).
String? resolveReadAloudIdentity(AgentMessage message) {
  final key = message.modelOutputKey?.trim();
  if (key != null && key.isNotEmpty) return key;
  final id = message.id?.trim();
  if (id != null && id.isNotEmpty) return id;
  return null;
}

/// Whether [message] is eligible for the read-aloud action.
///
/// Requires [AgentMessageType.modelOutput], final `model-output` with non-empty
/// text ([AgentMessageModelOutput.isReadAloudEligible]), and a resolvable
/// stable identity ([resolveReadAloudIdentity]).
bool isReadAloudEligible(AgentMessage message) {
  if (message.type != AgentMessageType.modelOutput) return false;
  if (!message.isReadAloudEligible) return false;
  return resolveReadAloudIdentity(message) != null;
}

/// Returns the set of indices that are the newest eligible read-aloud frame
/// for their resolved identity.
///
/// When multiple final `model-output` frames share the same identity (e.g.
/// a replayed history frame), only the last one should expose the read-aloud
/// action. Frames with different identities each expose their own action.
/// Ineligible frames never suppress eligible ones.
Set<int> newestEligibleIndices(List<AgentMessage> messages) {
  final latestByIdentity = <String, int>{};
  for (var i = 0; i < messages.length; i++) {
    final message = messages[i];
    if (!isReadAloudEligible(message)) continue;
    final identity = resolveReadAloudIdentity(message)!;
    latestByIdentity[identity] = i;
  }
  return latestByIdentity.values.toSet();
}
