// A wire-level, in-process broker for client feature tests.
//
// The app's REAL broker clients run against it: `BrokerClient` (REST over
// Dio), the health and auth probes, the pairing accept request and
// `SessionConnection` (stream tickets + WebSocket frames). It plugs in through
// the two production transport seams, `brokerHttpTransportProvider` and
// `sessionSocketAdapterFactoryProvider`, so every request crosses the same
// JSON/HTTP boundary a real broker sees.
//
// Every request lands in a ledger (`requests`), every socket in `sockets`.
// Fault hooks: unreachable hosts, held responses released by the test,
// one-shot status/body overrides, and pairing acceptance tampering.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart' as crypto;
import 'package:cosyncing_client/src/features/connection/data/broker_http_transport.dart';
import 'package:dio/dio.dart';

/// Text planted in transport failures. Tests assert it never reaches a
/// user-facing surface outside an explicit "Technical details" disclosure.
const String rawLeakSentinel = 'RAW-LEAK-SENTINEL';

/// Owner-token header the broker reads.
const String ownerTokenHeader = 'x-cosyncing-token';

/// Paired-device (peer) token header the broker reads.
const String peerTokenHeader = 'x-cosyncing-peer-token';

/// One HTTP request the app sent.
class FakeBrokerRequest {
  FakeBrokerRequest({
    required this.method,
    required this.uri,
    required this.headers,
    required this.body,
  });

  /// HTTP method, upper case.
  final String method;

  /// Full request URI.
  final Uri uri;

  /// Request headers, lower-cased names.
  final Map<String, String> headers;

  /// Decoded JSON body, when there was one.
  final Object? body;

  /// Whether the app cancelled the request while it was in flight (a long
  /// poll abandoned because the app went to the background, say).
  bool cancelled = false;

  /// The status the broker answered with, once it has answered.
  int? answered;

  /// URI path.
  String get path => uri.path;

  /// The owner token the request carried, if any.
  String? get ownerToken => headers[ownerTokenHeader];

  /// The paired-device token the request carried, if any.
  String? get peerToken => headers[peerTokenHeader];

  /// Whether the request carried no credential at all.
  bool get anonymous => ownerToken == null && peerToken == null;

  @override
  String toString() => '$method ${uri.path}${uri.hasQuery ? '?…' : ''}';
}

/// A canned response.
class FakeBrokerResponse {
  const FakeBrokerResponse(this.status, [this.body, this.headers = const {}])
    : rawText = null;

  /// A plain-text (non-JSON) body, byte for byte: a signed file download.
  const FakeBrokerResponse.text(
    this.status,
    String this.rawText, [
    this.headers = const {},
  ]) : body = null;

  /// Broker error body in the shape the real broker emits.
  factory FakeBrokerResponse.error(int status, String code, String message) =>
      FakeBrokerResponse(status, {'error': message, 'code': code});

  /// HTTP status code.
  final int status;

  /// JSON-encodable body.
  final Object? body;

  /// A body served as plain text instead of JSON.
  final String? rawText;

  /// Extra response headers.
  final Map<String, String> headers;
}

/// A request matcher used by holds and one-shot overrides.
typedef FakeRequestMatcher = bool Function(FakeBrokerRequest request);

/// Holds matching requests until the test releases them.
///
/// Models a slow broker answer: the request is in flight (the app shows its
/// busy state) and the test decides when, and with what, it lands.
class FakeHold {
  FakeHold._();

  final _waiting = <Completer<FakeBrokerResponse?>>[];
  var _released = false;

  /// How many matching requests have arrived at this hold.
  int arrivals = 0;

  /// Requests currently parked.
  int get pending => _waiting.length;

  /// Lets every parked request through and ends the hold.
  ///
  /// With [response] the parked requests are answered with it; otherwise the
  /// broker answers them as it normally would at release time. Later requests
  /// are not held.
  void release([FakeBrokerResponse? response]) {
    _released = true;
    for (final waiter in _waiting) {
      waiter.complete(response);
    }
    _waiting.clear();
  }

  Future<FakeBrokerResponse?> _park() {
    arrivals += 1;
    final waiter = Completer<FakeBrokerResponse?>();
    _waiting.add(waiter);
    return waiter.future;
  }
}

/// One-time QR transport pairing offer issued by a [FakeBroker].
class FakePairingOffer {
  FakePairingOffer._({
    required this.pairingId,
    required this.qr,
  });

  /// One-use pairing id.
  final String pairingId;

  /// `cosyncing://pair?payload=…` exactly as the broker prints it.
  final String qr;

  /// Accept requests this offer received.
  int acceptCalls = 0;

  /// Whether the broker accepted it.
  bool accepted = false;
}

/// An agent entry for `GET /api/agents`.
AgentInfo fakeAgent({
  String id = 'codex',
  String displayName = 'Codex',
  bool canCreateSession = true,
  bool canSelectModelAtCreation = false,
  bool canSelectPermissionModeAtCreation = false,
  bool canFork = false,
  bool canClone = false,
  bool canTranscriptExport = false,
  bool canRenameNative = false,
  bool supportsNativeFileInput = false,
}) => AgentInfo(
  id: id,
  displayName: displayName,
  capabilities: AgentCapabilities(
    integrationKind: IntegrationKind.jsonrpcStdio,
    attachModes: const [AttachMode.resume],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: false,
    supportsNativeArtifact: false,
    supportsNativeFileInput: supportsNativeFileInput,
    supportsModelSwitch: true,
    permissionGranularity: PermissionGranularity.perSession,
  ),
  canCreateSession: canCreateSession,
  canSelectModelAtCreation: canSelectModelAtCreation,
  canSelectPermissionModeAtCreation: canSelectPermissionModeAtCreation,
  canRenameNative: canRenameNative,
  canFork: canFork,
  canClone: canClone,
  canTranscriptExport: canTranscriptExport,
);

/// A set of fake brokers addressed by `scheme://host:port`.
///
/// Hosts with no broker behave like an address nothing listens on: the
/// connection fails before any HTTP status.
class FakeBrokerNetwork {
  final _brokers = <String, FakeBroker>{};

  /// Every request the app sent, to any address.
  final List<FakeBrokerRequest> requests = [];

  /// Every socket the app opened, to any address.
  final List<FakeBrokerSocket> sockets = [];

  var _clientsOpened = 0;
  var _clientsClosed = 0;

  /// Upper bound on requests per test: a client that re-requests in a tight
  /// loop fails loudly here instead of hanging the test.
  int requestBudget = 2000;

  /// Registers a broker at [baseUrl].
  ///
  /// [ownerToken] turns on the broker's auth gate (default-deny except
  /// `/api/health` and pairing acceptance), like a broker started with a
  /// configured token. Without it, every route answers anonymously, like the
  /// loopback development baseline.
  FakeBroker add(
    String baseUrl, {
    String machine = 'studio',
    String? ownerToken,
  }) {
    final broker = FakeBroker._(
      this,
      Uri.parse(baseUrl),
      machine: machine,
      ownerToken: ownerToken,
    );
    _brokers[_authority(broker.baseUri)] = broker;
    return broker;
  }

  /// The broker serving [uri], if any.
  FakeBroker? brokerFor(Uri uri) => _brokers[_authority(uri)];

  /// HTTP transport for `brokerHttpTransportProvider`.
  BrokerHttpTransport get transport =>
      () => _FakeBrokerHttpAdapter(this);

  /// WebSocket factory for `sessionSocketAdapterFactoryProvider`.
  WebSocketAdapter Function(String url) get socketFactory => (url) {
    final socket = FakeBrokerSocket._(this, Uri.parse(url));
    sockets.add(socket);
    return socket;
  };

  /// HTTP clients (Dio instances) the app built and has not closed.
  int get openHttpClients => _clientsOpened - _clientsClosed;

  static String _authority(Uri uri) {
    final scheme = switch (uri.scheme) {
      'ws' => 'http',
      'wss' => 'https',
      final other => other,
    };
    return '$scheme://${uri.host.toLowerCase()}:${uri.port}';
  }
}

/// One fake broker.
class FakeBroker {
  FakeBroker._(
    this.network,
    this.baseUri, {
    required this.machine,
    required this.ownerToken,
  });

  /// Network this broker is registered on.
  final FakeBrokerNetwork network;

  /// Base URL clients use.
  final Uri baseUri;

  /// Host name reported in health answers.
  String machine;

  /// Owner (shared) token; null means auth is not enforced.
  String? ownerToken;

  /// Paired-device tokens this broker accepts.
  final Set<String> peerTokens = {};

  /// When false, every connection to this broker fails before HTTP.
  bool reachable = true;

  /// What `/api/health` reports as `ok`.
  bool healthy = true;

  /// Broker contract revision advertised on health.
  int contractRevision = cosyncingClientContractRevision;

  /// Sessions served by `GET /api/sessions`.
  final List<Map<String, Object?>> sessions = [];

  /// Roster revision served with [sessions].
  int rosterRevision = 1;

  /// What `complete` says on roster answers: false models a broker that
  /// answered ahead of a still-running discovery sweep.
  bool rosterComplete = true;

  /// Roster delta journal: one entry per published change.
  final List<Map<String, Object?>> _journal = [];

  /// Long polls waiting for the next roster change.
  final List<Completer<void>> _deltaWaiters = [];

  /// When true, the next delta poll is answered `resetRequired`.
  bool resetNextDeltaPoll = false;

  /// When set, the delta route answers with this status (404 = an old broker
  /// without the feed) instead of long-polling.
  int? deltaFeedStatus;

  static const _windows = <String, Duration?>{
    '1d': Duration(days: 1),
    '7d': Duration(days: 7),
    '1m': Duration(days: 30),
    'all': null,
  };

  List<Map<String, Object?>> _inWindow(String? window) {
    final span = _windows[window ?? 'all'];
    if (span == null) return List.of(sessions);
    final cutoff = DateTime.now().subtract(span).millisecondsSinceEpoch;
    return [
      for (final row in sessions)
        if (((row['updatedAt'] as num?) ?? 0) >= cutoff) row,
    ];
  }

  /// The roster answer this broker would give right now for [window],
  /// frozen: release a held request with it later to deliver a stale answer.
  FakeBrokerResponse rosterAnswer({String? window}) => FakeBrokerResponse(
    200,
    {
      'sessions': _inWindow(window),
      'machine': machine,
      'revision': rosterRevision,
      'generatedAt': 0,
      'complete': rosterComplete,
    },
    {'etag': '"roster-$rosterRevision-${window ?? 'all'}"'},
  );

  /// Adds a session, last active just now unless [updatedAt] says otherwise.
  ///
  /// The change is journaled for the delta feed and wakes waiting polls.
  void addSession(
    String id,
    String title, {
    String tool = 'codex',
    SessionStatus status = SessionStatus.idle,
    String? cwd,
    String? projectName,
    DateTime? updatedAt,
    String? origin,
    String? parentThreadId,
    String? nativeId,
    AttachMode attachMode = AttachMode.live,
    Map<String, Object?> extra = const {},
  }) {
    final at = (updatedAt ?? DateTime.now()).millisecondsSinceEpoch;
    upsertSession({
      ...SessionInfo(
        id: id,
        tool: tool,
        title: title,
        status: status,
        attachMode: attachMode,
        cwd: cwd ?? '/work/$machine',
        projectName: projectName,
        createdAt: at,
        updatedAt: at,
        nativeId: nativeId,
        parentThreadId: parentThreadId,
      ).toJson(),
      'origin': ?origin,
      ...extra,
    });
  }

  /// Inserts or replaces a session row (by tool and id), bumps the roster
  /// revision, journals the change and wakes waiting delta polls.
  void upsertSession(Map<String, Object?> row) {
    final index = sessions.indexWhere(
      (s) => s['id'] == row['id'] && s['tool'] == row['tool'],
    );
    if (index >= 0) {
      sessions[index] = row;
    } else {
      sessions.add(row);
    }
    rosterRevision += 1;
    _journal.add({
      'revision': rosterRevision,
      'machine': machine,
      'tool': row['tool'],
      'sessionId': row['id'],
      'changedFields': const <String>[],
      'session': row,
    });
    _wakeDeltaWaiters();
  }

  /// Changes fields of an existing session row (a status flip, a new
  /// `updatedAt`) and publishes it like any broker-side change.
  void updateSession(String id, Map<String, Object?> fields) {
    final row = sessions.firstWhere((s) => s['id'] == id);
    upsertSession({...row, ...fields});
  }

  /// Removes a session and publishes the removal.
  void removeSession(String id) {
    final index = sessions.indexWhere((s) => s['id'] == id);
    final row = sessions.removeAt(index);
    rosterRevision += 1;
    _journal.add({
      'revision': rosterRevision,
      'machine': machine,
      'tool': row['tool'],
      'sessionId': id,
      'changedFields': const <String>[],
      'removed': true,
    });
    _wakeDeltaWaiters();
  }

  /// The broker restarted: its journal and revision numbering start over at
  /// [revision] with exactly [rows]. The next delta poll says `resetRequired`.
  void restartRoster({
    required int revision,
    List<Map<String, Object?>> rows = const [],
  }) {
    sessions
      ..clear()
      ..addAll(rows);
    rosterRevision = revision;
    _journal.clear();
    resetNextDeltaPoll = true;
    _wakeDeltaWaiters();
  }

  /// Bumps the roster revision with no content change.
  void bumpRosterRevision() {
    rosterRevision += 1;
    _wakeDeltaWaiters();
  }

  /// Wakes every parked roster long poll so it re-evaluates.
  void _wakeDeltaWaiters() {
    for (final waiter in List.of(_deltaWaiters)) {
      if (!waiter.isCompleted) waiter.complete();
    }
    _deltaWaiters.clear();
  }

  // --- agents and session creation ------------------------------------------

  /// Agents `GET /api/agents` lists; null serves one creatable Codex.
  List<AgentInfo>? agents;

  /// Model catalogs by tool (`GET /api/agents/:tool/models`).
  final Map<String, List<ModelOption>> modelCatalogs = {};

  /// Permission-mode catalogs by tool (`GET /api/agents/:tool/modes`).
  final Map<String, List<ModeOption>> modeCatalogs = {};

  /// Transcript messages replayed on attach, by session id.
  final Map<String, List<Map<String, Object?>>> transcripts = {};

  /// Frames a socket sends right after it connects to a session, in order.
  /// Null sends the standard hello, session and history frames.
  List<Map<String, Object?>> Function(
    FakeBrokerSocket socket,
    Map<String, Object?> session,
  )?
  attachFrames;

  /// When false, session sockets cannot be opened (the stream is down while
  /// the REST API answers).
  bool socketsAccepted = true;

  /// Params the app bound into each stream ticket request, newest last.
  final List<Map<String, Object?>> ticketRequests = [];

  /// Stream tickets issued, by ticket: what was bound into each and the
  /// credential it was issued to. A real broker authorizes exactly this.
  final Map<String, ({Map<String, String> params, String? credential})>
  _tickets = {};

  var _ticketsIssued = 0;

  /// The `control` block served in the session frame of the standard attach,
  /// by session id. Sessions without an entry are Driving.
  final Map<String, Map<String, Object?>> controls = {};

  /// Called for every frame the app sends on a session socket, after it is
  /// recorded in [FakeBrokerSocket.sent]. The place for the broker's answer
  /// (an `ack`, a `nack`, a handoff confirmation).
  void Function(FakeBrokerSocket socket, Map<String, dynamic> frame)? onFrame;

  /// Makes the socket write of a frame fail (the app's send throws and the
  /// frame never reaches the broker) when this returns true.
  bool Function(FakeBrokerSocket socket, Map<String, dynamic> frame)? failFrame;

  /// Session sockets the app opened to this broker for session [id], oldest
  /// first.
  List<FakeBrokerSocket> socketsFor(String id) => [
    for (final socket in network.sockets)
      if (identical(socket.broker, this) && socket.attachTarget?.$2 == id)
        socket,
  ];

  var _created = 0;

  /// The agents the broker lists.
  List<AgentInfo> get agentList => agents ?? [fakeAgent()];

  /// Standard hello frame for this broker.
  Map<String, Object?> helloFrame() => {
    'kind': 'hello',
    'broker': {'version': '0.7.0', 'contract': _contract},
    'compatibility': {
      'status': 'compatible',
      'readOnly': false,
      'reason': 'compatible',
      'broker': _contract,
    },
  };

  /// Control block of a session this app drives, with no terminal in play.
  static const Map<String, Object?> drivingControl = {
    'drive': {'state': 'driving', 'supported': true},
    'terminalSync': {
      'supported': false,
      'syncAvailable': false,
      'active': false,
    },
  };

  List<Map<String, Object?>> _standardAttach(
    FakeBrokerSocket socket,
    Map<String, Object?> session,
  ) => [
    helloFrame(),
    {
      'kind': 'session',
      'info': {
        ...session,
        'control': controls[session['id']] ?? drivingControl,
      },
    },
    {
      'kind': 'history',
      'messages': transcripts[session['id']] ?? const <Object?>[],
      'cursor': 'cursor-1',
    },
  ];

  /// Requests the app sent to this broker's address, including attempts
  /// refused while it was unreachable.
  final List<FakeBrokerRequest> requests = [];

  /// Files served on `GET <path>` without credentials (a signed download
  /// URL carries its own authority), by absolute path. Every request is still
  /// recorded in [requests].
  final Map<String, FakeBrokerResponse> files = {};

  final _holds = <(FakeRequestMatcher, FakeHold)>[];
  final _overrides = <(FakeRequestMatcher, FakeBrokerResponse)>[];

  /// Requests to [path] (exact path match), optionally by [method].
  List<FakeBrokerRequest> requestsTo(String path, {String? method}) => [
    for (final request in requests)
      if (request.path == path && (method == null || request.method == method))
        request,
  ];

  /// Extra routes, tried in order after authentication and before the
  /// built-in ones: return null to pass. The place for a feature's own
  /// stateful REST surface (scheduled sends).
  final List<Future<FakeBrokerResponse?> Function(FakeBrokerRequest request)>
  routes = [];

  /// Holds every request matching [method] and [path] until released.
  FakeHold hold(String method, String path) =>
      holdWhere((r) => r.method == method && r.path == path);

  /// Holds every request matching [matches] until released.
  FakeHold holdWhere(FakeRequestMatcher matches) {
    final hold = FakeHold._();
    _holds.add((matches, hold));
    return hold;
  }

  /// Answers the next request matching [method] and [path] with [response].
  void respondNext(String method, String path, FakeBrokerResponse response) =>
      _overrides.add((
        (r) => r.method == method && r.path == path,
        response,
      ));

  final _lostAnswers = <FakeRequestMatcher>[];

  /// Answers the next request satisfying [matches] with [response].
  void respondNextWhere(
    FakeRequestMatcher matches,
    FakeBrokerResponse response,
  ) => _overrides.add((matches, response));

  /// The broker fully handles the next request matching [method] and [path],
  /// then the connection drops before its answer reaches the app: the
  /// ambiguous failure a one-use request must never retry.
  void loseNextAnswer(String method, String path) =>
      _lostAnswers.add((r) => r.method == method && r.path == path);

  bool _takeLostAnswer(FakeBrokerRequest request) {
    for (final matches in List.of(_lostAnswers)) {
      if (matches(request)) {
        _lostAnswers.remove(matches);
        return true;
      }
    }
    return false;
  }

  // --- pairing ------------------------------------------------------------

  crypto.IdentityKeyPair? _identity;
  final _offers = <String, FakePairingOffer>{};
  var _offerCount = 0;

  /// Broker peer id the accept answer claims; null uses the QR's broker id.
  String? acceptBrokerPeerIdOverride;

  /// Broker identity key the accept answer claims; null uses the real one.
  String? acceptIdentityOverride;

  /// Signs acceptance proofs with a different key (a forged answer).
  bool forgeAcceptanceSignature = false;

  /// Broker id committed in this broker's QR payloads.
  String get brokerId => 'broker-$machine';

  /// Issues a one-time QR pairing offer.
  ///
  /// [includeUrl] false gives the URL-free v3 code the CLI prints for a broker
  /// that cannot know its client-reachable address (v1/v2 always carry one).
  Future<FakePairingOffer> issuePairingOffer({
    int version = 3,
    bool includeUrl = true,
  }) async {
    final identity = _identity ??=
        await crypto.PairingCrypto.generateIdentityKeyPair();
    final pairingId = 'pair-${++_offerCount}';
    final payload = <String, Object?>{
      'version': version,
      'brokerId': brokerId,
      'publicKey': identity.publicKey,
      // v3 names the broker URL transport; v1/v2 carried a Tailnet address.
      'transport': {
        'kind': version == 3 ? 'broker-url' : 'tailscale-direct',
        if (includeUrl || version < 3) 'url': baseUri.toString(),
      },
      if (version >= 2) 'pairingId': pairingId,
    };
    final qr =
        'cosyncing://pair?payload='
        '${crypto.base64UrlNoPadding(utf8.encode(jsonEncode(payload)))}';
    final offer = FakePairingOffer._(pairingId: pairingId, qr: qr);
    _offers[pairingId] = offer;
    return offer;
  }

  Future<FakeBrokerResponse> _acceptPairing(
    String pairingId,
    Map<String, dynamic> body,
  ) async {
    final offer = _offers[pairingId];
    if (offer == null) {
      return FakeBrokerResponse.error(
        404,
        'PAIRING_NOT_FOUND',
        'Pairing not found',
      );
    }
    offer.acceptCalls += 1;
    if (offer.accepted) {
      return FakeBrokerResponse.error(
        409,
        'PAIRING_ALREADY_ACCEPTED',
        'Pairing already accepted',
      );
    }
    final identity = _identity!;
    final peerId = body['peerId'] as String;
    final exchangePublicKey = body['exchangePublicKey'] as String;
    final identityPublicKey = body['identityPublicKey'] as String;
    final wrapped = await crypto.PairingCrypto.wrapDataKeyForPeer(
      dataKey: List<int>.generate(32, (i) => i + 1),
      recipientPublicKey: exchangePublicKey,
    );
    final brokerPeerToken = 'peer-token-${offer.pairingId}';
    final brokerPeerId = acceptBrokerPeerIdOverride ?? brokerId;
    final brokerIdentity = acceptIdentityOverride ?? identity.publicKey;
    final signingKey = forgeAcceptanceSignature
        ? (await crypto.PairingCrypto.generateIdentityKeyPair()).privateKey
        : identity.privateKey;
    final signature = await crypto.PairingCrypto.signIdentityMessage(
      privateKey: signingKey,
      message: crypto.PairingCrypto.pairingAcceptanceProofBytes(
        pairingId: pairingId,
        clientPeerId: peerId,
        clientIdentityPublicKey: identityPublicKey,
        clientExchangePublicKey: exchangePublicKey,
        brokerPeerId: brokerPeerId,
        brokerPeerToken: brokerPeerToken,
        brokerIdentityPublicKey: brokerIdentity,
        wrappedDataKey: wrapped,
      ),
    );
    offer.accepted = true;
    peerTokens.add(brokerPeerToken);
    return FakeBrokerResponse(200, {
      'ok': true,
      'peer': {
        'peerId': peerId,
        'label': 'Phone',
        'identityPublicKey': identityPublicKey,
      },
      'broker': {
        'peerId': brokerPeerId,
        'peerToken': brokerPeerToken,
        'identityPublicKey': brokerIdentity,
      },
      'wrappedDataKey': {
        'version': wrapped.version,
        'algorithm': wrapped.algorithm,
        'ephemeralPublicKey': wrapped.ephemeralPublicKey,
        'nonce': wrapped.nonce,
        'ciphertext': wrapped.ciphertext,
        'tag': wrapped.tag,
      },
      'brokerProof': {
        'version': 1,
        'algorithm': 'Ed25519',
        'signature': signature,
      },
    });
  }

  // --- request handling ---------------------------------------------------

  Map<String, Object?> get _contract => {
    'revision': contractRevision,
    'minimumClientRevision': cosyncingClientMinimumBrokerRevision,
    'surfaceHash': cosyncingClientContractSurfaceHash,
  };

  /// Which principal [request] authenticates as, or null when refused.
  String? _principal(FakeBrokerRequest request) {
    final peer = request.peerToken;
    if (peer != null) return peerTokens.contains(peer) ? 'peer' : null;
    final owner = request.ownerToken;
    if (owner != null) {
      if (ownerToken == null) return 'anonymous';
      return owner == ownerToken ? 'owner' : null;
    }
    return ownerToken == null ? 'anonymous' : null;
  }

  Future<FakeBrokerResponse> _handle(FakeBrokerRequest request) async {
    for (final entry in List.of(_holds)) {
      final (matches, hold) = entry;
      if (hold._released) {
        // A released hold is over: later requests flow normally and a
        // newer hold on the same route takes effect.
        _holds.remove(entry);
        continue;
      }
      if (!matches(request)) continue;
      final released = await hold._park();
      if (released != null) return released;
      break;
    }
    for (final entry in List.of(_overrides)) {
      if (entry.$1(request)) {
        _overrides.remove(entry);
        return entry.$2;
      }
    }

    final path = request.path;
    final file = request.method == 'GET' ? files[path] : null;
    if (file != null) return file;
    if (request.method == 'GET' && path == '/api/health') {
      return FakeBrokerResponse(200, {
        'ok': healthy,
        'product': 'cosyncing',
        'version': '0.7.0',
        'machine': machine,
        'contract': _contract,
      });
    }
    final accept = RegExp(
      r'^/api/transport/pairings/([^/]+)/accept$',
    ).firstMatch(path);
    if (request.method == 'POST' && accept != null) {
      return _acceptPairing(
        Uri.decodeComponent(accept.group(1)!),
        (request.body! as Map).cast<String, dynamic>(),
      );
    }

    final principal = _principal(request);
    if (principal == null) {
      return FakeBrokerResponse.error(
        401,
        'AUTH_REQUIRED',
        'Unauthorized: broker credential required',
      );
    }

    for (final route in routes) {
      final answer = await route(request);
      if (answer != null) return answer;
    }

    switch ((request.method, path)) {
      case ('GET', '/api/broker/health'):
        return FakeBrokerResponse(200, {
          'ok': true,
          'status': 'healthy',
          'checkedAt': 0,
          'machine': machine,
          'principal': {
            'kind': principal,
            'roles': principal == 'peer' ? ['peer'] : ['owner'],
          },
        });
      case ('GET', '/api/sessions'):
        final window = request.uri.queryParameters['window'];
        final etag = '"roster-$rosterRevision-${window ?? 'all'}"';
        if (request.headers['if-none-match'] == etag &&
            request.uri.queryParameters['refresh'] != '1') {
          return FakeBrokerResponse(304, null, {'etag': etag});
        }
        return rosterAnswer(window: window);
      case ('GET', '/api/agents'):
        return FakeBrokerResponse(200, [
          for (final agent in agentList) agent.toJson(),
        ]);
      case ('POST', '/api/ws-auth-tickets'):
        if (request.body is Map) {
          ticketRequests.add((request.body! as Map).cast<String, Object?>());
        }
        final ticket = 'ticket-${++_ticketsIssued}';
        final bound = request.body is Map
            ? (((request.body! as Map)['params'] as Map?) ??
                  const <String, Object?>{})
            : const <String, Object?>{};
        _tickets[ticket] = (
          params: {for (final e in bound.entries) '${e.key}': '${e.value}'},
          credential: request.ownerToken ?? request.peerToken,
        );
        return FakeBrokerResponse(200, {'wsAuthTicket': ticket});
      case ('GET', '/api/session-roster-deltas'):
        return _deltaPoll(request);
      case ('GET', '/api/schedules'):
        // No scheduled sends. (F04 grows this into a real schedule store.)
        return const FakeBrokerResponse(200, {
          'ok': true,
          'schedules': <Object?>[],
        });
      case ('PATCH', '/api/projects/rename'):
        final body = (request.body! as Map).cast<String, Object?>();
        final cwd = body['cwd']! as String;
        final name = body['name'] as String?;
        for (final row in List.of(sessions)) {
          if (row['cwd'] == cwd) upsertSession({...row, 'projectName': name});
        }
        return FakeBrokerResponse(200, {
          'ok': true,
          'cwd': cwd,
          'projectName': name,
        });
      case ('GET', '/api/attention-events'):
        return _attentionPoll(request);
    }
    final models = RegExp(r'^/api/agents/([^/]+)/models$').firstMatch(path);
    if (request.method == 'GET' && models != null) {
      final tool = Uri.decodeComponent(models.group(1)!);
      return FakeBrokerResponse(200, {
        'tool': tool,
        'models': [
          for (final model in modelCatalogs[tool] ?? const <ModelOption>[])
            model.toJson(),
        ],
        'refreshedAt': 1,
      });
    }
    final modes = RegExp(r'^/api/agents/([^/]+)/modes$').firstMatch(path);
    if (request.method == 'GET' && modes != null) {
      final tool = Uri.decodeComponent(modes.group(1)!);
      return FakeBrokerResponse(200, {
        'tool': tool,
        'modes': [
          for (final mode in modeCatalogs[tool] ?? const <ModeOption>[])
            mode.toJson(),
        ],
        'refreshedAt': 1,
      });
    }
    final rename = RegExp(
      r'^/api/sessions/([^/]+)/([^/]+)/rename$',
    ).firstMatch(path);
    if (request.method == 'PATCH' && rename != null) {
      final id = Uri.decodeComponent(rename.group(2)!);
      final title = ((request.body as Map?)?['title'] as String?) ?? '';
      updateSession(id, {'title': title});
      return FakeBrokerResponse(200, {
        'ok': true,
        'title': title,
        'session': sessions.firstWhere((s) => s['id'] == id),
      });
    }
    if (request.method == 'DELETE' &&
        RegExp(r'^/api/sessions/[^/]+/[^/]+/cache$').hasMatch(path)) {
      return const FakeBrokerResponse(200, {'ok': true, 'clearedArtifacts': 0});
    }
    final branch = RegExp(
      r'^/api/sessions/([^/]+)/([^/]+)/(fork|clone)$',
    ).firstMatch(path);
    if (request.method == 'POST' && branch != null) {
      final tool = Uri.decodeComponent(branch.group(1)!);
      final source = Uri.decodeComponent(branch.group(2)!);
      final kind = branch.group(3)!;
      final origin = sessions.firstWhere((s) => s['id'] == source);
      final id = '$kind-of-$source';
      addSession(
        id,
        '${origin['title']} ($kind)',
        tool: tool,
        cwd: origin['cwd'] as String?,
        attachMode: AttachMode.resume,
      );
      return FakeBrokerResponse(200, {'ok': true, 'session': sessions.last});
    }
    final create = RegExp(r'^/api/sessions/([^/]+)$').firstMatch(path);
    if (request.method == 'POST' && create != null) {
      final tool = Uri.decodeComponent(create.group(1)!);
      final body = (request.body as Map?)?.cast<String, Object?>() ?? {};
      final id = 'created-${++_created}';
      addSession(
        id,
        (body['title'] as String?) ?? '',
        tool: tool,
        cwd: body['directory'] as String?,
        attachMode: AttachMode.resume,
      );
      return FakeBrokerResponse(200, {
        'session': sessions.last,
        'attachMode': 'resume',
      });
    }
    return FakeBrokerResponse.error(404, 'NOT_FOUND', 'Not found: $path');
  }

  // --- attention feed -------------------------------------------------------

  /// Durable attention events, oldest first (cursor = position).
  final List<Map<String, Object?>> attentionEvents = [];

  final List<Completer<void>> _attentionWaiters = [];

  /// Publishes an attention event for [agent]/[sessionId] and wakes the
  /// app's long poll. [kind] is the broker kind (`run-finished` by default).
  Map<String, Object?> publishAttention({
    String kind = 'run-finished',
    String agent = 'codex',
    String? sessionId,
    String title = 'Run finished',
  }) {
    final cursor = attentionEvents.length + 1;
    final now = DateTime.now().millisecondsSinceEpoch;
    final event = <String, Object?>{
      'id': 'attn-$cursor',
      'cursor': cursor,
      'revision': 1,
      'presentationRevision': 1,
      'kind': kind,
      'state': 'active',
      'severity': 'informational',
      'dedupeKey': '$kind:$agent:$sessionId:$cursor',
      'createdAt': now,
      'updatedAt': now,
      'agent': agent,
      'sessionId': ?sessionId,
      'title': title,
      'action': {
        'kind': sessionId == null ? 'open-attention-inbox' : 'open-session',
        if (sessionId != null) 'tool': agent,
        'sessionId': ?sessionId,
      },
    };
    attentionEvents.add(event);
    for (final waiter in List.of(_attentionWaiters)) {
      if (!waiter.isCompleted) waiter.complete();
    }
    _attentionWaiters.clear();
    return event;
  }

  /// `GET /api/attention-events`: a page after `after`; with `waitMs` it
  /// parks until something is published.
  Future<FakeBrokerResponse> _attentionPoll(FakeBrokerRequest request) async {
    final params = request.uri.queryParameters;
    final after = int.tryParse(params['after'] ?? '') ?? 0;
    final wait = (int.tryParse(params['waitMs'] ?? '') ?? 0) > 0;
    while (true) {
      final events = [
        for (final event in attentionEvents)
          if ((event['cursor']! as int) > after) event,
      ];
      if (events.isNotEmpty || !wait) {
        return FakeBrokerResponse(200, {
          'events': events,
          'cursor': events.isEmpty ? after : events.last['cursor'],
          'hasMore': false,
        });
      }
      final waiter = Completer<void>();
      _attentionWaiters.add(waiter);
      await waiter.future;
    }
  }

  /// `GET /api/session-roster-deltas`: answers at once when the journal has
  /// changes after `after`, otherwise parks until the roster changes.
  Future<FakeBrokerResponse> _deltaPoll(FakeBrokerRequest request) async {
    final status = deltaFeedStatus;
    if (status != null) {
      return FakeBrokerResponse.error(status, 'NOT_FOUND', 'no delta feed');
    }
    final after = int.tryParse(request.uri.queryParameters['after'] ?? '') ?? 0;
    while (true) {
      if (resetNextDeltaPoll) {
        resetNextDeltaPoll = false;
        return FakeBrokerResponse(200, {
          'revision': rosterRevision,
          'deltas': const <Object?>[],
          'resetRequired': true,
        });
      }
      if (rosterRevision > after) {
        return FakeBrokerResponse(200, {
          'revision': rosterRevision,
          'deltas': [
            for (final delta in _journal)
              if ((delta['revision']! as int) > after) delta,
          ],
        });
      }
      final waiter = Completer<void>();
      _deltaWaiters.add(waiter);
      await waiter.future;
    }
  }
}

/// A fake broker WebSocket. The app's real `SessionConnection` drives it.
class FakeBrokerSocket implements WebSocketAdapter {
  FakeBrokerSocket._(this.network, this.url);

  /// Network the socket was opened on.
  final FakeBrokerNetwork network;

  /// URL the app asked for.
  final Uri url;

  final _inbound = StreamController<Object?>.broadcast();
  var _connected = false;
  var _closed = false;

  /// Frames the app sent, decoded.
  final List<Map<String, dynamic>> sent = [];

  /// The broker behind [url], if any.
  FakeBroker? get broker => network.brokerFor(url);

  /// Stream-auth ticket the socket presented, if any.
  String? get wsAuthTicket => url.queryParameters['wsAuthTicket'];

  /// Whether the app closed this socket.
  bool get closedByApp => _closed;

  /// The attach parameters this socket was opened with (`mode`, `reason`,
  /// `readOnly`, `ticket`, …): the stream URL's query, or what the stream
  /// ticket it presented was bound to.
  Map<String, String> get attachParams {
    final ticket = wsAuthTicket;
    final bound = ticket == null ? null : broker?._tickets[ticket];
    return bound?.params ?? url.queryParameters;
  }

  /// The credential the socket authenticated with: the owner or paired-device
  /// token its stream ticket was issued to, null for an anonymous attach.
  String? get credential {
    final ticket = wsAuthTicket;
    if (ticket != null) return broker?._tickets[ticket]?.credential;
    return url.queryParameters['peerToken'] ?? url.queryParameters['token'];
  }

  @override
  bool get isConnected => _connected;

  @override
  Future<void> connect() async {
    final target = broker;
    if (target == null || !target.reachable || !target.socketsAccepted) {
      throw StateError('connection refused: $rawLeakSentinel');
    }
    _connected = true;
    final session = this.session;
    if (session == null) return;
    // A real broker speaks first: hello, the session, then durable history.
    final frames = (target.attachFrames ?? target._standardAttach)(
      this,
      session,
    );
    scheduleMicrotask(() {
      for (final frame in frames) {
        emit(frame);
      }
    });
  }

  /// Tool and id named by the stream URL (`/api/sessions/<tool>/<id>/stream`).
  (String tool, String id)? get attachTarget {
    final segments = url.pathSegments;
    if (segments.length == 5 &&
        segments[0] == 'api' &&
        segments[1] == 'sessions' &&
        segments[4] == 'stream') {
      return (segments[2], segments[3]);
    }
    return null;
  }

  /// The roster row of the session this socket attaches to, if the broker
  /// knows it.
  Map<String, Object?>? get session {
    final named = attachTarget;
    final owner = broker;
    if (named == null || owner == null) return null;
    for (final row in owner.sessions) {
      if (row['tool'] == named.$1 && row['id'] == named.$2) return row;
    }
    return null;
  }

  /// Sends one broker frame to the app.
  void emit(Map<String, Object?> frame) {
    if (!_inbound.isClosed) _inbound.add(frame);
  }

  /// Drops the connection from the broker side.
  void drop() {
    _connected = false;
    if (!_inbound.isClosed) unawaited(_inbound.close());
  }

  @override
  void send(String data) {
    if (!_connected) throw StateError('WebSocket not connected');
    final frame = (jsonDecode(data) as Map).cast<String, dynamic>();
    if (broker?.failFrame?.call(this, frame) ?? false) {
      throw StateError('socket write failed: $rawLeakSentinel');
    }
    sent.add(frame);
    broker?.onFrame?.call(this, frame);
  }

  @override
  void sendJson(Object data) => send(jsonEncode(data));

  @override
  Stream<Object?> get messages => _inbound.stream;

  @override
  Future<void> close() async {
    _closed = true;
    _connected = false;
    if (!_inbound.isClosed) await _inbound.close();
  }
}

class _FakeBrokerHttpAdapter implements HttpClientAdapter {
  _FakeBrokerHttpAdapter(this.network) {
    network._clientsOpened += 1;
  }

  final FakeBrokerNetwork network;
  var _closed = false;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (_closed) {
      throw StateError('HTTP client used after close');
    }
    Object? body;
    if (requestStream != null) {
      final bytes = <int>[];
      await for (final chunk in requestStream) {
        bytes.addAll(chunk);
      }
      if (bytes.isNotEmpty) {
        final text = utf8.decode(bytes);
        try {
          body = jsonDecode(text);
        } on FormatException {
          body = text;
        }
      }
    }
    final request = FakeBrokerRequest(
      method: options.method.toUpperCase(),
      uri: options.uri,
      headers: {
        for (final entry in options.headers.entries)
          entry.key.toLowerCase(): '${entry.value}',
      },
      body: body,
    );
    network.requests.add(request);
    if (network.requests.length > network.requestBudget) {
      throw StateError(
        'FakeBrokerNetwork: more than ${network.requestBudget} requests — '
        'a client is polling in a tight loop. Last: $request',
      );
    }
    final broker = network.brokerFor(options.uri);
    broker?.requests.add(request);
    if (broker == null || !broker.reachable) {
      throw DioException.connectionError(
        requestOptions: options,
        reason: 'Connection refused ($rawLeakSentinel)',
      );
    }
    unawaited(
      cancelFuture?.then((_) => request.cancelled = true) ??
          Future<void>.value(),
    );
    final response = await broker._handle(request);
    request.answered = response.status;
    if (broker._takeLostAnswer(request)) {
      throw DioException.connectionError(
        requestOptions: options,
        reason: 'Connection reset by peer ($rawLeakSentinel)',
      );
    }
    final rawText = response.rawText;
    return ResponseBody.fromString(
      rawText ?? (response.body == null ? '' : jsonEncode(response.body)),
      response.status,
      headers: {
        Headers.contentTypeHeader: [
          if (rawText != null)
            'text/plain; charset=utf-8'
          else
            Headers.jsonContentType,
        ],
        for (final entry in response.headers.entries) entry.key: [entry.value],
      },
    );
  }

  @override
  void close({bool force = false}) {
    if (_closed) return;
    _closed = true;
    network._clientsClosed += 1;
  }
}
