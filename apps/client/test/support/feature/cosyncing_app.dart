// Pumps the REAL cosyncing App for feature tests.
//
// Real: `App`, its router and every page, all Riverpod providers and
// controllers, the Drift database (in memory), secure storage (the real
// `flutter_secure_storage` API over its in-memory test platform), the broker
// REST client, probes, pairing crypto and session connections.
//
// Fake, and only at the edges: the broker (wire level, `fake_broker.dart`),
// the installer pairing inbox (a file under the user's home in production),
// the public update-manifest host (routed into the fake network, where nothing
// answers), and time (flutter_test's fake clock; nothing waits on the wall
// clock). The app's clock reads the wall time the scenario started at, moved
// on by fake time ([FeatureContext.now]), so a row the fake broker stamped
// with the wall clock reads as older as fake time passes.
//
// Usage:
//
//   featureTest('what the user sees', (f) async {
//     final studio = f.network.add('http://studio.test:7734');
//     await f.storage.seedServer(studio);          // optional "given"
//     final app = await f.launch();                 // real App, first frame
//     await app.tapKey('…');                        // product verbs
//     expect(studio.requestsTo('/api/sessions'), isNotEmpty);
//   });
import 'package:cosyncing_client/src/app/app.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/app/shortcuts/app_shortcuts.dart';
import 'package:cosyncing_client/src/design/components/stroke_icon.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/drift_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/secure_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_http_transport.dart';
import 'package:cosyncing_client/src/features/pairing/controller/installer_pairing_handoff_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_connection.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:cosyncing_client/src/platform/clock/app_clock.dart';
import 'package:cosyncing_client/src/platform/update/stable_release_manifest.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:meta/meta.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'app_driver.dart';
import 'fake_broker.dart';
import 'fake_camera.dart';
import 'fake_installer_inbox.dart';

/// Window sizes feature scenarios run at.
enum FeatureViewport {
  /// A 320 dp phone, the narrowest supported width.
  narrowPhone(Size(320, 640)),

  /// A 390 dp phone.
  phone(Size(390, 844)),

  /// A 1440 dp desktop window.
  desktop(Size(1440, 900)),

  /// A 1440 dp window tall enough to build a whole transcript at once (the
  /// transcript list builds only what is on screen).
  desktopTall(Size(1440, 6000)),

  /// A 390 dp phone, tall (see [desktopTall]).
  phoneTall(Size(390, 6000)),

  /// A 320 dp phone, tall (see [desktopTall]).
  narrowPhoneTall(Size(320, 6000));

  const FeatureViewport(this.size);

  /// Logical size (device pixel ratio 1).
  final Size size;
}

/// Durable device state: survives an app restart within one test.
///
/// A restart is a fresh `ProviderScope` and widget tree over the same
/// storage, which is what relaunching the process gives the app.
class FeatureStorage {
  /// Fresh, empty device storage.
  FeatureStorage() : database = AppDatabase(NativeDatabase.memory()) {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
  }

  /// The app's Drift database.
  final AppDatabase database;

  /// The installer's first-run pairing inbox.
  final FakeInstallerInbox installerInbox = FakeInstallerInbox();

  /// The real secure credential store over the in-memory secure storage.
  final SecureCredentialStore credentials = SecureCredentialStore();

  /// The real profile repository over [database].
  late final DriftBrokerProfileRepository profiles =
      DriftBrokerProfileRepository(database);

  /// The real active-server store over [database].
  late final DriftActiveBrokerProfileStore activeServer =
      DriftActiveBrokerProfileStore(database);

  /// The real appearance/language preference store over [database].
  late final DriftUiPreferencesStore preferences = DriftUiPreferencesStore(
    database,
  );

  /// Saves a server the way an earlier launch would have, optionally active
  /// and with a stored owner or paired-device token.
  Future<BrokerProfile> seedServer(
    FakeBroker broker, {
    String? displayName,
    String? ownerToken,
    String? peerToken,
    bool active = true,
    DateTime? createdAt,
    DateTime? lastUsedAt,
  }) async {
    final id = broker.baseUri.toString();
    final credentialKey = ownerToken != null
        ? brokerSharedTokenCredentialKey(id)
        : peerToken != null
        ? brokerPeerTokenCredentialKey(id)
        : null;
    final created = createdAt ?? DateTime.utc(2026, 10);
    final saved = await profiles.save(
      BrokerProfile(
        id: id,
        displayName: displayName ?? broker.baseUri.host,
        baseUri: broker.baseUri,
        createdAt: created,
        updatedAt: created,
        lastUsedAt: lastUsedAt ?? created,
        credentialKey: credentialKey,
      ),
    );
    if (credentialKey != null) {
      await credentials.writeBrokerToken(
        credentialKey,
        ownerToken ?? peerToken!,
      );
    }
    if (active) await activeServer.setActiveProfileId(saved.id);
    return saved;
  }

  /// The stored secret under [credentialKey], or null.
  Future<String?> token(String credentialKey) =>
      credentials.readBrokerToken(credentialKey);
}

/// One scenario's world: a fake network, device storage, and the App.
class FeatureContext {
  FeatureContext._(this.tester)
    : _wallStart = DateTime.now(),
      _fakeStart = tester.binding.clock.now();

  /// The widget tester.
  final WidgetTester tester;

  final DateTime _wallStart;
  final DateTime _fakeStart;

  /// The app's clock ([appClockProvider]): the wall time this scenario started
  /// at, moved on by the fake time elapsed since. It survives [restart].
  ///
  /// The fake broker stamps rows with the wall clock, which barely moves while
  /// a scenario runs, so stamp a row's time from here to place it relative to
  /// what the app will read.
  DateTime now() =>
      _wallStart.add(tester.binding.clock.now().difference(_fakeStart));

  /// Brokers this scenario can reach. Unregistered hosts refuse connections.
  final FakeBrokerNetwork network = FakeBrokerNetwork();

  /// Device storage; survives [restart].
  final FeatureStorage storage = FeatureStorage();

  MobileScannerPlatform? _realCamera;
  FakeCamera? _camera;

  /// The device camera the QR scanner reads (installed on first use).
  FakeCamera get camera {
    final existing = _camera;
    if (existing != null) return existing;
    _realCamera = MobileScannerPlatform.instance;
    final camera = _camera = FakeCamera();
    MobileScannerPlatform.instance = camera;
    return camera;
  }

  ProviderContainer? _container;
  GoRouter? _router;
  FeatureViewport _viewport = FeatureViewport.desktop;
  List<Override> _overrides = const [];

  /// Launches the real App at [initialLocation] and settles its first frame.
  ///
  /// [overrides] are for fault injection around real stores (a failing
  /// write, a held read); they are kept across [restart].
  Future<AppDriver> launch({
    FeatureViewport viewport = FeatureViewport.desktop,
    String initialLocation = sessionsRoute,
    List<Override> overrides = const [],
  }) async {
    _viewport = viewport;
    _overrides = overrides;
    tester.view
      ..physicalSize = viewport.size
      ..devicePixelRatio = 1;

    final router = _router = createGoRouter(initialLocation: initialLocation);
    final container = _container = ProviderContainer(
      overrides: [
        appDatabaseProvider.overrideWithValue(storage.database),
        brokerHttpTransportProvider.overrideWithValue(network.transport),
        sessionSocketAdapterFactoryProvider.overrideWithValue(
          network.socketFactory,
        ),
        // The signed update manifest lives on a public host; route it into
        // the fake network, where nothing answers for it.
        stableReleaseDioProvider.overrideWith((ref) {
          final dio = Dio()..httpClientAdapter = network.transport();
          ref.onDispose(dio.close);
          return dio;
        }),
        installerPairingInboxProvider.overrideWithValue(storage.installerInbox),
        installerPairingClockProvider.overrideWithValue(
          () => tester.binding.clock.now(),
        ),
        appClockProvider.overrideWithValue(now),
        ...overrides,
      ],
    );

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: App(router: router, key: UniqueKey()),
      ),
    );
    final driver = AppDriver(
      tester,
      container: container,
      router: router,
      network: network,
      storage: storage,
    );
    await driver.settle();
    return driver;
  }

  /// Quits the App and launches it again over the same device storage.
  Future<AppDriver> restart({String initialLocation = sessionsRoute}) async {
    await quit();
    return launch(
      viewport: _viewport,
      initialLocation: initialLocation,
      overrides: _overrides,
    );
  }

  /// Unmounts the App and disposes every provider, like a process exit.
  Future<void> quit() async {
    await tester.pumpWidget(const SizedBox.shrink());
    _container?.dispose();
    _router?.dispose();
    _container = null;
    _router = null;
    await tester.pump();
  }

  Future<void> _close() async {
    await quit();
    // Let what disposal itself scheduled run out (Drift closes a cancelled
    // stream query on a timer). One minute, not more: a stopped worker must
    // cancel its own waits, so a longer timer still pending here (the
    // attention feed's 30-minute wait after a refused credential once was)
    // fails flutter_test's leak check instead of being drained away.
    await tester.pump(const Duration(minutes: 1));
    await storage.database.close();
    tester.view.reset();
    final realCamera = _realCamera;
    if (realCamera != null) MobileScannerPlatform.instance = realCamera;
  }
}

/// Declares one feature scenario.
///
/// Wraps `testWidgets` so every scenario starts from the same clean slate:
/// the requested target platform (desktop Linux unless stated), fresh
/// module-level debug globals, empty storage and network, and ends with the
/// App unmounted and every provider disposed.
///
/// The semantics tree is off unless [semantics] is set: building it costs
/// about an eighth of a scenario's CPU, and scenarios assert what is on
/// screen, not what a screen reader hears. A scenario that asserts semantics
/// passes `semantics: true` (or takes its own handle with
/// `tester.ensureSemantics()`).
@isTest
void featureTest(
  String description,
  Future<void> Function(FeatureContext f) body, {
  TargetPlatform platform = TargetPlatform.linux,
  bool skip = false,
  bool semantics = false,
}) {
  testWidgets(description, skip: skip, semanticsEnabled: semantics, (
    tester,
  ) async {
    _resetGlobals();
    debugDefaultTargetPlatformOverride = platform;
    final context = FeatureContext._(tester);
    try {
      await body(context);
    } finally {
      try {
        await context._close();
      } finally {
        _resetGlobals();
        debugDefaultTargetPlatformOverride = null;
      }
    }
  });
}

void _resetGlobals() {
  WebHandoffParticipants.instance.reset();
  debugWebReservedChordsOverride = null;
  debugStrokeIconRasterOverride = null;
}
