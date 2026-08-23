import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// App-facing connection states for the session detail shell.
enum SessionDetailConnectionStatus {
  /// Not attached.
  disconnected,

  /// Attach is in progress.
  connecting,

  /// The live stream is open.
  connected,

  /// The stream dropped and the transport is reconnecting.
  reconnecting,

  /// The connection was closed.
  closed,
}

/// App-facing live session connection boundary.
///
/// This keeps feature controllers testable without importing WebSocket
/// details. The production implementation delegates to the pure-Dart
/// broker client transport.
abstract interface class SessionDetailConnection {
  /// Current connection status.
  SessionDetailConnectionStatus get state;

  /// Connection status changes.
  Stream<SessionDetailConnectionStatus> get stateStream;

  /// Sanitized transport-setup failure suitable for the session error surface.
  String? get lastConnectionErrorMessage;

  /// Typed wire events from the broker.
  Stream<WireEvent> get events;

  /// Opens the live session stream.
  Future<void> connect();

  /// Closes the stream.
  Future<void> close({bool reconnect = false});

  /// Re-attaches under a new control mode — `resume` to Drive (Take over),
  /// `live` to join an adapter's existing live owner, or null to Observe.
  /// [reason] carries the
  /// drive-attach intent for a resume attach (`create`, `app-restore`,
  /// `lease-restore`, `join-existing`, or `takeover`); null keeps the legacy
  /// mode-only attach. [ownerRevision] is required only for `join-existing`.
  Future<void> reattach({
    String? mode,
    String? reason,
    bool readOnly = false,
    SessionOwnerRevision? ownerRevision,
  });

  /// Declares this socket read-only from its next (re)connect onward.
  void requireReadOnly();

  /// Whether this socket has declared itself read-only. Monotone once raised.
  bool get readOnly;

  /// Drops any pending control mode/reason so the next automatic reconnect
  /// attaches as Observe. Called when an explicit takeover fails, times out,
  /// or a live owner is demoted; it must never be silently retried.
  void disarmDriveAuthority();

  /// Requests terminal handoff from this exact Drive socket.
  Future<void> sendHandoff({String? clientMessageId});

  /// Sends a user prompt.
  ///
  /// [draftRevision] is the shared draft revision this device had adopted, and
  /// [draftUpdateId] the token of a draft write not yet acknowledged, so the
  /// broker's post-send clear covers this device's own draft and can never
  /// erase a newer one another device typed. Omitted against a legacy broker.
  ///
  /// [permissionMode] is the per-prompt approval mode the composer selected;
  /// omitted leaves the session's own mode alone.
  Future<void> sendPrompt(
    String text, {
    SessionCurrentModel? model,
    List<PromptFileAttachment> files = const [],
    String? clientMessageId,
    int? draftRevision,
    String? draftUpdateId,
    String? permissionMode,
  });

  /// Replaces the shared composer draft for this session.
  ///
  /// [updateId]/[baseRevision] carry the DR1 idempotency and optimistic
  /// concurrency tokens; both are omitted against a legacy broker.
  Future<void> sendDraft(String text, {String? updateId, int? baseRevision});

  /// Sends a semantic plan lifecycle action.
  Future<void> sendPlanAction(
    PlanActionRequest request, {
    String? clientMessageId,
  });

  /// Sends a structured interaction from a sandboxed HTML artifact.
  Future<void> sendArtifactInteraction(
    ArtifactInteractionRequest request, {
    String? clientMessageId,
  });

  /// Sends an attach-ticket acknowledgement.
  Future<void> sendAck(String attachTicket, {String? clientMessageId});

  /// Sends an attach-ticket negative acknowledgement.
  Future<void> sendNack(String attachTicket, {String? clientMessageId});

  /// Sends a slash command by name.
  Future<void> sendCommand(
    String name, {
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? clientMessageId,
  });

  /// Switches the session's active agent/mode (e.g. build/plan).
  Future<void> sendSetAgent(
    String agent, {
    String? clientMessageId,
  });

  /// Sends a permission decision.
  Future<void> sendPermissionDecision(
    String requestId,
    String decision, {
    String? clientMessageId,
  });

  /// Sends a question answer.
  Future<void> sendQuestionAnswer(
    String requestId,
    List<List<String>> answers, {
    String? clientMessageId,
  });

  /// Dismisses a question.
  Future<void> rejectQuestion(String requestId, {String? clientMessageId});

  /// Sends a base64-encoded file attachment to the session.
  Future<void> sendFile({
    required String name,
    required String data,
    String? mimeType,
    String? clientMessageId,
  });

  /// Releases connection resources.
  Future<void> dispose();
}

/// Optional transport capability for broker-backed backward history pages.
///
/// Kept separate from [SessionDetailConnection] so legacy/test transports can
/// remain attach-only and fail closed without fabricating pagination.
abstract interface class SessionHistoryConnection {
  /// Seeds a transactionally committed reconnect cursor before connecting.
  void seedHistoryCursor(String cursor);

  /// Requests the page before [cursor].
  Future<void> requestHistoryPage({
    required String cursor,
    int? limit,
    String? clientMessageId,
  });
}

/// Factory for creating a [SessionDetailConnection].
typedef SessionDetailConnectionFactory =
    SessionDetailConnection Function({
      required EndpointResolver resolver,
      required String tool,
      required String sessionId,
    });

/// Provides production live-session connections.
///
/// Tests override this with fake connections; no live broker is required.
final sessionDetailConnectionFactoryProvider =
    Provider<SessionDetailConnectionFactory>(
      (ref) {
        return ({required resolver, required sessionId, required tool}) {
          return BrokerSessionDetailConnection(
            resolver: resolver,
            tool: tool,
            sessionId: sessionId,
            adapterFactory: ref.read(sessionSocketAdapterFactoryProvider),
          );
        };
      },
    );

/// App-level adapter factory used by production session details.
final sessionSocketAdapterFactoryProvider =
    Provider<WebSocketAdapter Function(String url)>(
      (ref) => FlutterWebSocketAdapter.new,
    );

/// Production [SessionDetailConnection] backed by [SessionConnection].
class BrokerSessionDetailConnection
    implements SessionDetailConnection, SessionHistoryConnection {
  /// Creates a broker-backed session detail connection.
  BrokerSessionDetailConnection({
    required EndpointResolver resolver,
    required String tool,
    required String sessionId,
    WebSocketAdapter Function(String url)? adapterFactory,
  }) : _inner = SessionConnection(
         resolver: resolver,
         tool: tool,
         sessionId: sessionId,
         adapterFactory: adapterFactory ?? FlutterWebSocketAdapter.new,
       );

  final SessionConnection _inner;

  @override
  SessionDetailConnectionStatus get state => _mapState(_inner.state);

  @override
  Stream<SessionDetailConnectionStatus> get stateStream =>
      _inner.stateStream.map(_mapState);

  @override
  String? get lastConnectionErrorMessage {
    final error = _inner.lastConnectionError;
    if (error is BrokerException) return error.message;
    if (error is UnsupportedError) return error.message?.toString();
    if (error is TimeoutException) {
      return 'The broker authentication request timed out.';
    }
    return null;
  }

  @override
  Stream<WireEvent> get events => _inner.events;

  @override
  void seedHistoryCursor(String cursor) => _inner.seedCursor(cursor);

  @override
  Future<void> connect() => _inner.connect();

  @override
  Future<void> close({bool reconnect = false}) =>
      _inner.close(reconnect: reconnect);

  @override
  void requireReadOnly() => _inner.requireReadOnly();

  @override
  bool get readOnly => _inner.readOnly;

  @override
  Future<void> reattach({
    String? mode,
    String? reason,
    bool readOnly = false,
    SessionOwnerRevision? ownerRevision,
  }) => _inner.reattach(
    mode: mode,
    reason: reason,
    readOnly: readOnly,
    ownerRevision: ownerRevision,
  );

  @override
  void disarmDriveAuthority() => _inner.disarmDriveAuthority();

  @override
  Future<void> sendHandoff({String? clientMessageId}) async {
    _inner.sendHandoff(clientMessageId: clientMessageId);
  }

  @override
  Future<void> sendPrompt(
    String text, {
    SessionCurrentModel? model,
    List<PromptFileAttachment> files = const [],
    String? clientMessageId,
    int? draftRevision,
    String? draftUpdateId,
    String? permissionMode,
  }) async {
    _inner.sendPrompt(
      text,
      model: model,
      files: files,
      clientMessageId: clientMessageId,
      draftRevision: draftRevision,
      draftUpdateId: draftUpdateId,
      permissionMode: permissionMode,
    );
  }

  @override
  Future<void> sendDraft(
    String text, {
    String? updateId,
    int? baseRevision,
  }) async {
    _inner.sendDraft(text, updateId: updateId, baseRevision: baseRevision);
  }

  @override
  Future<void> requestHistoryPage({
    required String cursor,
    int? limit,
    String? clientMessageId,
  }) async {
    _inner.requestHistoryPage(
      cursor: cursor,
      limit: limit,
      clientMessageId: clientMessageId,
    );
  }

  @override
  Future<void> sendPlanAction(
    PlanActionRequest request, {
    String? clientMessageId,
  }) async {
    _inner.sendPlanAction(request, clientMessageId: clientMessageId);
  }

  @override
  Future<void> sendArtifactInteraction(
    ArtifactInteractionRequest request, {
    String? clientMessageId,
  }) async {
    _inner.sendArtifactInteraction(request, clientMessageId: clientMessageId);
  }

  @override
  Future<void> sendAck(
    String attachTicket, {
    String? clientMessageId,
  }) async {
    _inner.sendAck(attachTicket, clientMessageId: clientMessageId);
  }

  @override
  Future<void> sendNack(
    String attachTicket, {
    String? clientMessageId,
  }) async {
    _inner.sendNack(attachTicket, clientMessageId: clientMessageId);
  }

  @override
  Future<void> sendCommand(
    String name, {
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? clientMessageId,
  }) async {
    _inner.sendCommand(
      name,
      args: args,
      model: model,
      clientMessageId: clientMessageId,
    );
  }

  @override
  Future<void> sendSetAgent(
    String agent, {
    String? clientMessageId,
  }) async {
    _inner.sendSetAgent(agent, clientMessageId: clientMessageId);
  }

  @override
  Future<void> sendPermissionDecision(
    String requestId,
    String decision, {
    String? clientMessageId,
  }) async {
    _inner.sendApprove(requestId, decision, clientMessageId: clientMessageId);
  }

  @override
  Future<void> sendQuestionAnswer(
    String requestId,
    List<List<String>> answers, {
    String? clientMessageId,
  }) async {
    _inner.sendAnswer(requestId, answers, clientMessageId: clientMessageId);
  }

  @override
  Future<void> rejectQuestion(
    String requestId, {
    String? clientMessageId,
  }) async {
    _inner.sendRejectQuestion(requestId, clientMessageId: clientMessageId);
  }

  @override
  Future<void> sendFile({
    required String name,
    required String data,
    String? mimeType,
    String? clientMessageId,
  }) async {
    _inner.sendFile(
      name: name,
      data: data,
      mimeType: mimeType,
      clientMessageId: clientMessageId,
    );
  }

  @override
  Future<void> dispose() => _inner.dispose();

  static SessionDetailConnectionStatus _mapState(
    SessionConnectionState state,
  ) {
    return switch (state) {
      SessionConnectionState.disconnected =>
        SessionDetailConnectionStatus.disconnected,
      SessionConnectionState.connecting =>
        SessionDetailConnectionStatus.connecting,
      SessionConnectionState.connected =>
        SessionDetailConnectionStatus.connected,
      SessionConnectionState.reconnecting =>
        SessionDetailConnectionStatus.reconnecting,
      SessionConnectionState.closed => SessionDetailConnectionStatus.closed,
    };
  }
}
