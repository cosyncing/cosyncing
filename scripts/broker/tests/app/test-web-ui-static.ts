/**
 * Static regression checks for the no-build web UI. This intentionally avoids a browser dependency:
 * the render gate already checks canonical message coverage, while these assertions protect the
 * generic create-session and project-roster wiring added to app.js/index.html/main.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../../..');
const app = readFileSync(join(ROOT, 'apps/poc-ui/public/app.js'), 'utf8');
const html = readFileSync(join(ROOT, 'apps/poc-ui/public/index.html'), 'utf8');
const broker = readFileSync(join(ROOT, 'packages/typescript/broker/src/main.ts'), 'utf8');
const clientMessagePolicy = readFileSync(join(ROOT, 'packages/typescript/broker/src/client-message-policy.ts'), 'utf8');
const wsLimits = readFileSync(join(ROOT, 'packages/typescript/broker/src/ws-limits.ts'), 'utf8');
const hub = readFileSync(join(ROOT, 'packages/typescript/broker/src/hub.ts'), 'utf8');
const core = readFileSync(join(ROOT, 'packages/typescript/adapter-api/src/index.ts'), 'utf8');
const artifactStore = readFileSync(join(ROOT, 'packages/typescript/broker/src/artifact-store.ts'), 'utf8');
const historyDelta = readFileSync(join(ROOT, 'packages/typescript/broker/src/history-delta.ts'), 'utf8');
const agentActivitySource = app.slice(
  app.indexOf('function agentActivity(m)'),
  app.indexOf('function bubble(cls', app.indexOf('function agentActivity(m)')),
);
const taskListSource = app.slice(
  app.indexOf('function taskListState(m)'),
  app.indexOf('function renderSessionBars()', app.indexOf('function taskListState(m)')),
);

let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sourceWindow(source: string, needle: string, chars = 700): string {
  const idx = source.indexOf(needle);
  return idx < 0 ? '' : source.slice(idx, idx + chars);
}

function guardedFetch(needle: string, method: 'POST' | 'PATCH' | 'DELETE'): boolean {
  const src = sourceWindow(app, needle);
  return src.includes(`method: '${method}'`) && src.includes('tokenHeader()');
}

check(
  'broker exposes dynamic creatable-agent metadata',
  broker.includes('canCreateSession:') && broker.includes('typeof b.createSession') && broker.includes('b.canCreateSession'),
);
check(
  'broker serves no-build client assets without stale browser caching',
  broker.includes("rel === 'index.html' || rel === 'app.js'") &&
    broker.includes("headers.set('cache-control', 'no-store')"),
);
check(
  'broker WebSocket stopgap separates inbound limits from outbound history backpressure',
  broker.includes('HISTORY_WEBSOCKET_OPTIONS') &&
    broker.includes('websocket send dropped') &&
    wsLimits.includes('const WS_INBOUND_MAX_BYTES = 32 * 1024 * 1024') &&
    wsLimits.includes('const WS_OUTBOUND_BACKPRESSURE_BYTES = 256 * 1024 * 1024') &&
    wsLimits.includes('closeOnBackpressureLimit: true') &&
    wsLimits.includes('perMessageDeflate: true'),
);
check(
  'broker-injected artifact replay is version-aware and not count-capped',
    hub.includes('Do not') &&
    hub.includes('count-cap this list') &&
    hub.includes('path alone') &&
    hub.includes('artifactStore?.copyFile') &&
    hub.includes('artifactKey: artifactKeyFor(rel, opts?.fingerprint') &&
    hub.includes('artifactStore.putBytes') &&
    hub.includes('contentHash') &&
    !hub.includes('MAX_ARTIFACTS') &&
    !hub.includes('this.artifacts.shift()'),
);
check(
  'app artifact cards upsert by artifact identity before path',
  app.includes('function artifactIdentity(m)') &&
    app.includes('m.artifactKey || m.contentHash || m.path') &&
    app.includes('function artifactDomId(m)') &&
    app.includes('artifactDomId(m)') &&
    app.includes('regenerated reports can reuse') &&
    app.includes('docs/architecture/client-ui.md'),
);
check(
  'history cache negotiates cursors and artifact references over WebSocket',
  core.includes('export interface HistoryQuery') &&
    core.includes("artifactMode?: 'inline' | 'reference'") &&
    broker.includes('artifactMode') &&
    broker.includes('publicBrokerUrl') &&
    broker.includes('historyDelta(durableHistory, since)') &&
    broker.includes('derivedHistory') &&
    broker.includes('isCursorDurableMessage') &&
    broker.includes('const artifact = path.match') &&
    broker.includes('const clearCache = path.match') &&
    historyDelta.includes('export function isCursorDurableMessage') &&
    historyDelta.includes('function decodeCursor') &&
    historyDelta.includes('messages.slice(cursor.n)') &&
    historyDelta.includes('reset: false') &&
    historyDelta.includes('reset: true'),
);
check(
  'broker artifact store uses content-addressed blobs and signed expiring fetch URLs',
  artifactStore.includes("join(root, 'artifacts', 'blobs')") &&
    artifactStore.includes('createHmac') &&
    artifactStore.includes('SIGNATURE_TTL_MS') &&
    artifactStore.includes('signedUrl') &&
    artifactStore.includes('timingSafeEqual') &&
    artifactStore.includes('positiveNumber') &&
    artifactStore.includes('clearSession') &&
    artifactStore.includes('removeUnreferenced') &&
    artifactStore.includes('const removed: ArtifactRecord[]') &&
    artifactStore.includes('sweep()'),
);
check(
  'app caches session history locally and requests deltas on attach',
  app.includes("const CACHE_DB_NAME = 'cosyncing-history-cache'") &&
    app.includes("createObjectStore('sessions'") &&
    app.includes("createObjectStore('artifacts'") &&
    app.includes('function mergeCachedMessages') &&
    app.includes('function saveSessionCache') &&
    app.includes('CACHE_MAX_BYTES') &&
    app.includes('CACHE_MAX_AGE_MS') &&
    app.includes('function enforceLocalCacheRetention') &&
    app.includes('function idbDeleteWhere') &&
    app.includes('sessionKey: currentCacheKey') &&
    app.includes("params.set('artifactMode', 'reference')") &&
    app.includes("params.set('since', currentHistoryCursor)") &&
    app.includes('m.reset !== false') &&
    html.includes('id="clearSessionCache"') &&
    html.includes('id="clearAllCache"'),
);
check(
  'app lazy-renders artifact refs through IndexedDB-backed blob fetches',
  app.includes('function renderLazyArtifact') &&
    app.includes('function hydrateArtifact') &&
    app.includes('function fetchArtifactBlob') &&
    app.includes('function canPrefetchArtifact') &&
    app.includes('saveData') &&
    app.includes("if (live || m.message?.type === 'file-artifact')") &&
    app.includes("if (m.type === 'error') return ['error', stableTextHash") &&
    app.includes('function errorNote(text)') &&
    app.includes('ARTIFACT_PREFETCH_BYTES') &&
    app.includes('URL.createObjectURL') &&
    app.includes('loadArtifactBlob') &&
    app.includes('saveArtifactBlob') &&
    html.includes('.art-actions') &&
    html.includes('.art-status'),
);
check(
  'interactive HTML artifacts keep broker CSP and forward bridge events through the authenticated stream',
  artifactStore.includes('function injectCosyncingBridge') &&
    artifactStore.includes("content-security-policy") &&
    artifactStore.includes("default-src 'none'") &&
    artifactStore.includes("connect-src 'none'") &&
    artifactStore.includes('cosyncing-artifact-interaction') &&
    artifactStore.includes('window.location.origin') &&
    !artifactStore.includes("postMessage({ type: 'cosyncing-artifact-interaction', artifactKey, interaction }, '*')") &&
    app.includes('function renderInteractiveHtmlArtifact') &&
    app.includes("f.sandbox = 'allow-scripts allow-forms'") &&
    app.includes('window.addEventListener') &&
    app.includes("kind: 'artifact-interaction'") &&
    app.includes('sourceFrame') &&
    app.includes('sameSession(current, meta.session)') &&
    broker.includes("msg.kind === 'artifact-interaction'") &&
    broker.includes('artifactInteractionPrompt'),
);
check('new session posts to the selected tool', app.includes('/api/sessions/${encodeURIComponent(tool)}'));
check('new session no longer hardcodes OpenCode', !app.includes("fetch('/api/sessions/opencode'") && !app.includes('fetch("/api/sessions/opencode"'));
check('new session dialog has agent/title/directory controls', ['id="newAgent"', 'id="newDirectory"', 'id="newSessionTitle"', 'id="newCreate"'].every((s) => html.includes(s)));
check('new session has old-broker creatable fallback', app.includes('supportsLiveAttach') && app.includes('createCapabilityKnown'));
check(
  'new session directories default to home and relative paths resolve from home',
    broker.includes('function normalizeCreateDirectory') &&
    broker.includes('return os.homedir()') &&
    broker.includes('resolve(os.homedir(), expanded)') &&
    app.includes('dir.value = projectDirectory') &&
    app.includes("$('#newSession').onclick = () => void newSession()") &&
    html.includes('Empty = home'),
);
check(
  'created drivable sessions reopen in Drive mode',
  broker.includes('function createdSessionAttachMode') &&
    broker.includes("return 'resume'") &&
    app.includes('function newSessionAttachMode') &&
    app.includes("attach(d.session, d.attachMode || newSessionAttachMode(d.session))"),
);
check('roster has search/filter controls and stable list container', ['id="sessionSearch"', 'id="statusFilter"', 'id="agentFilter"', 'id="activityFilter"', 'id="olderThanDays"', 'id="rosterList"'].every((s) => html.includes(s)));
check(
  'roster shows a real loading indicator before sessions arrive',
  html.includes('class="loadingState"') &&
    html.includes('class="spinner"') &&
    html.includes('skeletonList') &&
    app.includes('function loadingRosterHtml()') &&
    app.includes('rosterList.innerHTML = loadingRosterHtml()'),
);
check(
  'session attach shows a transcript loading indicator until history arrives',
  app.includes('function sessionLoadingHtml') &&
    app.includes('id="sessionLoading"') &&
    app.includes('thread.innerHTML = sessionLoadingHtml(s)') &&
    app.includes('function clearTransientThreadState') &&
    app.includes("showEmptyThreadNote('No messages yet.')") &&
    html.includes('#thread .sessionLoading'),
);
check('projects default closed and explicitly opened', app.includes('const openProjects = new Set()') && app.includes('const open = openProjects.has(project.key)') && app.includes('if (open)'));
check('project status propagates from child sessions', ['function projectStatus', 'function projectStatusLabel', 'projectStatus'].every((s) => app.includes(s)));
check('project ranking prioritizes state then latest activity', app.includes('projectRank(a) - projectRank(b) || latestTime(b) - latestTime(a)'));
check('roster filters session fields', app.includes('function sessionPassesFilters') && app.includes('function sessionMatches') && app.includes('function activityMatches'));
check(
  'left roster displays terminal-sync state only on session rows',
  app.includes('function isTerminalSynced') &&
    app.includes('rowSync syncBadge') &&
    html.includes('.syncBadge') &&
    !app.includes('function projectHasSync') &&
    !app.includes('projectSync syncBadge') &&
    !app.includes('One or more sessions are synced with terminal'),
);
check(
  'plan lifecycle actions are semantic frames guarded by broker prompt/mutation gates',
  core.includes('export interface PlanActionInput') &&
    core.includes("export type PlanAction = 'approve' | 'edit' | 'exit'") &&
    core.includes('semantic?: PlanSemantic') &&
    core.includes('respondPlan?(input: PlanActionInput)') &&
    app.includes("kind: 'plan-action'") &&
    !app.includes('function isPlanTaskList') &&
    app.includes('planRevision: list.semantic.revision') &&
    app.includes('function planActions(list)') &&
    app.includes('function planEditDialog(list)') &&
    app.includes("toast(action === 'approve' ? 'Plan approved'") &&
    broker.includes("kind === 'prompt' || kind === 'file' || kind === 'command' || kind === 'plan-action' || kind === 'artifact-interaction'") &&
    broker.includes("kind === 'prompt' || kind === 'file' || kind === 'approve' || kind === 'answer' || kind === 'reject-question' || kind === 'command' || kind === 'plan-action' || kind === 'artifact-interaction'") &&
    broker.includes("msg?.kind === 'prompt' || msg?.kind === 'plan-action' || msg?.kind === 'artifact-interaction'") &&
    broker.includes('validatePlanActionRequest(msg, current)') &&
    broker.includes('if (mc.conn.respondPlan) await mc.conn.respondPlan(input)') &&
    broker.includes('function planActionPrompt') &&
    broker.includes('Plan approved in ${PRODUCT_IDENTITY.productName}') &&
    broker.includes('Plan revised in ${PRODUCT_IDENTITY.productName}') &&
    broker.includes('Exit planning mode in ${PRODUCT_IDENTITY.productName}'),
);
check(
  'assistant markdown renders tables and language-labelled highlighted code',
  app.includes('function renderMdTableBlock') &&
    app.includes('class="md-table"') &&
    app.includes('function splitMdTableRow') &&
    app.includes('function codeLangAttr') &&
    app.includes('data-lang=') &&
    html.includes('.msg.assistant .tableWrap') &&
    html.includes('table.md-table') &&
    html.includes('--code-keyword') &&
    html.includes('pre.cb[data-lang]::before'),
);
check(
  'session rename/fork and project rename are broker-backed through optional native hooks',
    core.includes('projectName?: string') &&
    core.includes('renameSession?') &&
    core.includes('forkSession?') &&
    core.includes('cloneSession?') &&
    broker.includes('SessionMetadataStore') &&
    broker.includes('backend.renameSession') &&
    broker.includes('backend.forkSession') &&
    broker.includes('backend.cloneSession') &&
    broker.includes('await backend.renameSession(id, title)') &&
    broker.includes('await backend.forkSession(id, { messageId })') &&
    broker.includes('await backend.cloneSession(id)') &&
    broker.includes('canFork: typeof b.forkSession') &&
    broker.includes('canRenameNative: typeof b.renameSession') &&
    broker.includes('/api/projects/rename') &&
    broker.includes('/rename') &&
    broker.includes('/fork') &&
    broker.includes('/clone') &&
    broker.includes('decorateSession(ev.info)') &&
    app.includes('function requestSessionRename') &&
    app.includes('function requestSessionFork') &&
    app.includes('function requestProjectRename') &&
    // Fork is a command-surface action (maintainer §4.6): the ⎇ session-meta button was removed. The hook,
    // route, and canFork flag remain (asserted above), but no fork button/title/glyph is rendered.
    !app.includes("'renameAction fork'") &&
    !app.includes('Fork session') &&
    !app.includes('⎇') &&
    app.includes("$('#sessionMeta')") &&
    html.includes('id="sessionMeta"') &&
    app.includes('Rename session') &&
    app.includes('Rename project'),
);
check(
  'session rows omit repeated cwd from row metadata',
  app.includes("const meta = [s.offlineCached ? 'cached read-only' : agentInfos[s.tool]?.displayName || s.tool, s.model]"),
);
check(
  'settings menu exposes managed-runtime policy + global recovery + display prefs (no global control-mode picker — D17)',
  html.includes('id="settingsButton"') &&
    html.includes('id="settingsMenu"') &&
    // D17: the global Observe+Drive-vs-True-Sync <select id="controlMode"> is GONE.
    !html.includes('id="controlMode"') &&
    !html.includes('value="observe-drive"') &&
    !html.includes('value="true-sync-terminal"') &&
    // D23: per-agent Codex sync enabler toggle replaces it. Packaged v1 exposes no Claude hook control.
    html.includes('id="codexSyncToggle"') &&
    !html.includes('id="claudeHooksToggle"') &&
    !app.includes('/api/claude/hooks') &&
    html.includes('id="runtimeUpdateBadge"') &&
    html.includes('id="runtimeUpdates"') &&
    html.includes('id="codexUpdatePolicy"') &&
    html.includes('id="managedRuntimeOwnershipNotice"') &&
    html.includes('id="runtimeStatusList"') &&
    html.includes('id="refreshRuntimeStatus"') &&
    html.includes('id="toolDisplayMode"') &&
    html.includes('value="responsive"') &&
    html.includes('value="collapsed"') &&
    html.includes('value="final-only"') &&
    html.includes('id="newProjectContext"') &&
    app.includes('class="renameAction projectNew"') &&
    app.includes('newSession({ directory: project.cwd, projectName: project.name })') &&
    html.includes('id="themeSelect"') &&
    html.includes('id="languageSelect"') &&
    html.includes('id="tokdashUrl"') &&
    html.includes('id="refreshTokdashUsage"') &&
    html.includes('id="tokdashUsageStatus"') &&
    html.includes('id="transportDemoSettings"') &&
    html.includes('id="runTransportDemo"') &&
    html.includes('id="transportDemoMessage"') &&
    html.includes('id="transportDemoStatus"') &&
    html.includes('id="transportContractJson"') &&
    html.includes('http://127.0.0.1:55423') &&
    html.includes('id="restartEverything"') &&
    html.includes('Restart everything') &&
    html.includes('id="controlState"') &&
    // D1/FU-1: ONE auto-routed control button; the two physical drive/sync buttons are collapsed away.
    html.includes('id="control"') &&
    !html.includes('id="drive"') &&
    !html.includes('id="sync"') &&
    // the single control button is actually STYLED (no unstyled-default-button regression), and the old
    // per-button rules are gone (dead CSS).
    html.includes('#composer button#control') &&
    html.includes('button#control[data-kind="sync"]') &&
    !html.includes('#composer button#drive') &&
    !html.includes('#composer button#sync') &&
    !app.includes('const CONTROL_PREF_KEY') &&
    !app.includes('function changeControlPreference') &&
    !app.includes('function refreshBrokerControlMode') &&
    !app.includes('function setControlPreference') &&
    !app.includes('/api/broker/control-mode') &&
    app.includes('const TOOL_DISPLAY_PREF_KEY') &&
    app.includes('const THEME_PREF_KEY') &&
    app.includes('const LANGUAGE_PREF_KEY') &&
    app.includes('const TOKDASH_URL_KEY') &&
    app.includes('function initSettingsMenu()') &&
    app.includes('function toggleCodexSync') &&
    app.includes('function refreshRuntimeUpdates') &&
    app.includes('function refreshCodexUpdatePolicy') &&
    app.includes('function changeCodexUpdatePolicy') &&
    // Restored 2026-07-11 (maintainer): per-runtime Restart-now + always-on status list + fresh re-probe.
    app.includes('function requestRuntimeRestart') &&
    app.includes('function renderRuntimeStatusList') &&
    app.includes("fresh ? '?fresh=1' : ''") &&
    app.includes('/api/agent-runtime-updates/${encodeURIComponent(update.agent)}/restart') &&
    app.includes("fetch('/api/agent-runtime-update-policy'") &&
    app.includes("fetch('/api/agents/codex/sync'") &&
    app.includes('function requestRestartEverything') &&
    app.includes('function refreshTokdashUsage') &&
    app.includes('/api/tokdash/usage?base=') &&
    app.includes('function parseTokdashUsage') &&
    app.includes('function runTransportDemo') &&
    app.includes('/api/transport/pairings') &&
    app.includes('/accept') &&
    app.includes('/api/transport/peers/') &&
    app.includes('/api/transport/envelopes') &&
    app.includes('/api/transport/session-control') &&
    app.includes('cosyncing-secure-transport-v1') &&
    app.includes('transportContractJson') &&
    app.includes('x-cosyncing-to-token') &&
    app.includes('x-cosyncing-peer-token') &&
    app.includes('x-cosyncing-wire-kind') &&
    app.includes('senderSignature') &&
    app.includes('cipher-envelope') &&
    app.includes('/api/broker/restart-all') &&
    app.includes('confirmRestart: true') &&
    app.includes('function waitForBrokerRestart') &&
    // D17: control-mode endpoint deleted from the broker; the retained restart machinery + per-agent
    // Codex enabler remain.
    !broker.includes("path === '/api/broker/control-mode'") &&
    broker.includes("path === '/api/agents/codex/sync'") &&
    broker.includes("path === '/api/agent-runtime-updates'") &&
    broker.includes("url.searchParams.get('fresh') === '1'") &&
    broker.includes("path === '/api/agent-runtime-update-policy'") &&
    broker.includes("/^\\/api\\/agent-runtime-updates\\/([^/]+)\\/restart$/") &&
    broker.includes("path === '/api/broker/restart'") &&
    broker.includes("path === '/api/broker/restart-all'") &&
    broker.includes('selected Codex update policy') &&
    !broker.includes('daemon proves thread/loaded/list empty') &&
    broker.includes('function scheduleBrokerControlModeRestart') &&
    broker.includes('function relaunchBrokerForControlMode') &&
    broker.includes('function scheduleBrokerRestart') &&
    broker.includes("path === '/api/tokdash/usage'") &&
    broker.includes('COSYNCING_TOKDASH_URL') &&
    broker.includes('http://127.0.0.1:55423') &&
    broker.includes('detached: true') &&
    broker.includes('child.unref()') &&
    broker.includes('COSYNCING_CODEX_SYNC_SERVER') &&
    app.includes('function setToolDisplayMode') &&
    app.includes('function setThemePreference') &&
    app.includes('function controlFor(s)') &&
    app.includes('function canSendFromControl(s)') &&
    app.includes('function requestSync(s)'),
);
check(
  'tokened deployments keep app mutation fetches and WebSocket stream authenticated',
  app.includes('const BROKER_TOKEN_KEY') &&
    app.includes('function tokenHeader()') &&
    app.includes("'x-cosyncing-token'") &&
    guardedFetch("fetch('/api/broker/restart-all'", 'POST') &&
    guardedFetch("const res = await fetch('/api/agents/codex/sync', {", 'POST') &&
    sourceWindow(app, 'async function changeCodexUpdatePolicy', 2400).includes("method: 'POST'") &&
    sourceWindow(app, 'async function changeCodexUpdatePolicy', 2400).includes('tokenHeader()') &&
    guardedFetch('/cache`, { method:', 'DELETE') &&
    guardedFetch('/rename`,', 'PATCH') &&
    guardedFetch('/fork`,', 'POST') &&
    guardedFetch("fetch('/api/projects/rename'", 'PATCH') &&
    guardedFetch('fetch(`/api/sessions/${encodeURIComponent(tool)}`', 'POST') &&
    app.includes("params.set('token', t)") &&
    app.includes('const conn = new WebSocket(url)') &&
    broker.includes('const mutating =') &&
    broker.includes("url.searchParams.get('token')?.trim()") &&
    broker.includes('safeCredentialEqual(TOKEN, sharedToken)') &&
    broker.includes('CLAUDE_HOOKS_DEV_ENABLED') &&
    broker.includes("path.startsWith('/pi/bridge/')") &&
    broker.includes('/stream$'),
);
check(
  'Codex sync enabler is per-agent and confirms the post-restart broker (no global control-mode flow — D15/D16/FU-3)',
  app.includes('async function waitForBrokerRestart(expected = null)') &&
    app.includes('body.codexSyncServer !== expected.codexSyncServer') &&
    app.includes('waitForBrokerRestart({ codexSyncServer: next })') &&
    app.includes("fetch('/api/agents/codex/sync'") &&
    !app.includes('setControlPreference') &&
    !app.includes('changeControlPreference'),
);
check(
  'composer gates input from SessionInfo.control without attachMode fallback',
  app.includes('docs/architecture/client-ui.md') &&
    app.includes('if (s.control && s.control.drive && s.control.terminalSync) return s.control') &&
    app.includes('function mergeSessionInfo(previous, incoming)') &&
    app.includes('attach frame drops optional control metadata') &&
    app.includes('missing control means read-only/unavailable') &&
    app.includes('function canMutateCurrentSession()') &&
    app.includes('driving = canSendFromControl(info)') &&
    app.includes('driving = canSendFromControl(s)') &&
    !app.includes("driving = mode === 'resume'") &&
    !app.includes("driving = mode === 'live'") &&
    !app.includes('transportDriving') &&
    !app.includes('transportSynced') &&
    !app.includes("driving = !!m.info.attachMode && m.info.attachMode !== 'observe'"),
);
check(
  'one auto-routed #control button: active sync wins, then driving, then sync-available, then take-over (D1/FU-1)',
  app.includes('function controlAction(s)') &&
    app.includes("$('#control').onclick") &&
    app.includes('function terminalSyncRoute(sync)') &&
    app.includes("route === 'handoff'") &&
    app.includes("label: '💻 Open in terminal (optional)'") &&
    app.includes('function terminalDrivingStatus(s, sync)') &&
    app.includes("terminalSyncPresenceHint(s, sync)") &&
    app.includes('if (sync.active)') &&
    app.includes("text = sync.label || 'Synced with terminal'") &&
    app.includes("text = 'Driving in app'") &&
    app.includes('title = terminalDrivingStatus(current, sync)') &&
    app.includes("text = 'Sync available'") &&
    app.includes("return { kind: 'sync'") &&
    app.includes("return { kind: 'takeover'") &&
    // distinct actions, never two physical buttons
    !app.includes("$('#drive').onclick") &&
    !app.includes("$('#sync').onclick"),
);
check(
  'no legacy no-sync drive-behind notice path remains',
  !app.includes('appCreatedSessionKeys') &&
    !app.includes('maybeShowOutOfSyncNoticeAfterPrompt') &&
    !app.includes('Your terminal session is now behind this one'),
);
check(
  'terminal sync setup dialog stays adapter-provided and concise',
  app.includes('function terminalCommandHint(sync)') &&
    app.includes("`Run this in a terminal:\\n${sync.command}`") &&
    !app.includes('True sync only works when the terminal connects through this shared mode') &&
    !app.includes('Existing plain terminal sessions may remain observe-only'),
);
check(
  'terminal sync control changes push session frames without waiting for roster poll',
  core.includes('watchSessionInfo?') &&
    hub.includes('refreshExternalSession') &&
    hub.includes('replaceConnection(conn)') &&
    broker.includes('backend.watchSessionInfo') &&
    app.includes('function updateLocalRosterSession') &&
    app.includes('updateLocalRosterSession(info)'),
);
check(
  'open session control is refreshed from roster updates and stale sockets are ignored',
  app.includes('let attachSeq = 0') &&
    app.includes('const attachToken = ++attachSeq') &&
    app.includes('function sameSession(a, b)') &&
    app.includes('function syncCurrentFromRoster(sessions)') &&
    app.includes('syncCurrentFromRoster(sessions)') &&
    app.includes('const isActiveAttach = () => attachToken === attachSeq && ws === conn && sameSession(current, s)') &&
    app.includes('if (!sameSession(m.info, s)) return') &&
    app.includes('function refreshCurrentSessionUi()'),
);
check(
  'session attach loading clears on socket failure',
  app.includes('const failAttachLoading = (message)') &&
    app.includes('Could not open this session. Check broker connection and retry.') &&
    app.includes('Connection error while opening this session.'),
);
check(
  'observe-mode pending input cards are rendered read-only',
  app.includes('docs/architecture/client-ui.md') &&
    app.includes('const readOnly = !!m.readOnly || !driving') &&
    app.includes('data-pending-input="actionable"') &&
    app.includes('function refreshPendingInputActionState()') &&
    app.includes("ws && ws.send(JSON.stringify({ kind: 'approve'") &&
    app.includes("ws && ws.send(JSON.stringify({ kind: 'answer'") &&
    app.includes("if (!canMutateCurrentSession()) { blockReadOnlyAction('Approval'); return; }") &&
    app.includes("if (!canMutateCurrentSession()) { blockReadOnlyAction('Question answer'); return; }") &&
    app.includes('function resolveQuestion(id)') &&
    app.includes('if (el) el.remove();') &&
    app.includes('Read-only observe view') &&
    app.includes('b.disabled = readOnly') &&
    app.includes('custom.disabled = readOnly'),
);
check(
  'read-only observe mutation is blocked at UI and broker send boundaries',
  broker.includes('function canMutateSession') &&
    broker.includes('function isMutatingClientMessage') &&
    broker.includes('read-only observe session') &&
    broker.includes('validateRequestedPermissionMode') &&
    broker.includes('permissionMode, // exact adapter-advertised') &&
    app.includes("if (!canMutateCurrentSession()) { blockReadOnlyAction('Prompt command'); return; }") &&
    app.includes("blockReadOnlyAction('Prompt input')") &&
    app.includes("blockReadOnlyAction('Interrupt')") &&
    app.includes("blockReadOnlyAction('File upload')") &&
    app.includes("blockReadOnlyAction('Agent command')") &&
    html.includes('.perm.readonly .acts { display: none; }') &&
    // Pickers gate on PROMPT capability (an answer-only sync can answer cards but can't inject /model or
    // /mode); the composer/send/file/interrupt still gate on send-or-answer capability (canMutateCurrentSession).
    app.includes('const editable = !!driving && !!current && canPromptFromControl(current)'),
);
check(
  'explicit send_file targets active drive/live connection before observe fallback',
  /getConn\(tool: string, id: string\)[\s\S]*this\.key\(tool, id, 'resume'\)[\s\S]*this\.key\(tool, id, 'live'\)[\s\S]*this\.key\(tool, id\)/.test(readFileSync(join(ROOT, 'packages/typescript/broker/src/hub.ts'), 'utf8')),
);
check(
  'transcript autoscroll respects user scroll position',
  app.includes('let threadPinnedToBottom = true') &&
    app.includes("thread.addEventListener('scroll', updateThreadPinnedToBottom") &&
    app.includes('function restoreThreadScroll(wasPinned, previousTop)') &&
    /function scroll\(force = false\)[\s\S]*if \(!force && !threadPinnedToBottom\) return;[\s\S]*thread\.scrollTop = thread\.scrollHeight;/.test(app) &&
    (app.match(/thread\.scrollTop = thread\.scrollHeight/g) || []).length === 1,
);
check(
  'working-to-idle sessions show a review notice that clears on attach',
  app.includes('const reviewSessionKeys = new Set()') &&
    app.includes('function updateReviewNotices(sessions)') &&
    app.includes("prev === 'working' && status === 'idle'") &&
    app.includes('projectHasReview(project)') &&
    app.includes("reviewSessionKeys.delete(sessionKey(s))") &&
    app.includes('review-ready') &&
    html.includes('.reviewDot'),
);
check(
  'active goal and background work bars are generic canonical UI',
  core.includes("type: 'goal-state'") &&
    core.includes("'goal-state'") &&
    app.includes("case 'goal-state'") &&
    app.includes('function goalState(m, live)') &&
    (app.match(/function goalState\(m, live\)/g) || []).length === 1 &&
    app.includes('function goalTerminalNote(m, key)') &&
    app.includes("if (m.status === 'cleared' || m.status === 'active') return;") &&
    app.includes("m.startedAt ?? ''") &&
    !app.includes("m.elapsedMs ?? '', m.detail || ''") &&
    app.includes("'Pursuing goal'") &&
    app.includes("'Goal achieved'") &&
    app.includes('function goalBarActions(bar)') &&
    app.includes('frozenElapsedMs') &&
    html.includes('.livebar.goal.paused') &&
    html.includes('.baractions') &&
    app.includes('function activitySessionBar(m)') &&
    app.includes('activitySessionBar(m)') &&
    app.includes("m.kind === 'workflow' ? 'Background workflow' : 'Background agent'") &&
    app.includes("if (m.status !== 'running')") &&
    agentActivitySource.includes("document.getElementById('act-' + m.key)?.remove()") &&
    !agentActivitySource.includes('thread.append') &&
    app.includes('resetSessionBars()') &&
    html.includes('id="sessionBars"') &&
    html.includes('.livebar.goal') &&
    html.includes('.livebar.activity'),
);
check(
  'session statusline exposes model mode runtime token and context telemetry',
  html.includes('id="statusline"') &&
    html.includes('id="statusModel"') &&
    html.includes('id="statusEffort"') &&
    html.includes('id="statusAgent"') &&
    html.includes('id="statusMode"') &&
    html.includes('id="runtimeMeter"') &&
    html.includes('id="tokmeter"') &&
    html.includes('id="contextMeter"') &&
    html.includes('.statusline') &&
    app.includes('docs/architecture/client-ui.md') &&
    app.includes('function renderStatusline()') &&
    app.includes('function metadataUpdate(m)') &&
    app.includes("m.key === 'contextUsage'") &&
    app.includes("m.key === 'runtimeTotals'") &&
    app.includes('function updateRuntimeFromStatus(status)') &&
    app.includes("case 'run-summary'") &&
    app.includes('function runSummary(m)') &&
    app.includes("parts.push('finished ' + finished)") &&
    app.includes('function renderUserBubble(el, text, m)') &&
    app.includes('latestTokenCount = m') &&
    app.includes('latestRuntimeTotals') &&
    html.includes('.msg.assistant .runmeta') &&
    html.includes('.msg.user .msgtime') &&
    app.includes('mp.disabled = !editable || !serverModels.length') &&
    app.includes('dp.disabled = !editable || !serverModes.length'),
);
check(
  'task-list-state has generic canonical UI scaffold',
  core.includes("type: 'task-list-state'") &&
    core.includes("'task-list-state'") &&
    app.includes("case 'task-list-state'") &&
    app.includes('const taskLists = new Map()') &&
    app.includes('function taskListState(m)') &&
    app.includes('function renderTaskList(list, openState)') &&
    taskListSource.includes("if (m.status === 'cleared')") &&
    taskListSource.includes("taskLists.set(key") &&
    taskListSource.includes("details.className = 'tasklist ' + list.status") &&
    app.includes('row.append(renderTaskList(list, taskOpen.get(list.key)))') &&
    html.includes('.tasklist') &&
    html.includes('.tl-summary') &&
    html.includes('.tl-active') &&
    html.includes('.tl-group-title'),
);
check(
  'permission mode options expose universal product categories',
  core.includes("category?: 'ask-permission' | 'approve-for-me' | 'full-access' | 'custom'") &&
    app.includes("if (!canChangePicksCurrentSession()) { blockReadOnlyAction('Permission mode'); return; }") &&
    app.includes('const haveModes = !!current && (serverModes.length > 0 || !!selectedMode || !!current.currentMode)') &&
    app.includes('dp.disabled = !editable || !serverModes.length') &&
    app.includes('prompt-like commands/skills share explicit per-turn overrides') &&
    broker.includes('validateRequestedPermissionMode') &&
    clientMessagePolicy.includes("'PERMISSION_MODE_UNSUPPORTED'") &&
    core.includes('export type CommandInput = Pick<PromptInput'),
);
check(
  'model picker preserves optional model variants',
  core.includes('variant?: string') &&
    app.includes('function modelVariantKey(variant)') &&
    app.includes('let selectedModelDirty = false') &&
    app.includes('if (info.currentModel && !selectedModelDirty) selectedModel = info.currentModel') &&
    app.includes('if (selectedModel && selectedModelDirty) msg.model = selectedModel') &&
    app.includes('modelVariantKey(x.variant) === modelVariantKey(selectedModel.variant)') &&
    app.includes('if (m.variant) selectedModel.variant = m.variant') &&
    app.includes('selectedModelDirty = true') &&
    app.includes("desc: [m.modelID, modelVariantKey(m.variant)].filter(Boolean).join(' · ')"),
);

check(
  'scheduled message visibility uses stable-id cards, canonical refreshes, and revision-aware mutations',
  app.includes('const pendingSchedules = new Map()') &&
    app.includes('function reconcilePendingScheduleCards') &&
    app.includes('s.tool === current.tool') &&
    app.includes('s.sessionId === current.id') &&
    app.includes("s.kind === 'message'") &&
    app.includes("s.state === 'scheduled'") &&
    app.includes('function refreshPendingSchedules') &&
    app.includes('function ownsScheduleRequest') &&
    app.includes('SCHEDULE_POLL_MS') &&
    app.includes('expectedRevision: scheduleRevision(edit)') &&
    app.includes('function scheduleDeleteUrl') &&
    app.includes('tokenHeader()') &&
    app.includes('function clearPendingScheduleElements') &&
    html.includes('id="scheduleText"') &&
    html.includes('.pendingSchedule'),
);

if (failed) {
  console.error(`\nFAIL: ${failed} static web UI check(s) failed.`);
  process.exit(1);
}

console.log('\nPASS');
