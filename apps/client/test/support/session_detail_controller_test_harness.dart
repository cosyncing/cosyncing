import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_identity_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void keepSessionDetailAlive(ProviderContainer container, SessionDetailKey key) {
  final subscription = container.listen(
    sessionDetailControllerProvider(key),
    (previous, next) {},
    fireImmediately: true,
  );
  addTearDown(subscription.close);
}

Future<void> drainSessionDetailMicrotasks() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

const _controllerBrokerContract = BrokerContractIdentity(
  revision: cosyncingClientContractRevision,
  minimumClientRevision: 2,
  surfaceHash: cosyncingClientContractSurfaceHash,
);

/// Hello frame of a current broker.
///
/// DR1 draft publishing waits for this negotiation rather than assuming a
/// legacy last-writer-wins relay, so any test that asserts a draft relay has to
/// emit it — exactly as a real attach does.
const defaultControllerHello = HelloWireEvent(
  brokerVersion: '1.4.0',
  brokerContract: _controllerBrokerContract,
  compatibility: BrokerClientCompatibility(
    status: BrokerClientCompatibilityStatus.compatible,
    readOnly: false,
    reason: 'compatible',
    broker: _controllerBrokerContract,
  ),
);

/// DR1: a real in-memory Drift database for ad-hoc controller containers, so
/// the durable draft repository and bounded maintenance runner work with real
/// persistence instead of falling into `AppDatabase.defaults()`.
List<Override> dr1DurableDraftTestOverrides() {
  final database = AppDatabase(NativeDatabase.memory());
  addTearDown(database.close);
  return [appDatabaseProvider.overrideWithValue(database)];
}

ProviderContainer buildControllerContainer(
  SessionDetailKey key,
  FakeSessionDetailConnection connection,
  SessionAttachmentPicker picker, {
  FakeSessionDetailConnection Function()? nextConnection,
  SessionDraftRepository? draftRepository,
  SessionDraftKeepalive? draftKeepalive,
  SessionTranscriptRepository? transcriptRepository,
  AppDatabase? appDatabase,
  bool enableCrossWindowDraftObservation = false,
}) {
  return buildControllerContainerWithNotificationHooks(
    key: key,
    connection: connection,
    picker: picker,
    nextConnection: nextConnection,
    draftRepository: draftRepository,
    draftKeepalive: draftKeepalive,
    transcriptRepository: transcriptRepository,
    appDatabase: appDatabase,
    enableCrossWindowDraftObservation: enableCrossWindowDraftObservation,
  );
}

ProviderContainer buildControllerContainerWithNotificationHooks({
  required SessionDetailKey key,
  required FakeSessionDetailConnection connection,
  required SessionAttachmentPicker picker,
  BrokerAppLifecycleMonitor? lifecycleMonitor,
  BrokerNotificationSink? sink,
  BrokerIdentityStore? brokerIdentityStore,
  // Returns the connection the next attach should use. A profile switch
  // disposes the previous one, so tests that re-attach across brokers need a
  // fresh socket rather than the closed shared fake.
  FakeSessionDetailConnection Function()? nextConnection,
  // Wraps or replaces the Drift-backed draft repository, so a test can hold one
  // database operation open and land another mutation inside that window.
  SessionDraftRepository? draftRepository,
  // DR1b: the synchronous keepalive the composer records into. A test supplies
  // one over its own backing store to observe what a destroyed document would
  // have left behind, and to reconstruct a "next start" over the same backing.
  SessionDraftKeepalive? draftKeepalive,
  SessionTranscriptRepository? transcriptRepository,
  // Lets multi-window tests use separate controller containers over the same
  // observable Drift database, matching the browser shared-worker topology.
  AppDatabase? appDatabase,
  bool enableCrossWindowDraftObservation = false,
}) {
  // DR1: a real in-memory Drift database backs the draft repository and the
  // bounded maintenance runner, so durable draft behavior is exercised
  // end-to-end instead of mocked away.
  final database = appDatabase ?? AppDatabase(NativeDatabase.memory());
  if (appDatabase == null) {
    addTearDown(database.close);
  }
  return ProviderContainer(
    overrides: [
      appDatabaseProvider.overrideWithValue(database),
      activeBrokerProfileProvider.overrideWith(
        (ref) => fakeControllerBrokerProfile(),
      ),
      brokerClientProvider.overrideWith(
        (ref) async => FakeControllerBrokerClient(),
      ),
      sessionDetailConnectionFactoryProvider.overrideWithValue(
        ({required resolver, required sessionId, required tool}) {
          return (nextConnection?.call() ?? connection)
            ..sessionId = sessionId
            ..tool = tool;
        },
      ),
      sessionArtifactFileServiceProvider.overrideWithValue(
        FakeControllerArtifactFileService(),
      ),
      sessionAttachmentPickerProvider.overrideWithValue(picker),
      sessionArtifactTransferRepositoryProvider.overrideWithValue(
        InMemorySessionArtifactTransferRepository(),
      ),
      sessionOutboxRepositoryProvider.overrideWithValue(
        RecordingSessionOutboxRepository(),
      ),
      sessionTranscriptRepositoryProvider.overrideWithValue(
        transcriptRepository ?? RecordingSessionTranscriptRepository(),
      ),
      sessionNotificationLifecycleMonitorProvider.overrideWithValue(
        lifecycleMonitor ??
            StubBrokerAppLifecycleMonitor(
              currentState: BrokerAppLifecycleState.paused,
            ),
      ),
      sessionNotificationSinkProvider.overrideWithValue(
        sink ?? CollectingNotificationSink(),
      ),
      sessionDriveIntentStoreProvider.overrideWithValue(
        InMemoryControllerDriveIntentStore(),
      ),
      if (brokerIdentityStore != null)
        brokerIdentityStoreProvider.overrideWithValue(brokerIdentityStore),
      if (draftKeepalive != null)
        sessionDraftKeepaliveProvider.overrideWithValue(draftKeepalive),
      if (draftRepository != null)
        sessionDraftRepositoryProvider.overrideWithValue(draftRepository)
      else if (draftKeepalive != null)
        sessionDraftRepositoryProvider.overrideWithValue(
          DriftSessionDraftRepository(database, keepalive: draftKeepalive),
        ),
      if (enableCrossWindowDraftObservation)
        sessionDraftCrossWindowObservationEnabledProvider.overrideWithValue(
          true,
        ),
    ],
  );
}

final class RecordingBrokerIdentityStore implements BrokerIdentityStore {
  final healthByProfile = <String, HealthResponse>{};
  final helloByProfile = <String, HelloWireEvent>{};

  @override
  Future<HealthResponse?> read(String brokerProfileId) async =>
      healthByProfile[brokerProfileId];

  @override
  Future<void> write(String brokerProfileId, HealthResponse health) async {
    healthByProfile[brokerProfileId] = health;
  }

  @override
  Future<HelloWireEvent?> readHello(String brokerProfileId) async =>
      helloByProfile[brokerProfileId];

  @override
  Future<void> writeHello(
    String brokerProfileId,
    HelloWireEvent hello,
  ) async {
    helloByProfile[brokerProfileId] = hello;
  }
}

final class CollectingNotificationSink implements BrokerNotificationSink {
  CollectingNotificationSink({this.shouldThrowOnShow = false});

  final bool shouldThrowOnShow;
  final List<BrokerNotificationRequest> requests = [];
  final List<String> cleared = [];
  bool clearAllCalled = false;

  @override
  Future<void> show(BrokerNotificationRequest request) async {
    requests.add(request);
    if (shouldThrowOnShow) {
      throw StateError('show failed');
    }
  }

  @override
  Future<void> clear(String id) async {
    cleared.add(id);
  }

  @override
  Future<void> clearMany(Iterable<String> ids) async {
    cleared.addAll(ids);
  }

  @override
  Future<void> clearAll() async {
    clearAllCalled = true;
  }
}

final class StubBrokerAppLifecycleMonitor implements BrokerAppLifecycleMonitor {
  StubBrokerAppLifecycleMonitor({required this.currentState});

  @override
  BrokerAppLifecycleState currentState;

  @override
  Stream<BrokerAppLifecycleState> get stateChanges =>
      const Stream<BrokerAppLifecycleState>.empty();

  @override
  void dispose() {}
}

/// The active profile controller tests attach against.
///
/// [baseUri] is a parameter because a profile is an editable POINTER: the same
/// id can be re-pointed at another machine, and every guard keyed on the id
/// alone was blind to that edit.
/// Scope key (`RosterSource.storageKey`) the controller uses for broker-bound
/// rows written under [fakeControllerBrokerProfile] — what a test must pass to
/// read or seed transcript, draft, Drive-provenance, intent, and outbox rows
/// the controller will see as its own.
String fakeControllerBrokerScope({Uri? baseUri}) => RosterSource.ofProfile(
  fakeControllerBrokerProfile(baseUri: baseUri),
).storageKey;

BrokerProfile fakeControllerBrokerProfile({Uri? baseUri}) {
  final now = DateTime(2026, 6, 26);
  return BrokerProfile(
    id: 'local',
    displayName: 'local',
    baseUri: baseUri ?? Uri.parse('http://127.0.0.1:7734'),
    createdAt: now,
  );
}

AgentInfo fakeControllerAgentInfo({
  bool canTranscriptExport = true,
  bool canFork = true,
  bool canClone = true,
}) {
  return AgentInfo(
    id: 'claude',
    displayName: 'Claude',
    capabilities: const AgentCapabilities(
      integrationKind: IntegrationKind.sdkCallback,
      attachModes: [AttachMode.observe, AttachMode.resume],
      supportsObserve: true,
      supportsResume: true,
      supportsLiveAttach: false,
      supportsNativeArtifact: true,
      supportsNativeFileInput: true,
      supportsModelSwitch: true,
      permissionGranularity: PermissionGranularity.perTool,
    ),
    canCreateSession: true,
    canRenameNative: true,
    canFork: canFork,
    canClone: canClone,
    canTranscriptExport: canTranscriptExport,
  );
}

class FakeControllerBrokerClient extends BrokerClient {
  FakeControllerBrokerClient() : super(baseUrl: 'http://127.0.0.1:7734');

  List<AgentInfo> agents = [fakeControllerAgentInfo()];
  Object? prepareError;
  Object? exportError;
  Object? forkError;
  Object? cloneError;
  Object? renameError;
  int listAgentsCount = 0;
  int prepareTranscriptExportCount = 0;
  int exportTranscriptCount = 0;
  int forkSessionCount = 0;
  int cloneSessionCount = 0;
  int renameSessionCount = 0;
  int initUploadCount = 0;
  int completeUploadCount = 0;
  final patchOffsets = <int>[];
  String? lastExportNonce;
  String? lastForkTool;
  String? lastForkSessionId;
  String? lastForkMessageId;
  String? lastCloneTool;
  String? lastCloneSessionId;
  String? lastRenameTitle;
  UploadCompleteResult uploadCompleteResult = const UploadCompleteResult(
    uploadId: 'upload-1',
    stagedRef: 'stg1.fixture',
    name: 'uploaded.bin',
    mimeType: '',
    size: 0,
    expiresAt: 1783590000000,
  );

  @override
  Future<List<AgentInfo>> listAgents() async {
    listAgentsCount++;
    return agents;
  }

  @override
  Future<TranscriptExportPreflightResponse> prepareTranscriptExport(
    String tool,
    String id,
  ) async {
    prepareTranscriptExportCount++;
    if (prepareError != null) {
      Error.throwWithStackTrace(prepareError!, StackTrace.current);
    }
    return const TranscriptExportPreflightResponse(
      ok: true,
      nonce: 'nonce-1',
      expiresAt: 1783590000000,
      confirm: TranscriptExportConfirm(
        action: 'transcriptExport',
        tool: 'claude',
        sessionId: 'session-1',
        sessionTitle: 'Main Session',
        format: 'html',
        redactionMode: 'redacted-full',
        tier: 'local',
        retentionMinutes: 30,
        sizeCapBytes: 5242880,
        irreversible: false,
        message: 'Download the FULL transcript as a redacted HTML file.',
      ),
    );
  }

  @override
  Future<TranscriptExportResponse> exportTranscript(
    String tool,
    String id, {
    required String nonce,
  }) async {
    exportTranscriptCount++;
    lastExportNonce = nonce;
    if (exportError != null) {
      Error.throwWithStackTrace(exportError!, StackTrace.current);
    }
    return const TranscriptExportResponse(
      ok: true,
      artifact: SessionArtifact(
        name: 'main-session.html',
        mimeType: 'text/html',
        size: 2048,
        fetchUrl:
            'http://127.0.0.1:7734/api/sessions/claude/session-1/artifact/export-1',
        artifactKey: 'export-1',
        deliveryClass: 'export-attachment',
        format: 'html',
        redactionSummary: '3 secrets redacted',
        expiresAt: 1783590000000,
      ),
    );
  }

  @override
  Future<ForkSessionResponse> forkSession(
    String tool,
    String id, {
    String? messageId,
  }) async {
    forkSessionCount++;
    lastForkTool = tool;
    lastForkSessionId = id;
    lastForkMessageId = messageId;
    if (forkError != null) {
      Error.throwWithStackTrace(forkError!, StackTrace.current);
    }

    return ForkSessionResponse(
      ok: true,
      session: SessionInfo.fromJson(
        const {
          'id': 'session-1-fork',
          'tool': 'claude',
          'title': 'Forked Session',
          'status': 'idle',
          'attachMode': 'observe',
        },
      ),
    );
  }

  @override
  Future<RenameSessionResponse> renameSession(
    String tool,
    String id,
    String? title,
  ) async {
    renameSessionCount++;
    lastRenameTitle = title;
    if (renameError != null) {
      Error.throwWithStackTrace(renameError!, StackTrace.current);
    }
    return RenameSessionResponse(ok: true, title: title);
  }

  @override
  Future<CloneSessionResponse> cloneSession(String tool, String id) async {
    cloneSessionCount++;
    lastCloneTool = tool;
    lastCloneSessionId = id;
    if (cloneError != null) {
      Error.throwWithStackTrace(cloneError!, StackTrace.current);
    }

    return CloneSessionResponse(
      ok: true,
      session: SessionInfo.fromJson(
        const {
          'id': 'session-1-clone',
          'tool': 'claude',
          'title': 'Cloned Session',
          'status': 'idle',
          'attachMode': 'observe',
        },
      ),
    );
  }

  @override
  Future<UploadInitResult> initUpload(
    String tool,
    String id, {
    required String name,
    String? mimeType,
    int? size,
    String? contentHash,
  }) async {
    initUploadCount++;
    return UploadInitResult(
      uploadId: 'upload-1',
      offset: 0,
      size: size ?? 0,
      expiresAt: 1783590000000,
    );
  }

  @override
  Future<UploadPatchResult> patchUploadChunk(
    String tool,
    String id,
    String uploadId, {
    required int offset,
    required List<int> bytes,
  }) async {
    patchOffsets.add(offset);
    return UploadPatchResult(
      uploadId: uploadId,
      offset: offset + bytes.length,
      size: uploadCompleteResult.size,
      progress: uploadCompleteResult.size == 0
          ? 1
          : (offset + bytes.length) / uploadCompleteResult.size,
    );
  }

  @override
  Future<UploadCompleteResult> completeUpload(
    String tool,
    String id,
    String uploadId,
  ) async {
    completeUploadCount++;
    return uploadCompleteResult;
  }

  @override
  void close() {}
}

ProviderContainer productionControllerContainer() {
  return ProviderContainer(
    overrides: [
      activeBrokerProfileProvider.overrideWith(
        (ref) => fakeControllerBrokerProfile(),
      ),
    ],
  );
}

final class TrackingWebSocketAdapter extends FakeWebSocketAdapter {
  bool connectCalled = false;

  @override
  Future<void> connect() async {
    connectCalled = true;
    await super.connect();
  }
}

class FakeControllerArtifactFileService implements SessionArtifactFileService {
  SessionArtifactCachedFile? mockCachedFile;
  int cacheCallCount = 0;
  int exportCallCount = 0;
  String? exportedPath;
  bool shouldThrowOnCache = false;
  bool shouldThrowOnExport = false;

  @override
  Future<SessionArtifactCachedFile> cacheArtifact(
    SessionArtifactDescriptor descriptor, {
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    cacheCallCount++;
    if (shouldThrowOnCache) {
      throw Exception('cache failed');
    }
    return mockCachedFile ??
        SessionArtifactCachedFile(
          cachedFilePath: descriptor.name ?? 'artifact.bin',
          fileName: descriptor.name ?? 'artifact.bin',
          byteLength: 0,
        );
  }

  @override
  Future<SessionArtifactCachedFile> cacheSessionFile({
    required String tool,
    required String sessionId,
    required String path,
    required String fileName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    return SessionArtifactCachedFile(
      cachedFilePath: fileName,
      fileName: fileName,
      contentType: mimeType,
      byteLength: 0,
    );
  }

  @override
  Future<String?> exportCachedArtifact(
    SessionArtifactCachedFile artifact, {
    SessionArtifactCancellationToken? cancellationToken,
  }) async {
    exportCallCount++;
    if (shouldThrowOnExport) {
      throw Exception('export failed');
    }
    return exportedPath;
  }
}

class FakeControllerAttachmentPicker implements SessionAttachmentPicker {
  SessionAttachment? selectedAttachment = const SessionAttachment(
    name: 'notes.txt',
    data: 'aGVsbG8=',
    byteLength: 5,
    mimeType: 'text/plain',
  );
  List<SessionAttachment>? selectedAttachments;

  int pickCount = 0;

  @override
  Future<List<SessionAttachment>> pickAttachments({
    bool allowMultiple = true,
  }) async {
    pickCount++;
    if (selectedAttachments case final selected?) {
      return selected;
    }
    return selectedAttachment == null ? const [] : [selectedAttachment!];
  }
}

class ThrowingSessionAttachmentPicker extends FakeControllerAttachmentPicker {
  @override
  Future<List<SessionAttachment>> pickAttachments({
    bool allowMultiple = true,
  }) async {
    throw Exception('attachment picker failed');
  }
}

class FakeSessionDetailConnection
    implements SessionDetailConnection, SessionHistoryConnection {
  final _stateController =
      StreamController<SessionDetailConnectionStatus>.broadcast();
  final _eventController = StreamController<WireEvent>.broadcast();

  int connectCount = 0;
  int closeCount = 0;
  int disposeCount = 0;
  final List<String?> reattachModes = [];
  final List<String?> reattachReasons = [];
  int disarmDriveAuthorityCount = 0;
  int sendPromptCount = 0;
  int sendDraftCount = 0;

  /// Throws from [sendDraft] this many times — a transport whose socket is
  /// mid-close still counts the attempt before failing it.
  int failNextSendDrafts = 0;

  Completer<void>? _sendDraftGate;

  /// Holds the next [sendDraft] open until the returned completer fires, so a
  /// test can interleave work while a draft frame is in flight.
  Completer<void> holdNextSendDraft() => _sendDraftGate = Completer<void>();
  int sendPlanActionCount = 0;
  int sendArtifactInteractionCount = 0;
  int sendAckCount = 0;
  int sendNackCount = 0;
  int sendPermissionDecisionCount = 0;
  int sendSetAgentCount = 0;
  int sendQuestionAnswerCount = 0;
  int rejectQuestionCount = 0;
  int sendCommandCount = 0;
  int sendFileCount = 0;
  bool? lastReconnect;
  bool failNextPrompt = false;
  bool failNextPermissionDecision = false;
  bool failNextSetAgent = false;
  bool failNextQuestionAnswer = false;
  bool failNextRejectQuestion = false;
  bool failNextCommand = false;
  bool failNextFile = false;
  bool failNextReattach = false;
  String? tool;
  String? sessionId;
  String? lastPrompt;
  String? lastDraft;
  String? lastDraftUpdateId;
  int? lastDraftBaseRevision;
  PlanActionRequest? lastPlanAction;
  ArtifactInteractionRequest? lastArtifactInteraction;
  String? lastProtocolTicket;
  String? seededHistoryCursor;
  String? lastHistoryPageCursor;
  int? lastHistoryPageLimit;
  String? lastHistoryPageClientMessageId;
  int historyPageRequestCount = 0;
  SessionCurrentModel? lastPromptModel;
  List<PromptFileAttachment> lastPromptFiles = const [];
  String? lastPromptClientMessageId;
  int? lastPromptDraftRevision;
  String? lastPromptDraftUpdateId;
  String? lastCommandName;
  String? lastCommandClientMessageId;
  Map<String, dynamic>? lastCommandArgs;
  SessionCurrentModel? lastCommandModel;
  String? lastFileName;
  String? lastFileData;
  String? lastFileMimeType;
  String? lastPermissionDecisionRequestId;
  String? lastPermissionDecision;
  String? lastSetAgent;
  String? lastQuestionRequestId;
  List<List<String>>? lastQuestionAnswers;
  String? lastRejectQuestionRequestId;
  void Function()? onSendPrompt;
  Future<void> Function()? onSendCommand;

  SessionDetailConnectionStatus _state =
      SessionDetailConnectionStatus.disconnected;

  @override
  SessionDetailConnectionStatus get state => _state;

  @override
  Stream<SessionDetailConnectionStatus> get stateStream =>
      _stateController.stream;

  @override
  Stream<WireEvent> get events => _eventController.stream;

  @override
  void seedHistoryCursor(String cursor) {
    seededHistoryCursor = cursor;
  }

  @override
  Future<void> requestHistoryPage({
    required String cursor,
    int? limit,
    String? clientMessageId,
  }) async {
    historyPageRequestCount++;
    lastHistoryPageCursor = cursor;
    lastHistoryPageLimit = limit;
    lastHistoryPageClientMessageId = clientMessageId;
  }

  @override
  Future<void> connect() async {
    connectCount++;
    _setState(SessionDetailConnectionStatus.connecting);
    _setState(SessionDetailConnectionStatus.connected);
  }

  @override
  Future<void> close({bool reconnect = false}) async {
    closeCount++;
    lastReconnect = reconnect;
    _setState(SessionDetailConnectionStatus.closed);
  }

  @override
  Future<void> reattach({String? mode, String? reason}) async {
    reattachModes.add(mode);
    reattachReasons.add(reason);
    if (failNextReattach) {
      failNextReattach = false;
      throw Exception('reattach failed');
    }
    _setState(SessionDetailConnectionStatus.connecting);
    _setState(SessionDetailConnectionStatus.connected);
  }

  @override
  void disarmDriveAuthority() {
    disarmDriveAuthorityCount++;
  }

  void emitSessionControl(
    Map<String, dynamic> control, {
    String status = 'idle',
  }) {
    emitEvent(
      SessionWireEvent(
        info: SessionInfo.fromJson({
          'id': sessionId ?? 'session-1',
          'tool': tool ?? 'claude',
          'title': 'Controller test',
          'status': status,
          'attachMode': 'observe',
          'control': control,
        }),
      ),
    );
  }

  @override
  Future<void> sendPrompt(
    String text, {
    SessionCurrentModel? model,
    String? clientMessageId,
    int? draftRevision,
    String? draftUpdateId,
    List<PromptFileAttachment> files = const [],
  }) async {
    sendPromptCount++;
    lastPrompt = text;
    lastPromptModel = model;
    lastPromptFiles = files;
    lastPromptClientMessageId = clientMessageId;
    lastPromptDraftRevision = draftRevision;
    lastPromptDraftUpdateId = draftUpdateId;
    onSendPrompt?.call();
    if (failNextPrompt) {
      failNextPrompt = false;
      throw Exception('prompt failed');
    }
  }

  @override
  Future<void> sendDraft(
    String text, {
    String? updateId,
    int? baseRevision,
  }) async {
    final gate = _sendDraftGate;
    if (gate != null) {
      _sendDraftGate = null;
      await gate.future;
    }
    sendDraftCount++;
    lastDraft = text;
    lastDraftUpdateId = updateId;
    lastDraftBaseRevision = baseRevision;
    if (failNextSendDrafts > 0) {
      failNextSendDrafts--;
      throw StateError('draft frame failed');
    }
  }

  @override
  Future<void> sendPlanAction(
    PlanActionRequest request, {
    String? clientMessageId,
  }) async {
    sendPlanActionCount++;
    lastPlanAction = request;
  }

  @override
  Future<void> sendArtifactInteraction(
    ArtifactInteractionRequest request, {
    String? clientMessageId,
  }) async {
    sendArtifactInteractionCount++;
    lastArtifactInteraction = request;
  }

  @override
  Future<void> sendAck(
    String attachTicket, {
    String? clientMessageId,
  }) async {
    sendAckCount++;
    lastProtocolTicket = attachTicket;
  }

  @override
  Future<void> sendNack(
    String attachTicket, {
    String? clientMessageId,
  }) async {
    sendNackCount++;
    lastProtocolTicket = attachTicket;
  }

  @override
  Future<void> sendPermissionDecision(
    String requestId,
    String decision, {
    String? clientMessageId,
  }) async {
    sendPermissionDecisionCount++;
    lastPermissionDecisionRequestId = requestId;
    lastPermissionDecision = decision;
    if (failNextPermissionDecision) {
      failNextPermissionDecision = false;
      throw Exception('permission failed');
    }
  }

  @override
  Future<void> sendSetAgent(
    String agent, {
    String? clientMessageId,
  }) async {
    sendSetAgentCount++;
    lastSetAgent = agent;
    if (failNextSetAgent) {
      failNextSetAgent = false;
      throw Exception('set agent failed');
    }
  }

  @override
  Future<void> sendQuestionAnswer(
    String requestId,
    List<List<String>> answers, {
    String? clientMessageId,
  }) async {
    sendQuestionAnswerCount++;
    lastQuestionRequestId = requestId;
    lastQuestionAnswers = answers;
    if (failNextQuestionAnswer) {
      failNextQuestionAnswer = false;
      throw Exception('question answer failed');
    }
  }

  @override
  Future<void> rejectQuestion(
    String requestId, {
    String? clientMessageId,
  }) async {
    rejectQuestionCount++;
    lastRejectQuestionRequestId = requestId;
    if (failNextRejectQuestion) {
      failNextRejectQuestion = false;
      throw Exception('reject question failed');
    }
  }

  @override
  Future<void> sendCommand(
    String name, {
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? clientMessageId,
  }) async {
    sendCommandCount++;
    lastCommandName = name;
    lastCommandClientMessageId = clientMessageId;
    lastCommandArgs = args;
    lastCommandModel = model;
    await onSendCommand?.call();
    if (failNextCommand) {
      failNextCommand = false;
      throw Exception('command failed');
    }
  }

  @override
  Future<void> sendFile({
    required String name,
    required String data,
    String? mimeType,
    String? clientMessageId,
  }) async {
    sendFileCount++;
    lastFileName = name;
    lastFileData = data;
    lastFileMimeType = mimeType;
    if (failNextFile) {
      failNextFile = false;
      throw Exception('file failed');
    }
  }

  @override
  Future<void> dispose() async {
    disposeCount++;
    await _stateController.close();
    await _eventController.close();
  }

  void emitEvent(WireEvent event) {
    _eventController.add(event);
  }

  void emitState(SessionDetailConnectionStatus state) {
    _setState(state);
  }

  void _setState(SessionDetailConnectionStatus state) {
    _state = state;
    _stateController.add(state);
  }
}

class InMemoryControllerDriveIntentStore implements SessionDriveIntentStore {
  final Map<String, SessionDriveProvenanceKind> intents =
      <String, SessionDriveProvenanceKind>{};
  int rememberCount = 0;
  int takeoverRefreshCount = 0;
  int clearCount = 0;
  bool failClear = false;
  bool failRead = false;

  String _key(String tool, String sessionId) => '$tool/$sessionId';

  /// Legacy-shaped seeding helper: records a takeover lease, matching the
  /// pre-provenance store's single intent kind.
  void seedTakeover(String tool, String sessionId) {
    intents[_key(tool, sessionId)] =
        SessionDriveProvenanceKind.terminalTakeover;
  }

  void seedAppCreated(String tool, String sessionId) {
    intents[_key(tool, sessionId)] = SessionDriveProvenanceKind.appCreated;
  }

  @override
  Future<SessionDriveProvenance?> read({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {
    if (failRead) {
      throw StateError('Drive-intent storage unavailable');
    }
    final kind = intents[_key(tool, sessionId)];
    if (kind == null) return null;
    return SessionDriveProvenance(kind: kind, recordedAt: DateTime.now());
  }

  @override
  Future<void> rememberAppCreated({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {
    rememberCount++;
    intents[_key(tool, sessionId)] = SessionDriveProvenanceKind.appCreated;
  }

  @override
  Future<void> rememberTakeover({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {
    rememberCount++;
    takeoverRefreshCount++;
    final existing = intents[_key(tool, sessionId)];
    intents[_key(
      tool,
      sessionId,
    )] = existing == SessionDriveProvenanceKind.appCreated
        ? SessionDriveProvenanceKind.appCreated
        : SessionDriveProvenanceKind.terminalTakeover;
  }

  @override
  Future<void> clear({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {
    clearCount++;
    if (failClear) {
      throw StateError('Drive-intent storage unavailable');
    }
    intents.remove(_key(tool, sessionId));
  }
}

class StubSessionListController extends SessionListController {
  int loadCount = 0;

  @override
  SessionListState build() => const SessionListState();

  void setSessions(List<SessionInfo> sessions) {
    state = SessionListState(
      status: SessionListStatus.loaded,
      sessions: sessions,
    );
  }

  @override
  Future<void> load({bool silent = false}) async {
    loadCount += 1;
  }
}

class RecordingSessionTranscriptRepository
    implements SessionTranscriptRepository {
  SessionTranscriptSnapshot? stored;
  final List<SessionTranscriptSnapshot> upserts = [];
  SessionCacheWriteFence? writeFence;
  Completer<void>? pendingUpsert;
  bool failUpsert = false;

  @override
  Future<SessionTranscriptSnapshot?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) async {
    final snapshot = stored;
    if (snapshot == null ||
        snapshot.brokerProfileId != brokerProfileId ||
        snapshot.sessionKey != sessionKey) {
      return null;
    }
    return snapshot;
  }

  @override
  Future<void> upsert(SessionTranscriptSnapshot snapshot) {
    Future<void> operation() async {
      upserts.add(snapshot);
      if (failUpsert) throw StateError('transcript store unavailable');
      final pending = pendingUpsert;
      if (pending != null) await pending.future;
      stored = snapshot;
    }

    return writeFence?.write(operation) ?? operation();
  }
}

class RecordingSessionOutboxRepository implements SessionOutboxRepository {
  final messages = <SessionOutboxMessage>[];

  /// Runs inside the durable insert, so a test can land a broker frame in the
  /// exact window between persisting a send and dispatching it.
  Future<void> Function()? onUpsert;

  /// Runs inside [loadForSession] before it answers, so a test can hold a
  /// recovery read open — e.g. across a profile switch.
  Future<void> Function()? onLoadForSession;

  @override
  Future<void> remove(String clientMessageId) async {
    messages.removeWhere(
      (message) => message.clientMessageId == clientMessageId,
    );
  }

  @override
  Future<void> upsert(SessionOutboxMessage message) async {
    await onUpsert?.call();
    final index = messages.indexWhere(
      (item) => item.clientMessageId == message.clientMessageId,
    );
    if (index < 0) {
      messages.add(message);
    } else {
      messages[index] = message;
    }
  }

  @override
  Future<List<SessionOutboxMessage>> loadForSession(
    SessionDetailKey sessionKey, {
    String? brokerProfileId,
  }) async {
    await onLoadForSession?.call();
    return messages
        .where(
          (message) =>
              message.sessionKey == sessionKey &&
              (brokerProfileId == null ||
                  message.brokerProfileId == brokerProfileId),
        )
        .toList(growable: false);
  }

  @override
  Future<List<SessionOutboxMessage>> loadRetryableForSession(
    SessionDetailKey sessionKey, {
    String? brokerProfileId,
    DateTime? now,
  }) async {
    final clock = now ?? DateTime.now();
    return messages
        .where(
          (message) =>
              message.sessionKey == sessionKey &&
              (brokerProfileId == null ||
                  message.brokerProfileId == brokerProfileId) &&
              message.isRetryableAt(clock),
        )
        .toList(growable: false);
  }

  @override
  Future<void> markDelivered(String clientMessageId) {
    return _update(
      clientMessageId,
      (message) => message.copyWith(
        status: SessionOutboxMessageStatus.delivered,
        updatedAt: DateTime.now(),
        clearError: true,
      ),
    );
  }

  @override
  Future<void> markFailed(String clientMessageId, String error) {
    return _update(
      clientMessageId,
      (message) => message.copyWith(
        status: SessionOutboxMessageStatus.failed,
        lastError: error,
        updatedAt: DateTime.now(),
      ),
    );
  }

  @override
  Future<void> markRetryable(String clientMessageId, String error) {
    return _update(
      clientMessageId,
      (message) => message.copyWith(
        status: SessionOutboxMessageStatus.retryable,
        lastError: error,
        updatedAt: DateTime.now(),
      ),
    );
  }

  @override
  Future<void> markSending(String clientMessageId) {
    return _update(
      clientMessageId,
      (message) => message.copyWith(
        status: SessionOutboxMessageStatus.sending,
        attemptCount: message.attemptCount + 1,
        updatedAt: DateTime.now(),
        clearError: true,
      ),
    );
  }

  SessionOutboxMessage? messageById(String clientMessageId) {
    for (final message in messages) {
      if (message.clientMessageId == clientMessageId) {
        return message;
      }
    }
    return null;
  }

  Future<void> _update(
    String clientMessageId,
    SessionOutboxMessage Function(SessionOutboxMessage message) update,
  ) async {
    final index = messages.indexWhere(
      (message) => message.clientMessageId == clientMessageId,
    );
    if (index >= 0) {
      messages[index] = update(messages[index]);
    }
  }
}
