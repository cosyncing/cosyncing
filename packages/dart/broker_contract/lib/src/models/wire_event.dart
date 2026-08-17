import 'package:broker_contract/src/models/agent_message.dart';
import 'package:broker_contract/src/models/contract_identity.dart';
import 'package:broker_contract/src/models/session_info.dart';
import 'package:broker_contract/src/models/stream_models.dart';

/// Discriminated union of all wire events the broker currently sends.
///
/// The broker sends JSON frames over WebSocket with a `kind` field
/// identifying the event type. This class parses all current kinds
/// and tolerates unknown kinds gracefully.
///
/// See `docs/protocol/contract-sync.md`.
sealed class WireEvent {
  const WireEvent();

  /// Parse a JSON map into a typed [WireEvent].
  ///
  /// Returns [UnknownWireEvent] for unrecognized `kind` values
  /// or for known kinds whose payload is malformed and cannot
  /// be decoded. Never throws on broker-supplied JSON.
  factory WireEvent.fromJson(Map<String, dynamic> json) {
    final kind = json['kind'] as String?;
    try {
      switch (kind) {
        case 'hello':
          return HelloWireEvent.fromJson(json);
        case 'session':
          return SessionWireEvent.fromJson(json);
        case 'history':
          return HistoryWireEvent.fromJson(json);
        case 'history-page':
          return HistoryPageWireEvent.fromJson(json);
        case 'message':
          return MessageWireEvent.fromJson(json);
        case 'commands':
          return CommandsWireEvent.fromJson(json);
        case 'options':
          return OptionsWireEvent.fromJson(json);
        case 'notice':
          return NoticeWireEvent.fromJson(json);
        case 'draft':
          return DraftWireEvent.fromJson(json);
        case 'ended':
          return EndedWireEvent.fromJson(json);
        case 'error':
          return ErrorWireEvent.fromJson(json);
        case 'ack':
          return AckWireEvent.fromJson(json);
        case 'nack':
          return NackWireEvent.fromJson(json);
        case 'attach-conflict':
          return AttachConflictWireEvent.fromJson(json);
        default:
          return UnknownWireEvent(kind: kind, raw: json);
      }
      // Catching all exceptions to prevent malformed broker
      // frames from crashing the transport layer.
      // ignore: avoid_catches_without_on_clauses
    } catch (e) {
      // A known kind with a malformed payload should not crash
      // the transport. Surface it as unknown so the client can
      // continue processing subsequent frames.
      return UnknownWireEvent(kind: kind, raw: json);
    }
  }

  Map<String, dynamic> toJson();
}

/// First frame sent by a BPC13 broker before session attachment.
class HelloWireEvent extends WireEvent {
  /// Creates a broker/client compatibility hello.
  const HelloWireEvent({
    required this.brokerVersion,
    required this.brokerContract,
    required this.compatibility,
    this.clientVersion,
  });

  /// Decodes the hello frame.
  factory HelloWireEvent.fromJson(Map<String, dynamic> json) {
    final broker = json['broker'];
    final compatibility = json['compatibility'];
    if (broker is! Map<Object?, Object?> ||
        compatibility is! Map<Object?, Object?>) {
      throw const FormatException(
        'hello broker and compatibility are required',
      );
    }
    final brokerJson = Map<String, dynamic>.from(broker);
    final contract = brokerJson['contract'];
    if (contract is! Map<Object?, Object?>) {
      throw const FormatException('hello broker contract is required');
    }
    return HelloWireEvent(
      brokerVersion: brokerJson['version'] as String? ?? 'unknown',
      brokerContract: BrokerContractIdentity.fromJson(
        Map<String, dynamic>.from(contract),
      ),
      clientVersion: json['clientVersion'] as String?,
      compatibility: BrokerClientCompatibility.fromJson(
        Map<String, dynamic>.from(compatibility),
      ),
    );
  }

  /// Broker semantic version.
  final String brokerVersion;

  /// Broker contract identity.
  final BrokerContractIdentity brokerContract;

  /// Client version echoed by the broker.
  final String? clientVersion;

  /// Negotiated compatibility decision.
  final BrokerClientCompatibility compatibility;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'hello',
    'broker': {
      'version': brokerVersion,
      'contract': brokerContract.toJson(),
    },
    if (clientVersion != null) 'clientVersion': clientVersion,
    'compatibility': compatibility.toJson(),
  };
}

/// `{ kind: 'session', info: SessionInfo }` — the first frame on attach.
class SessionWireEvent extends WireEvent {
  const SessionWireEvent({
    required this.info,
    this.authority,
    this.joinExisting,
  });

  factory SessionWireEvent.fromJson(Map<String, dynamic> json) {
    final authority = json['authority'];
    final joinExisting = json['joinExisting'];
    return SessionWireEvent(
      info: SessionInfo.fromJson(json['info'] as Map<String, dynamic>),
      authority: authority is Map<Object?, Object?>
          ? SessionConnectionAuthority.fromJson(
              Map<String, dynamic>.from(authority),
            )
          : null,
      joinExisting: joinExisting is Map<Object?, Object?>
          ? SessionJoinExistingAction.fromJson(
              Map<String, dynamic>.from(joinExisting),
            )
          : null,
    );
  }

  final SessionInfo info;

  /// Broker-derived authority of this Session Detail socket.
  final SessionConnectionAuthority? authority;

  /// Authenticated action metadata for joining an existing Drive owner.
  final SessionJoinExistingAction? joinExisting;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'session',
    'info': info.toJson(),
    if (authority != null) 'authority': authority!.toJson(),
    if (joinExisting != null) 'joinExisting': joinExisting!.toJson(),
  };
}

/// `{ kind: 'history', messages, reset?, cursor? }` — durable history replay.
///
/// When [reset] is `true`, the client should replace its local durable
/// transcript for this session before applying [messages].
///
/// [cursor] is an opaque broker cursor for reconnect deltas.
class HistoryWireEvent extends WireEvent {
  const HistoryWireEvent({
    required this.messages,
    this.reset = false,
    this.cursor,
    this.attachTicket,
    this.olderCursor,
    this.hasEarlier = false,
    this.gap,
    this.truncated,
  });

  factory HistoryWireEvent.fromJson(Map<String, dynamic> json) {
    final messagesJson = json['messages'] as List<dynamic>? ?? [];
    final gapJson = json['gap'];
    final truncatedJson = json['truncated'];
    return HistoryWireEvent(
      messages: messagesJson
          .map((e) => AgentMessage.fromJson(e as Map<String, dynamic>))
          .toList(),
      reset: json['reset'] as bool? ?? false,
      cursor: json['cursor'] as String?,
      attachTicket: json['attachTicket'] as String?,
      olderCursor: json['olderCursor'] as String?,
      hasEarlier: json['hasEarlier'] as bool? ?? false,
      gap: gapJson is Map<String, dynamic>
          ? HistoryGap.fromJson(gapJson)
          : null,
      truncated: truncatedJson is Map<String, dynamic>
          ? HistoryTruncation.fromJson(truncatedJson)
          : null,
    );
  }

  final List<AgentMessage> messages;

  /// If `true`, replace local durable transcript before applying [messages].
  final bool reset;

  /// Opaque broker cursor for reconnect deltas.
  final String? cursor;

  /// Attach ticket the client can ack/nack back to the broker for delivery
  /// bookkeeping. Currently the broker reuses the history [cursor] as the
  /// ticket. Optional for older brokers that do not issue one.
  final String? attachTicket;

  /// Opaque cursor for the page immediately before this attach tail.
  final String? olderCursor;

  /// Whether the broker retained older transcript messages.
  final bool hasEarlier;

  /// Gap metadata when the broker could not serve an incremental replay and
  /// sent a full replay fallback instead.
  final HistoryGap? gap;

  /// Honest tail-window metadata when the broker capped a large history.
  final HistoryTruncation? truncated;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'history',
    'messages': messages.map((m) => m.toJson()).toList(),
    if (reset) 'reset': true,
    if (cursor != null) 'cursor': cursor,
    if (attachTicket != null) 'attachTicket': attachTicket,
    if (olderCursor != null) 'olderCursor': olderCursor,
    if (hasEarlier) 'hasEarlier': true,
    if (gap != null) 'gap': gap!.toJson(),
    if (truncated != null) 'truncated': truncated!.toJson(),
  };
}

/// A chronological page of transcript messages older than the attach tail.
class HistoryPageWireEvent extends WireEvent {
  /// Creates a history page.
  const HistoryPageWireEvent({
    required this.messages,
    required this.hasMore,
    required this.endOfHistory,
    this.cursor,
    this.clientMessageId,
  });

  /// Decodes a broker history page.
  factory HistoryPageWireEvent.fromJson(Map<String, dynamic> json) {
    final rawMessages = json['messages'];
    if (rawMessages is! List) {
      throw const FormatException('history-page messages must be a list');
    }
    return HistoryPageWireEvent(
      messages: rawMessages
          .map((value) {
            if (value is! Map<Object?, Object?>) {
              throw const FormatException(
                'history-page messages must contain objects',
              );
            }
            return AgentMessage.fromJson(Map<String, dynamic>.from(value));
          })
          .toList(growable: false),
      cursor: json['cursor'] as String?,
      hasMore: json['hasMore'] as bool? ?? false,
      endOfHistory: json['endOfHistory'] as bool? ?? false,
      clientMessageId: json['clientMessageId'] as String?,
    );
  }

  /// Messages in normal chronological order.
  final List<AgentMessage> messages;

  /// Cursor for the next older page.
  final String? cursor;

  /// Whether another older page exists.
  final bool hasMore;

  /// Whether the retained beginning of history has been reached.
  final bool endOfHistory;

  /// Optional request correlation id.
  final String? clientMessageId;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'history-page',
    'messages': messages.map((message) => message.toJson()).toList(),
    if (cursor != null) 'cursor': cursor,
    'hasMore': hasMore,
    'endOfHistory': endOfHistory,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
  };
}

/// History replay gap metadata from the broker.
class HistoryGap {
  const HistoryGap({
    required this.code,
    required this.message,
    this.reason,
  });

  factory HistoryGap.fromJson(Map<String, dynamic> json) {
    return HistoryGap(
      code: json['code'] as String? ?? '',
      message: json['message'] as String? ?? '',
      reason: json['reason'] as String?,
    );
  }

  /// Stable broker gap code, such as `HISTORY_CURSOR_GONE`.
  final String code;

  /// Human-readable gap detail.
  final String message;

  /// Optional machine/debug reason.
  final String? reason;

  Map<String, dynamic> toJson() => {
    'code': code,
    if (reason != null) 'reason': reason,
    'message': message,
  };
}

/// Metadata for a broker-capped history replay.
class HistoryTruncation {
  const HistoryTruncation({required this.shown, required this.total});

  factory HistoryTruncation.fromJson(Map<String, dynamic> json) {
    return HistoryTruncation(
      shown: _nonNegativeInt(json['shown']),
      total: _nonNegativeInt(json['total']),
    );
  }

  /// Number of newest transcript messages included in this replay.
  final int shown;

  /// Total transcript messages represented by the broker snapshot.
  final int total;

  Map<String, dynamic> toJson() => {'shown': shown, 'total': total};
}

int _nonNegativeInt(Object? value) {
  if (value is! num || !value.isFinite) return 0;
  final integer = value.toInt();
  return integer < 0 ? 0 : integer;
}

/// `{ kind: 'message', seq, message }` — a single message frame.
///
/// Replay frames use `seq: 0`; live frames have incrementing seq values.
class MessageWireEvent extends WireEvent {
  const MessageWireEvent({required this.seq, required this.message});

  factory MessageWireEvent.fromJson(Map<String, dynamic> json) {
    return MessageWireEvent(
      seq: (json['seq'] as num?)?.toInt() ?? 0,
      message: AgentMessage.fromJson(json['message'] as Map<String, dynamic>),
    );
  }

  /// Sequence number. `0` for replay/derived frames.
  final int seq;

  final AgentMessage message;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'message',
    'seq': seq,
    'message': message.toJson(),
  };
}

/// `{ kind: 'commands', commands: [...] }` — available slash commands.
class CommandsWireEvent extends WireEvent {
  const CommandsWireEvent({required this.commands});

  factory CommandsWireEvent.fromJson(Map<String, dynamic> json) {
    final commandsJson = json['commands'] as List<dynamic>? ?? [];
    return CommandsWireEvent(
      commands: commandsJson
          .map((e) => SlashCommand.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  final List<SlashCommand> commands;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'commands',
    'commands': commands.map((c) => c.toJson()).toList(),
  };
}

/// `{ kind: 'options', models, agents, modes? }` — available session options.
class OptionsWireEvent extends WireEvent {
  const OptionsWireEvent({
    required this.models,
    required this.agents,
    this.modes,
  });

  factory OptionsWireEvent.fromJson(Map<String, dynamic> json) {
    final modelsJson = json['models'] as List<dynamic>? ?? [];
    final agentsJson = json['agents'] as List<dynamic>? ?? [];
    final modesJson = json['modes'] as List<dynamic>?;
    return OptionsWireEvent(
      models: modelsJson
          .map((e) => ModelOption.fromJson(e as Map<String, dynamic>))
          .toList(),
      agents: agentsJson
          .map((e) => AgentOption.fromJson(e as Map<String, dynamic>))
          .toList(),
      modes: modesJson
          ?.map((e) => ModeOption.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  final List<ModelOption> models;
  final List<AgentOption> agents;
  final List<ModeOption>? modes;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'options',
    'models': models.map((m) => m.toJson()).toList(),
    'agents': agents.map((a) => a.toJson()).toList(),
    if (modes != null) 'modes': modes!.map((m) => m.toJson()).toList(),
  };
}

/// `{ kind: 'notice', message }` — informational notice from the broker.
class NoticeWireEvent extends WireEvent {
  const NoticeWireEvent({required this.message});

  factory NoticeWireEvent.fromJson(Map<String, dynamic> json) {
    return NoticeWireEvent(
      message: json['message'] as String? ?? '',
    );
  }

  final String message;

  @override
  Map<String, dynamic> toJson() => {'kind': 'notice', 'message': message};
}

/// `{ kind: 'ended', reason? }` — session has ended.
class EndedWireEvent extends WireEvent {
  const EndedWireEvent({this.reason});

  factory EndedWireEvent.fromJson(Map<String, dynamic> json) {
    return EndedWireEvent(
      reason: json['reason'] as String?,
    );
  }

  final String? reason;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'ended',
    if (reason != null) 'reason': reason,
  };
}

/// `{ kind: 'error', message }` — error from the broker.
class ErrorWireEvent extends WireEvent {
  const ErrorWireEvent({required this.message});

  factory ErrorWireEvent.fromJson(Map<String, dynamic> json) {
    return ErrorWireEvent(
      message: json['message'] as String? ?? '',
    );
  }

  final String message;

  @override
  Map<String, dynamic> toJson() => {'kind': 'error', 'message': message};
}

/// `{ kind: 'draft', text, at, revision?, updateId? }` — shared unsent
/// composer draft sync.
///
/// Broadcast to every attached client on change and replayed to late joiners
/// so multi-client (phone/desktop/web) composers agree.
///
/// DR1: a broker at contract revision ≥ 3 versions every draft. [revision] is
/// the broker-assigned per-session monotone version; [updateId] echoes the
/// accepted mutation's idempotency token so the writer recognizes its own
/// update. Both are null for a legacy broker, which keeps last-writer-wins.
class DraftWireEvent extends WireEvent {
  const DraftWireEvent({
    required this.text,
    required this.at,
    this.revision,
    this.updateId,
  });

  factory DraftWireEvent.fromJson(Map<String, dynamic> json) {
    return DraftWireEvent(
      text: json['text'] as String? ?? '',
      at: (json['at'] as num?)?.toInt() ?? 0,
      revision: (json['revision'] as num?)?.toInt(),
      updateId: json['updateId'] as String?,
    );
  }

  /// The shared draft text (empty means the draft was cleared).
  final String text;

  /// Epoch milliseconds of the last write. Diagnostic only — versioned
  /// clients order by [revision], never by this wall clock.
  final int at;

  /// Broker-assigned per-session monotone draft version, or null when the
  /// broker predates durable versioned drafts (contract revision < 3).
  final int? revision;

  /// Idempotency token of the accepted update that produced this state, when
  /// the writer supplied one.
  final String? updateId;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'draft',
    'text': text,
    'at': at,
    if (revision != null) 'revision': revision,
    if (updateId != null) 'updateId': updateId,
  };
}

/// `{ kind: 'ack', ack, attachTicket?, clientMessageId?, ... }`
/// - a broker->client delivery / client-message acknowledgement.
///
/// [ackKind] is the receipt category:
/// - `'ack'` / `'nack'`: the broker acknowledging a client's ack/nack of an
///   attach ticket (delivery bookkeeping).
/// - `'client-message'`: the broker accepted and processed a mutating client
///   message identified by [clientMessageId].
class AckWireEvent extends WireEvent {
  const AckWireEvent({
    required this.ackKind,
    this.attachTicket,
    this.clientMessageId,
    this.duplicate = false,
    this.pending = false,
    this.draftCleared = true,
    this.draftRevision,
  });

  factory AckWireEvent.fromJson(Map<String, dynamic> json) {
    return AckWireEvent(
      ackKind: json['ack'] as String? ?? '',
      attachTicket: json['attachTicket'] as String?,
      clientMessageId: json['clientMessageId'] as String?,
      duplicate: json['duplicate'] as bool? ?? false,
      pending: json['pending'] as bool? ?? false,
      // Absent means "cleared" — a legacy broker never reports a failure, and
      // the historical behavior was to treat the handoff as complete.
      draftCleared: json['draftCleared'] as bool? ?? true,
      draftRevision: (json['draftRevision'] as num?)?.toInt(),
    );
  }

  /// The receipt category: `'ack'`, `'nack'`, or `'client-message'`.
  final String ackKind;

  /// Attach ticket the receipt refers to (for ack/nack receipts).
  final String? attachTicket;

  /// Client message id the ack refers to (for `client-message` acks).
  final String? clientMessageId;

  /// True when the broker already recorded this client message id (dedupe).
  final bool duplicate;

  /// True when the prior result for this id is still in flight.
  final bool pending;

  /// Whether an accepted prompt's shared draft was durably cleared (DR1).
  ///
  /// False means the prompt itself succeeded but the shared draft still holds
  /// the sent text, so the sender must keep its associated local row and retry
  /// the clear rather than completing the handoff. Defaults to true, which is
  /// what a broker predating the field implies.
  final bool draftCleared;

  /// Shared draft revision an uncleared draft was left at, sent only alongside
  /// `draftCleared: false`.
  ///
  /// The retry must be conditional on this exact revision. The sender cannot
  /// derive it: its own pre-send draft write may have moved the shared record
  /// past the revision the prompt reported.
  final int? draftRevision;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'ack',
    'ack': ackKind,
    if (attachTicket != null) 'attachTicket': attachTicket,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
    if (duplicate) 'duplicate': true,
    if (pending) 'pending': true,
    if (!draftCleared) 'draftCleared': false,
    if (!draftCleared && draftRevision != null) 'draftRevision': draftRevision,
  };
}

/// `{ kind: 'nack', code, message, attachTicket?, clientMessageId? }` - a
/// broker->client negative acknowledgement.
///
/// Sent when a client ack/nack references an unknown attach ticket, or when a
/// mutating client message (identified by [clientMessageId]) failed. [code]
/// is a stable broker error code (see `brokerErrorCodes`) such as
/// `ACK_UNKNOWN_TARGET`, `BAD_CLIENT_MESSAGE_ID`, or `CLIENT_MESSAGE_FAILED`.
class NackWireEvent extends WireEvent {
  const NackWireEvent({
    required this.code,
    required this.message,
    this.attachTicket,
    this.clientMessageId,
  });

  factory NackWireEvent.fromJson(Map<String, dynamic> json) {
    return NackWireEvent(
      code: json['code'] as String? ?? '',
      message: json['message'] as String? ?? '',
      attachTicket: json['attachTicket'] as String?,
      clientMessageId: json['clientMessageId'] as String?,
    );
  }

  /// Stable error code (see `brokerErrorCodes`).
  final String code;

  /// Human-readable failure detail.
  final String message;

  /// Attach ticket the nack refers to, when applicable.
  final String? attachTicket;

  /// Client message id the nack refers to, when applicable.
  final String? clientMessageId;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'nack',
    'code': code,
    'message': message,
    if (attachTicket != null) 'attachTicket': attachTicket,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
  };
}

/// `{ kind: 'attach-conflict', requestedMode, reason, code, message }` — the
/// broker's structured answer to a reason-tagged DRIVE attach it denied.
///
/// [requestedMode] names the mode that was actually asked for: `resume`, or
/// `live` for a takeover of a session whose Drive lives on the live key. A
/// client reading this frame to decide what to retry must use that value
/// rather than assume resume.
///
/// The socket stays open and continues as an Observe-class attach; this frame
/// tells the client the machine reason so it can keep its local Drive
/// provenance and surface an honest state instead of a generic failure. Never
/// sent for a mode-only attach.
class AttachConflictWireEvent extends WireEvent {
  /// Creates a structured drive-attach conflict.
  const AttachConflictWireEvent({
    required this.requestedMode,
    required this.reason,
    required this.code,
    required this.message,
  });

  /// Decodes the conflict frame.
  factory AttachConflictWireEvent.fromJson(Map<String, dynamic> json) {
    return AttachConflictWireEvent(
      requestedMode: json['requestedMode'] as String? ?? '',
      reason: json['reason'] as String? ?? '',
      code: json['code'] as String? ?? '',
      message: json['message'] as String? ?? '',
    );
  }

  /// The attach mode the client requested (currently always `resume`).
  final String requestedMode;

  /// The drive-attach reason the client sent (`create`, `app-restore`,
  /// `lease-restore`, or `takeover`).
  final String reason;

  /// Stable broker code: `DRIVE_OWNERSHIP_CONFLICT` when ownership facts deny
  /// the restore, `DRIVE_OWNERSHIP_UNKNOWN` when daemon ownership cannot be
  /// verified, `DRIVE_NATIVE_SESSION_UNRESUMABLE` when the native runtime
  /// rejects resume, or `DRIVE_RESTORE_FAILED` for another attach failure.
  final String code;

  /// Human-readable conflict detail from the broker/adapter.
  final String message;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'attach-conflict',
    'requestedMode': requestedMode,
    'reason': reason,
    'code': code,
    'message': message,
  };
}

/// An unrecognized wire event kind.
///
/// Preserved so the client does not crash on new broker frame types.
class UnknownWireEvent extends WireEvent {
  const UnknownWireEvent({this.kind, this.raw = const {}});

  final String? kind;
  final Map<String, dynamic> raw;

  @override
  Map<String, dynamic> toJson() => Map<String, dynamic>.of(raw);
}
