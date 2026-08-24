/**
 * Regression tests for the history-cache/lazy-artifact broker primitives.
 *
 * No live broker or model is required. This exercises the cursor delta algorithm and the
 * content-addressed artifact store that feeds the app's lazy fetch/cache path.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '../../../adapter-api/src/index.ts';
import { ArtifactStore } from '../../src/artifacts/artifact-store.ts';
import { ClientMessagePolicyError } from '../../src/sessions/client-message-policy.ts';
import { historyDelta, isCursorDurableMessage } from '../../src/sessions/history-delta.ts';

function fail(message: string): never {
  throw new Error(message);
}

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) fail(message);
}

async function withEnv<T>(next: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev = new Map(Object.keys(next).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(next)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prev) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function blobPath(root: string, contentHash: string): string {
  return join(root, 'artifacts', 'blobs', contentHash.slice(0, 2), contentHash);
}

function sameLengthForgery(sig: string): string {
  const last = sig.at(-1);
  return sig.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

async function testArtifactStore(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-artifacts-'));
  try {
    const store = new ArtifactStore('http://broker.default:7734', root);
    const session = { tool: 'claude', id: 'session one' };
    const ref = store.toReference(
      session,
      {
        type: 'file-artifact',
        path: 'reports/summary.txt',
        name: 'summary.txt',
        mimeType: 'text/plain',
        size: 18,
        url: 'data:text/plain;base64,SGVsbG8=',
      },
      'http://phone.magicdns:7734',
    ) as AgentMessage & { type: 'file-artifact' };

    assert(!ref.url, 'reference-mode artifact must not keep inline data URL');
    assert(ref.artifactKey, 'reference-mode artifact should expose an artifact key');
    assert(ref.contentHash, 'reference-mode artifact should expose a content hash');
    assert(ref.fetchUrl?.startsWith('/api/sessions/'), 'artifact fetch URL should be relative to the client profile origin');
    assert(!ref.fetchUrl?.includes('phone.magicdns'), 'request-local origins must not enter artifact references');

    const url = new URL(ref.fetchUrl!, 'http://client.example');
    assert(ref.interactionPolicy?.mode === 'display-only', 'non-HTML reference should advertise display-only policy');
    const served = store.serve(session.tool, session.id, ref.artifactKey!, url.searchParams.get('expires'), url.searchParams.get('sig'));
    assert(served.status === 200, `signed artifact URL should serve bytes, got ${served.status}`);
    assert(await served.text() === 'Hello', 'served artifact bytes should match the original payload');

    const reloaded = new ArtifactStore('http://broker.default:7734', root);
    const servedAfterRestart = reloaded.serve(session.tool, session.id, ref.artifactKey!, url.searchParams.get('expires'), url.searchParams.get('sig'));
    assert(servedAfterRestart.status === 200, `reloaded store should serve existing signed URL, got ${servedAfterRestart.status}`);
    assert(await servedAfterRestart.text() === 'Hello', 'reloaded store should preserve indexed artifact bytes');
    const ownerScope = { principalId: 'owner:test', authGeneration: 0 };
    const scopedRef = reloaded.toReference(session, ref, undefined, ownerScope) as AgentMessage & { type: 'file-artifact' };
    const scopedUrl = new URL(scopedRef.fetchUrl!, 'http://client.example');
    const wrongPrincipal = reloaded.serve(
      session.tool,
      session.id,
      ref.artifactKey!,
      scopedUrl.searchParams.get('expires'),
      scopedUrl.searchParams.get('sig'),
      { principalId: 'peer:other', authGeneration: 1 },
    );
    assert(wrongPrincipal.status === 403, 'artifact signature should be bound to one authenticated principal');
    const generationOneScope = { principalId: 'peer:repaired-phone', authGeneration: 1 };
    const generationOneRef = reloaded.toReference(session, ref, undefined, generationOneScope) as AgentMessage & { type: 'file-artifact' };
    const generationOneUrl = new URL(generationOneRef.fetchUrl!, 'http://client.example');
    const afterRepair = reloaded.serve(
      session.tool,
      session.id,
      ref.artifactKey!,
      generationOneUrl.searchParams.get('expires'),
      generationOneUrl.searchParams.get('sig'),
      { principalId: 'peer:repaired-phone', authGeneration: 3 },
    );
    assert(afterRepair.status === 403, 're-pairing the same peer id must not revive an older-generation artifact URL');

    const sig = url.searchParams.get('sig')!;
    const denied = reloaded.serve(session.tool, session.id, ref.artifactKey!, url.searchParams.get('expires'), sameLengthForgery(sig));
    assert(denied.status === 403, 'same-length invalid artifact signature should be rejected');

    const expired = reloaded.serve(session.tool, session.id, ref.artifactKey!, '1', sig);
    assert(expired.status === 403, 'expired artifact URL should be rejected');

    const crossSession = reloaded.serve(session.tool, 'other session', ref.artifactKey!, url.searchParams.get('expires'), sig);
    assert(crossSession.status === 403, 'artifact URL signature should be bound to the original session');

    assert(reloaded.clearSession(session.tool, session.id) === 1, 'session cache clear should remove the artifact index record');
    const staleRef = reloaded.toReference(session, { ...ref, fetchUrl: ref.fetchUrl }) as AgentMessage & { type: 'file-artifact' };
    assert(!staleRef.fetchUrl, 'missing artifact index record should strip stale fetchUrl instead of advertising a guaranteed 404');
    const missing = reloaded.serve(session.tool, session.id, ref.artifactKey!, url.searchParams.get('expires'), sig);
    assert(missing.status === 404, 'cleared session artifact should no longer be fetchable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testInteractiveHtmlArtifactServe(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-interactive-artifacts-'));
  try {
    const store = new ArtifactStore('http://broker.default:7734', root);
    const session = { tool: 'opencode', id: 'interactive-session' };
    const ref = store.toReference(session, {
      type: 'file-artifact',
      path: 'reports/form.html',
      name: 'form.html',
      mimeType: 'text/html',
      size: 90,
      url: 'data:text/html;base64,' + Buffer.from('<form id="f"><input name="answer" value="42"><button data-cosyncing-action="save">Save</button></form>').toString('base64'),
    }) as AgentMessage & { type: 'file-artifact' };
    const url = new URL(ref.fetchUrl!, 'http://client.example');
    assert(ref.interactionPolicy?.mode === 'display-only', 'download-only HTML must advertise a display-only policy');
    assert(ref.interactionPolicy.allowedActions.length === 0 && ref.interactionPolicy.interactionRef === undefined,
      'download-only HTML must not advertise an interaction channel');
    const served = store.serve(session.tool, session.id, ref.artifactKey!, url.searchParams.get('expires'), url.searchParams.get('sig'));
    assert(served.status === 200, `interactive HTML artifact should serve, got ${served.status}`);
    const html = await served.text();
    const csp = served.headers.get('content-security-policy') || '';
    assert(csp === 'sandbox', `HTML artifact should be sandboxed for download, got ${csp}`);
    assert(served.headers.get('content-type') === 'application/octet-stream', 'HTML must not retain an active MIME type');
    assert(served.headers.get('content-disposition')?.startsWith('attachment;') === true, 'HTML must be forced to attachment');
    assert(served.headers.get('cache-control') === 'no-store', 'artifact responses must not be cached');
    assert(served.headers.get('referrer-policy') === 'no-referrer', 'artifact responses must suppress referrers');
    assert(served.headers.get('cross-origin-resource-policy') === 'same-origin', 'artifact responses must remain same-origin');
    assert(!html.includes('window.__COSYNCING__'), 'served HTML must not receive an executable bridge');
    assert(html.includes('data-cosyncing-action'), 'original artifact HTML should remain present');
    assert(!html.includes('interactionRef'), 'signed interaction reference must never be injected into artifact JavaScript');

    const policyError = (fn: () => unknown, code: ClientMessagePolicyError['code']) => {
      let caught: unknown;
      try { fn(); } catch (error) { caught = error; }
      assert(caught instanceof ClientMessagePolicyError && caught.code === code, `expected ${code}`);
    };
    policyError(() => store.authorizeInteraction(
      session, ref.artifactKey, 'legacy-interaction-reference',
      { type: 'action', action: 'save' },
    ), 'ARTIFACT_INTERACTION_UNSUPPORTED');

    const plain = store.toReference(session, {
      type: 'file-artifact',
      path: 'notes.txt',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
      url: 'data:text/plain;base64,aGVsbG8=',
    }) as AgentMessage & { type: 'file-artifact' };
    const plainUrl = new URL(plain.fetchUrl!, 'http://client.example');
    assert(plain.interactionPolicy?.mode === 'display-only' && plain.interactionPolicy.allowedActions.length === 0,
      'non-HTML artifact should advertise display-only policy');
    policyError(() => store.authorizeInteraction(
      session, plain.artifactKey, 'legacy-interaction-reference',
      { type: 'action', action: 'save' },
    ), 'ARTIFACT_INTERACTION_UNSUPPORTED');
    const plainServed = store.serve(session.tool, session.id, plain.artifactKey!, plainUrl.searchParams.get('expires'), plainUrl.searchParams.get('sig'));
    assert(!(await plainServed.text()).includes('window.__COSYNCING__'), 'non-HTML artifacts must not receive the interactive bridge');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testArtifactStoreEnvAndEviction(): Promise<void> {
  await withEnv({ COSYNCING_ARTIFACT_CACHE_MAX_BYTES: '', COSYNCING_ARTIFACT_CACHE_MAX_AGE_DAYS: 'garbage' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-artifacts-env-'));
    try {
      const store = new ArtifactStore('http://broker.default:7734', root);
      const ref = store.toReference(
        { tool: 'opencode', id: 's1' },
        { type: 'file-artifact', path: 'a.txt', name: 'a.txt', mimeType: 'text/plain', url: 'data:text/plain;base64,YQ==' },
      ) as AgentMessage & { type: 'file-artifact' };
      const url = new URL(ref.fetchUrl!, 'http://client.example');
      const served = store.serve('opencode', 's1', ref.artifactKey!, url.searchParams.get('expires'), url.searchParams.get('sig'));
      assert(served.status === 200, 'blank/garbage artifact cache env values should fall back to defaults, not evict immediately');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await withEnv({ COSYNCING_ARTIFACT_CACHE_MAX_AGE_DAYS: '0.00001' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-artifacts-age-'));
    const originalNow = Date.now;
    try {
      let now = 1_800_000_000_000;
      Date.now = () => now;
      const store = new ArtifactStore('http://broker.default:7734', root);
      const oldRef = store.toReference(
        { tool: 'opencode', id: 's1' },
        { type: 'file-artifact', path: 'old.txt', name: 'old.txt', mimeType: 'text/plain', url: 'data:text/plain;base64,b2xk' },
      ) as AgentMessage & { type: 'file-artifact' };
      const oldBlob = blobPath(root, oldRef.contentHash!);
      assert(existsSync(oldBlob), 'test setup should create the first blob');

      now += 2_000;
      store.toReference(
        { tool: 'opencode', id: 's1' },
        { type: 'file-artifact', path: 'new.txt', name: 'new.txt', mimeType: 'text/plain', url: 'data:text/plain;base64,bmV3' },
      );
      assert(!existsSync(oldBlob), 'age-evicted artifact blob should be removed from disk, not only from the index');
    } finally {
      Date.now = originalNow;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function testHistoryDelta(): void {
  const messages: AgentMessage[] = [
    { type: 'user-message', key: 'u1', text: 'hello' },
    { type: 'model-output', key: 'm1', text: 'world' },
  ];
  const first = historyDelta(messages);
  assert(first.reset === true && first.messages.length === 2, 'first attach should return a reset/full history');

  const empty = historyDelta(messages, first.cursor);
  assert(empty.reset === false && empty.messages.length === 0, 'valid cursor should return no duplicate messages');

  const appended = historyDelta([...messages, { type: 'status', status: 'idle' }], first.cursor);
  assert(appended.reset === false && appended.messages.length === 1, 'valid cursor should return only appended durable messages');

  const changedPrefix = historyDelta([{ type: 'user-message', key: 'u1', text: 'changed' }, messages[1]!], first.cursor);
  assert(changedPrefix.reset === true && changedPrefix.messages.length === 2, 'stale cursor should force reset/replace');

  const resultHistory: AgentMessage[] = [{ type: 'tool-result', callId: 'c1', toolName: 'bash', result: 'old output' }];
  const resultCursor = historyDelta(resultHistory).cursor;
  const rewrittenResult = historyDelta([{ type: 'tool-result', callId: 'c1', toolName: 'bash', result: 'new output' }], resultCursor);
  assert(rewrittenResult.reset === true, 'tool-result content rewrites should invalidate a stale cursor');

  const activityBaseline: AgentMessage[] = [
    { type: 'model-output', key: 'm1', text: 'working' },
    { type: 'agent-activity', key: 'workflow', kind: 'workflow', title: 'Background workflow', status: 'running', elapsedMs: 1000 },
  ];
  const activityCursor = historyDelta(activityBaseline.filter(isCursorDurableMessage)).cursor;
  const activityChanged: AgentMessage[] = [
    { type: 'model-output', key: 'm1', text: 'working' },
    { type: 'agent-activity', key: 'workflow', kind: 'workflow', title: 'Background workflow', status: 'running', elapsedMs: 5000 },
    { type: 'status', status: 'idle' },
  ];
  const activityDelta = historyDelta(activityChanged.filter(isCursorDurableMessage), activityCursor);
  assert(activityDelta.reset === false && activityDelta.messages.length === 1, 'volatile agent-activity changes should not invalidate durable cursor prefix');
}

function testLargeDeltaGate(): void {
  const big = 'x'.repeat(50 * 1024 * 1024);
  const baseline: AgentMessage[] = [{ type: 'model-output', key: 'large', text: big }];
  const first = historyDelta(baseline);
  const next = historyDelta([...baseline, { type: 'status', status: 'idle' }], first.cursor);
  assert(next.reset === false, '50 MB cached history should not force a reset when the prefix is unchanged');
  assert(next.messages.length === 1 && next.messages[0]?.type === 'status', '50 MB cached history should return only the delta');
}

await testArtifactStore();
await testInteractiveHtmlArtifactServe();
await testArtifactStoreEnvAndEviction();
testHistoryDelta();
testLargeDeltaGate();

console.log('PASS broker history cursor + lazy artifact primitives');
