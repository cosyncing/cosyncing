/// Pure-Dart REST client for the cosyncing broker.
///
/// See `docs/protocol/contract-sync.md`.
library;

import 'dart:convert';

import 'package:broker_client/src/artifact_download.dart';
import 'package:broker_client/src/artifact_too_large_exception.dart';
import 'package:broker_client/src/endpoint_resolver.dart';
import 'package:broker_client/src/upload_offset_mismatch_exception.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:dio/dio.dart';

/// Pure-Dart REST client for the cosyncing broker.
///
/// Uses Dio for HTTP requests. No Flutter dependency.
/// All REST methods throw [BrokerException] on failure.
class BrokerClient {
  /// Creates a [BrokerClient] targeting [baseUrl].
  ///
  /// [token] is optional for brokers that require authentication.
  BrokerClient({
    required String baseUrl,
    String? token,
    String? peerToken,
    String? clientProfileId,
    String? clientProfileIncarnation,
    Dio? dio,
  }) : _resolver = EndpointResolver(
         baseUrl: baseUrl,
         token: token,
         peerToken: peerToken,
         clientProfileId: clientProfileId,
         clientProfileIncarnation: clientProfileIncarnation,
       ),
       _dio = dio ?? Dio();

  /// Exception raised when the broker does not expose
  /// `/api/attention-events`.
  ///
  /// This lets feature code distinguish an old broker from transient failures.
  static const String attentionFeedUnsupportedMessage =
      'Attention feed endpoint is not available on this broker';

  final EndpointResolver _resolver;
  final Dio _dio;
  CancelToken? _rosterDeltaCancelToken;

  /// The broker HTTP base URL.
  String get baseUrl => _resolver.baseUrl;

  /// The endpoint resolver.
  EndpointResolver get resolver => _resolver;

  /// Checks broker health.
  ///
  /// `GET /api/health`
  Future<HealthResponse> getHealth() async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.healthEndpoint,
    );
    return HealthResponse.fromJson(response);
  }

  /// Gets runtime update status for managed runtimes.
  ///
  /// `GET /api/agent-runtime-updates`
  /// `fresh=1` bypasses cache and forces a live probe when true.
  Future<RuntimeUpdatesResponse> getAgentRuntimeUpdates({
    bool fresh = false,
  }) async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.agentRuntimeUpdatesEndpointFor(fresh: fresh),
    );
    return RuntimeUpdatesResponse.fromJson(response);
  }

  /// Gets the current Codex runtime update policy.
  ///
  /// `GET /api/agent-runtime-update-policy`
  Future<CodexUpdatePolicyResponse> getCodexUpdatePolicy() async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.runtimeUpdatePolicyEndpoint,
    );
    return CodexUpdatePolicyResponse.fromJson(response);
  }

  /// Sets the Codex runtime update policy.
  ///
  /// `POST /api/agent-runtime-update-policy`
  /// Request body contains the selected detached/idle policy string.
  Future<CodexUpdatePolicyResponse> setCodexUpdatePolicy(
    SetCodexUpdatePolicyRequest request,
  ) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.runtimeUpdatePolicyEndpoint,
      data: request.toJson(),
    );
    return CodexUpdatePolicyResponse.fromJson(response);
  }

  /// Confirms runtime restart for one managed runtime agent.
  ///
  /// `POST /api/agent-runtime-updates/:agent/restart`
  /// Request body: `{ confirmRestart: true }`.
  Future<RuntimeUpdateRestartResponse> restartAgentRuntime({
    required String agent,
    required bool confirmRestart,
  }) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.agentRuntimeRestartEndpoint(agent),
      data: RuntimeUpdateRestartRequest(
        confirmRestart: confirmRestart,
      ).toJson(),
    );
    return RuntimeUpdateRestartResponse.fromJson(response);
  }

  /// Gets the authenticated broker health snapshot.
  ///
  /// `GET /api/broker/health`
  Future<BrokerHealthResponse> getBrokerHealth() async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.brokerHealthEndpoint,
    );
    return BrokerHealthResponse.fromJson(response);
  }

  /// Gets the workspace-browsing exposure state.
  Future<WorkspaceBrowsingSettingsResponse>
  getWorkspaceBrowsingSettings() async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.workspaceBrowsingSettingsEndpoint,
    );
    return WorkspaceBrowsingSettingsResponse.fromJson(response);
  }

  /// Changes workspace browsing and confirms its remote-file-access effect.
  Future<WorkspaceBrowsingSettingsResponse> setWorkspaceBrowsing({
    required bool enabled,
    required bool confirmRemoteFileAccess,
  }) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.workspaceBrowsingSettingsEndpoint,
      data: {
        'enabled': enabled,
        'confirmRemoteFileAccess': confirmRemoteFileAccess,
      },
    );
    return WorkspaceBrowsingSettingsResponse.fromJson(response);
  }

  /// Reads the signed stable broker release channel.
  ///
  /// `GET /api/broker/update`; `refresh=1` bypasses the broker cache.
  Future<BrokerUpdateResponse> getBrokerUpdate({bool refresh = false}) async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.brokerUpdateEndpointFor(refresh: refresh),
    );
    return BrokerUpdateResponse.fromJson(response);
  }

  /// Requests an update through the broker's signed, rollback-capable upgrader.
  ///
  /// Custom candidate manifests are a local operator CLI capability and cannot
  /// be supplied through the broker API.
  Future<BrokerUpdateTriggerResponse> triggerBrokerUpdate() async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.brokerUpdateEndpoint,
      data: const <String, dynamic>{},
    );
    return BrokerUpdateTriggerResponse.fromJson(response);
  }

  /// Restarts all broker-managed runtimes and broker process.
  ///
  /// `POST /api/broker/restart-all`
  Future<BrokerRestartAllResponse> restartEverything({
    required bool confirmRestart,
  }) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.brokerRestartAllEndpoint,
      data: {'confirmRestart': confirmRestart},
    );
    return BrokerRestartAllResponse.fromJson(response);
  }

  /// Lists available agents.
  ///
  /// `GET /api/agents`
  Future<List<AgentInfo>> listAgents() async {
    final response = await _get<List<dynamic>>(
      _resolver.agentRosterEndpoint,
    );
    return response
        .map((e) => AgentInfo.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// Lists all sessions.
  ///
  /// `GET /api/sessions`
  Future<ListSessionsResponse> listSessions() async {
    final response = await _get<Map<String, dynamic>>(
      // `sessionsEndpointFor`, not the bare prefix: this read has to declare
      // the same contract revision as every other roster read, or the broker
      // reads it as the oldest possible client and withholds every agent with
      // a declared floor.
      _resolver.sessionsEndpointFor(),
    );
    return ListSessionsResponse.fromJson(response);
  }

  /// Fetches a roster snapshot with a stable conditional ETag contract.
  Future<ConditionalSessionListResult> listSessionsConditional({
    String? etag,
    bool refresh = false,
    String? window,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        _resolver.sessionsEndpointFor(refresh: refresh, window: window),
        options: Options(
          headers: {
            ..._resolver.authHeaders,
            if (etag != null && !refresh) 'If-None-Match': etag,
          },
          validateStatus: (status) => status == 200 || status == 304,
        ),
      );
      final responseEtag = response.headers.value('etag') ?? etag;
      if (response.statusCode == 304) {
        return ConditionalSessionListResult.notModified(etag: responseEtag);
      }
      final data = response.data;
      if (data == null) {
        throw const BrokerException(
          message: 'Broker returned an empty session roster',
        );
      }
      return ConditionalSessionListResult.modified(
        response: ListSessionsResponse.fromJson(data),
        etag: responseEtag,
      );
    } on DioException catch (e) {
      throw BrokerException(
        message: e.message ?? 'Roster request failed',
        statusCode: e.response?.statusCode,
        error: _parseBrokerError(e),
      );
    }
  }

  /// Waits for transcript-free roster changes after [after].
  Future<SessionRosterDeltaBatch> waitForSessionRosterDeltas({
    required int after,
    Duration wait = const Duration(seconds: 25),
    String? window,
  }) async {
    final token = CancelToken();
    _rosterDeltaCancelToken?.cancel('superseded roster delta wait');
    _rosterDeltaCancelToken = token;
    final waitMs = wait.inMilliseconds.clamp(0, 25000);
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        _resolver.sessionRosterDeltasEndpointFor(
          after: after,
          waitMs: waitMs,
          window: window,
        ),
        options: Options(
          headers: _resolver.authHeaders,
          // A due broker-side safety reconciliation can include a cold adapter
          // discovery before the long poll. Keep one request alive without
          // increasing poll frequency or response size.
          receiveTimeout: wait + const Duration(minutes: 1),
        ),
        cancelToken: token,
      );
      final data = response.data;
      if (data == null) {
        throw const BrokerException(
          message: 'Broker returned an empty roster delta response',
        );
      }
      return SessionRosterDeltaBatch.fromJson(data);
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) {
        throw const RosterDeltaWaitCancelled();
      }
      throw BrokerException(
        message: e.message ?? 'Roster delta request failed',
        statusCode: e.response?.statusCode,
        error: _parseBrokerError(e),
      );
    } finally {
      if (identical(_rosterDeltaCancelToken, token)) {
        _rosterDeltaCancelToken = null;
      }
    }
  }

  /// Cancels the active foreground roster wait when the app is hidden.
  void cancelSessionRosterDeltaWait() {
    _rosterDeltaCancelToken?.cancel('roster feed suspended');
    _rosterDeltaCancelToken = null;
  }

  /// Lists local and configured peer machine rosters.
  ///
  /// `GET /api/machines` is authenticated and read-only.
  Future<AggregatedMachinesResponse> listMachines() async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.machineRosterEndpoint,
    );
    return AggregatedMachinesResponse.fromJson(response);
  }

  /// Resolves the authoritative owning broker for a composite session.
  Future<MachineSessionResolution> resolveMachineSession({
    required String machineId,
    required String tool,
    required String sessionId,
  }) async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.machineResolveEndpoint(
        machineId: machineId,
        tool: tool,
        sessionId: sessionId,
      ),
    );
    return MachineSessionResolution.fromJson(response);
  }

  /// Lists full prompt-bearing schedule records.
  ///
  /// `GET /api/schedules` is authenticated even though it is read-only.
  ///
  /// Pass [cancelToken] to abandon a read whose answer is no longer wanted.
  /// The Dio client carries no default timeout, so a superseded read that is
  /// merely ignored keeps its request and connection slot alive indefinitely.
  /// A canceled read throws [RequestCancelled].
  Future<ScheduleListResponse> listSchedules({
    CancelToken? cancelToken,
  }) async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.schedulesEndpoint,
      cancelToken: cancelToken,
    );
    return ScheduleListResponse.fromJson(response);
  }

  /// Creates an existing-session or new-session schedule.
  ///
  /// `POST /api/schedules`
  Future<ScheduleCreateResponse> createSchedule(
    ScheduleCreate request,
  ) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.schedulesEndpoint,
      data: request.toJson(),
    );
    return ScheduleCreateResponse.fromJson(response);
  }

  /// Edits a schedule using its current optimistic revision.
  Future<ScheduleMutationResponse> updateSchedule(
    String id,
    ScheduleUpdate request,
  ) async {
    final response = await _patch<Map<String, dynamic>>(
      _resolver.scheduleEndpoint(id),
      data: request.toJson(),
    );
    return ScheduleMutationResponse.fromJson(response);
  }

  /// Applies a typed lifecycle action using its current optimistic revision.
  Future<ScheduleMutationResponse> applyScheduleAction(
    String id,
    ScheduleActionRequest request,
  ) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.scheduleActionsEndpoint(id),
      data: request.toJson(),
    );
    return ScheduleMutationResponse.fromJson(response);
  }

  /// Cancels a live schedule or removes a terminal schedule.
  ///
  /// `DELETE /api/schedules/:id` is intentionally revision-free.
  Future<ScheduleDeleteResponse> deleteSchedule(String id) async {
    final response = await _delete<Map<String, dynamic>>(
      _resolver.scheduleEndpoint(id),
    );
    return ScheduleDeleteResponse.fromJson(response);
  }

  /// Gets Tokdash quota data through the broker proxy.
  ///
  /// `GET /api/tokdash/quota`
  /// The upstream endpoint is selected only by local broker configuration.
  Future<TokdashQuotaResponse> getTokdashQuota() async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.tokdashQuotaEndpoint,
    );
    return TokdashQuotaResponse.fromJson(response);
  }

  /// Gets quota warning preference.
  ///
  /// `GET /api/tokdash/quota-preference`
  Future<TokdashQuotaPreferenceResponse> getTokdashQuotaPreference() async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.tokdashQuotaPreferenceEndpoint,
    );
    return TokdashQuotaPreferenceResponse.fromJson(response);
  }

  /// Updates quota warning preference.
  ///
  /// `POST /api/tokdash/quota-preference`
  /// Request body: `{ enabled: true | false }`.
  Future<TokdashQuotaPreferenceResponse> setTokdashQuotaPreference(
    TokdashQuotaPreferenceRequest request,
  ) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.tokdashQuotaPreferenceEndpoint,
      data: request.toJson(),
    );
    return TokdashQuotaPreferenceResponse.fromJson(response);
  }

  /// Fetches a bounded attention-events page for [clientId].
  ///
  /// `GET /api/attention-events?clientId=...&after=...&limit=...&waitMs=...`
  ///
  /// Pass [cancelToken] to cancel long-polling calls.
  Future<AttentionEventsPage> getAttentionEvents({
    required String clientId,
    int? after,
    int? limit,
    int? waitMs,
    CancelToken? cancelToken,
  }) async {
    // Keep client receive-timeout aligned with the long-poll window from
    // docs/architecture/client-ui.md
    final effectiveWaitMs = (waitMs ?? 0) > 0 ? waitMs! : 0;
    final receiveTimeout = Duration(milliseconds: effectiveWaitMs + 10_000);
    final response = await _getAttentionEvents(
      _resolver.attentionEventsEndpointFor(
        clientId: clientId,
        after: after,
        limit: limit,
        waitMs: waitMs,
      ),
      cancelToken: cancelToken,
      receiveTimeout: receiveTimeout,
    );
    return AttentionEventsPage.fromJson(response);
  }

  /// Acknowledges an attention event for [clientId].
  ///
  /// `POST /api/attention-events/:id/ack`
  Future<Map<String, dynamic>> acknowledgeAttentionEvent(
    String eventId, {
    required String clientId,
  }) async {
    return _post<Map<String, dynamic>>(
      _resolver.attentionEventAckEndpoint(eventId),
      data: {'clientId': clientId},
    );
  }

  /// Dismisses an attention event for [clientId].
  ///
  /// `POST /api/attention-events/:id/dismiss`
  Future<Map<String, dynamic>> dismissAttentionEvent(
    String eventId, {
    required String clientId,
  }) async {
    return _post<Map<String, dynamic>>(
      _resolver.attentionEventDismissEndpoint(eventId),
      data: {'clientId': clientId},
    );
  }

  /// Dismisses one exact loaded snapshot for [clientId] in a bounded request.
  ///
  /// `POST /api/attention-events/dismiss-batch`
  Future<AttentionBulkDismissResponse> dismissAttentionEvents(
    List<AttentionBulkDismissItem> events, {
    required String clientId,
  }) async {
    if (events.length > attentionBulkDismissMax) {
      throw ArgumentError.value(
        events.length,
        'events',
        'must contain at most $attentionBulkDismissMax items',
      );
    }
    final response = await _post<Map<String, dynamic>>(
      _resolver.attentionEventsDismissBatchEndpoint,
      data: {
        'clientId': clientId,
        'events': events.map((event) => event.toJson()).toList(growable: false),
      },
    );
    return AttentionBulkDismissResponse.fromJson(response);
  }

  /// Registers the local wake token for push notifications.
  ///
  /// `POST /api/push/wake-tokens`
  ///
  /// The payload should include `platform` (`apns` | `fcm`), raw token
  /// (`token`), and optionally `deviceId` and `label`.
  Future<PushWakeTokenRegistrationResponse> registerWakeToken(
    PushWakeTokenRegistrationRequest request,
  ) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.wakeTokensEndpoint,
      data: request.toJson(),
    );
    return PushWakeTokenRegistrationResponse.fromJson(response);
  }

  /// Lists current wake-token registrations.
  ///
  /// `GET /api/push/wake-tokens`
  Future<PushWakeTokenListResponse> listWakeTokens() async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.wakeTokensEndpoint,
    );
    return PushWakeTokenListResponse.fromJson(response);
  }

  /// Revokes a wake-token registration by [deviceId].
  ///
  /// `DELETE /api/push/wake-tokens/:deviceId`
  Future<PushWakeTokenRevokeResponse> revokeWakeToken(
    String deviceId,
  ) async {
    final response = await _delete<Map<String, dynamic>>(
      _resolver.wakeTokenEndpoint(deviceId),
    );
    return PushWakeTokenRevokeResponse.fromJson(response);
  }

  /// Creates a new session for the given [tool].
  ///
  /// `POST /api/sessions/:tool`
  ///
  /// [directory] is optional working directory.
  /// [title] is optional session title.
  Future<CreateSessionResponse> createSession(
    String tool, {
    String? directory,
    String? title,
    SessionCurrentModel? model,
  }) async {
    final body = <String, dynamic>{};
    if (directory != null) body['directory'] = directory;
    if (title != null) body['title'] = title;
    if (model != null) {
      body['model'] = <String, dynamic>{
        'providerID': model.providerID,
        'modelID': model.modelID,
        if (model.variant != null) 'variant': model.variant,
        if (model.reasoningEffort != null)
          'reasoningEffort': model.reasoningEffort,
      };
    }

    final response = await _post<Map<String, dynamic>>(
      _resolver.createSessionEndpoint(tool),
      data: body,
    );
    return CreateSessionResponse.fromJson(response);
  }

  /// Loads the capability-driven pre-session model catalog for [tool].
  Future<ModelCatalogResponse> listAgentModels(String tool) async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.agentModelsEndpoint(tool),
    );
    return ModelCatalogResponse.fromJson(response);
  }

  /// Renames a session.
  ///
  /// `PATCH /api/sessions/:tool/:id/rename`
  ///
  /// [title] is the new title. Pass null to clear.
  Future<RenameSessionResponse> renameSession(
    String tool,
    String id,
    String? title,
  ) async {
    final response = await _patch<Map<String, dynamic>>(
      _resolver.renameSessionEndpoint(tool, id),
      data: {'title': title},
    );
    return RenameSessionResponse.fromJson(response);
  }

  /// Changes the display alias for a project directory.
  ///
  /// `PATCH /api/projects/rename`
  ///
  /// [name] is the new display alias. Pass null to reset it. The broker never
  /// moves or renames [cwd].
  Future<RenameProjectResponse> renameProject(
    String cwd,
    String? name,
  ) async {
    final response = await _patch<Map<String, dynamic>>(
      _resolver.renameProjectEndpoint,
      data: {'cwd': cwd, 'name': name},
    );
    return RenameProjectResponse.fromJson(response);
  }

  /// Clears the artifact cache for a session.
  ///
  /// `DELETE /api/sessions/:tool/:id/cache`
  Future<ClearSessionCacheResponse> clearSessionCache(
    String tool,
    String id,
  ) async {
    final response = await _delete<Map<String, dynamic>>(
      _resolver.clearSessionCacheEndpoint(tool, id),
    );
    return ClearSessionCacheResponse.fromJson(response);
  }

  /// Forks a session.
  ///
  /// `POST /api/sessions/:tool/:id/fork`
  ///
  /// [messageId] is optional and can be supplied when a fork point is
  /// already known.
  Future<ForkSessionResponse> forkSession(
    String tool,
    String id, {
    String? messageId,
  }) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.forkSessionEndpoint(tool, id),
      data: messageId == null ? const {} : {'messageId': messageId},
    );
    return ForkSessionResponse.fromJson(response);
  }

  /// Clones a session.
  ///
  /// `POST /api/sessions/:tool/:id/clone`
  Future<CloneSessionResponse> cloneSession(
    String tool,
    String id,
  ) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.cloneSessionEndpoint(tool, id),
    );
    return CloneSessionResponse.fromJson(response);
  }

  /// Prepares transcript export.
  ///
  /// `POST /api/sessions/:tool/:id/export/preflight`
  Future<TranscriptExportPreflightResponse> prepareTranscriptExport(
    String tool,
    String id,
  ) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.exportPreflightEndpoint(tool, id),
    );
    return TranscriptExportPreflightResponse.fromJson(response);
  }

  /// Exports transcript using a previously prepared nonce.
  ///
  /// `POST /api/sessions/:tool/:id/export`
  ///
  /// The broker currently accepts only `nonce` as a body field for this route.
  Future<TranscriptExportResponse> exportTranscript(
    String tool,
    String id, {
    required String nonce,
  }) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.exportSessionEndpoint(tool, id),
      data: {'nonce': nonce},
    );
    return TranscriptExportResponse.fromJson(response);
  }

  /// Reads a file from the session workspace.
  ///
  /// `GET /api/sessions/:tool/:id/fs/read?path=&maxBytes=`
  Future<FsReadResult> readSessionFile(
    String tool,
    String id, {
    String? path,
    int? maxBytes,
  }) async {
    final response = await _get<Map<String, dynamic>>(
      _appendQuery(
        _resolver.fsReadEndpoint(tool, id),
        {
          if (path != null) 'path': path,
          if (maxBytes != null) 'maxBytes': '$maxBytes',
        },
      ),
    );
    return FsReadResult.fromJson(response);
  }

  /// Lists a directory in the session workspace.
  ///
  /// `GET /api/sessions/:tool/:id/fs?path=`
  Future<FsDirectoryResult> listSessionDirectory(
    String tool,
    String id, {
    String? path,
  }) async {
    final response = await _get<Map<String, dynamic>>(
      _appendQuery(
        _resolver.fsDirectoryEndpoint(tool, id),
        {if (path != null) 'path': path},
      ),
    );
    return FsDirectoryResult.fromJson(response);
  }

  /// Downloads a raw file stream from the session workspace.
  ///
  /// `GET /api/sessions/:tool/:id/fs/download?path=`
  ///
  /// Unlike [fetchArtifactUrl], this attaches broker auth headers because the
  /// fs/download route is session-scoped, not a signed artifact URL. The
  /// Optional range and validator fields support restart-safe downloads.
  /// W14 advertises the sniffed MIME via both
  /// `content-type` and the `x-cosyncing-mime-type` header and sends a
  /// `nosniff` directive.
  Future<ArtifactDownload> downloadSessionFile(
    String tool,
    String id, {
    required String path,
    int? rangeStart,
    int? rangeEnd,
    String? ifRange,
  }) async {
    if (rangeStart != null && rangeStart < 0) {
      throw ArgumentError.value(rangeStart, 'rangeStart', 'Must be >= 0.');
    }
    if (rangeEnd != null && (rangeStart == null || rangeEnd < rangeStart)) {
      throw ArgumentError.value(
        rangeEnd,
        'rangeEnd',
        'Requires rangeStart and must be >= rangeStart.',
      );
    }
    try {
      final response = await _dio.get<List<int>>(
        _appendQuery(
          _resolver.fsDownloadEndpoint(tool, id),
          {'path': path},
        ),
        options: Options(
          responseType: ResponseType.bytes,
          headers: {
            ..._resolver.authHeaders,
            if (rangeStart != null)
              'range': 'bytes=$rangeStart-${rangeEnd ?? ''}',
            if (ifRange != null && ifRange.trim().isNotEmpty)
              'if-range': ifRange.trim(),
          },
          validateStatus: (status) =>
              status == 200 || status == 206 || status == 416,
        ),
      );
      final headers = response.headers;
      final mime =
          _firstAvailableHeader(
            headers,
            const ['x-cosyncing-mime-type'],
          ) ??
          headers.value('content-type');
      return ArtifactDownload(
        bytes: response.data ?? <int>[],
        contentType: mime,
        contentLength: _parseContentLength(headers.value('content-length')),
        sourceUrl: response.requestOptions.uri.toString(),
        statusCode: response.statusCode ?? 200,
        etag: headers.value('etag'),
        lastModified: headers.value('last-modified'),
        acceptRanges: headers.value('accept-ranges'),
        contentRange: headers.value('content-range'),
      );
    } on DioException catch (e) {
      throw BrokerException(
        message: 'File download failed',
        statusCode: e.response?.statusCode,
        error: _parseBytesBrokerError(e),
      );
    }
  }

  /// Downloads one authenticated workspace-file response with a hard byte
  /// ceiling enforced while bytes are arriving. Range fields have the same
  /// semantics as [downloadSessionFile]; unlike that native filesystem path,
  /// this method is safe for the browser's in-memory cache.
  Future<ArtifactDownload> downloadSessionFileBounded(
    String tool,
    String id, {
    required String path,
    required int maxBytes,
    int? rangeStart,
    int? rangeEnd,
    String? ifRange,
  }) async {
    if (maxBytes <= 0) {
      throw ArgumentError.value(maxBytes, 'maxBytes', 'Must be > 0.');
    }
    if (rangeStart != null && rangeStart < 0) {
      throw ArgumentError.value(rangeStart, 'rangeStart', 'Must be >= 0.');
    }
    if (rangeEnd != null && (rangeStart == null || rangeEnd < rangeStart)) {
      throw ArgumentError.value(
        rangeEnd,
        'rangeEnd',
        'Requires rangeStart and must be >= rangeStart.',
      );
    }
    final cancelToken = CancelToken();
    var overLimit = false;
    try {
      final response = await _dio.get<List<int>>(
        _appendQuery(
          _resolver.fsDownloadEndpoint(tool, id),
          {'path': path},
        ),
        options: Options(
          responseType: ResponseType.bytes,
          headers: {
            ..._resolver.authHeaders,
            if (rangeStart != null)
              'range': 'bytes=$rangeStart-${rangeEnd ?? ''}',
            if (ifRange != null && ifRange.trim().isNotEmpty)
              'if-range': ifRange.trim(),
          },
          validateStatus: (status) =>
              status == 200 || status == 206 || status == 416,
        ),
        cancelToken: cancelToken,
        onReceiveProgress: (received, total) {
          if (!overLimit &&
              ((total > 0 && total > maxBytes) || received > maxBytes)) {
            overLimit = true;
            cancelToken.cancel('workspace file exceeds client byte ceiling');
          }
        },
      );
      final headers = response.headers;
      final advertised = _parseContentLength(
        headers.value('content-length'),
      );
      final bytes = response.data ?? <int>[];
      if ((advertised != null && advertised > maxBytes) ||
          bytes.length > maxBytes) {
        throw ArtifactTooLargeException(
          limit: maxBytes,
          advertised: advertised,
        );
      }
      final mime =
          _firstAvailableHeader(
            headers,
            const ['x-cosyncing-mime-type'],
          ) ??
          headers.value('content-type');
      return ArtifactDownload(
        bytes: bytes,
        contentType: mime,
        contentLength: advertised,
        sourceUrl: response.requestOptions.uri.toString(),
        statusCode: response.statusCode ?? 200,
        etag: headers.value('etag'),
        lastModified: headers.value('last-modified'),
        acceptRanges: headers.value('accept-ranges'),
        contentRange: headers.value('content-range'),
      );
    } on DioException catch (e) {
      if (overLimit || e.type == DioExceptionType.cancel) {
        throw ArtifactTooLargeException(limit: maxBytes);
      }
      throw BrokerException(
        message: 'File download failed',
        statusCode: e.response?.statusCode,
        error: _parseBytesBrokerError(e),
      );
    }
  }

  /// Initializes a chunked upload.
  ///
  /// `POST /api/sessions/:tool/:id/uploads`
  Future<UploadInitResult> initUpload(
    String tool,
    String id, {
    required String name,
    String? mimeType,
    int? size,
    String? contentHash,
  }) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.uploadInitEndpoint(tool, id),
      data: {
        'name': name,
        if (mimeType != null) 'mimeType': mimeType,
        if (size != null) 'size': size,
        if (contentHash != null) 'contentHash': contentHash,
      },
    );
    return UploadInitResult.fromJson(response);
  }

  /// Gets the status of a chunked upload.
  ///
  /// `GET /api/sessions/:tool/:id/uploads/:uploadId`
  Future<UploadStatus> getUploadStatus(
    String tool,
    String id,
    String uploadId,
  ) async {
    final response = await _get<Map<String, dynamic>>(
      _resolver.uploadStatusEndpoint(tool, id, uploadId),
    );
    return UploadStatus.fromJson(response);
  }

  /// Completes a chunked upload, moving it into the session inbox.
  ///
  /// `POST /api/sessions/:tool/:id/uploads/:uploadId/complete`
  Future<UploadCompleteResult> completeUpload(
    String tool,
    String id,
    String uploadId,
  ) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.uploadCompleteEndpoint(tool, id, uploadId),
    );
    return UploadCompleteResult.fromJson(response);
  }

  /// Discards an incomplete or unconsumed staged upload.
  ///
  /// `DELETE /api/sessions/:tool/:id/uploads/:uploadId`
  Future<void> discardUpload(
    String tool,
    String id,
    String uploadId,
  ) async {
    await _delete<Map<String, dynamic>>(
      _resolver.uploadStatusEndpoint(tool, id, uploadId),
    );
  }

  /// Appends one binary chunk to a chunked upload.
  ///
  /// `PATCH /api/sessions/:tool/:id/uploads/:uploadId`
  ///
  /// [offset] is sent as the `x-cosyncing-upload-offset` header and must equal
  /// the broker's current byte offset for [uploadId]. [bytes] is sent as the
  /// raw binary request body (`application/octet-stream`).
  ///
  /// On a 409 `UPLOAD_OFFSET_MISMATCH` the broker echoes the authoritative
  /// next offset; this method throws [UploadOffsetMismatchException] so callers
  /// can resync from [UploadOffsetMismatchException.expectedOffset] and
  /// continue with the same [uploadId]. Other failures throw [BrokerException].
  Future<UploadPatchResult> patchUploadChunk(
    String tool,
    String id,
    String uploadId, {
    required int offset,
    required List<int> bytes,
  }) async {
    try {
      final response = await _dio.patch<Map<String, dynamic>>(
        _resolver.uploadStatusEndpoint(tool, id, uploadId),
        data: bytes,
        options: Options(
          headers: {
            'x-cosyncing-upload-offset': '$offset',
            'Content-Type': 'application/octet-stream',
            ..._resolver.authHeaders,
          },
        ),
      );
      return UploadPatchResult.fromJson(response.data!);
    } on DioException catch (e) {
      throw _wrapUploadPatchException(e);
    }
  }

  /// Accepts a one-time QR transport pairing.
  ///
  /// `POST /api/transport/pairings/:id/accept`
  ///
  /// This route is intentionally token-exempt on the broker. The client still
  /// sends the normal JSON content type; no bearer token is required.
  Future<TransportPairingAcceptResponse> acceptTransportPairing(
    String pairingId,
    TransportPairingAcceptRequest request,
  ) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.transportPairingAcceptEndpoint(pairingId),
      data: request.toJson(),
    );
    return TransportPairingAcceptResponse.fromJson(response);
  }

  /// Refreshes an authenticated, principal-bound artifact download ticket.
  Future<String> refreshArtifactTicket(
    String tool,
    String sessionId,
    String artifactId,
  ) async {
    final response = await _post<Map<String, dynamic>>(
      _resolver.artifactTicketEndpoint(tool, sessionId, artifactId),
      data: const <String, dynamic>{},
    );
    final fetchUrl = response['fetchUrl'];
    if (fetchUrl is! String || fetchUrl.trim().isEmpty) {
      throw const BrokerException(
        message: 'Broker returned an invalid artifact ticket',
      );
    }
    return fetchUrl;
  }

  /// Fetches an artifact URL directly.
  ///
  /// Uses a byte response mode and accepts either a fully-qualified legacy URL
  /// or a root-relative URL resolved against this client's broker. Current
  /// same-origin references carry the active broker credential; legacy
  /// cross-origin URLs never receive it.
  Future<ArtifactDownload> fetchArtifactUrl(String url) async {
    try {
      final response = await _getArtifactBytesWithRefresh(url);
      final headers = response.headers;

      return ArtifactDownload(
        bytes: response.data ?? <int>[],
        contentType: headers.value('content-type'),
        contentLength: _parseContentLength(headers.value('content-length')),
        artifactKey:
            _firstAvailableHeader(
              headers,
              const [
                'x-artifact-key',
                'x-cosyncing-artifact-key',
                'x-broker-artifact-key',
              ],
            ) ??
            _artifactKeyFromUrl(response.requestOptions.uri),
        contentHash: _firstAvailableHeader(
          headers,
          const [
            'x-content-hash',
            'x-cosyncing-content-hash',
            'x-broker-content-hash',
          ],
        ),
        sourceUrl: response.requestOptions.uri.toString(),
      );
    } on DioException catch (e) {
      throw BrokerException(
        message: 'Artifact fetch failed',
        statusCode: e.response?.statusCode,
        error: _parseBrokerError(e),
      );
    }
  }

  /// Fetches a signed artifact/diff URL with a hard byte ceiling, cancelling the
  /// transfer once [maxBytes] is crossed — so an oversized body is never fully
  /// buffered on a phone. Uses `onReceiveProgress` (not a `ResponseType.stream`
  /// read) so the bound ALSO holds on Flutter Web, where Dio's browser adapter
  /// buffers the whole XHR response and exposes no incremental byte stream: the
  /// progress callback still fires during download, so aborting there stops the
  /// browser mid-transfer (R4 finding 1). Rejects an advertised over-limit
  /// `content-length` early. Throws [ArtifactTooLargeException] in either case.
  /// Like [fetchArtifactUrl], same-origin references carry broker auth while
  /// legacy cross-origin URLs never receive the credential.
  Future<ArtifactDownload> fetchArtifactUrlBounded(
    String url, {
    required int maxBytes,
  }) async {
    try {
      final response = await _getArtifactBytesBoundedWithRefresh(
        url,
        maxBytes: maxBytes,
      );
      final headers = response.headers;
      final advertised = _parseContentLength(headers.value('content-length'));
      final bytes = response.data ?? <int>[];
      // Belt-and-suspenders: if a transport delivered the whole body with no
      // progress callback (or fired none), still refuse an over-ceiling body.
      if (advertised != null && advertised > maxBytes ||
          bytes.length > maxBytes) {
        throw ArtifactTooLargeException(
          limit: maxBytes,
          advertised: advertised,
        );
      }
      return ArtifactDownload(
        bytes: bytes,
        contentType: headers.value('content-type'),
        contentLength: advertised,
        artifactKey:
            _firstAvailableHeader(
              headers,
              const [
                'x-artifact-key',
                'x-cosyncing-artifact-key',
                'x-broker-artifact-key',
              ],
            ) ??
            _artifactKeyFromUrl(response.requestOptions.uri),
        contentHash: _firstAvailableHeader(
          headers,
          const [
            'x-content-hash',
            'x-cosyncing-content-hash',
            'x-broker-content-hash',
          ],
        ),
        sourceUrl: response.requestOptions.uri.toString(),
      );
    } on DioException catch (e) {
      throw BrokerException(
        message: 'Artifact fetch failed',
        statusCode: e.response?.statusCode,
        error: _parseBrokerError(e),
      );
    }
  }

  /// Closes the Dio client.
  void close() {
    cancelSessionRosterDeltaWait();
    _dio.close();
  }

  /// Appends `?k=v&...` to [path] for the given [params], encoding keys and
  /// values. Returns [path] unchanged when [params] is empty.
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

  /// Parses a [BrokerError] from a Dio error response, if possible.
  static BrokerError? _parseBrokerError(DioException e) {
    final data = e.response?.data;
    if (data is Map<String, dynamic> && data.containsKey('error')) {
      return BrokerError.fromJson(data);
    }
    return null;
  }

  /// Parses a [BrokerError] from a byte-stream Dio error response.
  ///
  /// [downloadSessionFile] requests bytes, so error bodies arrive as
  /// `List<int>` rather than a decoded JSON map. This decodes those bytes (and
  /// tolerates map/string bodies) so broker error codes like
  /// `FS_REMOTE_DISABLED` survive the bytes response type.
  static BrokerError? _parseBytesBrokerError(DioException e) {
    final data = e.response?.data;
    if (data is Map<String, dynamic> && data.containsKey('error')) {
      return BrokerError.fromJson(data);
    }
    if (data is String) {
      return _decodeBrokerErrorString(data);
    }
    if (data is List<int>) {
      return _decodeBrokerErrorString(
        utf8.decode(data, allowMalformed: true),
      );
    }
    return null;
  }

  static BrokerError? _decodeBrokerErrorString(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic> && decoded.containsKey('error')) {
        return BrokerError.fromJson(decoded);
      }
    } on Object {
      // Not JSON; ignore.
    }
    return null;
  }

  /// Wraps a [DioException] from `patchUploadChunk` into a typed exception.
  ///
  /// A 409 `UPLOAD_OFFSET_MISMATCH` becomes [UploadOffsetMismatchException]
  /// carrying the broker-authoritative next offset; everything else becomes a
  /// [BrokerException] with the parsed [BrokerError].
  static Exception _wrapUploadPatchException(DioException e) {
    final brokerError = _parseBrokerError(e);
    if (brokerError?.code == 'UPLOAD_OFFSET_MISMATCH') {
      return UploadOffsetMismatchException(
        expectedOffset: _extractExpectedOffset(e.response?.data),
        statusCode: e.response?.statusCode,
        error: brokerError,
        message: e.message ?? 'Upload offset mismatch',
      );
    }
    return BrokerException(
      message: e.message ?? 'Upload chunk failed',
      statusCode: e.response?.statusCode,
      error: brokerError,
    );
  }

  /// Reads the broker's expected next offset from an offset-mismatch body.
  ///
  /// The broker spreads the staging `details` into the top-level JSON, so the
  /// authoritative offset appears as `expectedOffset` (and equivalently
  /// `offset`). Returns `null` when the broker omitted the detail.
  static int? _extractExpectedOffset(Object? data) {
    if (data is Map<String, dynamic>) {
      final expected = data['expectedOffset'];
      if (expected is num) return expected.toInt();
      final offset = data['offset'];
      if (offset is num) return offset.toInt();
    }
    return null;
  }

  /// Wraps a Dio GET request, converting [DioException] to [BrokerException].
  ///
  /// A caller-supplied [cancelToken] surfaces as [RequestCancelled] rather
  /// than a generic failure, so abandoned work is never mistaken for a fault.
  ///
  /// The mapping is deliberately conditional on [cancelToken]. Seventeen GET
  /// APIs share this helper, and a cancel-shaped failure a caller did not ask
  /// for — an injected interceptor, a client-wide abort — is a fault to them,
  /// not abandoned work. Without the guard it would arrive as an unrelated
  /// "the caller abandoned this" signal instead of a [BrokerException].
  Future<T> _get<T>(String path, {CancelToken? cancelToken}) async {
    try {
      final response = await _dio.get<T>(
        path,
        options: Options(headers: _resolver.authHeaders),
        cancelToken: cancelToken,
      );
      return response.data as T;
    } on DioException catch (e) {
      if (cancelToken != null && e.type == DioExceptionType.cancel) {
        throw const RequestCancelled();
      }
      throw BrokerException(
        message: e.message ?? 'Request failed',
        statusCode: e.response?.statusCode,
        error: _parseBrokerError(e),
      );
    }
  }

  Future<Map<String, dynamic>> _getAttentionEvents(
    String path, {
    required Duration receiveTimeout,
    CancelToken? cancelToken,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        path,
        options: Options(
          headers: _resolver.authHeaders,
          receiveTimeout: receiveTimeout,
        ),
        cancelToken: cancelToken,
      );
      final data = response.data;
      if (data == null) {
        throw const BrokerException(
          message: 'Broker returned an empty attention response',
        );
      }
      return data;
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) {
        rethrow;
      }
      if (e.response?.statusCode == 404) {
        throw AttentionFeedUnsupportedException(
          message: attentionFeedUnsupportedMessage,
          statusCode: e.response?.statusCode,
          error: _parseBrokerError(e),
        );
      }
      throw BrokerException(
        message: e.message ?? 'Request failed',
        statusCode: e.response?.statusCode,
        error: _parseBrokerError(e),
      );
    }
  }

  /// Wraps a Dio POST request, converting [DioException] to [BrokerException].
  Future<T> _post<T>(String path, {Object? data}) async {
    try {
      final response = await _dio.post<T>(
        path,
        data: data,
        options: Options(headers: _resolver.jsonHeaders),
      );
      return response.data as T;
    } on DioException catch (e) {
      throw BrokerException(
        message: e.message ?? 'Request failed',
        statusCode: e.response?.statusCode,
        error: _parseBrokerError(e),
      );
    }
  }

  /// Wraps a Dio PATCH request, converting [DioException] to [BrokerException].
  Future<T> _patch<T>(String path, {Object? data}) async {
    try {
      final response = await _dio.patch<T>(
        path,
        data: data,
        options: Options(headers: _resolver.jsonHeaders),
      );
      return response.data as T;
    } on DioException catch (e) {
      throw BrokerException(
        message: e.message ?? 'Request failed',
        statusCode: e.response?.statusCode,
        error: _parseBrokerError(e),
      );
    }
  }

  /// Wraps a Dio DELETE request, converting [DioException]
  /// to [BrokerException].
  Future<T> _delete<T>(String path) async {
    try {
      final response = await _dio.delete<T>(
        path,
        options: Options(headers: _resolver.jsonHeaders),
      );
      return response.data as T;
    } on DioException catch (e) {
      throw BrokerException(
        message: e.message ?? 'Request failed',
        statusCode: e.response?.statusCode,
        error: _parseBrokerError(e),
      );
    }
  }

  Future<Response<List<int>>> _getArtifactBytesWithRefresh(String value) async {
    final resolved = _resolveArtifactUrl(value);
    try {
      return await _getArtifactBytes(resolved);
    } on DioException catch (error) {
      if (error.response?.statusCode != 403) rethrow;
      final identity = _canonicalArtifactIdentity(resolved);
      if (identity == null) rethrow;
      final refreshed = await refreshArtifactTicket(
        identity.tool,
        identity.sessionId,
        identity.artifactId,
      );
      final refreshedResolved = _resolveArtifactUrl(refreshed);
      if (!_sameArtifactIdentity(
        _canonicalArtifactIdentity(refreshedResolved),
        identity,
      )) {
        throw const BrokerException(
          message: 'Broker returned an invalid artifact ticket',
        );
      }
      return _getArtifactBytes(refreshedResolved);
    }
  }

  Future<Response<List<int>>> _getArtifactBytesBoundedWithRefresh(
    String value, {
    required int maxBytes,
  }) async {
    final resolved = _resolveArtifactUrl(value);
    try {
      return await _getArtifactBytesBounded(resolved, maxBytes: maxBytes);
    } on DioException catch (error) {
      if (error.response?.statusCode != 403) rethrow;
      final identity = _canonicalArtifactIdentity(resolved);
      if (identity == null) rethrow;
      final refreshed = await refreshArtifactTicket(
        identity.tool,
        identity.sessionId,
        identity.artifactId,
      );
      final refreshedResolved = _resolveArtifactUrl(refreshed);
      if (!_sameArtifactIdentity(
        _canonicalArtifactIdentity(refreshedResolved),
        identity,
      )) {
        throw const BrokerException(
          message: 'Broker returned an invalid artifact ticket',
        );
      }
      return _getArtifactBytesBounded(
        refreshedResolved,
        maxBytes: maxBytes,
      );
    }
  }

  Future<Response<List<int>>> _getArtifactBytes(String path) async {
    return _dio.get<List<int>>(
      path,
      options: Options(
        responseType: ResponseType.bytes,
        headers: _artifactAuthHeaders(path),
      ),
    );
  }

  Future<Response<List<int>>> _getArtifactBytesBounded(
    String path, {
    required int maxBytes,
  }) async {
    final cancelToken = CancelToken();
    var overLimit = false;
    try {
      return await _dio.get<List<int>>(
        path,
        options: Options(
          responseType: ResponseType.bytes,
          headers: _artifactAuthHeaders(path),
        ),
        cancelToken: cancelToken,
        onReceiveProgress: (received, total) {
          if (!overLimit &&
              ((total > 0 && total > maxBytes) || received > maxBytes)) {
            overLimit = true;
            cancelToken.cancel('artifact exceeds client byte ceiling');
          }
        },
      );
    } on DioException catch (error) {
      if (overLimit || error.type == DioExceptionType.cancel) {
        throw ArtifactTooLargeException(limit: maxBytes);
      }
      rethrow;
    }
  }

  Map<String, String> _artifactAuthHeaders(String resolvedUrl) {
    final target = Uri.tryParse(resolvedUrl);
    final broker = Uri.tryParse(_resolver.baseUrl);
    if (target == null || broker == null) return const <String, String>{};
    final sameOrigin = _sameOrigin(target, broker);
    return sameOrigin ? _resolver.authHeaders : const <String, String>{};
  }

  _ArtifactTicketIdentity? _canonicalArtifactIdentity(String resolvedUrl) {
    final target = Uri.tryParse(resolvedUrl);
    final broker = Uri.tryParse(_resolver.baseUrl);
    if (target == null || broker == null || !_sameOrigin(target, broker)) {
      return null;
    }
    final segments = target.pathSegments;
    if (segments.length != 6 ||
        segments[0] != 'api' ||
        segments[1] != 'sessions' ||
        segments[4] != 'artifact' ||
        segments
            .sublist(2)
            .any(
              (segment) => segment.isEmpty || segment.contains('/'),
            )) {
      return null;
    }
    return _ArtifactTicketIdentity(
      tool: segments[2],
      sessionId: segments[3],
      artifactId: segments[5],
    );
  }

  bool _sameOrigin(Uri target, Uri broker) {
    return target.scheme.toLowerCase() == broker.scheme.toLowerCase() &&
        target.host.toLowerCase() == broker.host.toLowerCase() &&
        target.port == broker.port;
  }

  bool _sameArtifactIdentity(
    _ArtifactTicketIdentity? left,
    _ArtifactTicketIdentity right,
  ) {
    return left != null &&
        left.tool == right.tool &&
        left.sessionId == right.sessionId &&
        left.artifactId == right.artifactId;
  }

  String _resolveArtifactUrl(String value) {
    final source = Uri.tryParse(value.trim());
    if (source == null || value.trim().isEmpty) {
      throw const BrokerException(message: 'Artifact fetch URL is invalid');
    }
    if (source.hasScheme) {
      return source.toString();
    }
    if (source.hasAuthority || !source.path.startsWith('/')) {
      throw const BrokerException(message: 'Artifact fetch URL is invalid');
    }
    return Uri.parse(_resolver.baseUrl).resolveUri(source).toString();
  }

  int? _parseContentLength(String? value) {
    if (value == null || value.isEmpty) {
      return null;
    }
    return int.tryParse(value);
  }

  String? _firstAvailableHeader(
    Headers headers,
    List<String> keys,
  ) {
    for (final key in keys) {
      final value = headers.value(key);
      if (value != null && value.isNotEmpty) {
        return value;
      }
    }
    return null;
  }

  String? _artifactKeyFromUrl(Uri uri) {
    final segments = uri.pathSegments;
    if (segments.isEmpty) {
      return null;
    }

    final artifactIndex = segments.indexWhere(
      (segment) => segment == 'artifact',
    );
    if (artifactIndex != -1 &&
        artifactIndex + 1 < segments.length &&
        segments[artifactIndex + 1].isNotEmpty) {
      return segments[artifactIndex + 1];
    }
    return null;
  }
}

class _ArtifactTicketIdentity {
  const _ArtifactTicketIdentity({
    required this.tool,
    required this.sessionId,
    required this.artifactId,
  });

  final String tool;
  final String sessionId;
  final String artifactId;
}

/// Result of a conditional roster snapshot request.
class ConditionalSessionListResult {
  const ConditionalSessionListResult._({
    required this.notModified,
    this.response,
    this.etag,
  });

  /// A fresh roster representation and its response ETag.
  const ConditionalSessionListResult.modified({
    required ListSessionsResponse response,
    String? etag,
  }) : this._(notModified: false, response: response, etag: etag);

  /// A 304 result carrying the ETag that matched.
  const ConditionalSessionListResult.notModified({String? etag})
    : this._(notModified: true, etag: etag);

  /// Whether the broker returned 304 without a roster body.
  final bool notModified;

  /// Fresh roster body when [notModified] is false.
  final ListSessionsResponse? response;

  /// Stable representation ETag, when advertised.
  final String? etag;
}

/// Expected cancellation when a roster surface leaves the foreground.
class RosterDeltaWaitCancelled implements Exception {
  /// Creates the expected foreground-lifecycle cancellation signal.
  const RosterDeltaWaitCancelled();
}

/// Expected cancellation of a request whose answer is no longer wanted.
///
/// Abandoned work, not a fault: callers should retire it silently rather than
/// classify it, report it, or record it as a freshness failure.
class RequestCancelled implements Exception {
  /// Creates the expected caller-initiated cancellation signal.
  const RequestCancelled();

  @override
  String toString() => 'The request was canceled by the caller.';
}

/// Thrown when the broker does not expose the attention feed endpoint.
class AttentionFeedUnsupportedException extends BrokerException {
  /// Creates an [AttentionFeedUnsupportedException].
  const AttentionFeedUnsupportedException({
    required super.message,
    super.statusCode,
    super.error,
  });
}
