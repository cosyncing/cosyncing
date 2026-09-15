import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/foundation.dart';

/// Connection-local question authority, independent of retained transcript.
/// History restores content without revoking a live pending request.
@immutable
final class SessionQuestionState {
  const SessionQuestionState._(this._pending, this.resolvedRequestIds);

  /// No live question evidence in this connection epoch.
  static const empty = SessionQuestionState._({}, {});

  final Set<String> _pending;

  /// Settlements survive eviction too, so an older loaded card stays disabled.
  final Set<String> resolvedRequestIds;

  /// Records live question authority or a settlement. Read-only copies carry
  /// content only; they must not change the authority learned from live events.
  SessionQuestionState applyMessage(AgentMessage message) {
    final id = message.raw['requestId'];
    if (id is! String || id.isEmpty) return this;
    if (message.type == AgentMessageType.questionResolved) {
      if (resolvedRequestIds.contains(id)) return this;
      return SessionQuestionState._(
        Set.unmodifiable({..._pending}..remove(id)),
        Set.unmodifiable({...resolvedRequestIds, id}),
      );
    }
    if (message.type != AgentMessageType.questionRequest ||
        message.raw['blocking'] != false ||
        message.requestIsReadOnly ||
        _pending.contains(id) ||
        resolvedRequestIds.contains(id)) {
      return this;
    }
    return SessionQuestionState._(
      Set.unmodifiable({..._pending, id}),
      resolvedRequestIds,
    );
  }

  /// Restores known authority when a history page or delta reloads a card.
  AgentMessage restoreMessage(AgentMessage message) {
    if (message.type != AgentMessageType.questionRequest) return message;
    final id = message.raw['requestId'];
    if (resolvedRequestIds.contains(id)) return _withReadOnly(message, true);
    if (_pending.contains(id)) return _withReadOnly(message, false);
    return message;
  }

  /// A protected browsing page can outlive a reconnect reset, but its old live
  /// authority cannot. The new connection must replay pending requests itself.
  static AgentMessage historicalMessage(AgentMessage message) =>
      message.type == AgentMessageType.questionRequest &&
          message.raw['blocking'] == false
      ? _withReadOnly(message, true)
      : message;

  static AgentMessage _withReadOnly(AgentMessage message, bool readOnly) {
    if (message.requestIsReadOnly == readOnly) return message;
    return AgentMessage(
      type: message.type,
      id: message.id,
      seq: message.seq,
      parentId: message.parentId,
      timestamp: message.timestamp,
      raw: {...message.raw, 'readOnly': readOnly},
    );
  }
}
