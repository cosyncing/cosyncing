// F11 — Client and broker updates, through the real App.
//
// Journeys:
//   1. Android: the verified-update dialog (Later, Back, a newer release, a
//      current build), then the download under its service, out of sight and
//      back, refused service, failed download; Settings > General controls.
//   2. Desktop: the build pointer, the General update row, the dot on the
//      Settings button, and who owns the guidance (pointer or compatibility
//      advice) for a broker behind, equal, ahead or unreadable.
//   3. The broker's own release status and health, honestly worded, including
//      a release that needs a newer Bun than this install can place.
//   4. Web: no app-update controls; a draft in the composer defers a web
//      handoff, and the commit window refuses typing.
//
// Update packages are authenticated by the product (signature and digest
// checks have pure suites that stay); here the manifest fetch and the APK
// download are the seams, so every offer is a verified candidate.
import 'dart:async';
import 'dart:io';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_identity_store.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/platform/desktop/desktop_keep_running.dart';
import 'package:cosyncing_client/src/platform/update/android_client_update.dart';
import 'package:cosyncing_client/src/platform/update/android_update_platform_contract.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update_provider.dart';
import 'package:cosyncing_client/src/platform/update/local_desktop_updater.dart';
import 'package:cosyncing_client/src/platform/update/local_desktop_updater_provider.dart';
import 'package:cosyncing_client/src/platform/update/native_client_update.dart';
import 'package:cosyncing_client/src/platform/update/stable_release_manifest.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/composer_driver.dart';
import '../support/feature/composer_wire.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/settings_wire.dart';
import '../support/feature/update_wire.dart';

const _signer =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));

Map<String, Object?> _androidManifest(String version, int versionCode) => {
  'schemaVersion': 1,
  'product': 'cosyncing',
  'channel': 'stable',
  'version': version,
  'androidApp': <String, Object?>{
    'name': 'cosyncing-client-$version-android.apk',
    'applicationId': 'com.cosyncing.client',
    'versionCode': versionCode,
    'size': 1024,
    'sha256': _signer,
    'url':
        'https://github.com/cosyncing/cosyncing/releases/download/'
        'broker-v$version/cosyncing-client-$version-android.apk',
    'signerSha256': _signer,
  },
};

Map<String, Object?> _desktopManifest(String version) => {
  'schemaVersion': 1,
  'product': 'cosyncing',
  'channel': 'stable',
  'version': version,
};

/// The Android installer and download service, recording what the app asked.
final class _AndroidPlatform implements AndroidUpdatePlatform {
  bool serviceStarts = true;
  int identityCalls = 0;
  int installCalls = 0;
  final starts = <AndroidUpdateDownloadNotice>[];
  final percents = <int>[];
  final stops = <AndroidUpdateReadyNotice?>[];

  @override
  bool get supported => true;

  @override
  Future<AndroidInstalledAppIdentity> installedIdentity() async {
    identityCalls += 1;
    return const AndroidInstalledAppIdentity(
      applicationId: 'com.cosyncing.client',
      versionCode: 11,
      signerSha256: _signer,
    );
  }

  @override
  Future<AndroidInstallLaunchResult> installApk({
    required String path,
    required String applicationId,
    required String version,
    required int versionCode,
    required String signerSha256,
  }) async {
    installCalls += 1;
    return AndroidInstallLaunchResult.launched;
  }

  @override
  Future<bool> startDownloadService(AndroidUpdateDownloadNotice notice) async {
    starts.add(notice);
    return serviceStarts;
  }

  @override
  Future<void> showDownloadProgress(int percent) async => percents.add(percent);

  @override
  Future<void> stopDownloadService({AndroidUpdateReadyNotice? ready}) async =>
      stops.add(ready);
}

/// A lifecycle the test moves by hand. Starts in front, like the app.
final class _Lifecycle implements BrokerAppLifecycleMonitor {
  final _changes = StreamController<BrokerAppLifecycleState>.broadcast();

  @override
  BrokerAppLifecycleState currentState = BrokerAppLifecycleState.resumed;

  @override
  Stream<BrokerAppLifecycleState> get stateChanges => _changes.stream;

  void move(BrokerAppLifecycleState value) {
    currentState = value;
    _changes.add(value);
  }

  @override
  void dispose() => unawaited(_changes.close());
}

class _DesktopHelper implements LocalDesktopUpdater {
  bool updated = false;
  bool failNextArm = false;
  String? recoveredPhase;
  final jobs = <String, Map<String, dynamic>>{};
  int arms = 0;
  @override
  Future<Map<String, dynamic>> inspect() async => {
    'helperVersion': '1.0.0',
    'runtimeVersion': '1.3.14',
    'version': updated ? '2.0.0' : '1.0.0',
    'host': 'linux-x64',
    'installationId': 'local-installation',
  };
  @override
  Future<Map<String, dynamic>> prepare(String id, String release) async {
    final job = jobs.putIfAbsent(
      id,
      () => {'id': id, 'releaseId': release, 'phase': 'ready'},
    );
    return job;
  }

  @override
  Future<Map<String, dynamic>> arm(String id) async {
    arms++;
    if (failNextArm) {
      failNextArm = false;
      return jobs[id]!
        ..['phase'] = 'failed'
        ..['detailCode'] = 'fixture-replacement-refused';
    }
    return jobs[id]!..['phase'] = 'waiting-for-exit';
  }

  @override
  Future<Map<String, dynamic>> status(String id) async {
    final job = jobs[id];
    if (job == null) {
      throw const DesktopUpdaterUnavailable('desktop-update-job-not-found');
    }
    if (updated) {
      job['phase'] = 'succeeded';
    } else if (recoveredPhase != null &&
        const ['waiting-for-exit', 'replacing'].contains(job['phase'])) {
      job['phase'] = recoveredPhase;
      recoveredPhase = null;
    }
    return job;
  }

  @override
  Future<void> cancel(String id) async {
    jobs[id]!['phase'] = 'cancelled';
  }

  @override
  Future<void> acknowledgeStartup(String version) async {}
}

class _UpdateWindow extends DesktopWindowChannel {
  _UpdateWindow(this._quit);
  final Future<void> Function() _quit;
  @override
  Future<void> quitForUpdate() => _quit();
}

void main() {
  Finder key(String k) => find.byKey(Key(k));
  featureTest(
    'Updates checks with text, keeps current servers readable and lives '
    'under General',
    (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final desk = UpdateDesk(studio, now: f.now)
        ..updateAvailable = false
        ..checkHeld = Completer<void>();
      final profile = await f.storage.seedServer(studio, ownerToken: 'owner');
      final app = await f.launch(
        initialLocation: settingsRoute,
        viewport: FeatureViewport.phone,
        overrides: [clientIsWebProvider.overrideWithValue(true)],
      );
      expect(key('settings-category-updates'), findsNothing);
      await app.tapKey('settings-category-general');
      await app.tapKey('settings-general-updates');
      await app.waitFor(key('updates-checking'));
      expect(find.byType(LinearProgressIndicator), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(desk.preparations, isEmpty);
      expect(desk.applies, isEmpty);
      desk.checkHeld!.complete();
      await app.waitForAbsent(key('updates-checking'));
      expect(find.textContaining(en.updatesCurrent), findsOneWidget);
      expect(key('updates-review'), findsNothing);
      expect(key('updates-server-${profile.id}'), findsOneWidget);
      expect(
        find.descendant(
          of: key('updates-server-${profile.id}'),
          matching: find.byType(Checkbox),
        ),
        findsNothing,
      );
      desk.checkHeld = Completer<void>();
      await app.tapKey('updates-check');
      await app.waitFor(key('updates-checking'));
      expect(find.byType(LinearProgressIndicator), findsNothing);
      desk.checkHeld!.complete();
      await app.waitForAbsent(key('updates-checking'));
      expect(desk.preparations, isEmpty);
      expect(desk.applies, isEmpty);
    },
  );
  featureTest('the desktop app saves its draft before a full quit and resumes '
      'only unfinished updates after relaunch', (f) async {
    final studio = f.network.add('http://studio.test:7734')
      ..addSession('s1', 'Draft');
    ComposerDesk(studio);
    await f.storage.seedServer(studio);
    final helper = _DesktopHelper();
    var quits = 0;
    final window = _UpdateWindow(() async {
      expect(WebHandoffParticipants.instance.frozen.value, isTrue);
      final drafts = await f.storage.database
          .select(f.storage.database.sessionDraftRows)
          .get();
      expect(drafts.map((r) => r.draftText), contains('keep this exact draft'));
      quits++;
    });
    var app = await f.launch(
      overrides: [
        clientTargetPlatformProvider.overrideWithValue(TargetPlatform.linux),
        clientIsWebProvider.overrideWithValue(false),
        localDesktopUpdaterProvider.overrideWithValue(helper),
        desktopWindowChannelProvider.overrideWithValue(window),
        desktopClientVersionProvider.overrideWithValue('1.0.0'),
        stableReleaseManifestFetcherProvider.overrideWithValue(
          () async => {
            ..._desktopManifest('2.0.0'),
            'sourceCommit': '2222222',
            'updater': <String, Object?>{
              'schemaVersion': 1,
              'releaseId': 'rel-2.0.0+2222222',
              'minimumHelperVersion': '1.0.0',
              'clientContract': {
                'revision': cosyncingClientContractRevision,
                'minimumBrokerRevision': cosyncingClientMinimumBrokerRevision,
                'surfaceHash': cosyncingClientContractSurfaceHash,
              },
              'desktop': {
                'linux-x64': {
                  'capabilities': [
                    'prepare',
                    'client-replace',
                    'client-relaunch',
                  ],
                },
              },
            },
          },
        ),
      ],
    );
    await app.openFromRoster('s1', cwd: '/work/studio');
    await app.type('keep this exact draft');
    await app.go(updatesRoute);
    await app.pumpUntil(
      () => key('updates-app-available').evaluate().isNotEmpty,
      reason: 'the owned app update is selectable',
    );
    await app.tapKey('updates-update-app');
    await app.tapKey('updates-ack-app-will-close');
    await app.tapKey('updates-ack-compatibility-unconfirmed');
    expect(quits, 0);
    await app.tapKey('updates-apply');
    await app.pumpUntil(
      () => quits == 1,
      reason: 'drafts are durable before the native quit',
    );
    expect(helper.arms, 1);
    expect(helper.jobs.length, 1);
    app = await f.restart(initialLocation: updatesRoute);
    await app.tapKey('updates-continue');
    await app.pumpUntil(
      () =>
          app.tester.widget<FilledButton>(key('updates-continue')).onPressed !=
          null,
      reason: 'a live exit worker is preserved without a second handoff',
    );
    expect(helper.arms, 1);
    expect(quits, 1);
    helper.recoveredPhase = 'ready';
    await app.tapKey('updates-continue');
    await app.pumpUntil(
      () => quits == 2,
      reason: 'status recovers the interrupted exit worker before rearming',
    );
    expect(helper.jobs.length, 1);
    helper.jobs.values.single['phase'] = 'replacing';
    helper.recoveredPhase = 'rolled_back';
    app = await f.restart(initialLocation: updatesRoute);
    await app.tapKey('updates-continue');
    await app.pumpUntil(
      () => quits == 3,
      reason: 'a recovered replacement is retried under a fresh key',
    );
    expect(helper.jobs.length, 2);
    helper.updated = true;
    app = await f.restart();
    await app.go(updatesRoute);
    await app.tapKey('updates-continue');
    await app.waitFor(find.textContaining(en.updatesSucceeded));
    expect(helper.arms, 3);
    expect(quits, 3);
    expect(helper.jobs.length, 2);
  });
  featureTest(
    'a manual-only server shows its checked version and update guidance',
    (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final desk = UpdateDesk(studio, now: f.now)..canApply = false;
      final profile = await f.storage.seedServer(studio, ownerToken: 'owner');
      final app = await f.launch(
        initialLocation: updatesRoute,
        viewport: FeatureViewport.narrowPhoneTall,
        overrides: [clientIsWebProvider.overrideWithValue(true)],
      );
      await app.waitFor(find.textContaining('1.0.0 → 2.0.0'));
      await app.waitFor(find.text(UpdateDesk.manualGuidance));
      expect(find.text(UpdateDesk.manualBlocker), findsOneWidget);
      expect(find.text(en.updatesServerManual), findsOneWidget);
      expect(find.text(en.updatesCheckFailed), findsNothing);
      expect(
        find.descendant(
          of: key('updates-server-${profile.id}'),
          matching: find.byType(CheckboxListTile),
        ),
        findsNothing,
      );
      expect(key('updates-review'), findsNothing);
      expect(desk.preparations, isEmpty);
      expect(desk.applies, isEmpty);
      expect(app.tester.takeException(), isNull);
    },
  );
  featureTest('a combined update requires known compatibility and stages the '
      'server before a safe app-first restart', (f) async {
    final studio = f.network.add('http://studio.test:7734');
    final desk = UpdateDesk(studio, now: f.now)..contractKnown = false;
    await f.storage.seedServer(studio, ownerToken: 'owner');
    final helper = _DesktopHelper();
    var quits = 0;
    var app = await f.launch(
      initialLocation: updatesRoute,
      overrides: [
        clientIsWebProvider.overrideWithValue(false),
        localDesktopUpdaterProvider.overrideWithValue(helper),
        desktopWindowChannelProvider.overrideWithValue(
          _UpdateWindow(() async {
            expect(desk.preparations.length, 1);
            expect(desk.applies, isEmpty);
            quits++;
          }),
        ),
        stableReleaseManifestFetcherProvider.overrideWithValue(
          () async => {
            ..._desktopManifest('2.0.0'),
            'updater': {
              'schemaVersion': 1,
              'releaseId': 'rel-2.0.0+2222222',
              'minimumHelperVersion': '1.0.0',
              'clientContract': {
                'revision': cosyncingClientContractRevision + 1,
                'minimumBrokerRevision': cosyncingClientMinimumBrokerRevision,
                'surfaceHash': cosyncingClientContractSurfaceHash,
              },
              'desktop': {
                'linux-x64': {
                  'capabilities': [
                    'prepare',
                    'client-replace',
                    'client-relaunch',
                  ],
                },
              },
            },
          },
        ),
      ],
    );
    await app.waitFor(key('updates-app-available'));
    await app.pumpUntil(
      () =>
          key('updates-review').evaluate().isNotEmpty &&
          app.tester.widget<FilledButton>(key('updates-review')).onPressed !=
              null,
      reason: 'app and server checks finish before review',
    );
    await app.tapKey('updates-review');
    await app.tapKey('updates-include-app');
    await app.waitFor(find.text(en.updatesReviewChanged));
    expect(desk.preparations, isEmpty);
    expect(helper.jobs, isEmpty);
    desk
      ..contractKnown = true
      ..targetRevision = cosyncingClientContractRevision + 2;
    await app.tap(find.text(en.cancel).last);
    await app.tapKey('updates-check');
    await app.tapKey('updates-review');
    await app.tapKey('updates-include-app');
    await app.waitFor(key('updates-ack-app-will-close'));
    await app.tapKey('updates-ack-app-will-close');
    await app.tapKey('updates-ack-server-will-disconnect');
    await app.tapKey('updates-apply');
    await app.pumpUntil(() => quits == 1, reason: 'the app-first step quits');
    expect(desk.applies, isEmpty);
    helper.updated = true;
    app = await f.restart(initialLocation: updatesRoute);
    await app.tapKey('updates-continue');
    await app.pumpUntil(
      () => desk.applies.length == 1,
      reason: 'the reopened app continues the prepared server update',
    );
    expect(helper.arms, 1);
    expect(desk.preparations.length, 1);
    expect(app.tester.takeException(), isNull);
  });
  featureTest('a failed app replacement retries only the app after the server '
      'has already updated', (f) async {
    final studio = f.network.add('http://studio.test:7734');
    final desk = UpdateDesk(studio, now: f.now);
    await f.storage.seedServer(studio, ownerToken: 'owner');
    final helper = _DesktopHelper()..failNextArm = true;
    var quits = 0;
    var app = await f.launch(
      initialLocation: updatesRoute,
      overrides: [
        clientIsWebProvider.overrideWithValue(false),
        localDesktopUpdaterProvider.overrideWithValue(helper),
        desktopWindowChannelProvider.overrideWithValue(
          _UpdateWindow(() async {
            quits++;
          }),
        ),
        stableReleaseManifestFetcherProvider.overrideWithValue(
          () async => {
            ..._desktopManifest('2.0.0'),
            'updater': {
              'schemaVersion': 1,
              'releaseId': 'rel-2.0.0+2222222',
              'minimumHelperVersion': '1.0.0',
              'clientContract': {
                'revision': cosyncingClientContractRevision,
                'minimumBrokerRevision': cosyncingClientMinimumBrokerRevision,
                'surfaceHash': cosyncingClientContractSurfaceHash,
              },
              'desktop': {
                'linux-x64': {
                  'capabilities': [
                    'prepare',
                    'client-replace',
                    'client-relaunch',
                  ],
                },
              },
            },
          },
        ),
      ],
    );
    await app.waitFor(key('updates-app-available'));
    await app.pumpUntil(
      () =>
          key('updates-review').evaluate().isNotEmpty &&
          app.tester.widget<FilledButton>(key('updates-review')).onPressed !=
              null,
      reason: 'app and server checks have finished',
    );
    await app.tapKey('updates-review');
    await app.tapKey('updates-include-app');
    await app.tapKey('updates-ack-app-will-close');
    await app.tapKey('updates-ack-server-will-disconnect');
    await app.tapKey('updates-apply');
    await app.pumpUntil(
      () =>
          helper.arms == 1 &&
          app.tester.widget<FilledButton>(key('updates-continue')).onPressed !=
              null,
      reason: 'the app failure is recorded after the server succeeded',
    );
    expect(desk.applies.length, 1);
    expect(quits, 0);
    await app.tapKey('updates-continue');
    await app.pumpUntil(
      () => quits == 1,
      reason: 'only the failed app component is retried',
    );
    expect(helper.jobs.length, 2);
    expect(helper.arms, 2);
    expect(desk.applies.length, 1);
    helper.updated = true;
    app = await f.restart(initialLocation: updatesRoute);
    await app.tapKey('updates-continue');
    await app.pumpUntil(
      () => find.textContaining(en.updatesSucceeded).evaluate().length == 2,
      reason: 'both component results remain successful after reopening',
    );
    expect(desk.applies.length, 1);
    expect(helper.arms, 2);
  });
  featureTest(
    'Updates reviews named saved servers without changing the active one, '
    'then stages every selection before the first restart',
    (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final laptop = f.network.add('http://laptop.test:7734');
      final events = <String>[];
      final a = UpdateDesk(studio, now: f.now, onEvent: events.add);
      final b = UpdateDesk(laptop, now: f.now, onEvent: events.add)
        ..jobReadHeld = Completer<void>();
      final first = await f.storage.seedServer(studio, ownerToken: 'owner');
      final second = await f.storage.seedServer(
        laptop,
        active: false,
        ownerToken: 'owner',
      );
      final app = await f.launch(
        initialLocation: updatesRoute,
        viewport: FeatureViewport.narrowPhoneTall,
        overrides: [clientIsWebProvider.overrideWithValue(true)],
      );
      await app.waitFor(key('updates-server-${second.id}'));
      await app.pumpUntil(
        () =>
            app.tester
                .widget<CheckboxListTile>(key('updates-server-${second.id}'))
                .onChanged !=
            null,
        reason: 'saved-server update availability has been checked',
      );
      await app.tapKey('updates-server-${second.id}');
      expect(
        app.tester
            .widget<CheckboxListTile>(
              key('updates-server-${second.id}'),
            )
            .value,
        isTrue,
        reason: 'Selecting a server must not invoke its separate update action',
      );
      await app.tapKey('updates-review');
      await app.waitFor(key('updates-ack-server-will-disconnect'));
      expect(a.preparations, isEmpty);
      expect(b.preparations, isEmpty);
      await app.tapKey('updates-ack-server-will-disconnect');
      await app.tapKey('updates-apply');
      await app.pumpUntil(
        () => a.applies.isNotEmpty && b.jobReads > 0,
        reason: 'the first server finishes before the second may apply',
      );
      await app.tapKey('updates-cancel');
      b.jobReadHeld!.complete();
      await app.waitFor(find.textContaining(en.canceled));
      expect(a.applies.length, 1);
      expect(b.applies, isEmpty);
      expect(b.preparations.values.single['phase'], 'cancelled');
      expect(a.preparations.length, 1);
      expect(b.preparations.length, 1);
      expect(events.take(3), ['prepared', 'prepared', 'applied']);
      expect(await f.storage.activeServer.getActiveProfileId(), first.id);
      expect(laptop.requestsTo('/api/sessions'), isEmpty);
      expect(app.tester.takeException(), isNull);
    },
  );

  featureTest('a credential change while progress is in flight cannot apply '
      "the previous credential's update", (f) async {
    final studio = f.network.add(
      'http://studio.test:7734',
      ownerToken: 'owner',
    );
    final desk = UpdateDesk(studio, now: f.now)
      ..jobReadHeld = Completer<void>();
    final profile = await f.storage.seedServer(studio, ownerToken: 'owner');
    final app = await f.launch(
      initialLocation: updatesRoute,
      overrides: [clientIsWebProvider.overrideWithValue(true)],
    );
    await app.pumpUntil(
      () =>
          key('updates-review').evaluate().isNotEmpty &&
          (key('updates-review').evaluate().isNotEmpty &&
              app.tester
                      .widget<FilledButton>(key('updates-review'))
                      .onPressed !=
                  null),
      reason: 'the server is eligible for review',
    );
    await app.tapKey('updates-review');
    await app.tapKey('updates-ack-server-will-disconnect');
    await app.tapKey('updates-apply');
    await app.pumpUntil(
      () => desk.jobReads > 0,
      reason: 'progress is being read before commit',
    );
    await f.storage.credentials.writeBrokerToken(
      profile.credentialKey!,
      'replacement',
    );
    desk.jobReadHeld!.complete();
    await app.waitFor(find.text(en.updatesReviewChanged));
    expect(desk.applies, isEmpty);
    expect(desk.preparations.values.single['phase'], 'ready');
    await app.tapKey('updates-cancel');
    await app.pumpUntil(
      () =>
          key('updates-review').evaluate().isNotEmpty &&
          app.tester.widget<FilledButton>(key('updates-review')).onPressed !=
              null,
      reason: 'inaccessible old work does not lock all future reviews',
    );
    expect(find.textContaining(en.updatesNeedsAttention), findsWidgets);
    expect(desk.applies, isEmpty);
  });
  featureTest(
    'a lost preparation response survives app restart and resumes the same job',
    (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final desk = UpdateDesk(studio, now: f.now)
        ..losePreparationResponse = true;
      await f.storage.seedServer(studio, ownerToken: 'owner');
      var app = await f.launch(
        initialLocation: updatesRoute,
        viewport: FeatureViewport.phoneTall,
        overrides: [clientIsWebProvider.overrideWithValue(true)],
      );
      await app.pumpUntil(
        () =>
            key('updates-review').evaluate().isNotEmpty &&
            app.tester.widget<FilledButton>(key('updates-review')).onPressed !=
                null,
        reason: 'the active server has an actionable update',
      );
      await app.tapKey('updates-review');
      await app.tapKey('updates-ack-server-will-disconnect');
      await app.tapKey('updates-apply');
      await app.waitFor(key('updates-continue'));
      expect(desk.preparations.length, 1);
      expect(desk.applies, isEmpty);
      app = await f.restart();
      await app.go(updatesRoute);
      await app.tapKey('updates-continue');
      await app.pumpUntil(
        () => desk.applies.isNotEmpty,
        reason: 'the original job is recovered',
      );
      expect(desk.preparations.length, 1);
      expect(desk.applies.length, 1);
    },
  );

  featureTest(
    'update permission is requested explicitly and revocation '
    'prevents an install',
    (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final desk = UpdateDesk(studio, now: f.now)..allowed = false;
      studio.peerTokens.add('phone');
      final profile = await f.storage.seedServer(studio, peerToken: 'phone');
      final app = await f.launch(
        initialLocation: updatesRoute,
        viewport: FeatureViewport.phoneTall,
        overrides: [clientIsWebProvider.overrideWithValue(true)],
      );
      await app.waitFor(key('updates-request-${profile.id}'));
      await app.tapKey('updates-request-${profile.id}');
      expect(desk.requests, contains('phone'));
      expect(desk.grants, isEmpty);
      await app.waitForAbsent(find.byType(SnackBar));
      await app.tapKey('updates-review');
      expect(
        find.descendant(
          of: key('updates-confirmation'),
          matching: find.text(en.updatesPermission),
        ),
        findsOneWidget,
      );
      expect(
        app.tester.widget<FilledButton>(key('updates-apply')).onPressed,
        isNull,
      );
      expect(desk.preparations, isEmpty);
      expect(desk.applies, isEmpty);
      await app.tap(find.text(en.cancel).last);
      desk.allowed = true;
      await app.tapKey('updates-check');
      await app.tapKey('updates-update-server-${profile.id}');
      await app.tapKey('updates-ack-server-will-disconnect');
      desk.preparationHeld = Completer<void>();
      await app.tapKey('updates-apply');
      await app.pumpUntil(
        () => desk.preparations.isNotEmpty,
        reason: 'the reviewed download is staged before revocation',
      );
      desk.revoked = true;
      desk.preparationHeld!.complete();
      await app.pumpUntil(
        () =>
            key('updates-continue').evaluate().isNotEmpty &&
            app.tester
                    .widget<FilledButton>(key('updates-continue'))
                    .onPressed !=
                null,
        reason: 'revocation pauses the prepared operation',
      );
      expect(desk.applies, isEmpty);
      expect(
        studio
            .requestsTo('/api/broker/updates/jobs/job-0/apply')
            .single
            .answered,
        403,
      );
    },
  );
  final dialog = find.byKey(const Key('android-client-update-dialog'));

  featureTest(
    'an Android update is offered, never installed without a tap, and '
    'followed through the download',
    (f) async {
      final studio = f.network.add('http://studio.test:7734');
      await f.storage.seedServer(studio);
      final desk = RuntimeDesk(studio, version: '0.6.0');
      final platform = _AndroidPlatform();
      final lifecycle = _Lifecycle();
      // The release the manifest names, and what the download does.
      var release = (version: '1.2.0', code: 12);
      var download = Completer<File>();
      var downloads = 0;
      Object? downloadError;
      var app = await f.launch(
        viewport: FeatureViewport.phoneTall,
        overrides: [
          androidUpdatePlatformProvider.overrideWithValue(platform),
          androidClientVersionProvider.overrideWithValue('1.1.0'),
          androidManifestFetcherProvider.overrideWithValue(
            () async => _androidManifest(release.version, release.code),
          ),
          androidApkDownloaderProvider.overrideWithValue((_, onProgress) {
            downloads += 1;
            for (final value in [0.001, 0.004, 0.4, 0.401, 0.409]) {
              onProgress(value);
            }
            if (downloadError != null) return Future.error(downloadError!);
            return download.future;
          }),
          sessionNotificationLifecycleMonitorProvider.overrideWithValue(
            lifecycle,
          ),
        ],
      );
      Future<void> relaunch(String version, int code) async {
        release = (version: version, code: code);
        download = Completer<File>();
        downloadError = null;
        app = await f.restart();
      }

      // An update is a dialog; Later closes it for good, and nothing installs
      // behind the user's back.
      expect(dialog, findsOneWidget);
      expect(find.text('Version 1.2.0 is ready to download.'), findsOneWidget);
      expect(find.text('This update stays in Settings → General.'), findsOne);
      expect(platform.installCalls, 0);
      expect(downloads, 0);
      await app.tapKey('android-client-update-later');
      expect(dialog, findsNothing);
      expect(platform.installCalls, 0);

      // A fresh launch with the same release does not ask again.
      app = await f.restart();
      expect(dialog, findsNothing);

      // A newer release is offered even after an older one closed; Android
      // back closes the dialog like any other.
      await relaunch('1.3.0', 13);
      expect(find.text('Version 1.3.0 is ready to download.'), findsOneWidget);
      await f.tester.binding.handlePopRoute();
      await app.settle();
      expect(dialog, findsNothing);
      app = await f.restart();
      expect(dialog, findsNothing, reason: 'Back counts as closing it');

      // The installed build is current: no dialog, no record of one.
      await relaunch('1.1.0', 11);
      expect(dialog, findsNothing);

      // Update follows the download. Mid-download the only action is a way
      // out; the download runs under its service and shows each percent once.
      await relaunch('1.4.0', 14);
      expect(dialog, findsOneWidget);
      await app.tapKey('android-client-update-action');
      expect(find.text('Downloading version 1.4.0…'), findsOneWidget);
      expect(
        f.tester
            .widget<LinearProgressIndicator>(
              key('android-client-update-progress'),
            )
            .value,
        0.4,
      );
      expect(key('android-client-update-action'), findsNothing);
      expect(find.text('Close'), findsOneWidget);
      expect(downloads, 1, reason: 'one download however often it is asked');
      expect(platform.starts.last.title, 'Downloading Cosyncing 1.4.0');
      expect(platform.starts.last.channelName, 'App updates');
      expect(platform.percents, [0, 40]);
      expect(platform.installCalls, 0, reason: 'nothing installs unfinished');
      download.complete(File('nonexistent-test-apk'));
      await app.settle();
      expect(platform.installCalls, 1);
      expect(dialog, findsNothing);
      expect(platform.stops.last, isNull);

      // A download finished out of sight waits for the app to be back: Android
      // opens an installer only for an app in front.
      await relaunch('1.5.0', 15);
      await app.tapKey('android-client-update-action');
      lifecycle.move(BrokerAppLifecycleState.paused);
      download.complete(File('nonexistent-test-apk'));
      await app.settle();
      expect(platform.installCalls, 1);
      final ready = platform.stops.last!;
      expect(ready.title, 'Cosyncing 1.5.0 is ready to install');
      expect(ready.text, 'Tap to install the update.');
      lifecycle.move(BrokerAppLifecycleState.inactive);
      await app.settle();
      expect(platform.installCalls, 1);
      lifecycle.move(BrokerAppLifecycleState.resumed);
      await app.settle();
      expect(platform.installCalls, 2);
      expect(platform.stops.last, isNull, reason: 'notice goes before install');

      // A refused service still downloads while the app stays open.
      platform.serviceStarts = false;
      await relaunch('1.6.0', 16);
      await app.tapKey('android-client-update-action');
      download.complete(File('nonexistent-test-apk'));
      await app.settle();
      expect(platform.installCalls, 3);
      platform.serviceStarts = true;

      // A failed download stops its service and leaves no ready notice.
      await relaunch('1.7.0', 17);
      downloadError = const FormatException('downloaded APK digest differs');
      final starts = platform.starts.length;
      await app.tapKey('android-client-update-action');
      await app.settle();
      expect(platform.starts, hasLength(starts + 1));
      expect(platform.stops.last, isNull);
      expect(platform.installCalls, 3, reason: 'a bad APK is never installed');
      expect(app.tester.takeException(), isNull);

      // Settings > Updates offers the same verified release and a re-check.
      await app.tester.binding.handlePopRoute();
      await app.settle();
      await relaunch('1.8.0', 18);
      await app.tapKey('android-client-update-later');
      await app.go(generalSettingsRoute);
      await app.tapKey('settings-general-updates');
      await app.reveal(key('settings-native-client-update-section'));
      expect(find.text('Version 1.8.0 is ready to download.'), findsOneWidget);
      expect(key('settings-native-client-update-install'), findsOneWidget);
      expect(platform.installCalls, 3, reason: 'offering is not installing');
      final beforeManualOffer = downloads;
      await app.tapKey('settings-native-client-update-install');
      await app.waitFor(key('settings-native-client-update-confirmation'));
      expect(find.text(en.updatesAndroidInstallerNotice), findsOneWidget);
      expect(downloads, beforeManualOffer);
      await app.tap(find.text(en.cancel).last);
      expect(downloads, beforeManualOffer);
      expect(platform.installCalls, 3);

      // No build pointer for a desktop on a phone: only desktops download.
      await app.go(brokerDevicesSettingsRoute);
      await app.waitFor(key('settings-broker-version'));
      expect(desk.version, '0.6.0');
      expect(key('settings-desktop-build-update'), findsNothing);
    },
    platform: TargetPlatform.android,
  );

  featureTest('a desktop is pointed at its download, and told only what is '
      'true about the broker', (f) async {
    final studio = f.network.add('http://studio.test:7734');
    final profile = await f.storage.seedServer(studio);
    final desk = RuntimeDesk(studio, version: '0.6.0');
    final launched = <Uri>[];
    var launcher = 'opens';
    var release = '0.5.9';
    var app = await f.launch(
      initialLocation: brokerDevicesSettingsRoute,
      overrides: [
        desktopClientVersionProvider.overrideWithValue('0.5.8'),
        stableReleaseManifestFetcherProvider.overrideWithValue(
          () async => _desktopManifest(release),
        ),
        desktopDownloadLauncherProvider.overrideWithValue((url) async {
          launched.add(url);
          if (launcher == 'throws') throw StateError('launcher unavailable');
          return launcher == 'opens';
        }),
      ],
    );
    final pointer = key('settings-desktop-updates-link');
    final behindAdvice = key('settings-client-behind-compatibility');

    // Seeds what the broker said about this client when it last greeted.
    Future<void> greeted() async {
      const broker = BrokerContractIdentity(
        revision: 6,
        minimumClientRevision: 0,
        surfaceHash: 'fnv1a32:095fc995',
      );
      await app.container
          .read(brokerIdentityStoreProvider)
          .writeHello(
            RosterSource.ofProfile(profile).storageKey,
            const HelloWireEvent(
              brokerVersion: '0.6.0',
              brokerContract: broker,
              clientVersion: '0.5.8',
              compatibility: BrokerClientCompatibility(
                status: BrokerClientCompatibilityStatus.clientBehind,
                readOnly: false,
                reason: 'client is one revision behind',
                broker: broker,
                client: ClientContractIdentity(
                  revision: cosyncingClientContractRevision,
                  minimumBrokerRevision: cosyncingClientMinimumBrokerRevision,
                  surfaceHash: cosyncingClientContractSurfaceHash,
                ),
              ),
            ),
          );
    }

    Future<void> reopen(String? brokerVersion) async {
      desk.version = brokerVersion;
      app = await f.restart(initialLocation: brokerDevicesSettingsRoute);
      await app.waitFor(key('settings-broker-version'));
    }

    // Every desktop version location opens the same Updates screen. The
    // eligible app release comes from its own channel, not this server.
    await app.waitFor(pointer);
    await app.tapKey('settings-open-updates');
    await app.waitFor(key('settings-native-client-update-section'));
    expect(find.text('Version 0.5.9 is ready to download.'), findsOneWidget);
    await app.tapKey('settings-native-client-update-download');
    await app.tapKey('settings-native-client-update-confirm');
    expect(launched.single.path, contains('client-v0.5.9/'));
    launcher = 'refuses';
    await app.tapKey('settings-native-client-update-download');
    await app.tapKey('settings-native-client-update-confirm');
    expect(
      find.text(en.settingsDesktopBuildUpdateLaunchFailed),
      findsOneWidget,
    );
    for (final brokerVersion in ['0.5.8', null, '0.5.7']) {
      await reopen(brokerVersion);
      expect(pointer, findsOneWidget, reason: '$brokerVersion');
    }

    // Cached compatibility advice stays attributed to the server it greeted.
    // The version link remains available independently of that advice.
    await reopen('0.6.0');
    await greeted();
    await reopen('0.6.0');
    expect(pointer, findsOneWidget);
    expect(behindAdvice, findsNothing, reason: 'no contradictory advice');
    await reopen('0.5.8');
    expect(pointer, findsOneWidget);
    expect(behindAdvice, findsOneWidget);
    expect(
      find.text(
        'Client update recommended for ${profile.displayName}. Install the '
        'latest signed app release to match this server.',
      ),
      findsOneWidget,
    );
    await reopen(null);
    expect(behindAdvice, findsOneWidget);
    await reopen('0.5.7');
    expect(pointer, findsOneWidget);
    expect(
      behindAdvice,
      findsNothing,
      reason: 'an ahead client needs no advice',
    );

    // The release channel: a newer desktop release lights the dot on the
    // Settings button and offers its own download in Settings > Updates.
    app = await f.restart(initialLocation: updatesRoute);
    await app.waitFor(key('settings-native-client-update-section'));
    expect(find.text('Version 0.5.9 is ready to download.'), findsOneWidget);
    launched.clear();
    launcher = 'opens';
    await app.tapKey('settings-native-client-update-download');
    await app.tapKey('settings-native-client-update-confirm');
    expect(
      launched.single.toString(),
      'https://github.com/cosyncing/cosyncing/releases/download/'
      'client-v0.5.9/cosyncing-client-0.5.9-linux-x64.tar.gz',
    );
    expect(app.container.read(nativeClientUpdateAvailableProvider), isTrue);
    release = '0.5.8';
    app = await f.restart(initialLocation: updatesRoute);
    await app.waitFor(key('settings-native-client-update-section'));
    expect(find.text('Version 0.5.9 is ready to download.'), findsNothing);
    expect(app.container.read(nativeClientUpdateAvailableProvider), isFalse);

    // The compact view at the largest text size still fits it.
    release = '0.5.9';
    final device = f.tester.platformDispatcher..textScaleFactorTestValue = 2;
    addTearDown(device.clearTextScaleFactorTestValue);
    f.tester.view
      ..physicalSize = const Size(360, 640)
      ..devicePixelRatio = 1;
    addTearDown(() {
      f.tester.view
        ..resetPhysicalSize()
        ..resetDevicePixelRatio();
    });
    for (final language in const [Locale('en'), Locale('es')]) {
      await app.container
          .read(localeControllerProvider.notifier)
          .setLocale(language);
      app = await f.restart(initialLocation: updatesRoute);
      await app.waitFor(key('settings-native-client-update-section'));
      await app.reveal(key('settings-native-client-update-download'));
      expect(app.tester.takeException(), isNull, reason: '$language');
    }
  });

  featureTest('the broker release status and health say only what is known', (
    f,
  ) async {
    final studio = f.network.add('http://studio.test:7734');
    await f.storage.seedServer(studio);
    final desk = RuntimeDesk(studio, version: '0.6.0');
    var app = await f.launch(
      viewport: FeatureViewport.desktopTall,
      initialLocation: brokerDevicesSettingsRoute,
    );
    Future<void> reopen() async {
      app = await f.restart(initialLocation: brokerDevicesSettingsRoute);
      await app.waitFor(key('settings-broker-version'));
    }

    final current = key('settings-broker-status-current');
    final unchecked = key('settings-broker-status-unchecked');
    final packageManaged = key('settings-broker-status-package-managed');
    final guidance = key('settings-broker-package-managed-body');
    final runtimeUpgrade = key(
      'settings-broker-status-runtime-upgrade-required',
    );
    final runtimeGuidance = key(
      'settings-broker-runtime-upgrade-required-body',
    );
    final updateButton = key('settings-update-broker');
    void snapshot(String status, String detail, {String? latest}) =>
        desk.brokerUpdate = {
          'status': status,
          'currentVersion': '0.6.0',
          'latestVersion': ?latest,
          'checkedAt': '2026-08-05T00:00:00Z',
          'detailCode': detail,
        };

    // An npm broker never consults the release channel: reporting it as
    // current is a claim the app has no evidence for.
    snapshot('unknown', 'upgrade-package-manager-owned');
    for (final language in const [Locale('en'), Locale('zh')]) {
      await app.container
          .read(localeControllerProvider.notifier)
          .setLocale(language);
      await reopen();
      expect(packageManaged, findsOneWidget);
      expect(current, findsNothing);
      expect(
        find.text(
          language.languageCode == 'en' ? 'Managed by npm' : '由 npm 管理',
        ),
        findsOneWidget,
      );
      expect(find.text('Current'), findsNothing);
      expect(find.text('已是最新'), findsNothing);
      // The honest state also says what to do next.
      expect(guidance, findsOneWidget);
      expect(find.textContaining('https://cosyncing.com/#install'), findsOne);
      expect(find.textContaining('cosy update'), findsOneWidget);
    }
    await app.container
        .read(localeControllerProvider.notifier)
        .setLocale(const Locale('en'));

    // An unreachable channel is not a channel that reported good news.
    snapshot('unknown', 'release-channel-unconfigured');
    await reopen();
    expect(unchecked, findsOneWidget);
    expect(find.text('Not checked'), findsOneWidget);
    expect(
      [
        current,
        packageManaged,
        guidance,
        runtimeUpgrade,
        runtimeGuidance,
      ].map((k) => k.evaluate()),
      everyElement(isEmpty),
    );

    // The one state that supports the claim still makes it.
    snapshot('current', 'current');
    await reopen();
    expect(current, findsOneWidget);
    expect(find.text('Current'), findsOneWidget);
    expect(unchecked, findsNothing);

    // An available release offers its button.
    snapshot('update-available', 'update-available');
    await reopen();
    expect(updateButton, findsOneWidget);
    expect(current, findsNothing);
    expect(unchecked, findsNothing);
    expect(packageManaged, findsNothing);
    expect(runtimeUpgrade, findsNothing);

    // A newer release whose Bun this install cannot place itself (a Bun
    // chosen with COSYNCING_BUN_BIN, or no pinned build for the host): `cosy
    // update` would refuse it, so no button, and "Not checked" would hide the
    // release. The pill says so; the guidance names the release and the
    // command to run once the runtime has moved.
    snapshot(
      'unknown',
      'release-runtime-upgrade-required',
      latest: '0.7.0',
    );
    for (final (language, pill) in const [
      (Locale('en'), 'Needs newer Bun'),
      (Locale('zh'), '需要更新 Bun'),
      (Locale('ja'), '新しい Bun が必要'),
      (Locale('ko'), '새 Bun 필요'),
      (Locale('es'), 'Requiere Bun nuevo'),
    ]) {
      await app.container
          .read(localeControllerProvider.notifier)
          .setLocale(language);
      await reopen();
      expect(runtimeUpgrade, findsOneWidget, reason: '$language');
      expect(find.text(pill), findsOneWidget, reason: '$language');
      final body = f.tester.widget<SelectableText>(runtimeGuidance).data!;
      expect(body, contains('0.7.0'), reason: '$language');
      expect(body, contains('cosy update'), reason: '$language');
      expect(body, contains('Bun'), reason: '$language');
      expect(
        [
          updateButton,
          current,
          unchecked,
          packageManaged,
          guidance,
        ].map((k) => k.evaluate()),
        everyElement(isEmpty),
        reason: '$language',
      );
    }
    await app.container
        .read(localeControllerProvider.notifier)
        .setLocale(const Locale('en'));

    // Persistence health is named without presenting severity as it, and an
    // unrecognized status is never printed raw.
    snapshot('current', 'current');
    for (final (status, language, text) in [
      ('critical', 'en', 'Persistence or storage checks need attention.'),
      ('critical', 'zh', '持久化或存储检查需要处理。'),
      ('degraded', 'en', 'Persistence or storage checks are degraded.'),
      ('degraded', 'zh', '持久化或存储检查处于降级状态。'),
      (
        'future-attention-severity',
        'en',
        'Server health checks are unavailable.',
      ),
    ]) {
      desk.healthStatus = status;
      await app.container
          .read(localeControllerProvider.notifier)
          .setLocale(Locale(language));
      await reopen();
      expect(find.text(text), findsOneWidget, reason: '$status $language');
      expect(find.textContaining('Status: critical'), findsNothing);
      expect(find.textContaining('状态：critical'), findsNothing);
      expect(find.textContaining('future-attention-severity'), findsNothing);
    }
    expect(app.tester.takeException(), isNull);
  });

  featureTest('the web client offers no app update, and a draft defers a '
      'handoff until it is gone', (f) async {
    final studio = f.network.add('http://studio.test:7734')
      ..addSession('s1', 'Fix login');
    ComposerDesk(studio);
    await f.storage.seedServer(studio);
    final registry = WebHandoffParticipants.instance;
    final app = await f.launch(
      overrides: [
        clientIsWebProvider.overrideWithValue(true),
        stableReleaseManifestFetcherProvider.overrideWithValue(
          () async => _desktopManifest('9.9.9'),
        ),
      ],
    );
    addTearDown(registry.reset);

    // A web page is updated by reloading, not by downloading a build.
    await app.go(generalSettingsRoute);
    expect(key('settings-native-client-update-section'), findsNothing);
    expect(key('sessions-workspace-settings'), findsOneWidget);
    await app.go(sessionsRoute);
    await app.openFromRoster('s1', cwd: '/work/studio');

    // With nothing typed the tab may be moved; a draft refuses it, and
    // nothing is flushed or frozen for a round that is not going to happen.
    expect(await registry.prepare(), isTrue);
    await app.type('half a thought');
    expect(await registry.prepare(), isFalse);
    expect(registry.frozen.value, isFalse);

    // Clearing it makes the tab movable again; the commit window then refuses
    // typing, and handing the surface back restores it.
    await app.type('');
    expect(await registry.prepare(), isTrue);
    final commit = registry.commit();
    expect(registry.frozen.value, isTrue);
    f.tester.testTextInput.enterText('must not land');
    await f.tester.idle();
    expect(app.composerText, isEmpty, reason: 'the frozen tab takes no input');
    expect(await commit, isTrue);
    registry.releaseAll();
    await app.settle();
    await app.type('lands after release');
    expect(app.composerText, 'lands after release');
  });
}
