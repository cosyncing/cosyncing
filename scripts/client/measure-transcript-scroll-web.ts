/**
 * Web half of `measure-transcript-scroll.ts`: transcript scrolling in a
 * profile web build, in headless Chromium, against an isolated fixture broker.
 *
 * The broker runs from source with its own temporary port and home and no
 * managed runtimes (see `isolatedBrokerFixtureEnvironment`), and serves the
 * profile bundle. A Pi bridge session carries a long mixed history; replies
 * stream into it through the bridge's event route, as a Pi terminal would
 * send them, and the bridge is kept alive by long-polling its command route
 * as the terminal does. Stopped with SIGINT or SIGTERM, it closes the browser
 * and the broker and removes the temporary home. The page is instrumented
 * before the app starts:
 *
 * - every `performance.measure` the profile build records (a dart2js profile
 *   build turns the framework's timeline events, `Frame` among them, into
 *   measures), and every animation frame's timestamp;
 * - the broker WebSocket: page requests are timed from send to the first
 *   animation frame after the page is handed to the app, and a history page
 *   can be held back by a chosen delay before it is, as a slow broker would.
 *
 * Headless Chromium here renders without a GPU (see the launch flags): the
 * renderer rasterizes each frame on the page's main thread, so frame times
 * and the phases measured around them carry that cost. They are comparable
 * between runs on one machine, not with a device that has a GPU.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  settledProcessOutput,
  startHealthyFixtureBroker,
  type ProcessOutputCapture,
} from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import packageJson from '../../package.json';
import { readWebSourceIdentity, stampWebCache } from './build-web-cache.ts';
import { CLIENT_ROOT, REPOSITORY_ROOT, runClientCommand } from './run-client-command.ts';

const WEB_PROFILE_BUILD = join(CLIENT_ROOT, 'build/web-profile');
const BROWSER_ARGS = [
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-features=Vulkan,VizDisplayCompositor',
];
const VIEWPORT = { width: 1280, height: 800 };
const HISTORY_ROWS = 3000;

export interface WebMeasureOptions {
  out: string;
  skipBuild: boolean;
  /** A profile web build to serve instead of building this checkout's. */
  webDir?: string;
  /** Comma-separated scenario names, or `all`. */
  scenarios?: string;
  scale: number;
}

const started = Date.now();
function progress(message: string): void {
  console.error(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s] ${message}`);
}

// ---------------------------------------------------------------- the build

async function buildProfileWeb(): Promise<number> {
  const source = readWebSourceIdentity();
  const code = await runClientCommand([
    'flutter',
    'build',
    'web',
    '--profile',
    '--base-href',
    '/cosy/',
    '--output',
    WEB_PROFILE_BUILD,
    '--no-wasm-dry-run',
    `--dart-define=COSYNCING_CLIENT_VERSION=${packageJson.version}`,
    `--dart-define=COSYNCING_CLIENT_SOURCE_COMMIT=${source.sourceCommit}`,
    `--dart-define=COSYNCING_CLIENT_SOURCE_DIRTY=${source.dirty}`,
  ]);
  if (code !== 0) return code;
  return stampWebCache({ buildDir: WEB_PROFILE_BUILD, quiet: true, sourceIdentity: source });
}

// ---------------------------------------------------------- the history

function paragraph(index: number, p: number): string {
  return `Paragraph ${p} of row ${index} explains what changed and why, with `
    + '`inline code`, a [reference](https://example.com/' + index + ') and enough '
    + 'words to wrap across several lines at any reasonable width.';
}

function code(index: number, lines: number): string {
  const body = Array.from({ length: lines }, (_, line) =>
    `  final value${line} = compute(${index}, ${line}); // step ${line}`).join('\n');
  return '```dart\nvoid step' + index + '() {\n' + body + '\n}\n```';
}

function log(index: number, lines: number): string {
  return Array.from({ length: lines }, (_, line) =>
    `[${String(line).padStart(4, '0')}] row ${index}: task ${line} finished in ${line % 97} ms`).join('\n');
}

/** Bridge history events for durable row [index], in units of ten rows. */
function historyEvents(index: number): unknown[] {
  const unit = index % 10;
  const oversized = index % 50 === 49;
  switch (unit) {
    case 0:
      return [{ t: 'user', key: `u${index}`, text: `Row ${index}. Please look at part ${Math.floor(index / 10)}.` }];
    case 1:
      return [{ t: 'final', kind: 'text', key: `m${index}`, text: [0, 1, 2].map((p) => paragraph(index, p)).join('\n\n') }];
    case 2:
      return [{
        t: 'final', kind: 'text', key: `m${index}`,
        text: `## Row ${index} summary\n\n- first point\n- second point with \`code\`\n\n`
          + '| file | change |\n| --- | --- |\n| a.dart | +12 |\n| b.dart | -3 |',
      }];
    case 3:
      return [{ t: 'final', kind: 'text', key: `m${index}`, text: `Row ${index} code:\n\n${code(index, 12)}` }];
    case 4:
    case 5: {
      const callId = `call-${index}`;
      if (index % 20 < 10) {
        const args = { path: `lib/file_${index}.dart`, oldText: 'old', newText: 'new' };
        const diff = Array.from({ length: 24 }, (_, l) => (l % 3 === 0 ? `-old ${l}` : `+new ${l}`)).join('\n');
        return unit === 4
          ? [{ t: 'tool-call', callId, name: 'edit', args }]
          : [{ t: 'tool-result', callId, name: 'edit', args, result: `Edited lib/file_${index}.dart`, details: { diff }, isError: false }];
      }
      const args = { command: `bun run task --row ${index}` };
      return unit === 4
        ? [{ t: 'tool-call', callId, name: 'bash', args }]
        : [{ t: 'tool-result', callId, name: 'bash', args, result: log(index, index % 100 === 15 ? 900 : 24), isError: false }];
    }
    case 6:
      return [{ t: 'final', kind: 'text', key: `m${index}`, text: paragraph(index, 0) }];
    case 7:
      return [{ t: 'final', kind: 'thinking', key: `t${index}`, text: `Thinking about row ${index}: ${paragraph(index, 1)}` }];
    case 8:
      return [{ t: 'final', kind: 'text', key: `m${index}`, text: [0, 1].map((p) => paragraph(index, p)).join('\n\n') }];
    default:
      if (!oversized) return [{ t: 'final', kind: 'text', key: `m${index}`, text: 'Done.' }];
      return [{
        t: 'final', kind: 'text', key: `m${index}`,
        text: index % 150 === 49
          ? Array.from({ length: 40 }, (_, p) => paragraph(index, p)).join('\n\n')
          : `Long listing for row ${index}:\n\n${code(index, 160)}`,
      }];
  }
}

function replySegment(reply: number, segment: number): string {
  return segment % 4 === 3 ? code(reply * 100 + segment, 6) : paragraph(reply, segment);
}

// -------------------------------------------------------------- the broker

interface Broker {
  child: ReturnType<typeof Bun.spawn>;
  output: ProcessOutputCapture;
  origin: string;
}

async function startBroker(root: string, webDir: string): Promise<Broker> {
  const captures = new Map<unknown, ProcessOutputCapture>();
  const { child, port } = await startHealthyFixtureBroker({
    spawn: (port) => {
      const spawned = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
        cwd: REPOSITORY_ROOT,
        env: isolatedBrokerFixtureEnvironment(root, {
          overrides: {
            PORT: String(port),
            HOST: '127.0.0.1',
            COSYNCING_CACHE_DIR: join(root, 'cache'),
            COSYNCING_WEB_DIR: webDir,
            COSYNCING_PI_SESSIONS_ROOT: '',
            PI_CODING_AGENT_SESSION_DIR: '',
          },
        }),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      captures.set(spawned, captureProcessOutput(spawned));
      return spawned;
    },
    healthUrl: (port) => `http://127.0.0.1:${port}/api/health`,
    capture: (child) => captures.get(child)!,
    stop: async (child) => {
      child.kill();
      await child.exited;
    },
  });
  return { child, output: captures.get(child)!, origin: `http://127.0.0.1:${port}` };
}

async function stopBroker(broker: Broker | undefined): Promise<void> {
  if (!broker) return;
  if (broker.child.exitCode == null) broker.child.kill('SIGTERM');
  const exited = await Promise.race([
    broker.child.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!exited) broker.child.kill('SIGKILL');
  await broker.child.exited;
  await settledProcessOutput(broker.output);
}

async function post(origin: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Opens the bridge session and saves its history. A hello is bounded like any
 * ordinary request, so it carries none; the rows follow as bridge events in
 * batches under that bound, which the bridge keeps as history just as it
 * keeps a terminal's finished rows. (A tool call sent as an event is shown
 * live but not kept; its result carries the call's name and arguments.)
 */
async function openBridge(origin: string, root: string): Promise<string> {
  const response = await post(origin, '/pi/bridge/hello', {
    sessionFile: join(root, 'scroll-fixture.jsonl'),
    cwd: root,
    title: 'Scroll fixture',
    history: [],
  });
  if (response.status !== 200) throw new Error(`bridge hello failed: ${response.status}`);
  const id = String(((await response.json()) as { id: unknown }).id);
  let batch: unknown[] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const sent = await post(origin, '/pi/bridge/events', { id, events: batch });
    if (sent.status !== 200) throw new Error(`bridge history failed: ${sent.status}`);
    batch = [];
    bytes = 0;
  };
  for (let index = 0; index < HISTORY_ROWS; index++) {
    for (const event of historyEvents(index)) {
      const size = JSON.stringify(event).length;
      if (bytes + size > 768 * 1024) await flush();
      batch.push(event);
      bytes += size;
    }
  }
  await flush();
  return id;
}

/**
 * Long-polls the bridge's command route, as the terminal extension does: the
 * broker takes a bridge that has neither sent nor polled for a minute to be a
 * terminal that went away. Resolves once [signal] aborts.
 */
async function keepBridgeAlive(origin: string, id: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await fetch(`${origin}/pi/bridge/commands?id=${encodeURIComponent(id)}`, { signal });
    } catch {
      if (!signal.aborted) await Bun.sleep(1_000);
    }
  }
}

/** Streams one reply of [chunks] segments at [intervalMs], then finishes it. */
async function streamReply(
  origin: string,
  id: string,
  key: string,
  reply: number,
  chunks: number,
  intervalMs: number,
  between?: (chunk: number) => Promise<void>,
): Promise<void> {
  await post(origin, '/pi/bridge/events', { id, events: [{ t: 'status', running: true }] });
  const segments: string[] = [];
  for (let chunk = 0; chunk < chunks; chunk++) {
    const segment = replySegment(reply, chunk);
    segments.push(segment);
    await post(origin, '/pi/bridge/events', {
      id,
      events: [{ t: 'delta', kind: 'text', key, delta: `${chunk === 0 ? '' : '\n\n'}${segment}` }],
    });
    if (between) await between(chunk);
    else await Bun.sleep(intervalMs);
  }
  await post(origin, '/pi/bridge/events', {
    id,
    events: [
      { t: 'final', kind: 'text', key, text: segments.join('\n\n') },
      { t: 'status', running: false },
    ],
  });
}

// ------------------------------------------------------ the instrumentation

/** Installed before the app loads (see the file comment). */
function instrument(): void {
  interface PageRecord {
    id: string;
    newer: boolean;
    sentAt: number;
    arrivedAt?: number;
    deliveredAt?: number;
    paintedAt?: number;
    bytes?: number;
    failed?: boolean;
  }
  const state = {
    recording: false,
    measures: [] as Array<[string, number, number]>,
    raf: [] as number[],
    pageDelayMs: 0,
    pages: [] as PageRecord[],
    unpainted: [] as PageRecord[],
    textFrames: 0,
    otherFrames: 0,
  };
  (window as unknown as { __scroll: typeof state }).__scroll = state;
  new PerformanceObserver((list) => {
    if (!state.recording) return;
    for (const entry of list.getEntries()) {
      state.measures.push([entry.name, entry.startTime, entry.duration]);
    }
  }).observe({ type: 'measure' });
  const onFrame = (time: number) => {
    if (state.recording) state.raf.push(time);
    if (state.unpainted.length) {
      for (const record of state.unpainted) record.paintedAt = time;
      state.unpainted = [];
    }
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);

  const byId = new Map<string, PageRecord>();
  const Native = window.WebSocket;
  class Instrumented extends Native {
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (typeof data === 'string' && data.includes('"history-page"')) {
        try {
          const frame = JSON.parse(data) as { kind?: string; clientMessageId?: string; direction?: string };
          if (frame.kind === 'history-page' && frame.clientMessageId) {
            const record: PageRecord = {
              id: frame.clientMessageId,
              newer: frame.direction === 'newer',
              sentAt: performance.now(),
            };
            byId.set(record.id, record);
            state.pages.push(record);
          }
        } catch {
          // Not JSON: nothing to time.
        }
      }
      super.send(data);
    }

    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (listener == null) return;
      if (type !== 'message' || typeof listener !== 'function') {
        super.addEventListener(type, listener, options);
        return;
      }
      super.addEventListener(type, (event) => {
        const message = event as MessageEvent;
        if (typeof message.data !== 'string') {
          state.otherFrames += 1;
          listener.call(this, event);
          return;
        }
        state.textFrames += 1;
        let record: PageRecord | undefined;
        if (message.data.includes('"history-page"') || message.data.includes('"nack"')) {
          try {
            const frame = JSON.parse(message.data) as { kind?: string; clientMessageId?: string };
            if ((frame.kind === 'history-page' || frame.kind === 'nack') && frame.clientMessageId) {
              record = byId.get(frame.clientMessageId);
              if (record) {
                record.arrivedAt = performance.now();
                record.bytes = message.data.length;
                record.failed = frame.kind === 'nack';
              }
            }
          } catch {
            // Not JSON: deliver as is.
          }
        }
        const deliver = () => {
          if (record) {
            record.deliveredAt = performance.now();
            state.unpainted.push(record);
          }
          listener.call(this, event);
        };
        if (record && state.pageDelayMs > 0) setTimeout(deliver, state.pageDelayMs);
        else deliver();
      }, options);
    }
  }
  window.WebSocket = Instrumented;
}

interface Recorded {
  measures: Array<[string, number, number]>;
  raf: number[];
  pages: Array<{
    newer: boolean;
    sentAt: number;
    arrivedAt?: number;
    deliveredAt?: number;
    paintedAt?: number;
    bytes?: number;
    failed?: boolean;
  }>;
  textFrames: number;
  otherFrames: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const value = sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
  return Math.round(value * 1000) / 1000;
}

function distribution(values: number[]): Record<string, number | null> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? Math.round(sorted.at(-1)! * 1000) / 1000 : null,
    mean: sorted.length ? Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 1000) / 1000 : null,
  };
}

function summarize(recorded: Recorded): Record<string, unknown> {
  const byName = new Map<string, number[]>();
  for (const [name, , duration] of recorded.measures) {
    const list = byName.get(name) ?? [];
    list.push(duration);
    byName.set(name, list);
  }
  const frames = byName.get('Frame') ?? [];
  const over = (budget: number) => frames.filter((value) => value > budget).length;
  const intervals: number[] = [];
  for (let i = 1; i < recorded.raf.length; i++) intervals.push(recorded.raf[i]! - recorded.raf[i - 1]!);
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const period = percentile(sortedIntervals, 50) ?? 1000 / 60;
  const phases: Record<string, unknown> = {};
  for (const [name, values] of byName) {
    if (name === 'Frame') continue;
    const total = values.reduce((a, b) => a + b, 0);
    phases[name] = { count: values.length, totalMs: Math.round(total), ...distribution(values) };
  }
  const answered = recorded.pages.filter((page) => page.paintedAt != null && !page.failed);
  return {
    frames: {
      frames: frames.length,
      frameMs: distribution(frames),
      over16_7ms: over(1000 / 60),
      over8_3ms: over(1000 / 120),
      within16_7msShare: frames.length ? (frames.length - over(1000 / 60)) / frames.length : null,
      within8_3msShare: frames.length ? (frames.length - over(1000 / 120)) / frames.length : null,
      worstStallsMs: [...frames].sort((a, b) => b - a).slice(0, 5).map((v) => Math.round(v * 1000) / 1000),
    },
    animationFrames: {
      count: recorded.raf.length,
      medianIntervalMs: period,
      intervalsOver1_5Periods: intervals.filter((value) => value > period * 1.5).length,
      intervalMs: distribution(intervals),
    },
    phases,
    pages: {
      requested: recorded.pages.length,
      older: recorded.pages.filter((page) => !page.newer).length,
      newer: recorded.pages.filter((page) => page.newer).length,
      failed: recorded.pages.filter((page) => page.failed).length,
      bytes: recorded.pages.reduce((sum, page) => sum + (page.bytes ?? 0), 0),
      requestToFirstPaintMs: distribution(answered.map((page) => page.paintedAt! - page.sentAt)),
      deliveryToFirstPaintMs: distribution(answered.map((page) => page.paintedAt! - page.deliveredAt!)),
    },
    socketFrames: { text: recorded.textFrames, other: recorded.otherFrames },
  };
}

// -------------------------------------------------------------- the reader

async function chromiumExecutable(): Promise<string> {
  const explicit = process.env.COSYNCING_CHROMIUM_EXECUTABLE?.trim();
  if (explicit) return explicit;
  const cache = join(process.env.HOME ?? tmpdir(), '.cache/ms-playwright');
  const shells = readdirSync(cache)
    .filter((entry) => entry.startsWith('chromium_headless_shell-'))
    .sort((left, right) => Number(right.split('-')[1]) - Number(left.split('-')[1]));
  if (shells.length === 0) throw new Error('No Chromium headless shell under ~/.cache/ms-playwright.');
  return join(cache, shells[0]!, 'chrome-headless-shell-linux64/chrome-headless-shell');
}

async function startRecording(page: Page, delayMs: number): Promise<void> {
  await page.evaluate((delay) => {
    const state = (window as unknown as { __scroll: Record<string, unknown> }).__scroll;
    state.measures = [];
    state.raf = [];
    state.pages = [];
    state.textFrames = 0;
    state.otherFrames = 0;
    state.pageDelayMs = delay;
    state.recording = true;
  }, delayMs);
}

async function stopRecording(page: Page): Promise<Recorded> {
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const state = (window as unknown as { __scroll: Record<string, unknown> }).__scroll;
    state.recording = false;
    return JSON.parse(JSON.stringify({
      measures: state.measures,
      raf: state.raf,
      pages: state.pages,
      textFrames: state.textFrames,
      otherFrames: state.otherFrames,
    })) as Recorded;
  });
}

async function pagesRequested(page: Page): Promise<number> {
  return page.evaluate(() =>
    ((window as unknown as { __scroll: { pages: unknown[] } }).__scroll.pages).length);
}

async function heap(cdp: CDPSession): Promise<{ usedBytes: number; totalBytes: number }> {
  await cdp.send('HeapProfiler.collectGarbage');
  const usage = await cdp.send('Runtime.getHeapUsage') as { usedSize: number; totalSize: number };
  return { usedBytes: usage.usedSize, totalBytes: usage.totalSize };
}

/** Wheels [dy] per animation frame for [ms]; negative is toward older rows. */
async function wheelFor(page: Page, dy: number, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(16);
  }
}

/** A touch fling of [distance] px at [speed] px/s; positive is toward older rows. */
async function fling(cdp: CDPSession, distance: number, speed: number): Promise<void> {
  await cdp.send('Input.synthesizeScrollGesture', {
    x: VIEWPORT.width / 2,
    y: VIEWPORT.height / 2,
    yDistance: distance,
    speed,
    gestureSourceType: 'touch',
    preventFling: false,
  });
}

async function openSession(page: Page, origin: string, id: string): Promise<void> {
  await page.goto(`${origin}/cosy/#/sessions/pi/${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => Boolean(document.querySelector('flt-glass-pane, flutter-view')),
    undefined,
    { timeout: 90_000 },
  );
  // The transcript is ready when its first page has been received and the app
  // has settled on its newest rows.
  await page.waitForTimeout(6_000);
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  const frames = await page.evaluate(() => {
    const state = (window as unknown as { __scroll: { textFrames: number; otherFrames: number } }).__scroll;
    return { text: state.textFrames, other: state.otherFrames };
  });
  progress(`session open; socket frames seen: ${frames.text} text, ${frames.other} other`);
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}

/**
 * Self time by function from a sampled CPU profile: where the page's main
 * thread went. Only on request (TRANSCRIPT_SCROLL_WEB_CPU_PROFILE=1): the
 * sampler has a cost of its own.
 */
function topSelfTime(
  profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] },
  limit = 40,
): Array<{ fn: string; selfMs: number }> {
  const byNode = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]!;
    byNode.set(id, (byNode.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  const byFunction = new Map<string, number>();
  for (const node of profile.nodes) {
    const micros = byNode.get(node.id);
    if (!micros) continue;
    const frame = node.callFrame;
    const name = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.lineNumber}`;
    byFunction.set(name, (byFunction.get(name) ?? 0) + micros);
  }
  return [...byFunction.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([fn, micros]) => ({ fn, selfMs: Math.round(micros / 100) / 10 }));
}

/** Time by script function including what it called, each sample once per function. */
function inclusiveTime(
  profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] },
  limit = 30,
): Array<{ fn: string; ms: number }> {
  const parent = new Map<number, number>();
  const nodes = new Map<number, ProfileNode>();
  for (const node of profile.nodes) {
    nodes.set(node.id, node);
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const byFunction = new Map<string, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    const seen = new Set<string>();
    let node = nodes.get(profile.samples[i]!);
    while (node) {
      if (node.callFrame.url.endsWith('main.dart.js')) {
        seen.add(`${node.callFrame.functionName || '(anonymous)'}:${node.callFrame.lineNumber}`);
      }
      const up = parent.get(node.id);
      node = up == null ? undefined : nodes.get(up);
    }
    for (const key of seen) byFunction.set(key, (byFunction.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  return [...byFunction.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([fn, micros]) => ({ fn, ms: Math.round(micros / 100) / 10 }));
}

/**
 * Time spent in the renderer's WebAssembly, charged to the nearest script
 * frame that called into it (the WebAssembly itself carries no names), with
 * that frame's own callers for context.
 */
function wasmByCaller(
  profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] },
  limit = 25,
): Array<{ caller: string; ms: number }> {
  const parent = new Map<number, number>();
  const nodes = new Map<number, ProfileNode>();
  for (const node of profile.nodes) {
    nodes.set(node.id, node);
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const name = (node: ProfileNode) =>
    `${node.callFrame.functionName || '(anonymous)'}:${node.callFrame.lineNumber}`;
  const isWasm = (node: ProfileNode) => node.callFrame.url.endsWith('.wasm');
  const byCaller = new Map<string, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    let node = nodes.get(profile.samples[i]!);
    if (!node || !isWasm(node)) continue;
    while (node && (isWasm(node) || !node.callFrame.url.endsWith('main.dart.js'))) {
      const up = parent.get(node.id);
      node = up == null ? undefined : nodes.get(up);
    }
    const chain: string[] = [];
    for (let depth = 0; node && depth < 4; depth++) {
      chain.push(name(node));
      const up = parent.get(node.id);
      node = up == null ? undefined : nodes.get(up);
    }
    const key = chain.join(' < ') || '(no script caller)';
    byCaller.set(key, (byCaller.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  return [...byCaller.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([caller, micros]) => ({ caller, ms: Math.round(micros / 100) / 10 }));
}

// ------------------------------------------------------------ the scenarios

export async function measureWebTranscriptScroll(options: WebMeasureOptions): Promise<number> {
  if (!options.skipBuild && !options.webDir) {
    const code = await buildProfileWeb();
    if (code !== 0) return code;
  }
  const webDir = options.webDir ? resolve(options.webDir) : WEB_PROFILE_BUILD;
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-scroll-web-'));
  let broker: Broker | undefined;
  const alive = new AbortController();
  let polling: Promise<void> | undefined;
  const browser = await chromium.launch({
    executablePath: await chromiumExecutable(),
    args: BROWSER_ARGS,
  });
  // Stopped from outside: leave no browser, broker or temporary home behind.
  const onSignal = (signal: NodeJS.Signals) => {
    alive.abort();
    void (async () => {
      await browser.close().catch(() => {});
      await stopBroker(broker).catch(() => {});
      rmSync(root, { recursive: true, force: true });
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const report: Record<string, unknown> = {};
  const selected = (options.scenarios ?? 'all').split(',');
  const wanted = (name: string) => selected.includes('all') || selected.includes(name);
  try {
    broker = await startBroker(root, webDir);
    const id = await openBridge(broker.origin, root);
    polling = keepBridgeAlive(broker.origin, id, alive.signal);
    report.environment = {
      mode: 'profile',
      browser: `chromium ${browser.version()} (headless shell, software rendering)`,
      viewport: VIEWPORT,
      historyRows: HISTORY_ROWS,
    };

    let shown = false;
    // TRANSCRIPT_SCROLL_WEB_SHOTS=1 keeps a screenshot of each stage, to see
    // what the reader was looking at when a scenario went wrong.
    const shots = process.env.TRANSCRIPT_SCROLL_WEB_SHOTS === '1'
      ? options.out.replace(/\.json$/, '-shots')
      : undefined;
    const shot = async (page: Page, name: string) => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: join(shots, `${name}.png`) });
    };
    const fresh = async (name: string) => {
      const context = await browser.newContext({ viewport: VIEWPORT, hasTouch: true });
      await context.addInitScript(instrument);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await openSession(page, broker!.origin, id);
      if (!shown) {
        // What the reader sees when the scenarios start, beside the report.
        await page.screenshot({ path: options.out.replace(/\.json$/, '.png') });
        shown = true;
      }
      await shot(page, `${name}-open`);
      return { context, page, cdp, errors };
    };

    for (const delay of wanted('traverse') ? [0, 100] : []) {
      progress(`traverse ${delay} ms`);
      const { context, page, errors } = await fresh(`traverse-${delay}`);
      await startRecording(page, delay);
      const cycles: Array<Record<string, number>> = [];
      for (let cycle = 0; cycle < 2; cycle++) {
        const before = await pagesRequested(page);
        const back = Date.now();
        while ((await pagesRequested(page)) - before < 6 && Date.now() - back < 90_000) {
          await wheelFor(page, -120, 400);
        }
        await shot(page, `traverse-${delay}-back${cycle}`);
        // As long forward as it took to read back, which reaches the newest
        // rows again.
        await wheelFor(page, 120, Date.now() - back);
        await shot(page, `traverse-${delay}-forward${cycle}`);
        cycles.push({ pagesBack: (await pagesRequested(page)) - before, ms: Date.now() - back });
        progress(`  cycle ${cycle}: ${cycles.at(-1)!.pagesBack} pages back in ${cycles.at(-1)!.ms} ms`);
      }
      report[`traverse-${delay}ms`] = { ...summarize(await stopRecording(page)), cycles, errors };
      await context.close();
    }

    for (const delay of wanted('flings') ? [0, 100, 500] : []) {
      progress(`flings ${delay} ms`);
      const { context, page, cdp, errors } = await fresh(`flings-${delay}`);
      await startRecording(page, delay);
      for (let index = 0; index < 12 * options.scale; index++) await fling(cdp, 1200, 5000);
      for (let index = 0; index < 12 * options.scale; index++) await fling(cdp, -1200, 5000);
      await page.waitForTimeout(1_500);
      report[`flings-${delay}ms`] = { ...summarize(await stopRecording(page)), errors };
      await context.close();
    }

    if (wanted('stream-far-back')) {
      progress('stream far back');
      const { context, page, errors } = await fresh('stream-far-back');
      const before = await pagesRequested(page);
      const reading = Date.now();
      while ((await pagesRequested(page)) - before < 2 && Date.now() - reading < 60_000) {
        await wheelFor(page, -120, 400);
      }
      progress(`  read back ${(await pagesRequested(page)) - before} pages`);
      await page.waitForTimeout(1_000);
      await startRecording(page, 0);
      let reply = 0;
      let direction = 1;
      let strokes = 0;
      const started = Date.now();
      while (Date.now() - started < 20_000 * options.scale) {
        await streamReply(broker.origin, id, `far-${reply}`, reply, 30, 33, async (chunk) => {
          if (chunk % 2 === 0) {
            await wheelFor(page, 40 * direction, 60);
            strokes += 1;
            if (strokes % 6 === 0) direction = -direction;
          } else {
            await Bun.sleep(33);
          }
        });
        reply += 1;
      }
      report['stream-far-back'] = { ...summarize(await stopRecording(page)), replies: reply, errors };
      await context.close();
    }

    if (wanted('stream-at-tail')) {
      progress('stream at tail');
      const { context, page, cdp, errors } = await fresh('stream-at-tail');
      const cpuProfile = process.env.TRANSCRIPT_SCROLL_WEB_CPU_PROFILE === '1';
      if (cpuProfile) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
        await cdp.send('Profiler.start');
      }
      await startRecording(page, 0);
      for (let reply = 0; reply < 4 * options.scale; reply++) {
        await streamReply(broker.origin, id, `tail-${reply}`, 100 + reply, 60, 33);
      }
      report['stream-at-tail'] = { ...summarize(await stopRecording(page)), errors };
      if (cpuProfile) {
        const { profile } = await cdp.send('Profiler.stop') as {
          profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };
        };
        (report['stream-at-tail'] as Record<string, unknown>).cpuSelfTime = topSelfTime(profile);
        (report['stream-at-tail'] as Record<string, unknown>).wasmByCaller = wasmByCaller(profile);
        (report['stream-at-tail'] as Record<string, unknown>).cpuInclusive = inclusiveTime(profile, 120);
      }
      await context.close();
    }

    if (wanted('memory-stream')) {
      progress('memory stream');
      const { context, page, cdp, errors } = await fresh('memory-stream');
      const curve: Array<Record<string, number>> = [];
      const started = Date.now();
      curve.push({ second: 0, ...(await heap(cdp)) });
      let reply = 0;
      let next = 10_000;
      while (Date.now() - started < 90_000 * options.scale) {
        await streamReply(broker.origin, id, `memory-${reply}`, 200 + reply, 20, 33);
        reply += 1;
        if (Date.now() - started >= next) {
          curve.push({ second: Math.round((Date.now() - started) / 1000), ...(await heap(cdp)) });
          next += 10_000;
        }
      }
      curve.push({ second: Math.round((Date.now() - started) / 1000), ...(await heap(cdp)) });
      report['memory-stream'] = { heapCurve: curve, replies: reply, errors };
      await context.close();
    }
  } finally {
    alive.abort();
    await polling;
    await browser.close().catch(() => {});
    await stopBroker(broker);
    rmSync(root, { recursive: true, force: true });
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify({ transcript_scroll: report }, null, 2)}\n`);
  console.log(`wrote ${options.out}`);
  return 0;
}
