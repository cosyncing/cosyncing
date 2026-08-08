// cosyncing — minimal web client (no build step). Product copy is injected from PRODUCT_IDENTITY.
// Talks to the broker: GET /api/sessions, WS /api/sessions/:tool/:id/stream.

const $ = (s) => document.querySelector(s);
const thread = $('#thread');
const roster = $('#roster');
const rosterList = $('#rosterList') || roster;
const input = $('#input');
const sendBtn = $('#send');
const connDot = $('#conn');

let ws = null;
let attachSeq = 0;
let current = null; // SessionInfo
let currentRosterStatus = null; // the roster status at attach time (the broker's session frame later replaces `current` and can drop the live status, so we keep this for the Drive warning escalation)
const keyed = new Map(); // streaming upsert: key -> {el, text}
let serverCommands = []; // slash commands advertised by the broker for the attached session
let serverModels = []; // [{providerID, modelID, label}] for the model picker
let serverAgents = []; // [{name, description}] for the agent picker
let serverModes = []; // [{value, label, description}] permission modes for the mode picker (Claude)
let selectedModel = null; // {providerID, modelID, reasoningEffort?} sent with each prompt (null = session default)
let selectedModelDirty = false; // true only after the user explicitly picks model/effort in the app
let selectedAgent = null; // 'build' | 'plan' | … sent with each prompt
let selectedMode = null; // permission mode (e.g. 'acceptEdits') shown in the picker
let selectedModeDirty = false; // true only after the user explicitly picks a mode — only then does it ride prompts (mirrors selectedModelDirty; an undirty mode must never re-assert backend state, issues-part3)
let lastAttachMode = null; // effective mode of the most recent attach — a visibility resync reopens the stream the same way
let sessionEndedByServer = false; // the broker sent 'ended' and we closed on purpose — a resync must not resurrect it
let agentBusy = false; // is the attached agent actively working? (drives queued-message display)
let driving = false; // are we DRIVING (live/resume) vs read-only observing? gates the composer
const TOOL_DISPLAY_PREF_KEY = 'cosyncing.toolDisplay';
const LEGACY_TOOL_CALLS_PREF_KEY = 'cosyncing.showToolCalls';
const TOOL_DISPLAY_MODES = new Set(['responsive', 'collapsed', 'final-only']);
const TOOL_PREVIEW_MAX_LINES = 40;
const TOOL_PREVIEW_MAX_BYTES = 4096;
const THEME_PREF_KEY = 'cosyncing.themePreference';
const LANGUAGE_PREF_KEY = 'cosyncing.languagePreference';
const SESSION_WINDOW_KEY = 'cosyncing.sessionWindow';
const TOKDASH_URL_KEY = 'cosyncing.tokdashUrl';
const BROKER_TOKEN_KEY = 'cosyncing.brokerToken';
// Optional broker shared secret — only needed when the broker is exposed beyond loopback (COSYNCING_TOKEN set).
// Bootstrap from a `?token=` on first load (then persist), and send it on the WS stream plus gated control
// fetches. Loopback default has no token, so these are no-ops. See main.ts authed()/non-loopback guard.
function brokerToken() {
  try {
    const fromUrl = new URL(location.href).searchParams.get('token');
    if (fromUrl) localStorage.setItem(BROKER_TOKEN_KEY, fromUrl);
    return localStorage.getItem(BROKER_TOKEN_KEY) || '';
  } catch { return ''; }
}
function tokenHeader() { const t = brokerToken(); return t ? { 'x-cosyncing-token': t } : {}; }
const TOKDASH_DEFAULT_URL = 'http://127.0.0.1:55423';
const TRANSPORT_DEMO_CHANNEL = 'web-demo';
const TRANSPORT_DEMO_FROM = 'webui-demo-sender';
const TRANSPORT_DEMO_TO = 'webui-demo-receiver';
const CACHE_DB_NAME = 'cosyncing-history-cache';
const CACHE_DB_VERSION = 1;
const ARTIFACT_PREFETCH_BYTES = 512 * 1024;
const CACHE_MAX_BYTES = 512 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let toolDisplayMode = readToolDisplayMode();
let transcriptTurnSerial = 0;
let currentTranscriptTurn = 0;
let lastTranscriptUserKey = null;
let activeLookupRun = null;
let themePreference = readThemePreference();
let languagePreference = readLanguagePreference();
let sessionWindow = readSessionWindow();
// Auto-started sessions (SessionInfo.origin) hidden from the roster — "hide auto sessions, show
// human-initiated ones" (issues-part3 subagent display, D1/D2): subagent + exec hidden by default,
// IDE (vscode) shown. One unified Settings group, persisted per device.
const HIDDEN_ORIGINS_KEY = 'cosyncing.hiddenOrigins';
const ORIGIN_VALUES = ['subagent', 'exec', 'vscode'];
let hiddenOrigins = readHiddenOrigins();
// Parents whose agent-spawned children are temporarily revealed via the row's ⚒ chip (keyed
// `${tool}:${nativeId}`; session-scoped on purpose — a reveal is a peek, not a preference).
const revealedSubagentParents = new Set();
function readHiddenOrigins() {
  try {
    const raw = localStorage.getItem(HIDDEN_ORIGINS_KEY);
    if (raw === null) return new Set(['subagent', 'exec']);
    const list = JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter((v) => ORIGIN_VALUES.includes(v)) : ['subagent', 'exec']);
  } catch {
    return new Set(['subagent', 'exec']);
  }
}
function setOriginHidden(origin, hidden) {
  if (!ORIGIN_VALUES.includes(origin)) return;
  if (hidden) hiddenOrigins.add(origin);
  else hiddenOrigins.delete(origin);
  try { localStorage.setItem(HIDDEN_ORIGINS_KEY, JSON.stringify([...hiddenOrigins])); } catch {}
  renderRoster();
}
// Last roster ETag: sent back as If-None-Match so an unchanged /api/sessions poll returns 304 (no body,
// no re-render). Reset to force a full refetch (e.g. when the session-history window changes).
let lastRosterEtag = null;
let tokdashUrl = readTokdashUrl();
let canInterrupt = false; // does the session advertise a stop/abort action? (drives the Stop button)
let lastSubmitted = null; // {text, files} of the last sent prompt — restored to the composer on interrupt
const agentCaps = {}; // tool id → AgentCapabilities + native hook affordances (from /api/agents)
const agentInfos = {}; // tool id → {displayName, canCreateSession, capabilities}
let lastRosterSessions = [];
const openProjects = new Set();
let rosterStatusBySession = new Map();
const reviewSessionKeys = new Set();
const activeBars = new Map(); // goal/background activity bars keyed by canonical message upsert key
const taskLists = new Map(); // task-list-state panels keyed by canonical message upsert key
const goalNotes = new Set();
let activeBarTimer = null;
let latestTokenCount = null;
let latestContextUsage = null;
let latestRuntimeTotals = null;
const runSummaries = new Map();
let observedRuntimeMs = 0;
let runStartedAt = null;
let statuslineTimer = null;
let currentCacheKey = null;
let currentCachedMessages = [];
let currentHistoryCursor = null;
let historyReceived = false;
const artifactObjectUrls = new Map();
const artifactFrames = new Map();
let clientMessageSequence = 0;
function nextClientMessageId(kind) {
  clientMessageSequence = (clientMessageSequence + 1) % Number.MAX_SAFE_INTEGER;
  return ['web', kind, Date.now().toString(36), clientMessageSequence.toString(36)].join('-');
}
// Transcript autoscroll policy: follow live output only while the reader is already at the tail.
// If they scroll upward, new agent messages must not yank them back down.
// Governing UX doc: docs/architecture/client-ui.md
const AUTOSCROLL_BOTTOM_PX = 72;
let threadPinnedToBottom = true;
const pendingSends = []; // optimistic queued user bubbles awaiting their server echo: {text, el}
const pendingAttachments = []; // files staged in the composer, sent with the NEXT prompt: {name,mimeType,data}
// Scheduled message cards are client-side session state, not AgentMessages. They are keyed by the
// broker's stable schedule id and rebuilt from the authenticated schedule list after transcript/cache
// replay, so history can never duplicate or deliver them as ordinary user bubbles.
const pendingSchedules = new Map();
const pendingScheduleElements = new Map();
let scheduleFetchPromise = null;
let scheduleFetchGeneration = null;
const SCHEDULE_POLL_MS = 15000;
const CLIENT_COMMANDS = [
  { name: 'new', description: 'Start a new session', kind: 'client' },
  { name: 'copy', description: 'Copy transcript to clipboard', kind: 'client' },
  { name: 'export', description: 'Download transcript', kind: 'client' },
];

// App-side PROMPT commands: `/name <args>` expands a template and sends it as a normal turn —
// available for EVERY agent, no backend support needed. `${args}` is substituted. Models won't call
// send_file on a plain "send me X" (they glob/read instead), so /send_file injects the explicit
// phrasing that reliably triggers the tool. (Later: merge user-defined entries here from config.)
const CLIENT_PROMPTS = [
  {
    name: 'send_file',
    description: 'Ask the agent to send you a file (describe it in your own words)',
    kind: 'client-prompt',
    // A tiny "skill", NOT a literal path field: lead with the user's own request (free text), then
    // teach the model to deliver it via the send_file tool — models otherwise glob/read instead of
    // sending. `${args}` is the user's words verbatim; defaultArgs covers the bare `/send_file`.
    template:
      '${args}\n\nTo send a file to me, use your send_file tool — call it with the path of the file to deliver (create the file first if it does not exist yet). Do that now.',
    defaultArgs: 'Please send me the relevant file from this session.',
  },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function restartEverything() {
  const res = await fetch('/api/broker/restart-all', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...tokenHeader() },
    body: JSON.stringify({ confirmRestart: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `broker returned ${res.status}`);
  return body;
}

// Wait for a broker self-restart to come back. `expected` optionally pins a post-restart broker fact to
// confirm (e.g. {codexSyncServer:true} after enabling Codex sync) so we don't return on the OLD broker.
async function waitForBrokerRestart(expected = null) {
  const deadline = Date.now() + 20000;
  let sawUnavailable = false;
  while (Date.now() < deadline) {
    await delay(500);
    try {
      const res = await fetch(`/api/health?restartPoll=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (expected && typeof expected.codexSyncServer === 'boolean' && body.codexSyncServer !== expected.codexSyncServer) {
          sawUnavailable = true;
          continue;
        }
        if (sawUnavailable || Date.now() > deadline - 18500) {
          toast('Broker reconnected');
          await loadRoster();
          return true;
        }
      } else {
        sawUnavailable = true;
      }
    } catch {
      sawUnavailable = true;
    }
  }
  toast('Broker is still restarting. Refresh in a moment.', 'error');
  return false;
}

async function requestRestartEverything() {
  const ok = await confirmDialog({
    title: 'Restart everything?',
    body:
      'This restarts the managed Codex daemon, __PRODUCT_NAME__ broker, and broker-managed OpenCode server.\n\n' +
      'Active turns may be interrupted. Attached clients will disconnect, and Codex terminals must be resumed after the restart.',
    confirmText: 'Restart everything',
    cancelText: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  const btn = $('#restartEverything');
  if (btn) btn.disabled = true;
  try {
    const result = await restartEverything();
    toast(result?.components?.codex?.ok === false ? `Codex restart failed: ${result.components.codex.error || 'unknown error'}. Broker is restarting…` : 'Everything restarting. Reconnecting...', result?.components?.codex?.ok === false ? 'error' : undefined);
    await waitForBrokerRestart();
  } catch {
    toast('Restart requested. Reconnecting...');
    await waitForBrokerRestart();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function readToolDisplayMode() {
  try {
    const value = localStorage.getItem(TOOL_DISPLAY_PREF_KEY);
    if (TOOL_DISPLAY_MODES.has(value)) return value;
    // One-time migration from the former checkbox. `false` meant "remove tool cards"; the new
    // final-only mode is the closest, more coherent transcript-level equivalent.
    const legacy = localStorage.getItem(LEGACY_TOOL_CALLS_PREF_KEY);
    return legacy === 'false' ? 'final-only' : 'responsive';
  } catch {
    return 'responsive';
  }
}

function setToolDisplayMode(value, forceExpansion = true) {
  toolDisplayMode = TOOL_DISPLAY_MODES.has(value) ? value : 'responsive';
  try { localStorage.setItem(TOOL_DISPLAY_PREF_KEY, toolDisplayMode); } catch {}
  document.body.classList.toggle('tool-display-collapsed', toolDisplayMode === 'collapsed');
  document.body.classList.toggle('tool-display-final', toolDisplayMode === 'final-only');
  const el = $('#toolDisplayMode');
  if (el && el.value !== toolDisplayMode) el.value = toolDisplayMode;
  applyToolExpansionDefaults(forceExpansion);
  refreshFinalMessages();
}

function readThemePreference() {
  try {
    const v = localStorage.getItem(THEME_PREF_KEY);
    return v === 'light' || v === 'system' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

function effectiveTheme(pref = themePreference) {
  if (pref === 'system') {
    try { return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
    catch { return 'dark'; }
  }
  return pref === 'light' ? 'light' : 'dark';
}

function applyThemePreference() {
  const theme = effectiveTheme();
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#0b0d10');
  const el = $('#themeSelect');
  if (el && el.value !== themePreference) el.value = themePreference;
}

function setThemePreference(v) {
  themePreference = v === 'light' || v === 'system' ? v : 'dark';
  try { localStorage.setItem(THEME_PREF_KEY, themePreference); } catch {}
  applyThemePreference();
}

function readLanguagePreference() {
  try {
    const v = localStorage.getItem(LANGUAGE_PREF_KEY);
    return v === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

function setLanguagePreference(v) {
  languagePreference = v === 'zh' ? 'zh' : 'en';
  try { localStorage.setItem(LANGUAGE_PREF_KEY, languagePreference); } catch {}
  document.documentElement.lang = languagePreference === 'zh' ? 'zh-CN' : 'en';
  const el = $('#languageSelect');
  if (el && el.value !== languagePreference) el.value = languagePreference;
}

// How far back the roster loads. Stored per device, sent to the broker as ?window= so a phone can pull
// only recent sessions (fast) while a PC stays on 'all'. Older sessions stay saved and reappear when
// the window widens.
const SESSION_WINDOW_VALUES = ['7d', '1m', '2m', '6m', 'all'];
function readSessionWindow() {
  try {
    const v = localStorage.getItem(SESSION_WINDOW_KEY);
    return SESSION_WINDOW_VALUES.includes(v) ? v : 'all';
  } catch {
    return 'all';
  }
}

function setSessionWindow(v) {
  sessionWindow = SESSION_WINDOW_VALUES.includes(v) ? v : 'all';
  try { localStorage.setItem(SESSION_WINDOW_KEY, sessionWindow); } catch {}
  const el = $('#sessionWindowSelect');
  if (el && el.value !== sessionWindow) el.value = sessionWindow;
  lastRosterEtag = null; // window changed → old ETag no longer matches; force a full refetch now
  void loadRoster(true); // user-forced → queue past any in-flight poll so the new window isn't masked
}

function readTokdashUrl() {
  try {
    const v = localStorage.getItem(TOKDASH_URL_KEY);
    return v && v.trim() ? v.trim() : TOKDASH_DEFAULT_URL;
  } catch {
    return TOKDASH_DEFAULT_URL;
  }
}

function setTokdashUrl(v) {
  tokdashUrl = (v || TOKDASH_DEFAULT_URL).trim().replace(/\/+$/, '') || TOKDASH_DEFAULT_URL;
  try { localStorage.setItem(TOKDASH_URL_KEY, tokdashUrl); } catch {}
  const el = $('#tokdashUrl');
  if (el && el.value !== tokdashUrl) el.value = tokdashUrl;
}

function usageNumber(...values) {
  for (const v of values) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function usageBucket(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const roots = [
    raw.today,
    raw.currentDay,
    raw.current_day,
    raw.daily,
    raw.summary,
    raw.totals,
    raw.total,
    raw.usage,
    raw.data,
    raw,
  ];
  return roots.find((x) => x && typeof x === 'object') || {};
}

function parseTokdashUsage(raw) {
  const bucket = usageBucket(raw);
  const input = usageNumber(bucket.input_tokens, bucket.inputTokens, bucket.input, bucket.prompt_tokens, bucket.promptTokens);
  const output = usageNumber(bucket.output_tokens, bucket.outputTokens, bucket.output, bucket.completion_tokens, bucket.completionTokens);
  const total = usageNumber(bucket.total_tokens, bucket.totalTokens, bucket.tokens, bucket.token_count, bucket.tokenCount);
  const cost = usageNumber(bucket.cost_usd, bucket.total_cost_usd, bucket.totalCostUsd, bucket.costUSD, bucket.cost, bucket.usd);
  const runs = usageNumber(bucket.runs, bucket.requests, bucket.requestCount, bucket.sessions, bucket.sessionCount, bucket.turns, bucket.calls);
  return {
    input,
    output,
    total: total ?? ((input != null || output != null) ? (input || 0) + (output || 0) : null),
    cost,
    runs,
  };
}

function formatUsageCost(cost) {
  if (cost == null) return '–';
  return '$' + Number(cost).toFixed(Number(cost) < 1 ? 4 : 2);
}

function renderTokdashUsage(summary = null, status = 'Not loaded', cls = '') {
  const tokens = $('#tokdashTokens');
  const cost = $('#tokdashCost');
  const runs = $('#tokdashRequests');
  const state = $('#tokdashUsageStatus');
  if (tokens) tokens.textContent = summary?.total != null ? fmtCount(summary.total) : '–';
  if (cost) cost.textContent = formatUsageCost(summary?.cost);
  if (runs) runs.textContent = summary?.runs != null ? fmtCount(summary.runs) : '–';
  if (state) {
    state.textContent = status;
    state.className = ['usageStatus', cls].filter(Boolean).join(' ');
  }
}

async function refreshTokdashUsage() {
  const urlInput = $('#tokdashUrl');
  if (urlInput) setTokdashUrl(urlInput.value);
  renderTokdashUsage(null, 'Loading usage...');
  try {
    const res = await fetch(`/api/tokdash/usage?base=${encodeURIComponent(tokdashUrl)}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || `Tokdash returned ${res.status}`);
    const summary = parseTokdashUsage(body.data);
    renderTokdashUsage(summary, body.endpoint ? `Updated from ${body.endpoint}` : 'Updated', 'ok');
  } catch (err) {
    renderTokdashUsage(null, err instanceof Error ? err.message : 'Tokdash unavailable', 'warn');
  }
}

function bytesToBase64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlToBytes(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(value).length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function transportDemoAad(meta) {
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    id: meta.id,
    channel: meta.channel,
    from: meta.from || '',
    to: meta.to || '',
  }));
}

async function transportDemoCrypto() {
  if (globalThis.__COSYNCING_TEST__) {
    return {
      async pairingMaterial(peerId, peerToken) {
        return { peerId, peerToken, identityPublicKey: 'phone-public-identity', exchangePublicKey: 'phone-exchange-public' };
      },
      async unwrapDataKey(_wrapped, _material) { return { testOnly: true }; },
      async seal(_key, meta, plaintext, material) {
        return new TextEncoder().encode(JSON.stringify({
          version: 1,
          kind: 'cipher-envelope',
          envelopeId: meta.id,
          channel: meta.channel,
          from: meta.from,
          to: meta.to,
          sealed: { algorithm: 'TEST-AES-256-GCM', nonce: 'test', ciphertext: bytesToBase64url(plaintext), tag: 'test' },
          senderIdentityPublicKey: material.identityPublicKey,
          senderSignature: 'test-signature',
        }));
      },
      async open(_key, meta, bytes, trustedIdentityPublicKey) {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (parsed.envelopeId !== meta.id || parsed.channel !== meta.channel || parsed.from !== meta.from || parsed.to !== meta.to) throw new Error('test envelope metadata mismatch');
        if (parsed.senderIdentityPublicKey !== trustedIdentityPublicKey || !parsed.senderSignature) throw new Error('test envelope sender identity mismatch');
        return base64urlToBytes(parsed.sealed.ciphertext);
      },
    };
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is unavailable in this browser');
  const algorithmSupported = async (name) => {
    try {
      if (name === 'Ed25519') await subtle.generateKey({ name }, true, ['sign', 'verify']);
      if (name === 'X25519') await subtle.generateKey({ name }, true, ['deriveBits']);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await algorithmSupported('Ed25519')) || !(await algorithmSupported('X25519'))) {
    throw new Error('This browser does not expose Ed25519/X25519 Web Crypto for the pairing demo');
  }
  return {
    async pairingMaterial(peerId, peerToken) {
      const identity = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      const exchange = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      return {
        peerId,
        peerToken,
        identity,
        exchange,
        identityPublicKey: bytesToBase64url(new Uint8Array(await subtle.exportKey('spki', identity.publicKey))),
        exchangePublicKey: bytesToBase64url(new Uint8Array(await subtle.exportKey('spki', exchange.publicKey))),
      };
    },
    async unwrapDataKey(wrapped, material) {
      const ephemeralPublicKey = await subtle.importKey('spki', base64urlToBytes(wrapped.ephemeralPublicKey), { name: 'X25519' }, false, []);
      const shared = await subtle.deriveBits({ name: 'X25519', public: ephemeralPublicKey }, material.exchange.privateKey, 256);
      const hkdfKey = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
      const wrapKey = await subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode('cosyncing-datakey-wrap-v1') },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      );
      const raw = await subtle.decrypt({
        name: 'AES-GCM',
        iv: base64urlToBytes(wrapped.nonce),
        additionalData: new TextEncoder().encode('cosyncing-datakey'),
      }, wrapKey, concatBytes(base64urlToBytes(wrapped.ciphertext), base64urlToBytes(wrapped.tag)));
      return await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    },
    async seal(key, meta, plaintext, material) {
      const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: transportDemoAad(meta) }, key, plaintext));
      const ciphertext = sealed.slice(0, Math.max(0, sealed.length - 16));
      const tag = sealed.slice(Math.max(0, sealed.length - 16));
      const cipherWithoutSignature = {
        version: 1,
        kind: 'cipher-envelope',
        envelopeId: meta.id,
        channel: meta.channel,
        from: meta.from,
        to: meta.to,
        sealed: {
          algorithm: 'AES-256-GCM',
          nonce: bytesToBase64url(nonce),
          ciphertext: bytesToBase64url(ciphertext),
          tag: bytesToBase64url(tag),
        },
        senderIdentityPublicKey: material.identityPublicKey,
      };
      const signature = await subtle.sign({ name: 'Ed25519' }, material.identity.privateKey, transportDemoSignaturePayload(cipherWithoutSignature));
      const cipher = { ...cipherWithoutSignature, senderSignature: bytesToBase64url(new Uint8Array(signature)) };
      return new TextEncoder().encode(JSON.stringify(cipher));
    },
    async open(key, meta, bytes, trustedIdentityPublicKey) {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed.envelopeId !== meta.id || parsed.channel !== meta.channel || parsed.from !== meta.from || parsed.to !== meta.to) throw new Error('cipher envelope metadata mismatch');
      if (parsed.senderIdentityPublicKey !== trustedIdentityPublicKey || !parsed.senderSignature) throw new Error('cipher envelope sender identity mismatch');
      const trusted = await subtle.importKey('spki', base64urlToBytes(trustedIdentityPublicKey), { name: 'Ed25519' }, false, ['verify']);
      const withoutSignature = { ...parsed };
      delete withoutSignature.senderSignature;
      const verified = await subtle.verify({ name: 'Ed25519' }, trusted, base64urlToBytes(parsed.senderSignature), transportDemoSignaturePayload(withoutSignature));
      if (!verified) throw new Error('cipher envelope sender signature is invalid');
      const sealed = parsed.sealed || {};
      const decrypted = await subtle.decrypt({
        name: 'AES-GCM',
        iv: base64urlToBytes(sealed.nonce),
        additionalData: transportDemoAad(meta),
      }, key, concatBytes(base64urlToBytes(sealed.ciphertext), base64urlToBytes(sealed.tag)));
      return new Uint8Array(decrypted);
    },
  };
}

function transportDemoSignaturePayload(cipher) {
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    kind: cipher.kind,
    envelopeId: cipher.envelopeId,
    channel: cipher.channel,
    from: cipher.from || '',
    to: cipher.to || '',
    sealed: {
      algorithm: cipher.sealed.algorithm,
      nonce: cipher.sealed.nonce,
      ciphertext: cipher.sealed.ciphertext,
      tag: cipher.sealed.tag,
    },
    senderIdentityPublicKey: cipher.senderIdentityPublicKey || '',
  }));
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function transportClientContract() {
  return {
    protocol: 'cosyncing-secure-transport-v1',
    endpoints: {
      createPairing: '/api/transport/pairings',
      acceptPairing: '/api/transport/pairings/{pairingId}/accept',
      mailbox: '/api/transport/envelopes',
      sessionControl: '/api/transport/session-control',
      revokePeer: '/api/transport/peers/{peerId}',
    },
    headers: [
      'x-cosyncing-token',
      'x-cosyncing-envelope-id',
      'x-cosyncing-channel',
      'x-cosyncing-from',
      'x-cosyncing-to',
      'x-cosyncing-to-token',
      'x-cosyncing-peer-token',
      'x-cosyncing-wire-version',
      'x-cosyncing-wire-kind',
    ],
    pairingAcceptBody: ['peerId', 'peerToken', 'identityPublicKey', 'exchangePublicKey'],
    cipherEnvelope: ['version', 'kind', 'envelopeId', 'channel', 'from', 'to', 'sealed', 'senderIdentityPublicKey', 'senderSignature'],
    controlPayloads: [
      { kind: 'approve', required: ['tool', 'sessionId', 'requestId', 'decision'] },
      { kind: 'answer', required: ['tool', 'sessionId', 'requestId', 'answers'] },
      { kind: 'plan-action', required: ['tool', 'sessionId', 'action'] },
    ],
  };
}

function renderTransportContract(extra = {}) {
  const target = $('#transportContractJson');
  if (!target) return;
  target.value = JSON.stringify({ ...transportClientContract(), ...extra }, null, 2);
}

async function runTransportDemo() {
  const status = $('#transportDemoStatus');
  const inputEl = $('#transportDemoMessage');
  const setStatus = (text, cls = '') => {
    if (!status) return;
    status.textContent = text;
    status.className = ['usageStatus', cls].filter(Boolean).join(' ');
  };
  const text = inputEl?.value?.trim() || 'hello encrypted transport';
  renderTransportContract();
  setStatus('Encrypting locally...');
  try {
    const cryptoImpl = await transportDemoCrypto();
    const peerId = 'web-demo-phone';
    const peerToken = globalThis.crypto?.randomUUID?.() ?? `web-demo-peer-${Date.now().toString(36)}`;
    const material = await cryptoImpl.pairingMaterial(peerId, peerToken);
    const offerRes = await fetch('/api/transport/pairings', {
      method: 'POST',
      headers: { ...tokenHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ clientLabel: 'Web demo phone' }),
    });
    const offer = await offerRes.json().catch(() => ({}));
    if (!offerRes.ok) throw new Error(offer.error || `pairing failed: HTTP ${offerRes.status}`);
    setStatus('Pairing public identities...');
    const acceptRes = await fetch(`/api/transport/pairings/${encodeURIComponent(offer.pairingId)}/accept`, {
      method: 'POST',
      headers: { ...tokenHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: material.peerId,
        peerToken: material.peerToken,
        identityPublicKey: material.identityPublicKey,
        exchangePublicKey: material.exchangePublicKey,
      }),
    });
    const accepted = await acceptRes.json().catch(() => ({}));
    if (!acceptRes.ok) throw new Error(accepted.error || `pair accept failed: HTTP ${acceptRes.status}`);
    const key = await cryptoImpl.unwrapDataKey(accepted.wrappedDataKey, material);
    const meta = {
      id: `web-demo-${Date.now().toString(36)}`,
      channel: TRANSPORT_DEMO_CHANNEL,
      from: material.peerId,
      to: accepted.broker.peerId,
    };
    const sealedBytes = await cryptoImpl.seal(key, meta, new TextEncoder().encode(text), material);
    const headers = {
      ...tokenHeader(),
      'content-type': 'application/octet-stream',
      'x-cosyncing-envelope-id': meta.id,
      'x-cosyncing-channel': meta.channel,
      'x-cosyncing-from': meta.from,
      'x-cosyncing-to': meta.to,
      'x-cosyncing-to-token': accepted.broker.peerToken,
      'x-cosyncing-wire-version': '1',
      'x-cosyncing-wire-kind': 'cipher-envelope',
    };
    const post = await fetch('/api/transport/envelopes', { method: 'POST', headers, body: sealedBytes });
    const postBody = await post.json().catch(() => ({}));
    if (!post.ok) throw new Error(postBody.error || `send failed: HTTP ${post.status}`);
    setStatus('Ciphertext queued at broker...');
    const got = await fetch(`/api/transport/envelopes?peer=${encodeURIComponent(meta.to)}&channel=${encodeURIComponent(meta.channel)}`, {
      headers: { ...tokenHeader(), accept: 'application/json', 'x-cosyncing-peer-token': accepted.broker.peerToken },
      cache: 'no-store',
    });
    const body = await got.json().catch(() => ({}));
    if (!got.ok) throw new Error(body.error || `receive failed: HTTP ${got.status}`);
    const item = (body.envelopes || []).find((x) => x.id === meta.id);
    if (!item) throw new Error('broker returned no matching envelope');
    const opened = await cryptoImpl.open(key, meta, base64urlToBytes(item.bytes), material.identityPublicKey);
    const decoded = new TextDecoder().decode(opened);
    if (decoded !== text) throw new Error('decrypted payload did not match');
    await fetch(`/api/transport/peers/${encodeURIComponent(material.peerId)}`, {
      method: 'DELETE',
      headers: tokenHeader(),
    }).catch(() => undefined);
    renderTransportContract({
      lastRun: {
        peerId: material.peerId,
        brokerPeerId: accepted.broker.peerId,
        envelopeId: meta.id,
        channel: meta.channel,
        ciphertextBytes: sealedBytes.byteLength,
      },
    });
    setStatus(`Round trip OK: paired identity sealed ${sealedBytes.byteLength} encrypted bytes; replay cache active; decrypted "${decoded}" locally.`, 'ok');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'encrypted transport demo failed', 'warn');
  }
}

// Governing settings/control UX: docs/architecture/client-ui.md
// Session-control changes are broker mode changes: warn, POST a confirmed restart, then reconnect.
function initSettingsMenu() {
  const btn = $('#settingsButton');
  const menu = $('#settingsMenu');
  if (!btn || !menu) return;
  renderTransportContract();
  const setOpen = (open) => {
    menu.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains('open'));
  };
  menu.onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  const codexSync = $('#codexSyncToggle');
  if (codexSync) {
    void refreshCodexSyncState();
    codexSync.onclick = () => void toggleCodexSync();
  }
  const schedulesBtn = $('#openSchedules');
  // Close the menu first — it sits at a higher z-index than the sheet and would cover it.
  if (schedulesBtn) schedulesBtn.onclick = () => { setOpen(false); openSchedulesSheet(); };
  void refreshRuntimeUpdates();
  void refreshCodexUpdatePolicy();
  const updatePolicy = $('#codexUpdatePolicy');
  if (updatePolicy) updatePolicy.onchange = (e) => void changeCodexUpdatePolicy(e.target.value);
  const runtimeBadge = $('#runtimeUpdateBadge');
  // stopPropagation: without it the badge's own click bubbles on to the document close-listener and
  // the menu opens then immediately closes (verified in a real browser).
  if (runtimeBadge) runtimeBadge.onclick = (e) => { e.stopPropagation(); btn.click(); };
  setInterval(() => void refreshRuntimeUpdates(), 60_000);
  const refreshStatus = $('#refreshRuntimeStatus');
  if (refreshStatus) refreshStatus.onclick = async () => {
    refreshStatus.disabled = true;
    try { await refreshRuntimeUpdates(true); toast('Runtime status re-probed', 'ok'); } finally { refreshStatus.disabled = false; }
  };
  const tools = $('#toolDisplayMode');
  if (tools) {
    tools.value = toolDisplayMode;
    tools.onchange = (e) => setToolDisplayMode(e.target.value);
  }
  const theme = $('#themeSelect');
  if (theme) {
    theme.value = themePreference;
    theme.onchange = (e) => setThemePreference(e.target.value);
  }
  const language = $('#languageSelect');
  if (language) {
    language.value = languagePreference;
    language.onchange = (e) => setLanguagePreference(e.target.value);
  }
  const sessionWindowSel = $('#sessionWindowSelect');
  if (sessionWindowSel) {
    sessionWindowSel.value = sessionWindow;
    sessionWindowSel.onchange = (e) => setSessionWindow(e.target.value);
  }
  // Background-session visibility (subagent display D1/D2): checkbox CHECKED = category shown.
  for (const [elId, origin] of [['#showOriginSubagent', 'subagent'], ['#showOriginExec', 'exec'], ['#showOriginVscode', 'vscode']]) {
    const box = $(elId);
    if (!box) continue;
    box.checked = !hiddenOrigins.has(origin);
    box.onchange = (e) => setOriginHidden(origin, !e.target.checked);
  }
  const tokdash = $('#tokdashUrl');
  if (tokdash) {
    tokdash.value = tokdashUrl;
    tokdash.onchange = (e) => setTokdashUrl(e.target.value);
  }
  const tokdashRefresh = $('#refreshTokdashUsage');
  if (tokdashRefresh) tokdashRefresh.onclick = () => void refreshTokdashUsage();
  renderTokdashUsage();
  const transportDemo = $('#runTransportDemo');
  if (transportDemo) transportDemo.onclick = () => void runTransportDemo();
  const clearSession = $('#clearSessionCache');
  if (clearSession) clearSession.onclick = () => clearCurrentSessionCache();
  const clearAll = $('#clearAllCache');
  if (clearAll) clearAll.onclick = () => clearAllLocalCache();
  const restart = $('#restartEverything');
  if (restart) restart.onclick = () => void requestRestartEverything();
}

// Governing runtime-freshness UX: docs/architecture/client-ui.md
// Pending drift stays visible without blocking normal use. Two manual actions (maintainer, 2026-07-11 —
// test-UI clarity over minimal UX): a per-runtime "Restart now" on each pending row applies THAT
// pending update; global "Restart everything" is the forced full-stack recovery even when current.
// Unknown native statuses remain visible by id so an opt-in never stalls silently.
let runtimeUpdateStates = [];
function runtimeUpdateElementId(prefix, agent) {
  return `${prefix}-${String(agent).replace(/[^a-z0-9_-]/gi, '_')}`;
}
// Config-only wording follows docs/architecture/client-ui.md: one shared
// maintenance event, without presenting equal binary versions as an upgrade.
function runtimePendingChangeSummary(update) {
  const changes = Array.isArray(update?.pendingChanges) ? update.pendingChanges : [];
  const config = changes.includes('configuration');
  const binary = changes.includes('binary-version') || (!changes.length && update?.runningVersion !== update?.installedVersion);
  if (config && !binary) return 'configuration changed since this daemon started';
  const versions = `running ${update?.runningVersion || 'unknown'} → installed ${update?.installedVersion || 'newer'}`;
  return config ? `${versions}; configuration also changed` : versions;
}
function renderRuntimeUpdates() {
  const panel = $('#runtimeUpdates');
  const badge = $('#runtimeUpdateBadge');
  if (!panel || !badge) return;
  const pending = runtimeUpdateStates.filter((update) => update?.state === 'pending' && update.updateAvailable);
  badge.style.display = pending.length ? '' : 'none';
  badge.textContent = pending.length ? `${pending.length} update${pending.length === 1 ? '' : 's'} ready` : 'update ready';
  panel.style.display = pending.length ? '' : 'none';

  for (const update of runtimeUpdateStates) {
    const agent = String(update?.agent ?? '');
    if (!agent) continue;
    let row = document.getElementById(runtimeUpdateElementId('runtimeUpdate', agent));
    let detail = document.getElementById(runtimeUpdateElementId('runtimeUpdateText', agent));
    let restart = document.getElementById(runtimeUpdateElementId('runtimeUpdateRestart', agent));
    if (!row) {
      row = document.createElement('div');
      row.id = runtimeUpdateElementId('runtimeUpdate', agent);
      row.className = 'runtimeUpdateRow';
      detail = document.createElement('span');
      detail.id = runtimeUpdateElementId('runtimeUpdateText', agent);
      detail.className = 'runtimeUpdateText';
      restart = document.createElement('button');
      restart.id = runtimeUpdateElementId('runtimeUpdateRestart', agent);
      restart.className = 'runtimeUpdateRestart';
      restart.type = 'button';
      row.append(detail, restart);
      panel.append(row);
    }
    const isPending = update.state === 'pending' && update.updateAvailable;
    row.style.display = isPending ? '' : 'none';
    if (!isPending || !detail || !restart) continue;
    detail.textContent = `${update.displayName || agent}: ${runtimePendingChangeSummary(update)}. ${runtimeBlockerSummary(update)}`;
    restart.textContent = 'Restart now';
    restart.title = `Apply the pending ${update.displayName || agent} update now, bypassing the automatic idle/policy gate`;
    restart.disabled = false;
    restart.onclick = () => void requestRuntimeRestart(update);
  }
  renderRuntimeStatusList();
}

function runtimeBlockerSummary(update) {
  // blockers ABSENT (vs 0) means the safety probe itself failed — fail-closed, show why, never
  // render it as "no blockers" (verified live: strict socket-missing probe omits the field).
  if (update.blockers == null) return update.detail || 'Blocker probe unavailable — restart stays blocked.';
  const blockers = Number(update.blockers || 0);
  if (!blockers) return 'No attached blockers — waiting for the next automatic check.';
  const composition = update.blockerComposition || {};
  const counts = `${Number(composition.idle || 0)} idle, ${Number(composition.working || 0)} working, ${Number(composition.needsInput || 0)} waiting for input, ${Number(composition.unknown || 0)} unknown`;
  const unknownIds = Array.isArray(update.blockerDetails)
    ? update.blockerDetails.filter((entry) => entry?.status === 'unknown').map((entry) => String(entry.id || '').slice(0, 8)).filter(Boolean)
    : [];
  return `${blockers} loaded (${counts}).${unknownIds.length ? ` Unknown: ${unknownIds.join(', ')}.` : ''} Waiting for the selected policy.`;
}

// Always-visible per-runtime status (test-UI clarity): state + versions + blockers + probe age for
// EVERY managed runtime, even when nothing is pending — so the guardian is inspectable at all times.
function renderRuntimeStatusList() {
  const list = $('#runtimeStatusList');
  if (!list) return;
  if (!runtimeUpdateStates.length) {
    list.textContent = 'No runtime status yet — press Refresh status.';
    return;
  }
  list.textContent = '';
  for (const update of runtimeUpdateStates) {
    const agent = String(update?.agent ?? '');
    if (!agent) continue;
    const line = document.createElement('div');
    line.id = runtimeUpdateElementId('runtimeStatus', agent);
    line.className = 'runtimeStatusRow';
    const ageSec = Number.isFinite(update.checkedAt) ? Math.max(0, Math.round((Date.now() - update.checkedAt) / 1000)) : null;
    const versions = update.state === 'pending'
      ? runtimePendingChangeSummary(update)
      : update.runningVersion ? `version ${update.runningVersion}` : '';
    const parts = [
      `${update.displayName || agent} ${update.runtimeKind || 'runtime'} — ${update.state}`,
      versions,
      update.state === 'pending' ? runtimeBlockerSummary(update) : (update.detail || ''),
      ageSec == null ? '' : `checked ${ageSec}s ago`,
    ].filter(Boolean);
    line.textContent = parts.join(' · ');
    list.append(line);
  }
}

async function refreshRuntimeUpdates(fresh = false) {
  try {
    // fresh=1 bypasses the broker's 60s status cache and forces a real native probe (test-UI control).
    const response = await fetch(`/api/agent-runtime-updates${fresh ? '?fresh=1' : ''}`, { headers: tokenHeader(), signal: AbortSignal.timeout(fresh ? 20_000 : 8000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `broker returned ${response.status}`);
    runtimeUpdateStates = Array.isArray(body.updates) ? body.updates : [];
  } catch {
    runtimeUpdateStates = [];
  }
  renderRuntimeUpdates();
}

// Per-runtime manual restart (restored 2026-07-11): applies THIS runtime's pending update via
// POST /api/agent-runtime-updates/{agent}/restart. The broker's restartNow() is a no-op when no
// update is pending, so this button only renders on pending rows; forced no-update recovery is
// the separate global Restart everything.
async function requestRuntimeRestart(update) {
  const displayName = update?.displayName || update?.agent || 'agent';
  const runtimeKind = update?.runtimeKind || 'runtime';
  const restartWarning = update?.restartWarning ? `\n\n${update.restartWarning}` : '';
  const ok = await confirmDialog({
    title: `Restart ${displayName} ${runtimeKind} now?`,
    body:
      `This applies the pending managed-runtime change (${runtimePendingChangeSummary(update)}) immediately, bypassing the automatic idle/policy gate.\n\n` +
      `${runtimeBlockerSummary(update)}\n\nAttached terminal or app clients may disconnect. Do not restart during an active turn.${restartWarning}`,
    confirmText: 'Restart now',
    cancelText: 'Keep waiting',
    danger: true,
  });
  if (!ok) return;
  const button = document.getElementById(runtimeUpdateElementId('runtimeUpdateRestart', update.agent));
  if (button) button.disabled = true;
  try {
    const response = await fetch(`/api/agent-runtime-updates/${encodeURIComponent(update.agent)}/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenHeader() },
      body: JSON.stringify({ confirmRestart: true }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `broker returned ${response.status}`);
    const after = body.update || {};
    toast(after.state === 'current' ? `${displayName} ${runtimeKind} restarted — now ${after.runningVersion || 'current'}` : `${displayName} restart finished — state: ${after.state || 'unknown'}`, 'ok');
  } catch (error) {
    toast(error instanceof Error ? error.message : `Could not restart ${displayName}`, 'error');
  } finally {
    await refreshRuntimeUpdates(true);
  }
}

let codexUpdatePolicy = 'when-detached';
async function refreshCodexUpdatePolicy() {
  const select = $('#codexUpdatePolicy');
  if (!select) return;
  try {
    const response = await fetch('/api/agent-runtime-update-policy', { headers: tokenHeader(), signal: AbortSignal.timeout(8000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `broker returned ${response.status}`);
    codexUpdatePolicy = body.codexUpdatePolicy === 'when-idle' ? 'when-idle' : 'when-detached';
    select.value = codexUpdatePolicy;
  } catch {
    select.value = codexUpdatePolicy;
  }
}

async function changeCodexUpdatePolicy(next) {
  const select = $('#codexUpdatePolicy');
  const previous = codexUpdatePolicy;
  if (next === 'when-idle') {
    const confirmed = await confirmDialog({
      title: 'Allow idle Codex terminal restarts?',
      body:
        '__PRODUCT_NAME__ will still wait while any Codex session is working or waiting for input, and unknown native states will block the restart.\n\n' +
        'Open idle Codex terminals will disconnect during an automatic daemon update and must be resumed afterward. A pending update may apply immediately.',
      confirmText: 'Allow when idle',
      cancelText: 'Keep safest policy',
      danger: true,
    });
    if (!confirmed) {
      if (select) select.value = previous;
      return;
    }
  }
  try {
    const response = await fetch('/api/agent-runtime-update-policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenHeader() },
      body: JSON.stringify({ codexUpdatePolicy: next }),
      // Saving when-idle can immediately apply a pending Codex update; native restart is bounded at 30s.
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `broker returned ${response.status}`);
    codexUpdatePolicy = body.codexUpdatePolicy;
    if (select) select.value = codexUpdatePolicy;
    toast(codexUpdatePolicy === 'when-idle' ? 'Codex updates may restart idle terminals' : 'Codex updates will wait for all terminals to close', 'ok');
  } catch (error) {
    if (select) select.value = previous;
    toast(error instanceof Error ? error.message : 'Could not save Codex update policy', 'error');
  }
  await refreshRuntimeUpdates();
}

// Codex sync enabler (D15/D23) — per-agent, decoupled from the removed global control-mode picker. Reads/sets
// whether the managed Codex app-server daemon is enabled; toggling against a running broker restarts it once.
let codexSyncState = null;
async function refreshCodexSyncState() {
  const btn = $('#codexSyncToggle');
  if (!btn) return;
  try {
    const r = await fetch('/api/agents/codex/sync', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    codexSyncState = !!j.enabled;
    btn.textContent = codexSyncState ? '✓ Enabled — Disable' : 'Enable Codex sync';
    btn.title = codexSyncState
      ? 'Codex true terminal sync is ON (managed app-server daemon). Click to disable.'
      : 'Enable Codex true terminal sync (managed app-server daemon). Click to enable.';
    btn.disabled = false;
  } catch {
    btn.textContent = 'Retry Codex sync';
    btn.disabled = false;
  }
}
async function toggleCodexSync() {
  const btn = $('#codexSyncToggle');
  if (!btn) return;
  if (codexSyncState === null) { await refreshCodexSyncState(); return; } // unknown → re-probe, don't act blind
  const next = !codexSyncState;
  btn.disabled = true;
  btn.textContent = next ? 'Enabling…' : 'Disabling…';
  try {
    const res = await fetch('/api/agents/codex/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenHeader() },
      body: JSON.stringify({ enabled: next }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `broker returned ${res.status}`);
    codexSyncState = next;
    if (body.restartRequired) {
      toast(`Codex sync ${next ? 'enabling' : 'disabling'} — broker restarting…`);
      await waitForBrokerRestart({ codexSyncServer: next });
    } else {
      toast(`Codex sync ${next ? 'enabled' : 'disabled'}`);
      await loadRoster();
    }
  } catch {
    toast('Could not change Codex sync', 'error');
  } finally {
    await refreshCodexSyncState();
  }
}

// Governing contract: docs/architecture/client-ui.md Session input ownership is explicit
// metadata; missing control means read-only/unavailable, never inferred from attachMode.
function controlFor(s) {
  if (!s) return null;
  if (s.control && s.control.drive && s.control.terminalSync) return s.control;
  const caps = agentCaps[s.tool] || {};
  const drive = caps.supportsResume
    ? { supported: true, state: 'unknown', reason: 'This adapter has not reported explicit Drive ownership state yet.' }
    : { supported: false, state: 'unavailable', reason: 'This adapter has not reported a Drive path for this session.' };
  const terminalSync = s.terminalSyncHint
    ? { supported: true, syncAvailable: true, active: false, label: s.terminalSyncHint.label, command: s.terminalSyncHint.command, note: s.terminalSyncHint.note }
    : {
        supported: !!caps.supportsLiveAttach,
        syncAvailable: false,
        active: false,
        reason: caps.supportsLiveAttach ? undefined : 'This adapter has not reported true terminal sync support.',
      };
  return { drive, terminalSync };
}

function canSendFromControl(s) {
  const c = controlFor(s);
  return !!(c && ((c.drive.supported && c.drive.state === 'driving') || (c.terminalSync.supported && c.terminalSync.active)));
}

// Can we send a NEW PROMPT (vs only ANSWER permission/question cards)? Drive = yes; an active terminal-sync =
// yes UNLESS the adapter marks the sync 'answer-only' (Claude hooks have no live-prompt-inject path, so the
// composer stays read-only there while the permission/question cards remain actionable via canSendFromControl).
function canPromptFromControl(s) {
  const c = controlFor(s);
  if (!c) return false;
  if (c.drive.supported && c.drive.state === 'driving') return true;
  return !!(c.terminalSync.supported && c.terminalSync.active && c.terminalSync.input !== 'answer-only');
}
function terminalSyncRoute(sync) {
  const explicitAction = sync?.action;
  if (explicitAction === 'join' || explicitAction === 'handoff') return explicitAction;
  return sync?.supported ? 'join' : 'handoff';
}

function terminalSyncPresenceHint(s, sync) {
  const launchSurface = s?.launchSurface || 'unknown';
  const presence = sync?.presence || 'unknown';
  if (launchSurface === 'app' && presence === 'absent') return 'No terminal is open; nothing is behind.';
  if (presence === 'shared') return 'Terminal is connected/synced.';
  if (presence === 'private') return sync?.behind === true ? 'Terminal is behind; restart/resume to rejoin.' : 'Terminal needs restart/rejoin to continue.';
  return '';
}

function terminalDrivingStatus(s, sync) {
  const launchSurface = s?.launchSurface || 'unknown';
  const presence = sync?.presence || 'unknown';
  if (launchSurface === 'app' && presence === 'absent') return 'No terminal is open; nothing is behind.';
  if (presence === 'shared') return 'Terminal is connected/synced.';
  if (presence === 'private') return sync?.behind === true ? 'Terminal is behind; restart or resume it to rejoin.' : 'Terminal needs restart/rejoin to continue.';
  return 'Driving in app';
}

function terminalCommandHint(sync) {
  return sync.command ? `Run this in a terminal:\n${sync.command}` : 'No terminal command is available for this session.';
}

async function copyCommandIfAvailable(cmd) {
  if (!cmd) return false;
  try {
    await navigator.clipboard.writeText(cmd);
    toast('Command copied');
    return true;
  } catch {
    toast('Copy failed — select and copy manually', 'error');
    return false;
  }
}

function handoffTransferBody(sync, presence) {
  const base = sync?.supported === false
    ? 'This session does not expose true live terminal sync; this is a one-way handoff.'
    : 'This command transfers control to the terminal; the app switches to Observe after a successful copy.';
  const instructions = presence === 'private'
    ? 'To continue this conversation in the terminal:\n1. Restart or re-open the terminal session\n2. Resume it with:'
    : 'To continue this conversation in the terminal:\n1. Open or resume a terminal session\n2. Run:';
  return `${base}\n\n${instructions}`;
}

function isAnswerOnlySync(s) {
  const c = controlFor(s);
  return !!(c && c.terminalSync.supported && c.terminalSync.active && c.terminalSync.input === 'answer-only');
}

function canMutateCurrentSession() {
  return !!(current && driving && canSendFromControl(current) && ws && ws.readyState === 1);
}

// Can we CHANGE model/effort/mode/agent from here? These ride a prompt/command frame, which an answer-only
// synced session (Claude hooks) rejects — so the pickers must follow PROMPT capability, not just send/answer
// capability (canMutateCurrentSession), or a hooks-synced session shows clickable pickers whose selection can
// never be applied (a misleading no-op). Mirrors the composer, which already gates on canPromptFromControl.
function canChangePicksCurrentSession() {
  return !!(current && driving && canPromptFromControl(current) && ws && ws.readyState === 1);
}

function forwardArtifactInteraction(meta, interaction) {
  if (!ws || ws.readyState !== 1) return;
  if (!meta?.session || !sameSession(current, meta.session)) return;
  const policy = meta.interactionPolicy;
  if (policy?.mode !== 'structured' || policy.bridgeVersion !== 1 || policy.schemaVersion !== 1 || !policy.interactionRef) {
    toast('This artifact is display-only', 'error');
    return;
  }
  if (!canChangePicksCurrentSession()) { blockReadOnlyAction('Artifact interaction'); return; }
  const msg = {
    kind: 'artifact-interaction',
    artifactKey: meta.artifactKey,
    interactionRef: policy.interactionRef,
    interaction,
    clientMessageId: nextClientMessageId('artifact'),
  };
  ws.send(JSON.stringify(msg));
  toast('Artifact interaction sent');
}

window.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'cosyncing-artifact-interaction') return;
  const sourceFrame = event.source;
  const meta = artifactFrames.get(sourceFrame);
  if (!meta || meta.artifactKey !== data.artifactKey) return;
  if (data.bridgeVersion !== 1 || data.schemaVersion !== 1) return;
  if (typeof event.origin === 'string' && event.origin !== 'null' && event.origin !== meta.origin) return;
  forwardArtifactInteraction(meta, data.interaction || {});
});

function blockReadOnlyAction(action = 'This action') {
  toast(`${action} is unavailable in read-only Observe. Use Drive or active terminal sync first.`, 'error');
}

// ── local history/artifact cache ─────────────────────────────────────────────
// Governing spec: docs/architecture/client-ui.md
// The app owns IndexedDB for fast reopen/offline read-only review; the broker remains authoritative.
function hasIndexedDb() {
  return typeof indexedDB !== 'undefined';
}

function openCacheDb() {
  if (!hasIndexedDb()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('artifacts')) db.createObjectStore('artifacts', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function idbGet(storeName, key) {
  const db = await openCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function idbPut(storeName, value) {
  const db = await openCacheDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

async function idbDelete(storeName, key) {
  const db = await openCacheDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

async function idbGetAll(storeName) {
  const db = await openCacheDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function idbClear(storeName) {
  const db = await openCacheDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

async function idbDeleteWhere(storeName, predicate) {
  const rows = await idbGetAll(storeName);
  const keys = rows.filter(predicate).map((r) => r.key).filter(Boolean);
  if (!keys.length) return 0;
  const db = await openCacheDb();
  if (!db) return 0;
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    keys.forEach((key) => store.delete(key));
    tx.oncomplete = () => resolve(keys.length);
    tx.onerror = () => resolve(0);
  });
}

function sessionCacheKeyFor(s) {
  if (!s) return '';
  return [s.machine || 'local', s.tool, s.id].join('\0');
}

function cachedOfflineControl(reason = 'Broker is offline; cached sessions are read-only.') {
  return {
    drive: { supported: false, state: 'unavailable', reason },
    terminalSync: { supported: false, syncAvailable: false, active: false, reason },
  };
}

function cacheMessageId(m, index) {
  if (!m) return 'missing:' + index;
  if (m.type === 'file-artifact') return ['artifact', m.artifactKey || m.contentHash || m.path || m.name || index].join(':');
  if (m.key) return [m.type, m.key].join(':');
  if (m.requestId) return [m.type, m.requestId].join(':');
  if (m.callId) return [m.type, m.callId].join(':');
  if (m.type === 'token-count') return ['token', m.input ?? '', m.output ?? '', m.cost ?? ''].join(':');
  if (m.type === 'error') return ['error', stableTextHash(m.message || '')].join(':');
  if (m.type === 'terminal-output') return ['terminal-output', stableTextHash(m.data || '')].join(':');
  return [m.type || 'event', index, JSON.stringify(m).slice(0, 160)].join(':');
}

function stableTextHash(text) {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i++) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Client-side render/cache bound, matching the broker's COSYNCING_HISTORY_MAX_MESSAGES default: the
// thread DOM and the per-session IndexedDB row hold at most this many of the NEWEST messages. A 16k
// message synchronous replay is what froze/crashed the tab on long sessions (2026-07-03 perf review).
const HISTORY_RENDER_MAX = 500;
const CACHED_MESSAGES_MAX = 1000;

function capCachedMessages(messages) {
  return messages.length > CACHED_MESSAGES_MAX ? messages.slice(-CACHED_MESSAGES_MAX) : messages;
}

/** Honest marker at the top of a capped thread ("last N of M"). Not `.empty`-classed:
 *  clearTransientThreadState() removes `.empty` nodes on the next render. */
function showTruncationNote(t) {
  let el = document.getElementById('historyTruncNote');
  if (!el) {
    el = document.createElement('div');
    el.id = 'historyTruncNote';
    el.style.cssText = 'color:var(--muted);text-align:center;padding:10px 0 4px;font-size:12px;';
  }
  el.textContent = `Showing the last ${t.shown ?? t.total} of ${t.total} messages — older history stays in the agent's own transcript.`;
  thread.prepend(el);
}

// Live-message cache writes are DEBOUNCED: each save serializes the whole cached-message array into
// IndexedDB, so writing on every streamed delta made a busy long session cost O(history) per token.
let saveCacheTimer = null;
let saveCachePending = null;
function scheduleSaveSessionCache(s, messages, cursor) {
  saveCachePending = { s, messages, cursor };
  if (saveCacheTimer) return;
  saveCacheTimer = setTimeout(() => {
    saveCacheTimer = null;
    const p = saveCachePending;
    saveCachePending = null;
    if (p) void saveSessionCache(p.s, p.messages, p.cursor);
  }, 500);
}

function mergeCachedMessages(existing, incoming) {
  const out = existing.slice();
  const pos = new Map(out.map((m, i) => [cacheMessageId(m, i), i]));
  incoming.forEach((m, i) => {
    const id = cacheMessageId(m, out.length + i);
    const at = pos.get(id);
    if (at == null) {
      pos.set(id, out.length);
      out.push(m);
    } else {
      out[at] = m;
    }
  });
  return out;
}

const rememberedInfoSig = new Map();
async function rememberSessionInfo(s) {
  if (!s) return;
  const key = sessionCacheKeyFor(s);
  // Skip the IndexedDB round-trip when nothing changed: the roster poll calls this for EVERY session
  // every 6s, and each put rewrites the row INCLUDING its cached messages — for ~1000 sessions that
  // was megabytes of main-thread IndexedDB churn per poll for no new information.
  const sig = JSON.stringify({ ...s, offlineCached: undefined });
  if (rememberedInfoSig.get(key) === sig) return;
  rememberedInfoSig.set(key, sig);
  const prev = await idbGet('sessions', key);
  await idbPut('sessions', {
    ...(prev || {}),
    key,
    info: { ...s, offlineCached: undefined },
    cursor: prev?.cursor || null,
    messages: prev?.messages || [],
    sizeBytes: prev?.sizeBytes || 0,
    updatedAt: Date.now(),
  });
}

function updateLocalRosterSession(info) {
  if (!info || !lastRosterSessions.length) return;
  const i = lastRosterSessions.findIndex((s) => sameSession(s, info));
  if (i < 0) return;
  lastRosterSessions[i] = mergeSessionInfo(lastRosterSessions[i], info);
  renderRoster();
}

function sameSession(a, b) {
  return !!(a && b && a.tool === b.tool && a.id === b.id);
}

// ── per-session sticky model pick (issues-part1: take-over forgets the app-picked model) ────────
function modelPickStorageKey(s) {
  return 'cosyncing:modelPick:' + s.tool + ':' + (s.lineageId || s.id);
}
function saveModelPick() {
  if (!current || !selectedModel || !selectedModelDirty) return;
  try { localStorage.setItem(modelPickStorageKey(current), JSON.stringify(selectedModel)); } catch { /* private mode etc. */ }
}
function restoreModelPick(s) {
  try {
    const raw = localStorage.getItem(modelPickStorageKey(s));
    if (!raw) return;
    const m = JSON.parse(raw);
    if (!m || !m.modelID) return;
    selectedModel = m;
    selectedModelDirty = true; // explicit user intent → rides the next prompt as an override
  } catch { /* unreadable/blocked storage → keep the session's own model */ }
}

const DRIVING_STICKY_MS = 30 * 60 * 1000;
function drivingStorageKey(s) {
  return 'cosyncing:driving:' + s.tool + ':' + s.id;
}
function rememberDrivingIntent(s) {
  if (!s) return;
  try { localStorage.setItem(drivingStorageKey(s), String(Date.now())); } catch { /* private mode etc. */ }
}
function clearDrivingIntent(s) {
  if (!s) return;
  try { localStorage.removeItem(drivingStorageKey(s)); } catch { /* private mode etc. */ }
}
function shouldResumeFromStickyDriving(s) {
  try {
    const raw = localStorage.getItem(drivingStorageKey(s));
    if (!raw) return false;
    const ts = Number(raw);
    if (Number.isFinite(ts) && Date.now() - ts <= DRIVING_STICKY_MS) return true;
    localStorage.removeItem(drivingStorageKey(s));
  } catch { /* unreadable/blocked storage → observe */ }
  return false;
}

function refreshCurrentSessionUi() {
  if (!current) return;
  driving = canSendFromControl(current);
  renderSessionMeta();
  renderStatusline();
  renderSyncHint(current);
  renderControlState();
  renderControls();
  updateComposerButtons();
}

function syncCurrentFromRoster(sessions) {
  if (!current) return;
  const next = sessions.find((s) => sameSession(s, current));
  if (!next) return;
  current = mergeSessionInfo(current, next);
  currentRosterStatus = current.status || currentRosterStatus;
  refreshCurrentSessionUi();
}

async function loadSessionCache(s) {
  if (!s) return null;
  return idbGet('sessions', sessionCacheKeyFor(s));
}

async function saveSessionCache(s, messages, cursor) {
  if (!s) return;
  const key = sessionCacheKeyFor(s);
  await idbPut('sessions', {
    key,
    info: { ...s, offlineCached: undefined },
    messages,
    cursor: cursor || null,
    sizeBytes: roughJsonBytes(messages),
    updatedAt: Date.now(),
  });
  void enforceLocalCacheRetention();
}

async function listCachedSessions() {
  const rows = await idbGetAll('sessions');
  return rows
    .filter((r) => r.info && Array.isArray(r.messages) && r.messages.length)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((r) => ({
      ...r.info,
      status: 'idle',
      offlineCached: true,
      control: cachedOfflineControl(),
      updatedAt: r.updatedAt || r.info.updatedAt,
    }));
}

function artifactCacheKey(m) {
  return [currentCacheKey || 'session', m.artifactKey || m.contentHash || m.path || m.name].join('\0');
}

async function loadArtifactBlob(m) {
  const row = await idbGet('artifacts', artifactCacheKey(m));
  return row?.blob || null;
}

async function saveArtifactBlob(m, blob) {
  await idbPut('artifacts', {
    key: artifactCacheKey(m),
    sessionKey: currentCacheKey || 'session',
    blob,
    mimeType: m.mimeType || blob.type || 'application/octet-stream',
    size: blob.size,
    updatedAt: Date.now(),
  });
  void enforceLocalCacheRetention();
}

function roughJsonBytes(value) {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    try { return JSON.stringify(value).length; } catch { return 0; }
  }
}

async function enforceLocalCacheRetention() {
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  await idbDeleteWhere('sessions', (r) => (r.updatedAt || 0) < cutoff);
  await idbDeleteWhere('artifacts', (r) => (r.updatedAt || 0) < cutoff);

  const sessions = await idbGetAll('sessions');
  const artifacts = await idbGetAll('artifacts');
  let total =
    sessions.reduce((sum, r) => sum + (r.sizeBytes || 0), 0) +
    artifacts.reduce((sum, r) => sum + (r.size || 0), 0);
  if (total <= CACHE_MAX_BYTES) return;

  const victims = [
    ...artifacts.map((r) => ({ store: 'artifacts', key: r.key, size: r.size || 0, updatedAt: r.updatedAt || 0 })),
    ...sessions.map((r) => ({ store: 'sessions', key: r.key, size: r.sizeBytes || 0, updatedAt: r.updatedAt || 0 })),
  ].sort((a, b) => a.updatedAt - b.updatedAt);
  for (const victim of victims) {
    if (total <= CACHE_MAX_BYTES * 0.8) break;
    await idbDelete(victim.store, victim.key);
    total -= victim.size;
  }
}

function revokeArtifactObjectUrls() {
  for (const url of artifactObjectUrls.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  artifactObjectUrls.clear();
}

function canPrefetchArtifact(m) {
  if (!m.fetchUrl || !m.artifactKey) return false;
  if (isHtmlArtifact(m)) return false;
  if ((m.size || 0) > ARTIFACT_PREFETCH_BYTES) return false;
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c?.saveData) return false;
    if (c?.effectiveType && /(^|-)2g$/.test(c.effectiveType)) return false;
  } catch {}
  return true;
}

async function clearAllLocalCache() {
  revokeArtifactObjectUrls();
  await idbClear('sessions');
  await idbClear('artifacts');
  toast('Local cache cleared');
}

async function clearCurrentSessionCache() {
  if (!current) return;
  revokeArtifactObjectUrls();
  const key = sessionCacheKeyFor(current);
  await idbDelete('sessions', key);
  await idbDeleteWhere('artifacts', (r) => r.sessionKey === key || String(r.key || '').startsWith(key + '\0'));
  await fetch(`/api/sessions/${encodeURIComponent(current.tool)}/${encodeURIComponent(current.id)}/cache`, { method: 'DELETE', headers: { ...tokenHeader() } }).catch(() => null);
  currentCachedMessages = [];
  currentHistoryCursor = null;
  toast('Session cache cleared');
}

// ── roster ───────────────────────────────────────────────────────────────────
// Governing UX doc: docs/architecture/client-ui.md
function loadingRosterHtml() {
  return '<div class="loadingState" role="status" aria-live="polite">' +
    '<span class="spinner" aria-hidden="true"></span><span>Loading sessions</span>' +
    '<div class="skeletonList" aria-hidden="true"><i></i><i></i><i></i></div></div>';
}

function sessionLoadingHtml(s) {
  const title = escapeHtml(s?.title || s?.id || 'session');
  const tool = escapeHtml(agentInfos[s?.tool]?.displayName || s?.tool || '');
  const meta = [title, tool].filter(Boolean).join(' · ');
  return '<div id="sessionLoading" class="sessionLoading loadingState" role="status" aria-live="polite">' +
    '<span class="spinner" aria-hidden="true"></span>' +
    '<span class="sessionLoadingTitle">Opening session</span>' +
    `<span class="sessionLoadingMeta">${meta}</span>` +
    '<div class="skeletonList" aria-hidden="true"><i></i><i></i></div></div>';
}

function clearTransientThreadState() {
  document.getElementById('sessionLoading')?.remove();
  const empty = thread.querySelector('.empty');
  if (empty && empty.parentElement === thread) empty.remove();
}

function showEmptyThreadNote(text) {
  if (!thread.childElementCount) thread.innerHTML = `<div class="empty">${escapeHtml(text)}</div>`;
}

const ROSTER_FETCH_TIMEOUT_MS = 20000; // bound each roster fetch: a hung broker socket must not wedge rosterLoading=true forever (that would drop every future poll — the exact "stuck loading" failure this path guards against)
let rosterLoading = false;
let rosterReloadPending = false;
async function loadRoster(force = false) {
  // One roster fetch at a time (each response also fans out IndexedDB writes — overlapping polls used to
  // snowball the main thread). A timer/visibility poll that overlaps an in-flight fetch is DROPPED, never
  // queued — otherwise a roster slower than the 6s poll would relaunch on every completion, a continuous
  // fetch/parse loop. Only a USER-forced refresh (force=true, e.g. a session-history window change) queues
  // a pending reload so the new request runs once the in-flight one settles (the new window can't be masked).
  if (rosterLoading) { if (force) rosterReloadPending = true; return; }
  rosterLoading = true;
  try {
    await loadRosterOnce();
  } finally {
    rosterLoading = false;
    if (rosterReloadPending) { rosterReloadPending = false; void loadRoster(true); }
  }
}
async function loadRosterOnce() {
  if (!rosterList.querySelector('.project')) rosterList.innerHTML = loadingRosterHtml(); // no flash on refresh
  const reqWindow = sessionWindow; // capture: if the window changes mid-flight, discard this response
  let data;
  try {
    // Per-device window + conditional GET: If-None-Match lets an unchanged roster return 304 (no body,
    // no re-render), and ?window= keeps a phone from pulling every historical session. cache:no-store so
    // the browser hands us the real 304 instead of transparently serving a cached 200.
    const headers = {};
    if (lastRosterEtag) headers['if-none-match'] = lastRosterEtag;
    const qs = reqWindow && reqWindow !== 'all' ? `?window=${encodeURIComponent(reqWindow)}` : '';
    // Bound the fetch (AbortSignal.timeout where supported): a hung socket rejects instead of hanging
    // forever, so `finally` resets rosterLoading and the next poll retries rather than the roster wedging.
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ROSTER_FETCH_TIMEOUT_MS) : undefined;
    const res = await fetch(`/api/sessions${qs}`, { cache: 'no-store', headers, signal });
    if (res.status === 304) return; // roster unchanged since last poll — keep the current view as-is
    const etag = res.headers.get('etag');
    const parsed = await res.json();
    // Recheck AFTER the body download, not just after headers: fetch() resolves at headers, and the
    // window can change while the (potentially large) body streams. If it did, discard this response for
    // the now-wrong window — don't store its ETag or render it; the pending reload fetches the current one.
    if (reqWindow !== sessionWindow) return;
    lastRosterEtag = etag;
    data = parsed;
  } catch (e) {
    // A transient poll error/timeout must not blow away an already-rendered roster (flashing it to the
    // offline view and back). If sessions are on screen, keep them and let the next poll retry; only fall
    // back to cached/unreachable when nothing is rendered yet (first load against a down broker).
    if (rosterList.querySelector('.project')) return;
    const cached = await listCachedSessions();
    if (cached.length) {
      $('#machine').textContent = '· cached';
      lastRosterSessions = cached;
      renderRoster(cached);
    } else {
      rosterList.innerHTML = '<div class="empty">Broker unreachable.</div>';
    }
    return;
  }
  $('#machine').textContent = data.machine ? '· ' + data.machine : '';
  const sessions = data.sessions || [];
  sessions.forEach((s) => void rememberSessionInfo(s));
  updateReviewNotices(sessions);
  lastRosterSessions = sessions;
  syncCurrentFromRoster(sessions);
  renderRoster(sessions);
}

function renderRoster(sessions = lastRosterSessions) {
  if (!sessions.length) {
    rosterList.innerHTML =
      '<div class="empty">No sessions found.<br/><br/>Start one (e.g. <code>opencode</code> or <code>pi</code>) and refresh.</div>';
    return;
  }
  refreshAgentFilterOptions(sessions);
  const filtered = sessions.filter(sessionPassesFilters);
  if (!filtered.length) {
    rosterList.innerHTML = '<div class="empty">No sessions match.</div>';
    return;
  }
  const projects = groupByProject(filtered);
  const continuedBy = lineageContinuationMap(filtered);
  // Parent↔child linkage (subagent display): counts from the FULL payload (children are usually
  // filtered out), parents resolved by the tool's native id.
  const subagentChildren = new Map(); // `${tool}:${parentThreadId}` → count
  const byNativeId = new Map(); // `${tool}:${nativeId}` → session
  for (const s of sessions) {
    if (s.nativeId) byNativeId.set(`${s.tool}:${s.nativeId}`, s);
    if (s.origin === 'subagent' && s.parentThreadId) {
      const k = `${s.tool}:${s.parentThreadId}`;
      subagentChildren.set(k, (subagentChildren.get(k) || 0) + 1);
    }
  }
  const rowLink = (s) => ({
    childCount: s.nativeId ? subagentChildren.get(`${s.tool}:${s.nativeId}`) || 0 : 0,
    parent: s.origin === 'subagent' && s.parentThreadId ? byNativeId.get(`${s.tool}:${s.parentThreadId}`) : undefined,
  });
  rosterList.innerHTML = '';
  for (const project of projects) {
    const wrap = document.createElement('div');
    const open = openProjects.has(project.key);
    const pStatus = projectStatus(project.sessions);
    wrap.className = 'project ' + pStatus + (open ? ' open' : '');
    const head = document.createElement('div');
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(open));
    head.tabIndex = 0;
    head.className = 'projectHead';
    head.innerHTML = '<span class="projectCaret"></span><span class="projectName"></span><span class="reviewDot" title="Ready to review" aria-label="Ready to review"></span><span class="projectStatus"></span><span class="projectCount"></span><button class="renameAction projectNew" type="button">+</button><button class="renameAction projectRename" type="button" title="Rename project" aria-label="Rename project">✎</button>';
    head.classList.add(pStatus);
    if (projectHasReview(project)) head.classList.add('review-ready');
    head.querySelector('.projectCaret').textContent = open ? '⌄' : '›';
    head.querySelector('.projectName').textContent = project.name;
    head.querySelector('.projectStatus').textContent = projectStatusLabel(project.sessions, pStatus);
    head.querySelector('.projectCount').textContent = project.sessions.length + ' session' + (project.sessions.length === 1 ? '' : 's');
    head.onclick = () => {
      if (openProjects.has(project.key)) openProjects.delete(project.key);
      else openProjects.add(project.key);
      renderRoster();
    };
    head.onkeydown = (e) => {
      if (e.target !== head || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      head.onclick();
    };
    const rename = head.querySelector('.projectRename');
    rename.onclick = (e) => {
      e.stopPropagation();
      void requestProjectRename(project);
    };
    const projectNew = head.querySelector('.projectNew');
    projectNew.title = `New session in ${project.name}`;
    projectNew.setAttribute('aria-label', `New session in ${project.name}`);
    projectNew.disabled = !project.cwd;
    projectNew.onclick = (e) => {
      e.stopPropagation();
      if (project.cwd) void newSession({ directory: project.cwd, projectName: project.name });
    };
    const path = document.createElement('div');
    path.className = 'projectPath';
    path.textContent = project.cwd || 'No directory';
    wrap.append(head, path);
    if (open) {
      for (const [label, list] of statusGroups(project.sessions)) {
        if (list.length) wrap.append(groupEl(label, list.length), ...list.map((s) => rowEl(s, continuedBy.get(sessionKey(s)), rowLink(s))));
      }
    }
    rosterList.append(wrap);
  }
}

function lineageContinuationMap(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    if (!s.lineageId) continue;
    const key = `${s.tool}:${s.lineageId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const out = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) => activityTime(b) - activityTime(a));
    const primary = sorted[0];
    for (const older of sorted.slice(1)) out.set(sessionKey(older), primary.title || primary.id);
  }
  return out;
}

function groupEl(label, count) {
  const d = document.createElement('div');
  d.className = 'group';
  d.innerHTML = '<span></span><span class="gcount"></span>';
  d.querySelector('span').textContent = label;
  d.querySelector('.gcount').textContent = String(count);
  return d;
}

function sessionPassesFilters(s) {
  // Auto-origin default-hide (subagent/exec; vscode toggleable). Escape hatches: the currently open
  // session never vanishes from the list, and a parent's ⚒ chip reveals ITS children while the
  // global toggle stays off.
  if (s.origin && hiddenOrigins.has(s.origin)) {
    const isOpen = current && current.id === s.id && current.tool === s.tool;
    const revealed = s.origin === 'subagent' && s.parentThreadId && revealedSubagentParents.has(`${s.tool}:${s.parentThreadId}`);
    if (!isOpen && !revealed) return false;
  }
  const q = ($('#sessionSearch')?.value || '').trim().toLowerCase();
  if (q && !sessionMatches(s, q)) return false;
  const status = $('#statusFilter')?.value || '';
  const normalizedStatus = s.status === 'needs-input' || s.status === 'working' ? s.status : 'idle';
  if (status && normalizedStatus !== status) return false;
  const agent = $('#agentFilter')?.value || '';
  if (agent && s.tool !== agent) return false;
  const activity = $('#activityFilter')?.value || '';
  if (activity && !activityMatches(s, activity)) return false;
  const olderThan = Number($('#olderThanDays')?.value || 0);
  if (olderThan > 0 && !isOlderThan(s, olderThan)) return false;
  return true;
}

function sessionMatches(s, q) {
  return [s.title, s.projectName, projectName(s.cwd), s.tool, agentInfos[s.tool]?.displayName, s.model, s.cwd, s.status, s.attachMode]
    .filter(Boolean)
    .some((x) => String(x).toLowerCase().includes(q));
}

function activityTime(s) {
  return s.updatedAt || s.createdAt || 0;
}

function ageMs(s) {
  const t = activityTime(s);
  return t ? Date.now() - t : Infinity;
}

function activityMatches(s, filter) {
  const day = 86400 * 1000;
  const age = ageMs(s);
  if (filter === 'today') return age <= day;
  if (filter === '7d') return age <= 7 * day;
  if (filter === '30d') return age <= 30 * day;
  if (filter === 'old7') return age > 7 * day;
  if (filter === 'old30') return age > 30 * day;
  return true;
}

function isOlderThan(s, days) {
  return ageMs(s) > days * 86400 * 1000;
}

function refreshAgentFilterOptions(sessions) {
  const sel = $('#agentFilter');
  if (!sel) return;
  const currentValue = sel.value;
  const ids = [...new Set(sessions.map((s) => s.tool).filter(Boolean))].sort((a, b) =>
    (agentInfos[a]?.displayName || a).localeCompare(agentInfos[b]?.displayName || b),
  );
  sel.innerHTML = '<option value="">All agents</option>';
  for (const id of ids) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = agentInfos[id]?.displayName || id;
    sel.append(opt);
  }
  if (ids.includes(currentValue)) sel.value = currentValue;
}

function groupByProject(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = s.cwd || '(unknown)';
    if (!map.has(key)) map.set(key, { key, cwd: s.cwd || '', name: s.projectName || projectName(s.cwd), sessions: [] });
    const project = map.get(key);
    if (s.projectName) project.name = s.projectName;
    project.sessions.push(s);
  }
  return [...map.values()]
    .map((p) => ({ ...p, sessions: p.sessions.sort(compareSessions) }))
    .sort((a, b) => projectRank(a) - projectRank(b) || latestTime(b) - latestTime(a) || a.name.localeCompare(b.name));
}

function projectName(cwd) {
  if (!cwd) return 'No directory';
  const clean = String(cwd).replace(/\/+$/, '');
  return clean.split('/').pop() || clean;
}

function latestTime(project) {
  return Math.max(0, ...project.sessions.map(activityTime));
}

function projectRank(project) {
  return Math.min(...project.sessions.map(statusRank));
}

function projectStatus(sessions) {
  if (sessions.some((s) => s.status === 'needs-input')) return 'needs-input';
  if (sessions.some((s) => s.status === 'working')) return 'working';
  return 'idle';
}

function projectStatusLabel(sessions, status) {
  const n = sessions.filter((s) => (status === 'idle' ? s.status !== 'needs-input' && s.status !== 'working' : s.status === status)).length;
  if (status === 'needs-input') return `${n} need input`;
  if (status === 'working') return `${n} working`;
  return 'idle';
}

function statusRank(s) {
  return s.status === 'needs-input' ? 0 : s.status === 'working' ? 1 : 2;
}

function compareSessions(a, b) {
  return statusRank(a) - statusRank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

function statusGroups(sessions) {
  return [
    ['Needs input', sessions.filter((s) => s.status === 'needs-input')],
    ['Working', sessions.filter((s) => s.status === 'working')],
    ['Idle', sessions.filter((s) => s.status !== 'needs-input' && s.status !== 'working')],
  ];
}

function sessionKey(s) {
  return `${s.tool}\u0000${s.id}`;
}

function normalizedStatus(s) {
  return s.status === 'needs-input' || s.status === 'working' ? s.status : 'idle';
}

function projectHasReview(project) {
  return project.sessions.some((s) => reviewSessionKeys.has(sessionKey(s)));
}

function isTerminalSynced(s) {
  return !!s?.control?.terminalSync?.active;
}

// D4: a session that COULD be synced now (or via one setup step) but isn't yet — the roster ghost badge.
function isSyncAvailable(s) {
  const t = s?.control?.terminalSync;
  return !!(t && t.syncAvailable && !t.active);
}

function updateReviewNotices(sessions) {
  const next = new Map();
  for (const s of sessions) {
    const key = sessionKey(s);
    const status = normalizedStatus(s);
    const prev = rosterStatusBySession.get(key);
    const isOpen = current && current.tool === s.tool && current.id === s.id;
    if (prev === 'working' && status === 'idle' && !isOpen) reviewSessionKeys.add(key);
    if (status !== 'idle' || isOpen) reviewSessionKeys.delete(key);
    next.set(key, status);
  }
  for (const key of [...reviewSessionKeys]) if (!next.has(key)) reviewSessionKeys.delete(key);
  rosterStatusBySession = next;
}

function rowEl(s, continuedAs = '', link = null) {
  const d = document.createElement('div');
  const key = sessionKey(s);
  d.className =
    'srow' +
    (current && current.id === s.id && current.tool === s.tool ? ' active' : '') +
    (reviewSessionKeys.has(key) ? ' review-ready' : '');
  const meta = [s.offlineCached ? 'cached read-only' : agentInfos[s.tool]?.displayName || s.tool, s.model].filter(Boolean).join(' · ');
  const st = s.status || 'idle';
  d.innerHTML = `<div class="t">
      <span class="title"></span>
      <span class="reviewDot" title="Ready to review" aria-label="Ready to review"></span>
      <span class="rowSync syncBadge" title="Synced with terminal">synced</span>
      <span class="rowSyncAvail syncBadge ghost" title="Sync available — join this session live">sync available</span>
      <span class="badge ${st}">${st === 'needs-input' ? 'needs input' : st}</span>
      <button class="renameAction sessionRename" type="button" title="Rename session" aria-label="Rename session">✎</button>
    </div><div class="meta"></div>`;
  d.querySelector('.title').textContent = s.title || s.id;
  d.querySelector('.rowSync').style.display = isTerminalSynced(s) ? '' : 'none';
  d.querySelector('.rowSyncAvail').style.display = isSyncAvailable(s) ? '' : 'none';
  d.querySelector('.meta').textContent = [meta, relTime(s.updatedAt), continuedAs ? `↪ continued as "${continuedAs}"` : ''].filter(Boolean).join(' · ');
  const badges = d.querySelector('.badge');
  // Origin chips (subagent display): an auto session says what it is; a subagent links to its
  // parent; a parent with agent-spawned children gets a ⚒ chip that peeks them into the list.
  if (s.origin) {
    const chip = document.createElement('span');
    chip.className = 'syncBadge ghost originChip';
    chip.textContent = s.origin === 'subagent' ? '↳ agent-spawned' : s.origin === 'exec' ? 'exec' : 'IDE';
    if (s.origin === 'subagent' && link?.parent) {
      const parent = link.parent;
      chip.classList.add('linked');
      chip.textContent = `↳ ${parent.title || 'parent'}`;
      chip.title = `Spawned by "${parent.title || parent.id}" — click to open the parent session`;
      chip.onclick = (e) => {
        e.stopPropagation();
        void attach(parent);
      };
    } else if (s.origin === 'subagent') {
      chip.title = 'Spawned by another session (parent not in the current list)';
    } else {
      chip.title = s.origin === 'exec' ? 'Automated run (codex exec / agent-driven)' : 'Started from the IDE extension';
    }
    badges.before(chip);
  }
  if (link?.childCount) {
    const kids = document.createElement('span');
    const revealKey = `${s.tool}:${s.nativeId}`;
    const revealed = revealedSubagentParents.has(revealKey);
    kids.className = 'syncBadge ghost originChip kids' + (revealed ? ' on' : '');
    kids.textContent = `⚒ ${link.childCount}`;
    kids.title = revealed
      ? 'Hide this session’s agent-spawned sessions again'
      : `Show ${link.childCount} agent-spawned session${link.childCount === 1 ? '' : 's'} of this session in the list`;
    kids.onclick = (e) => {
      e.stopPropagation();
      if (revealed) revealedSubagentParents.delete(revealKey);
      else revealedSubagentParents.add(revealKey);
      renderRoster();
    };
    badges.before(kids);
  }
  d.querySelector('.sessionRename').onclick = (e) => {
    e.stopPropagation();
    void requestSessionRename(s);
  };
  d.onclick = () => attach(s);
  return d;
}

function renderSessionMeta() {
  const row = $('#sessionMeta');
  if (!row) return;
  row.innerHTML = '';
  if (!current) {
    row.style.display = 'none';
    return;
  }
  const title = document.createElement('span');
  title.className = 'sessionTitle';
  title.textContent = current.title || current.id;
  const renameSession = document.createElement('button');
  renameSession.type = 'button';
  renameSession.className = 'renameAction session';
  renameSession.title = 'Rename session';
  renameSession.setAttribute('aria-label', 'Rename session');
  renameSession.textContent = '✎';
  renameSession.onclick = () => void requestSessionRename(current);
  row.append(title, renameSession);
  // Fork/clone/export are command-surface actions, not session-meta buttons (maintainer §4.6): the session
  // UI must not accumulate buttons for infrequent lifecycle actions. The forkSession hook, the /fork
  // route, the canFork flag, and requestSessionFork remain for command-surface wiring — only the button
  // is intentionally absent. Buttons here stay limited to rename + the core drive/stop/model controls.
  if (current.cwd) {
    const project = document.createElement('span');
    project.className = 'sessionProject';
    project.textContent = current.projectName || projectName(current.cwd);
    project.title = current.cwd;
    const renameProject = document.createElement('button');
    renameProject.type = 'button';
    renameProject.className = 'renameAction project';
    renameProject.title = 'Rename project';
    renameProject.setAttribute('aria-label', 'Rename project');
    renameProject.textContent = '✎';
    renameProject.onclick = () => void requestProjectRename({
      key: current.cwd,
      cwd: current.cwd,
      name: current.projectName || projectName(current.cwd),
      sessions: [current],
    });
    row.append(project, renameProject);
  }
  row.style.display = '';
}

function applyRenamedSession(info) {
  if (!info) return;
  if (current && current.tool === info.tool && current.id === info.id) {
    current = mergeSessionInfo(current, info);
    renderSessionMeta();
    renderControlState();
    renderControls();
  }
  updateLocalRosterSession(info);
  void rememberSessionInfo(info);
}

function applyProjectAlias(cwd, name) {
  if (!cwd) return;
  const alias = name || undefined;
  lastRosterSessions = lastRosterSessions.map((s) => (s.cwd === cwd ? { ...s, projectName: alias } : s));
  if (current?.cwd === cwd) {
    current = { ...current, projectName: alias };
    renderSessionMeta();
    void rememberSessionInfo(current);
  }
  renderRoster();
}

async function requestSessionRename(s = current) {
  if (!s) return;
  const next = await promptDialog({
    title: 'Rename session',
    label: 'Session name',
    value: s.title || '',
    help: 'Leave blank to restore the adapter title.',
    confirmText: 'Save',
  });
  if (next === undefined) return;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(s.tool)}/${encodeURIComponent(s.id)}/rename`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...tokenHeader() },
      body: JSON.stringify({ title: next }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `rename failed (${r.status})`);
    if (d.session) applyRenamedSession(d.session);
    else if (next.trim()) applyRenamedSession({ ...s, title: next.trim() });
    toast(d.title ? 'Session renamed' : 'Session title reset');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not rename session', 'error');
  }
}

async function requestSessionFork(s = current, messageId) {
  if (!s) return;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(s.tool)}/${encodeURIComponent(s.id)}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenHeader() },
      body: JSON.stringify(messageId ? { messageId } : {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `fork failed (${r.status})`);
    if (d.session) {
      const next = { ...d.session };
      lastRosterSessions = [next, ...lastRosterSessions.filter((row) => !(row.tool === next.tool && row.id === next.id))];
      renderRoster();
      await attach(next);
    }
    toast('Session forked');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not fork session', 'error');
  }
}

// Gated R2 transcript export (Slice 6). COMMAND-surface action per maintainer §4.6 — no session-meta
// button. Availability is computed from the backend hook + registry enablement (canTranscriptExport),
// never an agent-name branch. Flow: preflight (server issues a confirmation nonce) -> confirm dialog
// stating irreversibility/content-leaves-boundary/destination -> execute with the nonce -> render the
// returned export-attachment file-artifact card (metadata only; download rides the existing
// authenticated fetch -> Blob path). Never inline-previews or innerHTMLs exported content.
async function requestTranscriptExport(s = current) {
  if (!s) return;
  if (!agentCaps[s.tool]?.canTranscriptExport) {
    toast('Transcript export is not available for this agent.', 'error');
    return;
  }
  try {
    const pf = await fetch(`/api/sessions/${encodeURIComponent(s.tool)}/${encodeURIComponent(s.id)}/export/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenHeader() },
      body: '{}',
    });
    const pfd = await pf.json().catch(() => ({}));
    // T2 (remote/phone) export is default-deny unless enabled on the host (maintainer Decision #3): show a
    // human explanation instead of the raw COSYNCING_R2_ENABLED_ACTIONS reason string.
    if (pf.status === 403 && pfd.code === 'R2_DISABLED') {
      throw new Error('Transcript export is turned off for remote devices. Enable it on the host machine.');
    }
    if (!pf.ok || !pfd.nonce) throw new Error(pfd.error || `export unavailable (${pf.status})`);
    const c = pfd.confirm || {};
    const ok = await confirmDialog({
      title: 'Download transcript',
      body: c.message || `Download the full transcript of “${s.title || s.id}” as a redacted ${(c.format || 'file').toUpperCase()} file.`,
      confirmText: 'Download',
      cancelText: 'Cancel',
    });
    if (!ok) return;
    const r = await fetch(`/api/sessions/${encodeURIComponent(s.tool)}/${encodeURIComponent(s.id)}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenHeader() },
      body: JSON.stringify({ nonce: pfd.nonce }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.artifact) throw new Error(d.error || `export failed (${r.status})`);
    // Render the export-attachment as a normal file-artifact card. Its octet-stream mime keeps it
    // download-only (isHtmlArtifact is false), so exported content is never inline-rendered.
    render({ ...d.artifact, proactive: true });
    toast('Transcript ready to download');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not export transcript', 'error');
  }
}

async function requestProjectRename(project) {
  if (!project?.cwd) {
    toast('Project rename needs a session directory.', 'error');
    return;
  }
  const next = await promptDialog({
    title: 'Rename project',
    label: 'Project name',
    value: project.name || projectName(project.cwd),
    help: 'This changes the app label only. The real directory is not renamed.',
    confirmText: 'Save',
  });
  if (next === undefined) return;
  try {
    const r = await fetch('/api/projects/rename', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...tokenHeader() },
      body: JSON.stringify({ cwd: project.cwd, name: next }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `rename failed (${r.status})`);
    applyProjectAlias(d.cwd || project.cwd, d.projectName || '');
    toast(d.projectName ? 'Project renamed' : 'Project name reset');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not rename project', 'error');
  }
}

function mergeSessionInfo(previous, incoming) {
  if (!previous || !incoming || previous.tool !== incoming.tool || previous.id !== incoming.id) return incoming;
  const merged = { ...incoming };
  // The roster row and the WebSocket session frame are both backend-provided SessionInfo. If a partial
  // attach frame drops optional control metadata, keep the explicit state already seen for the same
  // session instead of falling back to "Control unknown". This preserves backend truth; it never infers
  // ownership from attachMode. Governing docs:
  // docs/architecture/client-ui.md and docs/architecture/client-ui.md
  if (!merged.control && previous.control) merged.control = previous.control;
  if (!merged.terminalSyncHint && previous.terminalSyncHint) merged.terminalSyncHint = previous.terminalSyncHint;
  // Per-socket frames describe live control state and often omit recency/identity metadata. Dropping
  // them re-SORTS the roster row: updatedAt undefined → 0 → the row sinks from its real rank to the
  // bottom of its group until the next poll restores it, then sinks again on the next frame — the
  // "session disappears from the left panel for a bit, then reappears" oscillation (issues-part2).
  if (merged.updatedAt === undefined && previous.updatedAt !== undefined) merged.updatedAt = previous.updatedAt;
  if (merged.createdAt === undefined && previous.createdAt !== undefined) merged.createdAt = previous.createdAt;
  if (!merged.cwd && previous.cwd) merged.cwd = previous.cwd;
  if (!merged.projectName && previous.projectName) merged.projectName = previous.projectName;
  // Origin tags are roster identity too: a frame that omits them must not un-hide an auto session
  // or break the parent↔child linkage (same class as the updatedAt sort-key oscillation above).
  if (!merged.origin && previous.origin) merged.origin = previous.origin;
  if (!merged.parentThreadId && previous.parentThreadId) merged.parentThreadId = previous.parentThreadId;
  if (!merged.nativeId && previous.nativeId) merged.nativeId = previous.nativeId;
  return merged;
}

// Terminal-sync instructions: shown when the adapter provides a hint (OpenCode today).
// Generic — the UI never special-cases a tool, it just renders whatever the adapter sends.
function renderSyncHint(info) {
  const el = $('#synchint');
  if (info?.control) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const h = info && info.terminalSyncHint;
  if (!h) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = `<div class="sh-row">
      <span class="sh-label"></span>
      <button class="sh-toggle">show command</button>
    </div>
    <div class="sh-body" style="display:none">
      <code class="sh-cmd"></code>
      <button class="sh-copy">copy</button>
      <div class="sh-note"></div>
    </div>`;
  el.querySelector('.sh-label').textContent = '💻 ' + h.label;
  el.querySelector('.sh-cmd').textContent = h.command;
  el.querySelector('.sh-note').textContent = h.note || '';
  const body = el.querySelector('.sh-body');
  el.querySelector('.sh-toggle').onclick = (e) => {
    const open = body.style.display === 'none';
    body.style.display = open ? 'flex' : 'none';
    e.target.textContent = open ? 'hide command' : 'show command';
  };
  el.querySelector('.sh-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(h.command); toast('Command copied'); }
    catch { toast('Copy failed — select & copy manually', 'error'); }
  };
}

// Relative "x ago" timestamp for the roster (instant-messenger style).
function relTime(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ── attach ───────────────────────────────────────────────────────────────────
async function attach(s, mode = null) {
  const attachToken = ++attachSeq;
  // Sticky driving exists for sessions whose Drive is an EXPLICIT mode (?mode=resume survives a
  // refresh). A session that is already mutable on its BARE attach (opencode shared-serve rows report
  // drive:'driving'; full terminal sync) must NOT be re-opened as resume: that key (`tool:id#resume`)
  // is a DIFFERENT Hub owner (an `opencode run` rival to the serve), so a second tab attached that way
  // shares nothing live with the first — the item-14 draft-sync split. Ignore + clean the stale intent.
  if (!mode && shouldResumeFromStickyDriving(s)) {
    // canSend on the ROSTER row can come from a still-open DRIVE (#resume) conn's overlay — that
    // mutability belongs to the resume owner, NOT to a bare attach. After a refresh, claude's old
    // drive conn survives the Hub's 15s grace and stamps drive:'driving' + attachMode:'resume' on
    // the row; treating that like an opencode bare-mutable row cleared the intent and reopened
    // OBSERVE — drive silently lost on every refresh (item 13.1 re-flag). Only a row that is
    // mutable on its BARE attach (shared serve / daemon-live: attachMode 'live') cleans the intent.
    if (canSendFromControl(s) && s.attachMode !== 'resume') clearDrivingIntent(s);
    else mode = 'resume';
  }
  lastAttachMode = mode; // effective mode — a visibility resync must reopen the stream the same way
  sessionEndedByServer = false;
  // Draft hygiene on a session SWITCH (issues-part2 item-14 follow-up): kill any pending debounce
  // from the previous composer and clear the box — the old session's text must neither leak into
  // this session's shared draft nor sit visibly in its composer until a replay overwrites it. A
  // same-session reattach (visibility resync) keeps both: the user's in-progress typing survives.
  const reattachingSame = !!(current && s && sameSession(current, s));
  closeScheduleSheet(); // never leave another attach/profile generation's prompt text in the edit sheet
  if ($('#schedulesSheet')?.classList.contains('open')) $('#schedulesList').textContent = 'Refreshing…';
  if (draftSyncTimer) { clearTimeout(draftSyncTimer); draftSyncTimer = null; }
  if (!reattachingSame) {
    input.value = '';
    input.style.height = 'auto';
    lastLocalInputAt = 0; // typing recency belonged to the previous session — don't block this one's draft replay
  }
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  revokeArtifactObjectUrls();
  current = s;
  currentCacheKey = sessionCacheKeyFor(s);
  currentCachedMessages = [];
  currentHistoryCursor = null;
  historyReceived = false;
  if (!reattachingSame) {
    clearPendingScheduleElements();
    pendingSchedules.clear();
  }
  lastSyncedDraft = null; // new session → let its draft replay through (multi-client sync)
  reviewSessionKeys.delete(sessionKey(s));
  currentRosterStatus = s ? s.status : null; // captured before the session frame overwrites `current`
  // DRIVING = this socket can send prompts only after an explicit Drive attach or a backend-proven
  // true-sync/driving control state. See docs/architecture/client-ui.md
  driving = canSendFromControl(s);
  keyed.clear();
  resetTranscriptGrouping();
  serverCommands = [];
  serverModels = [];
  serverAgents = [];
  serverModes = [];
  selectedModel = s.currentModel || null;
  selectedModelDirty = false;
  selectedAgent = s.currentAgent || 'build';
  selectedMode = s.currentMode || null;
  selectedModeDirty = false; // display-only until the user picks — must not re-assert a stale mode over the backend's
  // Under take-over, prefer the model the user last picked IN THE APP for this session — without
  // this, every reattach silently reverted the picker (and the next turn) to whatever the terminal
  // was launched with (issues-part1). The restored pick is marked dirty so it rides the next prompt
  // as an explicit override and session frames don't clobber it. Observe stays untouched: a locked
  // picker must show the session's REAL current model, not a wish.
  if (mode === 'resume' || driving) restoreModelPick(s);
  canInterrupt = false;
  lastSubmitted = null;
  agentBusy = false;
  pendingSends.length = 0;
  pendingAttachments.length = 0;
  artifactFrames.clear();
  renderAttachments();
  resetSessionBars();
  resetStatuslineState();
  setStatusDetail(''); // clear any lingering retry/warning banner when switching sessions
  $('#palette').style.display = 'none';
  $('#optmenu').style.display = 'none';
  threadPinnedToBottom = true; // a newly attached session opens at the transcript tail
  clearPendingScheduleElements();
  thread.innerHTML = sessionLoadingHtml(s);
  renderSessionMeta();
  renderStatusline();
  renderSyncHint(s);
  renderControlState();
  renderControls();
  document.body.classList.add('attached');
  $('#back').style.display = '';
  updateComposerButtons();
  if (lastRosterSessions.length) renderRoster();

  const cached = await loadSessionCache(s);
  if (!current || current.tool !== s.tool || current.id !== s.id) return;
  if (cached?.messages?.length) {
    currentCachedMessages = cached.messages;
    currentHistoryCursor = cached.cursor || null;
    clearPendingScheduleElements();
    thread.innerHTML = '';
    keyed.clear();
    resetTranscriptGrouping();
    resetSessionBars();
    // Bound the warm-open replay the same way the broker bounds a cold attach: a pre-cap cached row
    // can hold tens of thousands of messages, and rendering them synchronously freezes the tab.
    const replay = cached.messages.length > HISTORY_RENDER_MAX ? cached.messages.slice(-HISTORY_RENDER_MAX) : cached.messages;
    replay.forEach((msg) => render(msg, false));
    if (replay.length < cached.messages.length) showTruncationNote({ shown: replay.length, total: cached.messages.length });
    scroll(true);
  }
  reconcilePendingScheduleCards();
  void refreshPendingSchedules(attachToken);
  if ($('#schedulesSheet')?.classList.contains('open')) void renderSchedulesList();
  await rememberSessionInfo(s);
  if (!current || current.tool !== s.tool || current.id !== s.id) return;
  if (s.offlineCached) {
    setStatusDetail('Cached read-only. Broker offline.');
    updateComposerButtons();
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams();
  if (mode) params.set('mode', mode);
  params.set('artifactMode', 'reference');
  if (currentHistoryCursor) params.set('since', currentHistoryCursor);
  { const t = brokerToken(); if (t) params.set('token', t); } // auth the stream when the broker requires a token
  const qs = params.toString();
  const url = `${proto}://${location.host}/api/sessions/${encodeURIComponent(s.tool)}/${encodeURIComponent(s.id)}/stream${qs ? '?' + qs : ''}`;
  const conn = new WebSocket(url);
  ws = conn;
  const isActiveAttach = () => attachToken === attachSeq && ws === conn && sameSession(current, s);
  const failAttachLoading = (message) => {
    if (!isActiveAttach() || historyReceived || !document.getElementById('sessionLoading')) return;
    thread.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  };
  conn.onopen = () => { if (isActiveAttach()) connDot.classList.add('on'); };
  conn.onclose = () => {
    if (!isActiveAttach()) return;
    connDot.classList.remove('on');
    setStatusDetail('');
    failAttachLoading('Could not open this session. Check broker connection and retry.');
  };
  conn.onerror = () => {
    if (!isActiveAttach()) return;
    toast('Connection error', 'error');
    failAttachLoading('Connection error while opening this session.');
  };
  conn.onmessage = (ev) => {
    if (!isActiveAttach()) return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!isActiveAttach()) return;
    if (m.kind === 'history') {
      const reset = m.reset !== false || !historyReceived && currentCachedMessages.length === 0;
      const wasPinned = threadPinnedToBottom || thread.childElementCount === 0;
      const previousTop = thread.scrollTop;
      if (reset) {
        clearPendingScheduleElements();
        thread.innerHTML = '';
        keyed.clear();
        resetTranscriptGrouping();
        pendingSends.length = 0; // thread is rebuilt from history → drop any optimistic queued bubbles
        resetSessionBars();
        currentCachedMessages = [];
      } else {
        clearTransientThreadState();
      }
      // Replay is NOT live: render historical messages inline (an old error shows at its position) but
      // never re-fire the global toast/banner for them — that's the stale "session limit" popup bug (A).
      (m.messages || []).forEach((msg) => render(msg, false));
      // Broker capped a long replay to its newest messages (`truncated`): say so honestly at the top
      // of the thread instead of silently presenting the tail as the whole conversation.
      if (m.truncated && m.truncated.total > (m.messages || []).length) showTruncationNote(m.truncated);
      currentCachedMessages = capCachedMessages(mergeCachedMessages(reset ? [] : currentCachedMessages, m.messages || []));
      currentHistoryCursor = m.cursor || currentHistoryCursor;
      historyReceived = true;
      void saveSessionCache(current, currentCachedMessages, currentHistoryCursor);
      reconcilePendingScheduleCards();
      showEmptyThreadNote('No messages yet.');
      restoreThreadScroll(wasPinned, previousTop);
    } else if (m.kind === 'message') {
      // Live only when it carries a real ring seq (>=1); the attach catch-up frames use seq:0 → replay.
      const live = (m.seq ?? 0) >= 1;
      render(m.message, live);
      if (live || m.message?.type === 'file-artifact') {
        currentCachedMessages = capCachedMessages(mergeCachedMessages(currentCachedMessages, [m.message]));
        scheduleSaveSessionCache(current, currentCachedMessages, currentHistoryCursor);
      }
      scroll();
    } else if (m.kind === 'session') {
      if (!sameSession(m.info, s)) return;
      const info = mergeSessionInfo(current, m.info);
      current = info;
      // Authoritative per-socket control state from the broker. attachMode is transport shape; input
      // ownership comes from SessionInfo.control.
      driving = canSendFromControl(info);
      // Record sticky driving ONLY for an explicit resume attach. A bare attach that is driving by
      // default (opencode serve conn) needs no intent — and recording one made every OTHER tab open
      // the same session as ?mode=resume, splitting the Hub identity (the item-14 draft-sync bug).
      if (mode === 'resume' && info.control?.drive?.state === 'driving') rememberDrivingIntent(info);
      if (info.currentModel && !selectedModelDirty) selectedModel = info.currentModel;
      if (info.currentAgent && !selectedAgent) selectedAgent = info.currentAgent;
      if (info.currentMode && !selectedModeDirty) selectedMode = info.currentMode; // follow backend mode changes (e.g. a synced terminal's) unless the user picked here
      renderSessionMeta();
      renderStatusline();
      renderSyncHint(info);
      renderControlState();
      renderControls();
      updateComposerButtons();
      updateLocalRosterSession(info);
      renderSessionBars(); // goal-bar actions re-gate on driving flips; frozen bars have no ticker to repaint them
      void rememberSessionInfo(info);
    } else if (m.kind === 'commands') {
      serverCommands = m.commands || [];
      // A session is interruptible iff it advertises a stop/abort ACTION (capability-driven, no
      // tool-name branch) — drives the Stop button (Issue E).
      canInterrupt = serverCommands.some((c) => (c.name === 'stop' || c.name === 'abort') && c.kind === 'action');
      updateComposerButtons();
      renderSessionBars(); // /goal advertisement arrived after the bar rendered → enable its actions
    } else if (m.kind === 'options') {
      serverModels = m.models || [];
      serverAgents = m.agents || [];
      serverModes = m.modes || [];
      renderControls();
      renderStatusline();
    } else if (m.kind === 'notice') {
      clearCommandBars(); // the command completed — its notice is the result
      systemNote(m.message); // requester feedback for an action (e.g. "Reverted last message")
    } else if (m.kind === 'draft') {
      applyRemoteDraft(m); // multi-client composer sync (issues-part2)
    } else if (m.kind === 'ended') {
      // The live (bridged) session ended or was replaced in the terminal — quit/new/resume/fork.
      // Show a clear persistent note (a toast alone is missed) and close our socket so the connection
      // dot reflects "disconnected" instead of looking live on a socket that's gone silent.
      clearDrivingIntent(current);
      agentBusy = false;
      sessionEndedByServer = true; // deliberate close: the visibility resync must not resurrect it
      updateRuntimeFromStatus('idle');
      setStatusDetail('');
      systemNote(endedText(m.reason));
      try { ws.close(); } catch {}
    } else if (m.kind === 'error') {
      clearCommandBars(); // a failed command must not leave a forever-running bar
      toast(m.message, 'error');
    }
  };
}

// ── render the canonical AgentMessage union ──────────────────────────────────
// `live` = this frame is happening NOW (a ring seq >= 1), vs a replayed history/catch-up frame. Only
// live frames raise attention UI (toast / warning banner); replayed ones render inline only. (Issue A.)
function render(m, live = false) {
  clearTransientThreadState();
  switch (m.type) {
    case 'user-message':
      // upsert by key so a prompt (from app OR CLI) shows exactly one right-side bubble,
      // and the history copy + live echo dedupe into the same one.
      breakLookupRun();
      beginTranscriptTurn(m);
      return userMessage(m);
    case 'model-output':
      breakLookupRun();
      return upsert(m.key, 'assistant', m);
    case 'thinking':
      breakLookupRun();
      return upsert(m.key, 'thinking', m);
    case 'tool-call':
      return toolBlock(m.callId, m.toolName, m.args, null, m.title, m.toolClass);
    case 'tool-result':
      return toolBlock(m.callId, m.toolName, undefined, m, m.title, m.toolClass);
    case 'fs-edit':
      return toolBlock('edit:' + m.path, 'edit ' + m.path, m.diff || m.description, { done: true }, undefined, 'edit');
    case 'file-artifact':
      breakLookupRun();
      return artifact(m);
    case 'permission-request':
      breakLookupRun();
      if (live) agentBusy = true;
      renderStatusline();
      return perm(m);
    case 'permission-resolved':
      return resolvePerm(m.requestId);
    case 'question-request':
      breakLookupRun();
      if (live) agentBusy = true;
      renderStatusline();
      return questionCard(m);
    case 'question-resolved':
      return resolveQuestion(m.requestId);
    case 'status':
      agentBusy = m.status === 'running'; // drives whether the next send shows as "queued"
      if (m.status === 'idle') {
        lastSubmitted = null; // turn finished normally → nothing to restore
        clearCommandBars(); // the command turn ended — its reply text/notice is the feedback (issues-part1 round 4)
      }
      updateRuntimeFromStatus(m.status);
      connDot.classList.toggle('on', m.status === 'running' || m.status === 'idle');
      // A retry / transient API failure rides on a LIVE 'running' status carrying a `detail` — show it
      // as a warning banner. Replayed status frames never raise the banner (it's a now-condition).
      setStatusDetail(live && m.status === 'running' ? m.detail || '' : '');
      updateComposerButtons();
      return;
    case 'error':
      breakLookupRun();
      // Render INLINE at its historical position, always (this is the "session limit" line in-thread).
      errorNote(m.message);
      clearCommandBars(); // a failed command must not leave a forever-running bar
      // Only a LIVE error raises the global popup + clears any retry banner — a replayed/long-reset
      // limit must NOT re-pop the toast as if it just happened. (Issue A.)
      if (live) {
        setStatusDetail('');
        toast(m.message, 'error');
      }
      return;
    case 'token-count':
      return tokenMeter(m); // both adapters emit this; coalesce to a header chip (not a bubble)
    case 'run-summary':
      // Authoritative per-turn runtime/timestamps are adapter facts, not browser receive-time guesses.
      // See docs/architecture/client-ui.md
      return runSummary(m);
    case 'terminal-output':
      breakLookupRun();
      return bubble('tool', m.data || ''); // raw PTY/stream text (e.g. live bash output)
    case 'notice':
      breakLookupRun();
      clearCommandBars(); // command completed with textual feedback (e.g. Claude /compact local_command)
      return systemNote(m.message);
    case 'metadata-update':
      return metadataUpdate(m); // keyed side-channel, including context usage for the statusline
    case 'event':
      return; // generic escape hatch — nothing to render yet
    case 'goal-state':
      // Persistent high-level goal bar (for native "Pursuing goal" style status). The adapter owns
      // correlation; the UI just upserts/removes by canonical key. Goal state is session STATE, not a
      // transcript event: replayed frames only update the bar, and only a LIVE transition earns an
      // in-thread note (a stale "Goal paused" under the newest bubble misdates the transition). See
      // docs/architecture/client-ui.md
      return goalState(m, live);
    case 'task-list-state':
      // Native task/todo ledgers (Claude TodoWrite, OpenCode todowrite, etc.) render as one
      // upserted session-state panel, not a stack of raw tool cards. Governing template:
      // docs/architecture/client-ui.md
      return taskListState(m);
    case 'agent-activity':
      breakLookupRun();
      // A subagent (Task) or workflow run — a collapsible progress card upserted by m.key. The card
      // layout is identical for kind 'subagent' vs 'workflow' (kind only picks an icon); the UI reads
      // structured payload fields and NEVER branches on a tool name.
      return agentActivity(m);
    case 'history-reset':
      lastSubmitted = null; // transcript reloaded wholesale → drop any interrupt-restore buffer
      clearCommandBars(); // compaction/history rebuild is a command completion signal
      return; // handled by the broker (it re-pushes history); nothing to draw here
    default:
      // A canonical AgentMessage type with no render case reached the UI — log it so a NEW dropped
      // frame is visible (this is exactly how token-count was silently swallowed). See the
      // conformance harness, which turns this into a hard CI failure.
      console.warn('[__PRODUCT_NAME__] unhandled message type:', m && m.type, m);
      return;
  }
}

// Session statusline: compact operational telemetry under the session title.
// Governing UX doc: docs/architecture/client-ui.md
function fmtCount(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  const v = Number(n);
  return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : String(v);
}
function setChip(id, html, visible = true, className = '') {
  const el = document.getElementById(id);
  if (!el) return false;
  el.innerHTML = html || '';
  el.style.display = visible && html ? '' : 'none';
  el.className = ['statuschip', className].filter(Boolean).join(' ');
  return visible && !!html;
}
function modelDisplayLabel() {
  const cm = selectedModel || current?.currentModel;
  if (!driving && current?.model && current.model !== cm?.modelID) return current.model;
  const model = currentModelOption();
  if (model?.label) return model.label;
  if (cm?.modelID) return [cm.modelID, modelVariantKey(cm.variant)].filter(Boolean).join(' · ');
  return current?.model || '';
}
function effortDisplayLabel() {
  const model = currentModelOption();
  const effort = selectedModel?.reasoningEffort || current?.currentModel?.reasoningEffort || '';
  if (!effort) return '';
  return effortOptions(model).find((x) => x.effort === effort)?.label || effort;
}
function modeDisplayLabel() {
  const mode = selectedMode || current?.currentMode || '';
  if (!mode) return '';
  return serverModes.find((x) => x.value === mode)?.label || mode;
}
function activityDisplayLabel() {
  if (agentBusy || runStartedAt) return 'working';
  return normalizedStatus(current || {});
}
function runtimeMs() {
  return observedRuntimeMs + (runStartedAt ? Math.max(0, Date.now() - runStartedAt) : 0);
}
function updateRuntimeFromStatus(status) {
  if (status === 'running') {
    if (!runStartedAt) runStartedAt = Date.now();
  } else if (runStartedAt) {
    observedRuntimeMs += Math.max(0, Date.now() - runStartedAt);
    runStartedAt = null;
  }
  updateStatuslineTimer();
  renderStatusline();
}
function updateStatuslineTimer() {
  if (runStartedAt && !statuslineTimer) statuslineTimer = setInterval(renderStatusline, 1000);
  if (!runStartedAt && statuslineTimer) {
    clearInterval(statuslineTimer);
    statuslineTimer = null;
  }
}
function resetStatuslineState() {
  latestTokenCount = null;
  latestContextUsage = null;
  latestRuntimeTotals = null;
  runSummaries.clear();
  observedRuntimeMs = 0;
  runStartedAt = null;
  if (statuslineTimer) {
    clearInterval(statuslineTimer);
    statuslineTimer = null;
  }
  renderStatusline();
}
function tokenText(m) {
  if (!m) return '';
  const i = fmtCount(m.input), o = fmtCount(m.output), cr = fmtCount(m.cacheRead), cw = fmtCount(m.cacheWrite);
  const parts = [];
  if (i != null || o != null) parts.push(`${i ?? '-'}↑ ${o ?? '-'}↓`);
  if (cr != null) parts.push(`${cr} cache`);
  if (cw != null) parts.push(`${cw} write`);
  if (m.cost != null && Number(m.cost) > 0) parts.push('$' + Number(m.cost).toFixed(Number(m.cost) < 1 ? 4 : 2));
  return parts.length ? parts.join(' · ') : '';
}
function parseContextUsage(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    const pct = value <= 1 ? value * 100 : value;
    return Number.isFinite(pct) ? { percent: Math.max(0, Math.min(100, pct)) } : null;
  }
  if (typeof value !== 'object') return null;
  const used = value.used ?? value.tokensUsed ?? value.input ?? value.current;
  const max = value.max ?? value.tokensTotal ?? value.limit ?? value.total;
  let percent = value.percent ?? value.pct ?? value.ratio;
  if (percent == null && used != null && max) percent = (Number(used) / Number(max)) * 100;
  if (percent != null && Number(percent) <= 1) percent = Number(percent) * 100;
  percent = Number(percent);
  if (!Number.isFinite(percent)) return null;
  return {
    percent: Math.max(0, Math.min(100, percent)),
    used: fmtCount(used),
    max: fmtCount(max),
    label: typeof value.label === 'string' ? value.label : '',
  };
}
function parseRuntimeTotals(value) {
  if (!value || typeof value !== 'object') return null;
  const total = Number(value.totalRuntimeMs ?? value.runtimeMs ?? value.agentActiveMs);
  if (!Number.isFinite(total) || total < 0) return null;
  const turns = Number(value.turnCount ?? value.turns ?? value.completedTurns);
  const agent = Number(value.agentRuntimeMs);
  const execution = Number(value.executionRuntimeMs);
  return {
    totalRuntimeMs: total,
    agentRuntimeMs: Number.isFinite(agent) && agent >= 0 ? agent : undefined,
    executionRuntimeMs: Number.isFinite(execution) && execution >= 0 ? execution : undefined,
    turnCount: Number.isFinite(turns) && turns > 0 ? turns : undefined,
    source: typeof value.source === 'string' ? value.source : '',
  };
}
function runtimeSplitText(totals) {
  if (!totals) return '';
  const parts = [];
  const agent = fmtDur(totals.agentRuntimeMs);
  const execution = fmtDur(totals.executionRuntimeMs);
  if (agent) parts.push('agent ' + agent);
  if (execution) parts.push('exec ' + execution);
  if (totals.turnCount) parts.push(`${fmtCount(totals.turnCount)} turns`);
  if (totals.source === 'live-only') parts.push('live only');
  return parts.join(' · ');
}
function metadataUpdate(m) {
  if (m.key === 'contextUsage' || m.key === 'context-usage' || m.key === 'context') {
    latestContextUsage = parseContextUsage(m.value);
    renderStatusline();
  } else if (m.key === 'runtimeTotals' || m.key === 'runtime-totals') {
    latestRuntimeTotals = parseRuntimeTotals(m.value);
    renderStatusline();
  }
}
function renderStatusline() {
  const row = document.getElementById('statusline');
  if (!row) return;
  if (!current) {
    row.style.display = 'none';
    return;
  }
  let shown = 0;
  const status = activityDisplayLabel();
  const statusClass = status === 'needs-input' ? 'warn' : status === 'working' ? 'ok' : '';
  shown += setChip('statusActivity', `status <strong>${escapeHtml(status === 'needs-input' ? 'needs input' : status)}</strong>`, true, statusClass) ? 1 : 0;
  const model = modelDisplayLabel();
  shown += setChip('statusModel', `model <strong>${escapeHtml(model || 'unknown')}</strong>`, true) ? 1 : 0;
  const effort = effortDisplayLabel();
  shown += setChip('statusEffort', `effort <strong>${escapeHtml(effort || 'default')}</strong>`, !!(effort || serverModels.length)) ? 1 : 0;
  const agent = selectedAgent || current.currentAgent || '';
  shown += setChip('statusAgent', `agent <strong>${escapeHtml(agent || 'default')}</strong>`, !!(agent || serverAgents.length)) ? 1 : 0;
  const mode = modeDisplayLabel();
  shown += setChip('statusMode', `mode <strong>${escapeHtml(mode || 'default')}</strong>`, !!(mode || serverModes.length)) ? 1 : 0;
  const runtime = runtimeMs();
  const totalRuntime = latestRuntimeTotals?.totalRuntimeMs;
  const split = runtimeSplitText(latestRuntimeTotals);
  const runtimeDetail = totalRuntime != null
    ? `total <strong>${escapeHtml(fmtDur(totalRuntime) || '0s')}${split ? ` · ${escapeHtml(split)}` : ''}</strong>`
    : `runtime <strong>${escapeHtml(fmtDur(runtime) || '0s')}</strong>`;
  shown += setChip('runtimeMeter', runtimeDetail, totalRuntime != null || runtime > 0 || !!runStartedAt, 'runtimemeter mono') ? 1 : 0;
  const tok = tokenText(latestTokenCount);
  shown += setChip('tokmeter', `tok <strong>${escapeHtml(tok)}</strong>`, !!tok, 'tokmeter mono') ? 1 : 0;
  if (latestContextUsage) {
    const pct = Math.round(latestContextUsage.percent);
    const detail = latestContextUsage.used && latestContextUsage.max ? ` ${latestContextUsage.used}/${latestContextUsage.max}` : '';
    const cls = pct >= 85 ? 'contextmeter mono warn' : 'contextmeter mono';
    shown += setChip(
      'contextMeter',
      `ctx <strong>${pct}%${escapeHtml(detail)}</strong><span class="ctxBar"><i style="--pct:${pct}%"></i></span>`,
      true,
      cls,
    ) ? 1 : 0;
  } else {
    setChip('contextMeter', '', false, 'contextmeter mono');
  }
  row.style.display = shown ? '' : 'none';
}
// Token/cost meter — coalesce to the latest value in a single statusline chip, never a transcript bubble.
function tokenMeter(m) {
  latestTokenCount = m;
  renderStatusline();
}

// ── agent-activity: a subagent (Task) or workflow PROGRESS CARD ───────────────
// Find-or-create + upsert by m.key (exactly like toolBlock keys by callId), so a re-emit transitions
// the SAME card in place (running → done). Tool-agnostic: reads only structured payload fields; m.kind
// picks an icon, never a code path. Header shows "title · subtitle  [x/y agents] [dur] [↓tok] [n tools]
// running…/✓/✗"; expanding reveals the per-agent / per-phase child rows.
function fmtDur(ms) {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return s < 3600 ? m + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + (m % 60) + 'm';
}
function fmtTok(n) {
  if (n == null) return null;
  return (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n)) + ' tok';
}
function barStart(m, key) {
  if (typeof m.startedAt === 'number') return m.startedAt;
  if (typeof m.elapsedMs === 'number') return Date.now() - m.elapsedMs;
  const existing = activeBars.get(key);
  if (existing?.startedAt) return existing.startedAt;
  return Date.now();
}
function resetSessionBars() {
  activeBars.clear();
  taskLists.clear();
  // goalNotes dedups a goal-state replayed live-then-resync within ONE thread build; the callers of
  // this reset all wipe the thread DOM, so the seen-set must reset with it or a replayed terminal
  // note ("Goal paused") is swallowed on every reopen/resync until a hard reload.
  goalNotes.clear();
  renderSessionBars();
}
function goalState(m, live) {
  const key = 'goal:' + (m.key || 'current');
  if (live) goalTerminalNote(m, key); // transition trace at its true chronological position
  if (m.status === 'active' || m.status === 'paused' || m.status === 'blocked') {
    // Resumable/ongoing states stay pinned as a session bar; paused/blocked freeze the elapsed
    // readout at the goal's used time instead of ticking wall-clock from a long-past transition.
    activeBars.set(key, {
      kind: 'goal',
      goalStatus: m.status,
      goalKey: m.key || 'current',
      label: m.status === 'paused' ? 'Goal paused' : m.status === 'blocked' ? 'Goal blocked' : 'Pursuing goal',
      title: m.title || current?.title || 'Current task',
      detail: m.detail || '',
      startedAt: barStart(m, key),
      frozenElapsedMs: m.status === 'active' ? null : (typeof m.elapsedMs === 'number' ? m.elapsedMs : 0),
    });
  } else {
    activeBars.delete(key); // done/cleared/error: the goal is no longer session state
  }
  renderSessionBars();
}
function goalTerminalNote(m, key) {
  if (m.status === 'cleared' || m.status === 'active') return;
  const noteKey = [key, m.status, m.title || '', m.startedAt ?? ''].join('\0');
  if (goalNotes.has(noteKey)) return;
  goalNotes.add(noteKey);
  const label =
    m.status === 'done' ? 'Goal achieved' :
    m.status === 'blocked' ? 'Goal blocked' :
    m.status === 'paused' ? 'Goal paused' :
    'Goal error';
  const elapsed = fmtDur(m.elapsedMs);
  const title = m.title && !/^goal (achieved|blocked|paused|cleared|error)$/i.test(m.title) ? ': ' + m.title : '';
  const detail = m.detail ? ' · ' + m.detail : '';
  systemNote(label + (elapsed ? ' in ' + elapsed : '') + title + detail);
}
// Goal-bar actions dispatch the agent's native /goal command (advertised by adapters that support
// it, e.g. Codex thread/goal/*). Confirmation comes back as a goal-state update — no local mutation.
// The buttons render on every goal bar for discoverability; gating happens at click time so Observe
// gets the standard "take control first" toast instead of an invisibly missing affordance.
function goalBarSupported() {
  return serverCommands.some((c) => c.name === 'goal' && c.kind === 'action');
}
function goalBarActionable() {
  return canMutateCurrentSession() && goalBarSupported();
}
function goalBarCommand(args) {
  if (!canMutateCurrentSession()) { blockReadOnlyAction('Goal command'); return; }
  if (!goalBarSupported()) { toast('This agent does not expose a /goal command', 'error'); return; }
  ws.send(JSON.stringify({ kind: 'command', name: 'goal', args }));
  cmdEcho('/goal ' + args);
  startCommandBar('goal', args);
}
function goalBarActions(bar) {
  const wrap = document.createElement('span');
  const actionable = goalBarActionable();
  wrap.className = 'baractions' + (actionable ? '' : ' readonly');
  if (!actionable) wrap.title = 'Take control (Drive) to use goal actions';
  const btn = (text, args, titleText) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (titleText && actionable) b.title = titleText;
    b.onclick = () => {
      if (args === 'edit') {
        if (!canMutateCurrentSession()) { blockReadOnlyAction('Goal command'); return; }
        if (!goalBarSupported()) { toast('This agent does not expose a /goal command', 'error'); return; }
        const next = window.prompt('Update goal objective', bar.title || '');
        if (next && next.trim()) goalBarCommand('set ' + next.trim());
        return;
      }
      goalBarCommand(args);
    };
    return b;
  };
  if (bar.goalStatus === 'active') wrap.append(btn('Pause', 'pause', 'Pause the goal and stop the running turn'));
  else wrap.append(btn('Resume', 'resume', 'Resume — the agent continues working autonomously'));
  wrap.append(btn('Edit', 'edit', 'Set a new goal objective'), btn('Clear', 'clear'));
  return wrap;
}
// ── slash-command progress bar (issues-part1: "/compact's progress bar is not showing") ─────────
// A long-running agent command (/compact ≈ 45s) gave no feedback at all. Show an elapsed-ticking bar
// in the session-bars row from dispatch until a completion signal: the command's notice, an error,
// a history resync (compaction rewrites the transcript), or (for ordinary commands) the turn going idle.
// /compact can report idle before its local_command stdout arrives, so it waits for notice/reset/error.
const COMMAND_BAR_TIMEOUT_MS = 5 * 60 * 1000;
let commandBarTimer = null;
function startCommandBar(name, args) {
  if (name === 'stop' || name === 'abort') return; // interrupt is instant; a bar would just flash
  activeBars.set('cmd:' + name, {
    kind: 'activity',
    label: 'Running command',
    title: '/' + name + (args ? ' ' + args : ''),
    detail: name === 'compact' ? 'Summarizing the conversation to shrink context…' : '',
    startedAt: Date.now(),
  });
  renderSessionBars();
  clearTimeout(commandBarTimer);
  commandBarTimer = setTimeout(clearCommandBars, COMMAND_BAR_TIMEOUT_MS);
}
function clearCommandBars() {
  clearTimeout(commandBarTimer);
  commandBarTimer = null;
  let hit = false;
  for (const k of [...activeBars.keys()]) {
    if (k.startsWith('cmd:')) { activeBars.delete(k); hit = true; }
  }
  if (hit) renderSessionBars();
}

function activitySessionBar(m) {
  const key = 'activity:' + m.key;
  if (m.status !== 'running') {
    activeBars.delete(key);
    renderSessionBars();
    return;
  }
  const progress = m.agentsTotal != null ? (m.agentsDone || 0) + '/' + m.agentsTotal + ' agents' : '';
  const tok = fmtTok(m.tokens && m.tokens.output);
  const tools = m.toolCalls != null ? m.toolCalls + ' tools' : '';
  activeBars.set(key, {
    kind: 'activity',
    label: m.kind === 'workflow' ? 'Background workflow' : 'Background agent',
    title: m.title || m.key,
    detail: [m.subtitle, progress, tok ? '↓' + tok : '', tools].filter(Boolean).join(' · '),
    startedAt: barStart(m, key),
  });
  renderSessionBars();
}
function taskListCounts(items) {
  const counts = { total: items.length, done: 0, inProgress: 0, open: 0, cancelled: 0 };
  for (const item of items) {
    if (item.status === 'done') counts.done++;
    else if (item.status === 'in-progress') counts.inProgress++;
    else if (item.status === 'cancelled') counts.cancelled++;
    else counts.open++;
  }
  return counts;
}
function taskListSummary(counts) {
  const parts = [
    counts.done + ' done',
    counts.inProgress + ' in progress',
    counts.open + ' open',
  ];
  if (counts.cancelled) parts.push(counts.cancelled + ' cancelled');
  return counts.total + ' ' + (counts.total === 1 ? 'task' : 'tasks') + ': ' + parts.join(', ');
}
function taskListActiveItem(items) {
  return items.find((item) => item.status === 'in-progress') || items.find((item) => item.status === 'open') || null;
}
function taskListStatusLabel(status) {
  return status === 'in-progress' ? 'In progress' :
    status === 'done' ? 'Done' :
    status === 'cancelled' ? 'Cancelled' :
    'Open';
}
function validPlanSemantic(value) {
  return !!value && value.kind === 'plan' &&
    typeof value.planKey === 'string' && value.planKey.length > 0 && value.planKey.length <= 200 &&
    typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 200 &&
    ['proposed', 'active', 'completed', 'exited'].includes(value.state) &&
    value.actions && typeof value.actions.approve === 'boolean' &&
    typeof value.actions.edit === 'boolean' && typeof value.actions.exit === 'boolean';
}
function taskListState(m) {
  const key = 'tasks:' + (m.key || 'current');
  if (m.status === 'cleared') {
    taskLists.delete(key);
    renderSessionBars();
    return;
  }
  const items = Array.isArray(m.items) ? m.items.filter((item) => item && item.title) : [];
  taskLists.set(key, {
    key,
    messageKey: m.key,
    title: m.title || 'Tasks',
    status: m.status === 'done' ? 'done' : 'running',
    source: m.source || '',
    sourceTool: m.sourceTool || '',
    updatedAt: m.updatedAt || 0,
    semantic: validPlanSemantic(m.semantic) ? m.semantic : null,
    items,
  });
  renderSessionBars();
}
function renderTaskList(list, openState) {
  const details = document.createElement('details');
  details.className = 'tasklist ' + list.status;
  details.open = openState ?? list.status !== 'done';
  details.dataset.key = list.key;

  const summary = document.createElement('summary');
  summary.className = 'tl-head';
  const label = document.createElement('span');
  label.className = 'tl-label';
  label.textContent = list.title || 'Tasks';
  const counts = taskListCounts(list.items);
  const sum = document.createElement('span');
  sum.className = 'tl-summary';
  sum.textContent = taskListSummary(counts);
  summary.append(label, sum);

  const active = taskListActiveItem(list.items);
  if (active) {
    const activeEl = document.createElement('span');
    activeEl.className = 'tl-active';
    activeEl.textContent = (active.status === 'in-progress' ? 'In progress: ' : 'Next: ') + active.title;
    summary.append(activeEl);
  }
  const source = list.sourceTool || list.source;
  if (source) {
    const sourceEl = document.createElement('span');
    sourceEl.className = 'tl-source';
    sourceEl.textContent = source;
    summary.append(sourceEl);
  }
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'tl-body';
  const groups = [
    ['in-progress', 'In progress'],
    ['open', 'Open'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
  ];
  let rendered = 0;
  for (const [status, title] of groups) {
    const items = list.items.filter((item) => item.status === status);
    if (!items.length) continue;
    rendered += items.length;
    const group = document.createElement('div');
    group.className = 'tl-group ' + status;
    const groupTitle = document.createElement('div');
    groupTitle.className = 'tl-group-title';
    groupTitle.textContent = title;
    group.append(groupTitle);
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'tl-item ' + status;
      const st = document.createElement('span');
      st.className = 'tl-status';
      st.textContent = taskListStatusLabel(status);
      const text = document.createElement('span');
      text.className = 'tl-text';
      text.textContent = item.title;
      row.append(st, text);
      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'tl-detail';
        detail.textContent = item.detail;
        row.append(detail);
      }
      group.append(row);
    }
    body.append(group);
  }
  if (!rendered) {
    const empty = document.createElement('div');
    empty.className = 'tl-empty';
    empty.textContent = 'No tasks';
    body.append(empty);
  }
  details.append(body);
  if (list.semantic?.kind === 'plan') {
    const actions = planActions(list);
    if (actions.querySelectorAll('button').length) details.append(actions);
  }
  return details;
}

function planActions(list) {
  const row = document.createElement('div');
  row.className = 'plan-actions';
  const canAct = !!current && canPromptFromControl(current);
  const make = (label, action) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.disabled = !canAct;
    btn.title = canAct ? '' : 'Plan actions need Drive or active prompt-capable terminal sync.';
    btn.onclick = async (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (!canPromptFromControl(current)) { blockReadOnlyAction('Plan action'); return; }
      if (action === 'edit') {
        const text = await planEditDialog(list);
        if (text == null) return;
        sendPlanAction('edit', list, text);
      } else {
        sendPlanAction(action, list);
      }
    };
    return btn;
  };
  const supported = list.semantic?.actions || {};
  if (supported.approve === true) row.append(make('Approve plan', 'approve'));
  if (supported.edit === true) row.append(make('Revise plan', 'edit'));
  if (supported.exit === true) row.append(make('Exit plan', 'exit'));
  return row;
}

function sendPlanAction(action, list, text) {
  if (!ws || ws.readyState !== 1) return;
  if (!canPromptFromControl(current)) { blockReadOnlyAction('Plan action'); return; }
  const msg = {
    kind: 'plan-action',
    action,
    planKey: list.semantic.planKey,
    planRevision: list.semantic.revision,
    clientMessageId: nextClientMessageId('plan'),
  };
  if (text != null) msg.text = text;
  if (selectedModel && selectedModelDirty) msg.model = selectedModel;
  if (selectedAgent) msg.agent = selectedAgent;
  if (selectedMode && selectedModeDirty && serverModes.length) msg.permissionMode = selectedMode;
  ws.send(JSON.stringify(msg));
  toast(action === 'approve' ? 'Plan approved' : action === 'edit' ? 'Plan revised' : 'Plan exit requested');
}

function planTextForEdit(list) {
  return (list.items || []).map((item, index) => `${index + 1}. ${item.title}`).join('\n');
}
function renderSessionBars() {
  const row = $('#sessionBars');
  if (!row) return;
  const taskOpen = new Map([...row.querySelectorAll('.tasklist')].map((el) => [el.dataset.key, el.open]));
  row.innerHTML = '';
  if (!activeBars.size && !taskLists.size) {
    row.style.display = 'none';
    if (activeBarTimer) {
      clearInterval(activeBarTimer);
      activeBarTimer = null;
    }
    return;
  }
  row.style.display = '';
  const items = [...activeBars.entries()].sort((a, b) => {
    if (a[1].kind !== b[1].kind) return a[1].kind === 'goal' ? -1 : 1;
    return a[0].localeCompare(b[0]);
  });
  for (const [, bar] of items) {
    const el = document.createElement('div');
    el.className = 'livebar ' + bar.kind + (bar.goalStatus && bar.goalStatus !== 'active' ? ' ' + bar.goalStatus : '');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = bar.label;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = bar.title || '';
    const elapsed = document.createElement('span');
    elapsed.className = 'elapsed';
    // Paused/blocked goals show the goal's frozen used-time, not a ticking wall-clock: the
    // transition may be days old and counting up from it would misread as still running.
    elapsed.textContent = (bar.frozenElapsedMs != null ? fmtDur(bar.frozenElapsedMs) : fmtDur(Math.max(0, Date.now() - bar.startedAt))) || '';
    el.append(label, title, elapsed);
    if (bar.kind === 'goal') el.append(goalBarActions(bar));
    if (bar.detail) {
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = bar.detail;
      el.append(detail);
    }
    row.append(el);
  }
  for (const [, list] of [...taskLists.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    row.append(renderTaskList(list, taskOpen.get(list.key)));
  }
  // Tick only while some bar shows live wall-clock; a row of frozen (paused/blocked) bars is static.
  const needsTick = [...activeBars.values()].some((bar) => bar.frozenElapsedMs == null);
  if (needsTick && !activeBarTimer) activeBarTimer = setInterval(renderSessionBars, 1000);
  if (!needsTick && activeBarTimer) {
    clearInterval(activeBarTimer);
    activeBarTimer = null;
  }
}
function agentActivity(m) {
  activitySessionBar(m);
  // `agent-activity` is live progress, not transcript history. Keep standalone cards out of the
  // message thread so Claude history replay cannot create a bottom stack of already-finished
  // subagents/workflows. See docs/architecture/client-ui.md
  document.getElementById('act-' + m.key)?.remove();
  // BUT a SUBAGENT correlates to its spawning Task/Agent tool_use — key 'agent:<toolUseId>' and the
  // thread block id 'tool-<toolUseId>' — so upsert its progress INTO that block at its true position:
  // visible while running (agent type · elapsed · tokens) and a durable rollup once done. This is the
  // issues-part1 "subagents are not displayed" fix; the top bar alone vanished on completion.
  if (m.kind !== 'subagent' || !m.key || !m.key.startsWith('agent:')) return;
  const tool = document.getElementById('tool-' + m.key.slice('agent:'.length));
  if (!tool) return;
  let line = tool.querySelector('.subagentMeta');
  if (!line) {
    line = document.createElement('div');
    line.className = 'subagentMeta';
    line.style.cssText = 'color:var(--muted);font-size:12px;padding:2px 2px 4px;';
    tool.append(line);
  }
  const state = m.status === 'running' ? 'running…' : m.status === 'error' ? '✗ failed' : '✓ done';
  // A quiet agent (inside a long tool call) emits no frames for minutes — the line must keep ticking
  // client-side, anchored on the adapter's startedAtMs (issues-part1: "stuck at 4s").
  const startedAt = m.status === 'running' ? m.startedAtMs || (m.elapsedMs != null ? Date.now() - m.elapsedMs : Date.now()) : 0;
  line.dataset.running = m.status === 'running' ? '1' : '';
  line.dataset.startedAt = String(startedAt || '');
  line.dataset.prefix = '⚒ ' + (m.subtitle || 'subagent') + ' · ' + state;
  // Prefer tokens.input — for Claude subagents it carries the context size, the same "↓ Nk tokens"
  // figure the native TUI shows for the task (issues-part2: ours said ↓1.2k where the TUI said 17.5k).
  const tokFigure = m.tokens ? (m.tokens.input != null ? m.tokens.input : m.tokens.output) : null;
  line.dataset.suffix = tokFigure != null ? '↓' + fmtTok(tokFigure) : '';
  line.textContent = [line.dataset.prefix, fmtDur(m.elapsedMs), line.dataset.suffix].filter(Boolean).join(' · ');
  if (m.status === 'running') ensureSubagentTicker();
}

let subagentTickTimer = null;
function ensureSubagentTicker() {
  if (subagentTickTimer) return;
  subagentTickTimer = setInterval(() => {
    const running = document.querySelectorAll('.subagentMeta[data-running="1"]');
    if (!running.length) {
      clearInterval(subagentTickTimer);
      subagentTickTimer = null;
      return;
    }
    for (const line of running) {
      const startedAt = Number(line.dataset.startedAt);
      if (!Number.isFinite(startedAt) || startedAt <= 0) continue;
      line.textContent = [line.dataset.prefix, fmtDur(Math.max(0, Date.now() - startedAt)), line.dataset.suffix].filter(Boolean).join(' · ');
    }
  }, 1000);
}

function runSummary(m) {
  if (!m?.key) return;
  runSummaries.set(m.key, m);
  if (m.tokens) latestTokenCount = m.tokens;
  if (m.status === 'running') {
    if (m.startedAt && !runStartedAt) runStartedAt = m.startedAt;
    updateStatuslineTimer();
    renderStatusline();
    return;
  }
  if (runStartedAt && m.completedAt && m.completedAt >= runStartedAt) {
    observedRuntimeMs += Math.max(0, m.completedAt - runStartedAt);
    runStartedAt = null;
    updateStatuslineTimer();
  }
  const text = runSummaryText(m);
  const target = runSummaryTarget(m);
  if (text && target) {
    const id = 'runmeta-' + stableTextHash(m.key || m.turnId || '');
    let el = target.querySelector('#' + id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'runmeta';
      target.append(el);
    }
    el.textContent = text;
  }
  renderStatusline();
  scroll();
}

function runSummaryTarget(m) {
  const direct = m.assistantMessageKey ? keyed.get(m.assistantMessageKey)?.el : null;
  if (direct) return direct;
  const assistant = thread.querySelectorAll('.msg.assistant');
  return assistant[assistant.length - 1] || null;
}

// Governing UI contract: docs/architecture/client-ui.md
function runSummaryText(m) {
  const status =
    m.status === 'running' ? 'Run started' :
    m.status === 'error' ? 'Run failed' :
    m.status === 'cancelled' ? 'Run cancelled' :
    'Run';
  const total = m.totalRuntimeMs ?? (
    typeof m.startedAt === 'number' && typeof m.completedAt === 'number'
      ? Math.max(0, m.completedAt - m.startedAt)
      : undefined
  );
  const parts = [];
  const totalText = fmtDur(total);
  if (totalText) parts.push(totalText);
  const agentText = fmtDur(m.agentRuntimeMs);
  const execText = fmtDur(m.executionRuntimeMs);
  if (agentText) parts.push('agent ' + agentText);
  if (execText) parts.push('exec ' + execText);
  if (m.status !== 'running' && typeof m.completedAt === 'number') {
    const finished = fmtClock(m.completedAt);
    if (finished) parts.push('finished ' + finished);
  }
  const tok = tokenText(m.tokens);
  if (tok) parts.push(tok);
  if (!parts.length && typeof m.startedAt === 'number') parts.push(fmtClock(m.startedAt));
  return [status, ...parts].filter(Boolean).join(' · ');
}

function messageTimestampMs(m) {
  const v = m?.sentAt ?? m?.createdAt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

function fmtClock(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderUserBubble(el, text, m) {
  const t = messageTimestampMs(m);
  if (!t) {
    el.textContent = text || '';
    return;
  }
  el.innerHTML = `<span class="utext">${escapeHtml(text || '')}</span><span class="msgtime">${escapeHtml(fmtClock(t))}</span>`;
}

function resetTranscriptGrouping() {
  transcriptTurnSerial = 0;
  currentTranscriptTurn = 0;
  lastTranscriptUserKey = null;
  activeLookupRun = null;
}

function beginTranscriptTurn(m) {
  if (!thread.querySelector('[data-turn-group]')) {
    resetTranscriptGrouping();
  }
  // A queued prompt is visible in the transcript, but the current agent turn is still producing
  // output. Advance only when the adapter re-emits that same prompt as delivered; otherwise a final
  // answer that lands while the prompt waits would be assigned to the next turn in final-only mode.
  if (m.queued) return;
  const identity = m.key || `${m.sentAt || m.createdAt || ''}:${stableTextHash(m.text || '')}`;
  if (identity !== lastTranscriptUserKey) {
    transcriptTurnSerial += 1;
    currentTranscriptTurn = transcriptTurnSerial;
    lastTranscriptUserKey = identity;
  }
}

function markTranscriptElement(el, kind) {
  el.dataset.turnGroup = String(currentTranscriptTurn);
  if (kind) el.dataset.transcriptKind = kind;
  if (kind === 'assistant') refreshFinalMessages();
  return el;
}

function refreshFinalMessages() {
  const lastByTurn = new Map();
  for (const el of thread.querySelectorAll('.msg.assistant')) {
    el.classList.remove('turn-final');
    lastByTurn.set(el.dataset.turnGroup || '0', el);
  }
  for (const el of lastByTurn.values()) el.classList.add('turn-final');
}

function breakLookupRun() {
  activeLookupRun = null;
}

function bubble(cls, text) {
  breakLookupRun();
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text || '';
  thread.append(d);
  return markTranscriptElement(d, cls);
}

// A user-side pill recording a slash command the user ran — its own style (mono, accented),
// never an error, so running e.g. /compact reads as an action you took, not a dropped input.
function cmdEcho(text) {
  breakLookupRun();
  const d = document.createElement('div');
  d.className = 'msg cmd';
  d.textContent = text;
  thread.append(d);
  scroll();
}

// A centered, muted system line — requester feedback for a completed action.
function systemNote(text) {
  breakLookupRun();
  const d = document.createElement('div');
  d.className = 'sysnote';
  d.textContent = text;
  thread.append(d);
  scroll();
}

// Friendly text for an `ended` frame, by Pi's SessionShutdownEvent.reason.
function endedText(reason) {
  switch (reason) {
    case 'quit': return '● The terminal session was closed.';
    case 'new': return '● The terminal started a new session.';
    case 'resume': return '● The terminal switched to another session.';
    case 'fork': return '● The terminal forked this session.';
    default: return '● This session ended in the terminal.';
  }
}

// A persistent red transcript line for a (terminal) error — stays in the log, unlike a toast.
function errorNote(text) {
  breakLookupRun();
  const id = 'err-' + stableTextHash(text || '');
  let d = document.getElementById(id);
  if (!d) {
    d = document.createElement('div');
    d.id = id;
    d.className = 'sysnote';
    d.style.color = 'var(--danger)';
    thread.append(d);
  }
  d.textContent = '✕ ' + text;
  scroll();
}

// A persistent warning banner pinned at the top, for a transient/non-fatal condition the user
// should see while it persists — e.g. "API unreachable — retrying (retry #5)". Pass '' to clear.
function setStatusDetail(detail) {
  let b = document.getElementById('statusBanner');
  if (!detail) {
    if (b) b.remove();
    return;
  }
  if (!b) {
    b = document.createElement('div');
    b.id = 'statusBanner';
    b.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:60;background:#4a2f00;' +
      'color:#ffce85;border:1px solid #7a5200;padding:6px 12px;border-radius:8px;font-size:13px;' +
      'max-width:92%;box-shadow:0 2px 10px rgba(0,0,0,.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    document.body.append(b);
  }
  b.textContent = '⚠ ' + detail;
}

function upsert(key, cls, m) {
  const k = key || Math.random().toString(36);
  let rec = keyed.get(k);
  if (!rec) {
    rec = { el: bubble(cls, ''), text: '' };
    keyed.set(k, rec);
  }
  if (m.text != null) rec.text = m.text;
  else if (m.delta != null) rec.text += m.delta;
  if (cls === 'user') {
    markTranscriptElement(rec.el, 'user');
    renderUserBubble(rec.el, rec.text, m);
    return;
  }
  if (cls !== 'assistant') {
    rec.el.textContent = rec.text;
    return;
  }
  // Assistant output is markdown — render it (matching the agent's own terminal). Throttle re-parsing
  // during streaming so a long reply doesn't re-render on every token; always render the final snapshot.
  const render = () => {
    rec._last = performance.now();
    rec._pending = false;
    rec.el.innerHTML = mdToHtml(rec.text);
    refreshFinalMessages();
    scroll();
  };
  if (m.text != null || !rec._last || performance.now() - rec._last > 70) {
    clearTimeout(rec._t);
    render();
  } else if (!rec._pending) {
    rec._pending = true;
    rec._t = setTimeout(render, 80);
  }
}

// A user prompt. If we already drew an optimistic "queued" bubble for it (sent while the agent
// was busy), adopt that element when the server echoes the prompt — so it just drops the badge
// instead of drawing a duplicate. Otherwise dedupe by messageID like before.
// `m.queued` = the agent recorded the message but has NOT delivered it yet (claude's mid-run queue):
// keep/apply the dimmed queued styling; the delivery re-emits the SAME key without the flag, which
// clears it in place (issues-part2 item-12 follow-up).
function userMessage(m) {
  // Prefix-match too: a prompt sent WITH attachments has file-refs appended by the adapter, so the
  // server echo starts with (but isn't equal to) the optimistic bubble's typed text.
  const i = pendingSends.findIndex((p) => p.text === m.text || (p.text && m.text.startsWith(p.text + '\n')));
  if (i >= 0) {
    const { el } = pendingSends.splice(i, 1)[0];
    if (m.key) keyed.set(m.key, { el, text: m.text });
    markTranscriptElement(el, 'user');
    renderUserBubble(el, m.text, m);
    setBubbleQueued(el, !!m.queued);
    return;
  }
  upsert(m.key, 'user', m);
  const el = m.key ? keyed.get(m.key)?.el : null;
  if (el) {
    renderUserBubble(el, m.text, m);
    setBubbleQueued(el, !!m.queued);
  }
}

// Apply/clear the queued styling AFTER renderUserBubble (it rewrites innerHTML, killing any badge).
function setBubbleQueued(el, queued) {
  el.classList.toggle('queued', queued);
  const badge = el.querySelector('.qbadge');
  if (queued && !badge) {
    const b = document.createElement('span');
    b.className = 'qbadge';
    b.textContent = 'queued';
    el.append(b);
  } else if (!queued && badge) {
    badge.remove();
  }
}

function normalizedToolClass(value) {
  return value === 'execute' || value === 'edit' || value === 'lookup' ? value : 'other';
}

function toolShouldExpand(_el) {
  // Owner decision 2026-07-18: no tool card auto-expands in any mode/width; expansion is
  // always a manual click. (Previously responsive+wide auto-expanded execute/edit cards.)
  return false;
}

function setToolExpanded(el, expanded, manual = false) {
  const detail = el.querySelector('.detail');
  const head = el.querySelector('.head');
  const twisty = el.querySelector('.twisty');
  if (!detail || !head) return;
  detail.style.display = expanded ? 'block' : 'none';
  head.setAttribute('aria-expanded', String(expanded));
  if (twisty) twisty.textContent = expanded ? '▾' : '▸';
  if (manual) el._manualExpansion = true;
}

function applyToolExpansionDefaults(force = false) {
  for (const el of document.querySelectorAll('.tool')) {
    if (force) el._manualExpansion = false;
    if (!el._manualExpansion) setToolExpanded(el, toolShouldExpand(el));
  }
  if (force) {
    for (const group of document.querySelectorAll('.tool-group')) setLookupGroupExpanded(group, false);
  }
}

function setLookupGroupExpanded(group, expanded) {
  const body = group.querySelector('.lookup-body');
  const head = group.querySelector('.lookup-head');
  const twisty = group.querySelector('.lookup-twisty');
  if (!body || !head) return;
  body.style.display = expanded ? 'block' : 'none';
  head.setAttribute('aria-expanded', String(expanded));
  if (twisty) twisty.textContent = expanded ? '▾' : '▸';
}

function createLookupGroup(run) {
  const group = document.createElement('div');
  group.className = 'tool-group';
  group.innerHTML = '<div class="lookup-head" role="button" tabindex="0" aria-expanded="false"><span class="lookup-twisty">▸</span><span class="lookup-summary"></span></div><div class="lookup-body" style="display:none"></div>';
  const toggle = () => setLookupGroupExpanded(group, group.querySelector('.lookup-body').style.display === 'none');
  group.querySelector('.lookup-head').onclick = toggle;
  markTranscriptElement(group, 'tool-group');
  run.cards[0].before(group);
  const body = group.querySelector('.lookup-body');
  for (const card of run.cards) {
    body.append(card);
    card._lookupGroup = group;
  }
  run.group = group;
  setLookupGroupExpanded(group, false);
  updateLookupGroup(group);
}

function updateLookupGroup(group) {
  if (!group) return;
  const cards = group.querySelectorAll('.tool');
  const labels = [];
  for (const card of cards) {
    const label = oneLine(card.querySelector('.name')?.textContent || 'lookup');
    if (label && !labels.includes(label)) labels.push(label);
  }
  const shown = labels.slice(0, 3).join(', ');
  const more = labels.length > 3 ? `, +${labels.length - 3} more` : '';
  group.querySelector('.lookup-summary').textContent = `🔍 ${cards.length} lookup${cards.length === 1 ? '' : 's'}${shown ? ` · ${shown}${more}` : ''}`;
}

function appendToolCard(el, toolClass) {
  markTranscriptElement(el, 'tool');
  if (toolClass !== 'lookup') {
    breakLookupRun();
    thread.append(el);
    return;
  }
  const turn = el.dataset.turnGroup || '0';
  const runAnchor = activeLookupRun?.group || activeLookupRun?.cards.at(-1);
  const anchorSelector = activeLookupRun?.group ? '.tool-group' : '.tool';
  const runIsAttached = !!runAnchor && Array.from(thread.querySelectorAll(anchorSelector)).includes(runAnchor);
  // Session/history changes clear `thread` without necessarily rendering a user message first. A
  // cached lookup run can therefore point at detached DOM; never move a new card into that old run.
  if (!activeLookupRun || activeLookupRun.turn !== turn || !runIsAttached) {
    activeLookupRun = { turn, cards: [el], group: null };
    thread.append(el);
    return;
  }
  activeLookupRun.cards.push(el);
  if (!activeLookupRun.group) createLookupGroup(activeLookupRun);
  else {
    activeLookupRun.group.querySelector('.lookup-body').append(el);
    el._lookupGroup = activeLookupRun.group;
    updateLookupGroup(activeLookupRun.group);
  }
}

function fmtToolDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1).replace(/\.0$/, '')}s`;
  return fmtDur(ms);
}

function toolBlock(callId, name, args, result, title, toolClass) {
  const id = 'tool-' + callId;
  let el = document.getElementById(id);
  const isNew = !el;
  const displayClass = normalizedToolClass(toolClass || el?.dataset.toolClass);
  if (!el) {
    el = document.createElement('div');
    el.className = `tool tool-${displayClass}`;
    el.id = id;
    el.dataset.toolClass = displayClass;
    el.innerHTML = `<div class="head" role="button" tabindex="0" aria-expanded="false"><span class="twisty">▸</span><span class="name"></span><span class="chips"></span><span class="st" style="color:var(--muted);margin-left:auto">running…</span></div><div class="detail" style="display:none"></div>`;
    const detail = el.querySelector('.detail');
    el.querySelector('.head').onclick = () => setToolExpanded(el, detail.style.display === 'none', true);
    appendToolCard(el, displayClass);
  } else if (toolClass && displayClass !== el.dataset.toolClass) {
    el.classList.remove(`tool-${el.dataset.toolClass}`);
    el.classList.add(`tool-${displayClass}`);
    el.dataset.toolClass = displayClass;
  }
  const detail = el.querySelector('.detail');
  // Friendly summary: prefer the adapter-derived title (present while RUNNING too — the bash command,
  // "Read foo.ts", etc.) so a running tool reads as what it's doing, not the bare tool name or `{}`.
  el.querySelector('.name').textContent = title || (result && result.title) || toolTitleFallback(name, args ?? el._argsValue, result) || name;
  updateLookupGroup(el._lookupGroup);
  if (args !== undefined && args !== null) {
    // An empty `{}` arrives before OpenCode streams the tool input — don't show literal "{}".
    const empty = typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0;
    el._argsValue = empty ? undefined : args;
  }
  if (!result) {
    renderToolDetails(detail, el._argsValue, null);
    if (isNew || !el._manualExpansion) setToolExpanded(el, toolShouldExpand(el));
    return;
  }
  // status + summary chips
  const st = el.querySelector('.st');
  st.textContent = result.isError ? '✗ error' : '✓ done';
  st.style.color = result.isError ? 'var(--danger)' : 'var(--accent2)';
  const chips = el.querySelector('.chips');
  chips.innerHTML = '';
  if (result.additions != null || result.deletions != null) {
    chips.append(chip(`+${result.additions || 0} −${result.deletions || 0}`, 'diffstat'));
  }
  if (result.exitCode != null) chips.append(chip('exit ' + result.exitCode, result.exitCode ? 'err' : ''));
  if (result.truncated) chips.append(chip('truncated', 'muted'));
  const duration = fmtToolDuration(result.durationMs);
  if (duration) chips.append(chip(duration, 'duration'));
  // detail: a diff renders as +/- lines; otherwise show structured rows/output first and keep raw JSON
  // behind an explicit "Raw ..." disclosure. See docs/architecture/client-ui.md
  if (result.diff) {
    renderDiff(detail, result.diff);
  } else {
    renderToolDetails(detail, el._argsValue, result);
  }
  if (isNew || !el._manualExpansion) setToolExpanded(el, toolShouldExpand(el));
}

const TOOL_FIELD_LABELS = {
  command: 'Command',
  cmd: 'Command',
  path: 'Path',
  filePath: 'File',
  file_path: 'File',
  filename: 'File',
  url: 'URL',
  query: 'Query',
  pattern: 'Pattern',
  description: 'Description',
  status: 'Status',
  exitCode: 'Exit code',
  stdout: 'Stdout',
  stderr: 'Stderr',
  output: 'Output',
  error: 'Error',
  message: 'Message',
  text: 'Text',
  content: 'Content',
  summary: 'Summary',
};

const TOOL_PRIMARY_FIELDS = ['command', 'cmd', 'filePath', 'file_path', 'filename', 'path', 'url', 'query', 'pattern', 'description'];
const TOOL_OUTPUT_FIELDS = ['stdout', 'stderr', 'output', 'error', 'message', 'text', 'content', 'summary', 'status'];

function toolTitleFallback(name, args, result) {
  const command = pickToolScalar(args, ['command', 'cmd']);
  if (command) return oneLine(command);
  const target = result?.path || pickToolScalar(args, ['filePath', 'file_path', 'filename', 'path', 'url', 'query', 'pattern']);
  if (target) return [humanToolName(name), basenameForDisplay(target)].filter(Boolean).join(' ');
  return humanToolName(name);
}

function renderToolDetails(container, args, result) {
  container.innerHTML = '';
  let wrote = false;
  if (args !== undefined && args !== null && args !== '') {
    wrote = appendToolPayload(container, 'Input', args, TOOL_PRIMARY_FIELDS) || wrote;
  }
  if (result) {
    const rows = [];
    if (result.path) rows.push(['Path', result.path]);
    if (result.exitCode != null) rows.push(['Exit code', String(result.exitCode)]);
    if (result.truncated) rows.push(['Output', 'truncated by agent']);
    if (rows.length) {
      appendToolRows(container, 'Result metadata', rows);
      wrote = true;
    }
    wrote = appendToolPayload(container, 'Result', result.result, TOOL_OUTPUT_FIELDS) || wrote;
  }
  if (!wrote) {
    const empty = document.createElement('div');
    empty.className = 'tool-empty';
    empty.textContent = result ? 'No detail reported.' : 'Waiting for tool input...';
    container.append(empty);
  }
}

function appendToolPayload(container, label, value, preferredKeys) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    appendToolText(container, label, String(value));
    return true;
  }
  if (Array.isArray(value)) {
    const textItems = value.map((item) => toolTextFromStructuredItem(item)).filter(Boolean);
    appendToolRows(container, label, [['Items', String(value.length)]]);
    if (textItems.length) appendToolText(container, 'Content', textItems.join('\n\n'));
    else appendToolRaw(container, label, value);
    return true;
  }
  if (typeof value === 'object') {
    const rows = [];
    const textBlocks = [];
    const seen = new Set();
    for (const key of preferredKeys) {
      const v = value[key];
      if (v == null || v === '') continue;
      if (isToolScalar(v)) {
        rows.push([TOOL_FIELD_LABELS[key] || key, String(v)]);
        seen.add(key);
      } else {
        const text = toolTextFromStructuredItem(v);
        if (text) {
          textBlocks.push([TOOL_FIELD_LABELS[key] || key, text]);
          seen.add(key);
        }
      }
    }
    for (const [key, v] of Object.entries(value)) {
      if (seen.has(key) || rows.length >= 8 || v == null || v === '' || !isToolScalar(v)) continue;
      rows.push([TOOL_FIELD_LABELS[key] || key, String(v)]);
      seen.add(key);
    }
    if (rows.length) appendToolRows(container, label, rows);
    for (const [k, text] of textBlocks) appendToolText(container, k, text);
    appendToolRaw(container, label, value);
    return true;
  }
  appendToolText(container, label, String(value));
  return true;
}

function appendToolRows(container, title, rows) {
  const section = document.createElement('div');
  section.className = 'tool-section';
  const head = document.createElement('div');
  head.className = 'tool-section-title';
  head.textContent = title;
  section.append(head);
  for (const [key, value] of rows) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    const k = document.createElement('span');
    k.className = 'tool-key';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'tool-value';
    const valueText = document.createElement('span');
    valueText.className = 'tool-value-text';
    v.append(valueText);
    renderExpandableToolText(
      v,
      valueText,
      String(value),
      /^(stdout|stderr|output|result|content)$/i.test(String(key)),
    );
    row.append(k, v);
    section.append(row);
  }
  container.append(section);
}

function appendToolText(container, title, text) {
  const section = document.createElement('div');
  section.className = 'tool-section';
  const head = document.createElement('div');
  head.className = 'tool-section-title';
  head.textContent = title;
  const pre = document.createElement('pre');
  section.append(head, pre);
  renderExpandableToolText(section, pre, String(text), /^(result|output|stdout|stderr|content)$/i.test(title));
  container.append(section);
}

function appendToolRaw(container, label, value) {
  const raw = prettyJson(value);
  if (!raw || raw === '{}') return;
  const details = document.createElement('details');
  details.className = 'tool-raw';
  const summary = document.createElement('summary');
  summary.textContent = 'Raw ' + label.toLowerCase();
  const pre = document.createElement('pre');
  details.append(summary, pre);
  renderExpandableToolText(details, pre, raw, false);
  container.append(details);
}

function pickToolScalar(value, keys) {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) {
    const v = value[key];
    if (isToolScalar(v) && String(v).trim()) return String(v);
  }
  return undefined;
}

function isToolScalar(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function toolTextFromStructuredItem(value) {
  if (value == null) return '';
  if (isToolScalar(value)) return String(value);
  if (Array.isArray(value)) return value.map((item) => toolTextFromStructuredItem(item)).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return value.content.map((item) => toolTextFromStructuredItem(item)).filter(Boolean).join('\n');
  return '';
}

function humanToolName(name) {
  return String(name || 'Tool')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function basenameForDisplay(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function chip(text, cls) {
  const s = document.createElement('span');
  s.className = 'chip' + (cls ? ' ' + cls : '');
  s.textContent = text;
  return s;
}

function utf8Length(value) {
  try { return new TextEncoder().encode(value).byteLength; }
  catch { return value.length; }
}

function sliceUtf8(value, maxBytes, fromTail) {
  const chars = Array.from(value);
  let bytes = 0;
  const kept = [];
  if (fromTail) {
    for (let i = chars.length - 1; i >= 0; i--) {
      const ch = chars[i];
      const size = utf8Length(ch);
      if (bytes + size > maxBytes) break;
      kept.push(ch);
      bytes += size;
    }
    return kept.reverse().join('');
  }
  for (const ch of chars) {
    const size = utf8Length(ch);
    if (bytes + size > maxBytes) break;
    kept.push(ch);
    bytes += size;
  }
  return kept.join('');
}

function toolTextPreview(value, fromTail = false) {
  const full = String(value ?? '');
  const lines = full.split('\n');
  const bytes = utf8Length(full);
  if (lines.length <= TOOL_PREVIEW_MAX_LINES && bytes <= TOOL_PREVIEW_MAX_BYTES) {
    return { full, preview: full, truncated: false, lines: lines.length, bytes };
  }
  // Reserve one of the 40 lines and a small byte allowance for the omission marker itself.
  const visibleLines = Math.max(1, TOOL_PREVIEW_MAX_LINES - 1);
  const picked = fromTail ? lines.slice(-visibleLines) : lines.slice(0, visibleLines);
  const pickedText = picked.join('\n');
  let content = sliceUtf8(pickedText, TOOL_PREVIEW_MAX_BYTES - 96, fromTail);
  // If the byte cap cut a multi-line preview, discard only the partial edge line. A command-tail
  // beginning with half of a 500-character log line is harder to scan than one fewer whole line.
  if (content !== pickedText && content.includes('\n')) {
    content = fromTail ? content.slice(content.indexOf('\n') + 1) : content.slice(0, content.lastIndexOf('\n'));
  }
  const shownLines = content ? content.split('\n').length : 0;
  const hiddenLines = Math.max(0, lines.length - shownLines);
  const marker = `… ${hiddenLines ? `${hiddenLines} ${fromTail ? 'earlier' : 'later'} line${hiddenLines === 1 ? '' : 's'}; ` : ''}${Math.max(0, bytes - utf8Length(content))} bytes hidden …`;
  return {
    full,
    preview: fromTail ? `${marker}\n${content}` : `${content}\n${marker}`,
    truncated: true,
    lines: lines.length,
    bytes,
  };
}

function renderExpandableToolText(parent, target, value, fromTail = false, renderValue = null) {
  const capped = toolTextPreview(value, fromTail);
  const apply = renderValue || ((text) => { target.textContent = text; });
  apply(capped.preview);
  if (!capped.truncated) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-show-all';
  button.textContent = `Show all (${capped.lines} lines · ${formatBytes(capped.bytes)})`;
  button.setAttribute('aria-expanded', 'false');
  let expanded = false;
  button.onclick = (event) => {
    event?.stopPropagation?.();
    expanded = !expanded;
    apply(expanded ? capped.full : capped.preview);
    button.textContent = expanded ? 'Show preview' : `Show all (${capped.lines} lines · ${formatBytes(capped.bytes)})`;
    button.setAttribute('aria-expanded', String(expanded));
  };
  parent.append(button);
}

function renderDiff(container, diff) {
  container.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'tool-diff';
  container.append(pre);
  const paint = (value) => {
    pre.innerHTML = '';
    for (const line of String(value).split('\n')) {
      const d = document.createElement('div');
      d.className = 'dl';
      if (line.startsWith('+') && !line.startsWith('+++')) d.classList.add('add');
      else if (line.startsWith('-') && !line.startsWith('---')) d.classList.add('del');
      else if (line.startsWith('@@')) d.classList.add('hunk');
      d.textContent = line || ' ';
      pre.append(d);
    }
  };
  renderExpandableToolText(container, pre, String(diff), false, paint);
}

function artifact(m) {
  const d = document.createElement('div');
  // Stable id so a history replay (getHistory re-runs on every attach/resync) REPLACES the prior card
  // in place instead of stacking a duplicate — artifacts have no other upsert. Keyed by artifactKey /
  // contentHash first, never path alone when a version key is available: regenerated reports can reuse
  // the same path and must remain separate durable records. Governing plan:
  // docs/architecture/client-ui.md
  const id = artifactDomId(m);
  const prev = document.getElementById(id);
  d.id = id;
  // `proactive` = the agent flagged this as push-worthy (send_file / SendUserFile status:'proactive',
  // or an auto-surfaced deliverable write) — give it visual emphasis + an attention signal below.
  d.className = 'artifact' + (m.proactive ? ' proactive' : '');

  const head = document.createElement('div');
  head.className = 'art-head';
  const icon = document.createElement('span');
  icon.textContent = m.proactive ? '📨' : '📄';
  const name = document.createElement('span');
  name.className = 'art-name';
  name.textContent = m.name || m.path || 'artifact';
  const meta = document.createElement('span');
  meta.className = 'art-meta';
  meta.textContent = [m.mimeType || 'file', m.size ? formatBytes(m.size) : '', m.fetchUrl && !m.url ? 'cached on demand' : '']
    .filter(Boolean)
    .join(' · ');
  const actions = document.createElement('span');
  actions.className = 'art-actions';
  const status = document.createElement('span');
  status.className = 'art-status';
  head.append(icon, name, meta, actions, status);
  if (m.proactive) {
    const badge = document.createElement('span');
    badge.className = 'pushbadge';
    badge.textContent = 'sent to you';
    head.append(badge);
  }
  d.append(head);

  const preview = document.createElement('div');
  preview.className = 'art-preview';
  d.append(preview);

  if (prev) prev.replaceWith(d); // replace the replayed card in place (no duplicate on reconnect)
  else {
    thread.append(d);
    scroll();
  }

  const cachedUrl = artifactObjectUrls.get(artifactCacheKey(m));
  if (m.url || cachedUrl) renderArtifactPreview(preview, actions, status, m, m.url || cachedUrl);
  else if (m.fetchUrl) renderLazyArtifact(preview, actions, status, m, d);
  else status.textContent = 'metadata only';

  // Fire the attention signal only for a NEWLY-seen proactive file. Proactive artifacts are persisted
  // broker-side and REPLAYED on every attach/reconnect/history-reset (main.ts artifactSnapshot,
  // hub.ts resync), so without this gate a reconnect would re-toast/re-vibrate for files already seen.
  // The Set is module-level and intentionally NOT cleared on a history frame, so replays stay silent.
  if (m.proactive) {
    const akey = artifactIdentity(m);
    if (akey && !_seenArtifacts.has(akey)) {
      _seenArtifacts.add(akey);
      proactiveAlert(m.name || 'a file');
    }
  }
}

function renderLazyArtifact(preview, actions, status, m, container) {
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Open';
  open.onclick = () => {
    if (isHtmlArtifact(m) && m.fetchUrl) renderInteractiveHtmlArtifact(preview, actions, status, m);
    else hydrateArtifact(preview, actions, status, m, { announce: true });
  };
  actions.append(open);
  status.textContent = 'not downloaded';

  // Data-saver-aware default: small artifacts may prefetch only when the browser does not report a
  // metered/save-data connection. Larger artifacts remain open-only. See ui-ux doc 13.
  if (!canPrefetchArtifact(m)) return;
  const prefetch = () => hydrateArtifact(preview, actions, status, m, { prefetch: true });
  if (typeof IntersectionObserver !== 'undefined') {
    const obs = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      obs.disconnect();
      prefetch();
    }, { root: thread, rootMargin: '160px' });
    obs.observe(container);
  } else {
    prefetch();
  }
}

async function hydrateArtifact(preview, actions, status, m, opts = {}) {
  const key = artifactCacheKey(m);
  if (artifactObjectUrls.has(key)) {
    renderArtifactPreview(preview, actions, status, m, artifactObjectUrls.get(key));
    return;
  }
  try {
    status.textContent = opts.prefetch ? 'prefetching…' : 'loading…';
    actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const cached = await loadArtifactBlob(m);
    const blob = cached || await fetchArtifactBlob(m);
    const url = URL.createObjectURL(blob);
    artifactObjectUrls.set(key, url);
    renderArtifactPreview(preview, actions, status, m, url);
    if (opts.announce && !cached) toast('Artifact cached locally');
  } catch {
    status.textContent = current?.offlineCached ? 'not in local cache' : 'load failed';
    actions.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

async function fetchArtifactBlob(m) {
  if (!m.fetchUrl) throw new Error('missing artifact URL');
  const res = await fetch(m.fetchUrl);
  if (!res.ok) throw new Error('artifact fetch failed');
  const blob = await res.blob();
  await saveArtifactBlob(m, blob);
  return blob;
}

function isHtmlArtifact(m) {
  const value = `${m.mimeType || ''} ${m.name || ''} ${m.path || ''}`;
  return /text\/html|\bhtml\b|\.html?\b/i.test(value);
}

function renderInteractiveHtmlArtifact(preview, actions, status, m) {
  actions.innerHTML = '';
  const a = document.createElement('a');
  a.href = m.fetchUrl;
  a.download = m.name || 'artifact.html';
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Download';
  actions.append(a);
  preview.innerHTML = '';
  const f = document.createElement('iframe');
  f.src = m.fetchUrl;
  f.sandbox = 'allow-scripts allow-forms';
  f.style = 'width:100%;height:320px;border:1px solid var(--line);border-radius:8px;margin-top:8px;background:#fff';
  const meta = {
    artifactKey: m.artifactKey,
    session: current ? { tool: current.tool, id: current.id } : null,
    interactionPolicy: m.interactionPolicy || { mode: 'display-only' },
    origin: (() => { try { return new URL(m.fetchUrl).origin; } catch { return ''; } })(),
  };
  const registerFrameSource = () => {
    if (meta.interactionPolicy.mode !== 'structured') return;
    artifactFrames.set(f, meta); // DOM-shim fallback.
    if (f.contentWindow) artifactFrames.set(f.contentWindow, meta);
  };
  f.addEventListener('load', registerFrameSource);
  registerFrameSource();
  preview.append(f);
  status.textContent = 'opened from broker';
  scroll();
}

function renderArtifactPreview(preview, actions, status, m, url) {
  const mime = m.mimeType || '';
  actions.innerHTML = '';
  const a = document.createElement('a');
  a.href = url;
  a.download = m.name || 'file';
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Download';
  actions.append(a);
  preview.innerHTML = '';
  if (mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = m.name || 'image';
    preview.append(img);
  } else if (mime.includes('html')) {
    const f = document.createElement('iframe');
    f.src = url;
    f.sandbox = 'allow-scripts allow-forms';
    f.style = 'width:100%;height:320px;border:1px solid var(--line);border-radius:8px;margin-top:8px;background:#fff';
    preview.append(f);
  }
  status.textContent = m.fetchUrl && !m.url ? 'cached locally' : '';
  scroll();
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function artifactIdentity(m) {
  return m.artifactKey || m.contentHash || m.path || m.url || m.name;
}

function artifactDomId(m) {
  return 'art-' + encodeURIComponent(artifactIdentity(m) || Math.random().toString(36));
}

// An agent flagged a deliverable as push-worthy. The away-from-desk promise: pull the user's
// attention even if they've tabbed away. No server push infra yet, so do it client-side and
// best-effort: a toast + a vibrate (foreground mobile) + a title-flash and a Web Notification
// (only if already granted) while the tab is hidden. All guarded so nothing throws if unsupported.
const _seenArtifacts = new Set(); // proactive files already alerted (survives history-frame rebuilds)
let _proactiveTitleArmed = false;
function proactiveAlert(label) {
  toast('📨 ' + label + ' — sent to you');
  try {
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
  } catch (_) {}
  if (document.hidden && !_proactiveTitleArmed) {
    _proactiveTitleArmed = true;
    const base = document.title.replace(/^● /, '');
    document.title = '● ' + base;
    const restore = () => {
      document.title = base;
      _proactiveTitleArmed = false;
      document.removeEventListener('visibilitychange', restore);
    };
    document.addEventListener('visibilitychange', restore);
    try {
      if (window.Notification && Notification.permission === 'granted')
        new Notification('__PRODUCT_NAME__', { body: label + ' — sent to you' });
    } catch (_) {}
  }
}

function perm(m) {
  if (document.getElementById('perm-' + m.requestId)) return; // dedupe (pending-replay + live)
  // Read-only observe is never allowed to answer pending input, even if an adapter forgets to mark the
  // card readOnly. See docs/architecture/client-ui.md
  const readOnly = !!m.readOnly || !driving;
  if (readOnly) {
    const r = document.createElement('div');
    r.className = 'perm readonly';
    r.dataset.pendingInput = 'readonly';
    r.id = 'perm-' + m.requestId;
    r.innerHTML = `<div class="q"></div><div style="color:var(--muted)"></div>`;
    r.querySelector('.q').textContent = 'Waiting for input: ' + (m.title || 'Permission request');
    r.querySelectorAll('div')[1].textContent =
      m.detail || 'This is a read-only observe view. Answer in the terminal, or Drive/Sync before approving from __PRODUCT_NAME__.';
    thread.append(r);
    return;
  }
  const d = document.createElement('div');
  d.className = 'perm';
  d.dataset.pendingInput = 'actionable';
  d.id = 'perm-' + m.requestId;
  d.innerHTML = `<div class="q"></div>${m.detail ? `<div style="color:var(--muted);margin-bottom:8px"></div>` : ''}
    <div class="acts">
      <button class="ok">Allow once</button>
      <button class="session">Allow session</button>
      <button class="no">Deny</button>
    </div>`;
  d.querySelector('.q').textContent = (m.toolName ? m.toolName + ': ' : '') + (m.title || 'Permission request');
  if (m.detail) d.querySelectorAll('div')[1].textContent = m.detail;
  const decide = (decision) => {
    if (!canMutateCurrentSession()) { blockReadOnlyAction('Approval'); return; }
    ws && ws.send(JSON.stringify({ kind: 'approve', requestId: m.requestId, decision }));
    resolvePerm(m.requestId);
  };
  d.querySelector('.ok').onclick = () => decide('approve');
  d.querySelector('.session').onclick = () => decide('approve-session');
  d.querySelector('.no').onclick = () => decide('reject');
  thread.append(d);
}

function resolvePerm(id) {
  const el = document.getElementById('perm-' + id);
  if (el) {
    el.classList.add('done');
    el.querySelectorAll('button').forEach((b) => (b.disabled = true));
  }
  agentBusy = false;
  renderStatusline();
  updateComposerButtons();
}

// Interactive agent→user question (OpenCode `question` tool). Answered via its OWN channel
// ({kind:'answer'}) — never as a new prompt (which OpenCode would just queue).
function questionCard(m) {
  if (document.getElementById('q-' + m.requestId)) return; // dedupe (pending-replay + live)
  // Observe mode must surface questions without making them answerable from the app. The backend should
  // set readOnly for terminal-owned pending input; the UI also gates on `driving` as a safety net.
  // See docs/architecture/client-ui.md
  const readOnly = !!m.readOnly || !driving;
  const d = document.createElement('div');
  d.className = 'perm' + (readOnly ? ' readonly' : '');
  d.dataset.pendingInput = readOnly ? 'readonly' : 'actionable';
  d.id = 'q-' + m.requestId;
  const qs = m.questions || [];
  d.innerHTML = `<div class="q"></div><div class="qbody"></div>
    ${readOnly ? '<div class="ro-note" style="color:var(--muted);margin-top:8px">Read-only observe view. Answer in the terminal, or Drive/Sync before answering from __PRODUCT_NAME__.</div>' : '<div class="acts"><button class="ok">Submit</button><button class="no">Dismiss</button></div>'}`;
  d.querySelector('.q').textContent = qs.length === 1 ? qs[0].header || 'Question' : 'Questions';
  const body = d.querySelector('.qbody');
  const sel = qs.map(() => new Set());
  qs.forEach((q, qi) => {
    const block = document.createElement('div');
    block.className = 'qblock';
    const qt = document.createElement('div');
    qt.className = 'qtext';
    qt.textContent = q.question || '';
    block.append(qt);
    (q.options || []).forEach((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qopt';
      b.innerHTML = `<b></b>${o.description ? ' <span class="od"></span>' : ''}`;
      b.querySelector('b').textContent = o.label;
      if (o.description) b.querySelector('.od').textContent = '— ' + o.description;
      b.disabled = readOnly;
      if (!readOnly) {
        b.onclick = () => {
          custom.value = '';
          if (q.multiple) {
            if (sel[qi].has(o.label)) { sel[qi].delete(o.label); b.classList.remove('on'); }
            else { sel[qi].add(o.label); b.classList.add('on'); }
          } else {
            sel[qi].clear();
            sel[qi].add(o.label);
            [...block.querySelectorAll('.qopt')].forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
          }
        };
      }
      block.append(b);
    });
    const custom = document.createElement('input');
    custom.className = 'qcustom';
    custom.placeholder = readOnly ? 'Read-only observe view' : 'Type your own answer…';
    custom.disabled = readOnly;
    if (!readOnly) {
      custom.oninput = () => {
        if (custom.value) {
          sel[qi].clear();
          [...block.querySelectorAll('.qopt')].forEach((x) => x.classList.remove('on'));
        }
      };
    }
    block._custom = custom;
    block.append(custom);
    body.append(block);
  });
  if (!readOnly) {
    const finish = (reject) => {
      if (!canMutateCurrentSession()) { blockReadOnlyAction('Question answer'); return; }
      if (reject) {
        ws && ws.send(JSON.stringify({ kind: 'reject-question', requestId: m.requestId }));
      } else {
        const answers = qs.map((q, qi) => {
          const c = body.children[qi]._custom.value.trim();
          return c ? [c] : [...sel[qi]];
        });
        ws && ws.send(JSON.stringify({ kind: 'answer', requestId: m.requestId, answers }));
      }
      resolveQuestion(m.requestId);
    };
    d.querySelector('.ok').onclick = () => finish(false);
    d.querySelector('.no').onclick = () => finish(true);
  }
  thread.append(d);
}

function resolveQuestion(id) {
  const el = document.getElementById('q-' + id);
  if (el) el.remove();
  agentBusy = false;
  renderStatusline();
  updateComposerButtons();
}

function refreshPendingInputActionState() {
  const readonly = !canMutateCurrentSession();
  thread.querySelectorAll('[data-pending-input="actionable"]').forEach((el) => {
    if (el.classList.contains('done')) return;
    el.classList.toggle('readonly', readonly);
    el.querySelectorAll('button, input').forEach((x) => { x.disabled = readonly; });
  });
}

// ── composer ─────────────────────────────────────────────────────────────────
function sendPrompt() {
  const text = input.value.trim();
  const files = pendingAttachments.slice();
  if ((!text && !files.length) || !ws || ws.readyState !== 1) return;
  if (!canMutateCurrentSession()) {
    blockReadOnlyAction('Prompt input');
    return;
  }
  const msg = { kind: 'prompt', text };
  if (files.length) msg.files = files; // staged attachments → written to inbox + referenced in-turn
  if (selectedModel && selectedModelDirty) msg.model = selectedModel; // explicit per-prompt model override
  if (selectedAgent) msg.agent = selectedAgent; // per-prompt agent/mode (build/plan)
  // Only ride a permission mode when the mode picker is actually ACTIONABLE (the adapter reported selectable
  // modes). A locked picker reports no modes — e.g. Claude true-sync, where there is no mid-session
  // permission-mode mechanism — so echoing the current mode would send a value the adapter must ignore
  // (docs/architecture/client-ui.md: picker actionability must match backend support).
  if (selectedMode && selectedModeDirty && serverModes.length) msg.permissionMode = selectedMode; // per-prompt permission mode (Claude)
  // Retain the just-sent prompt so an interrupt can restore it to the composer for edit+resend (E).
  lastSubmitted = { text, files: files.slice() };
  ws.send(JSON.stringify(msg));
  // ALWAYS draw the sent prompt now (issues-part1: "only the response is shown"). Not every adapter
  // echoes the prompt back — Claude Drive's stream-json has no user echo, so waiting for the server
  // copy left the user's own message invisible for the whole turn. userMessage() ADOPTS this bubble
  // when an echo (or the reattach history copy) arrives — prefix-matched on the typed text, since the
  // adapter may append file-refs — so adapters that do echo (OpenCode/Pi) never show a duplicate.
  // A "queued" badge marks sends made while the agent is busy (they run after the current turn).
  if (text) {
    const el = bubble('user' + (agentBusy ? ' queued' : ''), text + (files.length ? `  📎${files.length}` : ''));
    if (agentBusy) {
      const badge = document.createElement('span');
      badge.className = 'qbadge';
      badge.textContent = 'queued';
      el.append(badge);
    }
    pendingSends.push({ text, el });
    scroll();
  }
  pendingAttachments.length = 0; // staged files are now in flight
  renderAttachments();
  agentBusy = true; // sending makes the agent busy → a follow-up send shows as queued
  updateRuntimeFromStatus('running');
  input.value = '';
  input.style.height = 'auto';
  updateComposerButtons();
}
sendBtn.onclick = sendPrompt;

// ── drive / interrupt (capability-driven — no tool-name branch) ───────────────
// Gates the composer (read-only until driving) and the Stop/Drive buttons from {driving, agentBusy,
// canInterrupt, supportsResume}. Drive shows for an observe view of a resumable session; Stop shows
// while a drivable session is busy and advertises a stop/abort action.
// Auto-route the ONE #control button off the session's PROVEN control state (D1/D3/FU-1) — no user mode
// preference. Synced/driving → no button (composer is the surface). Sync-available → "Sync" (join, no
// confirm). Drivable-only → "Take over" (the takeover-confirm path). Neither → disabled, reason in title.
// Sync and Take over stay DISTINCT actions behind one slot (they never share a handler).
function controlAction(s) {
  const c = controlFor(s);
  if (!c) return { kind: 'none' };
  const sync = c.terminalSync || {};
  const drive = c.drive || {};
  if (sync.active) return { kind: 'none' }; // truly synced — terminal and app already share one owner
  if (drive.state === 'driving') {
    const route = terminalSyncRoute(sync);
    const hint = terminalSyncPresenceHint(s, sync);
    const titleBase = hint || 'Terminal rejoin command';
    // Driving leaves the terminal behind (Claude) or un-joined (serve/daemon agents) — keep a
    // persistent affordance that shows the exact terminal command (issues-part1 round 4). HONEST
    // wording per capability and broker action:
    //   join: optional shared-owner terminal join, keeps Drive ownership.
    //   handoff: continue in terminal as an explicit ownership transfer.
    if (route === 'handoff') {
      return {
        kind: 'resync',
        label: '💻 ' + (sync.label || 'Resume in terminal'),
        title: `Show the command to RESUME this conversation in your terminal (${titleBase})`,
        disabled: false,
      };
    }
    return {
      kind: 'resync',
      label: '💻 Open in terminal (optional)',
      title: hint ? `Show the command to join in terminal (${hint})` : 'Show the command to open this conversation in the terminal',
      disabled: false,
    };
  }
  if (sync.syncAvailable) {
    return { kind: 'sync', label: 'Sync', title: sync.note || 'Join this session live (terminal + app share one owner)', disabled: false };
  }
  if (drive.supported && drive.state === 'observing') {
    return { kind: 'takeover', label: '▶ Take over', title: 'Take over this session to send prompts from here', disabled: false };
  }
  const reason = drive.reason || sync.reason || 'This session can only be observed right now.';
  return { kind: 'unavailable', label: drive.state === 'unknown' ? 'Control unknown' : 'Take over unavailable', title: reason, disabled: true };
}

function updateComposerButtons() {
  const composer = $('#composer');
  const controlBtn = $('#control');
  // Cards (permission/question) stay actionable via `driving` (canSendFromControl); the COMPOSER additionally
  // requires PROMPT capability, so an answer-only synced session (Claude hooks) keeps the composer read-only
  // while its permission/question cards remain actionable.
  const mutable = !!current && !!driving && canPromptFromControl(current);
  const action = current ? controlAction(current) : { kind: 'none' };
  const showControl = action.kind === 'sync' || action.kind === 'resync' || action.kind === 'takeover' || action.kind === 'unavailable';
  if (controlBtn) {
    controlBtn.style.display = showControl ? '' : 'none';
    controlBtn.disabled = !!action.disabled;
    controlBtn.textContent = action.label || '';
    controlBtn.title = action.title || '';
    controlBtn.dataset.kind = action.kind;
  }
  $('#stop').style.display = mutable && agentBusy && canInterrupt ? '' : 'none';
  composer.classList.toggle('readonly', !!current && !mutable);
  input.disabled = !current || !mutable;
  sendBtn.disabled = !current || !mutable;
  const scheduleBtn = $('#scheduleBtn');
  if (scheduleBtn) scheduleBtn.disabled = !current || !mutable; // schedule = a later Send, so it gates like Send
  $('#attach').disabled = !current || !mutable;
  const clearSession = $('#clearSessionCache');
  if (clearSession) clearSession.disabled = !current;
  if (!current) {
    input.placeholder = 'Message the agent…  (type / for commands)';
  } else if (!mutable && isAnswerOnlySync(current)) {
    input.placeholder = 'Synced — answer prompts & questions above; send new messages in the terminal';
  } else if (!mutable && action.kind === 'sync') {
    input.placeholder = 'Read-only view — tap Sync to join the live session';
  } else if (!mutable && action.kind === 'takeover') {
    input.placeholder = 'Read-only view — tap Take over to send';
  } else if (!mutable) {
    input.placeholder = 'Read-only view';
  } else {
    input.placeholder = 'Message the agent…  (type / for commands)';
  }
  renderControlState();
  refreshPendingInputActionState();
}

// Interrupt the running turn AND return the just-sent prompt to the composer for edit + resend (E).
function interrupt() {
  const stop = serverCommands.find((c) => (c.name === 'stop' || c.name === 'abort') && c.kind === 'action');
  if (!stop || !ws || ws.readyState !== 1) return;
  if (!canMutateCurrentSession()) {
    blockReadOnlyAction('Interrupt');
    return;
  }
  ws.send(JSON.stringify({ kind: 'command', name: stop.name, args: '' }));
  if (lastSubmitted) {
    input.value = lastSubmitted.text || '';
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    pendingAttachments.length = 0;
    for (const f of lastSubmitted.files || []) pendingAttachments.push(f);
    renderAttachments();
    // drop the optimistic "queued" bubble for this prompt, if one was drawn
    const i = pendingSends.findIndex((p) => p.text === lastSubmitted.text);
    if (i >= 0) { const { el } = pendingSends.splice(i, 1)[0]; el.remove(); }
    input.focus();
  }
  lastSubmitted = null;
  agentBusy = false;
  updateRuntimeFromStatus('idle');
  updateComposerButtons();
}
$('#stop').onclick = interrupt;

// Reusable themed confirm modal → Promise<boolean>. The general pattern for any owning/destructive action
// (today: Drive). Esc / backdrop = cancel, Enter = confirm.
function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modalback';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
      '<div class="mtitle"></div><div class="mbody"></div>' +
      '<div class="mbtns"><button class="mcancel"></button><button class="mok"></button></div></div>';
    const titleEl = back.querySelector('.mtitle');
    titleEl.textContent = title;
    if (danger) titleEl.classList.add('warn');
    back.querySelector('.mbody').textContent = body;
    const cancel = back.querySelector('.mcancel');
    cancel.textContent = cancelText;
    const ok = back.querySelector('.mok');
    ok.textContent = confirmText;
    if (danger) ok.classList.add('danger');
    const close = (val) => {
      document.removeEventListener('keydown', onKey);
      back.remove();
      resolve(val);
    };
    cancel.onclick = () => close(false);
    ok.onclick = () => close(true);
    back.onclick = (e) => { if (e.target === back) close(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    ok.focus();
  });
}

// Reusable single-field modal for display aliases. Blank submit means "clear this broker alias" so
// the adapter/native title or directory basename becomes visible again.
function promptDialog({ title, label, value = '', help = '', confirmText = 'Save', cancelText = 'Cancel' }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modalback';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
      '<div class="mtitle"></div><div class="mfield"><label></label><input class="minput" /></div>' +
      '<div class="mhelp"></div>' +
      '<div class="mbtns"><button class="mcancel"></button><button class="mok"></button></div></div>';
    back.querySelector('.mtitle').textContent = title;
    back.querySelector('label').textContent = label;
    const field = back.querySelector('.minput');
    field.value = value || '';
    back.querySelector('.mhelp').textContent = help;
    const cancel = back.querySelector('.mcancel');
    cancel.textContent = cancelText;
    const ok = back.querySelector('.mok');
    ok.textContent = confirmText;
    const close = (val) => {
      document.removeEventListener('keydown', onKey);
      back.remove();
      resolve(val);
    };
    cancel.onclick = () => close(undefined);
    ok.onclick = () => close(field.value);
    back.onclick = (e) => { if (e.target === back) close(undefined); };
    const onKey = (e) => {
      if (e.key === 'Escape') close(undefined);
      else if (e.key === 'Enter') close(field.value);
    };
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    field.focus();
  });
}

function planEditDialog(list) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modalback';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
      '<div class="mtitle"></div><div class="mhelp"></div><textarea class="planedit"></textarea>' +
      '<div class="mbtns"><button class="mcancel"></button><button class="mok"></button></div></div>';
    back.querySelector('.mtitle').textContent = 'Revise plan';
    back.querySelector('.mhelp').textContent = 'Edit the plan that will be sent back to the agent.';
    const field = back.querySelector('.planedit');
    field.value = planTextForEdit(list);
    const cancel = back.querySelector('.mcancel');
    cancel.textContent = 'Cancel';
    const ok = back.querySelector('.mok');
    ok.textContent = 'Send revision';
    const close = (val) => {
      document.removeEventListener('keydown', onKey);
      back.remove();
      resolve(val);
    };
    cancel.onclick = () => close(undefined);
    ok.onclick = () => close(field.value.trim());
    back.onclick = (e) => { if (e.target === back) close(undefined); };
    const onKey = (e) => {
      if (e.key === 'Escape') close(undefined);
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') close(field.value.trim());
    };
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    field.focus();
  });
}

// The ONE entry point for taking over (driving) a session — EVERY Drive trigger goes through here, so the
// take-over warning is universal. Driving spawns a second owner/continuation of the session; doing it while
// the session is still working can interrupt or diverge from the live run, so we always confirm first and
// escalate the wording (red) when the session is actively working. (Recommend: Drive only when it's done.)
async function requestDrive(s) {
  if (!s) return;
  // Best-effort "is it working" (observe status is a lagging filesystem signal, so this can miss) — when
  // we DO know it's working, escalate to a red warning; otherwise the unconditional caution still applies.
  const working = agentBusy || currentRosterStatus === 'working' || (s && s.status === 'working');
  // The adapter proves a live terminal owner (control.drive.willFork): driving NOW forks to a new uuid.
  // Say so up front with the escape hatch — quitting the terminal first keeps the same session (issues-part2).
  const willFork = !!s?.control?.drive?.willFork;
  const ok = await confirmDialog({
    title: 'Take over this session?',
    body:
      'Driving takes over the session as a new owner so you can send prompts from here. If a run is in ' +
      'progress it will be interrupted, and the takeover can diverge from the live terminal session. ' +
      'Strongly recommended: Drive only when the session is idle or done — not while it is working.' +
      (willFork
        ? '\n\n⚠ A terminal is attached to this session RIGHT NOW, so your first prompt here will continue in a FORK (new uuid). To keep the SAME session instead: quit the terminal (Ctrl+C / Ctrl+D) first, then Drive.'
        : '') +
      (working ? '\n\n⚠ This session looks like it is still working right now.' : ''),
    confirmText: willFork ? 'Drive (fork)' : 'Drive',
    cancelText: 'Cancel',
    danger: working || willFork,
  });
  if (ok) attach(s, 'resume');
}
// The ONE control button, auto-routed (D1/FU-1): Sync and Take over are DISTINCT actions (join vs takeover,
// no-confirm vs confirm) that never share a handler — they just share this DOM slot.
$('#control').onclick = () => {
  const a = controlAction(current);
  if (a.kind === 'sync') requestSync(current);
  else if (a.kind === 'resync') requestResyncTip(current);
  else if (a.kind === 'takeover') requestDrive(current);
};

// One status pill, derived purely off the session's proven `control` state (no user mode preference).
// Order matters: a proven active sync / driving is an OWNERSHIP fact and must win over the availability views.
function renderControlState() {
  const row = $('#controlState');
  if (!row) return;
  row.innerHTML = '';
  if (!current) { row.style.display = 'none'; return; }
  const c = controlFor(current);
  const sync = c?.terminalSync || {};
  const drive = c?.drive || {};
  const pill = document.createElement('span');
  pill.className = 'controlpill';
  let text = 'Control unknown';
  let title = '';
  if (sync.active) {
    text = sync.label || 'Synced with terminal';
    if (sync.note) title = sync.note;
    pill.classList.add('ok');
  } else if (drive.state === 'driving') {
    text = 'Driving in app';
    title = terminalDrivingStatus(current, sync);
    pill.classList.add('ok');
  } else if (sync.syncAvailable) {
    text = 'Sync available';
    title = sync.note || (sync.command ? `Run: ${sync.command}` : '');
  } else if (drive.state === 'observing' && drive.supported) {
    text = 'Observed from terminal';
  } else if (drive.state === 'unavailable' || drive.supported === false) {
    text = 'Take over unavailable';
    title = drive.reason || sync.reason || '';
    pill.classList.add('warn');
  }
  pill.textContent = text;
  if (title) pill.title = title;
  row.append(pill);
  row.style.display = '';
}

// The persistent terminal rejoin affordance while DRIVING: show the exact command
// that brings the user's terminal back in line with this conversation. Adapters that have no live shared
// owner still provide a handoff command via terminalSync.command (Claude: `--resume <live uuid>`, kept
// correct across the single-owner fork by the adapter); serve/daemon/other agents provide their attach command.
async function requestResyncTip(s) {
  if (!s) return;
  const sync = controlFor(s)?.terminalSync || { supported: false, active: false };
  const route = terminalSyncRoute(sync);
  const presence = sync?.presence || 'unknown';
  const presenceHint = terminalSyncPresenceHint(s, sync);
  if (route === 'handoff') {
    const cmd = sync.command || '';
    const intro = handoffTransferBody(sync, presence);
    const body = [
      intro,
      presenceHint,
      cmd
        ? cmd
        : sync.reason || 'This adapter does not expose a terminal re-sync command for this session.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const ok = await confirmDialog({
      title: sync.label || 'Resume in your terminal',
      body,
      confirmText: cmd ? 'Copy command' : 'OK',
      cancelText: 'Close',
    });
    if (ok && cmd && (await copyCommandIfAvailable(cmd))) {
      // Pressing "Copy command" declares intent to CONTINUE IN THE TERMINAL. Demote this tab to
      // observation immediately so the broker-owned drive process can't contest ownership (or fork
      // the session) while the user resumes it in the CLI (item 13.1a). Closing the dialog without
      // copying keeps driving.
      if (driving && current && sameSession(current, s)) {
        clearDrivingIntent(current);
        void attach(current, null);
        toast('Now observing — the terminal owns this session once you resume it there.');
      }
    }
    return;
  }
  return requestSync(s);
}

async function requestSync(s) {
  if (!s) return;
  const sync = controlFor(s)?.terminalSync || { supported: false, active: false };
  const presenceHint = terminalSyncPresenceHint(s, sync);
  if (sync.active) {
    toast('This session is already synced with the terminal.');
    return;
  }
  const unavailable = !sync.supported;
  const body = [
    presenceHint,
    unavailable
      ? (sync.reason || 'This adapter does not support true terminal sync for this session.')
      : terminalCommandHint(sync),
  ]
    .filter(Boolean)
    .join('\n\n');
  const ok = await confirmDialog({
    title: sync.label || (unavailable ? 'Sync unavailable' : 'Sync with terminal'),
    body,
    confirmText: sync.command && !unavailable ? 'Copy command' : 'OK',
    cancelText: sync.command && !unavailable ? 'Close' : 'Cancel',
    danger: unavailable,
  });
  if (ok && sync.command && !unavailable) {
    void copyCommandIfAvailable(sync.command);
  }
}

input.addEventListener('keydown', (e) => {
  const pal = $('#palette');
  const open = pal.style.display !== 'none';
  if (e.key === 'Escape' && open) { pal.style.display = 'none'; return; }
  // Esc with the palette closed interrupts a running, interruptible turn (Issue E).
  if (e.key === 'Escape' && !open && canInterrupt && agentBusy) { e.preventDefault(); interrupt(); return; }
  // ↑/↓ move the highlighted command when the palette is open (it scrolls — see CSS max-height).
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    movePaletteSel(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  const sel = () => (pal._matches && pal._matches[pal._sel ?? 0]) || null;
  // Tab autocompletes the highlighted command name (text only — never runs).
  if (e.key === 'Tab' && input.value.startsWith('/')) {
    e.preventDefault();
    const m = sel();
    if (m) completeCmd(m);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (input.value.startsWith('/')) {
      const parsed = parseCommand(input.value);
      if (parsed) return execCmd(parsed.command, parsed.args); // exact command → run (with any args typed after it)
      if (open && sel()) return completeCmd(sel()); // partial → complete the highlighted match
      // starts with "/" but no command match → fall through and send as a literal prompt
    }
    sendPrompt();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  updatePalette();
  scheduleDraftSync();
});

// ── multi-client composer draft sync (issues-part2) ─────────────────────────
// Every attached client shares ONE unsent draft per session: local edits are debounced to the broker,
// which fans them out; incoming frames update the box unless the local user typed more recently
// (last-writer-wins without yanking text out from under an actively-typing hand).
let draftSyncTimer = null;
let lastLocalInputAt = 0;
let lastSyncedDraft = null; // exact text we last sent/received — used to swallow our own echo
function scheduleDraftSync() {
  lastLocalInputAt = Date.now();
  if (draftSyncTimer) clearTimeout(draftSyncTimer);
  const scheduledFor = current ? sessionKey(current) : null; // the session this text was typed in
  draftSyncTimer = setTimeout(() => {
    draftSyncTimer = null;
    // The debounce can outlive a session switch — by fire time `ws` is already the NEW session's
    // stream, so the socket alone can't tell. Without this guard the previous composer's text was
    // injected into the new session's shared draft and fanned out to its other clients
    // (issues-part2 item-14 follow-up: "one session's draft propagates to another session").
    if (!current || sessionKey(current) !== scheduledFor) return;
    if (!ws || ws.readyState !== 1) return;
    if (input.value === lastSyncedDraft) return;
    lastSyncedDraft = input.value;
    ws.send(JSON.stringify({ kind: 'draft', text: input.value }));
  }, 300);
}
function applyRemoteDraft(m) {
  const text = String(m.text ?? '');
  if (text === input.value) {
    lastSyncedDraft = text;
    return;
  }
  // The local user typed within the last 1.5s → their keystrokes win; the next debounce re-syncs.
  if (document.activeElement === input && Date.now() - lastLocalInputAt < 1500) return;
  lastSyncedDraft = text;
  input.value = text;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

// ── slash-command palette ─────────────────────────────────────────────────────
function allCommands() {
  return [...CLIENT_COMMANDS, ...CLIENT_PROMPTS, ...serverCommands];
}
// Parse the longest advertised command name at the start of `/...`, so commands whose names contain
// spaces (OpenCode prompt templates) work too. Falls back to null for partials/literal prompts.
function parseCommand(value) {
  if (!value.startsWith('/')) return null;
  const body = value.slice(1);
  const lower = body.toLowerCase();
  const cmd = [...allCommands()]
    .sort((a, b) => b.name.length - a.name.length)
    .find((c) => {
      const name = c.name.toLowerCase();
      return lower === name || lower.startsWith(name + ' ');
    });
  return cmd ? { command: cmd, args: body.slice(cmd.name.length).trim() } : null;
}
function updatePalette() {
  const pal = $('#palette');
  const v = input.value;
  if (!v.startsWith('/')) { pal.style.display = 'none'; return; }
  const token = v.slice(1).split(/\s+/)[0].toLowerCase();
  // Show EVERY matching command/skill (the palette itself scrolls — max-height in CSS). Previously
  // capped at 8, which silently hid most of the ~90 commands/skills. Bounded only by a generous
  // ceiling so a pathological registry can't build thousands of DOM nodes per keystroke.
  const matches = allCommands().filter((c) => c.name.toLowerCase().startsWith(token));
  if (!matches.length) { pal.style.display = 'none'; return; }
  const shown = matches.slice(0, 200);
  pal.innerHTML = '';
  shown.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'pitem' + (i === 0 ? ' sel' : '');
    d.innerHTML = `<span class="pname"></span><span class="pdesc"></span>`;
    d.querySelector('.pname').textContent = '/' + c.name;
    d.querySelector('.pdesc').textContent = c.description || (c.kind === 'action' ? 'action' : '');
    d.onclick = () => pickCmd(c);
    pal.append(d);
  });
  if (matches.length > shown.length) {
    const more = document.createElement('div');
    more.className = 'pmore';
    more.textContent = `+${matches.length - shown.length} more — keep typing to narrow`;
    pal.append(more);
  }
  pal._matches = shown; // selection/complete operate over what's rendered
  pal._sel = 0;
  pal.style.display = '';
  pal.scrollTop = 0;
}
/** Move the palette selection by `delta` (↑/↓), wrapping, and scroll it into view. */
function movePaletteSel(delta) {
  const pal = $('#palette');
  if (pal.style.display === 'none' || !pal._matches || !pal._matches.length) return;
  const items = pal.querySelectorAll('.pitem');
  const n = items.length;
  pal._sel = ((pal._sel ?? 0) + delta + n) % n;
  items.forEach((el, i) => el.classList.toggle('sel', i === pal._sel));
  items[pal._sel]?.scrollIntoView({ block: 'nearest' });
}
// Execute a command now. `action`/`client` are one-shot; `prompt` (skills/templates) starts a turn.
function execCmd(c, args) {
  $('#palette').style.display = 'none';
  input.value = '';
  input.style.height = 'auto';
  if (c.kind === 'client') {
    if (c.name === 'new') newSession();
    else if (c.name === 'copy') copyTranscript();
    else if (c.name === 'export') exportTranscript();
    return;
  }
  if (c.kind === 'client-prompt') {
    if (!canMutateCurrentSession()) { blockReadOnlyAction('Prompt command'); return; }
    // Expand the template (user's free-text request, or a sensible default) and send as a normal turn.
    const req = (args || c.defaultArgs || '').trim();
    input.value = c.template.replace(/\$\{args\}/g, req);
    sendPrompt();
    return;
  }
  if (ws && ws.readyState === 1 && canMutateCurrentSession()) {
    const msg = { kind: 'command', name: c.name, args: args || '' };
    if (selectedModel && selectedModelDirty) msg.model = selectedModel; // prompt-like commands/skills share explicit per-turn overrides
    if (selectedAgent) msg.agent = selectedAgent;
    if (selectedMode && selectedModeDirty && serverModes.length) msg.permissionMode = selectedMode; // only when the mode picker is actionable (see sendPrompt)
    ws.send(JSON.stringify(msg));
    // Record the command as user-side input so a successful action never reads as dropped/failed.
    cmdEcho('/' + c.name + (args ? ' ' + args : ''));
    startCommandBar(c.name, args || ''); // elapsed-ticking feedback until the command resolves
  } else if (ws && ws.readyState === 1) {
    blockReadOnlyAction('Agent command');
  } else {
    toast('Not connected', 'error');
  }
}
// Just complete the text in the composer and keep focus — for skills/templates that take args,
// and for Tab autocomplete. The user reviews/adds args, then presses Enter to run.
function completeCmd(c) {
  input.value = '/' + c.name + ' ';
  input.focus();
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  updatePalette();
}
// Click behaviour: actions/client run immediately; prompt/template commands complete-and-wait.
function pickCmd(c) {
  if (c.kind === 'prompt') completeCmd(c);
  else execCmd(c, '');
}
async function newSession(context = {}) {
  await loadAgents();
  openNewSessionDialog(context);
}

function creatableAgents() {
  return Object.values(agentInfos).filter((a) => a.canCreateSession);
}

function createCapabilityKnown() {
  const agents = Object.values(agentInfos);
  return agents.length > 0 && agents.every((a) => a.createCapabilityKnown);
}

function openNewSessionDialog(context = {}) {
  const sheet = $('#newSheet');
  const select = $('#newAgent');
  const dir = $('#newDirectory');
  const title = $('#newSessionTitle');
  const hint = $('#newHint');
  const projectContext = $('#newProjectContext');
  const projectDirectory = typeof context?.directory === 'string' ? context.directory.trim() : '';
  const projectLabel = typeof context?.projectName === 'string' && context.projectName.trim()
    ? context.projectName.trim()
    : projectName(projectDirectory);
  const agents = creatableAgents();
  select.innerHTML = '';
  if (!agents.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No creatable agents';
    select.append(opt);
    hint.textContent = createCapabilityKnown()
      ? 'No registered adapter currently exposes createSession().'
      : 'This broker does not report creatable agents yet. Restart the broker to pick up the latest /api/agents contract.';
    $('#newCreate').disabled = true;
  } else {
    for (const a of agents) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.displayName || a.id;
      select.append(opt);
    }
    const preferred = current?.tool && agents.find((a) => a.id === current.tool) ? current.tool : agents[0].id;
    select.value = preferred;
    hint.textContent = projectDirectory
      ? 'This project directory is prefilled and remains editable. Relative paths are resolved from home. Model and mode are selected after attach.'
      : 'Leave directory empty to create in your home directory. Relative paths are resolved from home. Model and mode are selected after attach.';
    $('#newCreate').disabled = false;
  }
  dir.value = projectDirectory;
  if (projectContext) {
    projectContext.textContent = projectDirectory ? `${projectLabel} · ${projectDirectory}` : '';
    projectContext.style.display = projectDirectory ? '' : 'none';
  }
  title.value = '';
  // Scheduled start (part-3 #50 B): calendar-style — create later, optionally repeating. The repeat
  // options are deliberately simple (once / daily / weekdays, D5); each run creates a FRESH session
  // and sends it the first message below.
  const when = $('#newWhen');
  const fields = $('#newScheduleFields');
  if (when && fields) {
    when.value = 'now';
    fields.style.display = 'none';
    $('#newAt').value = '';
    $('#newPrompt').value = '';
    when.onchange = () => {
      const scheduled = when.value !== 'now';
      fields.style.display = scheduled ? '' : 'none';
      if (scheduled && !$('#newAt').value) $('#newAt').value = defaultScheduleAt();
      $('#newCreate').textContent = scheduled ? 'Schedule' : 'Create';
    };
    $('#newCreate').textContent = 'Create';
  }
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  setTimeout(() => dir.focus(), 0);
}

function closeNewSessionDialog() {
  const sheet = $('#newSheet');
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
}

async function createNewSessionFromDialog() {
  const tool = $('#newAgent').value;
  if (!tool) return;
  const directory = $('#newDirectory').value.trim();
  const title = $('#newSessionTitle').value.trim();
  const when = $('#newWhen') ? $('#newWhen').value : 'now';
  if (when !== 'now') {
    await scheduleNewSessionFromDialog(tool, directory, title, when);
    return;
  }
  try {
    const body = JSON.stringify({ ...(directory ? { directory } : {}), ...(title ? { title } : {}) });
    const r = await fetch(`/api/sessions/${encodeURIComponent(tool)}`, { method: 'POST', headers: { 'content-type': 'application/json', ...tokenHeader() }, body });
    const d = await r.json();
    if (d.session) {
      closeNewSessionDialog();
      attach(d.session, d.attachMode || newSessionAttachMode(d.session));
    } else {
      toast(d.error || 'Could not create session', 'error');
    }
  } catch {
    toast('Could not create session', 'error');
  }
}

function newSessionAttachMode(s) {
  const c = controlFor(s);
  if (c?.terminalSync?.active || c?.drive?.state === 'driving') return null;
  if (c?.terminalSync?.syncAvailable) return null; // sync-first: don't auto-resume a syncable session
  if (c?.drive?.supported && c.drive.state === 'observing') return 'resume';
  const caps = agentInfos[s?.tool]?.capabilities || {};
  return !s?.control && caps.supportsResume ? 'resume' : null;
}
function copyTranscript() {
  navigator.clipboard?.writeText(thread.innerText || '').then(() => toast('Transcript copied')).catch(() => toast('Copy failed', 'error'));
}
function exportTranscript() {
  const blob = new Blob([thread.innerText || ''], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = ((current && current.title) || 'session').replace(/[^\w.-]+/g, '_') + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}
$('#newSession').onclick = () => void newSession();
$('#newCancel').onclick = closeNewSessionDialog;
$('#newCreate').onclick = createNewSessionFromDialog;
$('#newSheet').onclick = (e) => { if (e.target.id === 'newSheet') closeNewSessionDialog(); };

// ── scheduled sends (part-3 #50) ─────────────────────────────────────────────
// A: composer 🕒 schedules THIS composer text for THIS session (one-shot, D5). B: the New-session
// dialog's Start selector schedules a fresh session + first message (once/daily/weekdays). The broker
// fires either through the SAME control gates as a normal prompt with NO model/mode overrides (D6) and
// notifies outcomes (quiet success row, pushy failure/miss — D7/D8). Managed under Settings → Manage.
function defaultScheduleAt(minutesFromNow = 60) {
  const d = new Date(Date.now() + minutesFromNow * 60_000);
  d.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  // datetime-local wants a LOCAL "YYYY-MM-DDTHH:MM" string (toISOString would shift to UTC).
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Date.parse on a no-timezone "YYYY-MM-DDTHH:MM" string is LOCAL time per spec — what the user meant.
function parseScheduleAt(value) {
  const at = Date.parse(String(value || ''));
  if (!Number.isFinite(at)) { toast('Pick a valid time', 'error'); return null; }
  if (at < Date.now() - 60_000) { toast('That time is in the past', 'error'); return null; }
  return at;
}
function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; }
  catch { return undefined; }
}
function scheduleRevision(s) {
  const revision = Number(s?.revision);
  return Number.isInteger(revision) && revision > 0 ? revision : 1;
}
function scheduleAtInputValue(at) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function scheduleDateText(at) {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : 'an unknown time';
}
function isPendingScheduleForCurrent(s) {
  return !!(
    current && s && s.id != null &&
    s.tool === current.tool &&
    s.sessionId === current.id &&
    s.kind === 'message' &&
    s.state === 'scheduled'
  );
}
function scheduleDeleteUrl(s) {
  const id = encodeURIComponent(String(s?.id || ''));
  const rawRevision = Number(s?.revision);
  const query = Number.isInteger(rawRevision) && rawRevision > 0 ? `?expectedRevision=${rawRevision}` : '';
  return `/api/schedules/${id}${query}`;
}
function clearPendingScheduleElements() {
  for (const el of pendingScheduleElements.values()) el.remove();
  pendingScheduleElements.clear();
}
async function fetchSchedulesSnapshot() {
  const requestGeneration = attachSeq;
  if (scheduleFetchPromise && scheduleFetchGeneration !== requestGeneration) {
    await scheduleFetchPromise.catch(() => null);
  }
  if (scheduleFetchPromise && scheduleFetchGeneration === requestGeneration) return scheduleFetchPromise;
  const request = (async () => {
    const r = await fetch('/api/schedules', { cache: 'no-store', headers: tokenHeader() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Could not load schedules (${r.status})`);
    return Array.isArray(d.schedules) ? d.schedules : [];
  })();
  scheduleFetchPromise = request;
  scheduleFetchGeneration = requestGeneration;
  try {
    return await request;
  } finally {
    if (scheduleFetchPromise === request) {
      scheduleFetchPromise = null;
      scheduleFetchGeneration = null;
    }
  }
}
function reconcilePendingScheduleCards(schedules) {
  if (Array.isArray(schedules)) {
    pendingSchedules.clear();
    for (const s of schedules) {
      if (isPendingScheduleForCurrent(s)) pendingSchedules.set(String(s.id), s);
    }
  }
  let container = thread.querySelector('.pendingSchedules');
  for (const [id, el] of pendingScheduleElements) {
    if (!pendingSchedules.has(id)) {
      el.remove();
      pendingScheduleElements.delete(id);
    }
  }
  if (!pendingSchedules.size) {
    container?.remove();
    return;
  }
  if (!container || container.parentElement !== thread || !Array.from(thread.children).includes(container)) {
    container = document.createElement('div');
    container.className = 'pendingSchedules';
    container.setAttribute('aria-live', 'polite');
    thread.append(container);
  }
  for (const [id, s] of pendingSchedules) {
    let card = pendingScheduleElements.get(id);
    if (!card || card.parentElement !== container || !Array.from(container.children).includes(card)) {
      card = document.createElement('article');
      card.className = 'pendingSchedule';
      card.dataset.scheduleId = id;
      card.innerHTML =
        '<div class="pendingScheduleHead"><span class="pendingScheduleState"></span><span class="pendingScheduleTime"></span></div>' +
        '<div class="pendingScheduleText"></div>' +
        '<div class="pendingScheduleMeta"></div>' +
        '<div class="pendingScheduleActions"><button type="button" class="scheduleEdit">Edit</button><button type="button" class="scheduleCancel">Cancel</button></div>';
      pendingScheduleElements.set(id, card);
      container.append(card);
    }
    card.dataset.scheduleRevision = String(scheduleRevision(s));
    card.querySelector('.pendingScheduleState').textContent = 'Scheduled';
    card.querySelector('.pendingScheduleTime').textContent = scheduleDateText(s.at);
    card.querySelector('.pendingScheduleText').textContent = s.text || '';
    card.querySelector('.pendingScheduleMeta').textContent = 'Will send to this session';
    card.querySelector('.scheduleEdit').onclick = () => openScheduleEdit(s);
    card.querySelector('.scheduleCancel').onclick = () => void cancelSchedule(s);
  }
}
function setPendingSchedule(s) {
  if (!isPendingScheduleForCurrent(s)) return;
  pendingSchedules.set(String(s.id), s);
  reconcilePendingScheduleCards();
}
function scheduleTargetFor(s) {
  if (s && s.tool && s.sessionId) return { tool: s.tool, id: s.sessionId };
  if (s && s.tool && s.id != null && !s.kind) return { tool: s.tool, id: s.id };
  return null;
}
// A null target is intentional for Settings → Manage when no session is attached: ownership is the
// attach generation alone. A non-null target additionally requires the exact attached tool/session.
function ownsScheduleRequest(generation, target) {
  if (generation !== attachSeq) return false;
  if (!target) return true;
  return !!current && current.tool === target.tool && current.id === target.id;
}
async function refreshScheduleTruth(expectedAttachSeq = attachSeq, expectedTarget = scheduleTargetFor(current)) {
  const schedules = await fetchSchedulesSnapshot();
  if (ownsScheduleRequest(expectedAttachSeq, expectedTarget)) reconcilePendingScheduleCards(schedules);
  return schedules;
}
async function refreshPendingSchedules(expectedAttachSeq = attachSeq) {
  const target = current ? { tool: current.tool, id: current.id } : null;
  if (!target) return [];
  try {
    const schedules = await fetchSchedulesSnapshot();
    // A session switch or reattach can complete after this GET started. Its rows belong to the old
    // attach generation and must never paint into the newly attached session.
    if (expectedAttachSeq !== attachSeq || !current || current.tool !== target.tool || current.id !== target.id) return schedules;
    reconcilePendingScheduleCards(schedules);
    return schedules;
  } catch {
    return null;
  }
}
function openScheduleEdit(s) {
  if (!s || s.kind !== 'message' || s.state !== 'scheduled') return;
  editingSchedule = { ...s };
  $('#scheduleTitle').textContent = 'Edit scheduled message';
  $('#scheduleTarget').textContent = `To: ${s.sessionTitle || `${s.tool} session`}`;
  $('#scheduleText').value = s.text || '';
  $('#scheduleAt').value = scheduleAtInputValue(s.at);
  $('#scheduleConfirm').textContent = 'Save changes';
  const sheet = $('#scheduleSheet');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
}
function openScheduleSheet() {
  if (!current) return;
  if (!input.value.trim()) { toast('Type the message to schedule first', 'error'); return; }
  editingSchedule = null;
  $('#scheduleTitle').textContent = 'Schedule message';
  $('#scheduleTarget').textContent = `To: ${current.title || current.id} (${current.tool})`;
  $('#scheduleText').value = input.value;
  $('#scheduleAt').value = defaultScheduleAt();
  $('#scheduleConfirm').textContent = 'Schedule';
  const sheet = $('#scheduleSheet');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
}
let editingSchedule = null;
function closeScheduleSheet() {
  const sheet = $('#scheduleSheet');
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  editingSchedule = null;
}
async function confirmScheduleMessage() {
  const edit = editingSchedule;
  if (!edit && !current) return;
  const requestAttachSeq = attachSeq;
  // Settings can edit a live message for a different session; that still owns the current attach
  // generation's sheet. Inline edits, however, bind their response to the attached session target.
  const editBelongsToCurrent = !!(edit && current && edit.tool === current.tool && edit.sessionId === current.id);
  const requestTarget = edit
    ? (editBelongsToCurrent ? scheduleTargetFor(edit) : null)
    : (current ? { tool: current.tool, id: current.id } : null);
  const text = $('#scheduleText').value.trim();
  if (!text) { closeScheduleSheet(); return; }
  const at = parseScheduleAt($('#scheduleAt').value);
  if (at == null) return;
  try {
    if (edit) {
      const body = JSON.stringify({ text, at, expectedRevision: scheduleRevision(edit) });
      const r = await fetch(`/api/schedules/${encodeURIComponent(String(edit.id))}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', ...tokenHeader() }, body,
      });
      const d = await r.json().catch(() => ({}));
      // The sheet may now belong to a newer attach. No stale PATCH outcome—success, conflict, or
      // error—may close, repopulate, or toast over that newer editor.
      if (!ownsScheduleRequest(requestAttachSeq, requestTarget)) return;
      if (r.status === 409) {
        const truth = await refreshScheduleTruth(requestAttachSeq, requestTarget).catch(() => []);
        const canonical = ownsScheduleRequest(requestAttachSeq, requestTarget)
          ? truth.find((s) => String(s.id) === String(edit.id)) || (String(d.schedule?.id) === String(edit.id) ? d.schedule : null)
          : null;
        if (canonical?.state === 'scheduled') openScheduleEdit(canonical);
        else closeScheduleSheet();
        toast('This scheduled message changed elsewhere. We refreshed it — review and try again.', 'error');
        return;
      }
      if (!r.ok || !d.schedule) { toast(d.error || 'Could not update scheduled message', 'error'); return; }
      if (ownsScheduleRequest(requestAttachSeq, requestTarget) && current) setPendingSchedule(d.schedule);
      closeScheduleSheet();
      toast('Scheduled message updated');
      if ($('#schedulesSheet')?.classList.contains('open')) void renderSchedulesList();
      return;
    }
    const body = JSON.stringify({ kind: 'message', tool: current.tool, sessionId: current.id, sessionTitle: current.title, text, at });
    const r = await fetch('/api/schedules', { method: 'POST', headers: { 'content-type': 'application/json', ...tokenHeader() }, body });
    const d = await r.json().catch(() => ({}));
    if (!ownsScheduleRequest(requestAttachSeq, requestTarget)) return;
    if (!r.ok || !d.schedule) { toast(d.error || 'Could not schedule', 'error'); return; }
    // A POST can finish after the user has switched sessions. Do not let that old mutation clear the
    // new session's composer/shared draft or close its UI; the returned row is also discarded.
    setPendingSchedule(d.schedule);
    closeScheduleSheet();
    // The text now lives in the schedule — clear the composer AND the shared draft, like a send would.
    input.value = '';
    input.style.height = 'auto';
    lastSyncedDraft = '';
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ kind: 'draft', text: '' }));
    toast(`Scheduled for ${scheduleDateText(d.schedule.at ?? at)}`);
  } catch {
    if (requestAttachSeq !== attachSeq) return;
    toast(edit ? 'Could not update scheduled message' : 'Could not schedule', 'error');
  }
}
async function scheduleNewSessionFromDialog(tool, directory, title, when) {
  const text = $('#newPrompt').value.trim();
  if (!text) { toast('A scheduled session needs a first message', 'error'); return; }
  const at = parseScheduleAt($('#newAt').value);
  if (at == null) return;
  const repeat = when === 'daily' ? 'daily' : when === 'weekdays' ? 'weekdays' : undefined;
  const body = JSON.stringify({
    kind: 'new-session', tool, text, at,
    ...(directory ? { directory } : {}), ...(title ? { title } : {}), ...(repeat ? { repeat, timeZone: browserTimeZone() } : {}),
  });
  try {
    const r = await fetch('/api/schedules', { method: 'POST', headers: { 'content-type': 'application/json', ...tokenHeader() }, body });
    const d = await r.json();
    if (!d.schedule) { toast(d.error || 'Could not schedule', 'error'); return; }
    closeNewSessionDialog();
    toast(`Session scheduled for ${new Date(at).toLocaleString()}${repeat ? ` (repeats ${repeat})` : ''}`);
  } catch {
    toast('Could not schedule', 'error');
  }
}
function openSchedulesSheet() {
  const sheet = $('#schedulesSheet');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  void renderSchedulesList();
}
function closeSchedulesSheet() {
  const sheet = $('#schedulesSheet');
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
}
async function renderSchedulesList() {
  const list = $('#schedulesList');
  const renderAttachSeq = attachSeq;
  try {
    const schedules = await fetchSchedulesSnapshot();
    if (renderAttachSeq !== attachSeq) return;
    if (current && renderAttachSeq === attachSeq) reconcilePendingScheduleCards(schedules);
    list.innerHTML = '';
    if (!schedules.length) {
      list.textContent = 'Nothing scheduled. Use the composer 🕒 to schedule a message, or "Start: Later" in New session.';
      return;
    }
    for (const s of schedules) list.append(scheduleRowEl(s));
  } catch {
    list.textContent = 'Could not load schedules.';
  }
}
function scheduleRowEl(s) {
  const row = document.createElement('div');
  row.className = 'scheduleRow' + (s.state !== 'scheduled' ? ' done' : '');
  row.dataset.scheduleId = String(s.id || '');
  const body = document.createElement('div');
  body.className = 'scheduleBody';
  const what = document.createElement('div');
  what.className = 'scheduleWhat';
  const target = s.kind === 'message'
    ? `→ ${s.sessionTitle || `${s.tool} session`}`
    : `new ${s.tool} session${s.title ? ` “${s.title}”` : ''}${s.directory ? ` in ${s.directory}` : ''}`;
  what.textContent = `${s.kind === 'message' ? '💬' : '🗓'} ${target}: ${s.text}`;
  what.title = s.text;
  const meta = document.createElement('div');
  meta.className = 'scheduleMeta';
  const repeat = s.repeat ? ` · repeats ${s.repeat}` : '';
  const err = s.lastError ? ` (${s.lastError})` : '';
  meta.textContent = s.state === 'scheduled'
    ? `next ${new Date(s.at).toLocaleString()}${repeat}${s.lastOutcome ? ` · last: ${s.lastOutcome}${err}` : ''}`
    : `${s.state}${s.lastFiredAt ? ` · ${new Date(s.lastFiredAt).toLocaleString()}` : ''}${err}`;
  body.append(what, meta);
  const actions = document.createElement('div');
  actions.className = 'scheduleActions';
  if (s.state === 'scheduled' && s.kind === 'message') {
    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.onclick = () => openScheduleEdit(s);
    actions.append(edit);
  }
  const act = document.createElement('button');
  act.textContent = s.state === 'scheduled' ? 'Cancel' : 'Remove';
  act.onclick = async () => {
    await cancelSchedule(s);
    void renderSchedulesList();
  };
  actions.append(act);
  row.append(body, actions);
  return row;
}
async function cancelSchedule(s) {
  const requestAttachSeq = attachSeq;
  const requestTarget = scheduleTargetFor(s);
  let conflict = false;
  let responseSchedule = null;
  try {
    const r = await fetch(scheduleDeleteUrl(s), { method: 'DELETE', headers: tokenHeader() });
    responseSchedule = await r.json().catch(() => ({}));
    conflict = r.status === 409;
    if (conflict && ownsScheduleRequest(requestAttachSeq, requestTarget) && responseSchedule?.schedule) {
      // A 409 may already carry the broker's canonical row. Apply it before the best-effort GET so
      // a failed refresh cannot leave the card with the stale revision that just conflicted.
      const canonical = responseSchedule.schedule;
      if (canonical.state === 'scheduled') pendingSchedules.set(String(canonical.id), canonical);
      else pendingSchedules.delete(String(s.id));
      reconcilePendingScheduleCards();
    }
    if (!r.ok && !conflict) {
      toast(responseSchedule.error || 'Could not cancel schedule', 'error');
    } else if (r.ok && ownsScheduleRequest(requestAttachSeq, requestTarget)) {
      // Remove the visible card from the successful mutation response first. A slow/failed follow-up
      // GET must not leave a schedule that the broker already canceled painted in the transcript.
      const canonical = responseSchedule?.schedule;
      if (canonical?.state === 'scheduled') pendingSchedules.set(String(canonical.id), canonical);
      else pendingSchedules.delete(String(s.id));
      reconcilePendingScheduleCards();
    }
  } catch {
    toast('Could not cancel schedule', 'error');
  }
  await refreshScheduleTruth(requestAttachSeq, requestTarget).catch(() => null);
  if (conflict) toast('This schedule changed elsewhere. We refreshed it.', 'error');
}
$('#scheduleBtn').onclick = openScheduleSheet;
$('#scheduleCancel').onclick = closeScheduleSheet;
$('#scheduleConfirm').onclick = confirmScheduleMessage;
$('#scheduleSheet').onclick = (e) => { if (e.target.id === 'scheduleSheet') closeScheduleSheet(); };
$('#schedulesClose').onclick = closeSchedulesSheet;
$('#schedulesSheet').onclick = (e) => { if (e.target.id === 'schedulesSheet') closeSchedulesSheet(); };
['sessionSearch', 'statusFilter', 'agentFilter', 'activityFilter', 'olderThanDays'].forEach((id) => {
  const el = $('#' + id);
  if (el) {
    el.oninput = () => renderRoster();
    el.onchange = () => renderRoster();
  }
});

// ── model / agent pickers ─────────────────────────────────────────────────────
// The selection rides along with each prompt (per-prompt model/agent override), so switching is
// instant and stateless on the server. The UI just tracks selectedModel/selectedAgent.
function renderControls() {
  const controls = $('#controls');
  const ap = $('#agentPick');
  const mp = $('#modelPick');
  const ep = $('#effortPick');
  const dp = $('#modePick');
  // Pickers (model/effort/mode/agent) need PROMPT capability, not just send/answer — an answer-only synced
  // session can answer cards but cannot inject a /model or /mode change, so the pickers stay locked there.
  const editable = !!driving && !!current && canPromptFromControl(current);
  const haveAgents = !!current && (serverAgents.length > 0 || !!selectedAgent || !!current.currentAgent);
  const haveModels = !!current && (serverModels.length > 0 || !!selectedModel || !!current.model || !!current.currentModel);
  const haveModes = !!current && (serverModes.length > 0 || !!selectedMode || !!current.currentMode);
  const model = currentModelOption();
  ensureReasoningEffort(model);
  const efforts = effortOptions(model);
  const haveEfforts = !!current && (efforts.length > 0 || !!selectedModel?.reasoningEffort || !!current.currentModel?.reasoningEffort);
  ap.style.display = haveAgents ? '' : 'none';
  ap.disabled = !editable || !serverAgents.length;
  ap.textContent = '🧩 ' + (selectedAgent || current.currentAgent || 'build');
  mp.style.display = haveModels ? '' : 'none';
  mp.disabled = !editable || !serverModels.length;
  mp.textContent = '🤖 ' + (model ? model.label : selectedModel ? selectedModel.modelID : current.currentModel?.modelID || current.model || 'model');
  ep.style.display = haveEfforts ? '' : 'none';
  ep.disabled = !editable || !efforts.length;
  ep.textContent = '🧠 ' + (efforts.find((x) => x.effort === selectedModel?.reasoningEffort)?.label || selectedModel?.reasoningEffort || current.currentModel?.reasoningEffort || 'effort');
  dp.style.display = haveModes ? '' : 'none';
  dp.disabled = !editable || !serverModes.length;
  dp.textContent = '🛡️ ' + (serverModes.find((x) => x.value === selectedMode)?.label || selectedMode || current.currentMode || 'mode');
  controls.style.display = haveAgents || haveModels || haveEfforts || haveModes ? '' : 'none';
  renderStatusline();
}
function currentModelOption() {
  return selectedModel && serverModels.find(
    (x) =>
      x.providerID === selectedModel.providerID &&
      x.modelID === selectedModel.modelID &&
      modelVariantKey(x.variant) === modelVariantKey(selectedModel.variant),
  );
}
// Model variants are part of exact model identity for tools that expose them.
// Contract: docs/architecture/client-ui.md and
// docs/protocol/adapter-support.md
function modelVariantKey(variant) {
  return variant == null || variant === '' ? '' : String(variant);
}
function effortOptions(model) {
  return (model && model.reasoningEfforts) || [];
}
function ensureReasoningEffort(model) {
  if (!selectedModel || selectedModel.reasoningEffort || !model) return;
  const efforts = effortOptions(model);
  const effort = model.defaultReasoningEffort || (efforts[0] && efforts[0].effort);
  if (effort) selectedModel.reasoningEffort = effort;
}
// A searchable dropdown reused for both pickers; items: [{label, desc, value}].
function openPicker(items, placeholder, onPick) {
  const menu = $('#optmenu');
  menu.innerHTML = '';
  const filter = document.createElement('input');
  filter.className = 'ofilter';
  filter.placeholder = placeholder;
  const list = document.createElement('div');
  menu.append(filter, list);
  const draw = (q) => {
    list.innerHTML = '';
    const ql = q.trim().toLowerCase();
    items
      .filter((it) => !ql || it.label.toLowerCase().includes(ql) || (it.desc || '').toLowerCase().includes(ql))
      .slice(0, 80)
      .forEach((it) => {
        const d = document.createElement('div');
        d.className = 'oitem';
        d.innerHTML = `<div class="ol"></div><div class="od"></div>`;
        d.querySelector('.ol').textContent = it.label;
        d.querySelector('.od').textContent = it.desc || '';
        d.onclick = () => { menu.style.display = 'none'; onPick(it.value); };
        list.append(d);
      });
  };
  filter.oninput = () => draw(filter.value);
  draw('');
  menu.style.display = '';
  filter.focus();
}
$('#agentPick').onclick = () => {
  if (!canChangePicksCurrentSession()) { blockReadOnlyAction('Agent selection'); return; }
  const menu = $('#optmenu');
  if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
  openPicker(
    serverAgents.map((a) => ({ label: a.name, desc: a.description, value: a.name })),
    'Filter agents…',
    (name) => { selectedAgent = name; renderControls(); toast('Agent: ' + name); },
  );
};
$('#modelPick').onclick = () => {
  if (!canChangePicksCurrentSession()) { blockReadOnlyAction('Model selection'); return; }
  const menu = $('#optmenu');
  if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
  openPicker(
    serverModels.map((m) => ({ label: m.label, desc: [m.modelID, modelVariantKey(m.variant)].filter(Boolean).join(' · '), value: m })),
    `Search ${serverModels.length} models…`,
    (m) => {
      selectedModel = { providerID: m.providerID, modelID: m.modelID };
      if (m.variant) selectedModel.variant = m.variant;
      selectedModelDirty = true;
      ensureReasoningEffort(m);
      saveModelPick(); // sticky per session — survives reattach/take-over (issues-part1)
      renderControls();
      toast('Model: ' + m.label);
    },
  );
};
$('#effortPick').onclick = () => {
  if (!canChangePicksCurrentSession()) { blockReadOnlyAction('Reasoning effort'); return; }
  const menu = $('#optmenu');
  if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
  const model = currentModelOption();
  const efforts = effortOptions(model);
  if (!selectedModel || !efforts.length) return;
  openPicker(
    efforts.map((e) => ({ label: e.label || e.effort, desc: e.description || e.effort, value: e.effort })),
    'Filter effort…',
    (effort) => { selectedModel.reasoningEffort = effort; selectedModelDirty = true; saveModelPick(); renderControls(); toast('Reasoning: ' + effort); },
  );
};
$('#modePick').onclick = () => {
  if (!canChangePicksCurrentSession()) { blockReadOnlyAction('Permission mode'); return; }
  const menu = $('#optmenu');
  if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
  if (!serverModes.length) return;
  openPicker(
    serverModes.map((x) => ({ label: x.label || x.value, desc: x.description || x.value, value: x.value })),
    'Filter modes…',
    (v) => { selectedMode = v; selectedModeDirty = true; renderControls(); toast('Mode: ' + v); },
  );
};

// ── file upload (user → agent) ────────────────────────────────────────────────
$('#attach').onclick = () => {
  if (!canMutateCurrentSession()) { blockReadOnlyAction('File upload'); return; }
  $('#fileInput').click();
};
// Picking files STAGES them (multi-file) — they ride along with the next prompt you send, so you
// can attach + type + send as one turn. Nothing is sent until you hit Send.
$('#fileInput').onchange = async () => {
  const files = [...$('#fileInput').files];
  $('#fileInput').value = '';
  if (!canMutateCurrentSession()) {
    pendingAttachments.length = 0;
    renderAttachments();
    blockReadOnlyAction('File upload');
    return;
  }
  for (const f of files) {
    if (f.size > 8_000_000) { toast(`"${f.name}" too large (max 8MB)`, 'error'); continue; }
    try {
      pendingAttachments.push({ name: f.name, mimeType: f.type || 'application/octet-stream', data: await fileToBase64(f) });
    } catch { toast(`Could not read "${f.name}"`, 'error'); }
  }
  renderAttachments();
};
// Render the staged-attachment chips above the composer (with a × to remove each).
function renderAttachments() {
  const row = $('#attachRow');
  if (!row) return;
  row.innerHTML = '';
  row.style.display = pendingAttachments.length ? 'flex' : 'none';
  pendingAttachments.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'achip';
    chip.innerHTML = `<span class="aname"></span><button class="ax" title="Remove" aria-label="Remove">×</button>`;
    chip.querySelector('.aname').textContent = '📎 ' + f.name;
    chip.querySelector('.ax').onclick = () => { pendingAttachments.splice(i, 1); renderAttachments(); };
    row.append(chip);
  });
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || ''); // strip the data:…;base64, prefix
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ── misc ─────────────────────────────────────────────────────────────────────
function isThreadNearBottom() {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight <= AUTOSCROLL_BOTTOM_PX;
}

function updateThreadPinnedToBottom() {
  threadPinnedToBottom = isThreadNearBottom();
}

thread.addEventListener('scroll', updateThreadPinnedToBottom, { passive: true });

function restoreThreadScroll(wasPinned, previousTop) {
  if (wasPinned) {
    scroll(true);
    return;
  }
  thread.scrollTop = previousTop;
  updateThreadPinnedToBottom();
}

function scroll(force = false) {
  if (!force && !threadPinnedToBottom) return;
  thread.scrollTop = thread.scrollHeight;
  threadPinnedToBottom = true;
}
let toastT;
// kind: 'error' (red, the default for failures) or 'info' (neutral). Successful actions use a
// system note / command echo in-thread, so a toast no longer implies something went wrong.
function toast(msg, kind = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', kind === 'error');
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 3000);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function codeLangAttr(lang) {
  const clean = String(lang || '').trim().slice(0, 24);
  return clean ? ` data-lang="${escapeHtml(clean)}"` : '';
}

// ── markdown → safe HTML (assistant output) ─────────────────────────────────
// Renders the common subset (headings, bold/italic/strike, inline + fenced code, tables, lists, quotes,
// links, rules) so the app matches the agent's own terminal rendering. XSS-safe: fenced code is
// extracted first, everything else is escaped, and only a fixed set of tags is (re)introduced.
// Governing UX doc: docs/architecture/client-ui.md
function mdToHtml(src) {
  const blocks = [];
  const stash = (html) => `\uE000B${blocks.push(html) - 1}\uE000`;
  let s = String(src ?? '');
  // closed fenced code blocks ```lang\n…```
  s = s.replace(/```([\w+#.-]*)\n?([\s\S]*?)```/g, (_, lang, code) => stash(`<pre class="cb"${codeLangAttr(lang)}><code>${highlight(code.replace(/\n$/, ''), lang)}</code></pre>`));
  // an UNCLOSED trailing fence (mid-stream) — render what's there so it doesn't look broken
  s = s.replace(/```([\w+#.-]*)\n([\s\S]*)$/g, (_, lang, code) => stash(`<pre class="cb"${codeLangAttr(lang)}><code>${highlight(code, lang)}</code></pre>`));
  const esc = escapeHtml(s);
  const lines = esc.split('\n');
  const out = [];
  const isPlaceholder = (t) => /^\uE000B\d+\uE000$/.test(t.trim());
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isPlaceholder(line)) { out.push(line.trim()); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const lvl = Math.min(h[1].length + 2, 6); out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`); i++; continue; }
    const table = renderMdTableBlock(lines, i);
    if (table) { out.push(table.html); i = table.next; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${mdInline(buf.join('\n'))}</blockquote>`); continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { buf.push(`<li>${mdInline(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`); i++; }
      out.push(`<ul>${buf.join('')}</ul>`); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { buf.push(`<li>${mdInline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`); i++; }
      out.push(`<ol>${buf.join('')}</ol>`); continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const buf = [];
    while (
      i < lines.length && !/^\s*$/.test(lines[i]) && !isPlaceholder(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) && !renderMdTableBlock(lines, i)
    ) { buf.push(lines[i]); i++; }
    out.push(`<p>${mdInline(buf.join('\n'))}</p>`);
  }
  return out.join('').replace(/\uE000B(\d+)\uE000/g, (_, n) => blocks[+n] ?? '');
}

function splitMdTableRow(line) {
  let s = String(line ?? '').trim();
  if (!s.includes('|')) return [];
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      cell += ch;
      escaped = false;
    } else if (ch === '\\') {
      cell += ch;
      escaped = true;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isMdTableDelimiter(line) {
  const cells = splitMdTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function mdTableAlign(cell) {
  const marker = String(cell || '').replace(/\s+/g, '');
  if (marker.startsWith(':') && marker.endsWith(':')) return 'center';
  if (marker.endsWith(':')) return 'right';
  return '';
}

function renderMdTableBlock(lines, start) {
  if (start + 1 >= lines.length || isPlaceholderLine(lines[start]) || isPlaceholderLine(lines[start + 1])) return null;
  const header = splitMdTableRow(lines[start]);
  if (header.length < 2 || !isMdTableDelimiter(lines[start + 1])) return null;
  const align = splitMdTableRow(lines[start + 1]).map(mdTableAlign);
  let i = start + 2;
  const rows = [];
  while (i < lines.length && !/^\s*$/.test(lines[i]) && !isPlaceholderLine(lines[i])) {
    const cells = splitMdTableRow(lines[i]);
    if (cells.length < 2 || isMdTableDelimiter(lines[i])) break;
    rows.push(cells);
    i++;
  }
  const cell = (tag, text, col) => {
    const style = align[col] ? ` style="text-align:${align[col]}"` : '';
    return `<${tag}${style}>${mdInline(text || '')}</${tag}>`;
  };
  const head = `<thead><tr>${header.map((text, col) => cell('th', text, col)).join('')}</tr></thead>`;
  const body = `<tbody>${rows.map((row) => `<tr>${header.map((_, col) => cell('td', row[col] || '', col)).join('')}</tr>`).join('')}</tbody>`;
  return { html: `<div class="tableWrap"><table class="md-table">${head}${body}</table></div>`, next: i };
}

function isPlaceholderLine(line) {
  return /^\uE000B\d+\uE000$/.test(String(line || '').trim());
}

// Inline spans on already-escaped text. Inline code is protected first so emphasis never bleeds in.
function mdInline(s) {
  const codes = [];
  let t = s.replace(/`([^`]+)`/g, (_, c) => `C${codes.push(c) - 1}`);
  t = t
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_, tx, u) => `<a href="${u}" target="_blank" rel="noopener">${tx}</a>`);
  return t.replace(/C(\d+)/g, (_, n) => `<code>${codes[+n] ?? ''}</code>`);
}

// Minimal, dependency-free syntax highlighter for fenced code. Tokenizes the RAW source (comments,
// strings, numbers) escaping each chunk as it goes, then highlights keywords in the plain segments.
const HL_KW = {
  sh: ['if','then','else','elif','fi','for','while','do','done','case','esac','in','function','return','export','local','echo','cd','sudo','source','set','unset','read','exit','trap'],
  js: ['const','let','var','function','return','if','else','for','while','await','async','import','from','export','default','class','extends','new','try','catch','finally','throw','typeof','instanceof','of','in','this','null','true','false','undefined','interface','type','enum'],
  py: ['def','return','if','elif','else','for','while','import','from','as','class','try','except','finally','with','lambda','yield','pass','break','continue','in','not','and','or','is','None','True','False','self','async','await','raise','global'],
};
function hlBucket(l) {
  l = (l || '').toLowerCase();
  if (/^(bash|sh|shell|zsh|console|fish)$/.test(l)) return 'sh';
  if (/^(py|python)$/.test(l)) return 'py';
  if (/^(json|jsonc)$/.test(l)) return null; // structure only — strings/numbers, no keywords
  return 'js';
}
function highlight(code, lang) {
  const l = (lang || '').toLowerCase();
  const bucket = hlBucket(l);
  const kw = (HL_KW[bucket] || []);
  const kwRe = kw.length ? new RegExp('\\b(' + kw.join('|') + ')\\b', 'g') : null;
  const hash = /^(bash|sh|shell|zsh|console|fish|py|python|ruby|yaml|yml|toml|ini|dockerfile|makefile|r)$/.test(l);
  const slash = !hash || /^(c|cpp|java|go|rust|rs|php|kotlin|swift|scala)$/.test(l);
  const comment = [hash ? '#[^\\n]*' : '', slash ? '\\/\\/[^\\n]*' : '', slash ? '\\/\\*[\\s\\S]*?\\*\\/' : ''].filter(Boolean).join('|');
  const tokenRe = new RegExp(
    '(' + (comment || '(?!)') + ')|' +
    '("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)|' +
    '(\\b\\d[\\d._xa-fA-F]*\\b)', 'g',
  );
  const applyKw = (escaped) => (kwRe ? escaped.replace(kwRe, '<span class="k">$1</span>') : escaped);
  let out = '', last = 0, m;
  while ((m = tokenRe.exec(code))) {
    if (m.index < last) { tokenRe.lastIndex++; continue; }
    out += applyKw(escapeHtml(code.slice(last, m.index)));
    if (m[1]) out += `<span class="c">${escapeHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="s">${escapeHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="n">${escapeHtml(m[3])}</span>`;
    last = tokenRe.lastIndex;
    if (tokenRe.lastIndex === m.index) tokenRe.lastIndex++; // guard against zero-width matches
  }
  out += applyKw(escapeHtml(code.slice(last)));
  return out;
}

function leaveSessionView() {
  clearDrivingIntent(current);
  ++attachSeq; // invalidate any in-flight schedule GET as well as stale stream work
  document.body.classList.remove('attached');
  $('#back').style.display = 'none';
  if (ws) { try { ws.close(); } catch {} ws = null; }
  current = null;
  clearPendingScheduleElements();
  pendingSchedules.clear();
  reconcilePendingScheduleCards();
  serverCommands = [];
  serverModels = [];
  serverAgents = [];
  serverModes = [];
  selectedMode = null;
  selectedModeDirty = false;
  driving = false;
  canInterrupt = false;
  lastSubmitted = null;
  pendingSends.length = 0;
  resetStatuslineState();
  $('#palette').style.display = 'none';
  $('#optmenu').style.display = 'none';
  $('#controls').style.display = 'none';
  $('#sessionMeta').style.display = 'none';
  $('#statusline').style.display = 'none';
  $('#stop').style.display = 'none';
  $('#control').style.display = 'none';
  $('#controlState').style.display = 'none';
  $('#attach').disabled = true;
  renderSyncHint(null);
  loadRoster();
}

// Per-tool capabilities (for the Drive affordance: which sessions can be taken over / driven).
async function loadAgents() {
  try {
      const list = await (await fetch('/api/agents')).json();
    for (const a of list || []) {
      const hasCreateFlag = Object.prototype.hasOwnProperty.call(a, 'canCreateSession');
      agentCaps[a.id] = { ...(a.capabilities || {}), canRenameNative: !!a.canRenameNative, canFork: !!a.canFork, canClone: !!a.canClone, canTranscriptExport: !!a.canTranscriptExport };
      agentInfos[a.id] = {
        id: a.id,
        displayName: a.displayName || a.id,
        // Compatibility with an already-running older broker: the new broker sends the authoritative
        // canCreateSession flag; older brokers did not, but OpenCode-like live adapters were the only
        // creatable surface then. If this optimistic fallback is wrong, POST /api/sessions/:tool
        // still returns a clear backend error.
        canCreateSession: hasCreateFlag ? !!a.canCreateSession : !!(a.capabilities?.supportsLiveAttach && a.capabilities?.attachModes?.includes('live')),
        createCapabilityKnown: hasCreateFlag,
        canRenameNative: !!a.canRenameNative,
        canFork: !!a.canFork,
        canClone: !!a.canClone,
        canTranscriptExport: !!a.canTranscriptExport,
        capabilities: agentCaps[a.id],
      };
    }
    if (lastRosterSessions.length) renderRoster();
  } catch { /* offline — Drive just won't show until next load */ }
}

// --- Broker unlock gate -----------------------------------------------------------------------------
// The broker gates its API and WS stream behind a shared token whenever one is provisioned. The shell is
// deliberately served WITHOUT auth (it holds no secrets), so an unauthenticated visitor would otherwise get
// a fully rendered page whose every data call 401s — an empty UI with no explanation and no way in.
//
// Probe one gated endpoint on boot; if the broker wants a credential we don't have, ask for it here. This is
// deliberately not a `?token=` URL flow: secrets in URLs leak into browser history, access logs and Referer
// headers, and can't be revoked per-viewer. brokerToken() still accepts a URL token for first-run handoff,
// which is a one-time bootstrap rather than the standing access path.
async function probeBrokerAuth() {
  try {
    const res = await fetch('/api/broker/health', { headers: { ...tokenHeader() } });
    return res.status === 401 ? 'needs-token' : 'ok';
  } catch {
    return 'offline'; // broker down / network error — not an auth problem, so don't nag for a token
  }
}

function showBrokerUnlock(onAccepted) {
  if (document.getElementById('brokerUnlock')) return;
  const wrap = document.createElement('div');
  wrap.id = 'brokerUnlock';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;'
    + 'justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(2px)';

  // A real <form> with a username+password pair, not a bare input: browser password managers
  // (Safari/Chrome/Firefox) only offer to save a credential when they can see a submitted form
  // containing an autocomplete-tagged password field. The username is the broker origin, which both
  // gives the manager a key to associate the entry with and lets a multi-broker user tell saved
  // entries apart. It is readonly — it identifies the broker, it is not something to type.
  const form = document.createElement('form');
  form.method = 'post';
  form.action = '#';
  form.autocomplete = 'on';
  form.style.cssText = 'background:var(--panel,#1b1b1f);color:var(--fg,#eee);padding:24px;border-radius:12px;'
    + 'max-width:420px;width:calc(100% - 32px);box-shadow:0 12px 40px rgba(0,0,0,.5);font:14px system-ui';

  const title = document.createElement('div');
  title.textContent = 'This broker requires a token';
  title.style.cssText = 'font-size:16px;font-weight:600';

  const hint = document.createElement('div');
  hint.textContent = 'Find it on the broker host at ~/.cosyncing/secrets/broker-token, '
    + 'or run: cosyncing pair — to pair this device instead.';
  hint.style.cssText = 'opacity:.75;margin-top:6px;line-height:1.45';

  const fieldCss = 'width:100%;padding:9px 10px;margin-top:12px;border-radius:7px;'
    + 'border:1px solid var(--border,#444);background:var(--bg,#111);color:inherit;font:inherit;box-sizing:border-box';

  const user = document.createElement('input');
  user.type = 'text';
  user.name = 'username';
  user.id = 'brokerUnlockUser';
  user.autocomplete = 'username';
  user.readOnly = true;
  user.value = location.host;
  user.setAttribute('aria-label', 'Broker');
  user.style.cssText = fieldCss + ';opacity:.7';

  const input = document.createElement('input');
  input.type = 'password';
  input.name = 'password';
  input.id = 'brokerUnlockToken';
  input.autocomplete = 'current-password';
  input.placeholder = 'Paste broker token';
  input.setAttribute('aria-label', 'Broker token');
  input.style.cssText = fieldCss;

  const err = document.createElement('div');
  err.style.cssText = 'color:#ff6b6b;min-height:18px;margin:8px 0 0';

  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.textContent = 'Unlock';
  btn.style.cssText = 'margin-top:12px;width:100%;padding:9px;border-radius:7px;border:0;'
    + 'background:var(--accent,#4c8dff);color:#fff;font:inherit;cursor:pointer';

  form.onsubmit = async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) { err.textContent = 'Enter a token.'; return; }
    btn.disabled = true;
    err.textContent = '';
    try {
      // Validate against the broker BEFORE persisting, so a typo can't wedge the app into a stored-but-bad
      // credential that 401s forever with no visible cause.
      const res = await fetch('/api/broker/health', { headers: { 'x-cosyncing-token': value } });
      if (res.status === 401) { err.textContent = 'Broker rejected that token.'; btn.disabled = false; return; }
      localStorage.setItem(BROKER_TOKEN_KEY, value);
      wrap.remove();
      // The reload doubles as the navigation that prompts the password manager to offer saving.
      onAccepted();
    } catch {
      err.textContent = 'Could not reach the broker.';
      btn.disabled = false;
    }
  };

  form.append(title, hint, user, input, err, btn);
  wrap.append(form);
  document.body.append(wrap);
  input.focus();
}

async function ensureBrokerAccess() {
  if (await probeBrokerAuth() !== 'needs-token') return;
  // Reload rather than re-running init piecemeal: everything downstream (roster, agents, WS attach) reads the
  // token at call time, and a fresh load is the only way to guarantee no half-initialized state survives.
  showBrokerUnlock(() => location.reload());
}

function startApp() {
  void ensureBrokerAccess();
  applyThemePreference();
  setLanguagePreference(languagePreference);
  setToolDisplayMode(toolDisplayMode, false);
  addEventListener('resize', () => setToolDisplayMode(toolDisplayMode, false));
  initSettingsMenu();
  renderControlState();
  try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyThemePreference); } catch {}
  $('#refresh').onclick = loadRoster;
  $('#back').onclick = leaveSessionView;
  loadAgents();
  loadRoster();
  // Refresh the roster even while attached, so status badges (e.g. needs-input) don't go stale. Skip the
  // poll while hidden (backgrounded phone/tab) — resyncAfterReturn catches up the moment the user returns.
  setInterval(() => { if (!document.hidden) void loadRoster(); }, 6000);
  // Schedule visibility is intentionally much less frequent than roster/status polling. The shared
  // fetch promise in fetchSchedulesSnapshot serializes this with Settings → Manage and attach refreshes.
  setInterval(() => { if (!document.hidden && current) void refreshPendingSchedules(); }, SCHEDULE_POLL_MS);
  // Background tabs get this interval throttled (Chrome intensive throttling: as little as one tick
  // per 10 minutes) and a frozen tab may have its stream socket closed underneath us. WS frames that
  // DID arrive while hidden render fine — what goes stale is the roster and a killed socket. Resync
  // both the moment the user returns instead of waiting for the next throttled tick (issues-part3).
  // visibilitychange only — throttling/freezing key on document.hidden, and a window `focus` listener
  // would re-render the roster on every click into the page (it broke Playwright's click stability).
  document.addEventListener('visibilitychange', resyncAfterReturn);
}

function resyncAfterReturn() {
  if (document.hidden) return;
  void loadRoster(); // immediate roster catch-up (rosterLoading gate dedupes)
  if (current) void refreshPendingSchedules();
  if (current && !sessionEndedByServer && (!ws || ws.readyState >= 2)) {
    toast('Reconnecting session…');
    void attach(current, lastAttachMode);
  }
}

function exposeTestApi() {
  // Component tests load this no-build browser file directly under a tiny DOM shim and call the same
  // render/state functions production uses. Keep this list narrow; it exists to prevent static-only UI
  // checks from missing regressions like the ready-to-review red dot.
  // Governing UX doc: docs/architecture/client-ui.md
  globalThis.__COSYNCING_APP__ = {
    attach,
    controlFor,
    groupByProject,
    initSettingsMenu,
    loadAgents,
    loadRoster,
    render,
    renderControlState,
    renderRoster,
    setSessionWindow,
    requestRestartEverything,
    requestRuntimeRestart,
    requestProjectRename,
    requestSessionFork,
    requestSessionRename,
    requestTranscriptExport,
    resetSessionBars,
    resyncAfterReturn,
    startCommandBar,
    clearCommandBars,
    rowEl,
    runTransportDemo,
    sessionKey,
    controlAction,
    updateComposerButtons,
    updateReviewNotices,
    openNewSessionDialog,
    createNewSessionFromDialog,
    openScheduleSheet,
    openScheduleEdit,
    confirmScheduleMessage,
    refreshPendingSchedules,
    renderSchedulesList,
    setToolDisplayMode,
    getState: () => ({
      activeBars,
      taskLists,
      current,
      driving,
      lastRosterSessions,
      openProjects,
      reviewSessionKeys,
      rosterStatusBySession,
      pendingSchedules,
    }),
  };
}

if (globalThis.__COSYNCING_TEST__) exposeTestApi();
else startApp();
