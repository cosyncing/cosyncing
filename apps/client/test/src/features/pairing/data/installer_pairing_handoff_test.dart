import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cosyncing_client/src/features/pairing/controller/installer_pairing_handoff_controller.dart';
import 'package:cosyncing_client/src/features/pairing/controller/pairing_controller.dart';
import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_handoff.dart';
import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_inbox.dart';
import 'package:cosyncing_client/src/features/pairing/data/secure_storage_preflight.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('parseInstallerPairingHandoff', () {
    test('reads the document the installer writes', () {
      final handoff = parseInstallerPairingHandoff(
        jsonEncode({
          'schemaVersion': 1,
          'qr': 'cosy://pair/v3?x=1',
          'brokerUrl': 'http://127.0.0.1:7734',
          'expiresAt': '2026-09-05T12:05:00.000Z',
        }),
      );

      expect(handoff, isNotNull);
      expect(handoff!.qr, 'cosy://pair/v3?x=1');
      expect(handoff.brokerUrl, 'http://127.0.0.1:7734');
      expect(handoff.expiresAt, DateTime.utc(2026, 9, 5, 12, 5));
    });

    test('treats every malformed shape as no handoff at all', () {
      expect(parseInstallerPairingHandoff('not json'), isNull);
      expect(parseInstallerPairingHandoff('[]'), isNull);
      expect(parseInstallerPairingHandoff('{}'), isNull);
      expect(parseInstallerPairingHandoff('{"qr": 7}'), isNull);
      expect(parseInstallerPairingHandoff('{"qr": "   "}'), isNull);
    });

    test('a missing or unparseable expiry leaves the offer live', () {
      final noExpiry = parseInstallerPairingHandoff('{"qr": "cosy://x"}');
      expect(noExpiry!.hasExpired(DateTime(2026, 9, 5)), isFalse);

      final badExpiry = parseInstallerPairingHandoff(
        '{"qr": "cosy://x", "expiresAt": "soon"}',
      );
      expect(badExpiry!.expiresAt, isNull);
      expect(badExpiry.hasExpired(DateTime(2026, 9, 5)), isFalse);
    });

    test('an offer is expired at its deadline, not after it', () {
      final handoff = parseInstallerPairingHandoff(
        '{"qr": "cosy://x", "expiresAt": "2026-09-05T12:05:00.000Z"}',
      )!;

      expect(handoff.hasExpired(DateTime.utc(2026, 9, 5, 12, 4, 59)), isFalse);
      expect(handoff.hasExpired(DateTime.utc(2026, 9, 5, 12, 5)), isTrue);
    });

    test('a URL-free offer keeps a null broker URL', () {
      final handoff = parseInstallerPairingHandoff(
        '{"qr": "cosy://x", "brokerUrl": "  "}',
      );

      expect(handoff!.brokerUrl, isNull);
    });
  });

  group('installerPairingHandoffPath', () {
    test('COSYNCING_HOME wins and must be absolute', () {
      expect(
        installerPairingHandoffPath({
          'COSYNCING_HOME': '/srv/cosy',
          'HOME': '/user-home',
        }),
        '/srv/cosy/client-pairing.json',
      );
      expect(
        installerPairingHandoffPath({
          'COSYNCING_HOME': 'relative/cosy',
          'HOME': '/user-home',
        }),
        '/user-home/.cosyncing/client-pairing.json',
      );
    });

    test('falls back to HOME, then to the Windows USERPROFILE', () {
      expect(
        installerPairingHandoffPath({'HOME': '/user-home'}),
        '/user-home/.cosyncing/client-pairing.json',
      );
      expect(
        installerPairingHandoffPath({
          'USERPROFILE': r'C:\profile',
        }, separator: r'\'),
        r'C:\profile\.cosyncing\client-pairing.json',
      );
    });

    test('an environment with no home at all resolves nothing', () {
      expect(installerPairingHandoffPath(const {}), isNull);
    });
  });

  group('FileInstallerPairingInbox', () {
    test('atomically claims, releases, and later discards an offer', () async {
      final home = Directory.systemTemp.createTempSync('cosy-handoff-');
      addTearDown(() => home.deleteSync(recursive: true));
      final path = installerPairingHandoffPath({'COSYNCING_HOME': home.path})!;
      File(path).writeAsStringSync('{"qr": "cosy://x"}');
      final inbox = FileInstallerPairingInbox(path: path);

      expect(parseInstallerPairingHandoff((await inbox.read())!), isNotNull);
      expect(File(path).existsSync(), isFalse);
      expect(File('$path.claimed').existsSync(), isTrue);

      await inbox.release();
      File(path).writeAsStringSync('{"qr": "cosy://fresh"}');
      final retry = FileInstallerPairingInbox(path: path);
      expect(parseInstallerPairingHandoff((await retry.read())!), isNotNull);
      expect(await retry.discard(), isTrue);
      expect(File('$path.claimed').existsSync(), isFalse);
      final fresh = FileInstallerPairingInbox(path: path);
      expect(
        parseInstallerPairingHandoff((await fresh.read())!)!.qr,
        'cosy://fresh',
      );
      expect(await fresh.discard(), isTrue);
    });
  });

  group('installerPairingHandoffProvider', () {
    ProviderContainer containerFor(
      _FakeInbox inbox, {
      DateTime? now,
      List<Override> overrides = const [],
    }) {
      final container = ProviderContainer(
        overrides: [
          installerPairingInboxProvider.overrideWithValue(inbox),
          installerPairingStoragePreflightProvider.overrideWithValue(
            _StoragePreflight().verify,
          ),
          installerPairingBrokerPreflightProvider.overrideWithValue(
            _BrokerPreflight().verify,
          ),
          installerPairingRetryDelayProvider.overrideWithValue((_) async {}),
          if (now != null)
            installerPairingClockProvider.overrideWithValue(() => now),
          ...overrides,
        ],
      );
      addTearDown(container.dispose);
      return container;
    }

    test('an absent inbox is a no-op and discards nothing to import', () async {
      final inbox = _FakeInbox(null);
      final container = containerFor(inbox);

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.absent,
      );
      expect(inbox.discarded, isFalse);
    });

    test('a live offer reaches the pairing controller', () async {
      final inbox = _FakeInbox(
        jsonEncode({
          'qr': 'https://broker.example:9443',
          'expiresAt': '2026-09-05T12:05:00.000Z',
        }),
      );
      final container = containerFor(
        inbox,
        now: DateTime.utc(2026, 9, 5, 12),
        overrides: [
          pairingControllerProvider.overrideWith(_RecordingController.new),
        ],
      );

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.imported,
      );
      final controller =
          container.read(pairingControllerProvider.notifier)
              as _RecordingController;
      expect(controller.imported, ['https://broker.example:9443']);
      expect(inbox.discarded, isTrue);
    });

    test('an expired offer is discarded without importing', () async {
      final inbox = _FakeInbox(
        jsonEncode({
          'qr': 'https://broker.example:9443',
          'expiresAt': '2026-09-05T12:05:00.000Z',
        }),
      );
      final container = containerFor(
        inbox,
        now: DateTime.utc(2026, 9, 5, 12, 30),
        overrides: [
          pairingControllerProvider.overrideWith(_RecordingController.new),
        ],
      );

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.expired,
      );
      final controller =
          container.read(pairingControllerProvider.notifier)
              as _RecordingController;
      expect(controller.imported, isEmpty);
      expect(inbox.discarded, isTrue);
    });

    test('a fresh pending offer follows an expired stale claim', () async {
      final inbox = _FakeInbox(
        jsonEncode({
          'qr': 'https://broker.example/stale',
          'expiresAt': '2026-09-05T11:00:00.000Z',
        }),
        nextDocument: jsonEncode({
          'qr': 'https://broker.example/fresh',
          'expiresAt': '2026-09-05T12:05:00.000Z',
        }),
      );
      final container = containerFor(
        inbox,
        now: DateTime.utc(2026, 9, 5, 12),
        overrides: [
          pairingControllerProvider.overrideWith(_RecordingController.new),
        ],
      );

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.imported,
      );
      final controller =
          container.read(pairingControllerProvider.notifier)
              as _RecordingController;
      expect(controller.imported, ['https://broker.example/fresh']);
    });

    test('a malformed offer is discarded without importing', () async {
      final inbox = _FakeInbox('{ not json');
      final container = containerFor(
        inbox,
        overrides: [
          pairingControllerProvider.overrideWith(_RecordingController.new),
        ],
      );

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.unreadable,
      );
      expect(inbox.discarded, isTrue);
    });

    test(
      'an ambiguous import failure is not retried',
      () async {
        final inbox = _FakeInbox('{"qr": "https://broker.example:9443"}');
        final container = containerFor(
          inbox,
          overrides: [
            pairingControllerProvider.overrideWith(_ThrowingController.new),
          ],
        );

        expect(
          await container.read(installerPairingHandoffProvider.future),
          InstallerPairingHandoffOutcome.failed,
        );
        expect(inbox.discarded, isTrue);
        final controller =
            container.read(pairingControllerProvider.notifier)
                as _ThrowingController;
        expect(controller.attempts, 1);
      },
    );

    test('reports a malformed offer that cannot be removed', () async {
      final inbox = _FakeInbox('{ not json', discardSucceeds: false);
      final container = containerFor(inbox);

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.discardFailed,
      );
      expect(inbox.discarded, isTrue);
    });

    test('keeps the offer when secure storage never becomes ready', () async {
      final inbox = _FakeInbox(
        jsonEncode({
          'qr': 'https://broker.example:9443',
          'expiresAt': '2026-09-05T12:05:00.000Z',
        }),
      );
      final preflight = _StoragePreflight(failuresBeforeSuccess: 99);
      final container = containerFor(
        inbox,
        now: DateTime.utc(2026, 9, 5, 12),
        overrides: [
          installerPairingStoragePreflightProvider.overrideWithValue(
            preflight.verify,
          ),
          pairingControllerProvider.overrideWith(_RecordingController.new),
        ],
      );

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.secureStorageUnavailable,
      );
      expect(preflight.attempts, 5);
      expect(inbox.discarded, isFalse);
      expect(inbox.released, isTrue);
      final controller =
          container.read(pairingControllerProvider.notifier)
              as _RecordingController;
      expect(controller.imported, isEmpty);
    });

    test('discards an offer that expires during storage retries', () async {
      final inbox = _FakeInbox(
        jsonEncode({
          'qr': 'https://broker.example:9443',
          'expiresAt': '2026-09-05T12:05:00.000Z',
        }),
      );
      final moments = <DateTime>[
        DateTime.utc(2026, 9, 5, 12),
        DateTime.utc(2026, 9, 5, 12, 6),
      ];
      var clockReads = 0;
      final container = containerFor(
        inbox,
        overrides: [
          installerPairingClockProvider.overrideWithValue(
            () =>
                moments[clockReads < moments.length
                    ? clockReads++
                    : moments.length - 1],
          ),
          installerPairingStoragePreflightProvider.overrideWithValue(
            _StoragePreflight(failuresBeforeSuccess: 99).verify,
          ),
        ],
      );

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.expired,
      );
      expect(inbox.discarded, isTrue);
    });

    test('retries secure storage before redeeming the offer', () async {
      final inbox = _FakeInbox(
        jsonEncode({
          'qr': 'https://broker.example:9443',
          'expiresAt': '2026-09-05T12:05:00.000Z',
        }),
      );
      final preflight = _StoragePreflight(failuresBeforeSuccess: 2);
      final container = containerFor(
        inbox,
        now: DateTime.utc(2026, 9, 5, 12),
        overrides: [
          installerPairingStoragePreflightProvider.overrideWithValue(
            preflight.verify,
          ),
          pairingControllerProvider.overrideWith(_RecordingController.new),
        ],
      );

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.imported,
      );
      expect(preflight.attempts, 3);
      expect(inbox.discarded, isTrue);
    });

    test('does not redeem when the claimed offer cannot be erased', () async {
      final inbox = _FakeInbox(
        '{"qr": "https://broker.example:9443"}',
        discardSucceeds: false,
      );
      final container = containerFor(
        inbox,
        overrides: [
          pairingControllerProvider.overrideWith(_RecordingController.new),
        ],
      );

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.discardFailed,
      );
      final controller =
          container.read(pairingControllerProvider.notifier)
              as _RecordingController;
      expect(controller.imported, isEmpty);
    });

    // Claiming protects the safe preflights. The reusable bytes are erased
    // immediately before the non-idempotent acceptance call.
    test(
      'the offer is erased before redemption is attempted',
      () async {
        final inbox = _FakeInbox(
          jsonEncode({
            'qr': 'https://broker.example:9443',
            'expiresAt': '2026-09-05T12:05:00.000Z',
          }),
        );
        final container = containerFor(
          inbox,
          now: DateTime.utc(2026, 9, 5, 12),
          overrides: [
            pairingControllerProvider.overrideWith(_StalledController.new),
          ],
        );

        // Never awaited: this import never completes, which is the whole point.
        unawaited(container.read(installerPairingHandoffProvider.future));
        final controller =
            container.read(pairingControllerProvider.notifier)
                as _StalledController;
        await controller.started.future;

        expect(inbox.claimed, isTrue);
        expect(inbox.discarded, isTrue);
      },
    );

    test('retries broker readiness and accepts the offer only once', () async {
      final inbox = _FakeInbox(
        jsonEncode({
          'qr': 'https://broker.example:9443',
          'expiresAt': '2026-09-05T12:05:00.000Z',
        }),
      );
      final container = containerFor(
        inbox,
        now: DateTime.utc(2026, 9, 5, 12),
        overrides: [
          installerPairingBrokerPreflightProvider.overrideWithValue(
            _BrokerPreflight(failuresBeforeSuccess: 3).verify,
          ),
          pairingControllerProvider.overrideWith(_RecordingController.new),
        ],
      );

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.imported,
      );
      final controller =
          container.read(pairingControllerProvider.notifier)
              as _RecordingController;
      expect(controller.imported, ['https://broker.example:9443']);
      expect(inbox.discarded, isTrue);
      expect(inbox.released, isFalse);
    });

    test('an unreadable inbox never blocks startup', () async {
      final inbox = _FakeInbox(null, throwOnRead: true);
      final container = containerFor(inbox);

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.absent,
      );
    });
  });
}

class _FakeInbox implements InstallerPairingInbox {
  _FakeInbox(
    this._document, {
    this.throwOnRead = false,
    this.discardSucceeds = true,
    this.nextDocument,
  });

  String? _document;
  String? nextDocument;
  bool _pendingReady = false;
  final bool throwOnRead;
  final bool discardSucceeds;
  bool discarded = false;
  bool released = false;
  bool claimed = false;

  @override
  Future<String?> read() async {
    if (throwOnRead) throw const FileSystemException('unreadable');
    _pendingReady = false;
    claimed = _document != null;
    return _document;
  }

  @override
  Future<bool> discard() async {
    discarded = true;
    if (discardSucceeds) {
      _document = nextDocument;
      nextDocument = null;
      _pendingReady = _document != null;
    }
    return discardSucceeds;
  }

  @override
  Future<void> release() async {
    released = true;
  }

  @override
  Future<bool> hasPending() async => _pendingReady;

  @override
  Stream<void> changes() => const Stream<void>.empty();
}

class _RecordingController extends PairingController {
  final List<String> imported = [];

  @override
  Future<void> importPayload(String rawPayload, {String? brokerUrl}) async {
    imported.add(rawPayload);
    state = PairingControllerState(notice: PairingNotice.devicePaired);
  }
}

/// A controller whose import never returns, so a discard that waits for it
/// never happens.
class _StalledController extends PairingController {
  final Completer<void> started = Completer<void>();

  @override
  Future<void> importPayload(String rawPayload, {String? brokerUrl}) {
    if (!started.isCompleted) started.complete();
    return Completer<void>().future;
  }
}

class _ThrowingController extends PairingController {
  int attempts = 0;

  @override
  Future<void> importPayload(String rawPayload, {String? brokerUrl}) async {
    attempts += 1;
    throw StateError('pairing exploded');
  }
}

class _BrokerPreflight {
  _BrokerPreflight({this.failuresBeforeSuccess = 0});

  final int failuresBeforeSuccess;
  int attempts = 0;

  Future<void> verify(String brokerUrl) async {
    attempts += 1;
    if (attempts <= failuresBeforeSuccess) {
      throw StateError('fixture broker unavailable');
    }
  }
}

class _StoragePreflight {
  _StoragePreflight({this.failuresBeforeSuccess = 0});

  final int failuresBeforeSuccess;
  int attempts = 0;

  Future<void> verify() async {
    attempts += 1;
    if (attempts <= failuresBeforeSuccess) {
      throw const SecureStoragePreflightException(
        'fixture storage unavailable',
      );
    }
  }
}
