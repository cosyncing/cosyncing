/**
 * Executable component regression tests for the no-build web UI.
 *
 * This deliberately avoids a browser/package dependency. The app is still loaded from the real
 * `apps/poc-ui/public/app.js` file, but under a tiny DOM shim and the `__COSYNCING_TEST__` hook so we
 * can exercise the same render/state functions production uses. It catches behavior static string
 * checks cannot prove, such as the working->idle ready-to-review red dot.
 *
 *   bun run scripts/broker/tests/app/test-web-ui-components.ts
 */
export {};
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../../..');
const APP_SOURCE = readFileSync(join(ROOT, 'apps/poc-ui/public/app.js'), 'utf8');
const NOW = 1_800_000_000_000;

type SessionInfo = {
  id: string;
  lineageId?: string;
  tool: string;
  title?: string;
  cwd?: string;
  projectName?: string;
  status?: string;
  attachMode?: string;
  model?: string;
  updatedAt?: number;
  createdAt?: number;
  launchSurface?: 'app' | 'terminal' | 'ide' | 'unknown';
  currentModel?: unknown;
  currentAgent?: string;
  currentMode?: string;
  terminalSyncHint?: { label?: string; command?: string; note?: string };
  control?: {
    drive: { supported: boolean; state: string; reason?: string };
    terminalSync: {
      supported: boolean;
      syncAvailable?: boolean;
      active: boolean;
      input?: 'full' | 'answer-only';
      label?: string;
      command?: string;
      note?: string;
      reason?: string;
      action?: 'join' | 'handoff';
      presence?: 'shared' | 'private' | 'absent' | 'unknown';
      behind?: boolean;
    };
  };
};

type AppApi = {
  attach: (s: SessionInfo, mode?: string | null) => Promise<void>;
  initSettingsMenu: () => void;
  loadAgents: () => Promise<void>;
  loadRoster: () => Promise<void>;
  render: (m: Record<string, unknown>, live?: boolean) => void;
  renderRoster: (sessions?: SessionInfo[]) => void;
  setSessionWindow: (v: string) => void;
  requestBrokerRestart: () => Promise<void>;
  requestProjectRename: (project: { cwd?: string; name?: string; sessions?: SessionInfo[] }) => Promise<void>;
  requestSessionRename: (s?: SessionInfo | null) => Promise<void>;
  requestSessionFork: (s?: SessionInfo | null, messageId?: string) => Promise<void>;
  requestTranscriptExport: (s?: SessionInfo | null) => Promise<void>;
  resyncAfterReturn: () => void;
  runTransportDemo: () => Promise<void>;
  sessionKey: (s: SessionInfo) => string;
  setControlPreference: (v: string) => void;
  updateReviewNotices: (sessions: SessionInfo[]) => void;
  openNewSessionDialog: (context?: { directory?: string; projectName?: string }) => void;
  createNewSessionFromDialog: () => Promise<void>;
  openScheduleSheet: () => void;
  openScheduleEdit: (schedule: any) => void;
  confirmScheduleMessage: () => Promise<void>;
  refreshPendingSchedules: (generation?: number) => Promise<any[] | null>;
  renderSchedulesList: () => Promise<void>;
  setToolDisplayMode: (value: string, forceExpansion?: boolean) => void;
  getState: () => {
    activeBars: Map<string, unknown>;
    taskLists: Map<string, unknown>;
    current: SessionInfo | null;
    driving: boolean;
    lastRosterSessions: SessionInfo[];
    openProjects: Set<string>;
    reviewSessionKeys: Set<string>;
    rosterStatusBySession: Map<string, string>;
    pendingSchedules: Map<string, any>;
  };
};

type TestEnv = {
  api: AppApi;
  document: FakeDocument;
  setAgents: (next: unknown[]) => void;
  setCreatedSession: (next: SessionInfo) => void;
  setSessions: (next: SessionInfo[]) => void;
  rosterMock: { etag: string; next304: boolean; failNext: boolean; lastUrl: string; lastIfNoneMatch: string | null; fetchCount: number; gate: () => void; release: () => void };
  artifactFetches: string[];
  requests: Array<{ url: string; method: string; body?: string }>;
  sockets: FakeWebSocket[];
  schedulesMock: any[];
  scheduleMockControl: {
    conflictNextPatch: boolean;
    conflictSchedule: any | null;
    conflictNextDelete: boolean;
    conflictDeleteSchedule: any | null;
    failNextGet: boolean;
    holdNextGet: () => void;
    releaseGet: () => void;
    holdNextPatch: () => void;
    releasePatch: () => void;
    holdNextPost: () => void;
    releasePost: () => void;
  };
  el: (id: string) => FakeElement;
};

type Listener = (event: Record<string, unknown>) => void;

class FakeClassList {
  constructor(private readonly el: FakeElement) {}

  add(...names: string[]): void {
    const set = new Set(this.values());
    names.filter(Boolean).forEach((name) => set.add(name));
    this.el.className = [...set].join(' ');
  }

  remove(...names: string[]): void {
    const drop = new Set(names);
    this.el.className = this.values().filter((name) => !drop.has(name)).join(' ');
  }

  contains(name: string): boolean {
    return this.values().includes(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const shouldAdd = force ?? !has;
    if (shouldAdd) this.add(name);
    else this.remove(name);
    return shouldAdd;
  }

  private values(): string[] {
    return this.el.className.split(/\s+/).filter(Boolean);
  }
}

class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly attributes = new Map<string, string>();
  readonly classList: FakeClassList;
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  style: Record<string, string> & { cssText: string } = { cssText: '' };
  value = '';
  checked = false;
  disabled = false;
  type = '';
  title = '';
  placeholder = '';
  files: unknown[] = [];
  scrollTop = 0;
  scrollHeight = 120;
  clientHeight = 120;
  onclick: ((event: Record<string, unknown>) => void) | null = null;
  onchange: ((event: Record<string, unknown>) => void) | null = null;
  oninput: ((event: Record<string, unknown>) => void) | null = null;
  href = '';
  download = '';
  sandbox = '';
  src = '';
  alt = '';
  contentWindow: Record<string, unknown> | null = null;
  _matches?: unknown[];
  _sel?: number;
  private _id = '';
  private _className = '';
  private _text = '';

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.classList = new FakeClassList(this);
    if (this.tagName === 'IFRAME') this.contentWindow = { frame: this };
  }

  get id(): string {
    return this._id;
  }

  set id(value: string) {
    const next = String(value || '');
    if (this._id) this.ownerDocument.unregisterId(this._id, this);
    this._id = next;
    if (next) this.ownerDocument.registerId(next, this);
  }

  get className(): string {
    return this._className;
  }

  set className(value: string) {
    this._className = String(value || '').trim();
  }

  get textContent(): string {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string | null) {
    this._text = value == null ? '' : String(value);
    this.children = [];
  }

  get innerText(): string {
    return this.textContent;
  }

  set innerText(value: string) {
    this.textContent = value;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get innerHTML(): string {
    return this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(html: string) {
    for (const child of this.children) child.unregisterTree();
    this.children = [];
    this._text = '';
    parseHtmlInto(this, html || '');
  }

  setAttribute(name: string, value: string): void {
    const v = String(value);
    this.attributes.set(name, v);
    if (name === 'id') this.id = v;
    else if (name === 'class') this.className = v;
    else if (name === 'style') this.style.cssText = v;
    else if (name === 'value') this.value = v;
    else if (name === 'type') this.type = v;
    else if (name === 'title') this.title = v;
    else if (name === 'placeholder') this.placeholder = v;
    else if (name === 'href') this.href = v;
    else if (name === 'download') this.download = v;
    else if (name === 'src') this.src = v;
    else if (name === 'alt') this.alt = v;
    else if (name === 'sandbox') this.sandbox = v;
    else if (name === 'disabled') this.disabled = true;
    else if (name === 'checked') this.checked = true;
    else if (name.startsWith('data-')) this.dataset[dataNameToProp(name.slice(5))] = v;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === 'string') this._text += node;
      else this.appendChild(node);
    }
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  removeChild(child: FakeElement): void {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
  }

  before(...nodes: FakeElement[]): void {
    const parent = this.parentElement;
    if (!parent) return;
    for (const node of nodes) {
      node.parentElement?.removeChild(node);
      const idx = parent.children.indexOf(this);
      parent.children.splice(idx < 0 ? parent.children.length : idx, 0, node);
      node.parentElement = parent;
    }
  }

  remove(): void {
    this.parentElement?.removeChild(this);
    this.unregisterTree();
  }

  replaceWith(next: FakeElement): void {
    const parent = this.parentElement;
    if (!parent) return;
    const idx = parent.children.indexOf(this);
    if (idx < 0) return;
    this.unregisterTree();
    next.parentElement?.removeChild(next);
    parent.children[idx] = next;
    next.parentElement = parent;
    this.parentElement = null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of walk(this)) {
      if (matchesSelector(child, selector)) out.push(child);
    }
    return out;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((item) => item !== listener));
  }

  dispatchEvent(event: Record<string, unknown>): void {
    if (!event.target) event.target = this;
    for (const listener of this.listeners.get(String(event.type)) ?? []) listener(event);
  }

  click(): void {
    const event = eventFor(this, 'click');
    this.onclick?.(event);
    this.dispatchEvent(event);
  }

  focus(): void {}
  scrollIntoView(): void {}

  unregisterTree(): void {
    if (this._id) this.ownerDocument.unregisterId(this._id, this);
    for (const child of this.children) child.unregisterTree();
  }
}

class FakeDocument {
  readonly ids = new Map<string, FakeElement>();
  readonly listeners = new Map<string, Listener[]>();
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  hidden = false;
  title = 'cosyncing';

  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.append(this.body);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  getElementById(id: string): FakeElement | null {
    return this.ids.get(id) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === 'body') return this.body;
    if (selector === 'html') return this.documentElement;
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((item) => item !== listener));
  }

  registerId(id: string, el: FakeElement): void {
    this.ids.set(id, el);
  }

  unregisterId(id: string, el: FakeElement): void {
    if (this.ids.get(id) === el) this.ids.delete(id);
  }
}

class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
}

class FakeWebSocket {
  readyState = 1;
  onopen: ((event: Record<string, unknown>) => void) | null = null;
  onclose: ((event: Record<string, unknown>) => void) | null = null;
  onerror: ((event: Record<string, unknown>) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string, sockets: FakeWebSocket[]) {
    sockets.push(this);
    queueMicrotask(() => this.onopen?.(eventFor(null, 'open')));
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.(eventFor(null, 'close'));
  }
}

function parseHtmlInto(parent: FakeElement, html: string): void {
  const voidTags = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
  const stack: FakeElement[] = [parent];
  const re = /<\/?([A-Za-z][\w-]*)([^>]*)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const tag = match[1];
    const attrs = match[2] ?? '';
    const text = match[3];
    const current = stack[stack.length - 1];
    if (!current) break;
    if (text != null) {
      current.append(decodeEntities(text));
      continue;
    }
    if (!tag) continue;
    if (match[0].startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = parent.ownerDocument.createElement(tag);
    for (const [name, value] of parseAttrs(attrs)) el.setAttribute(name, decodeEntities(value));
    current.append(el);
    if (!voidTags.has(el.tagName) && !attrs.trim().endsWith('/')) stack.push(el);
  }
}

function parseAttrs(input: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    const name = match[1];
    if (!name) continue;
    out.push([name, match[2] ?? match[3] ?? match[4] ?? '']);
  }
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function* walk(root: FakeElement): Generator<FakeElement> {
  for (const child of root.children) {
    yield child;
    yield* walk(child);
  }
}

function matchesSelector(el: FakeElement, selector: string): boolean {
  return selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesComplexSelector(el, part));
}

function matchesComplexSelector(el: FakeElement, selector: string): boolean {
  const parts = selector.split(/\s+/).filter(Boolean);
  const last = parts.pop();
  if (!last || !matchesSimpleSelector(el, last)) return false;
  let parent = el.parentElement;
  for (let i = parts.length - 1; i >= 0; i--) {
    const want = parts[i];
    if (!want) return false;
    while (parent && !matchesSimpleSelector(parent, want)) parent = parent.parentElement;
    if (!parent) return false;
    parent = parent.parentElement;
  }
  return true;
}

function matchesSimpleSelector(el: FakeElement, selector: string): boolean {
  let rest = selector.trim();
  const attrMatches = [...rest.matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g)];
  rest = rest.replace(/\[[^\]]+\]/g, '');
  const id = rest.match(/#([A-Za-z0-9_-]+)/)?.[1];
  if (id && el.id !== id) return false;
  const tag = rest.match(/^[A-Za-z][\w-]*/)?.[0];
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  for (const cls of rest.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
    const name = cls[1];
    if (!name || !el.classList.contains(name)) return false;
  }
  for (const attr of attrMatches) {
    const name = attr[1];
    if (!name) return false;
    const expected = attr[2] ?? attr[3] ?? attr[4];
    const actual = name.startsWith('data-') ? el.dataset[dataNameToProp(name.slice(5))] : el.getAttribute(name);
    if (expected == null) {
      if (actual == null) return false;
    } else if (actual !== expected.replace(/^['"]|['"]$/g, '')) return false;
  }
  return true;
}

function dataNameToProp(name: string): string {
  return name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function eventFor(target: FakeElement | null, type: string): Record<string, unknown> {
  return {
    type,
    target,
    preventDefault() {},
    stopPropagation() {},
  };
}

function make(doc: FakeDocument, tag: string, id: string, parent: FakeElement = doc.body): FakeElement {
  const el = doc.createElement(tag);
  el.id = id;
  parent.append(el);
  return el;
}

function installDom(): FakeDocument {
  const doc = new FakeDocument();
  const roster = make(doc, 'aside', 'roster');
  const filter = make(doc, 'div', 'rosterFilter', roster);
  make(doc, 'input', 'sessionSearch', filter);
  make(doc, 'select', 'statusFilter', filter);
  make(doc, 'select', 'agentFilter', filter);
  make(doc, 'select', 'activityFilter', filter);
  make(doc, 'input', 'olderThanDays', filter);
  make(doc, 'div', 'rosterList', roster);

  for (const [tag, id] of [
    ['span', 'machine'],
    ['div', 'sessionMeta'],
    ['div', 'statusline'],
    ['span', 'statusActivity'],
    ['span', 'statusModel'],
    ['span', 'statusEffort'],
    ['span', 'statusAgent'],
    ['span', 'statusMode'],
    ['span', 'runtimeMeter'],
    ['span', 'tokmeter'],
    ['span', 'contextMeter'],
    ['div', 'synchint'],
    ['div', 'controlState'],
    ['div', 'sessionBars'],
    ['div', 'thread'],
    ['div', 'palette'],
    ['div', 'optmenu'],
    ['div', 'controls'],
    ['div', 'attachRow'],
    ['div', 'composer'],
    ['button', 'attach'],
    ['button', 'control'],
    ['button', 'stop'],
    ['button', 'send'],
    ['textarea', 'input'],
    ['span', 'conn'],
    ['button', 'back'],
    ['button', 'refresh'],
    ['button', 'newSession'],
    ['div', 'newSheet'],
    ['select', 'newAgent'],
    ['input', 'newDirectory'],
    ['div', 'newProjectContext'],
    ['input', 'newSessionTitle'],
    ['div', 'newHint'],
    ['button', 'newCreate'],
    ['button', 'newCancel'],
    ['button', 'settingsButton'],
    ['div', 'settingsMenu'],
    ['button', 'runtimeUpdateBadge'],
    ['div', 'runtimeUpdates'],
    ['div', 'runtimeUpdate-codex'],
    ['span', 'runtimeUpdateText-codex'],
    ['button', 'runtimeUpdateRestart-codex'],
    ['div', 'runtimeUpdate-opencode'],
    ['span', 'runtimeUpdateText-opencode'],
    ['button', 'runtimeUpdateRestart-opencode'],
    ['div', 'runtimeStatusList'],
    ['button', 'refreshRuntimeStatus'],
    ['select', 'codexUpdatePolicy'],
    ['div', 'managedRuntimeOwnershipNotice'],
    ['button', 'codexSyncToggle'],
    ['select', 'toolDisplayMode'],
    ['input', 'showOriginSubagent'],
    ['input', 'showOriginExec'],
    ['input', 'showOriginVscode'],
    ['select', 'themeSelect'],
    ['select', 'languageSelect'],
    ['input', 'tokdashUrl'],
    ['button', 'refreshTokdashUsage'],
    ['b', 'tokdashTokens'],
    ['b', 'tokdashCost'],
    ['b', 'tokdashRequests'],
    ['div', 'tokdashUsageStatus'],
    ['input', 'transportDemoMessage'],
    ['button', 'runTransportDemo'],
    ['textarea', 'transportContractJson'],
    ['div', 'transportDemoStatus'],
    ['button', 'restartEverything'],
    ['button', 'agentPick'],
    ['button', 'modelPick'],
    ['button', 'effortPick'],
    ['button', 'modePick'],
    ['input', 'fileInput'],
    ['div', 'toast'],
    ['button', 'scheduleBtn'],
    ['div', 'scheduleSheet'],
    ['h2', 'scheduleTitle'],
    ['div', 'scheduleTarget'],
    ['textarea', 'scheduleText'],
    ['input', 'scheduleAt'],
    ['button', 'scheduleCancel'],
    ['button', 'scheduleConfirm'],
    ['div', 'schedulesSheet'],
    ['div', 'schedulesList'],
    ['button', 'schedulesClose'],
    ['button', 'openSchedules'],
    ['select', 'newWhen'],
    ['div', 'newScheduleFields'],
    ['input', 'newAt'],
    ['textarea', 'newPrompt'],
  ] as const) {
    make(doc, tag, id);
  }

  doc.getElementById('themeSelect')!.value = 'dark';
  doc.getElementById('languageSelect')!.value = 'en';
  doc.getElementById('codexUpdatePolicy')!.value = 'when-detached';
  doc.getElementById('tokdashUrl')!.value = 'http://127.0.0.1:55423';
  doc.getElementById('transportDemoMessage')!.value = 'hello encrypted transport';
  doc.getElementById('toolDisplayMode')!.value = 'responsive';
  doc.getElementById('fileInput')!.files = [];
  doc.getElementById('newDirectory')!.placeholder = 'Empty = home, or relative to home';
  return doc;
}

function loadApp(): TestEnv {
  let sessions: SessionInfo[] = [];
  let agents: unknown[] = [];
  let createdSession: SessionInfo | null = null;
  let codexSyncEnabled = false;
  let codexUpdatePolicy = 'when-detached';
  let healthCalls = 0;
  const transportMailboxes = new Map<string, any[]>();
  const artifactFetches: string[] = [];
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const sockets: FakeWebSocket[] = [];
  const schedulesMock: any[] = [];
  const scheduleMockControl = {
    conflictNextPatch: false,
    conflictSchedule: null as any | null,
    conflictNextDelete: false,
    conflictDeleteSchedule: null as any | null,
    failNextGet: false,
    _gate: null as Promise<void> | null,
    _release: null as (() => void) | null,
    holdNextGet() { this._gate = new Promise<void>((resolve) => { this._release = resolve; }); },
    releaseGet() { const release = this._release; this._gate = null; this._release = null; release?.(); },
    _patchGate: null as Promise<void> | null,
    _patchRelease: null as (() => void) | null,
    holdNextPatch() { this._patchGate = new Promise<void>((resolve) => { this._patchRelease = resolve; }); },
    releasePatch() { const release = this._patchRelease; this._patchGate = null; this._patchRelease = null; release?.(); },
    _postGate: null as Promise<void> | null,
    _postRelease: null as (() => void) | null,
    holdNextPost() { this._postGate = new Promise<void>((resolve) => { this._postRelease = resolve; }); },
    releasePost() { const release = this._postRelease; this._postGate = null; this._postRelease = null; release?.(); },
  };
  // Roster fetch mock state: the real broker gzips + ETags /api/sessions, so loadRoster reads res.status
  // and res.headers.get('etag'). Tests drive the conditional-poll + window behavior through this.
  // gate()/release() hold a response body open (json() awaits the gate) so tests can exercise an
  // in-flight fetch; fetchCount counts how many /api/sessions requests actually reached the broker.
  const rosterMock = {
    etag: 'W/"roster-test"', next304: false, failNext: false, lastUrl: '', lastIfNoneMatch: null as string | null,
    fetchCount: 0,
    _gate: null as Promise<void> | null,
    _release: null as (() => void) | null,
    gate() { this._gate = new Promise<void>((res) => { this._release = res; }); },
    release() { const r = this._release; this._gate = null; this._release = null; r?.(); },
  };
  const windowListeners = new Map<string, Listener[]>();
  const document = installDom();

  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, 'addEventListener', {
    value: (type: string, listener: Listener) => {
      const list = windowListeners.get(type) ?? [];
      list.push(listener);
      windowListeners.set(type, list);
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'removeEventListener', {
    value: (type: string, listener: Listener) => {
      const list = windowListeners.get(type) ?? [];
      windowListeners.set(type, list.filter((item) => item !== listener));
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'dispatchEvent', {
    value: (event: Record<string, unknown>) => {
      for (const listener of windowListeners.get(String(event.type)) ?? []) listener(event);
      return true;
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', { value: new FakeStorage(), configurable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => undefined }, vibrate: () => true },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'location', { value: { protocol: 'http:', host: '127.0.0.1:7734' }, configurable: true });
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:test-artifact', configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true });
  Object.defineProperty(globalThis, 'matchMedia', {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    configurable: true,
  });
  Object.defineProperty(globalThis, 'Notification', {
    value: class FakeNotification { static permission = 'default'; constructor(_title: string, _opts?: unknown) {} },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'FileReader', {
    value: class FakeFileReader {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(_file: unknown): void {
        this.result = 'data:application/octet-stream;base64,';
        this.onload?.();
      }
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    value: class TestWebSocket extends FakeWebSocket {
      constructor(url: string) { super(url, sockets); }
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? init.body : undefined;
      requests.push({ url, method, body });
      if (url.includes('/artifact/')) {
        artifactFetches.push(url);
        return { ok: true, blob: async () => new Blob(['artifact'], { type: 'text/html' }) };
      }
      if (method === 'PATCH' && /\/api\/sessions\/[^/]+\/[^/]+\/rename$/.test(url)) {
        const parts = url.split('/');
        const id = decodeURIComponent(parts[parts.length - 2] || 's1');
        const tool = decodeURIComponent(parts[parts.length - 3] || 'opencode');
        const parsed = body ? JSON.parse(body) : {};
        const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null;
        return { ok: true, json: async () => ({ ok: true, title, session: session({ id, tool, title: title || 'Native title' }) }) };
      }
      if (method === 'POST' && /\/api\/sessions\/[^/]+\/[^/]+\/fork$/.test(url)) {
        const parts = url.split('/');
        const id = decodeURIComponent(parts[parts.length - 2] || 's1');
        const tool = decodeURIComponent(parts[parts.length - 3] || 'opencode');
        return { ok: true, json: async () => ({ ok: true, session: session({ id: `${id}-fork`, tool, title: 'Forked session' }) }) };
      }
      if (method === 'POST' && /\/api\/sessions\/[^/]+\/[^/]+\/export\/preflight$/.test(url)) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            nonce: 'nonce-abc.123.mac',
            expiresAt: NOW + 60_000,
            confirm: {
              action: 'transcriptExport',
              format: 'json',
              redactionMode: 'redacted-full',
              retentionMinutes: 30,
              message: 'Download the FULL transcript as a redacted JSON file. Stored for 30 minutes.',
            },
          }),
        };
      }
      if (method === 'POST' && /\/api\/sessions\/[^/]+\/[^/]+\/export$/.test(url)) {
        const parsed = body ? JSON.parse(body) : {};
        return {
          ok: true,
          json: async () => ({
            ok: true,
            nonceEcho: parsed.nonce,
            artifact: {
              type: 'file-artifact',
              path: 'My Session-transcript.json',
              name: 'My Session-transcript.json',
              mimeType: 'application/octet-stream',
              size: 2048,
              artifactKey: 'export-key-1',
              contentHash: 'hash1',
              deliveryClass: 'export-attachment',
              format: 'json',
              redactionSummary: 'redacted OPENAI_KEY:1, PATH_PREFIX:5',
              expiresAt: NOW + 1_800_000,
              fetchUrl: '/api/sessions/opencode/export-sess/artifact/export-key-1?expires=' + (NOW + 1_800_000) + '&sig=deadbeef',
            },
          }),
        };
      }
      if (method === 'PATCH' && url === '/api/projects/rename') {
        const parsed = body ? JSON.parse(body) : {};
        const projectName = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
        return { ok: true, json: async () => ({ ok: true, cwd: parsed.cwd, projectName }) };
      }
      if (method === 'POST' && /\/api\/sessions\/[^/]+$/.test(url)) {
        const tool = decodeURIComponent(url.split('/').pop() || 'opencode');
        return { json: async () => ({ session: createdSession ?? session({ id: 'new-session', tool, title: 'New session' }) }) };
      }
      if (method === 'POST' && url === '/api/broker/restart-all') {
        return { ok: true, json: async () => ({ ok: true, components: { codex: { ok: true }, opencode: { restartsWithBroker: true }, broker: { scheduled: true, dryRun: false } } }) };
      }
      if (url === '/api/agent-runtime-update-policy') {
        if (method === 'POST') {
          codexUpdatePolicy = JSON.parse(body || '{}').codexUpdatePolicy;
        }
        return { ok: true, json: async () => ({ ok: true, codexUpdatePolicy }) };
      }
      if (method === 'POST' && url === '/api/agent-runtime-updates/codex/restart') {
        return {
          ok: true,
          json: async () => ({ ok: true, update: { agent: 'codex', displayName: 'Codex', runtimeKind: 'daemon', managed: true, state: 'current', updateAvailable: false, autoRestartReady: false, installedVersion: '0.144.1', runningVersion: '0.144.1' } }),
        };
      }
      if (url === '/api/agent-runtime-updates' || url.startsWith('/api/agent-runtime-updates?')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            updates: [
              { agent: 'codex', displayName: 'Codex', runtimeKind: 'daemon', managed: true, state: 'pending', updateAvailable: true, autoRestartReady: false, installedVersion: '0.144.1', runningVersion: '0.142.5', blockers: 2, blockerComposition: { idle: 1, working: 0, needsInput: 0, unknown: 1 }, blockerDetails: [{ id: 'idle-thread', status: 'idle' }, { id: '019f51c9-be89-unknown', status: 'unknown', detail: 'thread/read timed out' }], checkedAt: Date.now() },
              { agent: 'configprobe', displayName: 'Config Probe', runtimeKind: 'daemon', managed: true, state: 'pending', updateAvailable: true, autoRestartReady: false, pendingChanges: ['configuration'], installedVersion: '0.144.1', runningVersion: '0.144.1', blockers: 1, blockerComposition: { idle: 0, working: 1, needsInput: 0, unknown: 0 }, blockerDetails: [{ id: 'working-thread', status: 'working' }], checkedAt: Date.now() },
              { agent: 'opencode', displayName: 'OpenCode', runtimeKind: 'serve', managed: true, state: 'current', updateAvailable: false, autoRestartReady: false, installedVersion: '1.16.2', runningVersion: '1.16.2', checkedAt: Date.now() },
              // Probe-failed shape: the provider OMITS `blockers` when the safety probe throws — must
              // render the failure detail, never "No attached blockers" (fail-closed honesty).
              { agent: 'fakeprobe', displayName: 'FakeProbe', runtimeKind: 'daemon', managed: true, state: 'pending', updateAvailable: true, autoRestartReady: false, installedVersion: '2.0.0', runningVersion: '1.0.0', detail: 'Loaded-thread safety probe failed: socket unavailable.', checkedAt: Date.now() },
            ],
          }),
        };
      }
      if (url.startsWith('/api/agents/codex/sync')) {
        if (method === 'POST') {
          const parsed = body ? JSON.parse(body) : {};
          const next = !!parsed.enabled;
          const restartRequired = next !== codexSyncEnabled;
          codexSyncEnabled = next;
          return { ok: true, json: async () => ({ ok: true, agent: 'codex', enabled: codexSyncEnabled, restartRequired }) };
        }
        return { ok: true, json: async () => ({ ok: true, agent: 'codex', enabled: codexSyncEnabled }) };
      }
      if (url.includes('/api/health')) {
        healthCalls++;
        if (healthCalls === 1) throw new Error('broker restarting');
        return { ok: true, json: async () => ({ ok: true, machine: 'test-machine', codexSyncServer: codexSyncEnabled }) };
      }
      if (url.startsWith('/api/tokdash/usage')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            endpoint: '/api/usage/summary',
            data: {
              today: {
                input_tokens: 12_300,
                output_tokens: 4_500,
                total_cost_usd: 0.42,
                requests: 7,
              },
            },
          }),
        };
      }
      if (url === '/api/transport/pairings' && method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            pairingId: 'pair-web-demo',
            qr: 'cosyncing://pair?payload=test-public-only',
            brokerPeerId: 'broker-web-demo',
            expiresAt: new Date(NOW + 60_000).toISOString(),
          }),
        };
      }
      if (url === '/api/transport/pairings/pair-web-demo/accept' && method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            peer: { peerId: 'web-demo-phone', identityPublicKey: 'phone-public-identity' },
            broker: { peerId: 'broker-web-demo', peerToken: 'broker-peer-token', identityPublicKey: 'broker-public-identity' },
            wrappedDataKey: { version: 1, algorithm: 'TEST-WRAP', ciphertext: 'wrapped' },
          }),
        };
      }
      if (url === '/api/transport/peers/web-demo-phone' && method === 'DELETE') {
        return { ok: true, json: async () => ({ ok: true, revoked: true }) };
      }
      if (url === '/api/transport/envelopes' && method === 'POST') {
        const headers = (init?.headers || {}) as Record<string, string>;
        const envelope = {
          id: headers['x-cosyncing-envelope-id'],
          channel: headers['x-cosyncing-channel'],
          from: headers['x-cosyncing-from'],
          to: headers['x-cosyncing-to'] || '',
          headers: {
            'x-cosyncing-wire-version': headers['x-cosyncing-wire-version'],
            'x-cosyncing-wire-kind': headers['x-cosyncing-wire-kind'],
          },
          bytes: Buffer.from(init?.body as ArrayBuffer).toString('base64url'),
        };
        const queue = transportMailboxes.get(envelope.to) ?? [];
        queue.push(envelope);
        transportMailboxes.set(envelope.to, queue);
        return { ok: true, json: async () => ({ ok: true, id: envelope.id, queued: queue.length }) };
      }
      if (url.startsWith('/api/transport/envelopes?') && method === 'GET') {
        const parsed = new URL(url, 'http://test');
        const peer = parsed.searchParams.get('peer') || '';
        const channel = parsed.searchParams.get('channel') || '';
        const queue = transportMailboxes.get(peer) ?? [];
        const envelopes = queue.filter((item) => !channel || item.channel === channel);
        transportMailboxes.delete(peer);
        return { ok: true, json: async () => ({ ok: true, envelopes }) };
      }
      if (url === '/api/schedules' && method === 'GET') {
        if (scheduleMockControl.failNextGet) {
          scheduleMockControl.failNextGet = false;
          return { ok: false, status: 503, json: async () => ({ ok: false, error: 'schedule service unavailable' }) };
        }
        const gate = scheduleMockControl._gate;
        const snapshot = schedulesMock.slice();
        return { ok: true, json: async () => { if (gate) await gate; return { ok: true, schedules: snapshot }; } };
      }
      if (url === '/api/schedules' && method === 'POST') {
        const parsed = body ? JSON.parse(body) : {};
        const record = { ...parsed, id: `sched-${schedulesMock.length + 1}`, revision: 1, state: 'scheduled', createdAt: NOW, updatedAt: NOW };
        const gate = scheduleMockControl._postGate;
        return { ok: true, json: async () => { if (gate) await gate; schedulesMock.push(record); return { ok: true, schedule: record }; } };
      }
      const schedDelete = url.match(/^\/api\/schedules\/([^/?]+)(?:\?.*)?$/);
      if (schedDelete && method === 'PATCH') {
        const idx = schedulesMock.findIndex((s) => s.id === decodeURIComponent(schedDelete[1]!));
        const parsed = body ? JSON.parse(body) : {};
        if (scheduleMockControl.conflictNextPatch) {
          scheduleMockControl.conflictNextPatch = false;
          const canonical = scheduleMockControl.conflictSchedule || (idx >= 0 ? { ...schedulesMock[idx], text: 'canonical from another client', revision: (schedulesMock[idx].revision || 1) + 1 } : null);
          if (canonical && idx >= 0) schedulesMock[idx] = canonical;
          return { ok: false, status: 409, json: async () => ({ ok: false, error: 'stale revision', schedule: canonical }) };
        }
        if (idx < 0) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) };
        const gate = scheduleMockControl._patchGate;
        return {
          ok: true,
          json: async () => {
            if (gate) await gate;
            const record = { ...schedulesMock[idx], text: parsed.text, at: parsed.at, revision: (schedulesMock[idx].revision || 1) + 1, updatedAt: NOW };
            schedulesMock[idx] = record;
            return { ok: true, schedule: record };
          },
        };
      }
      if (schedDelete && method === 'DELETE') {
        const idx = schedulesMock.findIndex((s) => s.id === decodeURIComponent(schedDelete[1]!));
        if (scheduleMockControl.conflictNextDelete) {
          scheduleMockControl.conflictNextDelete = false;
          const canonical = scheduleMockControl.conflictDeleteSchedule || (idx >= 0 ? { ...schedulesMock[idx], revision: (schedulesMock[idx].revision || 1) + 1, text: 'canonical cancellation conflict' } : null);
          if (canonical && idx >= 0) schedulesMock[idx] = canonical;
          return { ok: false, status: 409, json: async () => ({ ok: false, error: 'stale revision', schedule: canonical }) };
        }
        if (idx >= 0) {
          if (schedulesMock[idx].state === 'scheduled') schedulesMock[idx] = { ...schedulesMock[idx], state: 'canceled' };
          else schedulesMock.splice(idx, 1);
        }
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (url.includes('/api/sessions') && !url.includes('/stream')) {
        rosterMock.fetchCount += 1;
        rosterMock.lastUrl = url;
        rosterMock.lastIfNoneMatch = ((init?.headers || {}) as Record<string, string>)['if-none-match'] ?? null;
        if (rosterMock.failNext) { rosterMock.failNext = false; throw new Error('simulated transient roster fetch failure (timeout / hung socket)'); }
        const gate = rosterMock._gate; // captured at fetch time; json() below awaits it if armed
        const respHeaders = { get: (k: string) => (k.toLowerCase() === 'etag' ? rosterMock.etag : null) };
        if (rosterMock.next304) return { status: 304, headers: respHeaders, json: async () => { throw new Error('304 responses carry no body'); } };
        return { status: 200, headers: respHeaders, json: async () => { if (gate) await gate; return { machine: 'test-machine', sessions }; } };
      }
      if (url.includes('/api/agents')) return { json: async () => agents };
      throw new Error(`unexpected fetch: ${url}`);
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'setInterval', { value: () => 1, configurable: true });
  Object.defineProperty(globalThis, 'clearInterval', { value: () => undefined, configurable: true });
  Object.defineProperty(globalThis, 'setTimeout', {
    value: (fn: () => void) => {
      queueMicrotask(fn);
      return 1;
    },
    configurable: true,
  });
  Object.defineProperty(Date, 'now', { value: () => NOW, configurable: true });

  (globalThis as { __COSYNCING_TEST__?: boolean; __COSYNCING_APP__?: AppApi }).__COSYNCING_TEST__ = true;
  delete (globalThis as { __COSYNCING_APP__?: AppApi }).__COSYNCING_APP__;
  new Function(`${APP_SOURCE}\n//# sourceURL=cosyncing-app.js`)();
  const api = (globalThis as { __COSYNCING_APP__?: AppApi }).__COSYNCING_APP__;
  if (!api) throw new Error('app test API was not exposed');

  return {
    api,
    artifactFetches,
    document,
    setAgents: (next) => { agents = next; },
    setCreatedSession: (next) => { createdSession = next; },
    setSessions: (next) => { sessions = next; },
    rosterMock,
    requests,
    sockets,
    schedulesMock,
    scheduleMockControl,
    el: (id) => {
      const found = document.getElementById(id);
      if (!found) throw new Error(`missing fixture element #${id}`);
      return found;
    },
  };
}

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    tool: 'opencode',
    title: 'Build UI',
    cwd: '/workspace/project-a',
    status: 'idle',
    model: 'qwen',
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    control: {
      drive: { supported: true, state: 'observing' },
      terminalSync: { supported: true, active: false, label: 'Sync with terminal', command: 'cosyncing sync opencode s1' },
    },
    ...overrides,
  };
}

function claudeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return session({
    id: 'claude-s1',
    tool: 'claude',
    title: 'Claude session',
    cwd: '/workspace/claude-project',
    model: 'Claude Opus',
    control: {
      drive: {
        supported: true,
        state: 'observing',
        reason: 'Driving resumes this session via claude -p --resume on your Claude subscription.',
      },
      terminalSync: {
        supported: false,
        active: false,
        reason: 'True sync needs a first-party Anthropic subscription session — use Observe + Drive here.',
      },
    },
    ...overrides,
  });
}

function text(el: FakeElement | null): string {
  return (el?.textContent ?? '').trim();
}

function visible(el: FakeElement): boolean {
  return el.style.display !== 'none';
}

function assert(ok: unknown, detail: string): asserts ok {
  if (!ok) throw new Error(detail);
}

async function flushMicrotasks(count = 4): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

async function seedReviewNotice(env: TestEnv): Promise<SessionInfo> {
  const working = session({ status: 'working' });
  env.setSessions([working]);
  await env.api.loadRoster();
  const idle = session({ status: 'idle', updatedAt: NOW });
  env.setSessions([idle]);
  await env.api.loadRoster();
  return idle;
}

const results: { name: string; ok: boolean; detail: string }[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true, detail: '' });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.error(`FAIL  ${name}  — ${detail}`);
  }
}

await test('review dot appears on working-to-idle and propagates to a closed project', async () => {
  const env = loadApp();
  const working = session({ status: 'working' });
  env.setSessions([working]);
  await env.api.loadRoster();
  assert(env.api.getState().reviewSessionKeys.size === 0, 'working sessions should not start with review notices');
  assert(!env.document.querySelector('.review-ready'), 'no review-ready class should render before the transition');

  const idle = session({ status: 'idle', updatedAt: NOW });
  env.setSessions([idle]);
  await env.api.loadRoster();

  assert(env.api.getState().reviewSessionKeys.has(env.api.sessionKey(idle)), 'working->idle should add the review key');
  assert(env.document.querySelector('.projectHead.review-ready'), 'closed project header should carry the review-ready class');
  assert(!env.document.querySelector('.srow'), 'projects default closed, so no session row should be visible yet');
});

await test('expanded projects show the red dot on the idle session row', async () => {
  const env = loadApp();
  const idle = await seedReviewNotice(env);
  env.document.querySelector('.projectHead')?.click();
  const row = env.document.querySelector('.srow.review-ready');
  assert(row, 'expanded reviewed session row should carry review-ready');
  assert(row.querySelector('.reviewDot'), 'expanded reviewed session row should include the dot element');
  assert(env.api.getState().reviewSessionKeys.has(env.api.sessionKey(idle)), 'expanding should not clear the notice');
});

await test('opening a reviewed session clears both project and row notice state', async () => {
  const env = loadApp();
  const idle = await seedReviewNotice(env);
  env.document.querySelector('.projectHead')?.click();
  env.document.querySelector('.srow.review-ready')?.click();
  await flushMicrotasks(12);

  assert(!env.api.getState().reviewSessionKeys.has(env.api.sessionKey(idle)), 'attach should delete the review key');
  assert(!env.document.querySelector('.review-ready'), 'rendered review-ready classes should be gone after open');
  assert(env.sockets[0]?.url.includes('/api/sessions/opencode/s1/stream'), 'opening the row should attach to the session stream');
});

await test('the currently open session does not notify itself when it becomes idle', async () => {
  const env = loadApp();
  const working = session({ status: 'working' });
  env.setSessions([working]);
  await env.api.loadRoster();
  await env.api.attach(working);

  env.setSessions([session({ status: 'idle', updatedAt: NOW })]);
  await env.api.loadRoster();

  assert(env.api.getState().reviewSessionKeys.size === 0, 'open session should not receive a ready-to-review dot');
  assert(!env.document.querySelector('.review-ready'), 'open session should not render a review-ready class');
});

await test('review notices clear when a session resumes work or disappears', async () => {
  const env = loadApp();
  const idle = await seedReviewNotice(env);
  assert(env.api.getState().reviewSessionKeys.has(env.api.sessionKey(idle)), 'test setup should create a review key');

  env.setSessions([session({ status: 'working', updatedAt: NOW + 1 })]);
  await env.api.loadRoster();
  assert(env.api.getState().reviewSessionKeys.size === 0, 'non-idle status should clear stale review notices');

  const idleAgain = await seedReviewNotice(env);
  assert(env.api.getState().reviewSessionKeys.has(env.api.sessionKey(idleAgain)), 'second setup should create a review key');
  env.setSessions([]);
  await env.api.loadRoster();
  assert(env.api.getState().reviewSessionKeys.size === 0, 'missing sessions should remove stale review notices');
});

await test('project roster ranks propagated status before latest activity', async () => {
  const env = loadApp();
  env.setSessions([
    session({ id: 'idle-new', title: 'Idle new', cwd: '/workspace/idle-new', status: 'idle', updatedAt: NOW }),
    session({ id: 'work-old', title: 'Working old', cwd: '/workspace/work-old', status: 'working', updatedAt: NOW - 90_000 }),
    session({ id: 'need-old', title: 'Need old', cwd: '/workspace/need-old', status: 'needs-input', updatedAt: NOW - 120_000 }),
    session({ id: 'idle-old', title: 'Idle old', cwd: '/workspace/idle-old', status: 'idle', updatedAt: NOW - 240_000 }),
  ]);
  await env.api.loadRoster();

  const names = env.document.querySelectorAll('.projectName').map((el) => text(el));
  assert(names.join('|') === 'need-old|work-old|idle-new|idle-old', `unexpected project order: ${names.join('|')}`);
});

await test('roster filters update rendered projects without losing review state', async () => {
  const env = loadApp();
  const idle = await seedReviewNotice(env);
  env.setSessions([
    idle,
    session({ id: 's2', tool: 'codex', title: 'Other', cwd: '/workspace/other', status: 'working', updatedAt: NOW }),
  ]);
  await env.api.loadRoster();

  env.el('statusFilter').value = 'working';
  env.api.renderRoster();
  assert(text(env.document.querySelector('.projectName')) === 'other', 'status filter should show only the working project');
  assert(env.api.getState().reviewSessionKeys.has(env.api.sessionKey(idle)), 'filtering should not erase review state for hidden sessions');

  env.el('statusFilter').value = '';
  env.api.renderRoster();
  assert(env.document.querySelector('.projectHead.review-ready'), 'clearing the filter should restore the project review dot');
});

await test('roster poll is conditional: 200 renders + stores the ETag, next poll echoes If-None-Match', async () => {
  const env = loadApp();
  env.setSessions([session({ id: 's-cond', status: 'idle', updatedAt: NOW })]);
  await env.api.loadRoster();
  assert(env.rosterMock.lastIfNoneMatch === null, 'first load must not send If-None-Match (no prior ETag)');
  assert(env.document.querySelector('.project'), 'a 200 roster response renders the project list');
  await env.api.loadRoster();
  assert(env.rosterMock.lastIfNoneMatch === env.rosterMock.etag, 'the next poll echoes the stored ETag as If-None-Match');
});

await test('a 304 roster response keeps the current roster and does not re-render from an empty body', async () => {
  const env = loadApp();
  env.setSessions([session({ id: 's-304', status: 'idle', updatedAt: NOW })]);
  await env.api.loadRoster();
  const before = env.document.querySelectorAll('.project').length;
  assert(before > 0, 'roster rendered on the initial 200');
  env.rosterMock.next304 = true; // broker: unchanged since last poll
  env.setSessions([]); // if the app wrongly re-rendered off the (absent) 304 body, the roster would clear
  await env.api.loadRoster();
  assert(env.document.querySelectorAll('.project').length === before, 'a 304 must not re-render or clear the roster');
});

await test('a transient fetch error after a successful render keeps the roster (no offline flash)', async () => {
  const env = loadApp();
  env.setSessions([session({ id: 's-fail', status: 'idle', updatedAt: NOW })]);
  await env.api.loadRoster();                        // fetch #1 → 200, renders the project list
  const before = env.document.querySelectorAll('.project').length;
  assert(before > 0, 'roster rendered on the initial 200');
  const fetchesBefore = env.rosterMock.fetchCount;
  env.rosterMock.failNext = true;                    // next poll's fetch rejects (timeout / hung socket)
  await env.api.loadRoster();
  assert(env.rosterMock.fetchCount === fetchesBefore + 1, 'the failing poll actually issued a fetch');
  assert(env.document.querySelectorAll('.project').length === before, 'a transient poll error keeps the already-rendered roster instead of flashing to the cached/unreachable view');
});

await test('the per-device session-history window is sent to the broker as ?window=', async () => {
  const env = loadApp();
  env.setSessions([session()]);
  await env.api.loadRoster();
  assert(!env.rosterMock.lastUrl.includes('window='), 'the default window (all) sends no ?window= param');
  env.api.setSessionWindow('7d');
  await flushMicrotasks();
  assert(env.rosterMock.lastUrl.includes('window=7d'), 'selecting a window refetches the roster with ?window=7d');
});

await test('an overlapping timer poll is dropped (not queued) while a roster fetch is in flight', async () => {
  const env = loadApp();
  const fetches = () => env.rosterMock.fetchCount; // via a call so each read stays `number` (no literal-narrowing)
  env.setSessions([session({ id: 's-drop', status: 'idle', updatedAt: NOW })]);
  env.rosterMock.gate();                   // hold the first response body open
  const inflight = env.api.loadRoster();   // fetch #1, awaiting the gated body
  await flushMicrotasks();
  assert(fetches() === 1, 'the first poll issued exactly one fetch');
  await env.api.loadRoster();              // overlaps the in-flight one → must be dropped
  assert(fetches() === 1, 'an overlapping unforced poll issues no second fetch');
  env.rosterMock.release();
  await inflight;
  await flushMicrotasks(6);
  assert(fetches() === 1, 'a dropped overlap does not queue a follow-up fetch (no hot loop)');
});

await test('a window change during res.json() discards the stale response and triggers exactly one follow-up', async () => {
  const env = loadApp();
  const fetches = () => env.rosterMock.fetchCount;
  env.setSessions([session({ id: 'stale-all', title: 'STALE ALL WINDOW', status: 'idle', updatedAt: NOW })]);
  env.rosterMock.etag = 'W/"all"';
  env.rosterMock.gate();                   // the all-window response body hangs mid-flight
  const inflight = env.api.loadRoster();   // fetch #1 (all window)
  await flushMicrotasks();
  assert(fetches() === 1, 'the all-window fetch is in flight');
  env.rosterMock.next304 = true;           // make the follow-up a 304 so ONLY a stale render could add a project
  env.api.setSessionWindow('7d');          // forced refresh while #1's body streams → queued, not immediate
  assert(fetches() === 1, 'the window change does not fetch immediately (queued behind the in-flight poll)');
  env.rosterMock.release();                // #1 resolves; its window (all) != current (7d) → must be discarded
  await inflight;
  await flushMicrotasks(6);                // let the single pending reload run
  assert(fetches() === 2, 'exactly one follow-up fetch after the discarded stale response');
  assert(env.rosterMock.lastUrl.includes('window=7d'), 'the follow-up uses the new 7d window');
  assert(!env.document.querySelector('.project'), 'the stale all-window roster was discarded, never rendered');
});

await test('session rename updates current header and local roster state', async () => {
  const env = loadApp();
  const s = session({ id: 'rename-me', title: 'Native title' });
  env.setSessions([s]);
  await env.api.loadRoster();
  await env.api.attach(s);

  const pending = env.api.requestSessionRename(s);
  await flushMicrotasks(4);
  const field = env.document.querySelector('.modal .minput');
  assert(field, 'rename session dialog should render an input');
  field.value = 'Readable session name';
  env.document.querySelector('.modal .mok')?.click();
  await pending;
  await flushMicrotasks(8);

  const req = env.requests.find((r) => r.method === 'PATCH' && r.url.endsWith('/api/sessions/opencode/rename-me/rename'));
  assert(req, 'session rename should PATCH the broker rename endpoint');
  assert(JSON.parse(req.body || '{}').title === 'Readable session name', 'session rename should send the requested title');
  assert(env.api.getState().current?.title === 'Readable session name', 'current session title should update');
  assert(text(env.document.querySelector('#sessionMeta .sessionTitle')) === 'Readable session name', 'session header should show the renamed title');
  assert(env.api.getState().lastRosterSessions.find((row) => row.id === 'rename-me')?.title === 'Readable session name', 'roster copy should update without waiting for poll');
});

await test('a pushed session frame without updatedAt must not re-sort the roster row (issues-part2: row "disappears" then reappears)', async () => {
  const env = loadApp();
  const rows = [
    session({ id: 'flick-new', tool: 'pi', title: 'Newest', cwd: '/home/tester', status: 'idle', updatedAt: NOW }),
    session({ id: 'flick-mid', tool: 'pi', title: 'Renamed pi session', cwd: '/home/tester', status: 'idle', updatedAt: NOW - 1000 }),
    session({ id: 'flick-old', tool: 'pi', title: 'Oldest', cwd: '/home/tester', status: 'idle', updatedAt: NOW - 2000 }),
  ];
  env.setSessions(rows);
  await env.api.loadRoster();
  env.document.querySelector('.projectHead')?.click(); // expand the project so rows render
  const order = () => env.document.querySelectorAll('#rosterList .srow .title').map((el) => text(el)).join('|');
  assert(order() === 'Newest|Renamed pi session|Oldest', `pre-attach order: ${order()}`);

  await env.api.attach(rows[1]!);
  await flushMicrotasks(8);
  // The attach-time session frame carries live control state but NO recency metadata — the exact
  // shape adapters push. Before the fix the merge dropped updatedAt (→ 0), sinking the clicked row
  // to the BOTTOM of its group until the next 6s poll restored it, then sinking again on the next
  // frame — maintainer's "session disappears in the left panel for a bit, then reappears" oscillation.
  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'session',
      info: {
        id: 'flick-mid',
        tool: 'pi',
        title: 'Renamed pi session',
        cwd: '/home/tester',
        status: 'idle',
        attachMode: 'observe',
        control: { drive: { supported: true, state: 'observing' }, terminalSync: { supported: false, syncAvailable: false, active: false } },
      },
    }),
  });
  await flushMicrotasks(8);
  assert(order() === 'Newest|Renamed pi session|Oldest', `pushed frame re-sorted the roster: ${order()}`);
  const copy = env.api.getState().lastRosterSessions.find((s) => s.id === 'flick-mid');
  assert(copy?.updatedAt === NOW - 1000, 'roster copy must keep its recency metadata when the frame omits it');
});

await test('fork is a command-surface action, never a session-meta button (maintainer §4.6)', async () => {
  const env = loadApp();
  env.setAgents([
    { id: 'opencode', displayName: 'OpenCode', canCreateSession: true, canFork: true, capabilities: { supportsLiveAttach: true, attachModes: ['live'] } },
    { id: 'codex', displayName: 'Codex', canCreateSession: true, canFork: false, capabilities: { supportsResume: true, attachModes: ['observe', 'resume'] } },
  ]);
  await env.api.loadAgents();

  // Even a fork-capable agent (canFork:true) must NOT render a ⎇ button: the fork button shipped in
  // Slice 4/5 was removed. Fork stays reachable via the retained requestSessionFork hook / /fork route.
  const forkable = session({ id: 'forkable', tool: 'opencode', title: 'Forkable' });
  env.setSessions([forkable]);
  await env.api.loadRoster();
  await env.api.attach(forkable);
  assert(!env.document.querySelector('#sessionMeta .fork'), 'fork-capable sessions must not render a fork button');
  assert(!text(env.document.querySelector('#sessionMeta')).includes('⎇'), 'session meta must not carry the fork glyph');

  const notForkable = session({ id: 'not-forkable', tool: 'codex', title: 'No fork' });
  env.setSessions([notForkable]);
  await env.api.loadRoster();
  await env.api.attach(notForkable);
  assert(!env.document.querySelector('#sessionMeta .fork'), 'non-fork agents must not render a fork button either');
});

await test('session fork posts generic endpoint and opens returned child session', async () => {
  const env = loadApp();
  env.setAgents([
    { id: 'opencode', displayName: 'OpenCode', canCreateSession: true, canFork: true, capabilities: { supportsLiveAttach: true, attachModes: ['live'] } },
  ]);
  await env.api.loadAgents();
  const s = session({ id: 'fork-me', title: 'Parent session' });
  env.setSessions([s]);
  await env.api.loadRoster();
  await env.api.attach(s);

  await env.api.requestSessionFork(s, 'msg-1');
  await flushMicrotasks(8);

  const req = env.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/sessions/opencode/fork-me/fork'));
  assert(req, 'session fork should POST the broker fork endpoint');
  assert(JSON.parse(req.body || '{}').messageId === 'msg-1', 'session fork should send selected message id when supplied');
  assert(env.api.getState().current?.id === 'fork-me-fork', 'fork should attach the returned child session');
  assert(env.api.getState().lastRosterSessions.some((row) => row.id === 'fork-me-fork'), 'forked child should enter local roster state');
});

await test('transcript export is a command that confirms, executes with the nonce, and renders a download-only card', async () => {
  const env = loadApp();
  env.setAgents([
    { id: 'opencode', displayName: 'OpenCode', canCreateSession: true, canTranscriptExport: true, capabilities: { supportsLiveAttach: true, attachModes: ['live'] } },
  ]);
  await env.api.loadAgents();
  const s = session({ id: 'export-sess', title: 'My Session' });
  env.setSessions([s]);
  await env.api.loadRoster();
  await env.api.attach(s);

  const pending = env.api.requestTranscriptExport(s);
  await flushMicrotasks(6);
  // A confirm dialog (not a prompt with a text input) must appear stating the redaction/retention terms.
  const dialog = env.document.querySelector('.modal');
  assert(dialog, 'export should raise a confirmation dialog');
  assert(text(dialog).includes('redacted') && text(dialog).includes('30 minutes'), 'confirm copy should state redaction + retention');
  env.document.querySelector('.modal .mok')?.click();
  await pending;
  await flushMicrotasks(8);

  const pre = env.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/sessions/opencode/export-sess/export/preflight'));
  const exec = env.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/sessions/opencode/export-sess/export'));
  assert(pre, 'export should preflight for a confirmation nonce');
  assert(exec, 'export should execute after confirmation');
  assert(JSON.parse(exec.body || '{}').nonce === 'nonce-abc.123.mac', 'execute must carry the server-issued nonce');

  const card = env.document.querySelector('.artifact');
  assert(card, 'a file-artifact card should render for the export');
  assert(text(card).includes('My Session-transcript.json'), 'card should show the export filename');
  // Export-attachment (octet-stream) must be download-only: no inline iframe/preview of exported content.
  assert(!env.document.querySelector('.artifact iframe'), 'exported content must never be inline-rendered in an iframe');
  assert(!text(card).includes('<script>'), 'no exported markup should be injected into the card');
});

await test('transcript export is gated by canTranscriptExport (no hook, no export)', async () => {
  const env = loadApp();
  env.setAgents([
    { id: 'codex', displayName: 'Codex', canCreateSession: true, canTranscriptExport: false, capabilities: { supportsResume: true, attachModes: ['observe', 'resume'] } },
  ]);
  await env.api.loadAgents();
  const s = session({ id: 'no-export', tool: 'codex', title: 'No export' });
  env.setSessions([s]);
  await env.api.loadRoster();
  await env.api.attach(s);
  await env.api.requestTranscriptExport(s);
  await flushMicrotasks(6);
  assert(!env.requests.some((r) => r.url.includes('/export')), 'agents without canTranscriptExport must not hit the export route');
});

await test('project rename aliases the project group without changing cwd', async () => {
  const env = loadApp();
  env.setSessions([
    session({ id: 's1', title: 'One', cwd: '/workspace/project-a' }),
    session({ id: 's2', title: 'Two', cwd: '/workspace/project-a' }),
  ]);
  await env.api.loadRoster();

  const pending = env.api.requestProjectRename({ cwd: '/workspace/project-a', name: 'project-a' });
  await flushMicrotasks(4);
  const field = env.document.querySelector('.modal .minput');
  assert(field, 'rename project dialog should render an input');
  field.value = 'Client dashboard';
  env.document.querySelector('.modal .mok')?.click();
  await pending;
  await flushMicrotasks(8);

  const req = env.requests.find((r) => r.method === 'PATCH' && r.url === '/api/projects/rename');
  assert(req, 'project rename should PATCH the broker project endpoint');
  const body = JSON.parse(req.body || '{}');
  assert(body.cwd === '/workspace/project-a' && body.name === 'Client dashboard', 'project rename should send cwd + display name');
  assert(text(env.document.querySelector('.projectName')) === 'Client dashboard', 'project group should render the alias');
  assert(env.api.getState().lastRosterSessions.every((row) => row.cwd !== '/workspace/project-a' || row.projectName === 'Client dashboard'), 'every matching session row should carry the project alias');
});

await test('new session dialog does not inherit the current cwd and lists creatable agents', async () => {
  const env = loadApp();
  await env.api.attach(session({ cwd: '/workspace/current-project' }));
  env.setAgents([
    { id: 'opencode', displayName: 'OpenCode', canCreateSession: true, capabilities: { supportsLiveAttach: true, attachModes: ['live'] } },
    { id: 'codex', displayName: 'Codex', canCreateSession: true, capabilities: { supportsResume: true, attachModes: ['observe', 'resume'] } },
    { id: 'pi', displayName: 'Pi', canCreateSession: true, capabilities: { supportsResume: true, attachModes: ['observe', 'resume'] } },
    { id: 'claude', displayName: 'Claude Code', canCreateSession: true, capabilities: { supportsResume: true, attachModes: ['observe', 'resume'] } },
    { id: 'kimi', displayName: 'Kimi', canCreateSession: false, capabilities: { supportsResume: false, attachModes: ['observe'] } },
  ]);

  env.el('newSession').click();
  await flushMicrotasks(12);

  assert(env.el('newDirectory').value === '', 'new sessions should not default to the currently attached cwd');
  assert(env.el('newDirectory').placeholder.includes('home'), 'directory placeholder should explain home-root default');
  assert(env.el('newHint').textContent.includes('home'), 'dialog hint should explain empty/relative directory semantics');
  const optionText = env.document.querySelectorAll('#newAgent option').map((el) => text(el)).join(',');
  assert(['OpenCode', 'Codex', 'Pi', 'Claude Code'].every((name) => optionText.includes(name)), 'all creatable agents should be listed');
  assert(!optionText.includes('Kimi'), 'non-creatable agents should stay hidden rather than broken');
});

await test('project-scoped New session prefills the real project cwd and keeps it editable', async () => {
  const env = loadApp();
  env.setSessions([
    session({ id: 'project-new-1', title: 'One', cwd: '/workspace/project-a', projectName: 'Client dashboard' }),
    session({ id: 'project-new-2', title: 'Two', cwd: '/workspace/project-a', projectName: 'Client dashboard' }),
  ]);
  env.setAgents([
    { id: 'opencode', displayName: 'OpenCode', canCreateSession: true, capabilities: { supportsLiveAttach: true, attachModes: ['live'] } },
  ]);
  await env.api.loadRoster();

  const action = env.document.querySelector('.projectNew');
  assert(action, 'each directory-backed project should expose a scoped New-session action');
  assert(action!.getAttribute('aria-label') === 'New session in Client dashboard', 'the action names the display alias accessibly');
  action!.click();
  await flushMicrotasks(12);

  assert(env.el('newDirectory').value === '/workspace/project-a', 'project-scoped New must prefill the project actual cwd, not its display alias');
  assert(text(env.el('newProjectContext')).includes('Client dashboard') && text(env.el('newProjectContext')).includes('/workspace/project-a'), 'the dialog identifies both project label and real directory');
  assert(text(env.el('newHint')).includes('editable'), 'the dialog must state that the prefilled directory remains editable');

  env.el('newDirectory').value = '/workspace/project-a/scratch';
  await env.api.createNewSessionFromDialog();
  const post = env.requests.find((r) => r.method === 'POST' && r.url === '/api/sessions/opencode');
  assert(post, 'project-scoped New should use the ordinary create-session endpoint');
  assert(JSON.parse(post!.body || '{}').directory === '/workspace/project-a/scratch', 'the edited directory, not stale project context, must be submitted');

  const scheduled = loadApp();
  scheduled.setAgents([
    { id: 'opencode', displayName: 'OpenCode', canCreateSession: true, capabilities: { supportsLiveAttach: true, attachModes: ['live'] } },
  ]);
  await scheduled.api.loadAgents();
  scheduled.api.openNewSessionDialog({ directory: '/workspace/project-a', projectName: 'Client dashboard' });
  scheduled.el('newWhen').value = 'once';
  scheduled.el('newWhen').onchange?.({});
  scheduled.el('newAt').value = '2027-02-01T08:00';
  scheduled.el('newPrompt').value = 'start the project review';
  await scheduled.api.createNewSessionFromDialog();
  const scheduledPost = scheduled.requests.find((r) => r.method === 'POST' && r.url === '/api/schedules');
  assert(scheduledPost, 'project-scoped New should also use the ordinary scheduled-session endpoint');
  assert(JSON.parse(scheduledPost!.body || '{}').directory === '/workspace/project-a', 'the project cwd must flow into scheduled creation too');
});

await test('new drivable sessions attach in Drive mode while already-owned sessions attach normally', async () => {
  const driveNeeded = loadApp();
  driveNeeded.setAgents([
    { id: 'codex', displayName: 'Codex', canCreateSession: true, capabilities: { supportsResume: true, attachModes: ['observe', 'resume'] } },
  ]);
  driveNeeded.setCreatedSession(session({
    id: 'codex-created',
    tool: 'codex',
    title: 'New Codex',
    cwd: '/home/tester',
    control: {
      drive: { supported: true, state: 'observing' },
      terminalSync: { supported: false, active: false },
    },
  }));
  driveNeeded.el('newSession').click();
  await flushMicrotasks(12);
  driveNeeded.el('newCreate').click();
  await flushMicrotasks(16);
  const post = driveNeeded.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/sessions/codex'));
  assert(post, 'new session should POST to the selected tool');
  assert(!('directory' in JSON.parse(post.body || '{}')), 'empty directory should be omitted so the broker applies the home default');
  assert(driveNeeded.sockets[0]?.url.includes('mode=resume'), 'created drivable-but-observed sessions should attach with mode=resume');

  const alreadyOwned = loadApp();
  alreadyOwned.setAgents([
    { id: 'opencode', displayName: 'OpenCode', canCreateSession: true, capabilities: { supportsLiveAttach: true, attachModes: ['live'] } },
  ]);
  alreadyOwned.setCreatedSession(session({
    id: 'opencode-created',
    tool: 'opencode',
    title: 'New OpenCode',
    cwd: '/home/tester',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, active: false },
    },
  }));
  alreadyOwned.el('newSession').click();
  await flushMicrotasks(12);
  alreadyOwned.el('newCreate').click();
  await flushMicrotasks(16);
  assert(alreadyOwned.sockets[0] && !alreadyOwned.sockets[0].url.includes('mode=resume'), 'already-driving created sessions should not force a resume takeover');
});

await test('attaching a session shows a transcript loading state until history arrives', async () => {
  const env = loadApp();
  const s = session({ id: 'loading-session', title: 'Loading target' });
  await env.api.attach(s);

  const loading = env.document.getElementById('sessionLoading');
  assert(loading, 'attach should immediately show a transcript loading indicator');
  assert(loading.textContent.includes('Opening session') && loading.textContent.includes('Loading target'), 'loading state should identify the selected session');

  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'history',
      reset: true,
      cursor: 'cursor-1',
      messages: [{ type: 'model-output', key: 'm1', text: 'History ready' }],
    }),
  });

  assert(!env.document.getElementById('sessionLoading'), 'history should clear the transcript loading indicator');
  assert(env.el('thread').textContent.includes('History ready'), 'history should render after loading clears');
});

await test('settings Restart everything action warns and posts the global recovery endpoint', async () => {
  const env = loadApp();
  env.api.initSettingsMenu();

  env.el('restartEverything').click();
  await flushMicrotasks(4);
  const modal = env.document.querySelector('.modal');
  assert(modal, 'restart button should open a confirmation modal');
  assert(modal.textContent.includes('Restart everything?'), 'global recovery should use the explicit Restart everything title');
  assert(modal.textContent.toLowerCase().includes('active turns') && modal.textContent.includes('must be resumed'), 'global recovery must warn about interrupted work and Codex resume');

  modal.querySelector('.mok')?.click();
  await flushMicrotasks(24);

  const req = env.requests.find((r) => r.method === 'POST' && r.url === '/api/broker/restart-all');
  assert(req, 'confirmed global recovery should POST the Restart everything endpoint');
  assert(JSON.parse(req.body || '{}').confirmRestart === true, 'Restart everything should require explicit confirmation');
});

await test('settings usage panel refreshes Tokdash usage through the broker proxy', async () => {
  const env = loadApp();
  env.api.initSettingsMenu();

  assert(env.el('tokdashUrl').value === 'http://127.0.0.1:55423', 'Tokdash URL should default to the local API port');
  env.el('refreshTokdashUsage').click();
  await flushMicrotasks(8);

  const req = env.requests.find((r) => r.method === 'GET' && r.url.startsWith('/api/tokdash/usage'));
  assert(req, 'usage refresh should call the broker Tokdash proxy');
  assert(req.url.includes(encodeURIComponent('http://127.0.0.1:55423')), 'usage request should carry the configured Tokdash base URL');
  assert(text(env.el('tokdashTokens')).includes('17k'), 'usage panel should show total input+output tokens');
  assert(text(env.el('tokdashCost')).includes('$0.4200'), 'usage panel should show cost from Tokdash');
  assert(text(env.el('tokdashRequests')) === '7', 'usage panel should show run/request count');
  assert(text(env.el('tokdashUsageStatus')).includes('/api/usage/summary'), 'usage panel should show the endpoint that supplied data');
});

await test('settings encrypted transport demo performs opaque broker round trip', async () => {
  const env = loadApp();
  env.api.initSettingsMenu();

  env.el('transportDemoMessage').value = 'client-copyable encrypted payload';
  await env.api.runTransportDemo();
  await flushMicrotasks(8);

  const sent = env.requests.find((r) => r.method === 'POST' && r.url === '/api/transport/envelopes');
  const received = env.requests.find((r) => r.method === 'GET' && r.url.startsWith('/api/transport/envelopes?peer='));
  const pairing = env.requests.find((r) => r.method === 'POST' && r.url === '/api/transport/pairings');
  const accept = env.requests.find((r) => r.method === 'POST' && r.url === '/api/transport/pairings/pair-web-demo/accept');
  const revoke = env.requests.find((r) => r.method === 'DELETE' && r.url === '/api/transport/peers/web-demo-phone');
  assert(pairing, 'transport demo should create a broker pairing offer');
  assert(accept, 'transport demo should accept the broker pairing with phone identity material');
  assert(sent, 'transport demo should POST an opaque envelope to the broker mailbox');
  assert(received, 'transport demo should GET the receiver mailbox');
  assert(revoke, 'transport demo should revoke its demo peer after the round trip');
  assert(text(env.el('transportDemoStatus')).includes('Round trip OK'), 'transport demo should decrypt locally after broker carriage');
  assert(text(env.el('transportDemoStatus')).includes('paired identity'), 'transport demo should name the paired-identity path');
  assert(text(env.el('transportDemoStatus')).includes('replay'), 'transport demo should mention replay protection');
  const contract = JSON.parse(String(env.el('transportContractJson').value));
  assert(contract.protocol === 'cosyncing-secure-transport-v1', 'copyable contract should name the secure transport protocol version');
  assert(contract.endpoints.createPairing === '/api/transport/pairings', 'copyable contract should include create-pairing endpoint');
  assert(contract.endpoints.acceptPairing === '/api/transport/pairings/{pairingId}/accept', 'copyable contract should include accept-pairing endpoint');
  assert(contract.endpoints.mailbox === '/api/transport/envelopes', 'copyable contract should include mailbox endpoint');
  assert(contract.endpoints.sessionControl === '/api/transport/session-control', 'copyable contract should include encrypted session-control endpoint');
  assert(contract.headers.includes('x-cosyncing-to-token'), 'copyable contract should include recipient mailbox token header');
  assert(contract.cipherEnvelope.includes('senderSignature'), 'copyable contract should include sender signature field');
});

await test('one #control button auto-routes Take over (drivable-only) vs Sync (sync-available) off control state', async () => {
  const env = loadApp();
  // Drivable, NOT sync-available → the single button offers Take over (the confirm/drive path).
  await env.api.attach(session({
    control: {
      drive: { supported: true, state: 'observing' },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  }));
  assert(visible(env.el('control')), 'control button should be visible for a drivable session');
  assert(!env.el('control').disabled, 'control button should be enabled when drive.state is observing');
  assert(text(env.el('control')).includes('Take over'), 'drivable-only session should route the button to Take over');
  assert(env.el('control').dataset.kind === 'takeover', 'control kind should be takeover');
  assert(text(env.document.querySelector('#controlState .controlpill')) === 'Observed from terminal', 'control pill should describe observe state');

  // Sync-available → the SAME button offers Sync (join, no confirm). One element, distinct action.
  await env.api.attach(session({
    id: 'syncable',
    control: {
      drive: { supported: true, state: 'observing' },
      terminalSync: { supported: true, syncAvailable: true, active: false, label: 'Sync with terminal', command: 'opencode attach …' },
    },
  }));
  assert(visible(env.el('control')), 'control button should be visible for a sync-available session');
  assert(text(env.el('control')) === 'Sync', 'sync-available session should route the button to Sync');
  assert(env.el('control').dataset.kind === 'sync', 'control kind should be sync');
  assert(text(env.document.querySelector('#controlState .controlpill')) === 'Sync available', 'control pill should describe sync availability');
});

await test('pushed session control updates make an open Observe view synced immediately (Claude answer-only via hooks)', async () => {
  const env = loadApp();
  // A Claude session starts observe-only: the ADAPTER always reports terminalSync.supported:false (sync
  // lives in the broker hooks overlay, not the adapter), so observe state carries no syncAvailable either.
  const observed = session({
    id: 'sync-late',
    tool: 'claude',
    title: 'Late sync',
    status: 'idle',
    control: {
      drive: { supported: true, state: 'observing' },
      terminalSync: { supported: false, syncAvailable: false, active: false, label: 'Observed from terminal' },
    },
  });
  env.setSessions([observed]);
  await env.api.loadRoster();
  await env.api.attach(observed);
  await flushMicrotasks(12);
  assert(env.el('input').disabled === true, 'observe attach should start read-only');

  // The broker hooks overlay then pushes a SYNCED SessionInfo: terminalSync goes active with
  // input:'answer-only' (the hook can answer prompts/questions but cannot inject a fresh prompt).
  const synced = session({
    ...observed,
    attachMode: 'live',
    control: {
      drive: { supported: false, state: 'unavailable', reason: 'Synced through cosyncing hooks — answer prompts and questions here.' },
      terminalSync: { supported: true, syncAvailable: true, active: true, input: 'answer-only', label: 'Synced via hooks' },
    },
  });
  env.sockets[0]?.onmessage?.({ data: JSON.stringify({ kind: 'session', info: synced }) });
  await flushMicrotasks(12);

  assert(text(env.el('controlState')).includes('Synced'), 'control pill should update from the pushed session frame (shows the hooks sync label)');
  assert(
    env.el('input').disabled === true && env.el('send').disabled === true,
    'answer-only sync keeps the composer read-only (no live-prompt-inject path) even after the pushed sync frame',
  );
  const rosterCopy = env.api.getState().lastRosterSessions.find((s) => s.id === 'sync-late');
  assert(rosterCopy?.control?.terminalSync.active === true, 'local roster state should update immediately instead of waiting for the 6s poll');
});

await test('answer-only sync (D8): composer stays read-only while permission/question cards remain actionable', async () => {
  const env = loadApp();
  // Claude hooks overlay — genuinely SYNCED (active) and answerable, but input:'answer-only' (no live
  // prompt-inject path). This is the exact contract canPromptFromControl/isAnswerOnlySync gate; without a
  // test pinning it, deleting the `input !== 'answer-only'` guard would silently make the composer mutable.
  await env.api.attach(session({
    id: 'answer-only-sync',
    tool: 'claude',
    title: 'Hooks-synced',
    control: {
      drive: { supported: false, state: 'unavailable', reason: 'Synced through hooks.' },
      terminalSync: { supported: true, syncAvailable: true, active: true, input: 'answer-only', label: 'Synced via hooks' },
    },
  }));
  await flushMicrotasks(8);

  // Composer locked (no new-prompt path), but this is a real sync — NOT a "Take over" affordance.
  assert(env.el('input').disabled === true, 'answer-only sync must keep the prompt box read-only');
  assert(env.el('send').disabled === true, 'answer-only sync must keep the send button disabled');
  assert(!visible(env.el('control')), 'a synced session shows no control button (answer-only sync is not a takeover affordance)');
  assert(text(env.el('controlState')).includes('Synced'), 'pill should read as Synced for an active answer-only sync');

  // …yet permission and question cards ARE answerable (canSendFromControl is true for any active sync).
  env.api.render({ type: 'permission-request', requestId: 'ao1', title: 'Run shell', toolName: 'bash' });
  const permCard = env.document.getElementById('perm-ao1');
  assert(permCard && !permCard.classList.contains('readonly'), 'answer-only sync should render permission cards as actionable, not read-only');
  permCard.querySelector('.ok')?.click();
  assert(
    env.sockets[0]?.sent.some((m) => m.includes('"kind":"approve"') && m.includes('"requestId":"ao1"')),
    'approving a card on an answer-only sync should send an approve frame',
  );

  env.api.render({ type: 'question-request', requestId: 'aoq1', questions: [{ question: 'Proceed?', header: 'Decision', options: [{ label: 'Yes' }, { label: 'No' }] }] });
  const qCard = env.document.getElementById('q-aoq1');
  assert(qCard && !qCard.classList.contains('readonly'), 'answer-only sync should render question cards as actionable');
  env.document.querySelector('#q-aoq1 .qopt')?.click();
  env.document.querySelector('#q-aoq1 .ok')?.click();
  assert(
    env.sockets[0]?.sent.some((m) => m.includes('"kind":"answer"') && m.includes('"requestId":"aoq1"')),
    'answering a question on an answer-only sync should send an answer frame',
  );
});

await test('Claude Observe+Drive control survives the WebSocket session-frame overwrite', async () => {
  const env = loadApp();
  const s = claudeSession();
  await env.api.attach(s);
  assert(text(env.document.querySelector('#controlState .controlpill')) === 'Observed from terminal', 'Claude roster control should render as observed');
  assert(text(env.el('control')).includes('Take over'), 'Claude observing session should show the Take over button');

  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'session',
      info: {
        id: s.id,
        tool: s.tool,
        title: s.title,
        cwd: s.cwd,
        model: s.model,
        status: 'idle',
        attachMode: 'observe',
      },
    }),
  });

  assert(text(env.document.querySelector('#controlState .controlpill')) === 'Observed from terminal', 'partial session frame must not downgrade Claude control to unknown');
  assert(text(env.el('control')).includes('Take over'), 'partial session frame must preserve the Claude Take over affordance');
});

await test('attach transport mode alone does not grant app mutation ownership', async () => {
  const observed = loadApp();
  await observed.api.attach(session(), 'resume');
  assert(observed.api.getState().driving === false, 'resume transport mode without driving control must remain non-driving');
  assert(observed.el('input').disabled, 'composer should stay disabled until SessionInfo.control proves ownership');

  const owned = loadApp();
  await owned.api.attach(session({
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, active: false },
    },
  }));
  assert(owned.api.getState().driving === true, 'explicit driving control should grant app mutation ownership');
  assert(!owned.el('input').disabled, 'composer should enable from explicit driving control');
});

await test('driving attach persists sticky intent for refresh', async () => {
  const env = loadApp();
  const s = claudeSession();
  await env.api.attach(s, 'resume');
  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'session',
      info: {
        ...s,
        control: {
          drive: { supported: true, state: 'driving' },
          terminalSync: { supported: false, active: false },
        },
      },
    }),
  });
  assert(localStorage.getItem(`cosyncing:driving:${s.tool}:${s.id}`), 'drive session frame should persist sticky driving intent');
});

await test('fresh sticky driving intent reopens roster row in resume mode', async () => {
  const env = loadApp();
  const s = claudeSession();
  localStorage.setItem(`cosyncing:driving:${s.tool}:${s.id}`, String(NOW - 60_000));
  await env.api.attach(s);
  assert(env.sockets[0]?.url.includes('mode=resume'), `expected resume WebSocket URL, got ${env.sockets[0]?.url}`);
});

await test('stale sticky driving intent is cleared and opens observe mode', async () => {
  const env = loadApp();
  const s = claudeSession();
  localStorage.setItem(`cosyncing:driving:${s.tool}:${s.id}`, String(NOW - 31 * 60_000));
  await env.api.attach(s);
  assert(!env.sockets[0]?.url.includes('mode=resume'), `stale key should not force resume, got ${env.sockets[0]?.url}`);
  assert(localStorage.getItem(`cosyncing:driving:${s.tool}:${s.id}`) === null, 'stale sticky driving key should be removed');
});

await test('drive-by-default session never records or applies sticky resume (item-14 two-tab identity split)', async () => {
  // An opencode shared-serve session is ALREADY driving on its bare attach. Recording sticky intent
  // for it made every other tab open the same session as ?mode=resume — a DIFFERENT Hub owner
  // (`opencode:<id>#resume`, an `opencode run` rival), so composer drafts and live frames never
  // mirrored between two tabs (maintainer's item-14 screenshots, reproduced with two real pages).
  const env = loadApp();
  const s = session({
    id: 'oc-two-tab',
    tool: 'opencode',
    attachMode: 'live',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, syncAvailable: true, active: false },
    },
  });
  // Tab 1: bare attach; the session frame confirms driving — must NOT persist sticky intent.
  await env.api.attach(s);
  assert(!env.sockets[0]?.url.includes('mode=resume'), 'bare attach of a driving session stays bare');
  env.sockets[0]?.onmessage?.({ data: JSON.stringify({ kind: 'session', info: s }) });
  await flushMicrotasks(4);
  assert(localStorage.getItem(`cosyncing:driving:${s.tool}:${s.id}`) === null,
    'a driving-by-default session frame must not record sticky resume intent');

  // Tab 2 (worst case): a STALE intent already exists (pre-fix browser state) — it must be ignored
  // AND cleaned, so the second tab joins the same bare Hub identity as the first.
  localStorage.setItem(`cosyncing:driving:${s.tool}:${s.id}`, String(NOW - 60_000));
  await env.api.attach(s);
  const second = env.sockets[env.sockets.length - 1];
  assert(!second?.url.includes('mode=resume'), `second tab must attach bare (shared identity), got ${second?.url}`);
  assert(localStorage.getItem(`cosyncing:driving:${s.tool}:${s.id}`) === null, 'stale intent on a bare-mutable session is cleaned');
});

await test('no-sync adapters get an honest Resume-in-CLI affordance, never "Sync TUI" (over-claim fix)', async () => {
  // Claude has NO live terminal sync (terminalSync.supported:false) — its command is a resume/handoff.
  // maintainer's re-flag: while driving a claude session the button said "💻 Sync TUI" and the dialog
  // "Sync your terminal", over-claiming a live link. The affordance must use the adapter's honest
  // label; synced-capable sessions keep the optional terminal join wording.
  const env = loadApp();
  await env.api.attach(session({
    id: 'claude-handoff',
    tool: 'claude',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: false, syncAvailable: false, active: false, label: 'Resume in terminal', command: 'claude --resume abc-123' },
    },
  }));
  await flushMicrotasks(8);
  const label = text(env.el('control'));
  assert(label.includes('Resume in terminal'), `no-sync driving session button should say Resume in terminal, got "${label}"`);
  assert(!label.includes('Sync TUI'), 'no-sync driving session button must NOT say Sync TUI');
  assert((env.el('control').title || '').toLowerCase().includes('resume this conversation in your terminal'), 'tooltip should describe terminal resumption');

  const env2 = loadApp();
  await env2.api.attach(session({
    id: 'oc-real-sync',
    tool: 'opencode',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, syncAvailable: true, active: false, label: 'Sync with your terminal (optional)', command: 'opencode attach …' },
    },
  }));
  await flushMicrotasks(8);
  assert(text(env2.el('control')).toLowerCase().includes('open in terminal (optional)'), 'true-sync-capable driving session now uses optional open affordance');
});

await test('ended frame clears sticky driving intent', async () => {
  const env = loadApp();
  const s = claudeSession({
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: false, active: false },
    },
  });
  localStorage.setItem(`cosyncing:driving:${s.tool}:${s.id}`, String(NOW));
  await env.api.attach(s, 'resume');
  env.sockets[0]?.onmessage?.({ data: JSON.stringify({ kind: 'ended', reason: 'done' }) });
  assert(localStorage.getItem(`cosyncing:driving:${s.tool}:${s.id}`) === null, 'ended frame should clear sticky driving key');
});

await test('model picks are saved under lineageId and restored across forks', async () => {
  const env = loadApp();
  const control = { drive: { supported: true, state: 'driving' }, terminalSync: { supported: false, active: false } };
  const first = claudeSession({
    id: 'claude-lineage-a',
    lineageId: 'lineage-shared-user-uuid',
    currentModel: { providerID: 'anthropic', modelID: 'opus' },
    control,
  });
  await env.api.attach(first, 'resume');
  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'options',
      models: [
        { providerID: 'anthropic', modelID: 'opus', label: 'Opus · claude-opus-4-8' },
        { providerID: 'anthropic', modelID: 'sonnet', label: 'Sonnet · claude-sonnet-4-6' },
      ],
      agents: [],
      modes: [],
    }),
  });
  env.el('modelPick').onclick?.({});
  const sonnet = env.el('optmenu').querySelectorAll('.oitem').find((x) => text(x).includes('Sonnet'));
  sonnet?.onclick?.({});
  assert(localStorage.getItem('cosyncing:modelPick:claude:lineage-shared-user-uuid')?.includes('"sonnet"'), 'selected model should be stored under lineageId');

  const fork = claudeSession({
    id: 'claude-lineage-b',
    lineageId: 'lineage-shared-user-uuid',
    currentModel: { providerID: 'anthropic', modelID: 'opus' },
    control,
  });
  await env.api.attach(fork, 'resume');
  env.el('input').value = 'use restored lineage model';
  env.el('send').onclick?.({});
  const sent = env.sockets.at(-1)?.sent.map((raw) => JSON.parse(raw)).find((m) => m.kind === 'prompt');
  assert(sent?.model?.providerID === 'anthropic' && sent.model.modelID === 'sonnet', 'fork prompt should carry the lineage-restored model pick');
});

await test('refresh/second-client payload with launchSurface app + absent has no behind warning and renders optional join copy text', async () => {
  const shared = session({
    id: 'app-launch-absent',
    launchSurface: 'app',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: {
        supported: true,
        active: false,
        action: 'join',
        presence: 'absent',
        command: 'cosyncing sync opencode app-launch-absent',
      },
    },
  });
  const owner = loadApp();
  await owner.api.attach(shared, 'resume');
  await flushMicrotasks(4);
  const ownerPill = owner.el('controlState').querySelector('.controlpill');
  assert(text(ownerPill).includes('Driving in app'), `app+absent launch should keep compact driving pill, got "${text(ownerPill)}"`);
  assert(owner.document.querySelectorAll('.sysnote').length === 0, 'removed legacy behind note path should never render');
  assert((owner.el('control').textContent || '').toLowerCase().includes('open in terminal (optional)'), 'driving copy should use optional join affordance');
  const ownerPillTitle = ownerPill?.title || '';
  assert(ownerPillTitle.includes('No terminal is open; nothing is behind.'), 'driving detail should keep app+absent neutral signal in title');

  const second = loadApp();
  await second.api.attach(shared, 'resume');
  await flushMicrotasks(4); // second-client/open path should inherit same control routing
  const secondPill = second.el('controlState').querySelector('.controlpill');
  assert(text(secondPill) === 'Driving in app', `second payload should keep compact driving pill, got "${text(secondPill)}"`);
  assert((secondPill?.title || '').includes('No terminal is open; nothing is behind.'), 'second payload should still surface absent detail in status');
  assert(second.document.querySelectorAll('.sysnote').length === 0, 'second payload should never emit the old behind note');
});

await test('private/presence copy stays behind-safe (behind false) and behind-true', async () => {
  const noBehind = session({
    id: 'private-not-behind',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: {
        supported: true,
        active: false,
        action: 'join',
        presence: 'private',
        behind: false,
        command: 'cosyncing sync opencode private-not-behind',
      },
    },
  });
  const envNo = loadApp();
  await envNo.api.attach(noBehind, 'resume');
  await flushMicrotasks(4);
  const pillNo = envNo.el('controlState').querySelector('.controlpill');
  assert(text(pillNo) === 'Driving in app', `private/behind=false should keep compact driving pill, got "${text(pillNo)}"`);
  const detailNo = pillNo?.title || '';
  assert(detailNo.includes('Terminal needs restart/rejoin to continue.'), `private/behind=false should request restart/rejoin, got "${detailNo}"`);
  assert(!detailNo.toLowerCase().includes('behind'), 'private/behind=false should not claim behind');

  const behind = session({
    id: 'private-behind',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: {
        supported: true,
        active: false,
        action: 'join',
        presence: 'private',
        behind: true,
        command: 'cosyncing sync opencode private-behind',
      },
    },
  });
  const envBehind = loadApp();
  await envBehind.api.attach(behind, 'resume');
  await flushMicrotasks(4);
  const pillBehind = envBehind.el('controlState').querySelector('.controlpill');
  const detailBehind = pillBehind?.title || '';
  assert(pillBehind && pillBehind.textContent === 'Driving in app', `private/behind=true should keep compact driving pill, got "${text(pillBehind)}"`);
  assert(detailBehind.includes('behind'), 'private/behind=true should explicitly surface behind');

  const unknown = session({
    id: 'presence-unknown',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: {
        supported: true,
        active: false,
        action: 'join',
        command: 'cosyncing sync opencode presence-unknown',
      },
    },
  });
  const envUnknown = loadApp();
  await envUnknown.api.attach(unknown, 'resume');
  await flushMicrotasks(4);
  const pillUnknown = envUnknown.el('controlState').querySelector('.controlpill');
  const detailUnknown = pillUnknown?.title || '';
  assert(text(pillUnknown) === 'Driving in app', 'unknown presence should keep compact driving pill');
  assert(!detailUnknown.toLowerCase().includes('behind'), 'presence unknown should stay neutral');
});

await test('join action keeps driving intent and does not re-attach Observe on copy', async () => {
  const s = session({
    id: 'join-keeps-drive',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: {
        supported: true,
        active: false,
        action: 'join',
        presence: 'absent',
        command: 'cosyncing sync opencode join-keeps-drive',
      },
    },
  });
  const env = loadApp();
  localStorage.setItem(`cosyncing:driving:${s.tool}:${s.id}`, String(NOW));
  await env.api.attach(s, 'resume');
  await flushMicrotasks(4);
  const before = env.sockets.length;
  env.el('control').onclick?.({});
  await drainMicrotasks();
  const okBtn = env.document.querySelector('.mok');
  assert(okBtn, 'join action should open copy dialog');
  okBtn.onclick?.({});
  await drainMicrotasks();
  assert(env.sockets.length === before, 'join path should keep the resume attach (no re-attach to observe)');
  assert(localStorage.getItem(`cosyncing:driving:${s.tool}:${s.id}`) !== null, 'join action copy must keep sticky driving intent');
});

await test('roster rows with the same lineageId mark older continuations', () => {
  const env = loadApp();
  const older = session({ id: 'lineage-old', title: 'Original', lineageId: 'lineage-1', updatedAt: NOW - 10_000 });
  const newer = session({ id: 'lineage-new', title: 'Forked continuation', lineageId: 'lineage-1', updatedAt: NOW });
  env.api.getState().openProjects.add(older.cwd || '/workspace/project-a');
  env.api.renderRoster([older, newer]);
  assert(env.el('rosterList').textContent.includes('continued as "Forked continuation"'), 'older lineage row should point at the newest continuation title');
});

await test('auto-origin sessions hide by default; toggles, parent ⚒ peek, and child ↳ parent chip work (issues-part3 subagent display)', async () => {
  const env = loadApp();
  const mk = (over: Record<string, unknown>) => session({ tool: 'codex', model: undefined, ...over } as Partial<SessionInfo>);
  const roster = [
    mk({ id: 'p1', title: 'parent one', nativeId: 'thr-p1', updatedAt: NOW }),
    // two IDENTICAL child titles — the reveal must keep them distinct (cardinality lesson §F)
    mk({ id: 'c1', title: 'child same', nativeId: 'thr-c1', origin: 'subagent', parentThreadId: 'thr-p1', updatedAt: NOW - 2_000 }),
    mk({ id: 'c2', title: 'child same', nativeId: 'thr-c2', origin: 'subagent', parentThreadId: 'thr-p1', updatedAt: NOW - 3_000 }),
    mk({ id: 'e1', title: 'exec run', nativeId: 'thr-e1', origin: 'exec', updatedAt: NOW - 4_000 }),
    mk({ id: 'v1', title: 'ide session', nativeId: 'thr-v1', origin: 'vscode', updatedAt: NOW - 5_000 }),
  ];
  env.setSessions(roster);
  env.api.getState().openProjects.add('/workspace/project-a');
  await env.api.loadRoster(); // populates lastRosterSessions so the chips' re-renders see the full payload
  const rowTitles = () => env.document.documentElement.querySelectorAll('.srow .title').map((el) => text(el));
  assert(rowTitles().join('|') === 'parent one|ide session', `subagent+exec hidden, vscode shown by default — got [${rowTitles().join(', ')}]`);

  // the parent row carries a ⚒ 2 chip; clicking it peeks BOTH children without touching settings
  const kids = env.document.documentElement.querySelectorAll('.originChip.kids')[0];
  assert(kids && text(kids).includes('2'), 'parent row should show a ⚒ 2 children chip');
  kids.click();
  assert(rowTitles().filter((t) => t === 'child same').length === 2, 'the ⚒ peek must reveal BOTH identical-title children (distinct rows)');
  // each revealed child links back to its parent by title; clicking the chip opens the parent
  const childChip = env.document.documentElement.querySelectorAll('.originChip.linked')[0];
  assert(childChip && text(childChip).includes('parent one'), 'child rows should carry a ↳ <parent title> chip');
  childChip.click();
  await drainMicrotasks();
  assert(env.api.getState().current?.id === 'p1', 'clicking the ↳ chip should open the PARENT session');
  // the peek collapses again from the same chip
  env.document.documentElement.querySelectorAll('.originChip.kids')[0]!.click();
  assert(rowTitles().filter((t) => t === 'child same').length === 0, 'clicking ⚒ again hides the children');

  // settings toggles: showing exec runs reveals them; hiding IDE sessions removes them
  env.api.initSettingsMenu();
  const execBox = env.el('showOriginExec');
  execBox.checked = true;
  execBox.onchange?.({ target: execBox });
  assert(rowTitles().includes('exec run'), 'ticking "Exec runs" should reveal exec sessions');
  const vsBox = env.el('showOriginVscode');
  vsBox.checked = false;
  vsBox.onchange?.({ target: vsBox });
  assert(!rowTitles().includes('ide session'), 'unticking "IDE (VS Code)" should hide extension sessions');
});

await test('active terminal sync takes precedence: synced pill, no control button, composer live', async () => {
  const env = loadApp();
  await env.api.attach(session({
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, syncAvailable: true, active: true, label: 'Synced with terminal' },
    },
  }));

  assert(text(env.document.querySelector('#controlState .controlpill')) === 'Synced with terminal', 'active sync should win the status text');
  assert(!visible(env.el('control')), 'the single control button should be hidden once the session is already synced (composer is the surface)');
  assert(!env.el('input').disabled, 'composer should be enabled for a proven active sync');
});

await test('terminal sync state is session-scoped in the roster, not project-scoped', async () => {
  const env = loadApp();
  env.setSessions([
    session({
      id: 'synced-left-tab',
      title: 'Synced terminal work',
      control: {
        drive: { supported: false, state: 'unavailable', reason: 'Already synced with terminal.' },
        terminalSync: { supported: true, active: true, label: 'Synced with terminal' },
      },
    }),
  ]);
  await env.api.loadRoster();

  const head = env.document.querySelector('.projectHead');
  assert(head, 'project header should render');
  assert(!head.textContent.includes('synced'), 'closed project header should not show a session-level synced marker');
  assert(!env.document.querySelector('.srow'), 'projects should still default closed');

  head.click();
  const row = env.document.querySelector('.srow');
  assert(row?.textContent.includes('synced'), 'expanded session row should show a synced terminal marker');
  assert(row?.querySelector('.rowSync'), 'session row should include the dedicated sync badge element');
});

await test('roster shows a "sync available" ghost badge for syncable-but-not-active sessions (D4)', async () => {
  const env = loadApp();
  env.setSessions([
    session({
      id: 'sync-avail-row',
      title: 'Syncable work',
      control: {
        drive: { supported: true, state: 'observing' },
        terminalSync: { supported: true, syncAvailable: true, active: false, label: 'Sync with terminal', command: 'opencode attach …' },
      },
    }),
  ]);
  await env.api.loadRoster();
  env.document.querySelector('.projectHead')?.click();
  const row = env.document.querySelector('.srow');
  assert(row, 'expanded session row should render');
  const avail = row!.querySelector('.rowSyncAvail');
  assert(avail, 'session row should include the sync-available badge element');
  assert(visible(avail!), 'sync-available badge should be visible when syncAvailable && !active');
  assert(text(avail!) === 'sync available', 'badge wording is the two-word "sync available" (D4)');
  const syncedBadge = row!.querySelector('.rowSync');
  assert(syncedBadge && !visible(syncedBadge), 'the active "synced" badge should be hidden when not yet active');
});

await test('opencode TUI presence: pushed session frames flip the synced badge both ways (full sync, composer stays mutable)', async () => {
  // The opencode presence watcher (tui-presence.ts → watchSessionInfo → hub updateInfo) pushes
  // `kind:'session'` frames when an `opencode attach` TUI joins/leaves. Unlike Claude's answer-only
  // hooks sync, this is FULL sync: the composer must stay mutable through both flips, the Sync
  // button must disappear while attached, and it must come BACK when the terminal quits.
  const env = loadApp();
  const base = session({
    id: 'oc-presence',
    tool: 'opencode',
    title: 'Serve session',
    attachMode: 'live',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, syncAvailable: true, active: false, label: 'Sync with your terminal (optional)', command: 'opencode attach http://127.0.0.1:4096 -s oc-presence' },
    },
  });
  env.setSessions([base]);
  await env.api.loadRoster();
  await env.api.attach(base);
  await flushMicrotasks(12);
  assert(env.el('control').style.display !== 'none' && text(env.el('control')).toLowerCase().includes('open in terminal'), 'unsynced serve session offers the optional terminal join affordance');
  assert(env.el('input').disabled === false, 'driven serve session starts mutable');

  const joined = session({
    ...base,
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, syncAvailable: true, active: true, label: 'Synced with OpenCode terminal' },
    },
  });
  env.sockets[0]?.onmessage?.({ data: JSON.stringify({ kind: 'session', info: joined }) });
  await flushMicrotasks(12);
  assert(text(env.el('controlState')).includes('Synced'), 'TUI join: control pill shows the synced label from the pushed frame');
  assert(env.el('control').style.display === 'none', 'TUI join: the Sync button disappears (already one owner)');
  assert(env.el('input').disabled === false && env.el('send').disabled === false, 'TUI join: FULL sync keeps the composer mutable (opencode ≠ answer-only)');

  env.sockets[0]?.onmessage?.({ data: JSON.stringify({ kind: 'session', info: base }) });
  await flushMicrotasks(12);
  assert(env.el('control').style.display !== 'none' && text(env.el('control')).toLowerCase().includes('open in terminal'), 'TUI quit: the terminal join affordance returns from the pushed frame');
  assert(env.el('input').disabled === false, 'TUI quit: composer stays mutable (serve conn unchanged)');
});

await test('roster refresh updates the open session control state without reattach', async () => {
  const env = loadApp();
  const synced = session({
    id: 'roster-sync',
    title: 'Roster sync',
    control: {
      drive: { supported: false, state: 'unavailable', reason: 'Already synced with terminal.' },
      terminalSync: { supported: true, active: true, label: 'Synced with terminal' },
    },
  });
  env.setSessions([synced]);
  await env.api.loadRoster();
  await env.api.attach(synced);
  await flushMicrotasks(8);
  assert(text(env.el('controlState')).includes('Synced with terminal'), 'setup should start synced');
  assert(!env.el('input').disabled, 'active terminal sync should make the open composer mutable');

  const observedAgain = session({
    ...synced,
    control: {
      drive: { supported: true, state: 'observing' },
      terminalSync: { supported: true, active: false, label: 'Sync with terminal', command: 'cosyncing sync opencode roster-sync' },
    },
  });
  env.setSessions([observedAgain]);
  await env.api.loadRoster();
  await flushMicrotasks(8);

  assert(env.api.getState().current?.control?.terminalSync.active === false, 'current session control should merge from the refreshed roster row');
  assert(text(env.el('controlState')).includes('Observed from terminal'), 'header pill should downgrade without waiting for reattach');
  assert(env.el('input').disabled, 'composer should become read-only when refreshed control loses ownership');
});

await test('stale WebSocket frames cannot mutate a newer attached session', async () => {
  const env = loadApp();
  const first = session({ id: 'first-session', title: 'First session' });
  const second = session({ id: 'second-session', title: 'Second session' });
  await env.api.attach(first);
  const oldSocket = env.sockets[0];
  await env.api.attach(second);
  const activeSocket = env.sockets[1];
  assert(oldSocket && activeSocket, 'both WebSocket handles should exist in the fixture');

  oldSocket.onmessage?.({
    data: JSON.stringify({
      kind: 'history',
      reset: true,
      cursor: 'old-cursor',
      messages: [{ type: 'model-output', key: 'old-message', text: 'Old stale history' }],
    }),
  });
  oldSocket.onmessage?.({
    data: JSON.stringify({
      kind: 'session',
      info: { ...first, title: 'Stale overwrite', control: { drive: { supported: true, state: 'driving' }, terminalSync: { supported: true, active: false } } },
    }),
  });

  assert(env.api.getState().current?.id === 'second-session', 'old session frame should not replace current');
  assert(!env.el('thread').textContent.includes('Old stale history'), 'old history frame should not render into the new transcript');

  activeSocket.onmessage?.({
    data: JSON.stringify({
      kind: 'history',
      reset: true,
      cursor: 'new-cursor',
      messages: [{ type: 'model-output', key: 'new-message', text: 'Fresh active history' }],
    }),
  });
  assert(env.el('thread').textContent.includes('Fresh active history'), 'active socket history should still render');
});

await test('attach connection failures replace the transcript loading indicator', async () => {
  const env = loadApp();
  const s = session({ id: 'failure-session', title: 'Failure target' });
  await env.api.attach(s);
  assert(env.document.getElementById('sessionLoading'), 'attach should show loading before the socket fails');

  env.sockets[0]?.onerror?.(eventFor(null, 'error'));
  await flushMicrotasks(4);

  assert(!env.document.getElementById('sessionLoading'), 'socket error should remove the loading indicator');
  assert(env.el('thread').textContent.includes('Connection error while opening this session.'), 'socket error should leave an actionable transcript message');
});

await test('explicit app Drive ownership shows the Driving pill and keeps the composer enabled', async () => {
  const env = loadApp();
  await env.api.attach(session({
    id: 'true-sync-driving',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, syncAvailable: true, active: false, label: 'Sync with terminal', command: 'cosyncing sync opencode true-sync-driving' },
    },
  }));

  assert(text(env.document.querySelector('#controlState .controlpill')) === 'Driving in app', 'drive-owned sessions should not be mislabeled as terminal-sync setup');
  assert(visible(env.el('control')), 'a driving session shows the Sync TUI affordance');
  assert(text(env.el('control')).toLowerCase().includes('open in terminal'), 'the driving-slot button is the optional join affordance');
  assert(!env.el('input').disabled, 'explicit Drive ownership should keep the composer enabled');
});

await test('Codex sync toggle posts the per-agent enabler and never calls the deleted control-mode picker (D15/D17)', async () => {
  const env = loadApp();
  env.api.initSettingsMenu();
  await flushMicrotasks(8); // refreshCodexSyncState GET
  const toggle = env.el('codexSyncToggle');
  assert(toggle, 'settings should expose the per-agent Codex sync toggle');
  toggle.onclick?.({ type: 'click' });
  await flushMicrotasks(40);

  const post = env.requests.find((r) => r.method === 'POST' && r.url === '/api/agents/codex/sync');
  assert(post, 'toggling should POST the per-agent Codex sync enabler');
  assert(JSON.parse(post.body || '{}').enabled === true, 'enabler POST should request enabled:true');
  assert(!env.requests.find((r) => (r.url || '').startsWith('/api/broker/control-mode')), 'the deleted control-mode picker endpoint must never be called');
});

await test('runtime freshness surfaces per-runtime restart, always-on status list, and fresh re-probe', async () => {
  const env = loadApp();
  env.api.initSettingsMenu();
  await flushMicrotasks(16);

  assert(visible(env.el('runtimeUpdateBadge')), 'pending runtime drift should show the header update badge');
  assert(/\d+ updates? ready/.test(text(env.el('runtimeUpdateBadge'))), 'header badge should use concise counted update-ready wording');
  assert(visible(env.el('runtimeUpdate-codex')), 'pending Codex drift should show its settings row');
  assert(text(env.el('runtimeUpdateText-codex')).includes('0.142.5') && text(env.el('runtimeUpdateText-codex')).includes('0.144.1'), 'settings row should show running and installed versions');
  assert(text(env.el('runtimeUpdateText-codex')).includes('1 unknown') && text(env.el('runtimeUpdateText-codex')).includes('019f51c9'), 'unknown native thread/read blockers should be visible by composition and id');
  assert(text(env.el('runtimeUpdateText-configprobe')).includes('configuration changed since this daemon started'), 'config-only drift should not render equal versions as a fake binary upgrade');

  // Always-visible status list (test-UI clarity, 2026-07-11): every managed runtime, even when current.
  const statusList = text(env.el('runtimeStatusList'));
  assert(statusList.includes('Codex daemon — pending') && statusList.includes('OpenCode serve — current'), 'status list should show every runtime with its state');
  assert(statusList.includes('checked '), 'status list should show probe age');

  // Fail-closed honesty: an ABSENT blockers field (safety probe threw) must render the probe failure
  // verbatim in both the pending row and the status list — never "No attached blockers".
  assert(text(env.el('runtimeUpdateText-fakeprobe')).includes('Loaded-thread safety probe failed: socket unavailable.'), 'a probe-failed pending row must show the failure detail');
  assert(statusList.includes('Loaded-thread safety probe failed: socket unavailable.'), 'a probe-failed runtime must show the failure detail in the status list');
  assert(!statusList.includes('No attached blockers') && !text(env.el('runtimeUpdateText-fakeprobe')).includes('No attached blockers'), 'probe failure must never render as "no blockers"');

  // Restored per-runtime restart: detailed warned confirmation, then POST to the per-agent route.
  const restart = env.el('runtimeUpdateRestart-codex');
  assert(text(restart).includes('Restart now'), 'pending row should expose a targeted Restart now action');
  restart.onclick?.({});
  await flushMicrotasks(6);
  const modal = env.document.querySelector('.modal');
  assert(modal?.textContent.includes('Restart Codex daemon now?'), 'per-runtime restart must be confirmed');
  if (!modal) throw new Error('per-runtime restart modal missing');
  assert(modal.textContent.includes('bypassing the automatic idle/policy gate'), 'confirmation must state it bypasses the automatic gate');
  assert(modal.textContent.includes('1 unknown') && modal.textContent.includes('019f51c9'), 'confirmation must repeat the blocker composition and unknown ids');
  assert(modal.textContent.includes('codex resume --remote'), 'Codex confirmation must state how to resume disconnected terminals');
  modal.querySelector('.mok')?.click();
  await flushMicrotasks(20);
  const post = env.requests.find((entry) => entry.method === 'POST' && entry.url === '/api/agent-runtime-updates/codex/restart');
  assert(post && JSON.parse(post.body || '{}').confirmRestart === true, 'confirmed per-runtime restart should POST confirmRestart:true');
  assert(env.requests.some((entry) => entry.method !== 'POST' && String(entry.url).includes('/api/agent-runtime-updates?fresh=1')), 'a manual restart should re-probe with fresh=1 afterward');

  // Refresh-status button forces a fresh probe on demand.
  const before = env.requests.filter((entry) => String(entry.url).includes('fresh=1')).length;
  env.el('refreshRuntimeStatus').onclick?.({});
  await flushMicrotasks(8);
  const after = env.requests.filter((entry) => String(entry.url).includes('fresh=1')).length;
  assert(after > before, 'Refresh status should fetch /api/agent-runtime-updates?fresh=1');
});

await test('Codex update policy requires informed confirmation before allowing idle-terminal disconnects', async () => {
  const env = loadApp();
  env.api.initSettingsMenu();
  await flushMicrotasks(16);
  const policy = env.el('codexUpdatePolicy');
  assert(policy.value === 'when-detached', 'Codex policy should load the safe attachment-empty default');
  policy.value = 'when-idle';
  policy.onchange?.({ target: policy });
  await flushMicrotasks(4);
  const modal = env.document.querySelector('.modal');
  assert(modal?.textContent.includes('Allow idle Codex terminal restarts?'), 'when-idle must require an informed confirmation');
  if (!modal) throw new Error('when-idle confirmation modal missing');
  assert(modal.textContent.includes('will disconnect') && modal.textContent.includes('working or waiting for input'), 'policy warning must state the exact disconnect and active-turn gate');
  modal.querySelector('.mok')?.click();
  await flushMicrotasks(20);
  const request = env.requests.find((entry) => entry.method === 'POST' && entry.url === '/api/agent-runtime-update-policy');
  assert(request && JSON.parse(request.body || '{}').codexUpdatePolicy === 'when-idle', 'confirmed policy should persist the reviewed when-idle spelling');
});

await test('session statusline renders display telemetry and locked read-only pickers', async () => {
  const env = loadApp();
  const s = session({
    id: 'statusline-session',
    model: 'gpt-5',
    currentModel: { providerID: 'openai', modelID: 'gpt-5', reasoningEffort: 'high' },
    currentAgent: 'build',
    currentMode: 'ask',
  });
  await env.api.attach(s);
  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'options',
      models: [{
        providerID: 'openai',
        modelID: 'gpt-5',
        label: 'GPT-5',
        reasoningEfforts: [{ effort: 'high', label: 'High' }],
      }],
      agents: [{ name: 'build', description: 'Implementation agent' }],
      modes: [{ value: 'ask', label: 'Ask permission', description: 'Prompt before risky actions' }],
    }),
  });

  env.api.render({ type: 'status', status: 'running' });
  env.api.render({ type: 'token-count', input: 42_100, output: 8_300, cost: 0.18 });
  env.api.render({ type: 'metadata-update', key: 'contextUsage', value: { used: 580_000, max: 1_000_000 } });
  env.api.render({ type: 'metadata-update', key: 'runtimeTotals', value: { totalRuntimeMs: 9_000, turnCount: 1 } });

  assert(visible(env.el('statusline')), 'statusline should show for an attached session');
  assert(text(env.el('statusActivity')).includes('working'), 'statusline should show live activity state');
  assert(text(env.el('statusModel')).includes('GPT-5'), 'statusline should show the model label');
  assert(text(env.el('statusEffort')).includes('High'), 'statusline should show the reasoning effort');
  assert(text(env.el('statusAgent')).includes('build'), 'statusline should show the selected agent');
  assert(text(env.el('statusMode')).includes('Ask permission'), 'statusline should show the permission mode label');
  assert(text(env.el('tokmeter')).includes('42k') && text(env.el('tokmeter')).includes('8.3k'), 'statusline should show latest token counts');
  assert(text(env.el('contextMeter')).includes('58%'), 'statusline should show context usage from metadata-update');
  assert(text(env.el('runtimeMeter')).includes('total') && text(env.el('runtimeMeter')).includes('9s'), 'statusline should prefer authoritative runtime totals when reported');
  assert(visible(env.el('controls')), 'reported picker options should stay visible in read-only observe');
  assert(env.el('modelPick').disabled && env.el('modePick').disabled, 'read-only picker controls should be visible but locked');

  env.api.render({ type: 'user-message', key: 'u1', text: 'Timed prompt', sentAt: NOW });
  env.api.render({ type: 'model-output', key: 'a1', text: 'Timed response' });
  env.api.render({
    type: 'run-summary',
    key: 'run1',
    turnId: 'turn1',
    assistantMessageKey: 'a1',
    status: 'done',
    startedAt: NOW,
    completedAt: NOW + 4_000,
    totalRuntimeMs: 4_000,
    tokens: { input: 42_100, output: 8_300 },
  });
  assert(env.document.querySelector('.msg.user .msgtime'), 'user-message sentAt should render inside the user bubble');
  const meta = env.document.querySelector('.msg.assistant .runmeta');
  assert(meta && text(meta).includes('Run') && text(meta).includes('4s'), 'run-summary should render inline under the assistant response');
  assert(text(meta).includes('finished'), 'completed run-summary should show its finished-at clock');
  assert(text(meta).includes('42k') && text(meta).includes('8.3k'), 'completed run-summary should show per-turn usage when provided');
});

await test('a queued user-message renders dimmed+badged and its delivery clears the style IN PLACE (issues-part2 item-12 follow-up)', async () => {
  const env = loadApp();
  await env.api.attach(claudeSession({ status: 'working' }));
  const userBubbles = () => env.document.documentElement.querySelectorAll('.msg.user');
  const queuedBubbles = () => userBubbles().filter((el) => el.classList.contains('queued'));

  // cardinality (lessons §F): two IDENTICAL texts with distinct keys must stay two distinct bubbles
  env.api.render({ type: 'user-message', key: 'queued:t1:10', text: 'same words', queued: true, sentAt: NOW });
  env.api.render({ type: 'user-message', key: 'queued:t2:10', text: 'same words', queued: true, sentAt: NOW + 1_000 });
  assert(userBubbles().length === 2, 'two queued frames with distinct keys should render two bubbles');
  assert(queuedBubbles().length === 2, 'both bubbles should carry the dimmed queued class');
  assert(env.document.documentElement.querySelectorAll('.qbadge').length === 2, 'both bubbles should carry a queued badge');

  // the CLI delivers the first one: SAME key, no queued flag → the style clears in place, no new bubble
  env.api.render({ type: 'user-message', key: 'queued:t1:10', text: 'same words', sentAt: NOW + 5_000 });
  assert(userBubbles().length === 2, 'delivery must upsert the existing bubble, never add a third');
  assert(queuedBubbles().length === 1, 'the delivered bubble sheds the queued class; the pending one keeps it');
  assert(env.document.documentElement.querySelectorAll('.qbadge').length === 1, 'the delivered bubble sheds its badge');

  // the second one is dropped by the CLI (enqueue→remove, no user line): it simply KEEPS the queued look
  env.api.render({ type: 'user-message', key: 'queued:t2:10', text: 'same words', sentAt: NOW + 6_000 });
  assert(queuedBubbles().length === 0 && env.document.documentElement.querySelectorAll('.qbadge').length === 0, 'a later delivery of the second clears it too');
});

await test('historical permission and question cards do not latch the statusline as working', async () => {
  const env = loadApp();
  await env.api.attach(claudeSession({ status: 'idle' }));
  env.api.render({ type: 'permission-request', requestId: 'hist-p', title: 'Old shell permission' }, false);
  env.api.render({ type: 'permission-resolved', requestId: 'hist-p' }, false);
  env.api.render({
    type: 'question-request',
    requestId: 'hist-q',
    questions: [{ question: 'Old question?', header: 'Decision', options: [{ label: 'Yes' }] }],
  }, false);
  env.api.render({ type: 'question-resolved', requestId: 'hist-q' }, false);
  assert(text(env.el('statusActivity')).includes('idle'), `historical cards should not latch working: ${text(env.el('statusActivity'))}`);
});

await test('options frame drives model and effort prompt payload without fake permission mode', async () => {
  const env = loadApp();
  const s = session({
    id: 'pi-live-model-options',
    tool: 'pi',
    model: undefined,
    currentModel: { providerID: 'fake', modelID: 'reasoner', reasoningEffort: 'medium' },
    control: {
      drive: { supported: false, state: 'unavailable', reason: 'terminal sync owns this session' },
      terminalSync: { supported: true, active: true, label: 'Synced with Pi terminal' },
    },
  });
  await env.api.attach(s);
  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'options',
      models: [{
        providerID: 'fake',
        modelID: 'reasoner',
        label: 'Pi Reasoner',
        reasoningEfforts: [
          { effort: 'medium', label: 'Medium' },
          { effort: 'high', label: 'High' },
        ],
        defaultReasoningEffort: 'medium',
      }],
      agents: [],
      modes: [],
    }),
  });

  assert(visible(env.el('modelPick')) && !env.el('modelPick').disabled, 'model picker should be actionable when broker options include models');
  assert(visible(env.el('effortPick')) && !env.el('effortPick').disabled, 'effort picker should be actionable when selected model exposes efforts');
  assert(!visible(env.el('modePick')), 'permission mode picker should stay hidden when broker sends no modes');

  env.el('effortPick').onclick?.({});
  const high = env.el('optmenu').querySelectorAll('.oitem').find((x) => text(x).includes('High'));
  high?.onclick?.({});
  env.el('input').value = 'use selected Pi model';
  env.el('send').onclick?.({});

  const sent = env.sockets[0]?.sent.map((raw) => JSON.parse(raw)).find((m) => m.kind === 'prompt');
  assert(sent?.model?.providerID === 'fake' && sent.model.modelID === 'reasoner', 'prompt payload should include selected model from options frame');
  assert(sent?.model?.reasoningEffort === 'high', 'prompt payload should include selected reasoning effort');
  assert(!('permissionMode' in sent), 'prompt payload should not invent a permission mode when no mode options were reported');
});

await test('agent picker selects OpenCode plan agent without confusing it with permission mode', async () => {
  const env = loadApp();
  const s = session({
    id: 'opencode-plan-agent',
    tool: 'opencode',
    currentAgent: 'build',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, active: false },
    },
  });
  await env.api.attach(s);
  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'options',
      models: [],
      agents: [
        { name: 'build', description: 'Implementation agent' },
        { name: 'plan', description: 'Read-only planning agent' },
      ],
      modes: [],
    }),
  });

  assert(visible(env.el('agentPick')) && !env.el('agentPick').disabled, 'agent picker should be actionable when broker reports native agents');
  env.el('agentPick').onclick?.({});
  const plan = env.el('optmenu').querySelectorAll('.oitem').find((x) => text(x).includes('plan'));
  plan?.onclick?.({});
  assert(text(env.el('statusAgent')).includes('plan'), 'selecting plan should update the statusline agent');

  env.el('input').value = 'draft a plan';
  env.el('send').onclick?.({});
  const sent = env.sockets[0]?.sent.map((raw) => JSON.parse(raw)).find((m) => m.kind === 'prompt');
  assert(sent?.agent === 'plan', 'prompt payload should carry native OpenCode plan agent');
  assert(!('permissionMode' in sent), 'OpenCode plan agent must not ride as permissionMode');
});

await test('true-sync surfaces permission mode visible-but-locked while model and effort stay actionable', async () => {
  // Regression for the Claude true-sync contract (docs/architecture/client-ui.md): a synced
  // session is mutable, so model/effort pickers ARE actionable (the adapter injects /model + /effort over the
  // channel). Permission mode is NOT — Claude has no mid-session mechanism — so the adapter reports modes:[]
  // and the app must keep the mode VISIBLE-but-LOCKED from currentMode, never an enabled picker it ignores.
  // Proven END-TO-END through the broker options frame, not just the adapter mapper.
  const env = loadApp();
  const s = session({
    id: 'claude-truesync-mode',
    tool: 'claude',
    currentModel: { providerID: 'anthropic', modelID: 'opus', reasoningEffort: 'high' },
    currentMode: 'auto', // the adapter reads this from the transcript's permission-mode line
    control: {
      drive: { supported: false, state: 'unavailable', reason: 'terminal sync owns this session' },
      terminalSync: { supported: true, active: true, label: 'Synced with terminal' },
    },
  });
  await env.api.attach(s);
  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'options',
      models: [{
        providerID: 'anthropic',
        modelID: 'opus',
        label: 'Claude Opus',
        reasoningEfforts: [{ effort: 'high', label: 'High' }, { effort: 'max', label: 'Max' }],
        defaultReasoningEffort: 'high',
      }],
      agents: [],
      modes: [], // true-sync: the adapter omits permission modes — no native mid-session switch
    }),
  });

  assert(visible(env.el('modelPick')) && !env.el('modelPick').disabled, 'true-sync model picker stays actionable (/model is injectable)');
  assert(visible(env.el('effortPick')) && !env.el('effortPick').disabled, 'true-sync effort picker stays actionable (/effort is injectable)');
  assert(visible(env.el('modePick')), 'true-sync permission mode stays visible from currentMode (not hidden)');
  assert(env.el('modePick').disabled, 'true-sync permission mode picker is locked — no enabled picker the adapter ignores');
  assert(text(env.el('modePick')).includes('auto'), 'locked mode picker shows the current permission mode value');
  assert(text(env.el('statusMode')).includes('auto'), 'statusline shows the current permission mode');

  env.el('input').value = 'drive a turn';
  env.el('send').onclick?.({});
  const sent = env.sockets[0]?.sent.map((raw) => JSON.parse(raw)).find((m) => m.kind === 'prompt');
  assert(sent && !('permissionMode' in sent), 'true-sync prompt payload omits permission mode the adapter cannot apply');
});

await test('answer-only sync (Claude hooks): model/effort/mode pickers are VISIBLE but LOCKED (no inject path)', async () => {
  // An answer-only synced session can answer cards but cannot inject a /model or /effort change (the channel
  // that would carry it is archived). The pickers must therefore show the current value READ-ONLY — not be
  // clickable no-ops. This guards the canPromptFromControl gate on the pickers (regression: they previously
  // gated on canSendFromControl, which is true for answer-only, so they opened and "accepted" inert selections).
  const env = loadApp();
  const s = session({
    id: 'claude-answeronly-pickers',
    tool: 'claude',
    currentModel: { providerID: 'anthropic', modelID: 'opus', reasoningEffort: 'high' },
    currentMode: 'auto',
    control: {
      drive: { supported: false, state: 'unavailable', reason: 'Synced through hooks.' },
      terminalSync: { supported: true, syncAvailable: true, active: true, input: 'answer-only', label: 'Synced via hooks' },
    },
  });
  await env.api.attach(s);
  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'options',
      models: [{ providerID: 'anthropic', modelID: 'opus', label: 'Claude Opus', reasoningEfforts: [{ effort: 'high', label: 'High' }, { effort: 'max', label: 'Max' }], defaultReasoningEffort: 'high' }],
      agents: [],
      modes: [{ value: 'auto', label: 'Auto' }, { value: 'plan', label: 'Plan' }],
    }),
  });
  await flushMicrotasks(8);

  // visible (so the current model/mode are shown) but disabled (answer-only can't apply a change).
  assert(visible(env.el('modelPick')) && env.el('modelPick').disabled, 'answer-only model picker must be visible but LOCKED');
  assert(visible(env.el('modePick')) && env.el('modePick').disabled, 'answer-only mode picker must be visible but LOCKED');
  assert(env.el('effortPick').disabled, 'answer-only effort picker must be LOCKED');
  assert(text(env.el('modelPick')).includes('Opus') || text(env.el('modelPick')).includes('opus'), 'locked model picker still shows the current model');

  // Clicking a locked picker must NOT open the option menu (it routes through the read-only block, not openPicker).
  const before = env.sockets[0]?.sent.length ?? 0;
  env.el('modelPick').onclick?.({});
  await flushMicrotasks(4);
  assert((env.document.querySelector('#optmenu')?.style.display ?? 'none') === 'none', 'clicking a locked answer-only model picker must not open the option menu');
  assert((env.sockets[0]?.sent.length ?? 0) === before, 'clicking a locked picker sends nothing');
});

await test('assistant markdown tables render as table elements with inline formatting', () => {
  const env = loadApp();
  env.api.render({
    type: 'model-output',
    key: 'table-output',
    text: '| File | Status |\n| --- | :---: |\n| app.js | **ok** |',
  });

  const table = env.document.querySelector('.md-table');
  assert(table, 'markdown table should render as a real table');
  assert(table.textContent.includes('File') && table.textContent.includes('app.js'), 'table cells should preserve content');
  assert(table.querySelector('strong')?.textContent === 'ok', 'table cells should still run inline markdown formatting');
});

await test('fenced code blocks keep language labels and highlight tokens', () => {
  const env = loadApp();
  env.api.render({
    type: 'model-output',
    key: 'code-output',
    text: '```js\nconst answer = 42\n```',
  });

  const pre = env.document.querySelector('pre.cb[data-lang="js"]');
  assert(pre, 'fenced code should carry the language label for CSS display');
  assert(pre.querySelector('.k')?.textContent === 'const', 'keyword token should be highlighted');
  assert(pre.querySelector('.n')?.textContent === '42', 'number token should be highlighted');
});

await test('goal and background activity render as live bars and clear on terminal states', () => {
  const env = loadApp();
  env.api.render({ type: 'goal-state', key: 'g1', status: 'active', title: 'Ship feature', startedAt: NOW - 5_000 });
  assert(visible(env.el('sessionBars')), 'session bars row should show after active goal');
  assert(text(env.document.querySelector('.livebar.goal .label')) === 'Pursuing goal', 'goal bar should use the canonical label');

  env.api.render({
    type: 'agent-activity',
    key: 'sub1',
    kind: 'subagent',
    status: 'running',
    title: 'Review implementation',
    subtitle: 'Claude Code',
    startedAt: NOW - 2_000,
    agentsDone: 1,
    agentsTotal: 4,
    tokens: { output: 1234 },
    toolCalls: 3,
  });
  assert(env.document.querySelector('.livebar.activity'), 'running agent activity should render a live activity bar');
  assert(!env.document.querySelector('#thread .livebar'), 'activity bars must not be appended into the transcript thread');
  assert(!env.document.getElementById('act-sub1'), 'legacy activity transcript card should not be present');

  env.api.render({ type: 'agent-activity', key: 'sub1', kind: 'subagent', status: 'done' });
  assert(!env.document.querySelector('.livebar.activity'), 'done agent activity should remove its live bar');
  assert(env.document.querySelector('.livebar.goal'), 'goal bar should remain after activity completes');

  env.api.render({
    type: 'agent-activity',
    key: 'wf-ultracode',
    kind: 'workflow',
    status: 'running',
    title: 'UltraCode implementation pass',
    subtitle: 'Claude Code workflow',
    startedAt: NOW - 3_000,
    agentsDone: 2,
    agentsTotal: 5,
    tokens: { output: 2450 },
    toolCalls: 7,
  });
  assert(text(env.document.querySelector('.livebar.activity .label')) === 'Background workflow', 'workflow activity should use the UltraCode/workflow label');
  assert(text(env.document.querySelector('.livebar.activity .title')) === 'UltraCode implementation pass', 'workflow activity should render its workflow title');
  assert(text(env.document.querySelector('.livebar.activity .detail')).includes('2/5 agents'), 'workflow activity should render agent progress');

  env.api.render({ type: 'agent-activity', key: 'wf-ultracode', kind: 'workflow', status: 'done' });
  assert(!env.document.querySelector('.livebar.activity'), 'done workflow activity should remove its live bar');
  assert(!env.document.getElementById('act-wf-ultracode'), 'done workflow activity should not leave a transcript card');

  // A LIVE done transition removes the bar and leaves a chronological note (replayed transitions
  // are covered by the dedicated goal-state UX test below: bar-only, no note).
  env.api.render({ type: 'goal-state', key: 'g1', status: 'done', title: 'Ship feature', elapsedMs: 5_000, startedAt: NOW - 5_000 }, true);
  assert(!env.document.querySelector('.livebar.goal'), 'done goal should remove its live bar');
  assert(!visible(env.el('sessionBars')), 'session bars row should hide when no bars remain');
  assert(env.el('thread').textContent.includes('Goal achieved in 5s: Ship feature'), 'live done goal should leave a concise terminal note');
});

await test('slash-command dispatch shows an elapsed bar until the turn resolves (/compact feedback)', () => {
  const env = loadApp();
  const api = env.api as any;
  api.startCommandBar('compact', '');
  assert(visible(env.el('sessionBars')), 'dispatching /compact should show the session-bars row');
  const bar = env.document.querySelector('.livebar.activity');
  assert(bar, 'a command bar should render while the command runs');
  assert(text(bar.querySelector('.title')) === '/compact', 'the bar names the running command');
  assert(text(bar.querySelector('.label')) === 'Running command', 'the bar uses the command label');

  // The bar tracks the command TURN: running while the turn runs, cleared on idle — the command's
  // reply text/notice (mapped from the CLI's local-command output) is the durable feedback. A bar
  // that outlives idle waits for a notice that may never come (round-4: "runs indefinitely").
  api.render({ type: 'status', status: 'running' });
  assert(env.document.querySelector('.livebar.activity'), 'the bar survives while the command turn runs');
  api.render({ type: 'status', status: 'idle' });
  assert(!env.document.querySelector('.livebar.activity'), 'idle clears the command bar (the turn is over)');
  api.startCommandBar('compact', '');
  api.render({ type: 'notice', message: 'Compacted the conversation.' });
  assert(!env.document.querySelector('.livebar.activity'), 'notice also clears the command bar');
  assert(env.el('thread').textContent.includes('Compacted the conversation.'), 'notice should render as a system note');

  // stop/abort are instant interrupts — no bar.
  api.startCommandBar('stop', '');
  assert(!env.document.querySelector('.livebar.activity'), 'stop must not show a command bar');
});

await test('subagent activity upserts progress into its spawning tool block and persists when done', () => {
  const env = loadApp();
  // The Task/Agent tool_use renders a normal tool block at its true thread position…
  env.api.render({ type: 'tool-call', callId: 'toolu_SUB', toolName: 'Task', args: { description: 'Investigate flaky test' } });
  const block = env.document.getElementById('tool-toolu_SUB');
  assert(block, 'the spawning Task tool block should exist');
  // …and the correlated agent-activity (key agent:<toolUseId>) enriches THAT block while running.
  env.api.render({
    type: 'agent-activity',
    key: 'agent:toolu_SUB',
    kind: 'subagent',
    status: 'running',
    title: 'Investigate flaky test',
    subtitle: 'general-purpose',
    elapsedMs: 30_000,
    tokens: { output: 333 },
    agentsDone: 0,
    agentsTotal: 1,
  });
  const meta = block.querySelector('.subagentMeta');
  assert(meta, 'running subagent should upsert a progress line into its tool block');
  assert(text(meta).includes('general-purpose'), 'progress line should name the agent type');
  assert(text(meta).includes('running…'), 'progress line should read running while the subagent works');
  assert(env.document.querySelector('.livebar.activity'), 'the top activity bar should also show while running');

  // Completion: the bar goes away, but the tool block keeps a durable rollup (the issues-part1
  // "subagents are not displayed" fix — done work must stay visible in the transcript).
  env.api.render({
    type: 'agent-activity',
    key: 'agent:toolu_SUB',
    kind: 'subagent',
    status: 'done',
    subtitle: 'general-purpose',
    elapsedMs: 245_000,
    tokens: { output: 12_400 },
    agentsDone: 1,
    agentsTotal: 1,
  });
  assert(!env.document.querySelector('.livebar.activity'), 'done subagent should remove its live bar');
  const metaDone = env.document.getElementById('tool-toolu_SUB')?.querySelector('.subagentMeta');
  assert(metaDone, 'done subagent must keep its rollup line in the tool block');
  assert(text(metaDone).includes('✓ done'), 'rollup should read done');
  assert(text(metaDone).includes('4m 5s'), 'rollup should keep the elapsed time');
  // A workflow activity (no spawning tool block — its tool_use is suppressed) must not throw.
  env.api.render({ type: 'agent-activity', key: 'wf:none', kind: 'workflow', status: 'running', title: 'wf' });
  env.api.render({ type: 'agent-activity', key: 'wf:none', kind: 'workflow', status: 'done', title: 'wf' });
});

await test('task-list-state renders as one upserted panel and clears by key', () => {
  const env = loadApp();
  env.api.render({
    type: 'task-list-state',
    key: 'main',
    title: 'Tasks',
    status: 'running',
    sourceTool: 'TodoWrite',
    items: [
      { id: '1', title: 'Verify native event shape', status: 'done' },
      { id: '2', title: 'Write regression test', status: 'in-progress' },
      { id: '3', title: 'Map TodoWrite payload', status: 'open' },
      { id: '4', title: 'Add app renderer', status: 'open', detail: 'No transcript stack' },
    ],
  });

  assert(visible(env.el('sessionBars')), 'task list should show the session bars row');
  assert(env.document.querySelectorAll('.tasklist').length === 1, 'first frame should render one task list panel');
  assert(text(env.document.querySelector('.tasklist .tl-label')) === 'Tasks', 'task list should use the provided title');
  assert(text(env.document.querySelector('.tasklist .tl-summary')) === '4 tasks: 1 done, 1 in progress, 2 open', 'summary should count task statuses');
  assert(text(env.document.querySelector('.tasklist .tl-active')).includes('In progress: Write regression test'), 'header should surface the active task');
  assert(text(env.document.querySelector('.tasklist .tl-source')) === 'TodoWrite', 'source chip should render for rollout diagnostics');
  assert(env.api.getState().taskLists.size === 1, 'test API should expose one task-list state entry');
  (env.document.querySelector('.tasklist') as unknown as { open: boolean }).open = false;
  env.api.render({ type: 'goal-state', key: 'g1', status: 'active', title: 'Keep timer alive', startedAt: NOW - 1_000 });
  assert((env.document.querySelector('.tasklist') as unknown as { open: boolean }).open === false, 'live-bar rerenders should preserve collapsed task-list panels');

  env.api.render({
    type: 'task-list-state',
    key: 'main',
    status: 'done',
    items: [
      { id: '1', title: 'Verify native event shape', status: 'done' },
      { id: '2', title: 'Write regression test', status: 'done' },
    ],
  });
  assert(env.document.querySelectorAll('.tasklist').length === 1, 'second frame with the same key should upsert, not append');
  assert(text(env.document.querySelector('.tasklist .tl-summary')) === '2 tasks: 2 done, 0 in progress, 0 open', 'upsert should refresh counts');
  assert(env.document.querySelector('.tasklist')?.classList.contains('done'), 'done task list should remain visible but be marked terminal');
  assert(!env.document.querySelector('.tasklist .tl-active'), 'done task list should not show an active item');

  env.api.render({ type: 'goal-state', key: 'g1', status: 'cleared' });
  env.api.render({ type: 'task-list-state', key: 'main', status: 'cleared', items: [] });
  assert(!env.document.querySelector('.tasklist'), 'cleared frame should remove the task list');
  assert(!visible(env.el('sessionBars')), 'session bars row should hide after the last task list clears');
});

await test('plan task-list exposes approve edit and exit actions as semantic plan-action frames', async () => {
  const env = loadApp();
  await env.api.attach(session({
    id: 'plan-actions',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, active: false },
    },
  }));
  env.api.render({
    type: 'task-list-state',
    key: 'codex:plan',
    title: 'Plan',
    status: 'running',
    sourceTool: 'update_plan',
    semantic: {
      kind: 'plan',
      planKey: 'codex:plan',
      revision: 'rev-1',
      state: 'proposed',
      actions: { approve: true, edit: true, exit: true },
    },
    items: [
      { id: '1', title: 'Inspect native plan shape', status: 'done' },
      { id: '2', title: 'Implement plan actions', status: 'in-progress' },
    ],
  });

  const buttons = [...env.document.querySelectorAll('.tasklist .plan-actions button')];
  assert(buttons.length === 3, 'plan task list should expose approve, revise, and exit controls');
  buttons.find((b) => text(b).includes('Approve'))?.click();

  const approve = env.sockets[0]?.sent.map((raw) => JSON.parse(raw)).find((m) => m.kind === 'plan-action' && m.action === 'approve');
  assert(approve?.planKey === 'codex:plan' && approve?.planRevision === 'rev-1', 'approve should bind the exact semantic plan revision');
  assert(typeof approve?.clientMessageId === 'string', 'plan action should carry an idempotency key');
  assert(!('items' in approve) && !('title' in approve), 'client must not echo mutable plan content as authority');
  assert(!env.sockets[0]?.sent.map((raw) => JSON.parse(raw)).some((m) => m.kind === 'prompt' && /Approve/.test(m.text ?? '')), 'plan approval must not leave the app as an accidental plain prompt');

  buttons.find((b) => text(b).includes('Revise'))?.click();
  const editBox = env.document.querySelector('.modal textarea');
  assert(editBox, 'revise should open a textarea modal');
  editBox.value = '1. Inspect native plan shape\n2. Ship the semantic plan-action channel';
  env.document.querySelector('.modal .mok')?.click();
  await Promise.resolve();
  const edit = env.sockets[0]?.sent.map((raw) => JSON.parse(raw)).find((m) => m.kind === 'plan-action' && m.action === 'edit');
  assert(edit?.text.includes('Ship the semantic plan-action channel'), 'edit should send revised plan text through plan-action');

  buttons.find((b) => text(b).includes('Exit'))?.click();
  const exit = env.sockets[0]?.sent.map((raw) => JSON.parse(raw)).find((m) => m.kind === 'plan-action' && m.action === 'exit');
  assert(exit?.planKey === 'codex:plan', 'exit should send semantic plan-action for the current plan');
});

await test('plan-looking task titles do not create lifecycle actions without typed semantics', () => {
  const env = loadApp();
  env.api.render({
    type: 'task-list-state',
    key: 'generic',
    title: 'Plan rollout',
    status: 'running',
    sourceTool: 'plan_writer',
    items: [{ title: 'Inspect plan', status: 'open' }],
  });
  assert(!env.document.querySelector('.plan-actions'), 'display strings and source names must not classify a task list as a plan');
  env.api.render({
    type: 'task-list-state',
    key: 'malformed-plan',
    status: 'running',
    semantic: { kind: 'plan', planKey: '', revision: {}, state: 'proposed', actions: { approve: true } },
    items: [{ title: 'Malformed additive data', status: 'open' }],
  });
  assert(!env.document.querySelector('.plan-actions'), 'malformed additive plan semantics must degrade to a generic task list');
});

await test('artifact cards keep distinct same-path versions and upsert exact replays', () => {
  const env = loadApp();
  env.api.render({
    type: 'file-artifact',
    name: 'report.html',
    path: 'output/report.html',
    mimeType: 'text/html',
    size: 12,
    artifactKey: 'report-v1',
    contentHash: 'hash-v1',
    url: 'data:text/html;base64,dmVyc2lvbjE=',
  });
  env.api.render({
    type: 'file-artifact',
    name: 'report.html',
    path: 'output/report.html',
    mimeType: 'text/html',
    size: 12,
    artifactKey: 'report-v2',
    contentHash: 'hash-v2',
    url: 'data:text/html;base64,dmVyc2lvbjI=',
  });
  assert(env.document.querySelectorAll('.artifact').length === 2, 'same path with different artifact keys should keep both versions');

  env.api.render({
    type: 'file-artifact',
    name: 'report.html',
    path: 'output/report.html',
    mimeType: 'text/html',
    size: 12,
    artifactKey: 'report-v2',
    contentHash: 'hash-v2',
    url: 'data:text/html;base64,dmVyc2lvbjI=',
  });
  assert(env.document.querySelectorAll('.artifact').length === 2, 'replaying the same artifact key should upsert, not duplicate');
});

await test('lazy non-HTML artifact refs fetch on demand and render a downloadable preview', async () => {
  const env = loadApp();
  await env.api.attach(session());
  env.api.render({
    type: 'file-artifact',
    name: 'report.txt',
    path: 'output/report.txt',
    mimeType: 'text/plain',
    size: 700_000,
    artifactKey: 'report-ref',
    contentHash: 'hash-ref',
    fetchUrl: 'http://127.0.0.1:7734/api/sessions/opencode/s1/artifact/report-ref?expires=1&sig=s',
  });

  const card = env.document.querySelector('.artifact');
  assert(card, 'lazy artifact card should render metadata');
  assert(card.textContent.includes('not downloaded'), 'lazy artifact should not fetch before the user opens it');
  card.querySelector('button')?.click();
  await flushMicrotasks(12);

  assert(env.artifactFetches.length === 1, 'opening a lazy artifact should fetch exactly once');
  assert(card.textContent.includes('cached locally'), 'loaded artifact should show local cache status');
  assert(card.querySelector('a')?.href === 'blob:test-artifact', 'loaded artifact should expose a blob download link');
});

await test('interactive HTML artifact opens directly in CSP-locked sandbox and forwards bridge interactions', async () => {
  const env = loadApp();
  await env.api.attach(session({
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, active: false, label: 'Sync with terminal', command: 'cosyncing sync opencode s1' },
    },
  }));
  const fetchUrl = 'http://127.0.0.1:7734/api/sessions/opencode/s1/artifact/report-html?expires=1&sig=s';
  env.api.render({
    type: 'file-artifact',
    name: 'report.html',
    path: 'output/report.html',
    mimeType: 'text/html',
    size: 700_000,
    artifactKey: 'report-html',
    contentHash: 'hash-html',
    fetchUrl,
    interactionPolicy: {
      mode: 'structured',
      bridgeVersion: 1,
      schemaVersion: 1,
      allowedActions: ['form-submit', 'action'],
      interactionRef: 'v1.9999999999999.signed',
      expiresAt: 9999999999999,
    },
  });

  const card = env.document.querySelector('.artifact');
  assert(card, 'HTML artifact card should render metadata');
  card.querySelector('button')?.click();
  await flushMicrotasks(4);

  const frame = card.querySelector('iframe');
  assert(frame?.src === fetchUrl, 'HTML artifact should render from the signed broker URL, not a blob URL');
  assert(frame?.sandbox === 'allow-scripts allow-forms', 'HTML iframe should keep the tight sandbox');
  assert(env.artifactFetches.length === 0, 'opening an HTML artifact should not prefetch into a blob and lose CSP headers');

  dispatchEvent({
    type: 'message',
    source: frame.contentWindow,
    data: {
      type: 'cosyncing-artifact-interaction',
      bridgeVersion: 1,
      schemaVersion: 1,
      artifactKey: 'report-html',
      interaction: { type: 'form-submit', formId: 'f', data: { answer: '42' } },
    },
  } as any);
  await flushMicrotasks(4);

  const sent = env.sockets[0]?.sent.map((raw) => JSON.parse(raw)).find((m) => m.kind === 'artifact-interaction');
  assert(sent?.artifactKey === 'report-html', 'artifact bridge should forward the artifact key over the session WebSocket');
  assert(sent?.interactionRef === 'v1.9999999999999.signed', 'parent client should add the signed reference without exposing it to artifact JavaScript');
  assert(typeof sent?.clientMessageId === 'string', 'artifact interaction should carry an idempotency key');
  assert(!('session' in sent) && !('model' in sent) && !('permissionMode' in sent), 'artifact interaction must not carry session or prompt-control fields');
  assert(sent?.interaction?.data?.answer === '42', 'artifact bridge should forward structured form data');

  const sentCount = env.sockets[0]?.sent.filter((raw) => JSON.parse(raw).kind === 'artifact-interaction').length;
  dispatchEvent({
    type: 'message',
    origin: 'https://forged.example',
    source: frame.contentWindow,
    data: {
      type: 'cosyncing-artifact-interaction',
      bridgeVersion: 1,
      schemaVersion: 1,
      artifactKey: 'report-html',
      interaction: { type: 'action', action: 'save' },
    },
  } as any);
  assert(env.sockets[0]?.sent.filter((raw) => JSON.parse(raw).kind === 'artifact-interaction').length === sentCount,
    'forged postMessage origin must not be forwarded');
});

await test('older or malformed artifact interaction metadata remains display-only', async () => {
  const env = loadApp();
  await env.api.attach(session({
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  }));
  env.api.render({
    type: 'file-artifact',
    name: 'legacy.html',
    path: 'legacy.html',
    mimeType: 'text/html',
    artifactKey: 'legacy-html',
    fetchUrl: 'http://127.0.0.1:7734/api/sessions/opencode/s1/artifact/legacy-html?expires=1&sig=s',
  });
  const card = env.document.querySelector('.artifact');
  card?.querySelector('button')?.click();
  const frame = card?.querySelector('iframe');
  dispatchEvent({
    type: 'message',
    source: frame?.contentWindow,
    data: {
      type: 'cosyncing-artifact-interaction', bridgeVersion: 1, schemaVersion: 1,
      artifactKey: 'legacy-html', interaction: { type: 'action', action: 'save' },
    },
  } as any);
  assert(!env.sockets[0]?.sent.some((raw) => JSON.parse(raw).kind === 'artifact-interaction'),
    'absent interaction policy from an older broker must fail closed as display-only');
});

await test('keyless error messages upsert by content instead of duplicating on replay', () => {
  const env = loadApp();
  env.api.render({ type: 'error', message: 'API error' }, true);
  env.api.render({ type: 'error', message: 'API error' }, false);

  const notes = env.document.querySelectorAll('.sysnote');
  assert(notes.length === 1, 'same keyless error content should render once across live + replay');
  assert(notes[0]?.textContent.includes('API error'), 'error note should keep the error text');
});

await test('tool-call and tool-result render title, status, chips, and diff detail', () => {
  const env = loadApp();
  env.api.render({ type: 'tool-call', callId: 'bash-1', toolName: 'Bash', title: 'bun test', args: { command: 'bun test' } });
  env.api.render({
    type: 'tool-result',
    callId: 'bash-1',
    toolName: 'Bash',
    title: 'bun test',
    isError: true,
    exitCode: 1,
    additions: 2,
    deletions: 1,
    truncated: true,
    diff: ' context\n-old\n+new\n+more',
  });

  assert(env.document.querySelectorAll('.tool').length === 1, 'tool result should update the existing tool call card');
  assert(text(env.document.querySelector('.tool .name')) === 'bun test', 'tool card should show the friendly title');
  assert(text(env.document.querySelector('.tool .st')) === '✗ error', 'tool status should show error');
  assert(text(env.document.querySelector('.tool .chips')).includes('+2 −1'), 'tool diffstat chip should render');
  assert(text(env.document.querySelector('.tool .chips')).includes('exit 1'), 'tool exit-code chip should render');
  assert(text(env.document.querySelector('.tool .chips')).includes('truncated'), 'tool truncated chip should render');
  assert(env.document.querySelectorAll('.tool pre .dl.add').length === 2, 'diff additions should render with add class');
  assert(env.document.querySelectorAll('.tool pre .dl.del').length === 1, 'diff deletions should render with del class');
});

await test('structured tool payloads render rows before raw JSON disclosure', () => {
  const env = loadApp();
  env.api.render({
    type: 'tool-call',
    callId: 'mcp-1',
    toolName: 'filesystem_write_file',
    args: { path: '/tmp/report.html', content: '<h1>done</h1>', nested: { version: 2 } },
  });
  env.api.render({
    type: 'tool-result',
    callId: 'mcp-1',
    toolName: 'filesystem_write_file',
    result: { status: 'ok', message: 'wrote file', data: { mode: '0644' } },
  });

  const card = env.document.querySelector('.tool');
  assert(card, 'tool card should render');
  assert(text(card.querySelector('.name')) === 'Filesystem Write File report.html', 'tool title should fall back to a readable target summary');
  assert(text(card.querySelector('.tool-row .tool-key')) === 'Path', 'structured input should render key/value rows first');
  assert(card.textContent.includes('/tmp/report.html'), 'structured input should show path without requiring raw JSON');
  assert(card.textContent.includes('<h1>done</h1>'), 'structured input should show scalar content without requiring raw JSON');
  assert(card.textContent.includes('wrote file'), 'structured result should show common message fields');
  assert(card.querySelectorAll('.tool-raw').length === 2, 'raw input/result should remain available behind disclosures');
  assert(text(card.querySelector('.tool-raw summary')) === 'Raw input', 'raw JSON should be explicitly labeled');
});

await test('array tool result payloads render content items as text', () => {
  const env = loadApp();
  env.api.render({
    type: 'tool-result',
    callId: 'dyn-1',
    toolName: 'dynamic_tool',
    result: [
      { type: 'text', text: 'first item' },
      { content: [{ type: 'text', text: 'second item' }] },
    ],
  });

  const card = env.document.querySelector('.tool');
  assert(card, 'tool card should render for array payloads');
  assert(card.textContent.includes('Items2'), 'array payload should render an item count row');
  assert(card.textContent.includes('first item'), 'array text item should render as readable content');
  assert(card.textContent.includes('second item'), 'nested array text item should render as readable content');
});

await test('D9 tool cards default collapsed at every width; manual expansion and duration chips still work', () => {
  const phone = loadApp();
  phone.api.setToolDisplayMode('responsive');
  phone.api.render({ type: 'tool-call', callId: 'edit-phone', toolName: 'Edit', toolClass: 'edit', args: { path: 'app.ts' } });
  assert(phone.document.querySelector('.tool .detail')?.style.display === 'none', 'portrait-phone width keeps mutating tools at Tier-1');

  const wide = loadApp();
  Object.defineProperty(globalThis, 'matchMedia', {
    value: (query: string) => ({ matches: query.includes('min-width'), addEventListener() {}, removeEventListener() {} }),
    configurable: true,
  });
  wide.api.setToolDisplayMode('responsive');
  wide.api.render({ type: 'tool-call', callId: 'exec-wide', toolName: 'Bash', toolClass: 'execute', title: 'bun test', args: { command: 'bun test' } });
  wide.api.render({ type: 'tool-result', callId: 'exec-wide', toolName: 'Bash', toolClass: 'execute', result: 'ok', exitCode: 0, durationMs: 1_540 });
  const exec = wide.document.getElementById('tool-exec-wide')!;
  assert(exec.querySelector('.detail')?.style.display === 'none', 'execute/edit stay collapsed even on wide layouts (owner decision 2026-07-18: no auto-expand)');
  assert(text(exec.querySelector('.chips')).includes('1.5s'), 'native per-tool duration renders as a chip');

  exec.querySelector('.head')!.click();
  assert(exec.querySelector('.detail')?.style.display === 'block', 'a manual click still expands the card');
  wide.api.render({ type: 'tool-result', callId: 'exec-wide', toolName: 'Bash', toolClass: 'execute', result: 'ok', exitCode: 0, durationMs: 1_540 });
  assert(exec.querySelector('.detail')?.style.display === 'block', 'a re-emitted result preserves manual expansion');

  wide.api.render({ type: 'tool-call', callId: 'read-wide', toolName: 'Read', toolClass: 'lookup', args: { path: 'README.md' } });
  assert(wide.document.getElementById('tool-read-wide')!.querySelector('.detail')?.style.display === 'none', 'lookups stay collapsed even on wide layouts');
  wide.api.setToolDisplayMode('collapsed');
  assert(exec.querySelector('.detail')?.style.display === 'none', 'a display-mode switch reapplies collapsed defaults over manual expansion');
});

await test('D9 consecutive lookup calls group-collapse while execute/edit remain distinct', () => {
  const env = loadApp();
  env.api.render({ type: 'user-message', key: 'u-lookups', text: 'inspect it' });
  env.api.render({ type: 'tool-call', callId: 'read-1', toolName: 'Read', toolClass: 'lookup', title: 'Read hub.ts', args: { path: 'hub.ts' } });
  env.api.render({ type: 'tool-result', callId: 'read-1', toolName: 'Read', toolClass: 'lookup', result: 'contents' });
  env.api.render({ type: 'tool-call', callId: 'grep-1', toolName: 'Grep', toolClass: 'lookup', title: 'Grep roster', args: { pattern: 'roster' } });
  const group = env.document.querySelector('.tool-group');
  assert(group, 'the second consecutive lookup promotes the run into one group');
  assert(group!.querySelectorAll('.lookup-body .tool').length === 2, 'both lookup cards live inside the group');
  assert(text(group!.querySelector('.lookup-summary')).includes('2 lookups'), 'the group Tier-1 line reports its count');
  assert(group!.querySelector('.lookup-body')?.style.display === 'none', 'lookup groups default collapsed');

  env.api.render({ type: 'tool-call', callId: 'bash-distinct', toolName: 'Bash', toolClass: 'execute', args: { command: 'bun test' } });
  const execute = env.document.getElementById('tool-bash-distinct')!;
  assert(execute.parentElement === env.el('thread'), 'executing tools remain a distinct top-level card');
  env.api.render({ type: 'tool-call', callId: 'read-after-exec', toolName: 'Read', toolClass: 'lookup', args: { path: 'next.ts' } });
  assert(env.document.querySelectorAll('.tool-group').length === 1, 'a lookup after an execute starts a new run instead of joining the earlier group');

  // A session/history reset can clear the DOM before any user message arrives. The cached run must
  // not steal the first cards in the replacement transcript into a detached group.
  env.el('thread').innerHTML = '';
  env.api.render({ type: 'tool-call', callId: 'fresh-read', toolName: 'Read', toolClass: 'lookup', args: { path: 'fresh.ts' } });
  env.api.render({ type: 'tool-call', callId: 'fresh-grep', toolName: 'Grep', toolClass: 'lookup', args: { pattern: 'fresh' } });
  assert(env.document.querySelectorAll('.tool-group').length === 1, 'lookup grouping restarts inside the replacement transcript');
  const replacementGroup = env.el('thread').querySelector('.tool-group');
  assert(replacementGroup?.querySelectorAll('.lookup-body .tool').length === 2, 'replacement lookup cards remain attached to the thread');
});

await test('D9 tool output caps at 40 lines / 4KB and Show all restores the full result', () => {
  const env = loadApp();
  const output = Array.from({ length: 60 }, (_, i) => `line-${String(i).padStart(2, '0')} ${'x'.repeat(110)}`).join('\n');
  env.api.render({ type: 'tool-result', callId: 'long-output', toolName: 'Bash', toolClass: 'execute', result: output });
  const pre = env.document.querySelector('#tool-long-output .tool-section pre')!;
  assert(pre.textContent.split('\n').length <= 40, `preview must be at most 40 lines, got ${pre.textContent.split('\n').length}`);
  assert(new TextEncoder().encode(pre.textContent).byteLength <= 4096, 'preview must be at most 4KB');
  assert(pre.textContent.includes('line-59') && !pre.textContent.includes('line-00'), 'command output preview keeps the tail');
  const showAll = env.document.querySelector('#tool-long-output .tool-show-all')!;
  assert(text(showAll).startsWith('Show all'), 'truncated output offers a Show all control');
  showAll.click();
  assert(pre.textContent === output, 'Show all restores the exact full output');
  assert(text(showAll) === 'Show preview', 'expanded output can return to its capped preview');
});

await test('D9 final-only mode keeps the final assistant message per turn and hides work via one global class', () => {
  const env = loadApp();
  env.api.render({ type: 'user-message', key: 'u-1', text: 'first turn' });
  env.api.render({ type: 'model-output', key: 'a-1', text: 'preamble' });
  env.api.render({ type: 'thinking', key: 't-1', text: 'reasoning' });
  env.api.render({ type: 'tool-call', callId: 'tool-final', toolName: 'Read', toolClass: 'lookup', args: { path: 'a.ts' } });
  env.api.render({ type: 'user-message', key: 'u-2', text: 'queued next turn', queued: true });
  env.api.render({ type: 'model-output', key: 'a-2', text: 'first final' });
  env.api.render({ type: 'user-message', key: 'u-2', text: 'queued next turn' });
  env.api.render({ type: 'model-output', key: 'a-3', text: 'second final' });
  env.api.setToolDisplayMode('final-only');

  const assistant = env.document.querySelectorAll('.msg.assistant');
  assert(assistant.length === 3, 'all transcript data remains available in the DOM');
  assert(!assistant[0]!.classList.contains('turn-final'), 'an earlier assistant preamble is not the turn final, even when the next prompt was already queued');
  assert(assistant[1]!.classList.contains('turn-final') && assistant[2]!.classList.contains('turn-final'), 'the last assistant message of each turn is marked final');
  assert(env.document.body.classList.contains('tool-display-final'), 'one global mode class drives tool/thinking/activity hiding');
  assert(localStorage.getItem('cosyncing.toolDisplay') === 'final-only', 'the mode persists per device');
});

await test('pending input cards are read-only in Observe and actionable only when mutable', async () => {
  const observed = loadApp();
  await observed.api.attach(session());
  observed.api.render({ type: 'permission-request', requestId: 'p1', title: 'Run shell', detail: 'bash test' });
  const readOnlyCard = observed.document.getElementById('perm-p1');
  assert(readOnlyCard, 'observe permission card should render');
  assert(readOnlyCard.classList.contains('readonly'), 'observe permission card should be read-only');
  assert(!readOnlyCard.querySelector('.acts'), 'read-only permission card should not render action buttons');
  assert(readOnlyCard.textContent.includes('Waiting for input: Run shell'), 'read-only permission card should still explain the pending input');

  const mutable = loadApp();
  await mutable.api.attach(session({
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, active: false },
    },
  }));
  mutable.api.render({ type: 'permission-request', requestId: 'p2', title: 'Run shell', toolName: 'bash' });
  const card = mutable.document.getElementById('perm-p2');
  assert(card && !card.classList.contains('readonly'), 'mutable permission card should be actionable');
  card.querySelector('.ok')?.click();
  assert(mutable.sockets[0]?.sent.some((msg) => msg.includes('"kind":"approve"') && msg.includes('"requestId":"p2"')), 'approval button should send an approve frame');
});

await test('question cards answer through the question channel and clear on resolve', async () => {
  const observed = loadApp();
  await observed.api.attach(session());
  observed.api.render({
    type: 'question-request',
    requestId: 'q1',
    questions: [{ question: 'Proceed?', header: 'Decision', options: [{ label: 'Yes', description: 'Continue' }] }],
  });
  const readOnlyQuestion = observed.document.getElementById('q-q1');
  assert(readOnlyQuestion, 'observe question card should render');
  assert(readOnlyQuestion.classList.contains('readonly'), 'observe question card should be read-only');
  assert(readOnlyQuestion.querySelector('.qopt')?.disabled, 'read-only question options should be disabled');
  observed.api.render({ type: 'question-resolved', requestId: 'q1' });
  assert(!observed.document.getElementById('q-q1'), 'question-resolved should remove the question card');

  const mutable = loadApp();
  await mutable.api.attach(session({
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, active: false },
    },
  }));
  mutable.api.render({
    type: 'question-request',
    requestId: 'q2',
    questions: [{ question: 'Ship it?', header: 'Decision', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  mutable.document.querySelector('#q-q2 .qopt')?.click();
  mutable.document.querySelector('#q-q2 .ok')?.click();
  assert(
    mutable.sockets[0]?.sent.some((msg) => msg.includes('"kind":"answer"') && msg.includes('"requestId":"q2"') && msg.includes('"answers":[["Yes"]]')),
    'question submit should send the dedicated answer frame with selected labels',
  );
  assert(!mutable.document.getElementById('q-q2'), 'submitted question should clear immediately');
});

await test('goal state pins an actionable session bar; transition notes are live-only', async () => {
  // Replay (observe): a paused goal from long ago pins a bar with FROZEN used-time — no in-thread
  // note under the newest bubble (that would misdate the transition), no actions without drive.
  const observed = loadApp();
  await observed.api.attach(session());
  observed.api.render({ type: 'goal-state', key: 'g1', status: 'paused', title: 'resume the last goal', elapsedMs: 9_000 });
  const bar = observed.document.querySelector('.livebar.goal.paused');
  assert(bar, 'replayed paused goal should pin a session bar');
  assert(text(bar!.querySelector('.label')) === 'Goal paused', 'paused goal bar should be labeled Goal paused');
  assert(text(bar!.querySelector('.elapsed')) === '9s', 'paused goal bar should show frozen used-time, not a ticking clock');
  assert(!observed.document.querySelector('.sysnote'), 'replayed transitions must not add an in-thread note');
  // Actions stay visible in Observe for discoverability but are gated: readonly styling, and a
  // click produces the standard take-control toast instead of a command frame.
  const observedActions = bar!.querySelector('.baractions');
  assert(observedActions, 'goal actions should render in Observe for discoverability');
  assert(observedActions!.classList.contains('readonly'), 'observe goal actions should carry readonly styling');
  const sentBefore = observed.sockets[0]?.sent.length ?? 0;
  observedActions!.querySelectorAll('button').find((b) => text(b) === 'Resume')?.click();
  assert((observed.sockets[0]?.sent.length ?? 0) === sentBefore, 'observe goal action click must not send a command frame');

  // The same transition arriving LIVE earns a chronological transcript note (and keeps the bar).
  observed.api.render({ type: 'goal-state', key: 'g1', status: 'paused', title: 'resume the last goal', elapsedMs: 9_000 }, true);
  assert(observed.el('thread').textContent.includes('Goal paused in 9s: resume the last goal'), 'live pause should leave a transition note');
  assert(observed.document.querySelector('.livebar.goal.paused'), 'live pause should keep the pinned bar');

  // Driving with /goal advertised: bar actions dispatch the agent-native command.
  const mutable = loadApp();
  await mutable.api.attach(session({
    control: { drive: { supported: true, state: 'driving' }, terminalSync: { supported: true, active: false } },
  }));
  mutable.sockets[0]?.onmessage?.({ data: JSON.stringify({ kind: 'commands', commands: [{ name: 'goal', kind: 'action' }] }) });
  mutable.api.render({ type: 'goal-state', key: 'g1', status: 'paused', title: 'ship it', elapsedMs: 9_000 });
  const actions = mutable.document.querySelector('.livebar.goal .baractions');
  assert(actions, 'driving + advertised /goal should render bar actions');
  assert(!actions!.classList.contains('readonly'), 'driving goal actions should not be readonly-styled');
  const resume = actions!.querySelectorAll('button').find((b) => text(b) === 'Resume');
  assert(resume, 'paused goal should offer Resume');
  resume!.click();
  assert(
    mutable.sockets[0]?.sent.some((msg) => msg.includes('"kind":"command"') && msg.includes('"name":"goal"') && msg.includes('"args":"resume"')),
    'Resume must dispatch the native /goal resume command',
  );
});

await test('model picker enables from a LATE options frame on a fresh drivable session (new-session regression)', async () => {
  // PERMANENT guard for the recurring "no model selection for a newly created session" report: a
  // freshly created+attached session may receive its options frame SECONDS after attach (backing
  // service still starting). The picker must enable purely from that frame — no prompt, no
  // reattach, no other user action.
  const env = loadApp();
  await env.api.attach(session({
    control: { drive: { supported: true, state: 'driving' }, terminalSync: { supported: true, active: false } },
  }));
  const mp = env.document.getElementById('modelPick');
  assert(mp, 'model picker element should exist');
  env.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      kind: 'options',
      models: [{ providerID: 'p', modelID: 'm-default', label: 'Default Model' }],
      agents: [],
      modes: [],
    }),
  });
  assert(mp!.style.display !== 'none', 'picker should be visible once options arrive');
  assert(!mp!.disabled, 'picker should be ENABLED before any first message');
});

// The shim's setTimeout is a single queueMicrotask, so "waiting" means draining the microtask
// queue enough times for a multi-await chain (attach) to complete deterministically.
async function drainMicrotasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

await test('returning to a backgrounded tab reattaches a dead stream with the same mode; ended sessions stay ended (issues-part3 #39)', async () => {
  const env = loadApp();
  const control = { drive: { supported: true, state: 'driving' }, terminalSync: { supported: false, active: false } };
  const s = claudeSession({ id: 'resync-1', control });
  env.setSessions([s]);
  await env.api.attach(s, 'resume');
  const before = env.sockets.length;
  const rosterCallsBefore = env.requests.filter((r) => r.url.includes('/api/sessions') && r.method === 'GET').length;

  // A live socket must NOT be churned by a focus/visibility event — only the roster refreshes.
  env.api.resyncAfterReturn();
  await drainMicrotasks();
  assert(env.sockets.length === before, 'a healthy stream must not be reopened on focus');

  // The browser froze the tab and killed the socket underneath us → resync must reopen it, same mode.
  env.sockets.at(-1)!.readyState = 3;
  env.api.resyncAfterReturn();
  await drainMicrotasks();
  assert(env.sockets.length === before + 1, 'a dead stream must be reopened when the user returns');
  assert(env.sockets.at(-1)!.url.includes('/stream') && env.sockets.at(-1)!.url.includes('resync-1'), `fresh socket must target the same session: ${env.sockets.at(-1)!.url}`);
  assert(env.sockets.at(-1)!.url.includes('mode=resume'), 'the resync must reopen with the SAME mode as the original attach');
  const rosterCallsAfter = env.requests.filter((r) => r.url.includes('/api/sessions') && r.method === 'GET').length;
  assert(rosterCallsAfter > rosterCallsBefore, 'a resync must refresh the roster immediately (background timers are throttled)');

  // A session the broker declared ENDED closed its socket on purpose — never resurrect it on focus.
  env.sockets.at(-1)!.onmessage?.({ data: JSON.stringify({ kind: 'ended', reason: 'done' }) });
  const afterEnded = env.sockets.length;
  env.api.resyncAfterReturn();
  await drainMicrotasks();
  assert(env.sockets.length === afterEnded, 'an ended session must not be resurrected by the visibility resync');
});

await test('permission mode rides prompts only after an explicit pick; undirty follows backend updates (issues-part3 #37)', async () => {
  const env = loadApp();
  const control = { drive: { supported: true, state: 'driving' }, terminalSync: { supported: false, active: false } };
  const s = claudeSession({ id: 'mode-dirty-1', currentMode: 'ask-permission', control });
  await env.api.attach(s, 'resume');
  // Target THIS test's stream socket explicitly — an unawaited attach from a prior test can land an
  // extra socket in the array, so positional indexing is not stable.
  const promptSock = () => env.sockets.find((sk) => sk.url.includes('mode-dirty-1'))!;
  const prompts = () => promptSock().sent.map((raw) => JSON.parse(raw)).filter((m) => m.kind === 'prompt');
  promptSock().onmessage?.({
    data: JSON.stringify({
      kind: 'options',
      models: [],
      agents: [],
      modes: [
        { value: 'ask-permission', label: 'Ask permission' },
        { value: 'approve-for-me', label: 'Approve for me' },
        { value: 'full-access', label: 'Full access' },
      ],
    }),
  });

  // 1. No pick: the prompt must NOT re-assert the open-time mode over backend state — that echo is
  //    exactly what used to clobber a synced codex terminal's approve-for-me back to "ask" per send.
  env.el('input').value = 'no pick yet';
  env.el('send').onclick?.({});
  assert(prompts().length === 1 && prompts()[0]!.permissionMode === undefined, 'undirty mode must not ride the prompt');

  // 2. A backend mode change (e.g. picked in the synced terminal) must update the picker while undirty…
  promptSock().onmessage?.({ data: JSON.stringify({ kind: 'session', info: { ...s, currentMode: 'full-access' } }) });
  assert(text(env.el('modePick')).includes('Full access'), `undirty picker should follow the backend mode, got: ${text(env.el('modePick'))}`);
  env.el('input').value = 'still no pick';
  env.el('send').onclick?.({});
  assert(prompts().length === 2 && prompts()[1]!.permissionMode === undefined, 'backend-updated mode is still undirty and must not ride');

  // 3. An explicit pick becomes dirty: it rides prompts and pushed frames no longer clobber it.
  env.el('modePick').onclick?.({});
  const pick = env.el('optmenu').querySelectorAll('.oitem').find((x) => text(x).includes('Approve for me'));
  assert(pick, 'mode picker should list the approve-for-me option');
  pick!.onclick?.({});
  env.el('input').value = 'after explicit pick';
  env.el('send').onclick?.({});
  assert(prompts().length === 3 && prompts()[2]!.permissionMode === 'approve-for-me', `explicit pick must ride the prompt, got: ${JSON.stringify(prompts()[2])}`);
  promptSock().onmessage?.({ data: JSON.stringify({ kind: 'session', info: { ...s, currentMode: 'ask-permission' } }) });
  env.el('input').value = 'pick survives pushed frames';
  env.el('send').onclick?.({});
  assert(prompts().length === 4 && prompts()[3]!.permissionMode === 'approve-for-me', 'a pushed frame must not clobber a dirty pick');
});

await test("a session switch never leaks the previous composer's draft into the new session (issues-part2 item-14 follow-up)", async () => {
  const env = loadApp();
  const control = { drive: { supported: true, state: 'driving' }, terminalSync: { supported: false, active: false } };
  const a = claudeSession({ id: 'draft-leak-a', control });
  const b = claudeSession({ id: 'draft-leak-b', control });
  env.setSessions([a, b]);
  await env.api.attach(a, 'resume');
  await drainMicrotasks();

  // Type in session A — a draft debounce is now pending — then switch to B before it fires.
  env.el('input').value = 'secret plan typed in session A';
  env.el('input').dispatchEvent({ type: 'input' });
  await env.api.attach(b, 'resume');
  await drainMicrotasks();

  // The visible half of the leak: A's text must not sit in B's composer waiting to be sent/synced.
  assert(env.el('input').value === '', `switching sessions must clear the composer, got: ${env.el('input').value}`);

  // The wire half: continuing to type in B must sync ONLY B's text — before the fix the persisted
  // A-text rode B's draft frame and fanned out to B's other clients ("one session's draft
  // propagates to another session and causes divergence").
  env.el('input').value = env.el('input').value + 'hello B';
  env.el('input').dispatchEvent({ type: 'input' });
  await drainMicrotasks();
  const bSock = env.sockets.find((sk) => sk.url.includes('draft-leak-b'))!;
  const bDrafts = bSock.sent.map((raw: string) => JSON.parse(raw)).filter((m: { kind: string }) => m.kind === 'draft');
  assert(!bDrafts.some((d: { text?: string }) => String(d.text ?? '').includes('secret plan typed in session A')),
    `session A's text must never ship as session B's draft: ${JSON.stringify(bDrafts)}`);

  // B's own replayed draft must still land (the typing-recency guard belonged to A's composer).
  env.el('input').value = '';
  bSock.onmessage?.({ data: JSON.stringify({ kind: 'draft', text: 'draft replayed for B' }) });
  assert(env.el('input').value === 'draft replayed for B', "B's replayed draft must populate the composer after a switch");

  // A SAME-session reattach (the visibility resync path) must keep in-progress typing.
  env.el('input').value = 'typing kept across reattach';
  env.el('input').dispatchEvent({ type: 'input' });
  await env.api.attach(b, 'resume');
  await drainMicrotasks();
  assert(env.el('input').value === 'typing kept across reattach', 'a same-session reattach must not clear the composer');
});

await test('refresh keeps drive: a driving #resume overlay on the roster row must not clean the sticky intent (item 13.1b)', async () => {
  const env = loadApp();
  // The mid-grace roster shape right after a refresh: the old drive conn (`claude:<id>#resume`)
  // survives the Hub's 15s grace and the live overlay stamps drive:'driving' + attachMode:'resume'
  // onto the row. Before the fix the stale-intent cleanup treated that like an opencode
  // bare-mutable row: intent deleted, session reopened OBSERVE — drive lost on every refresh, and
  // the next Take-over could mint yet another fork.
  const s = claudeSession({
    id: 'refresh-keeps-drive',
    attachMode: 'resume',
    control: { drive: { supported: true, state: 'driving' }, terminalSync: { supported: false, active: false } },
  });
  localStorage.setItem(`cosyncing:driving:${s.tool}:${s.id}`, String(NOW - 60_000));
  await env.api.attach(s); // the post-refresh click — no explicit mode
  const sock = env.sockets.find((sk) => sk.url.includes('refresh-keeps-drive'))!;
  assert(sock.url.includes('mode=resume'), `post-refresh open must resume the drive, got ${sock.url}`);
  assert(localStorage.getItem(`cosyncing:driving:${s.tool}:${s.id}`) !== null, 'the sticky intent must survive — only rows mutable on a BARE attach may clean it');
});

await test('pressing Copy on the terminal-handoff dialog demotes the tab to observation (item 13.1a)', async () => {
  const env = loadApp();
  const s = claudeSession({
    id: 'copy-demotes',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: false, syncAvailable: false, active: false, label: 'Resume in terminal', command: 'cd /w && claude --resume abc' },
    },
  });
  localStorage.setItem(`cosyncing:driving:${s.tool}:${s.id}`, String(NOW));
  await env.api.attach(s, 'resume');
  await drainMicrotasks();
  const before = env.sockets.length;
  env.el('control').onclick?.({}); // opens the handoff dialog (async)
  await drainMicrotasks();
  const okBtn = env.document.querySelector('.mok');
  assert(okBtn, 'handoff dialog should render with a Copy command button');
  okBtn!.onclick?.({});
  await drainMicrotasks();
  // Copy = "I'll continue in the terminal": the tab must reattach OBSERVE so the broker-owned drive
  // process cannot contest ownership (or fork) against the user's terminal resume.
  const last = env.sockets.at(-1)!;
  assert(env.sockets.length > before && last.url.includes('copy-demotes') && !last.url.includes('mode=resume'),
    `copy must reattach in OBSERVE mode, got ${last.url}`);
  assert(localStorage.getItem(`cosyncing:driving:${s.tool}:${s.id}`) === null, 'copy must clear the sticky driving intent');
});

await test('handoff copy dialog supports supported=true/action=handoff and keeps transfer wording', async () => {
  const env = loadApp();
  const s = session({
    id: 'handoff-supported-true',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: {
        supported: true,
        syncAvailable: false,
        active: false,
        action: 'handoff',
        presence: 'absent',
        label: 'Resume in terminal',
        command: 'cd /tmp && /bin/echo continue',
      },
    },
  });
  localStorage.setItem(`cosyncing:driving:${s.tool}:${s.id}`, String(NOW));
  await env.api.attach(s, 'resume');
  await drainMicrotasks();
  env.el('control').onclick?.({});
  await drainMicrotasks();
  const modal = env.document.querySelector('.modal');
  assert(modal, 'supported=true handoff must open a copy dialog');
  assert(modal && text(modal).toLowerCase().includes('this command transfers control to the terminal'), 'handoff copy body should use generic transfer wording');
  assert(modal && !text(modal).toLowerCase().includes('no live terminal sync'), 'supported=true handoff should not force no-live-sync wording');
  const okBtn = env.document.querySelector('.mok');
  assert(okBtn, 'handoff dialog should render a copy button');
});

await test('scheduled sends: composer 🕒 schedules a one-shot message and clears the shared draft', async () => {
  const env = loadApp();
  // Read-only observe → the schedule affordance gates exactly like Send.
  await env.api.attach(claudeSession());
  assert(env.el('scheduleBtn').disabled, 'observe-only sessions must not offer message scheduling');

  const owned = loadApp();
  const s = session({
    id: 'sched-target',
    title: 'Perf sweep',
    control: { drive: { supported: true, state: 'driving' }, terminalSync: { supported: true, active: false } },
  });
  await owned.api.attach(s);
  assert(!owned.el('scheduleBtn').disabled, 'a driving session offers message scheduling');

  owned.el('input').value = 'run the nightly report';
  owned.api.openScheduleSheet();
  assert(owned.el('scheduleSheet').classList.contains('open'), 'the schedule sheet opens');
  assert(owned.el('scheduleAt').value, 'a default send-at time is prefilled');
  assert(text(owned.el('scheduleTarget')).includes('Perf sweep'), 'the sheet names the target session');

  owned.el('scheduleAt').value = '2027-02-01T09:00';
  await owned.api.confirmScheduleMessage();
  const post = owned.requests.find((r) => r.method === 'POST' && r.url === '/api/schedules');
  assert(post, 'confirming schedules via POST /api/schedules');
  const parsed = JSON.parse(post.body || '{}');
  assert(parsed.kind === 'message' && parsed.tool === 'opencode' && parsed.sessionId === 'sched-target', `message schedule carries the session identity, got ${post.body}`);
  assert(parsed.text === 'run the nightly report', 'the composer text rides the schedule');
  assert(parsed.at === Date.parse('2027-02-01T09:00'), 'the picked local time rides as epoch ms');
  assert(parsed.repeat === undefined, 'composer scheduling is one-shot (D5: repeats live in New session)');
  assert(!owned.el('scheduleSheet').classList.contains('open'), 'the sheet closes on success');
  assert(owned.el('input').value === '', 'the composer clears — the text now lives in the schedule');
  const inline = owned.document.querySelector('.pendingSchedule');
  assert(inline?.dataset.scheduleId === 'sched-1', 'the returned stable schedule id is rendered inline immediately');
  assert(text(inline?.querySelector('.pendingScheduleText') || null) === 'run the nightly report', 'the inline card shows the full scheduled prompt');
  assert(text(inline?.querySelector('.pendingScheduleState') || null) === 'Scheduled', 'the inline card clearly says Scheduled');
  assert(text(inline?.querySelector('.pendingScheduleTime') || null).includes(new Date(Date.parse('2027-02-01T09:00')).toLocaleString()), 'the inline card localizes the send date/time');
  assert(
    owned.sockets.some((sock) => sock.sent.some((frame) => { const f = JSON.parse(frame); return f.kind === 'draft' && f.text === ''; })),
    'the SHARED draft clears too, like a real send (item-14 multi-client sync)',
  );
});

await test('scheduled sends: New session "Start: Repeat daily" schedules a cron session instead of creating now', async () => {
  const env = loadApp();
  env.setAgents([
    { id: 'opencode', displayName: 'OpenCode', canCreateSession: true, capabilities: { supportsLiveAttach: true, attachModes: ['live'] } },
  ]);
  await env.api.loadAgents();
  env.api.openNewSessionDialog();
  await flushMicrotasks(4);
  assert(!visible(env.el('newScheduleFields')), 'schedule fields stay hidden for Start: Now');
  env.el('newWhen').value = 'daily';
  env.el('newWhen').onchange?.({});
  assert(visible(env.el('newScheduleFields')), 'picking a scheduled start reveals the calendar fields');
  assert(env.el('newAt').value, 'a default first-run time is prefilled');
  assert(text(env.el('newCreate')) === 'Schedule', 'the action button renames to Schedule');

  // A first message is REQUIRED for a scheduled session (there is no composer yet).
  env.el('newPrompt').value = '';
  env.el('newDirectory').value = '/workspace/nightly';
  env.el('newAt').value = '2027-02-01T07:30';
  await env.api.createNewSessionFromDialog();
  assert(!env.requests.some((r) => r.method === 'POST' && r.url === '/api/schedules'), 'no schedule is created without a first message');

  env.el('newPrompt').value = 'sweep the perf dashboards';
  await env.api.createNewSessionFromDialog();
  const post = env.requests.find((r) => r.method === 'POST' && r.url === '/api/schedules');
  assert(post, 'a scheduled start POSTs /api/schedules');
  const parsed = JSON.parse(post.body || '{}');
  assert(parsed.kind === 'new-session' && parsed.tool === 'opencode', `new-session schedule shape, got ${post.body}`);
  assert(parsed.repeat === 'daily' && parsed.directory === '/workspace/nightly' && parsed.text === 'sweep the perf dashboards', 'repeat/directory/first-message ride along');
  assert(typeof parsed.timeZone === 'string' && parsed.timeZone.length > 0, 'repeat carries the scheduling browser IANA time zone');
  assert(parsed.at === Date.parse('2027-02-01T07:30'), 'the picked first-run time rides as epoch ms');
  assert(!env.requests.some((r) => r.method === 'POST' && /\/api\/sessions\/opencode$/.test(r.url)), 'no session is created NOW for a scheduled start');
  assert(!env.el('newSheet').classList.contains('open'), 'the dialog closes once scheduled');
});

await test('scheduled sends: the Schedules manager lists rows and cancels live schedules', async () => {
  const env = loadApp();
  env.schedulesMock.push(
    { id: 'live-1', revision: 3, kind: 'message', tool: 'opencode', sessionId: 's1', sessionTitle: 'Perf sweep', text: 'run the report', at: NOW + 3_600_000, state: 'scheduled' },
    { id: 'done-1', kind: 'new-session', tool: 'opencode', title: 'Nightly', directory: '/workspace/nightly', text: 'sweep', at: NOW - 3_600_000, state: 'delivered', lastFiredAt: NOW - 3_600_000, lastOutcome: 'delivered' },
    { id: 'fail-1', kind: 'message', tool: 'claude', sessionId: 's9', sessionTitle: 'Doc pass', text: 'summarize', at: NOW - 7_200_000, state: 'failed', lastError: 'this session cannot accept remote prompts right now' },
  );
  await env.api.renderSchedulesList();
  const rows = env.document.querySelectorAll('.scheduleRow');
  assert(rows.length === 3, `all schedules render, got ${rows.length}`);
  const liveRow = rows.find((r) => text(r).includes('Perf sweep'));
  assert(liveRow && !liveRow.classList.contains('done'), 'live rows render un-dimmed');
  assert(liveRow.querySelectorAll('button').some((button) => text(button) === 'Edit'), 'live message rows offer Edit');
  assert(liveRow.querySelectorAll('button').some((button) => text(button) === 'Cancel'), 'live rows offer Cancel');
  const newSessionRow = rows.find((r) => text(r).includes('Nightly'));
  assert(newSessionRow && !newSessionRow.querySelectorAll('button').some((button) => text(button) === 'Edit'), 'new-session schedules remain manage/cancel only');
  const failRow = rows.find((r) => text(r).includes('Doc pass'));
  assert(failRow, 'the failed schedule renders a row');
  assert(failRow.classList.contains('done') && text(failRow).includes('cannot accept remote prompts'), 'failed rows show the honest error');
  assert(text(failRow.querySelector('button')) === 'Remove', 'terminal rows offer Remove');

  await liveRow.querySelectorAll('button').find((button) => text(button) === 'Cancel')!.onclick?.({});
  await flushMicrotasks(8);
  assert(env.requests.some((r) => r.method === 'DELETE' && r.url === '/api/schedules/live-1?expectedRevision=3'), 'Cancel DELETEs the rendered revision');
  assert(env.schedulesMock.find((s) => s.id === 'live-1')?.state === 'canceled', 'the schedule is canceled broker-side');
  const rerendered = env.document.querySelectorAll('.scheduleRow').find((r) => text(r).includes('Perf sweep'));
  assert(rerendered?.classList.contains('done') && text(rerendered.querySelector('button')) === 'Remove', 'the list re-renders the canceled row as terminal');
});

await test('scheduled sends: Manage edits a live message with no current session attached', async () => {
  const env = loadApp();
  env.schedulesMock.push({ id: 'manager-edit-1', revision: 5, kind: 'message', tool: 'opencode', sessionId: 'detached-session', sessionTitle: 'Detached target', text: 'manager old text', at: NOW + 3_600_000, state: 'scheduled' });
  env.el('schedulesSheet').classList.add('open');
  await env.api.renderSchedulesList();
  const row = env.document.querySelector('.scheduleRow');
  row?.querySelector('.scheduleActions button')?.click();
  env.el('scheduleText').value = 'manager edited with no current session';
  env.el('scheduleAt').value = '2027-02-01T12:00';
  await env.api.confirmScheduleMessage();
  const patchRequest = env.requests.find((r) => r.method === 'PATCH' && r.url === '/api/schedules/manager-edit-1');
  assert(patchRequest, 'Manage edit without an attached session must PATCH the stable id');
  assert(JSON.parse(patchRequest!.body || '{}').expectedRevision === 5, 'detached Manage edit must carry the rendered revision');
  assert(!env.el('scheduleSheet').classList.contains('open'), 'successful detached Manage edit closes its sheet');
  await flushMicrotasks(10);
  assert(text(env.el('schedulesList')).includes('manager edited with no current session'), 'detached Manage edit refreshes the manager list');
});

await test('scheduled sends: exact session filtering survives refresh and history reset without duplicates', async () => {
  const env = loadApp();
  const target = session({ id: 'same-id', tool: 'opencode', title: 'Current profile' });
  env.schedulesMock.push(
    { id: 'keep-1', revision: 2, kind: 'message', tool: 'opencode', sessionId: 'same-id', text: 'a very long prompt that must stay entirely visible in the pending card', at: NOW + 3_600_000, state: 'scheduled' },
    { id: 'wrong-tool', revision: 1, kind: 'message', tool: 'claude', sessionId: 'same-id', text: 'wrong tool secret', at: NOW + 3_600_000, state: 'scheduled' },
    { id: 'wrong-session', revision: 1, kind: 'message', tool: 'opencode', sessionId: 'other-id', text: 'other session secret', at: NOW + 3_600_000, state: 'scheduled' },
    { id: 'wrong-kind', revision: 1, kind: 'new-session', tool: 'opencode', sessionId: 'same-id', text: 'new session secret', at: NOW + 3_600_000, state: 'scheduled' },
    { id: 'terminal', revision: 1, kind: 'message', tool: 'opencode', sessionId: 'same-id', text: 'delivered secret', at: NOW - 3_600_000, state: 'delivered' },
  );
  await env.api.attach(target);
  await flushMicrotasks(12);
  const socket = env.sockets.at(-1)!;
  let cards = env.document.querySelectorAll('.pendingSchedule');
  const firstCard = cards[0];
  assert(cards.length === 1 && firstCard?.dataset.scheduleId === 'keep-1', `exact filtering should leave one card, got ${cards.length}`);
  assert(firstCard && text(firstCard.querySelector('.pendingScheduleText')) === 'a very long prompt that must stay entirely visible in the pending card', 'pending card keeps the full prompt text');
  socket.onmessage?.({ data: JSON.stringify({ kind: 'history', reset: true, messages: [] }) });
  await env.api.refreshPendingSchedules();
  cards = env.document.querySelectorAll('.pendingSchedule');
  assert(cards.length === 1 && cards[0]?.dataset.scheduleId === 'keep-1', 'history reset plus refresh must restore exactly one stable-id card');
  assert(!text(env.el('thread')).includes('wrong tool secret') && !text(env.el('thread')).includes('delivered secret'), 'filtered and terminal prompt text must not leak inline');
});

await test('scheduled sends: Edit PATCHes the stable id with the rendered revision and updates in place', async () => {
  const env = loadApp();
  const target = session({ id: 'edit-session', tool: 'opencode', title: 'Edit target' });
  env.schedulesMock.push({ id: 'edit-1', revision: 4, kind: 'message', tool: 'opencode', sessionId: 'edit-session', sessionTitle: 'Edit target', text: 'old prompt', at: NOW + 3_600_000, state: 'scheduled' });
  await env.api.attach(target);
  await flushMicrotasks(10);
  const before = env.document.querySelector('.pendingSchedule');
  before?.querySelector('.scheduleEdit')?.click();
  env.el('scheduleText').value = 'edited prompt with the same stable schedule';
  env.el('scheduleAt').value = '2027-02-01T10:30';
  await env.api.confirmScheduleMessage();
  const patchRequest = env.requests.find((r) => r.method === 'PATCH' && r.url === '/api/schedules/edit-1');
  assert(patchRequest, 'Edit must PATCH the existing schedule id');
  assert(JSON.stringify(JSON.parse(patchRequest!.body || '{}')) === JSON.stringify({ text: 'edited prompt with the same stable schedule', at: Date.parse('2027-02-01T10:30'), expectedRevision: 4 }), 'Edit PATCH body must carry text, at, and expectedRevision');
  const after = env.document.querySelector('.pendingSchedule');
  assert(after === before, 'successful edit updates the existing card in place');
  assert(after && text(after.querySelector('.pendingScheduleText')) === 'edited prompt with the same stable schedule' && after.dataset.scheduleId === 'edit-1', 'edited card keeps its stable id and new text');
});

await test('scheduled sends: PATCH conflict refreshes canonical fields and retries with the new revision', async () => {
  const env = loadApp();
  const target = session({ id: 'conflict-session', tool: 'opencode', title: 'Conflict target' });
  const canonical = { id: 'conflict-1', revision: 9, kind: 'message', tool: 'opencode', sessionId: 'conflict-session', sessionTitle: 'Conflict target', text: 'canonical text from another client', at: NOW + 7_200_000, state: 'scheduled' };
  env.schedulesMock.push({ ...canonical, revision: 4, text: 'stale text' });
  env.scheduleMockControl.conflictSchedule = canonical;
  env.scheduleMockControl.conflictNextPatch = true;
  await env.api.attach(target);
  await flushMicrotasks(10);
  env.document.querySelector('.pendingSchedule .scheduleEdit')?.click();
  env.el('scheduleText').value = 'my stale edit';
  await env.api.confirmScheduleMessage();
  assert(env.el('scheduleSheet').classList.contains('open'), 'conflict keeps a usable sheet open for retry');
  assert(env.el('scheduleText').value === canonical.text && env.api.getState().pendingSchedules.get('conflict-1')?.revision === 9, 'conflict replaces the old edit fields and inline revision with canonical truth');
  env.el('scheduleText').value = 'retry after refresh';
  await env.api.confirmScheduleMessage();
  const retries = env.requests.filter((r) => r.method === 'PATCH' && r.url === '/api/schedules/conflict-1');
  assert(JSON.parse(retries.at(-1)!.body || '{}').expectedRevision === 9, 'retry must use the refreshed revision, not loop on the stale revision');
});

await test('scheduled sends: successful Cancel removes the inline card before a failed truth refresh', async () => {
  const env = loadApp();
  const target = session({ id: 'cancel-session', tool: 'opencode' });
  env.schedulesMock.push({ id: 'cancel-1', revision: 7, kind: 'message', tool: 'opencode', sessionId: 'cancel-session', text: 'cancel me', at: NOW + 3_600_000, state: 'scheduled' });
  await env.api.attach(target);
  await flushMicrotasks(10);
  env.scheduleMockControl.failNextGet = true;
  env.document.querySelector('.pendingSchedule .scheduleCancel')?.click();
  await flushMicrotasks(12);
  assert(env.requests.some((r) => r.method === 'DELETE' && r.url === '/api/schedules/cancel-1?expectedRevision=7'), 'Cancel uses the rendered revision');
  assert(!env.document.querySelector('.pendingSchedule'), 'successful DELETE removes the card even when follow-up GET fails');
});

await test('scheduled sends: DELETE conflict applies returned canonical revision before a failed refresh', async () => {
  const env = loadApp();
  const target = session({ id: 'cancel-conflict-session', tool: 'opencode' });
  const canonical = { id: 'cancel-conflict-1', revision: 8, kind: 'message', tool: 'opencode', sessionId: 'cancel-conflict-session', text: 'canonical cancel conflict text', at: NOW + 5_400_000, state: 'scheduled' };
  env.schedulesMock.push({ ...canonical, revision: 4, text: 'stale cancel text' });
  env.scheduleMockControl.conflictNextDelete = true;
  env.scheduleMockControl.conflictDeleteSchedule = canonical;
  await env.api.attach(target);
  await flushMicrotasks(10);
  env.scheduleMockControl.failNextGet = true;
  env.document.querySelector('.pendingSchedule .scheduleCancel')?.click();
  await flushMicrotasks(14);
  const card = env.document.querySelector('.pendingSchedule');
  assert(card?.dataset.scheduleRevision === '8', 'DELETE conflict must replace the stale revision immediately');
  assert(text(card?.querySelector('.pendingScheduleText')) === canonical.text, 'DELETE conflict must use returned canonical text when GET fails');
});

await test('scheduled sends: a late GET from a prior attach generation cannot leak same-id prompt text', async () => {
  const env = loadApp();
  const first = session({ id: 'profile-session', tool: 'opencode', title: 'Profile A' });
  env.schedulesMock.push({ id: 'profile-1', revision: 1, kind: 'message', tool: 'opencode', sessionId: 'profile-session', text: 'profile A private prompt', at: NOW + 3_600_000, state: 'scheduled' });
  env.scheduleMockControl.holdNextGet();
  await env.api.attach(first);
  await flushMicrotasks(12);
  env.schedulesMock.length = 0; // the next authenticated profile has the same ids but no such row
  await env.api.attach(session({ id: 'profile-session', tool: 'opencode', title: 'Profile B' }));
  env.scheduleMockControl.releaseGet();
  await flushMicrotasks(20);
  assert(!text(env.el('thread')).includes('profile A private prompt'), 'a prior-generation schedule response must not leak prompt text after a profile/session switch');
  assert(env.document.querySelectorAll('.pendingSchedule').length === 0, 'same-id next-generation truth leaves no stale card');
  assert(env.requests.filter((r) => r.method === 'GET' && r.url === '/api/schedules').length >= 2, 'the new attach must issue its own generation-safe GET');
});

await test('scheduled sends: a late create POST cannot clear the next session draft', async () => {
  const env = loadApp();
  const first = session({ id: 'post-session', tool: 'opencode', title: 'POST session A', control: { drive: { supported: true, state: 'driving' }, terminalSync: { supported: true, active: false } } });
  const second = session({ id: 'post-session', tool: 'opencode', title: 'POST session B', control: { drive: { supported: true, state: 'driving' }, terminalSync: { supported: true, active: false } } });
  env.scheduleMockControl.holdNextPost();
  await env.api.attach(first);
  await flushMicrotasks(10);
  env.el('input').value = 'prompt from A';
  env.api.openScheduleSheet();
  env.el('scheduleAt').value = '2027-02-01T11:00';
  const latePost = env.api.confirmScheduleMessage();
  await flushMicrotasks(6);
  await env.api.attach(second);
  await flushMicrotasks(12); // B's own schedule GET snapshots before A's held POST completes
  env.el('input').value = 'draft from B';
  env.el('input').dispatchEvent({ type: 'input', target: env.el('input') });
  env.scheduleMockControl.releasePost();
  await latePost;
  await flushMicrotasks(12);
  assert(env.el('input').value === 'draft from B', 'late create success must not clear the next session composer');
  const secondSocket = env.sockets.at(-1)!;
  assert(!secondSocket.sent.some((frame) => { const parsed = JSON.parse(frame); return parsed.kind === 'draft' && parsed.text === ''; }), 'late create success must not clear the next session shared draft');
  assert(!text(env.el('thread')).includes('prompt from A'), 'late create success must not paint the old session prompt');
});

await test('scheduled sends: a late PATCH cannot close or replace the next session edit sheet', async () => {
  const env = loadApp();
  const first = session({ id: 'patch-session-a', tool: 'opencode', title: 'PATCH session A' });
  const second = session({ id: 'patch-session-b', tool: 'opencode', title: 'PATCH session B' });
  env.schedulesMock.push(
    { id: 'patch-a', revision: 3, kind: 'message', tool: 'opencode', sessionId: 'patch-session-a', sessionTitle: 'PATCH session A', text: 'A old text', at: NOW + 3_600_000, state: 'scheduled' },
    { id: 'patch-b', revision: 6, kind: 'message', tool: 'opencode', sessionId: 'patch-session-b', sessionTitle: 'PATCH session B', text: 'B current text', at: NOW + 7_200_000, state: 'scheduled' },
  );
  env.scheduleMockControl.holdNextPatch();
  await env.api.attach(first);
  await flushMicrotasks(10);
  env.document.querySelector('.pendingSchedule[data-schedule-id="patch-a"] .scheduleEdit')?.click();
  env.el('scheduleText').value = 'A edited text';
  const latePatch = env.api.confirmScheduleMessage();
  await flushMicrotasks(6);

  await env.api.attach(second);
  await flushMicrotasks(12);
  env.document.querySelector('.pendingSchedule[data-schedule-id="patch-b"] .scheduleEdit')?.click();
  const bText = env.el('scheduleText').value;
  assert(bText === 'B current text' && env.el('scheduleSheet').classList.contains('open'), 'B should have its own open edit sheet before A resolves');

  env.scheduleMockControl.releasePatch();
  await latePatch;
  await flushMicrotasks(12);
  assert(env.el('scheduleSheet').classList.contains('open'), 'late A PATCH must not close B\'s sheet');
  assert(env.el('scheduleText').value === bText, 'late A PATCH must not replace B\'s editor fields');
  assert(!text(env.el('toast')).includes('Scheduled message updated') && !text(env.el('toast')).includes('changed elsewhere'), 'late A PATCH must not toast over B\'s editor');
});

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\nFAIL: ${failed.length}/${results.length} web UI component check(s) failed.`);
  process.exit(1);
}

console.log(`\nPASS: ${results.length}/${results.length} web UI component checks passed.`);
