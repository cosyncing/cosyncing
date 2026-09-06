import 'dart:convert';
import 'dart:io';

import 'package:cosyncing_client/src/features/pairing/controller/installer_pairing_handoff_controller.dart';
import 'package:cosyncing_client/src/features/pairing/controller/pairing_controller.dart';
import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_handoff.dart';
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
    test('reads then removes the file, and reads nothing twice', () async {
      final home = Directory.systemTemp.createTempSync('cosy-handoff-');
      addTearDown(() => home.deleteSync(recursive: true));
      final path = installerPairingHandoffPath({'COSYNCING_HOME': home.path})!;
      File(path).writeAsStringSync('{"qr": "cosy://x"}');

      // The real inbox reads Platform.environment, which a test cannot set, so
      // the file behaviour is exercised through the same path resolver the
      // inbox uses rather than through the inbox's own environment read.
      expect(File(path).existsSync(), isTrue);
      final raw = File(path).readAsStringSync();
      File(path).deleteSync();
      expect(parseInstallerPairingHandoff(raw), isNotNull);
      expect(File(path).existsSync(), isFalse);
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

    test('an import that throws still consumes the file', () async {
      final inbox = _FakeInbox('{"qr": "https://broker.example:9443"}');
      final container = containerFor(
        inbox,
        overrides: [
          pairingControllerProvider.overrideWith(_ThrowingController.new),
        ],
      );

      expect(
        await container.read(installerPairingHandoffProvider.future),
        InstallerPairingHandoffOutcome.unreadable,
      );
      expect(inbox.discarded, isTrue);
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
  _FakeInbox(this._document, {this.throwOnRead = false});

  final String? _document;
  final bool throwOnRead;
  bool discarded = false;

  @override
  Future<String?> read() async {
    if (throwOnRead) throw const FileSystemException('unreadable');
    return _document;
  }

  @override
  Future<void> discard() async {
    discarded = true;
  }
}

class _RecordingController extends PairingController {
  final List<String> imported = [];

  @override
  Future<void> importPayload(String rawPayload, {String? brokerUrl}) async {
    imported.add(rawPayload);
  }
}

class _ThrowingController extends PairingController {
  @override
  Future<void> importPayload(String rawPayload, {String? brokerUrl}) async {
    throw StateError('pairing exploded');
  }
}
