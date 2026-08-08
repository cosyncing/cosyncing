import 'package:cosyncing_client/src/platform/update/desktop_client_update.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('resolveClientUpdateGuidance', () {
    ClientUpdateGuidance guidance({
      TargetPlatform platform = TargetPlatform.linux,
      bool isWeb = false,
      String? brokerVersion = '1.3.0',
      String clientVersion = '1.3.0',
      bool compatibilityFallbackAvailable = false,
    }) => resolveClientUpdateGuidance(
      platform: platform,
      isWeb: isWeb,
      brokerVersion: brokerVersion,
      clientVersion: clientVersion,
      compatibilityFallbackAvailable: compatibilityFallbackAvailable,
    );

    test('missing versions produce no desktop update pointer', () {
      expect(guidance(brokerVersion: null), ClientUpdateGuidance.none);
      expect(guidance(clientVersion: ''), ClientUpdateGuidance.none);
    });

    test('equal versions produce no release-level guidance', () {
      expect(guidance(), ClientUpdateGuidance.none);
    });

    test('behind client gives the desktop pointer sole ownership', () {
      expect(
        guidance(
          brokerVersion: '1.4.0',
          compatibilityFallbackAvailable: true,
        ),
        ClientUpdateGuidance.desktopDownload,
      );
    });

    test('ahead client suppresses contradictory compatibility advice', () {
      expect(
        guidance(
          brokerVersion: '1.2.0',
          compatibilityFallbackAvailable: true,
        ),
        ClientUpdateGuidance.none,
      );
    });

    test('compatibility fallback owns equal or unreadable comparisons', () {
      expect(
        guidance(compatibilityFallbackAvailable: true),
        ClientUpdateGuidance.compatibilityFallback,
      );
      expect(
        guidance(
          brokerVersion: null,
          compatibilityFallbackAvailable: true,
        ),
        ClientUpdateGuidance.compatibilityFallback,
      );
      expect(
        guidance(
          brokerVersion: '1.4.0-rc.1',
          compatibilityFallbackAvailable: true,
        ),
        ClientUpdateGuidance.compatibilityFallback,
      );
    });

    test('web and mobile can only use compatibility guidance', () {
      expect(
        guidance(
          isWeb: true,
          brokerVersion: '1.4.0',
          compatibilityFallbackAvailable: true,
        ),
        ClientUpdateGuidance.compatibilityFallback,
      );
      expect(
        guidance(
          platform: TargetPlatform.android,
          brokerVersion: '1.4.0',
          compatibilityFallbackAvailable: true,
        ),
        ClientUpdateGuidance.compatibilityFallback,
      );
    });
  });

  group('desktopClientUpdateAvailable', () {
    bool available({
      TargetPlatform platform = TargetPlatform.linux,
      bool isWeb = false,
      String? brokerVersion = '1.4.0',
      String clientVersion = '1.3.0',
    }) => desktopClientUpdateAvailable(
      platform: platform,
      isWeb: isWeb,
      brokerVersion: brokerVersion,
      clientVersion: clientVersion,
    );

    test('points at a download when the broker release is newer', () {
      expect(available(), isTrue);
      expect(available(brokerVersion: '1.3.1'), isTrue);
      expect(available(brokerVersion: '2.0.0'), isTrue);
      expect(
        available(brokerVersion: '1.10.0', clientVersion: '1.9.0'),
        isTrue,
      );
    });

    test('stays silent when the versions are equal', () {
      expect(available(brokerVersion: '1.3.0'), isFalse);
    });

    test('stays silent when this build is ahead of the broker', () {
      expect(available(brokerVersion: '1.2.9'), isFalse);
      expect(available(brokerVersion: '0.9.0'), isFalse);
    });

    test('fails closed when the broker reports no readable version', () {
      expect(available(brokerVersion: null), isFalse);
      expect(available(brokerVersion: ''), isFalse);
      expect(available(brokerVersion: 'unknown'), isFalse);
      expect(available(brokerVersion: '1.4'), isFalse);
      expect(available(brokerVersion: '1.4.0-rc1'), isFalse);
      expect(available(brokerVersion: 'v1.4.0'), isFalse);
    });

    test('fails closed on an unstamped desktop build', () {
      // The compiled-in default when no release pipeline passed
      // --dart-define=COSYNCING_CLIENT_VERSION.
      expect(available(clientVersion: '0.0.0-dev'), isFalse);
      expect(available(clientVersion: ''), isFalse);
    });

    test('never fires off native desktop', () {
      expect(available(isWeb: true), isFalse);
      // A browser on a desktop OS reports that OS as its target platform.
      expect(available(platform: TargetPlatform.macOS, isWeb: true), isFalse);
      expect(available(platform: TargetPlatform.android), isFalse);
      expect(available(platform: TargetPlatform.iOS), isFalse);
      expect(available(platform: TargetPlatform.fuchsia), isFalse);
    });

    test('fires on every native desktop platform', () {
      for (final platform in [
        TargetPlatform.windows,
        TargetPlatform.linux,
        TargetPlatform.macOS,
      ]) {
        expect(available(platform: platform), isTrue, reason: '$platform');
      }
    });
  });

  test('the download page is the one place the repository is named', () {
    expect(
      desktopClientDownloadUrl,
      'https://github.com/cosyncing/cosyncing/releases',
    );
  });

  group('isDesktopClientPlatform', () {
    test('separates native desktop from the web and mobile', () {
      expect(isDesktopClientPlatform(TargetPlatform.linux, isWeb: false), true);
      expect(isDesktopClientPlatform(TargetPlatform.linux, isWeb: true), false);
      expect(
        isDesktopClientPlatform(TargetPlatform.android, isWeb: false),
        false,
      );
    });
  });
}
