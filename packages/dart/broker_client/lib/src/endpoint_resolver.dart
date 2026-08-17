import 'package:broker_contract/broker_contract.dart';

/// Endpoint resolver for the cosyncing broker.
///
/// Centralizes endpoint paths, auth headers, and query behavior.
class EndpointResolver {
  /// Creates an [EndpointResolver].
  EndpointResolver({
    required this.baseUrl,
    this.token,
    this.peerToken,
    this.clientProfileId,
    this.clientProfileIncarnation,
  }) {
    if (token != null && peerToken != null) {
      throw ArgumentError('Configure either token or peerToken, not both.');
    }
    if ((clientProfileId == null) != (clientProfileIncarnation == null)) {
      throw ArgumentError(
        'Configure clientProfileId and clientProfileIncarnation together.',
      );
    }
  }

  /// The broker HTTP base URL (e.g. 'http://127.0.0.1:7734').
  final String baseUrl;

  /// Optional broker auth token.
  final String? token;

  /// Optional revocable paired-device auth token.
  final String? peerToken;

  /// Exact saved client profile that owns broker-bound requests.
  final String? clientProfileId;

  /// Opaque saved-row incarnation paired with [clientProfileId].
  final String? clientProfileIncarnation;

  /// The health endpoint.
  String get healthEndpoint => '$baseUrl/api/health';

  /// Runtime updates endpoint.
  String get agentRuntimeUpdatesEndpoint =>
      '$baseUrl/api/agent-runtime-updates';

  /// Runtime update policy endpoint.
  String get runtimeUpdatePolicyEndpoint =>
      '$baseUrl/api/agent-runtime-update-policy';

  /// Runtime settings restart endpoint for an agent.
  String agentRuntimeRestartEndpoint(String agent) =>
      '$baseUrl/api/agent-runtime-updates/${Uri.encodeComponent(agent)}/restart';

  /// Broker health endpoint.
  String get brokerHealthEndpoint => '$baseUrl/api/broker/health';

  /// Signed broker release-channel status and update endpoint.
  String get brokerUpdateEndpoint => '$baseUrl/api/broker/update';

  /// Builds the broker update endpoint, optionally forcing a live check.
  String brokerUpdateEndpointFor({bool refresh = false}) =>
      _appendQuery(brokerUpdateEndpoint, refresh ? {'refresh': '1'} : const {});

  /// Broker restart-all endpoint.
  String get brokerRestartAllEndpoint => '$baseUrl/api/broker/restart-all';

  /// The agents endpoint, as a bare path.
  ///
  /// Deliberately unqualified: [agentModelsEndpoint] builds on it, and a query
  /// string here would land in the middle of that path. Roster reads use
  /// [agentRosterEndpoint] instead.
  String get agentsEndpoint => '$baseUrl/api/agents';

  /// The agent roster, declaring which contract this client can decode.
  ///
  /// The roster arrives as ONE list, so an agent carrying a kind this build
  /// cannot parse would abort the whole decode and leave the app reporting no
  /// agents at all. Declaring the revision lets the broker withhold exactly
  /// those rows; omitting it is read as the oldest possible client, which is
  /// safe but shows less than this build can actually handle.
  String get agentRosterEndpoint => _appendQuery(agentsEndpoint, {
    'contractRevision': '$cosyncingClientContractRevision',
  });

  /// Pre-session model catalog endpoint for a specific tool.
  String agentModelsEndpoint(String tool) =>
      '$agentsEndpoint/${Uri.encodeComponent(tool)}/models';

  /// The sessions endpoint.
  ///
  /// Deliberately unqualified, like [agentsEndpoint]: it is a prefix other
  /// paths build on, and a query string here would land mid-path. Roster reads
  /// use [sessionsEndpointFor].
  String get sessionsEndpoint => '$baseUrl/api/sessions';

  /// Builds a roster snapshot endpoint, bypassing the cached representation
  /// only for an explicit user refresh.
  ///
  /// Declares the contract revision for the same reason [agentRosterEndpoint]
  /// does, and it has to be the SAME answer. The broker decides which agents a
  /// client can decode and applies that decision to both lists; asking for
  /// agents as a revision-15 client and for sessions as an unstated one made
  /// the broker withhold every Kimi and dsh SESSION while still listing both
  /// agents — the app would show the tools and none of their work.
  String sessionsEndpointFor({bool refresh = false, String? window}) =>
      _appendQuery(sessionsEndpoint, {
        'contractRevision': '$cosyncingClientContractRevision',
        if (refresh) 'refresh': '1',
        if (window != null) 'window': window,
      });

  /// Lightweight roster metadata/status journal endpoint.
  ///
  /// Carries the revision too: deltas update the snapshot, so a delta stream
  /// with wider visibility than the snapshot it updates would reintroduce
  /// exactly the rows the snapshot withheld.
  String sessionRosterDeltasEndpointFor({
    required int after,
    required int waitMs,
    String? window,
  }) => _appendQuery('$baseUrl/api/session-roster-deltas', {
    'contractRevision': '$cosyncingClientContractRevision',
    'after': '$after',
    'waitMs': '$waitMs',
    if (window != null) 'window': window,
  });

  /// The machines endpoint, as a bare path.
  ///
  /// Deliberately unqualified, like [agentsEndpoint] and [sessionsEndpoint]:
  /// [machineResolveEndpoint] builds on it, and a query string here would land
  /// in the middle of that path. Roster reads use [machineRosterEndpoint].
  String get machinesEndpoint => '$baseUrl/api/machines';

  /// Authenticated aggregated machine rosters, declaring this contract.
  ///
  /// The SAME revision as [agentRosterEndpoint] and [sessionsEndpointFor], for
  /// the same reason: the broker filters every roster read by what the caller
  /// says it can decode, and an unstated revision reads as the oldest possible
  /// client. Omitting it here made one app contradict itself — the local roster
  /// listed a tool while the aggregated view, which is the same rows gathered
  /// across this broker and its peers, dropped every session belonging to it.
  String get machineRosterEndpoint => _appendQuery(machinesEndpoint, {
    'contractRevision': '$cosyncingClientContractRevision',
  });

  /// Resolves an authoritative owning broker for a composite session.
  ///
  /// Carries the revision too: resolution searches the same filtered rosters,
  /// so a session this client can see and open would otherwise fail to resolve
  /// — a 404 on a row the app is showing.
  String machineResolveEndpoint({
    required String machineId,
    required String tool,
    required String sessionId,
  }) => _appendQuery('$machinesEndpoint/resolve', {
    'contractRevision': '$cosyncingClientContractRevision',
    'machineId': machineId,
    'tool': tool,
    'sessionId': sessionId,
  });

  /// The base attention events endpoint.
  String get attentionEventsEndpoint => '$baseUrl/api/attention-events';

  /// Endpoint for exact-revision bulk attention dismissal.
  String get attentionEventsDismissBatchEndpoint =>
      '$attentionEventsEndpoint/dismiss-batch';

  /// Schedule list/create endpoint.
  String get schedulesEndpoint => '$baseUrl/api/schedules';

  /// Endpoint for one schedule.
  ///
  /// The broker intentionally keeps DELETE revision-free; PATCH requests carry
  /// their optimistic revision in the request body.
  String scheduleEndpoint(String id) =>
      '$schedulesEndpoint/${Uri.encodeComponent(id)}';

  /// Typed pause/resume/run-now/quota-recovery route for one schedule.
  String scheduleActionsEndpoint(String id) =>
      '${scheduleEndpoint(id)}/actions';

  /// Tokdash quota proxy endpoint.
  String get tokdashQuotaEndpoint => '$baseUrl/api/tokdash/quota';

  /// Tokdash quota preference endpoint.
  String get tokdashQuotaPreferenceEndpoint =>
      '$baseUrl/api/tokdash/quota-preference';

  /// Endpoint for acking a single attention event.
  String attentionEventAckEndpoint(String id) =>
      '$baseUrl/api/attention-events/${Uri.encodeComponent(id)}/ack';

  /// Endpoint for dismissing a single attention event.
  String attentionEventDismissEndpoint(String id) =>
      '$baseUrl/api/attention-events/${Uri.encodeComponent(id)}/dismiss';

  /// Builds the attention-events endpoint with query args.
  String attentionEventsEndpointFor({
    required String clientId,
    int? after,
    int? limit,
    int? waitMs,
  }) {
    final params = <String, String>{'clientId': clientId};
    if (after != null) params['after'] = '$after';
    if (limit != null) params['limit'] = '$limit';
    if (waitMs != null) params['waitMs'] = '$waitMs';
    return _appendQuery(attentionEventsEndpoint, params);
  }

  /// Builds the runtime-updates endpoint, optionally forcing a fresh probe.
  String agentRuntimeUpdatesEndpointFor({bool? fresh}) {
    final params = <String, String>{};
    if (fresh ?? false) params['fresh'] = '1';
    return _appendQuery(agentRuntimeUpdatesEndpoint, params);
  }

  /// Builds the Tokdash quota endpoint with an optional localhost base URL.
  String tokdashQuotaEndpointFor({String? base}) {
    final params = <String, String>{};
    if (base != null) params['base'] = base;
    return _appendQuery(tokdashQuotaEndpoint, params);
  }

  /// Create session endpoint for a specific tool.
  String createSessionEndpoint(String tool) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}';

  /// Rename session endpoint.
  String renameSessionEndpoint(String tool, String id) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/rename';

  /// Display-only project rename endpoint.
  String get renameProjectEndpoint => '$baseUrl/api/projects/rename';

  /// Clear session cache endpoint.
  String clearSessionCacheEndpoint(String tool, String id) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/cache';

  /// Fork session endpoint.
  String forkSessionEndpoint(String tool, String id) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/fork';

  /// Clone session endpoint.
  String cloneSessionEndpoint(String tool, String id) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/clone';

  /// Transcript export preflight endpoint.
  String exportPreflightEndpoint(String tool, String id) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/export/preflight';

  /// Transcript export execution endpoint.
  String exportSessionEndpoint(String tool, String id) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/export';

  /// Artifact endpoint.
  String artifactEndpoint(String tool, String id, String artifactId) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/artifact/${Uri.encodeComponent(artifactId)}';

  /// Session filesystem listing endpoint.
  String fsDirectoryEndpoint(String tool, String id) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/fs';

  /// Session filesystem read endpoint.
  String fsReadEndpoint(String tool, String id) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/fs/read';

  /// Session filesystem download endpoint (binary stream).
  String fsDownloadEndpoint(String tool, String id) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/fs/download';

  /// Chunked upload init endpoint.
  String uploadInitEndpoint(String tool, String id) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/uploads';

  /// Chunked upload status/patch endpoint.
  String uploadStatusEndpoint(String tool, String id, String uploadId) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/uploads/${Uri.encodeComponent(uploadId)}';

  /// Chunked upload complete endpoint.
  String uploadCompleteEndpoint(String tool, String id, String uploadId) =>
      '$baseUrl/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/uploads/${Uri.encodeComponent(uploadId)}/complete';

  /// Wake-token registration and list endpoint.
  String get wakeTokensEndpoint => '$baseUrl/api/push/wake-tokens';

  /// Wake-token route for a stable installation id.
  String wakeTokenEndpoint(String deviceId) =>
      '$baseUrl/api/push/wake-tokens/${Uri.encodeComponent(deviceId)}';

  /// One-time transport pairing accept endpoint.
  String transportPairingAcceptEndpoint(String pairingId) =>
      '$baseUrl/api/transport/pairings/${Uri.encodeComponent(pairingId)}/accept';

  /// WebSocket stream endpoint.
  ///
  /// Returns a `ws://` or `wss://` URL for the session stream.
  /// Supports optional query parameters for auth and attach behavior.
  ///
  /// See `docs/protocol/contract-sync.md`.
  String streamEndpoint(
    String tool,
    String id, {
    String? mode,
    String? reason,
    bool readOnly = false,
    SessionOwnerRevision? ownerRevision,
    String? since,
    String? ticket,
    int? initialHistory,
    String? artifactMode,
    String clientVersion = cosyncingClientVersion,
    int contractRevision = cosyncingClientContractRevision,
    int minimumBrokerRevision = cosyncingClientMinimumBrokerRevision,
    String contractSurfaceHash = cosyncingClientContractSurfaceHash,
  }) {
    final wsBase = _toWebSocketUrl(baseUrl);
    final path =
        '$wsBase/api/sessions/${Uri.encodeComponent(tool)}/${Uri.encodeComponent(id)}/stream';
    final params = <String, String>{};
    if (token != null && token!.isNotEmpty) params['token'] = token!;
    if (peerToken != null && peerToken!.isNotEmpty) {
      params['peerToken'] = peerToken!;
    }
    if (clientProfileId != null) {
      params['clientProfileId'] = clientProfileId!;
      params['clientProfileIncarnation'] = clientProfileIncarnation!;
    }
    if (mode != null) params['mode'] = mode;
    // Asks the broker to enforce a read-only socket. Sent when this client
    // cannot reason about the session's attach mode, so omitting `mode` is not
    // a strong enough answer: a bare attach is read-only on one adapter and
    // full-authority on another, and only the broker can settle it.
    if (readOnly) params['readOnly'] = '1';
    // Drive-attach intent is additive, and the broker enforces a MATRIX rather
    // than a mode list. `create`, `app-restore` and `lease-restore` describe
    // reopening a connection this app previously owned, which is the resume
    // path; on `live` the broker rejects them. `takeover` is the only reason
    // valid on `live`, where it seizes the running session — a Kimi demoted
    // generation is the case that needs it.
    //
    // Mirrored here rather than left to the broker because the stale state is
    // real: a retained `app-restore` intent meeting a session that has since
    // become live-attach would otherwise build a request that can only 400.
    if (reason != null &&
        (mode == 'resume' || (mode == 'live' && reason == 'takeover'))) {
      params['reason'] = reason;
    }
    if (reason == 'join-existing' && ownerRevision != null) {
      params['ownerEpoch'] = ownerRevision.epoch;
      params['ownerSeq'] = '${ownerRevision.seq}';
    }
    if (since != null) params['since'] = since;
    if (ticket != null) params['ticket'] = ticket;
    if (initialHistory != null) params['initialHistory'] = '$initialHistory';
    if (artifactMode != null) params['artifactMode'] = artifactMode;
    params['clientVersion'] = clientVersion;
    params['contractRevision'] = '$contractRevision';
    params['minimumBrokerRevision'] = '$minimumBrokerRevision';
    params['contractSurfaceHash'] = contractSurfaceHash;
    if (params.isEmpty) return path;
    final query = params.entries
        .map(
          (e) =>
              '${Uri.encodeComponent(e.key)}=${Uri.encodeComponent(e.value)}',
        )
        .join('&');
    return '$path?$query';
  }

  /// Converts an HTTP(S) base URL to WS(S).
  static String _toWebSocketUrl(String url) {
    if (url.startsWith('https://')) return 'wss://${url.substring(8)}';
    if (url.startsWith('http://')) return 'ws://${url.substring(7)}';
    return url;
  }

  /// Returns auth headers for the request.
  ///
  /// Adds the header for the configured shared or paired-device credential.
  Map<String, String> get authHeaders {
    final sourceHeaders = {
      if (clientProfileId != null)
        'x-cosyncing-client-profile': clientProfileId!,
      if (clientProfileIncarnation != null)
        'x-cosyncing-client-incarnation': clientProfileIncarnation!,
    };
    if (peerToken != null && peerToken!.isNotEmpty) {
      return {'x-cosyncing-peer-token': peerToken!, ...sourceHeaders};
    }
    if (token != null && token!.isNotEmpty) {
      return {'x-cosyncing-token': token!, ...sourceHeaders};
    }
    return sourceHeaders;
  }

  /// Returns auth query parameters.
  ///
  /// Adds the query parameter for the configured auth credential.
  Map<String, String> get authQueryParams {
    if (peerToken != null && peerToken!.isNotEmpty) {
      return {'peerToken': peerToken!};
    }
    if (token != null && token!.isNotEmpty) {
      return {'token': token!};
    }
    return const {};
  }

  /// Returns headers for a JSON request.
  Map<String, String> get jsonHeaders => {
    'Content-Type': 'application/json',
    ...authHeaders,
  };

  String _appendQuery(String path, Map<String, String> params) {
    if (params.isEmpty) return path;
    final query = params.entries
        .map(
          (e) =>
              '${Uri.encodeComponent(e.key)}=${Uri.encodeComponent(e.value)}',
        )
        .join('&');
    return '$path?$query';
  }
}
