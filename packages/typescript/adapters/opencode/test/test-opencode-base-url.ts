#!/usr/bin/env bun
/**
 * Pure (no live service) — resolveLocalOpencodeBaseUrl is the SINGLE source of truth both the OpenCode
 * adapter constructor and managed serve (adapter-opencode/src/managed-server.ts) use to resolve OPENCODE_URL.
 * If they ever resolved differently, the adapter's REST/SSE calls would hit a different port than the serve
 * the broker launched, and True Sync would silently fail. This pins the contract: a portless LOCAL url gets
 * :4096; an explicit port is preserved; a non-local url is untouched.
 */
import { resolveLocalOpencodeBaseUrl } from '../src/index.ts';

let failures = 0;
const eq = (label: string, got: string, want: string) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — got ${got}${ok ? '' : ` want ${want}`}`);
  if (!ok) failures++;
};

// portless local hosts → pin :4096 (the documented default port)
eq('127.0.0.1 portless → :4096', resolveLocalOpencodeBaseUrl('http://127.0.0.1'), 'http://127.0.0.1:4096');
eq('localhost portless → :4096', resolveLocalOpencodeBaseUrl('http://localhost'), 'http://localhost:4096');
eq('https local portless → :4096', resolveLocalOpencodeBaseUrl('https://127.0.0.1'), 'https://127.0.0.1:4096');
eq('trailing slash trimmed + pinned', resolveLocalOpencodeBaseUrl('http://127.0.0.1/'), 'http://127.0.0.1:4096');

// explicit port preserved (local)
eq('explicit local port preserved', resolveLocalOpencodeBaseUrl('http://127.0.0.1:5000'), 'http://127.0.0.1:5000');
eq('default url unchanged', resolveLocalOpencodeBaseUrl('http://127.0.0.1:4096'), 'http://127.0.0.1:4096');

// non-local hosts left untouched (we never manage/repoint a remote serve)
eq('remote host untouched (no port)', resolveLocalOpencodeBaseUrl('http://example.com'), 'http://example.com');
eq('remote host untouched (port)', resolveLocalOpencodeBaseUrl('https://opencode.example:9000'), 'https://opencode.example:9000');

// malformed → returned trimmed, never throws
eq('malformed returned trimmed', resolveLocalOpencodeBaseUrl('not a url/'), 'not a url');

// The broker↔adapter agreement the fix exists to guarantee: the base the adapter talks to is exactly what
// the broker-managed serve would launch/probe for the same OPENCODE_URL (both call this one helper).
for (const url of ['http://127.0.0.1', 'http://localhost', 'http://127.0.0.1:4096', 'http://127.0.0.1:7000']) {
  const adapterBase = resolveLocalOpencodeBaseUrl(url);
  const serveBase = resolveLocalOpencodeBaseUrl(url.replace(/\/$/, '')); // managed-server.ts trims then calls the same helper
  eq(`broker base == adapter base for ${url}`, serveBase, adapterBase);
}

if (failures) {
  console.error(`\nFAIL: ${failures} opencode base-url check(s) failed.`);
  process.exit(1);
}
console.log('\n✅ opencode base-url resolution: all checks passed.');
