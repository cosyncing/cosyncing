#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultBrokerConfig,
  writeBrokerConfig,
} from '../../../packages/typescript/broker/src/runtime/configuration.ts';
import {
  ensureInstallationCredentials,
} from '../../../packages/typescript/broker/src/security/credentials.ts';
import {
  committedInstallState,
  writeInstallState,
} from '../../../packages/typescript/broker/src/installation/install-state.ts';
import {
  withCandidateParityBrowser,
} from './candidate-browser-startup.ts';

export interface CandidatePairArgs {
  broker: string;
  webDirectory: string;
  commit: string;
  version: string;
  allowDirtyWebReview?: boolean;
}

export const CANDIDATE_CREDENTIAL_FIELD_LABEL = 'Server token';

function usage(): never {
  console.error(
    'Usage: bun run scripts/broker/release/verify-candidate-pair.ts '
    + '--broker PATH --web-dir DIR --commit HEX --version X.Y.Z '
    + '[--allow-dirty-web-review true]',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): CandidatePairArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) usage();
    values.set(key, value);
  }
  const broker = values.get('--broker');
  const webDirectory = values.get('--web-dir');
  const commit = values.get('--commit');
  const version = values.get('--version');
  const allowDirtyWebReview =
    values.get('--allow-dirty-web-review') === 'true';
  if (!broker || !webDirectory || !commit || !version) usage();
  return {
    broker: resolve(broker),
    webDirectory: resolve(webDirectory),
    commit,
    version,
    allowDirtyWebReview,
  };
}

async function processJson(command: string[], cwd: string): Promise<any> {
  const process = Bun.spawn(command, {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command[0]} exited ${exitCode}: ${stderr.trim().slice(0, 500)}`,
    );
  }
  return JSON.parse(stdout);
}

interface LoopbackPortLease {
  port: number;
  release: () => void;
}

export interface CandidateBrokerProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(): void;
}

export interface CandidateBrokerAttemptContext<TPrepared> {
  attempt: number;
  maxAttempts: number;
  port: number;
  prepared: TPrepared;
  broker: CandidateBrokerProcess;
  stdout: Promise<string>;
  stderr: Promise<string>;
}

export interface CandidateBrokerAttemptOptions<TPrepared> {
  maxAttempts: number;
  reservePort: () => Promise<LoopbackPortLease>;
  prepare: (port: number) => TPrepared | Promise<TPrepared>;
  spawn: (prepared: TPrepared) => CandidateBrokerProcess;
  drainOutput: (stream: ReadableStream<Uint8Array>) => Promise<string>;
  verify: (
    context: CandidateBrokerAttemptContext<TPrepared>,
  ) => 'complete' | 'retry' | Promise<'complete' | 'retry'>;
  onProcessExit?: (options: {
    broker: CandidateBrokerProcess;
    stdout: string;
    stderr: string;
    retrying: boolean;
  }) => void;
}

/**
 * Owns every resource created after a port lease is acquired.
 *
 * Keeping setup, spawn, output draining, and verification inside this boundary
 * ensures that each failed attempt releases its lease and terminates any child
 * process that was created before the failure.
 */
export async function runCandidateBrokerAttempts<TPrepared>(
  options: CandidateBrokerAttemptOptions<TPrepared>,
): Promise<void> {
  for (
    let attempt = 1;
    attempt <= options.maxAttempts;
    attempt += 1
  ) {
    const lease = await options.reservePort();
    let broker: CandidateBrokerProcess | undefined;
    let stdout: Promise<string> | undefined;
    let stderr: Promise<string> | undefined;
    let retrying = false;
    try {
      const prepared = await options.prepare(lease.port);
      broker = options.spawn(prepared);
      stdout = options.drainOutput(broker.stdout);
      stderr = options.drainOutput(broker.stderr);
      retrying = await options.verify({
        attempt,
        maxAttempts: options.maxAttempts,
        port: lease.port,
        prepared,
        broker,
        stdout,
        stderr,
      }) === 'retry';
      if (retrying) continue;
      return;
    } finally {
      let drainedStdout = '';
      let drainedStderr = '';
      try {
        if (broker) {
          try {
            if (broker.exitCode === null) broker.kill();
          } finally {
            await broker.exited;
          }
          [drainedStdout, drainedStderr] = await Promise.all([
            stdout ?? Promise.resolve(''),
            stderr ?? Promise.resolve(''),
          ]);
        }
      } finally {
        lease.release();
      }
      if (broker) {
        options.onProcessExit?.({
          broker,
          stdout: drainedStdout,
          stderr: drainedStderr,
          retrying,
        });
      }
    }
  }
  throw new Error(
    `candidate broker exhausted ${options.maxAttempts} port attempts`,
  );
}

/**
 * Coordinates ephemeral broker ports across parallel jobs on one runner.
 *
 * The kernel selects the port while the probe socket is bound. Before that
 * socket is released, an atomic directory records the lease; another verifier
 * that is assigned the same newly-free port must release it and retry. The
 * lease remains until the candidate broker exits.
 */
async function reserveLoopbackPort(): Promise<LoopbackPortLease> {
  const leaseRoot = join(tmpdir(), 'cosyncing-candidate-port-leases');
  mkdirSync(leaseRoot, { recursive: true });
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const server = createServer();
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('could not allocate an ephemeral loopback port');
    }
    const leasePath = join(leaseRoot, String(address.port));
    try {
      mkdirSync(leasePath);
    } catch {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      continue;
    }
    try {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
      });
    } catch (error) {
      rmSync(leasePath, { recursive: true, force: true });
      throw error;
    }
    return {
      port: address.port,
      release: () => rmSync(leasePath, { recursive: true, force: true }),
    };
  }
  throw new Error('could not reserve an ephemeral loopback port');
}

async function drainProcessOutput(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    tail += decoder.decode(value, { stream: true });
    if (tail.length > 16_384) tail = tail.slice(-16_384);
  }
  tail += decoder.decode();
  return tail.slice(-16_384);
}

function chromeHeadlessShell(): string {
  const configured = process.env.CHROME_BIN?.trim();
  if (configured && existsSync(configured)) return configured;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim()
    || join(homedir(), '.cache', 'ms-playwright');
  const shells = (existsSync(cache)
    ? readdirSync(cache, { withFileTypes: true })
    : [])
    .filter((entry) =>
      entry.isDirectory() && entry.name.startsWith('chromium_headless_shell-')
    )
    .map((entry) => ({
      name: entry.name,
      revision: Number(entry.name.split('-').at(-1)),
    }))
    .sort((left, right) => right.revision - left.revision);
  for (const shell of shells) {
    const binary = join(
      cache,
      shell.name,
      'chrome-headless-shell-linux64',
      'chrome-headless-shell',
    );
    if (existsSync(binary)) return binary;
  }
  for (const binary of [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    if (existsSync(binary)) return binary;
  }
  throw new Error(
    'Chrome or chrome-headless-shell is required for built-client parity; '
    + 'run npx playwright install chromium-headless-shell',
  );
}

export function isAddressInUse(output: string): boolean {
  return /\bEADDRINUSE\b|address already in use|(?:is )?port \d+ (?:is )?(?:already )?in use/i
    .test(output);
}

/** The candidate browser may put only the short-lived ticket in its socket URL. */
export function isTicketedSessionWebSocket(
  rawUrl: string,
  expectedPath: string,
): boolean {
  try {
    const url = new URL(rawUrl);
    const ticket = url.searchParams.get('wsAuthTicket')?.trim() ?? '';
    return url.pathname === expectedPath
      && ticket.length > 0
      && !url.searchParams.has('token')
      && !url.searchParams.has('peerToken')
      && [...url.searchParams.keys()].every((key) => key === 'wsAuthTicket');
  } catch {
    return false;
  }
}

/** Prove that the long-lived credential travelled in the ticket request header, never its URL. */
export function isHeaderAuthenticatedTicketRequest(
  event: any,
  expectedBase: string,
  token: string,
): boolean {
  if (event?.method !== 'Network.requestWillBeSent'
      || event.params?.request?.method !== 'POST') return false;
  try {
    const url = new URL(String(event.params.request.url));
    const expected = new URL('/api/ws-auth-tickets', expectedBase);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname
        || url.searchParams.has('token') || url.searchParams.has('peerToken')) {
      return false;
    }
    const headers = Object.entries(event.params.request.headers ?? {})
      .reduce<Record<string, string>>((normalized, [name, value]) => {
        normalized[name.toLowerCase()] = String(value);
        return normalized;
      }, {});
    return headers['x-cosyncing-token'] === token;
  } catch {
    return false;
  }
}

export interface CandidateClientContractIdentity {
  clientVersion: string;
  contractRevision: number;
  minimumBrokerRevision: number;
  contractSurfaceHash: string;
}

/** Prove that the compiled client placed its stamped contract identity in the ticket request body. */
export function ticketRequestContractMatches(
  postData: unknown,
  expected: CandidateClientContractIdentity,
  tool: string,
  sessionId: string,
): boolean {
  try {
    const body = JSON.parse(String(postData));
    const params = body?.params;
    return body?.tool === tool
      && body?.sessionId === sessionId
      && params != null
      && typeof params === 'object'
      && !Array.isArray(params)
      && params.clientVersion === expected.clientVersion
      && params.contractRevision === String(expected.contractRevision)
      && params.minimumBrokerRevision === String(expected.minimumBrokerRevision)
      && params.contractSurfaceHash === expected.contractSurfaceHash;
  } catch {
    return false;
  }
}

export function candidateBrokerEnvironment(options: {
  home: string;
  hostHome: string;
  webDirectory: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: options.hostHome,
    COSYNCING_HOME: options.home,
    COSYNCING_TOKEN_FILE: '',
    COSYNCING_PI_INTEGRATION_FILE: '',
    COSYNCING_TOKEN: '',
    COSYNCING_PI_INTEGRATION_TOKEN: '',
    COSYNCING_CACHE_DIR: join(options.home, 'cache'),
    COSYNCING_WEB_DIR: options.webDirectory,
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    COSYNCING_CLAUDE_HOOKS: '0',
    COSYNCING_CODEX_SYNC_SERVER: '0',
    COSYNCING_TOKDASH_URL: 'http://127.0.0.1:1',
  };
}

async function probeBuiltClient(options: {
  base: string;
  browserHome: string;
  token: string;
  sessionId: string;
  brokerContract: any;
  clientContract: CandidateClientContractIdentity;
}): Promise<void> {
  await withCandidateParityBrowser({
    executable: chromeHeadlessShell(),
    profileRoot: options.browserHome,
  }, async ({ socket }) => {
    let nextId = 0;
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void }
    >();
    const events: any[] = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      } else if (message.method) {
        events.push(message);
      }
    });
    const send = (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<any> => new Promise((resolveResult, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveResult(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string): Promise<any> => {
      const response = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.exception?.description
          || 'candidate browser evaluation failed',
        );
      }
      return response.result?.value;
    };
    const waitFor = async (
      predicate: () => boolean | Promise<boolean>,
      timeout = 60_000,
    ): Promise<boolean> => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await predicate()) return true;
        await Bun.sleep(100);
      }
      return false;
    };
    const semanticPoint = async (label: string): Promise<any> => evaluate(`(() => {
      const target = ${JSON.stringify(label.toLowerCase())};
      const nodes = Array.from(document.querySelectorAll(
        'flt-semantics, flt-semantics *, input, textarea'
      )).map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: (element.getAttribute('aria-label')
            || element.getAttribute('placeholder')
            || element.textContent || '').trim(),
          role: element.getAttribute('role') || element.tagName.toLowerCase(),
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        };
      }).filter((node) => node.width > 0 && node.height > 0
        && node.label.toLowerCase() === target);
      nodes.sort((left, right) => {
        const leftControl = ['textbox', 'button', 'input', 'textarea'].includes(left.role) ? 0 : 1;
        const rightControl = ['textbox', 'button', 'input', 'textarea'].includes(right.role) ? 0 : 1;
        return leftControl - rightControl
          || (left.width * left.height) - (right.width * right.height);
      });
      return nodes[0] || null;
    })()`);
    const clickLabel = async (label: string): Promise<void> => {
      const point = await semanticPoint(label);
      if (!point) throw new Error(`built app did not expose ${JSON.stringify(label)}`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: Math.round(point.x + point.width / 2),
          y: Math.round(point.y + point.height / 2),
          button: 'left',
          clickCount: 1,
        });
      }
      await Bun.sleep(300);
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    const sessionPath = `/cosy/sessions/pi/${encodeURIComponent(options.sessionId)}`;
    await send('Page.navigate', {
      url: `${options.base}/cosy/#${sessionPath.substring('/cosy'.length)}`,
    });
    const flutterReady = await waitFor(async () =>
      await evaluate(
        `!document.getElementById('cosyncing-startup-shell')`,
      ) === true
    );
    if (!flutterReady) throw new Error('built Flutter app did not paint');
    const semanticsPlaceholderReady = await waitFor(async () =>
      await evaluate(`!!(
        document.querySelector('flt-semantics-placeholder')
        || document.querySelector('[aria-label="Enable accessibility"]')
      )`)
    );
    if (!semanticsPlaceholderReady) {
      throw new Error('built Flutter app did not expose its semantics control');
    }
    // Match Flutter's own semantics-placeholder browser test: mobile-mode
    // activation accepts a click only when its coordinates land within one
    // pixel of the placeholder's centre. HTMLElement.click() supplies zeroed
    // coordinates, while a rounded CDP pointer can miss a 1 px desktop
    // placeholder, so dispatch the centred event explicitly.
    const semanticsActivation = await evaluate(`(() => {
      const placeholder = document.querySelector('flt-semantics-placeholder')
        || document.querySelector('[aria-label="Enable accessibility"]');
      if (!placeholder) return false;
      const rect = placeholder.getBoundingClientRect();
      const dispatched = placeholder.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: Math.floor(rect.left + (rect.right - rect.left) / 2),
        clientY: Math.floor(rect.top + (rect.bottom - rect.top) / 2),
      }));
      return {
        dispatched,
        tag: placeholder.tagName,
        connected: placeholder.isConnected,
        rect: {
          left: rect.left, top: rect.top,
          right: rect.right, bottom: rect.bottom,
        },
        userAgent: navigator.userAgent,
      };
    })()`);
    const tokenFieldReady = await waitFor(async () =>
      (await semanticPoint(CANDIDATE_CREDENTIAL_FIELD_LABEL)) !== null
    );
    if (!tokenFieldReady) {
      const diagnostics = await evaluate(`(() => ({
        url: location.href,
        title: document.title,
        labels: Array.from(document.querySelectorAll(
          'flt-semantics, flt-semantics *, [aria-label], input, textarea'
        )).map((element) => (
          element.getAttribute('aria-label')
          || element.getAttribute('placeholder')
          || element.textContent
          || ''
        ).trim()).filter(Boolean).slice(0, 30)
      }))()`);
      throw new Error(
        `built app did not present its broker credential gate: ${
          JSON.stringify({ ...diagnostics, semanticsActivation })
        }`,
      );
    }
    await clickLabel(CANDIDATE_CREDENTIAL_FIELD_LABEL);
    await send('Input.insertText', { text: options.token });
    await clickLabel('Save token');
    // The save button starts an async secure-store/profile mutation followed by a gate refresh. A fixed
    // post-click delay let a slower hosted runner navigate away while that transaction was still in flight,
    // so the fresh route still had no credential and could never open its session WebSocket. The field is
    // removed only after the save and refresh have completed successfully, making it the user-visible commit
    // witness rather than an estimate of how long persistence ought to take.
    const credentialCommitted = await waitFor(async () =>
      (await semanticPoint(CANDIDATE_CREDENTIAL_FIELD_LABEL)) === null, 30_000);
    if (!credentialCommitted) {
      const diagnostics = await evaluate(`(() => ({
        url: location.href,
        labels: Array.from(document.querySelectorAll(
          'flt-semantics, flt-semantics *, [aria-label], input, textarea'
        )).map((element) => (
          element.getAttribute('aria-label')
          || element.getAttribute('placeholder')
          || element.textContent
          || ''
        ).trim()).filter(Boolean).slice(0, 30)
      }))()`);
      throw new Error(
        `built app did not commit its broker credential: ${JSON.stringify(diagnostics)}`,
      );
    }
    // The unauthenticated route guard sends the initial deep link to the
    // session list. Depending on router timing it can either keep the intended
    // hash in the address bar or replace it with `#/sessions`. Navigating
    // directly to the already-present hash is a same-document no-op, while
    // reloading alone cannot restore a hash the guard replaced. First reboot
    // Flutter from the persisted token, wait for that document to paint, then
    // revisit the intended session from the authenticated app.
    const reloadEventMark = events.length;
    await send('Page.reload', { ignoreCache: false });
    const documentReloaded = await waitFor(() => events
      .slice(reloadEventMark)
      .some((event) => event.method === 'Page.loadEventFired'), 30_000);
    if (!documentReloaded) {
      throw new Error('built app did not reload after committing its credential');
    }
    const authenticatedAppReady = await waitFor(async () => {
      try {
        return await evaluate(
          `!document.getElementById('cosyncing-startup-shell')`,
        ) === true;
      } catch {
        return false;
      }
    });
    if (!authenticatedAppReady) {
      throw new Error('built app did not repaint after committing its credential');
    }
    const sessionDeepLink = `${options.base}/cosy/#${
      sessionPath.substring('/cosy'.length)
    }`;
    await send('Page.navigate', { url: sessionDeepLink });

    const encodedSession = `/api/sessions/pi/${
      encodeURIComponent(options.sessionId)
    }/stream`;
    let appSocket: any;
    let lastSessionNavigation = Date.now();
    const connected = await waitFor(async () => {
      appSocket = events.find((event) => {
        if (event.method !== 'Network.webSocketCreated') return false;
        return isTicketedSessionWebSocket(event.params.url, encodedSession);
      });
      if (appSocket) return true;
      // A slower browser can finish the credential/profile refresh after the
      // first deep-link navigation and let its route guard settle back on the
      // roster. Reassert the same authenticated deep link until the socket is
      // observed; the existing deadline remains the hard bound.
      if (Date.now() - lastSessionNavigation >= 1_000) {
        lastSessionNavigation = Date.now();
        await send('Page.navigate', { url: sessionDeepLink });
      }
      return false;
    });
    if (!connected) {
      const diagnostics = await evaluate(`(() => ({
        url: location.href,
        labels: Array.from(document.querySelectorAll(
          'flt-semantics, flt-semantics *, [aria-label], input, textarea'
        )).map((element) => (
          element.getAttribute('aria-label')
          || element.getAttribute('placeholder')
          || element.textContent
          || ''
        ).trim()).filter(Boolean).slice(0, 30)
      }))()`);
      const sockets = events
        .filter((event) => event.method === 'Network.webSocketCreated')
        .map((event) => {
          try {
            const url = new URL(event.params.url);
            return {
              path: url.pathname,
              queryKeys: [...url.searchParams.keys()],
            };
          } catch {
            return { path: '<invalid>', queryKeys: [] };
          }
        });
      throw new Error(
        `built app did not create the session WebSocket: ${JSON.stringify({
          ...diagnostics,
          sockets,
        })}`,
      );
    }
    const socketEventIndex = events.indexOf(appSocket);
    const ticketRequest = events
      .slice(0, socketEventIndex)
      .find((event) => isHeaderAuthenticatedTicketRequest(
        event,
        options.base,
        options.token,
      ));
    if (!ticketRequest) {
      throw new Error(
        'built app did not exchange its header credential for the WebSocket ticket',
      );
    }
    const ticketPostData = await send('Network.getRequestPostData', {
      requestId: ticketRequest.params.requestId,
    });
    if (!ticketRequestContractMatches(
      ticketPostData?.postData,
      options.clientContract,
      'pi',
      options.sessionId,
    )) {
      throw new Error(
        'compiled web client ticket request does not match its stamped contract identity',
      );
    }
    let hello: any;
    const helloReceived = await waitFor(() => {
      for (const event of events) {
        if (event.method !== 'Network.webSocketFrameReceived'
            || event.params.requestId !== appSocket.params.requestId) continue;
        try {
          const frame = JSON.parse(event.params.response.payloadData);
          if (frame.kind === 'hello') {
            hello = frame;
            return true;
          }
        } catch {
          // Ignore non-JSON frames; the broker/client wire is expected to
          // produce a JSON hello and will fail below if it never does.
        }
      }
      return false;
    });
    if (!helloReceived || hello.compatibility?.status !== 'compatible'
        || hello.compatibility?.readOnly !== false
        || JSON.stringify(hello.compatibility?.broker)
          !== JSON.stringify(options.brokerContract)) {
      throw new Error('built app did not negotiate a compatible broker hello');
    }
    await Bun.sleep(500);
    const compatibilityNotice = await evaluate(`(() => {
      const prefixes = [
        'This client is one contract revision behind',
        'This broker is one contract revision behind',
        'This client and broker are incompatible',
        'This broker did not provide a complete compatibility identity'
      ];
      return Array.from(document.querySelectorAll('[aria-label], flt-semantics'))
        .map((element) => element.getAttribute('aria-label') || element.textContent || '')
        .some((label) => prefixes.some((prefix) => label.includes(prefix)));
    })()`);
    if (compatibilityNotice) {
      throw new Error('built app rendered a false compatibility notice');
    }
  });
}

export function webIdentityMatchesCandidate(
  identity: any,
  args: Pick<
    CandidatePairArgs,
    'commit' | 'version' | 'allowDirtyWebReview'
  >,
): boolean {
  return identity.version === args.version
    && identity.sourceCommit === args.commit
    && identity.dirty === (args.allowDirtyWebReview ? true : false)
    && identity.baseHref === '/cosy/'
    && Number.isSafeInteger(identity.contract?.revision)
    && Number.isSafeInteger(identity.contract?.minimumClientRevision)
    && typeof identity.contract?.surfaceHash === 'string'
    && /^fnv1a32:[a-f0-9]{8}$/.test(identity.contract.surfaceHash)
    && Number.isSafeInteger(identity.contract?.clientMinimumBrokerRevision);
}

export function brokerIdentityMatchesCandidate(
  identity: any,
  args: Pick<
    CandidatePairArgs,
    'commit' | 'version' | 'allowDirtyWebReview'
  >,
  webBrokerContract: unknown,
): boolean {
  return identity.version === args.version
    && identity.commit === args.commit
    && identity.packaged === true
    && identity.dirty === (args.allowDirtyWebReview ? true : false)
    && identity.schemaVersions?.brokerContract
      === (webBrokerContract as any)?.revision
    && JSON.stringify(identity.contract) === JSON.stringify(webBrokerContract);
}

export async function verifyCandidatePair(
  args: CandidatePairArgs,
): Promise<void> {
  const identityPath = join(
    args.webDirectory,
    'cosyncing-build-identity.json',
  );
  const identityBytes = readFileSync(identityPath);
  const identity = JSON.parse(identityBytes.toString('utf8'));
  const webBrokerContract = {
    revision: identity.contract?.revision,
    minimumClientRevision: identity.contract?.minimumClientRevision,
    surfaceHash: identity.contract?.surfaceHash,
  };
  if (!webIdentityMatchesCandidate(identity, args)) {
    throw new Error('built web client identity does not match the candidate');
  }
  const mainDart = readFileSync(join(args.webDirectory, 'main.dart.js'));
  if (!mainDart.includes(Buffer.from(identity.contract.surfaceHash, 'utf8'))) {
    throw new Error('compiled web client does not contain its stated contract hash');
  }
  const indexHtml = readFileSync(
    join(args.webDirectory, 'index.html'),
    'utf8',
  );
  const worker = readFileSync(join(args.webDirectory, 'sw.js'), 'utf8');
  const unstampedWorkerTokens = [
    '__COSYNCING_BUILD_VERSION__',
    '__COSYNCING_PRECACHE_URLS__',
    '__COSYNCING_RUNTIME_URLS__',
    '__COSYNCING_ASSET_HASHES__',
  ];
  if (!indexHtml.includes('<base href="/cosy/">')
      || !worker.includes(`const BUILD_VERSION = '${identity.buildId}'`)
      || unstampedWorkerTokens.some((token) => worker.includes(token))) {
    throw new Error('built web client is root-scoped or has an unstamped worker');
  }

  const binaryInfo = await processJson(
    [args.broker, 'version', '--json'],
    process.cwd(),
  );
  if (!brokerIdentityMatchesCandidate(binaryInfo, args, webBrokerContract)) {
    throw new Error('built broker identity does not match the candidate');
  }

  const home = mkdtempSync(join(tmpdir(), 'cosyncing-candidate-pair-'));
  try {
    const hostHome = join(home, 'host-home');
    mkdirSync(hostHome, { recursive: true });
    writeInstallState(committedInstallState(), home);
    const config = defaultBrokerConfig();
    const maxPortAttempts = 8;
    await runCandidateBrokerAttempts({
      maxAttempts: maxPortAttempts,
      reservePort: reserveLoopbackPort,
      prepare: (port) => {
        const base = `http://127.0.0.1:${port}`;
        writeBrokerConfig({
          ...config,
          broker: {
            ...config.broker,
            host: '127.0.0.1',
            port,
            machineLabel: 'release-candidate',
            internalUrl: base,
          },
          paths: {
            ...config.paths,
            flutterWebRoot: args.webDirectory,
          },
        }, home);
        const credentials = ensureInstallationCredentials({
          home,
          internalUrl: base,
        });
        return {
          base,
          credentials,
          token: credentials.brokerToken,
        };
      },
      spawn: () => Bun.spawn(
        [args.broker, 'broker'],
        {
          cwd: process.cwd(),
          env: candidateBrokerEnvironment({
            home,
            hostHome,
            webDirectory: args.webDirectory,
          }),
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ),
      drainOutput: drainProcessOutput,
      verify: async ({
        attempt,
        maxAttempts,
        broker,
        stdout,
        stderr,
        prepared,
      }) => {
        const { base, credentials, token } = prepared;
        let ready = false;
        for (let probe = 0; probe < 120 && !ready; probe += 1) {
          if (broker.exitCode !== null) break;
          try {
            const response = await fetch(`${base}/api/health`, {
              headers: { 'x-cosyncing-token': token },
            });
            if (response.ok) {
              const candidateHealth = await response.json() as any;
              if (candidateHealth.version === args.version
                  && JSON.stringify(candidateHealth.contract)
                    === JSON.stringify(webBrokerContract)) {
                ready = true;
              }
            }
          } catch {
            // Startup is still in progress.
          }
          if (!ready) await Bun.sleep(100);
        }
        if (ready) {
          // A process that wins the close-before-bind race can answer health
          // briefly while the candidate is still discovering EADDRINUSE.
          await Bun.sleep(100);
          if (broker.exitCode !== null) {
            ready = false;
          }
        }
        if (!ready) {
          if (broker.exitCode === null) broker.kill();
          await broker.exited;
          const [stdoutText, stderrText] = await Promise.all([
            stdout,
            stderr,
          ]);
          const output = `${stdoutText}\n${stderrText}`;
          if (isAddressInUse(output) && attempt < maxAttempts) {
            return 'retry';
          }
          const detail = output.trim().slice(-1_000);
          throw new Error(
            `candidate broker did not become healthy (${broker.exitCode})${
              detail ? `: ${detail}` : ''
            }`,
          );
        }
        const servedIdentity = await (
          await fetch(`${base}/cosy/cosyncing-build-identity.json`)
        ).json() as any;
        if (JSON.stringify(servedIdentity) !== JSON.stringify(identity)) {
          throw new Error('broker is not serving the verified web sidecar');
        }

        const piResponse = await fetch(`${base}/pi/bridge/hello`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cosyncing-integration-token':
              credentials.piIntegration.credential,
          },
          body: JSON.stringify({
            sessionFile: join(home, 'release-candidate.jsonl'),
            cwd: home,
            title: 'Release candidate parity',
            history: [],
          }),
        });
        const pi = await piResponse.json() as any;
        if (!piResponse.ok || typeof pi.id !== 'string') {
          throw new Error('candidate broker could not create the parity fixture');
        }
        await probeBuiltClient({
          base,
          browserHome: join(home, 'browser-profile'),
          token,
          sessionId: pi.id,
          brokerContract: webBrokerContract,
          clientContract: {
            clientVersion: identity.version,
            contractRevision: identity.contract.revision,
            minimumBrokerRevision:
              identity.contract.clientMinimumBrokerRevision,
            contractSurfaceHash: identity.contract.surfaceHash,
          },
        });
        return 'complete';
      },
      onProcessExit: ({ broker, stdout, stderr, retrying }) => {
        if (!retrying && broker.exitCode !== 0 && broker.exitCode !== 143) {
          const detail = `${stdout}\n${stderr}`.trim().slice(-1_000);
          if (detail) console.error(`candidate broker output: ${detail}`);
        }
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    await verifyCandidatePair(args);
    console.log(
      `PASS: built broker and /cosy/ web client are one compatible ${
        args.version
      } candidate at ${args.commit}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
