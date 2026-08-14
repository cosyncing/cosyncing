import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_controller.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:dio/dio.dart' show CancelToken;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'in_memory_session_display_preferences_store.dart';
import 'in_memory_session_live_state_view_store.dart';

/// The active broker profile widget tests attach against.
///
/// [baseUri] is a parameter because a profile is an editable POINTER: the same
/// id can be re-pointed at another machine, and qualification has to survive
/// that edit.
/// Scope key (`RosterSource.storageKey`) broker-bound rows are stored under
/// for [createTestBrokerProfile] — what widget tests must use to seed or read
/// transcript, draft, provenance, and outbox rows the page will see as its own.
String testBrokerScope({Uri? baseUri}) => RosterSource.ofProfile(
  createTestBrokerProfile(baseUri: baseUri),
).storageKey;
BrokerProfile createTestBrokerProfile({Uri? baseUri}) {
  final now = DateTime(2026, 6, 27);
  return BrokerProfile(
    id: 'local',
    displayName: 'local',
    baseUri: baseUri ?? Uri.parse('http://127.0.0.1:7734'),
    createdAt: now,
  );
}

Widget buildSessionDetailTestPage({
  required List<WireEvent> events,
  String tool = 'claude',
  bool autoConnect = true,
  String sessionId = 'session-1',
  ScriptedSessionDetailConnection? connection,
  SessionDetailConnectionFactory? connectionFactory,
  bool withActiveBrokerClient = true,
  List<SessionArtifactTransfer>? artifactTransfers,
  SessionArtifactFileService? artifactFileService,
  SessionAttachmentPicker? attachmentPicker,
  SessionAttachmentClipboard? attachmentClipboard,
  LocalTransferFileOpener? localTransferFileOpener,
  BrokerClient? brokerClient,
  Future<BrokerClient?> Function(Ref ref)? brokerClientLoader,
  SpeechInput? speechInput,
  SpeechOutput? speechOutput,
  SessionControlPreferencesStore? controlPreferencesStore,
  SessionDriveIntentStore? driveIntentStore,
  SessionModelPreferenceStore? modelPreferenceStore,
  SessionLiveStateViewStore? liveStateViewStore,
  OpenSessionsStore? openSessionsStore,
  SessionDetailState? initialState,
  SeededSessionDetailController? seededController,
  SessionTranscriptRepository? transcriptRepository,
  SessionDraftRepository? draftRepository,
  bool embedded = false,
  bool showDebugViews = false,
  ThemeData? theme,
  double textScale = 1,
  DiffBodyLoader? diffBodyLoader,
  AppDatabase? database,
  CredentialStore? credentialStore,
  Locale? locale,
  BrokerProfile? brokerProfile,
  SessionViewportSeed? viewportSeed,
  List<Override> extraOverrides = const [],
  List<ProviderObserver> observers = const [],
  Widget Function(Widget sessionDetailPage)? homeBuilder,
}) {
  final effectiveBrokerProfile = brokerProfile ?? createTestBrokerProfile();
  final scriptedConnection =
      connection ??
      ScriptedSessionDetailConnection(
        events: events,
        autoConnect: autoConnect,
      );
  // DR1: a real in-memory Drift database backs the draft repository and the
  // bounded maintenance runner so widget tests exercise durable drafts.
  final effectiveDatabase = database ?? AppDatabase(NativeDatabase.memory());
  addTearDown(effectiveDatabase.close);
  final overrides = <Override>[
    appDatabaseProvider.overrideWithValue(effectiveDatabase),
    if (credentialStore != null)
      credentialStoreProvider.overrideWithValue(credentialStore),
    if (viewportSeed != null)
      sessionViewportRegistryProvider.overrideWith(
        () => _SeededSessionViewportRegistry(
          key: SessionViewportKey.forSource(
            source: RosterSource.ofProfile(effectiveBrokerProfile),
            tool: tool,
            sessionId: sessionId,
          ),
          seed: viewportSeed,
        ),
      ),
    if (seededController != null)
      sessionDetailControllerProvider.overrideWith(() => seededController)
    else if (initialState != null)
      sessionDetailControllerProvider.overrideWith(
        () => SeededSessionDetailController(initialState),
      ),
    // A custom factory dispenses one connection PER attach — what an
    // endpoint-edit test needs to prove the new broker gets its own socket.
    // The default pins every attach to the single scripted connection.
    sessionDetailConnectionFactoryProvider.overrideWithValue(
      connectionFactory ??
          ({required resolver, required sessionId, required tool}) =>
              scriptedConnection,
    ),
    brokerClientProvider.overrideWith(
      brokerClientLoader ??
          (ref) async => withActiveBrokerClient
              ? brokerClient ?? FakeBrokerClient()
              : null,
    ),
    if (withActiveBrokerClient)
      activeBrokerProfileProvider.overrideWith(
        (ref) => effectiveBrokerProfile,
      )
    else
      activeBrokerProfileProvider.overrideWith((ref) => null),
    sessionArtifactTransferRepositoryProvider.overrideWithValue(
      InMemorySessionArtifactTransferRepository(),
    ),
    // Outbox/transcript/drafts share ONE real in-memory database so durable
    // handoff flows see each other's rows, exactly like production wiring.
    sessionOutboxRepositoryProvider.overrideWithValue(
      DriftSessionOutboxRepository(effectiveDatabase),
    ),
    sessionTranscriptRepositoryProvider.overrideWithValue(
      transcriptRepository ??
          DriftSessionTranscriptRepository(effectiveDatabase),
    ),
    if (draftRepository != null)
      sessionDraftRepositoryProvider.overrideWithValue(draftRepository),
    sessionNotificationSettingsStoreProvider.overrideWithValue(
      InMemorySessionNotificationSettingsStore(),
    ),
    sessionDisplayPreferencesStoreProvider.overrideWithValue(
      InMemorySessionDisplayPreferencesStore(),
    ),
    sessionControlPreferencesStoreProvider.overrideWithValue(
      controlPreferencesStore ?? InMemorySessionControlPreferencesStore(),
    ),
    sessionDriveIntentStoreProvider.overrideWithValue(
      driveIntentStore ?? InMemorySessionDriveIntentStore(),
    ),
    sessionModelPreferenceStoreProvider.overrideWithValue(
      modelPreferenceStore ?? InMemorySessionModelPreferenceStore(),
    ),
    sessionLiveStateViewStoreProvider.overrideWithValue(
      liveStateViewStore ?? InMemorySessionLiveStateViewStore(),
    ),
    openSessionsStoreProvider.overrideWithValue(
      openSessionsStore ?? InMemoryOpenSessionsStore(),
    ),
    if (diffBodyLoader != null)
      diffBodyLoaderProvider.overrideWithValue(diffBodyLoader),
    if (artifactFileService != null)
      sessionArtifactFileServiceProvider.overrideWithValue(
        artifactFileService,
      ),
    if (attachmentPicker != null)
      sessionAttachmentPickerProvider.overrideWithValue(
        attachmentPicker,
      ),
    if (attachmentClipboard != null)
      sessionAttachmentClipboardProvider.overrideWithValue(
        attachmentClipboard,
      ),
    if (artifactTransfers != null)
      sessionArtifactTransferControllerProvider.overrideWith(
        () => SeededSessionArtifactTransferController(artifactTransfers),
      ),
    if (localTransferFileOpener != null)
      localTransferFileOpenerProvider.overrideWithValue(
        localTransferFileOpener,
      ),
    if (speechInput != null)
      speechInputFactoryProvider.overrideWithValue(() => speechInput),
    if (speechOutput != null)
      speechOutputFactoryProvider.overrideWithValue(() => speechOutput),
    uiPreferencesStoreProvider.overrideWithValue(
      _HarnessUiPreferencesStore(showDebugViews: showDebugViews),
    ),
    ...extraOverrides,
  ];
  final Widget sessionDetailPage = SessionDetailPage(
    tool: tool,
    sessionId: sessionId,
    embedded: embedded,
  );
  return ProviderScope(
    overrides: overrides,
    observers: observers,
    child: MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      // Left null by default so tests keep resolving the system locale, as
      // before. Pass one to assert that a string is genuinely localized rather
      // than merely centralized in the ARB.
      locale: locale,
      theme:
          theme ??
          ThemeData(
            splashFactory: InkRipple.splashFactory,
            extensions: [themeSpecById(kDefaultThemeId).light],
          ),
      // homeBuilder lets lifecycle tests wrap the page in the widgets that
      // own it in production — a credential gate barrier, the open-session
      // supervisor — without duplicating this harness's override wiring.
      home: _maybeScaleText(
        textScale,
        homeBuilder == null
            ? sessionDetailPage
            : homeBuilder(sessionDetailPage),
      ),
    ),
  );
}

/// Semantic viewport seed for transcript restoration widget tests.
final class SessionViewportSeed {
  const SessionViewportSeed({
    required this.followTail,
    this.anchorMessageKey,
    this.anchorViewportTop,
  });
  final bool followTail;
  final String? anchorMessageKey;
  final double? anchorViewportTop;
}

final class _SeededSessionViewportRegistry extends SessionViewportRegistry {
  _SeededSessionViewportRegistry({required this.key, required this.seed});

  final SessionViewportKey key;
  final SessionViewportSeed seed;

  static const int _generation = 1;

  @override
  Map<SessionViewportKey, SessionViewportRecord> build() => {
    key: SessionViewportRecord(
      followTail: seed.followTail,
      anchorMessageKey: seed.anchorMessageKey,
      anchorViewportTop: seed.anchorViewportTop,
      membershipGeneration: _generation,
    ),
  };

  @override
  int? membershipGenerationFor(SessionViewportKey candidate) =>
      candidate == key ? _generation : null;

  @override
  void synchronize(Set<SessionViewportKey> keys) {}

  @override
  void capture({
    required SessionViewportKey key,
    required int membershipGeneration,
    required bool followTail,
    String? anchorMessageKey,
    double? anchorViewportTop,
  }) {
    if (key != this.key || membershipGeneration != _generation) return;
    state = {
      key: SessionViewportRecord(
        followTail: followTail,
        anchorMessageKey: followTail ? null : anchorMessageKey,
        anchorViewportTop: followTail ? null : anchorViewportTop,
        membershipGeneration: _generation,
      ),
    };
  }

  @override
  void clearRecord({
    required SessionViewportKey key,
    required int membershipGeneration,
  }) {
    if (key == this.key && membershipGeneration == _generation) {
      state = const {};
    }
  }
}

/// Overrides the inherited text scale for [child] when [scale] is not 1,
/// keeping the rest of the MediaQuery (viewport size, padding) intact.
Widget _maybeScaleText(double scale, Widget child) {
  if (scale == 1) return child;
  return Builder(
    builder: (context) => MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(textScaler: TextScaler.linear(scale)),
      child: child,
    ),
  );
}

/// Maps the pre-Variant-C tab keys onto the view-menu item that replaced them.
///
/// The tabs are gone; the destinations are not. Callers keep naming the tab
/// they mean and this drives the `⋮` menu instead, so navigation intent stays
/// readable at every call site.
const _sessionDetailViewItemKeys = <String, String>{
  'session-detail-tab-chat': 'session-detail-view-item-chat',
  'session-detail-tab-status': 'session-detail-view-item-status',
  'session-detail-tab-terminal': 'session-detail-view-item-terminal',
  'session-detail-tab-files': 'session-detail-view-item-files',
  'session-detail-tab-artifacts': 'session-detail-view-item-files',
  'session-detail-tab-debug': 'session-detail-view-item-debug',
};

/// Navigates the session body to the view named by [key].
///
/// Accepts either a legacy tab key or a `session-detail-view-item-*` key.
Future<void> openSessionDetailTestTab(WidgetTester tester, String key) async {
  final itemKey = _sessionDetailViewItemKeys[key] ?? key;
  await tester.tap(find.byKey(const Key('session-detail-view-menu')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(Key(itemKey)));
  await tester.pumpAndSettle();
}

/// Opens the `⋮` view menu without selecting anything, for tests that assert
/// on the menu's own contents (badges, dots, check state).
Future<void> openSessionDetailViewMenu(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('session-detail-view-menu')));
  await tester.pumpAndSettle();
}

/// Closes an open view menu.
Future<void> closeSessionDetailViewMenu(WidgetTester tester) async {
  await tester.tapAt(const Offset(4, 4));
  await tester.pumpAndSettle();
}

/// Runs [body] with the `⋮` view menu open, then closes it.
///
/// The menu is the only place the view destinations and their badges exist
/// now, so assertions about them have to happen while it is up.
Future<void> withSessionDetailViewMenu(
  WidgetTester tester,
  Future<void> Function() body,
) async {
  await openSessionDetailViewMenu(tester);
  await body();
  await closeSessionDetailViewMenu(tester);
}

/// Asserts a view destination's presence in the `⋮` menu.
Future<void> expectSessionDetailViewItem(
  WidgetTester tester,
  String name, {
  required Matcher matcher,
}) async {
  await withSessionDetailViewMenu(tester, () async {
    expect(find.byKey(Key('session-detail-view-item-$name')), matcher);
  });
}

/// Flips a checkable option (`report`, `expand`) in the `⋮` view menu.
Future<void> toggleSessionDetailViewOption(
  WidgetTester tester,
  String name,
) async {
  await openSessionDetailViewMenu(tester);
  await tester.tap(find.byKey(Key('session-detail-view-item-$name')));
  await tester.pumpAndSettle();
}

Future<void> showSessionStatusTestItem(WidgetTester tester, Key key) async {
  if (find.byKey(const Key('session-detail-status-panel')).evaluate().isEmpty) {
    await openSessionDetailTestTab(tester, 'session-detail-tab-status');
  }
  await tester.scrollUntilVisible(
    find.byKey(key),
    240,
    scrollable: find
        .descendant(
          of: find.byKey(const Key('session-detail-status-panel')),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pumpAndSettle();
}

/// A [SpeechOutput] that reports synthesis available and records what was
/// asked to speak. The host platform for widget tests has no TTS, so a chat
/// surface exercising read-aloud must inject this.
final class RecordingSpeechOutput implements SpeechOutput {
  /// Creates the fake; set [supportsPauseResume] false to exercise the
  /// stop-only footer path.
  RecordingSpeechOutput({this.supportsPauseResume = true});

  /// Whether this fake advertises pause/resume support.
  final bool supportsPauseResume;

  final List<String> spokenMessageKeys = <String>[];
  final List<String> spokenTexts = <String>[];
  final List<double> rateCalls = <double>[];
  int disposeCallCount = 0;
  final _states = StreamController<SpeechOutputState>.broadcast();

  @override
  SpeechOutputCapabilities get capabilities => SpeechOutputCapabilities(
    synthesis: true,
    pauseResume: supportsPauseResume,
    installedLanguageVoiceAvailability: false,
  );

  @override
  SpeechOutputState current = const SpeechOutputIdle();

  @override
  Stream<SpeechOutputState> get states => _states.stream;

  void _emit(SpeechOutputState state) {
    current = state;
    _states.add(state);
  }

  /// Emits an error state for the given [messageKey] (test-only).
  void emitError({required String reason, String? messageKey}) =>
      _emit(SpeechOutputError(reason: reason, messageKey: messageKey));

  @override
  Future<void> speak({
    required String messageKey,
    required List<SpeechUtterance> utterances,
  }) async {
    spokenMessageKeys.add(messageKey);
    spokenTexts.add(utterances.map((utterance) => utterance.text).join(' '));
    _emit(SpeechOutputSpeaking(messageKey));
  }

  @override
  Future<void> setRate(double rate) async => rateCalls.add(rate);

  @override
  Future<void> pause() async {
    final state = current;
    if (state is SpeechOutputSpeaking) {
      _emit(SpeechOutputPaused(state.messageKey));
    }
  }

  @override
  Future<void> resume() async {
    final state = current;
    if (state is SpeechOutputPaused) {
      _emit(SpeechOutputSpeaking(state.messageKey));
    }
  }

  @override
  Future<void> stop() async {
    _emit(const SpeechOutputIdle());
  }

  /// Deliberately does not close [states].
  ///
  /// `speechOutputProvider` is autoDispose and this fake is handed out by a
  /// factory override, so the one instance can be disposed and re-watched
  /// within a single test. Closing the stream would leave the re-created
  /// provider holding a dead stream.
  @override
  Future<void> dispose() async {
    disposeCallCount++;
  }

  /// Closes the state stream. Call from `addTearDown`, not from [dispose].
  Future<void> close() => _states.close();
}

/// Opens the slash-command modal sheet from the composer bar.
///
/// The picker used to sit permanently above the composer; it now lives behind
/// the composer bar's terminal icon, so its keys
/// (`session-detail-command-picker`, `-args-input`, `-send-button`) are only in
/// the tree once the sheet is open.
Future<void> openCommandPickerSheet(WidgetTester tester) async {
  await tester.tap(
    find.byKey(const Key('session-detail-command-picker-button')),
  );
  await tester.pumpAndSettle();
}

void useRoomyTestViewport(WidgetTester tester) {
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  tester.view
    ..physicalSize = const Size(1280, 800)
    ..devicePixelRatio = 1;
}

class SeededSessionDetailController extends SessionDetailController {
  SeededSessionDetailController(this.initialState, {this.onAttach});

  final SessionDetailState initialState;
  final Future<void> Function(int callCount)? onAttach;
  int attachCallCount = 0;

  @override
  SessionDetailState build(SessionDetailKey arg) => initialState;

  @override
  Future<void> attach({
    SessionDetailAttachIntent intent = SessionDetailAttachIntent.interactive,
    bool force = false,
  }) async {
    attachCallCount++;
    await onAttach?.call(attachCallCount);
  }

  SessionDetailState get emittedState => state;

  set emittedState(SessionDetailState next) {
    state = next;
  }
}

final class InMemorySessionTranscriptRepository
    implements SessionTranscriptRepository {
  SessionTranscriptSnapshot? snapshot;

  @override
  Future<SessionTranscriptSnapshot?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) async => snapshot;

  @override
  Future<void> upsert(SessionTranscriptSnapshot snapshot) async {
    this.snapshot = snapshot;
  }
}

final class RecordingSessionDetailTransferFileOpener
    implements LocalTransferFileOpener {
  RecordingSessionDetailTransferFileOpener({
    this.openResult = const LocalTransferFileActionResult.success(),
    this.previewResult = const LocalTransferTextPreviewResult.success(
      'preview content',
      isTruncated: false,
    ),
  });

  final LocalTransferFileActionResult openResult;
  final LocalTransferTextPreviewResult previewResult;
  final openedPaths = <String>[];
  final revealedPaths = <String>[];
  final previewedPaths = <String>[];

  @override
  Future<LocalTransferFileActionResult> openFile(String localPath) async {
    openedPaths.add(localPath);
    return openResult;
  }

  @override
  Future<LocalTransferFileActionResult> revealInFolder(String localPath) async {
    revealedPaths.add(localPath);
    return const LocalTransferFileActionResult.success();
  }

  @override
  Future<LocalTransferTextPreviewResult> previewTextFile(
    String localPath, {
    int maxBytes = 64 * 1024,
  }) async {
    previewedPaths.add(localPath);
    return previewResult;
  }
}

AgentInfo fakeAgentInfo({
  bool canRenameNative = true,
  bool canTranscriptExport = true,
  bool canFork = true,
  bool canClone = true,
  bool supportsNativeFileInput = true,
}) {
  return AgentInfo(
    id: 'claude',
    displayName: 'Claude',
    capabilities: AgentCapabilities(
      integrationKind: IntegrationKind.sdkCallback,
      attachModes: [AttachMode.observe, AttachMode.resume],
      supportsObserve: true,
      supportsResume: true,
      supportsLiveAttach: false,
      supportsNativeArtifact: true,
      supportsNativeFileInput: supportsNativeFileInput,
      supportsModelSwitch: true,
      permissionGranularity: PermissionGranularity.perTool,
    ),
    canCreateSession: true,
    canRenameNative: canRenameNative,
    canFork: canFork,
    canClone: canClone,
    canTranscriptExport: canTranscriptExport,
  );
}

class FakeBrokerClient extends BrokerClient {
  FakeBrokerClient({List<AgentInfo>? agents, super.token, super.peerToken})
    : agents = agents ?? [fakeAgentInfo()],
      super(
        baseUrl: 'http://127.0.0.1:7734',
        clientProfileId: 'local',
        clientProfileIncarnation: 'test-incarnation',
      );

  final List<AgentInfo> agents;
  Object? forkError;
  Object? cloneError;
  BrokerException? fsListError;
  FsDirectoryResult fsListing = const FsDirectoryResult(
    path: '',
    stat: FsNodeInfo(
      path: '',
      type: 'directory',
      size: 0,
      mtimeMs: 0,
      isDirectory: true,
      isRegularFile: false,
      isSymbolicLink: false,
    ),
    entries: [],
  );
  FsReadResult fsReadResult = const FsReadResult(
    path: 'notes.txt',
    size: 5,
    limit: 1024 * 1024,
    truncated: false,
    encoding: 'utf8',
    data: 'hello',
    mimeType: 'text/plain',
  );
  int prepareTranscriptExportCount = 0;
  int exportTranscriptCount = 0;
  int forkSessionCount = 0;
  int cloneSessionCount = 0;
  int renameSessionCount = 0;
  String? lastForkTool;
  String? lastForkSessionId;
  String? lastForkMessageId;
  String? lastCloneTool;
  String? lastCloneSessionId;
  String? lastRenameTitle;
  final List<ScheduleCreate> scheduleRequests = [];
  final List<ScheduleRecord> scheduleRows = [];

  @override
  Future<List<AgentInfo>> listAgents() async => agents;

  @override
  Future<ScheduleListResponse> listSchedules({
    CancelToken? cancelToken,
  }) async {
    return ScheduleListResponse(schedules: List.of(scheduleRows));
  }

  @override
  Future<ScheduleCreateResponse> createSchedule(ScheduleCreate request) async {
    scheduleRequests.add(request);
    final message = request as MessageScheduleCreate;
    final schedule = ScheduleRecord(
      id: 'scheduled-1',
      kind: ScheduleKind.message,
      tool: request.tool,
      sessionId: message.sessionId,
      sessionTitle: message.sessionTitle,
      text: request.text,
      at: request.at,
      state: ScheduleState.scheduled,
      createdAt: 1,
      updatedAt: 1,
    );
    scheduleRows
      ..removeWhere((row) => row.id == schedule.id)
      ..add(schedule);
    return ScheduleCreateResponse(schedule: schedule);
  }

  @override
  Future<FsDirectoryResult> listSessionDirectory(
    String tool,
    String id, {
    String? path,
  }) async {
    final error = fsListError;
    if (error != null) {
      throw error;
    }
    return fsListing;
  }

  @override
  Future<FsReadResult> readSessionFile(
    String tool,
    String id, {
    String? path,
    int? maxBytes,
  }) async {
    return fsReadResult;
  }

  @override
  Future<TranscriptExportPreflightResponse> prepareTranscriptExport(
    String tool,
    String id,
  ) async {
    prepareTranscriptExportCount++;
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
  Future<RenameSessionResponse> renameSession(
    String tool,
    String id,
    String? title,
  ) async {
    renameSessionCount++;
    lastRenameTitle = title;
    return RenameSessionResponse(ok: true, title: title);
  }

  @override
  void close() {}
}

final class InMemorySessionNotificationSettingsStore
    implements SessionNotificationSettingsStore {
  bool value = false;

  @override
  Future<bool> getLocalNotificationEnabled() async => value;

  @override
  Future<void> setLocalNotificationEnabled({required bool enabled}) async {
    value = enabled;
  }
}

class SeededSessionArtifactTransferController
    extends SessionArtifactTransferController {
  SeededSessionArtifactTransferController(this._transfers);

  final List<SessionArtifactTransfer> _transfers;

  @override
  List<SessionArtifactTransfer> build() => _transfers;
}

class InMemorySessionControlPreferencesStore
    implements SessionControlPreferencesStore {
  bool suppressed = false;

  @override
  Future<bool> isRoutineTakeoverWarningSuppressed() async => suppressed;

  @override
  Future<void> setRoutineTakeoverWarningSuppressed({
    required bool suppressed,
  }) async {
    this.suppressed = suppressed;
  }
}

class InMemorySessionDriveIntentStore implements SessionDriveIntentStore {
  final Map<String, SessionDriveProvenanceKind> intents =
      <String, SessionDriveProvenanceKind>{};

  String _key(String tool, String sessionId) => '$tool/$sessionId';

  @override
  Future<SessionDriveProvenance?> read({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {
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
    intents[_key(tool, sessionId)] = SessionDriveProvenanceKind.appCreated;
  }

  @override
  Future<void> rememberTakeover({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {
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
    intents.remove(_key(tool, sessionId));
  }
}

class InMemorySessionModelPreferenceStore
    implements SessionModelPreferenceStore {
  final _models = <SessionModelPreferenceKey, SessionCurrentModel>{};
  final _toolDefaults = <String, SessionCurrentModel>{};
  Completer<void>? loadGate;
  Completer<void>? loadStarted;

  @override
  Future<void> clear(SessionModelPreferenceKey key) async {
    _models.remove(key);
  }

  @override
  Future<SessionCurrentModel?> load(SessionModelPreferenceKey key) async {
    final started = loadStarted;
    if (started != null && !started.isCompleted) {
      started.complete();
    }
    await loadGate?.future;
    return _models[key];
  }

  @override
  Future<void> save(
    SessionModelPreferenceKey key,
    SessionCurrentModel model,
  ) async {
    _models[key] = model;
  }

  @override
  Future<SessionCurrentModel?> loadToolDefault({
    required String brokerProfileId,
    required String tool,
  }) async {
    return _toolDefaults[_toolDefaultKey(brokerProfileId, tool)];
  }

  @override
  Future<void> saveToolDefault({
    required String brokerProfileId,
    required String tool,
    required SessionCurrentModel model,
  }) async {
    _toolDefaults[_toolDefaultKey(brokerProfileId, tool)] = model;
  }

  static String _toolDefaultKey(String brokerProfileId, String tool) =>
      '$brokerProfileId\u0000$tool';
}

class InMemoryOpenSessionsStore implements OpenSessionsStore {
  InMemoryOpenSessionsStore({
    this.snapshot = OpenSessionsSnapshot.empty,
  });

  OpenSessionsSnapshot snapshot;

  @override
  Future<OpenSessionsSnapshot> load(String profileId) async => snapshot;

  @override
  Future<void> save(
    String profileId,
    OpenSessionsSnapshot snapshot,
  ) async {
    this.snapshot = snapshot;
  }
}

class InMemorySessionOutboxRepository implements SessionOutboxRepository {
  final _messages = <SessionOutboxMessage>[];

  @override
  Future<void> remove(String clientMessageId) async {
    _messages.removeWhere(
      (message) => message.clientMessageId == clientMessageId,
    );
  }

  @override
  Future<void> upsert(SessionOutboxMessage message) async {
    final index = _messages.indexWhere(
      (item) => item.clientMessageId == message.clientMessageId,
    );
    if (index < 0) {
      _messages.add(message);
    } else {
      _messages[index] = message;
    }
  }

  @override
  Future<List<SessionOutboxMessage>> loadForSession(
    SessionDetailKey sessionKey, {
    String? brokerProfileId,
  }) async {
    return _messages
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
    return _messages
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

  Future<void> _update(
    String clientMessageId,
    SessionOutboxMessage Function(SessionOutboxMessage message) update,
  ) async {
    final index = _messages.indexWhere(
      (message) => message.clientMessageId == clientMessageId,
    );
    if (index >= 0) {
      _messages[index] = update(_messages[index]);
    }
  }
}

class FakeSessionArtifactFileService implements SessionArtifactFileService {
  SessionArtifactCachedFile? mockCachedFile;
  int cacheCallCount = 0;
  int exportCallCount = 0;
  int remainingCacheFailures = 0;
  Exception cacheError = Exception('Transient artifact download failure');
  String? exportedPath;

  @override
  Future<SessionArtifactCachedFile> cacheArtifact(
    SessionArtifactDescriptor descriptor, {
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    cacheCallCount++;
    if (remainingCacheFailures > 0) {
      remainingCacheFailures--;
      throw cacheError;
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
    return exportedPath;
  }
}

class FakeSessionAttachmentPicker implements SessionAttachmentPicker {
  SessionAttachment? selectedAttachment = const SessionAttachment(
    name: 'notes.txt',
    data: 'aGVsbG8=',
    byteLength: 5,
    mimeType: 'text/plain',
  );
  List<SessionAttachment>? selectedAttachments;

  int pickCount = 0;
  final List<bool> allowMultipleValues = [];

  @override
  Future<List<SessionAttachment>> pickAttachments({
    bool allowMultiple = true,
  }) async {
    pickCount++;
    allowMultipleValues.add(allowMultiple);
    if (selectedAttachments case final selected?) {
      return selected;
    }
    return selectedAttachment == null ? const [] : [selectedAttachment!];
  }
}

class FakeSpeechInput implements SpeechInput {
  final StreamController<SpeechInputState> _states =
      StreamController<SpeechInputState>.broadcast();
  SpeechInputState _current = const SpeechInputIdle();

  int cancelCallCount = 0;

  @override
  SpeechInputCapabilities get capabilities => const SpeechInputCapabilities(
    recognition: true,
    onDeviceRecognition: true,
    soundLevelEvents: true,
  );

  @override
  SpeechInputState get current => _current;

  @override
  Stream<SpeechInputState> get states => _states.stream;

  void emitReady(String transcript) => _emit(SpeechInputReady(transcript));

  void emitListening() => _emit(const SpeechInputListening());

  void emitUnavailable(String reason) => _emit(SpeechInputUnavailable(reason));

  void _emit(SpeechInputState next) {
    _current = next;
    _states.add(next);
  }

  @override
  Future<void> requestPermission() async {
    _emit(const SpeechInputRequestingPermission());
    _emit(const SpeechInputIdle());
  }

  @override
  Future<void> start({required SpeechRecognitionPolicy policy}) async {
    _emit(const SpeechInputListening());
  }

  @override
  Future<void> stop() async => _emit(const SpeechInputProcessing());

  @override
  Future<void> cancel() async {
    cancelCallCount++;
    _emit(const SpeechInputIdle());
  }

  @override
  String? consumeReady() {
    final value = _current;
    if (value is! SpeechInputReady) return null;
    _emit(const SpeechInputIdle());
    return value.transcript;
  }

  @override
  Future<void> dispose() async {
    await _states.close();
  }
}

/// Hello frame a scripted connection sends when a test does not script one.
///
/// Mirrors a current broker, so versioned durable drafts are negotiated exactly
/// as they are in production.
const defaultScriptedHello = HelloWireEvent(
  brokerVersion: '1.4.0',
  brokerContract: _scriptedBrokerContract,
  compatibility: BrokerClientCompatibility(
    status: BrokerClientCompatibilityStatus.compatible,
    readOnly: false,
    reason: 'compatible',
    broker: _scriptedBrokerContract,
  ),
);

const _scriptedBrokerContract = BrokerContractIdentity(
  revision: cosyncingClientContractRevision,
  minimumClientRevision: 2,
  surfaceHash: cosyncingClientContractSurfaceHash,
);

/// A session row carrying a non-human [SessionInfo.origin], otherwise identical
/// to the harness default (connected, drivable, tool capabilities intact).
///
/// `subagent` is the shape the broker refuses to fork with
/// `SESSION_AGENT_OWNED`: its only writer is the parent session's run. Pass
/// `exec`/`vscode` for the narrowness controls — those are automated or IDE
/// launches with no owning parent and stay forkable.
SessionWireEvent agentOwnedSessionEvent({String origin = 'subagent'}) =>
    SessionWireEvent(
      info: SessionInfo.fromJson({
        'id': 'session-1',
        'tool': 'claude',
        'title': '',
        'status': 'idle',
        'attachMode': 'resume',
        'origin': origin,
        'parentThreadId': 'parent-thread',
        'control': {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        },
      }),
    );

List<WireEvent> withDefaultSessionControl(List<WireEvent> events) {
  if (events.any((event) => event is SessionWireEvent)) {
    return events;
  }
  return [
    SessionWireEvent(
      info: SessionInfo.fromJson(const {
        'id': 'session-1',
        'tool': 'claude',
        'title': '',
        'status': 'idle',
        'attachMode': 'resume',
        'control': {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        },
      }),
    ),
    ...events,
  ];
}

class ScriptedSessionDetailConnection implements SessionDetailConnection {
  ScriptedSessionDetailConnection({
    required List<WireEvent> events,
    this.autoConnect = true,
    this.failFirstSend = false,
    this.onSendPrompt,
    this.onSendCommand,
    List<WireEvent> reattachEvents = const [],
  }) : _events = List.unmodifiable([
         // A real broker always opens with hello, and DR1 draft publishing
         // waits for that negotiation rather than guessing the contract. A
         // fixture without one would leave every draft relay deferred.
         if (!events.any((event) => event is HelloWireEvent))
           defaultScriptedHello,
         if (!events.any((event) => event is HistoryWireEvent))
           const HistoryWireEvent(messages: []),
         ...withDefaultSessionControl(events),
       ]),
       _reattachEvents = List.unmodifiable(reattachEvents);

  final List<WireEvent> _events;
  final List<WireEvent> _reattachEvents;

  /// Modes passed to [reattach], newest last ('resume' = Take over, null =
  /// hand back). Asserted by drive/take-over tests.
  final List<String?> reattachModes = [];
  final List<String?> reattachReasons = [];
  int connectCount = 0;
  int disarmDriveAuthorityCount = 0;
  final StreamController<SessionDetailConnectionStatus> _stateController =
      StreamController<SessionDetailConnectionStatus>.broadcast();
  final StreamController<WireEvent> _eventController =
      StreamController<WireEvent>.broadcast();
  final bool autoConnect;
  final bool failFirstSend;
  final Future<void> Function()? onSendPrompt;
  final Future<void> Function()? onSendCommand;
  int sendPromptCount = 0;
  int sendDraftCount = 0;
  int sendPlanActionCount = 0;
  int sendArtifactInteractionCount = 0;
  int sendPermissionDecisionCount = 0;
  int sendSetAgentCount = 0;
  int sendQuestionAnswerCount = 0;
  int rejectQuestionCount = 0;
  int sendCommandCount = 0;
  int sendFileCount = 0;
  int sendHandoffCount = 0;
  int disposeCount = 0;
  String? lastPrompt;
  String? lastDraft;
  String? lastDraftUpdateId;
  int? lastDraftBaseRevision;
  SessionCurrentModel? lastPromptModel;
  String? lastPromptClientMessageId;
  List<PromptFileAttachment> lastPromptFiles = const [];
  String? lastCommandName;
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
  bool failNextPermissionDecision = false;
  bool failNextSetAgent = false;
  bool failNextQuestionAnswer = false;
  bool failNextRejectQuestion = false;
  bool failNextCommand = false;
  bool failNextFile = false;
  bool _failedSend = false;

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
  Future<void> connect() async {
    connectCount++;
    if (!autoConnect) {
      return;
    }

    _setState(SessionDetailConnectionStatus.connecting);
    _setState(SessionDetailConnectionStatus.connected);
    for (final event in _events) {
      _eventController.add(event);
    }
  }

  @override
  Future<void> close({bool reconnect = false}) async {
    _setState(SessionDetailConnectionStatus.closed);
  }

  @override
  Future<void> reattach({
    String? mode,
    String? reason,
    SessionOwnerRevision? ownerRevision,
  }) async {
    reattachModes.add(mode);
    reattachReasons.add(reason);
    _setState(SessionDetailConnectionStatus.connecting);
    _setState(SessionDetailConnectionStatus.connected);
    for (final event in _reattachEvents) {
      _eventController.add(event);
    }
  }

  @override
  void disarmDriveAuthority() {
    disarmDriveAuthorityCount++;
  }

  @override
  Future<void> sendHandoff({String? clientMessageId}) async {
    sendHandoffCount++;
    _eventController.add(
      SessionWireEvent(
        info: SessionInfo.fromJson({
          'id': 'session-1',
          'tool': 'claude',
          'title': 'Control test',
          'status': 'idle',
          'attachMode': 'observe',
          'control': {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          },
          'sessionOwner': {
            'revision': {'epoch': 'handoff-test', 'seq': 1},
            'state': 'none',
          },
        }),
      ),
    );
  }

  void emitState(SessionDetailConnectionStatus state) => _setState(state);

  void emitEvent(WireEvent event) => _eventController.add(event);

  void emitSessionControl(
    Map<String, dynamic> control, {
    String status = 'idle',
  }) {
    _eventController.add(
      SessionWireEvent(
        info: SessionInfo.fromJson({
          'id': 'session-1',
          'tool': 'claude',
          'title': 'Control test',
          'status': status,
          'attachMode': 'observe',
          'control': control,
        }),
      ),
    );
  }

  @override
  Future<void> dispose() async {
    disposeCount++;
    await _stateController.close();
    await _eventController.close();
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
    lastPromptClientMessageId = clientMessageId;
    lastPromptFiles = List.unmodifiable(files);
    await onSendPrompt?.call();
    if (failFirstSend && !_failedSend) {
      _failedSend = true;
      throw Exception('prompt failed');
    }
  }

  @override
  Future<void> sendDraft(
    String text, {
    String? updateId,
    int? baseRevision,
  }) async {
    sendDraftCount++;
    lastDraft = text;
    lastDraftUpdateId = updateId;
    lastDraftBaseRevision = baseRevision;
  }

  @override
  Future<void> sendPlanAction(
    PlanActionRequest request, {
    String? clientMessageId,
  }) async {
    sendPlanActionCount++;
  }

  @override
  Future<void> sendArtifactInteraction(
    ArtifactInteractionRequest request, {
    String? clientMessageId,
  }) async {
    sendArtifactInteractionCount++;
  }

  @override
  Future<void> sendAck(String attachTicket, {String? clientMessageId}) async {}

  @override
  Future<void> sendNack(
    String attachTicket, {
    String? clientMessageId,
  }) async {}

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

  void _setState(SessionDetailConnectionStatus state) {
    _state = state;
    _stateController.add(state);
  }
}

/// Minimal [UiPreferencesStore] for the Session Detail harness.
///
/// Only the D1 "show debug views" preference is meaningful here; every other
/// preference resolves to its default so themes/locale/scale stay at defaults.
class _HarnessUiPreferencesStore implements UiPreferencesStore {
  _HarnessUiPreferencesStore({required this.showDebugViews});

  final bool showDebugViews;

  @override
  Future<String?> getThemeId() async => null;

  @override
  Future<void> setThemeId(String themeId) async {}

  @override
  Future<String?> getThemeMode() async => null;

  @override
  Future<void> setThemeMode(String mode) async {}

  @override
  Future<String?> getLocaleTag() async => null;

  @override
  Future<void> setLocaleTag(String tag) async {}

  @override
  Future<String?> getTextScale() async => null;

  @override
  Future<void> setTextScale(String token) async {}

  @override
  Future<String?> getDensity() async => null;

  @override
  Future<void> setDensity(String token) async {}

  @override
  Future<bool?> getShowDebugViews() async => showDebugViews;

  @override
  Future<void> setShowDebugViews({required bool value}) async {}
}
