import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/foundation.dart';

/// Connection-local question authority, independent of retained transcript.
/// History restores content without revoking a live pending request.
///
/// It also says which cards a new connection no longer vouches for. After
/// its attach frame the broker replays every request still waiting, so a
/// card the window held when the last connection ended, and that the new
/// connection has not sent again since its attach frame, is no longer
/// waiting: it was answered or withdrawn while this client was away, though
/// no resolution reached it.
@immutable
final class SessionQuestionState {
  const SessionQuestionState._(
    this._pending,
    this.resolvedRequestIds, [
    this._carried = const {},
    this.withdrawnRequestIds = const {},
  ]);

  /// A new connection's authority before its attach frame: [carried] names
  /// the request ids of the cards the window held when the last one ended.
  factory SessionQuestionState.carrying(Set<String> carried) => carried.isEmpty
      ? empty
      : SessionQuestionState._(const {}, const {}, Set.unmodifiable(carried));

  /// No live question evidence in this connection epoch.
  static const empty = SessionQuestionState._({}, {});

  final Set<String> _pending;

  /// Settlements survive eviction too, so an older loaded card stays disabled.
  final Set<String> resolvedRequestIds;

  /// Cards held when the last connection ended, until this one's attach
  /// frame arrives.
  final Set<String> _carried;

  /// Cards carried from the last connection that this one has not sent again
  /// since its attach frame.
  final Set<String> withdrawnRequestIds;

  /// This authority once the connection's attach frame arrives: every card
  /// carried from the last connection is withdrawn until it is sent again.
  SessionQuestionState attached() => _carried.isEmpty
      ? this
      : _copyWith(carried: const {}, withdrawn: _carried);

  /// This authority with [withdrawn] withdrawn too: a reset's replacement
  /// keeps what the window it replaces learned from the attach.
  SessionQuestionState withdrawing(Set<String> withdrawn) =>
      withdrawn.isEmpty || withdrawnRequestIds.containsAll(withdrawn)
      ? this
      : _copyWith(withdrawn: {...withdrawnRequestIds, ...withdrawn});

  /// This authority after [message] arrived live: a request the broker sends
  /// is waiting on this connection, whatever the last one left.
  SessionQuestionState restated(AgentMessage message) {
    if (message.type != AgentMessageType.permissionRequest &&
        message.type != AgentMessageType.questionRequest) {
      return this;
    }
    final id = message.raw['requestId'];
    if (!withdrawnRequestIds.contains(id)) return this;
    return _copyWith(withdrawn: {...withdrawnRequestIds}..remove(id));
  }

  SessionQuestionState _copyWith({
    Set<String>? pending,
    Set<String>? resolved,
    Set<String>? carried,
    Set<String>? withdrawn,
  }) => SessionQuestionState._(
    pending == null ? _pending : Set.unmodifiable(pending),
    resolved == null ? resolvedRequestIds : Set.unmodifiable(resolved),
    carried == null ? _carried : Set.unmodifiable(carried),
    withdrawn == null ? withdrawnRequestIds : Set.unmodifiable(withdrawn),
  );

  /// Records live question authority or a settlement. Read-only copies carry
  /// content only; they must not change the authority learned from live events.
  SessionQuestionState applyMessage(AgentMessage message) {
    final id = message.raw['requestId'];
    if (id is! String || id.isEmpty) return this;
    if (message.type == AgentMessageType.questionResolved) {
      if (resolvedRequestIds.contains(id)) return this;
      return _copyWith(
        pending: {..._pending}..remove(id),
        resolved: {...resolvedRequestIds, id},
      );
    }
    if (message.type != AgentMessageType.questionRequest ||
        message.raw['blocking'] != false ||
        message.requestIsReadOnly ||
        _pending.contains(id) ||
        resolvedRequestIds.contains(id)) {
      return this;
    }
    return _copyWith(pending: {..._pending, id});
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
