import 'dart:convert';
import 'dart:io';

import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_handoff.dart';
import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_inbox.dart';
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
}
