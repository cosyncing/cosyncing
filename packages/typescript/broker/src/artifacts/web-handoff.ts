/**
 * The tiny same-origin page an open Cosyncing tab parks on while a verified
 * replacement build takes over (N3b).
 *
 * WHY IT IS NOT PART OF THE FLUTTER BUILD
 * ---------------------------------------
 * `apps/client/web/sw.js` is registered at the app's base href, so every URL
 * under `/cosy/` is inside its scope and every document there is one of its
 * CONTROLLED CLIENTS. A waiting worker activates only once the previous worker
 * controls nothing, so the handoff destination must live OUTSIDE that scope.
 * Anything the Flutter build emits lands under `/cosy/`, which is exactly the
 * wrong side of the boundary — hence a broker route, one path segment up.
 *
 * `/cosy/` -> `/cosy-handoff`. Under a mounted prefix the same relative rule
 * holds (`/x/cosy/` -> `/x/cosy-handoff`), because the page resolves the app
 * scope from its OWN location rather than from anything it is told.
 *
 * WHAT IT DOES
 * ------------
 * Nothing that can change state. It waits for the `/cosy/` registration to
 * report an active worker whose build identity is the one it was sent for,
 * then returns the tab to the exact route it came from. It never calls
 * `skipWaiting`, never registers or unregisters a worker, never opens a cache,
 * and never talks to the broker API. If the swap does not complete inside a
 * bounded deadline it returns the tab anyway — the previous build is still
 * whole and still serving, so a stranded blank page is the only outcome worse
 * than a deferred update.
 *
 * WHY IT IS BUILD-INDEPENDENT
 * ---------------------------
 * It is served identically by every broker revision and carries no application
 * identity, so a tab is never stranded on a handoff page belonging to a build
 * that no longer exists. It is `no-store` for the same reason.
 */

/** Path, relative to the broker root, of the out-of-scope handoff document. */
export const WEB_HANDOFF_PATH = '/cosy-handoff';

/**
 * Longest `?r=` route this page will return to.
 *
 * Bounds what one tab can carry across the swap. A longer value is not
 * truncated — a truncated route is a different route — it falls back to the
 * app root.
 */
export const WEB_HANDOFF_MAX_ROUTE_CHARS = 512;

/** Longest a tab waits for the replacement to activate before returning anyway. */
export const WEB_HANDOFF_DEADLINE_MS = 20000;

/**
 * The document itself.
 *
 * Self-contained by construction: no remote script, style, font or image, so
 * it renders from its own HTTP response with the app's caches and worker in an
 * indeterminate state. Colours and the mark mirror `apps/client/web/index.html`
 * so the tab shows one continuous surface across the swap rather than a flash
 * of unrelated chrome.
 */
export const WEB_HANDOFF_DOCUMENT = [
  '<!DOCTYPE html>',
  '<html>',
  '<head>',
  '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="robots" content="noindex">',
  '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F2F5F4">',
  '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0B0E14">',
  '<title>Cosyncing</title>',
  '<style>',
  ':root {',
  '  color-scheme: light dark;',
  '  --cosync-canvas: #F2F5F4;',
  '  --cosync-text: #1E2927;',
  '  --cosync-muted: #5F7370;',
  '  --cosync-accent: #0F766E;',
  '  --cosync-track: rgba(15, 118, 110, 0.18);',
  '  --cosync-mark-a: #0B0E14;',
  '  --cosync-mark-b: #0F766E;',
  '}',
  '@media (prefers-color-scheme: dark) {',
  '  :root {',
  '    --cosync-canvas: #0B0E14;',
  '    --cosync-text: #E2E8F0;',
  '    --cosync-muted: #94A3B8;',
  '    --cosync-accent: #2DD4BF;',
  '    --cosync-track: rgba(45, 212, 191, 0.20);',
  '    --cosync-mark-a: #F2F5F4;',
  '    --cosync-mark-b: #2DD4BF;',
  '  }',
  '}',
  'html, body {',
  '  margin: 0; padding: 0; height: 100%;',
  '  background: var(--cosync-canvas); color: var(--cosync-text);',
  '}',
  '#cosyncing-handoff {',
  '  position: fixed; inset: 0; display: flex; flex-direction: column;',
  '  align-items: center; justify-content: center; gap: 20px; padding: 24px;',
  '  box-sizing: border-box; text-align: center;',
  '  font: 400 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto,',
  '    "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;',
  '}',
  '.cosyncing-shell-mark { width: 64px; height: 64px; display: block; }',
  '.cosyncing-shell-mark .mark-a { fill: var(--cosync-mark-a); }',
  '.cosyncing-shell-mark .mark-b { fill: var(--cosync-mark-b); }',
  '.cosyncing-shell-wordmark {',
  '  font-size: 17px; font-weight: 600; letter-spacing: 0.01em;',
  '  color: var(--cosync-text);',
  '}',
  '.cosyncing-shell-status {',
  '  max-width: 34ch; color: var(--cosync-muted); font-size: 14px; margin: 0;',
  '}',
  '.cosyncing-shell-track {',
  '  width: 176px; max-width: 60vw; height: 4px; border-radius: 2px;',
  '  background: var(--cosync-track); overflow: hidden;',
  '}',
  '.cosyncing-shell-track::after {',
  '  content: ""; display: block; width: 40%; height: 100%; border-radius: 2px;',
  '  background: var(--cosync-accent); animation: cosyncing-shell-slide 1.4s ease-in-out infinite;',
  '}',
  '@keyframes cosyncing-shell-slide {',
  '  0%   { transform: translateX(-100%); }',
  '  100% { transform: translateX(250%); }',
  '}',
  '@media (prefers-reduced-motion: reduce) {',
  '  .cosyncing-shell-track::after { animation: none; width: 100%; }',
  '}',
  '@media (max-width: 420px) {',
  '  .cosyncing-shell-mark { width: 52px; height: 52px; }',
  '  #cosyncing-handoff { gap: 16px; }',
  '}',
  '.cosyncing-shell-link { color: var(--cosync-accent); }',
  '</style>',
  '</head>',
  '<body>',
  '<div id="cosyncing-handoff" role="status" aria-live="polite" aria-busy="true">',
  '  <svg class="cosyncing-shell-mark" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">',
  '    <path class="mark-a" d="M86,40 V74 A18,18 0 0 1 74,86 H40 V74 H66 A8,8 0 0 0 74,66 V40 Z"/>',
  '    <path class="mark-b" d="M14,60 V26 A18,18 0 0 1 26,14 H60 V26 H34 A8,8 0 0 0 26,34 V60 Z"/>',
  '  </svg>',
  '  <div class="cosyncing-shell-wordmark">cosyncing</div>',
  '  <p class="cosyncing-shell-status" id="cosyncing-handoff-status">Updating Cosyncing…</p>',
  '  <div class="cosyncing-shell-track" aria-hidden="true"></div>',
  '  <noscript><a class="cosyncing-shell-link" id="cosyncing-handoff-noscript" href="./cosy/">Open Cosyncing</a></noscript>',
  '</div>',
  '<script>',
  '(function () {',
  "  'use strict';",
  '',
  '  // Every bound this page has. Nothing here retries without one.',
  `  var DEADLINE_MS = ${WEB_HANDOFF_DEADLINE_MS};`,
  '  var POLL_MS = 200;',
  '  var WORKER_REPLY_MS = 1500;',
  `  var MAX_ROUTE_CHARS = ${WEB_HANDOFF_MAX_ROUTE_CHARS};`,
  '  var MAX_VERSION_CHARS = 64;',
  '',
  '  var COPY = {',
  "    en: { updating: 'Updating Cosyncing…', returning: 'Reopening your session…' },",
  "    zh: { updating: '正在更新 Cosyncing…', returning: '正在返回你的会话…' }",
  '  };',
  '',
  '  function pickCopy() {',
  '    var tags = (navigator.languages && navigator.languages.length)',
  '      ? navigator.languages',
  "      : [navigator.language || 'en'];",
  '    for (var i = 0; i < tags.length; i++) {',
  "      var primary = String(tags[i] || '').toLowerCase().split('-')[0];",
  '      if (COPY[primary]) return COPY[primary];',
  '    }',
  '    return COPY.en;',
  '  }',
  '',
  '  var copy = pickCopy();',
  "  var statusNode = document.getElementById('cosyncing-handoff-status');",
  '  if (statusNode) statusNode.textContent = copy.updating;',
  "  document.documentElement.lang = (copy === COPY.zh) ? 'zh' : 'en';",
  '',
  '  // The app scope is derived from THIS page\'s own location, never from the',
  '  // query string. A caller therefore cannot aim the return navigation at a',
  '  // path this page does not own, and a mounted prefix works without',
  '  // configuration: /x/cosy-handoff resolves the scope to /x/cosy/.',
  "  var APP_SCOPE = new URL('./cosy/', new URL('.', location.href)).href;",
  '  var noscriptLink = document.getElementById(\'cosyncing-handoff-noscript\');',
  '  if (noscriptLink) noscriptLink.href = APP_SCOPE;',
  '',
  '  var params = new URLSearchParams(location.search);',
  '',
  '  /** Build identity this tab was sent to wait for; anything else is ignored. */',
  '  function readVersion() {',
  "    var raw = params.get('v') || '';",
  '    return new RegExp("^[0-9a-z]{1," + MAX_VERSION_CHARS + "}$").test(raw) ? raw : null;',
  '  }',
  '',
  '  /**',
  '   * The route to return to, or the app root.',
  '   *',
  '   * Resolved against this origin and then required to still be inside the app',
  '   * scope, so a protocol-relative value, an absolute foreign URL, an encoded',
  '   * traversal or the handoff path itself all collapse to the app root rather',
  '   * than becoming an open redirect or a navigation loop.',
  '   */',
  '  function readRoute() {',
  "    var raw = params.get('r') || '';",
  '    if (!raw || raw.length > MAX_ROUTE_CHARS) return APP_SCOPE;',
  '    var resolved;',
  '    try { resolved = new URL(raw, location.href); } catch (error) { return APP_SCOPE; }',
  '    if (resolved.origin !== location.origin) return APP_SCOPE;',
  '    if (resolved.href.indexOf(APP_SCOPE) !== 0) return APP_SCOPE;',
  '    if (resolved.href.length > MAX_ROUTE_CHARS) return APP_SCOPE;',
  '    return resolved.href;',
  '  }',
  '',
  '  var wanted = readVersion();',
  '  var target = readRoute();',
  '  var deadline = Date.now() + DEADLINE_MS;',
  '  var returned = false;',
  '',
  '  /**',
  '   * Returns the tab to its route.',
  '   *',
  '   * `replace`, not `assign`: the entry this tab is sitting on IS the entry the',
  '   * app route used to occupy, so replacing it restores the history stack to',
  '   * exactly its pre-handoff shape. Back goes wherever it went before, and no',
  '   * handoff URL is ever left behind for a user to navigate onto.',
  '   */',
  '  function finish() {',
  '    if (returned) return;',
  '    returned = true;',
  '    if (statusNode) statusNode.textContent = copy.returning;',
  '    location.replace(target);',
  '  }',
  '',
  '  /** Asks one worker a read-only question, bounded, never throwing. */',
  '  function ask(worker, request) {',
  '    return new Promise(function (resolve) {',
  '      if (!worker) return resolve(null);',
  '      var settled = false;',
  '      var timer = setTimeout(function () {',
  '        if (settled) return;',
  '        settled = true;',
  '        resolve(null);',
  '      }, WORKER_REPLY_MS);',
  '      try {',
  '        var channel = new MessageChannel();',
  '        channel.port1.onmessage = function (event) {',
  '          if (settled) return;',
  '          settled = true;',
  '          clearTimeout(timer);',
  '          resolve(event.data || null);',
  '        };',
  '        worker.postMessage(request, [channel.port2]);',
  '      } catch (error) {',
  '        if (settled) return;',
  '        settled = true;',
  '        clearTimeout(timer);',
  '        resolve(null);',
  '      }',
  '    });',
  '  }',
  '',
  '  // No worker support, or nothing to wait for: there is no swap to observe, so',
  '  // parking here would be a hang with no upside.',
  "  if (!wanted || !('serviceWorker' in navigator)) return finish();",
  '',
  '  function poll() {',
  '    if (returned) return;',
  '    if (Date.now() > deadline) return finish();',
  '    navigator.serviceWorker.getRegistration(APP_SCOPE).then(function (registration) {',
  '      if (returned) return;',
  '      // No registration at all: the app will install one on arrival.',
  '      if (!registration) return finish();',
  '      // Something is still waiting — either the build this tab is here for, or',
  '      // a newer one. Either way this tab has not finished its job.',
  '      if (registration.waiting || registration.installing) {',
  '        return void setTimeout(poll, POLL_MS);',
  '      }',
  '      return ask(registration.active, { type: \'cosyncing-build-identity\' }).then(function (identity) {',
  '        if (returned) return;',
  '        if (identity && identity.version === wanted) return finish();',
  '        setTimeout(poll, POLL_MS);',
  '      });',
  '    }).catch(function () {',
  '      if (!returned) setTimeout(poll, POLL_MS);',
  '    });',
  '  }',
  '',
  '  // A hard stop independent of the poll chain: if every branch above somehow',
  '  // stops rescheduling, the tab still goes home.',
  '  setTimeout(finish, DEADLINE_MS + POLL_MS);',
  '  poll();',
  '})();',
  '</script>',
  '</body>',
  '</html>',
  '',
].join('\n');

/**
 * Serves the handoff document.
 *
 * `no-store` is load-bearing twice over: a tab that crashes here must re-fetch
 * a live copy on reopen, and no intermediate cache may pin a revision of this
 * page against a broker that has moved on.
 */
export function serveWebHandoff(decorate?: (headers: Headers) => Headers): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });
  return new Response(WEB_HANDOFF_DOCUMENT, {
    headers: decorate ? decorate(headers) : headers,
  });
}
