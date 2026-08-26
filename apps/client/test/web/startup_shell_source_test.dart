import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// N3 part A/B: structural invariants of the web startup shell and its worker.
///
/// These read the real `web/` sources, so they fail on the previous
/// implementation (which had no shell, no handshake and no worker) and they
/// fail again if a future edit quietly reintroduces a remote asset, drops the
/// browser-zoom listener, or lets something other than the Dart post-frame
/// callback dismiss the shell. The behavioural half — that the shell is
/// actually painted and actually removed — is covered by
/// `scripts/client/tests/test-startup-shell-browser.mjs` in a real browser.
void main() {
  final web = Directory('web');
  final indexHtml = File('${web.path}/index.html').readAsStringSync();
  final workerJs = File('${web.path}/sw.js').readAsStringSync();
  final bootstrapJs = File(
    '${web.path}/flutter_bootstrap.js',
  ).readAsStringSync();

  group('index.html shell', () {
    test('protects open session tabs from accidental browser close', () {
      expect(indexHtml, contains("addEventListener('beforeunload'"));
      expect(indexHtml, contains('cosyncingSetBrowserCloseProtection'));
      expect(indexHtml, contains("event.returnValue = ''"));
      expect(indexHtml, contains('cosyncingAllowIntentionalUnload'));
      expect(
        indexHtml.indexOf('cosyncingAllowIntentionalUnload();'),
        lessThan(indexHtml.indexOf('location.replace(handoffHref')),
      );
    });

    test('paints a branded shell in the initial HTML body', () {
      final bodyStart = indexHtml.indexOf('<body>');
      expect(bodyStart, greaterThan(0));
      final shellStart = indexHtml.indexOf('id="cosyncing-startup-shell"');
      expect(
        shellStart,
        greaterThan(bodyStart),
        reason: 'the shell must be markup in the first response, not injected',
      );
      // The mark is inline SVG, so it needs no network round trip.
      expect(indexHtml, contains('<svg class="cosyncing-shell-mark"'));
      expect(indexHtml, contains('cosyncing'));
    });

    test('uses only inline assets — no remote CSS, font, image or script', () {
      final remoteReference = RegExp(
        r'''(src|href)\s*=\s*["'](https?:)?//''',
        caseSensitive: false,
      );
      expect(
        remoteReference.hasMatch(indexHtml),
        isFalse,
        reason: 'the shell must paint without any network dependency',
      );
      for (final host in ['gstatic.com', 'googleapis.com', 'cdn.', 'unpkg']) {
        expect(indexHtml, isNot(contains(host)));
      }
    });

    test('sets a correct light and dark background from the first paint', () {
      expect(indexHtml, contains('prefers-color-scheme: dark'));
      // The app's default theme canvas, so the shell and Flutter's first
      // surface are the same colour in both schemes.
      expect(indexHtml, contains('#F2F5F4'));
      expect(indexHtml, contains('#0B0E14'));
      expect(indexHtml, contains('background: var(--cosync-canvas)'));
      expect(
        indexHtml,
        contains(
          '<meta name="theme-color" media="(prefers-color-scheme: light)"',
        ),
      );
      expect(
        indexHtml,
        contains(
          '<meta name="theme-color" media="(prefers-color-scheme: dark)"',
        ),
      );
    });

    test('the loading state is accessible', () {
      expect(indexHtml, contains('role="status"'));
      expect(indexHtml, contains('aria-live="polite"'));
      expect(indexHtml, contains('aria-busy="true"'));
      expect(indexHtml, contains('aria-hidden="true"'));
    });

    test('shell copy is localized for English and Chinese', () {
      expect(indexHtml, contains('Starting Cosyncing'));
      expect(indexHtml, contains('正在启动 Cosyncing'));
      expect(indexHtml, contains('navigator.languages'));
      // Flutter-side copy still goes through the ARBs; this dictionary covers
      // only the pre-Flutter shell.
      expect(indexHtml, contains('COPY.en'));
      expect(indexHtml, contains('zh:'));
    });

    test('only the Dart post-frame hook may dismiss the shell', () {
      expect(indexHtml, contains('window.cosyncingStartupShellReady'));
      // The removal path is reached from that hook alone.
      const removal = 'shell.parentNode.removeChild(shell)';
      expect(indexHtml, contains(removal));
      final hookIndex = indexHtml.indexOf(
        'window.cosyncingStartupShellReady =',
      );
      expect(indexHtml.indexOf(removal), greaterThan(hookIndex));
      // Two rAFs before the fade, so a frame is composited under the shell.
      expect(indexHtml, contains('requestAnimationFrame'));
      expect(indexHtml, contains('transition: opacity'));
    });

    test('retry is bounded and never reloads on its own', () {
      expect(indexHtml, contains('MAX_RELOAD_ATTEMPTS'));
      expect(indexHtml, contains('cosyncing.startup.attempts'));
      // Every reload is inside a click handler; nothing reloads from a timer.
      final reloadCount = 'window.location.reload()'
          .allMatches(indexHtml)
          .length;
      expect(reloadCount, greaterThan(0));
      final timerReload = RegExp(
        r'setTimeout\([^)]*location\.reload',
        multiLine: true,
      );
      expect(timerReload.hasMatch(indexHtml), isFalse);
    });

    test('production startup clocks remain eight and twenty-five seconds', () {
      expect(indexHtml, contains('var SLOW_MS = 8000;'));
      expect(indexHtml, contains('var FAIL_MS = 25000;'));
    });

    test('base href, PWA and the browser-zoom listener are preserved', () {
      expect(indexHtml, contains(r'<base href="$FLUTTER_BASE_HREF">'));
      expect(indexHtml, contains('<link rel="manifest" href="manifest.json">'));
      expect(indexHtml, contains('rel="apple-touch-icon"'));
      expect(indexHtml, contains('href="favicon.ico"'));
      expect(indexHtml, contains('href="favicon.svg"'));
      expect(indexHtml, contains("addEventListener('wheel'"));
      expect(indexHtml, contains('stopImmediatePropagation'));
      expect(indexHtml, contains('capture: true, passive: false'));
      expect(indexHtml, contains('<script src="flutter_bootstrap.js" async>'));
    });
  });

  group('service worker wiring', () {
    test('index.html registers sw.js at the app scope', () {
      expect(indexHtml, contains("register('sw.js', { scope: './'"));
      expect(indexHtml, contains("updateViaCache: 'none'"));
    });

    test('the Flutter loader is not allowed to register its own worker', () {
      expect(bootstrapJs, contains('{{flutter_js}}'));
      expect(bootstrapJs, contains('{{flutter_build_config}}'));
      expect(bootstrapJs, contains('_flutter.loader.load();'));
      // Comments explain WHY the settings are absent; the code must not carry
      // them, or Flutter's unregister-only stub would evict our worker.
      final code = bootstrapJs
          .split('\n')
          .where((line) => !line.trimLeft().startsWith('//'))
          .join('\n');
      expect(code, isNot(contains('serviceWorkerSettings')));
      expect(code, isNot(contains('serviceWorkerVersion')));
    });

    test(
      'the worker is a template the build stamps, not a stamped artefact',
      () {
        for (final placeholder in [
          '__COSYNCING_BUILD_VERSION__',
          '__COSYNCING_PRECACHE_URLS__',
          '__COSYNCING_RUNTIME_URLS__',
          '__COSYNCING_ASSET_HASHES__',
        ]) {
          expect(workerJs, contains(placeholder));
        }
      },
    );

    test("every cached response is checked against this build's hash", () {
      // Flutter web content-hashes no URL, so waiting to activate does not stop
      // the ACTIVE (old) worker from lazy-fetching a runtime URL and receiving
      // the next build's bytes. The hash check is what makes that detectable.
      expect(workerJs, contains("crypto.subtle.digest('SHA-256'"));
      expect(workerJs, contains('HASH_BY_URL'));
      expect(workerJs, contains('fetchVerified'));
      // The install path verifies too, so a deployment landing mid-install
      // aborts instead of precaching a mixture.
      expect(workerJs, isNot(contains('cache.addAll')));
      expect(workerJs, contains("statusText: 'Build version mismatch'"));
    });

    test('an install that never activates leaves no cache behind', () {
      expect(workerJs, contains('deleteAbandonedCaches'));
      expect(workerJs, contains('ACTIVATION_MARKER_URL'));
      expect(workerJs, contains('await caches.delete(CACHE_NAME)'));
    });

    test('a missing cached shell is refetched under verification', () {
      // The shell is the document that picks the bundle, so an unverified
      // network fallback here is a mixed build by construction: the new HTML
      // beside the old cached main.dart.js.
      expect(workerJs, contains('await fetchVerified(SHELL_URL)'));
      expect(workerJs, isNot(contains('return await fetch(request)')));
    });

    test('anything that can fail runs before activation deletes', () {
      // Activation is the only place the previous — working — build is
      // destroyed. Every operation that can reject therefore has to happen
      // first, or a rejected activation has already destroyed the only complete
      // build on the device.
      final activate = workerJs.substring(
        workerJs.indexOf("addEventListener('activate'"),
      );
      final marked = activate.indexOf('ACTIVATION_MARKER_URL');
      final claimed = activate.indexOf('self.clients.claim()');
      final deleted = activate.indexOf('caches.delete(name)');
      expect(marked, greaterThan(0));
      expect(claimed, greaterThan(0));
      expect(deleted, greaterThan(0));
      expect(
        claimed,
        greaterThan(marked),
        reason: 'the marker proves the cache before anything relies on it',
      );
      expect(
        deleted,
        greaterThan(claimed),
        reason: 'the previous build outlives anything that can still fail',
      );
    });

    test('cleanup cannot fail an activation that already succeeded', () {
      // Deleting an obsolete cache runs after the previous cache is already
      // gone, so a rejection there would be the same hazard in a new place.
      final activate = workerJs.substring(
        workerJs.indexOf("addEventListener('activate'"),
      );
      expect(activate, contains('Promise.allSettled'));
      expect(activate.indexOf('Promise.allSettled'), greaterThan(0));
      // A failed claim must not leave a durable-looking cache behind.
      expect(activate, contains('cache.delete(ACTIVATION_MARKER_URL)'));
    });

    test(
      'the worker refuses non-GET, cross-origin and out-of-scope requests',
      () {
        expect(workerJs, contains("request.method !== 'GET'"));
        expect(workerJs, contains("request.destination === 'websocket'"));
        expect(workerJs, contains('url.origin !== SCOPE_URL.origin'));
        expect(workerJs, contains('url.href.startsWith(SCOPE_URL.href)'));
        expect(workerJs, contains("url.search !== ''"));
        expect(workerJs, contains('isCacheableAsset'));
      },
    );

    test('activation deletes obsolete application caches', () {
      expect(workerJs, contains('CACHE_PREFIX'));
      expect(workerJs, contains('caches.delete(name)'));
      expect(workerJs, contains('LEGACY_CACHE_NAMES'));
    });

    test('an update never forces itself over an open client', () {
      // `skipWaiting()` hands the new worker a document that is still running
      // the previous main.dart.js, and activation then deletes the cache that
      // document is reading from. The whole coherence guarantee is that this
      // call does not exist.
      final code = workerJs
          .split('\n')
          .where((line) => !line.trimLeft().startsWith('//'))
          .where((line) => !line.trimLeft().startsWith('*'))
          .join('\n');
      expect(code, isNot(contains('skipWaiting')));
    });

    test('cache ownership is scoped, not origin-global', () {
      // A bare `cosyncing-app-` prefix makes every co-hosted app and every
      // other Cosyncing mount a candidate for this one's cleanup.
      expect(workerJs, contains(r'`cosyncing-app:${SCOPE_URL.pathname}:`'));
      expect(workerJs, contains('name.startsWith(CACHE_PREFIX)'));
      // Legacy Flutter caches are pruned entry-by-entry, never deleted blind,
      // and only for URLs this build actually owns — an app mounted deeper
      // (`/cosy/other/`) shares the scope prefix but is not this app.
      expect(workerJs, contains('pruneLegacyCache'));
      expect(
        workerJs,
        contains(
          'isCacheableAsset(request.url) || request.url === SHELL_URL',
        ),
      );
    });
  });

  group('recovery scope', () {
    test('the shell resets only this installation', () {
      // Same cache prefix as sw.js, derived the same way.
      expect(
        indexHtml,
        contains(
          "'cosyncing-app:' + new URL('./', document.baseURI).pathname + ':'",
        ),
      );
      expect(
        indexHtml,
        contains("APP_SCOPE = new URL('./', document.baseURI).href"),
      );
      // And it unregisters only the worker whose scope IS this app mount.
      expect(indexHtml, contains('registration.scope === APP_SCOPE'));
    });
  });
}
