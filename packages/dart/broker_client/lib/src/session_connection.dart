// Private fields cannot use `this.field` in named parameters.
// ignore_for_file: prefer_initializing_formals

import 'dart:async';
import 'dart:convert';

import 'package:broker_client/src/endpoint_resolver.dart';
import 'package:broker_client/src/websocket_adapter.dart';
import 'package:broker_contract/broker_contract.dart';

/// Connection state for a [SessionConnection].
enum SessionConnectionState {
  /// Not yet connected or fully disconnected.
  disconnected,

  /// WebSocket is being established.
  connecting,

  /// WebSocket is open and receiving frames.
  connected,

  /// Connection dropped, attempting to reconnect with backoff.
  reconnecting,

  /// Permanently closed.
  closed,
}

/// Pure-Dart session transport over the broker WebSocket.
///
/// Opens a WebSocket via [EndpointResolver.streamEndpoint], parses
/// incoming frames into typed [WireEvent]s, tracks session state, and
/// provides outbound methods for the current broker frame contract.
///
/// Supports reconnect with exponential backoff and stale-event
/// suppression via generation IDs.
///
/// No Flutter dependency — testable with [FakeWebSocketAdapter].
///
/// See `docs/architecture/monorepo.md`.
class SessionConnection {
  /// Creates a [SessionConnection].
  ///
  /// [resolver] provides the WebSocket URL.
  /// [adapterFactory] creates a [WebSocketAdapter]; defaults to the
  /// platform implementation. Tests pass [FakeWebSocketAdapter.new]
  /// to avoid a live broker.
  SessionConnection({
    required EndpointResolver resolver,
    required String tool,
    required String sessionId,
    String artifactMode = 'reference',
    String? mode,
    String? reason,
    SessionOwnerRevision? ownerRevision,
    int initialHistory = _defaultInitialHistory,
    WebSocketAdapter Function(String url)? adapterFactory,
  }) : _resolver = resolver,
       _tool = tool,
       _sessionId = sessionId,
       _artifactMode = artifactMode,
       _mode = mode,
       _reason = reason,
       _ownerRevision = ownerRevision,
       _initialHistory = initialHistory,
       _adapterFactory = adapterFactory ?? WebSocketAdapter.new;

  static const int _defaultInitialHistory = 100;

  final EndpointResolver _resolver;
  final String _tool;
  final String _sessionId;
  final String _artifactMode;
  final WebSocketAdapter Function(String url) _adapterFactory;
  final int _initialHistory;

  /// Control mode for the attach (`resume` to Drive, `live` to join an
  /// existing live owner, null to Observe). Mutated by [reattach] and applied
  /// on the next (re)connect's `streamEndpoint`.
  String? _mode;

  /// Drive-attach intent accompanying resume (`create`, `app-restore`,
  /// `lease-restore`, `join-existing`, or `takeover`).
  String? _reason;

  /// Owner revision accompanying a `join-existing` request only.
  SessionOwnerRevision? _ownerRevision;

  /// The current attach control mode (null = Observe).
  String? get mode => _mode;

  /// The current drive-attach reason (null = mode-only attach).
  String? get reason => _reason;

  /// Exact owner revision the current join-existing attach is conditional on.
  SessionOwnerRevision? get ownerRevision => _ownerRevision;

  WebSocketAdapter? _adapter;
  StreamSubscription<Object?>? _messageSub;
  Timer? _reconnectTimer;
  int _generation = 0;
  bool _disposed = false;
  bool _reconnectEnabled = true;

  // --- Backoff config ---
  static const _initialBackoff = Duration(seconds: 1);
  static const _maxBackoff = Duration(seconds: 30);
  int _backoffMultiplier = 1;

  // --- State ---
  final _stateController = StreamController<SessionConnectionState>.broadcast();
  final _eventController = StreamController<WireEvent>.broadcast();
  SessionConnectionState _state = SessionConnectionState.disconnected;

  // --- Session projection ---
  SessionInfo? _sessionInfo;
  final List<AgentMessage> _messages = [];
  List<SlashCommand> _commands = [];
  List<ModelOption> _models = [];
  List<AgentOption> _agents = [];
  List<ModeOption>? _modes;
  String? _cursor;
  String? _attachTicket;
  String? _olderCursor;
  bool _hasEarlier = false;
  HistoryGap? _lastHistoryGap;
  HelloWireEvent? _hello;
  int _clientMessageCounter = 0;

  // --- Public API ---

  /// Stream of connection state changes.
  Stream<SessionConnectionState> get stateStream => _stateController.stream;

  /// Current connection state.
  SessionConnectionState get state => _state;

  /// Stream of parsed [WireEvent]s from the broker.
  Stream<WireEvent> get events => _eventController.stream;

  /// The session info from the `session` frame.
  SessionInfo? get sessionInfo => _sessionInfo;

  /// All messages received so far (history + live).
  List<AgentMessage> get messages => List.unmodifiable(_messages);

  /// Available slash commands.
  List<SlashCommand> get commands => List.unmodifiable(_commands);

  /// Available model options.
  List<ModelOption> get models => List.unmodifiable(_models);

  /// Available agent options.
  List<AgentOption> get agents => List.unmodifiable(_agents);

  /// Available mode options.
  List<ModeOption>? get modes =>
      _modes == null ? null : List.unmodifiable(_modes!);

  /// The last opaque history cursor from the broker.
  String? get cursor => _cursor;

  /// Seeds a previously committed reconnect cursor before the first connect.
  ///
  /// The cursor is opaque broker state. It is accepted only while fully
  /// disconnected so an in-flight socket can never change identity.
  void seedCursor(String cursor) {
    if (_state != SessionConnectionState.disconnected) {
      throw StateError('History cursor can only be seeded while disconnected.');
    }
    final normalized = cursor.trim();
    if (normalized.isEmpty) {
      throw ArgumentError.value(cursor, 'cursor', 'Must not be empty.');
    }
    _cursor = normalized;
  }

  /// The last attach ticket issued by a history frame.
  String? get attachTicket => _attachTicket;

  /// Cursor for the next page before the attach tail/current page.
  String? get olderCursor => _olderCursor;

  /// Whether the broker advertises retained earlier transcript history.
  bool get hasEarlier => _hasEarlier;

  /// Last history cursor gap reported by the broker, if any.
  HistoryGap? get lastHistoryGap => _lastHistoryGap;

  /// Latest broker identity and compatibility negotiation frame.
  HelloWireEvent? get hello => _hello;

  /// Whether this connection must refuse mutating controls.
  bool get compatibilityReadOnly => _hello?.compatibility.readOnly ?? false;

  /// Opens the WebSocket connection and begins receiving frames.
  ///
  /// Subsequent calls while connecting/connected are no-ops.
  Future<void> connect() async {
    if (_state == SessionConnectionState.connecting ||
        _state == SessionConnectionState.connected) {
      return;
    }

    // Cancel any pending reconnect timer so it cannot
    // fire after we've started a fresh connection.
    _reconnectTimer?.cancel();
    _reconnectTimer = null;

    final gen = ++_generation;
    _reconnectEnabled = true;
    _backoffMultiplier = 1;
    _setState(SessionConnectionState.connecting);

    try {
      final url = _resolver.streamEndpoint(
        _tool,
        _sessionId,
        mode: _mode,
        reason: _reason,
        ownerRevision: _ownerRevision,
        ticket: _cursor,
        initialHistory: _initialHistory,
        artifactMode: _artifactMode,
      );
      _adapter = _adapterFactory(url);
      await _adapter!.connect();

      if (gen != _generation) return;
      _setState(SessionConnectionState.connected);

      _messageSub = _adapter!.messages.listen(
        (data) => _onMessage(data, gen),
        onError: (_) => _onDisconnect(gen),
        onDone: () => _onDisconnect(gen),
      );
      // Catching all exceptions during connect to trigger reconnect.
      // ignore: avoid_catches_without_on_clauses
    } catch (e) {
      if (gen != _generation) return;
      _onDisconnect(gen);
    }
  }

  // --- Outbound messages ---

  /// Sends a user prompt.
  ///
  /// The broker serializes prompts per-socket and spaces them ≥350ms.
  /// [draftRevision] is the shared draft revision this device had adopted, and
  /// [draftUpdateId] the token of a draft write it has not yet seen
  /// acknowledged, so the broker clears only the draft this send actually
  /// contained. Both are omitted against a legacy broker, which keeps its
  /// unconditional clear.
  String sendPrompt(
    String content, {
    SessionCurrentModel? model,
    List<PromptFileAttachment> files = const [],
    String? clientMessageId,
    int? draftRevision,
    String? draftUpdateId,
  }) {
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(
      OutboundFrame.prompt(
        content,
        model: model,
        files: files,
        clientMessageId: id,
        draftRevision: draftRevision,
        draftUpdateId: draftUpdateId,
      ),
    );
    return id;
  }

  /// Replaces the broker-relayed unsent draft for this session.
  ///
  /// [updateId]/[baseRevision] carry the DR1 idempotency and optimistic
  /// concurrency tokens; both are omitted against a legacy broker.
  void sendDraft(String text, {String? updateId, int? baseRevision}) {
    _sendFrame(
      OutboundFrame.draft(text, updateId: updateId, baseRevision: baseRevision),
    );
  }

  /// Requests an older transcript page and returns its correlation id.
  String requestHistoryPage({
    String? cursor,
    int? limit,
    String? clientMessageId,
  }) {
    final pageCursor = (cursor ?? _olderCursor)?.trim();
    if (pageCursor == null || pageCursor.isEmpty) {
      throw StateError('No earlier history cursor is available.');
    }
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(
      OutboundFrame.historyPage(
        cursor: pageCursor,
        limit: limit,
        clientMessageId: id,
      ),
    );
    return id;
  }

  /// Sends a semantic plan approve/revise/exit action.
  String sendPlanAction(
    PlanActionRequest request, {
    String? clientMessageId,
  }) {
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(OutboundFrame.planAction(request, clientMessageId: id));
    return id;
  }

  /// Sends one validated interaction from a sandboxed HTML artifact.
  String sendArtifactInteraction(
    ArtifactInteractionRequest request, {
    String? clientMessageId,
  }) {
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(
      OutboundFrame.artifactInteraction(request, clientMessageId: id),
    );
    return id;
  }

  /// Acknowledges one broker-issued attach ticket.
  void sendAck(String attachTicket, {String? clientMessageId}) {
    _sendFrame(
      OutboundFrame.ack(
        attachTicket: attachTicket,
        clientMessageId: clientMessageId,
      ),
    );
  }

  /// Negatively acknowledges one broker-issued attach ticket.
  void sendNack(String attachTicket, {String? clientMessageId}) {
    _sendFrame(
      OutboundFrame.nack(
        attachTicket: attachTicket,
        clientMessageId: clientMessageId,
      ),
    );
  }

  /// Sends a slash command.
  String sendCommand(
    String name, {
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? clientMessageId,
  }) {
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(
      OutboundFrame.command(
        name,
        args: args,
        model: model,
        clientMessageId: id,
      ),
    );
    return id;
  }

  /// Switches the session's active agent/mode (e.g. build/plan).
  ///
  /// [agent] must be one of the advertised [agents] names; the broker
  /// validates against the adapter's live roster and nacks anything else.
  String sendSetAgent(
    String agent, {
    String? clientMessageId,
  }) {
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(OutboundFrame.setAgent(agent, clientMessageId: id));
    return id;
  }

  /// Approves or rejects a permission request.
  String sendApprove(
    String requestId,
    String decision, {
    String? clientMessageId,
  }) {
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(
      OutboundFrame.approve(
        requestId,
        decision,
        clientMessageId: id,
      ),
    );
    return id;
  }

  /// Answers a question from the agent.
  ///
  /// [answers] is `string[][]`: one list per question in the request.
  String sendAnswer(
    String requestId,
    List<List<String>> answers, {
    String? clientMessageId,
  }) {
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(OutboundFrame.answer(requestId, answers, clientMessageId: id));
    return id;
  }

  /// Dismisses a question from the agent.
  String sendRejectQuestion(
    String requestId, {
    String? clientMessageId,
  }) {
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(OutboundFrame.rejectQuestion(requestId, clientMessageId: id));
    return id;
  }

  /// Sends a file to the session.
  ///
  /// The broker reads `msg.data` (not `content`).
  String sendFile({
    required String name,
    required String data,
    String? mimeType,
    String? clientMessageId,
  }) {
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(
      OutboundFrame.file(
        name: name,
        data: data,
        mimeType: mimeType,
        clientMessageId: id,
      ),
    );
    return id;
  }

  /// Requests terminal handoff on this exact Drive socket.
  String sendHandoff({String? clientMessageId}) {
    final id = _resolveClientMessageId(clientMessageId);
    _sendFrame(OutboundFrame.handoff(clientMessageId: id));
    return id;
  }

  /// Closes the connection.
  ///
  /// Set [reconnect] to `true` to allow automatic reconnect.
  Future<void> close({bool reconnect = false}) async {
    _reconnectEnabled = reconnect;
    // Invalidate every in-flight connect/disconnect continuation before the
    // adapter is torn down. Reattach starts a fresh generation in connect().
    _generation++;
    await _closeAdapter();
    _setState(SessionConnectionState.closed);
  }

  /// Re-attaches the stream under a new control [mode] — `resume` to Drive
  /// (Take over), `live` to join an existing live owner, or null to Observe
  /// (hand back). [reason] carries the
  /// drive-attach intent for a `resume` attach so the broker can arbitrate
  /// ownership atomically; [ownerRevision] qualifies `join-existing` only.
  /// Null keeps the legacy mode-only attach. Closes the current socket and
  /// reconnects; the fresh `connect()` bumps the generation so any late
  /// disconnect from the old socket is ignored. The history cursor is kept so
  /// the broker resumes from where we were.
  Future<void> reattach({
    String? mode,
    String? reason,
    SessionOwnerRevision? ownerRevision,
  }) async {
    if (_disposed) return;
    _mode = mode;
    _reason = reason;
    _ownerRevision = reason == 'join-existing' ? ownerRevision : null;
    await close();
    await connect();
  }

  /// Drops any requested control mode/reason without touching the socket, so
  /// the next (re)connect attaches as Observe. Called when an explicit
  /// authority request fails, times out, or loses its live owner — a later
  /// automatic reconnect must never silently retry it.
  void disarmDriveAuthority() {
    _mode = null;
    _reason = null;
    _ownerRevision = null;
  }

  /// Releases all resources. Cannot be reused after this.
  Future<void> dispose() async {
    _disposed = true;
    _reconnectEnabled = false;
    _generation++;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    await _closeAdapter();
    _setState(SessionConnectionState.closed);
    await _stateController.close();
    await _eventController.close();
  }

  // --- Internal ---

  void _setState(SessionConnectionState s) {
    _state = s;
    if (!_stateController.isClosed) {
      _stateController.add(s);
    }
  }

  void _sendFrame(Map<String, dynamic> frame) {
    final adapter = _adapter;
    if (adapter == null || !adapter.isConnected) {
      return;
    }
    adapter.sendJson(frame);
  }

  String _resolveClientMessageId(String? explicit) {
    if (explicit != null) {
      final trimmed = explicit.trim();
      if (!_isValidClientMessageId(trimmed)) {
        throw ArgumentError.value(
          explicit,
          'clientMessageId',
          'Must match [A-Za-z0-9._:-] and be at most 160 characters.',
        );
      }
      return trimmed;
    }
    return _nextClientMessageId();
  }

  String _nextClientMessageId() {
    final now = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
    final sequence = (_clientMessageCounter++).toRadixString(36);
    return 'ca.$now.$sequence';
  }

  static bool _isValidClientMessageId(String id) {
    return id.isNotEmpty &&
        id.length <= 160 &&
        RegExp(r'^[A-Za-z0-9._:-]+$').hasMatch(id);
  }

  Future<void> _closeAdapter() async {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    await _messageSub?.cancel();
    _messageSub = null;
    await _adapter?.close();
    _adapter = null;
  }

  void _onMessage(Object? data, int gen) {
    if (gen != _generation || _disposed) return;

    final Map<String, dynamic> json;
    if (data is Map<String, dynamic>) {
      json = data;
    } else if (data is String) {
      try {
        json = jsonDecode(data) as Map<String, dynamic>;
      } on FormatException {
        return;
      }
    } else {
      return;
    }

    final event = WireEvent.fromJson(json);
    _updateState(event);
    if (!_eventController.isClosed) {
      _eventController.add(event);
    }
  }

  void _updateState(WireEvent event) {
    switch (event) {
      case HelloWireEvent():
        _hello = event;
      case SessionWireEvent(:final info):
        _sessionInfo = info;
        final drive = info.control?.drive;
        final isDriving =
            (drive?.supported ?? false) && drive?.state == DriveState.driving;
        if (isDriving) {
          _reason = switch (_reason) {
            'create' => 'app-restore',
            'takeover' => 'lease-restore',
            final reason => reason,
          };
        }
      case HistoryWireEvent(
        :final messages,
        :final reset,
        :final cursor,
      ):
        if (reset) {
          _messages.clear();
        }
        _messages.addAll(messages);
        if (cursor != null) {
          _cursor = cursor;
        }
        _attachTicket = event.attachTicket ?? cursor ?? _attachTicket;
        _olderCursor = event.olderCursor;
        _hasEarlier = event.hasEarlier && event.olderCursor != null;
        _lastHistoryGap = event.gap;
      case HistoryPageWireEvent(
        :final messages,
        :final cursor,
        :final hasMore,
      ):
        _messages.insertAll(0, messages);
        _olderCursor = cursor;
        _hasEarlier = hasMore && cursor != null;
      case MessageWireEvent(:final message):
        _messages.add(message);
      case CommandsWireEvent(:final commands):
        _commands = commands;
      case OptionsWireEvent(
        :final models,
        :final agents,
        :final modes,
      ):
        _models = models;
        _agents = agents;
        _modes = modes;
      case EndedWireEvent():
        _reconnectEnabled = false;
        unawaited(_closeAdapter());
        _setState(SessionConnectionState.closed);
      case AttachConflictWireEvent():
        // Explicit create/takeover reasons are one-shot authority requests.
        // A denied attach continues as Observe and must never silently retry
        // the same authority request on a later transport reconnect.
        _mode = null;
        _reason = null;
        _ownerRevision = null;
      case ErrorWireEvent():
      case NoticeWireEvent():
      case UnknownWireEvent():
      case DraftWireEvent():
      case AckWireEvent():
      case NackWireEvent():
        // Ordinary frames carry no attach-authority answer; the requested
        // mode/reason must survive them so a mid-stream notice or ack cannot
        // demote the next reconnect to Observe.
        break;
    }
  }

  void _onDisconnect(int gen) {
    if (gen != _generation || _disposed) return;

    _messageSub?.cancel();
    _messageSub = null;
    _adapter = null;

    if (!_reconnectEnabled) {
      _setState(SessionConnectionState.closed);
      return;
    }

    _setState(SessionConnectionState.reconnecting);
    _scheduleReconnect(gen);
  }

  void _scheduleReconnect(int gen) {
    final delay = _initialBackoff * _backoffMultiplier;
    _reconnectTimer = Timer(delay, () async {
      // If a newer connect() or another reconnect already
      // bumped the generation, this timer is stale.
      if (gen != _generation || !_reconnectEnabled || _disposed) {
        return;
      }
      // Bump generation so events from any prior adapter
      // are suppressed by the gen check in _onMessage.
      final reconnectGen = ++_generation;

      try {
        final url = _resolver.streamEndpoint(
          _tool,
          _sessionId,
          mode: _mode,
          reason: _reason,
          ownerRevision: _ownerRevision,
          ticket: _cursor,
          initialHistory: _initialHistory,
          artifactMode: _artifactMode,
        );
        _adapter = _adapterFactory(url);
        await _adapter!.connect();

        if (reconnectGen != _generation) return;
        _setState(SessionConnectionState.connected);
        _backoffMultiplier = 1;

        _messageSub = _adapter!.messages.listen(
          (data) => _onMessage(data, reconnectGen),
          onError: (_) => _onDisconnect(reconnectGen),
          onDone: () => _onDisconnect(reconnectGen),
        );
        // Catching all exceptions during reconnect to retry.
        // ignore: avoid_catches_without_on_clauses
      } catch (e) {
        if (reconnectGen != _generation) return;
        _backoffMultiplier = (_backoffMultiplier * 2).clamp(
          1,
          _maxBackoff.inSeconds,
        );
        _scheduleReconnect(reconnectGen);
      }
    });
  }
}
