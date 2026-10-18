import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_SCHEMA_VERSION = 1;
const ENVIRONMENT_SCHEMA_VERSION = 1;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_GENERATIONS = 3;
const MAX_LOG_READ_BYTES = 1024 * 1024;
const RESTART_ATTEMPTS = 3;
const RESTART_INTERVAL_MS = 60_000;
const serviceRoot = dirname(fileURLToPath(import.meta.url));
const stateRoot = dirname(dirname(serviceRoot));
const versionsRoot = join(serviceRoot, 'versions');
const manifestPath = join(serviceRoot, 'active-install.json');
const logDirectory = join(stateRoot, 'logs');
const logPath = join(logDirectory, 'broker.log');

function rotateLog() {
  if (!existsSync(logPath) || statSync(logPath).size < MAX_LOG_BYTES) return;
  if (existsSync(`${logPath}.${LOG_GENERATIONS}`)) unlinkSync(`${logPath}.${LOG_GENERATIONS}`);
  for (let generation = LOG_GENERATIONS; generation >= 1; generation -= 1) {
    const source = generation === 1 ? logPath : `${logPath}.${generation - 1}`;
    if (!existsSync(source)) continue;
    renameSync(source, `${logPath}.${generation}`);
  }
}

function appendFatal(descriptor, error) {
  const message = error instanceof Error ? error.message : String(error);
  const safe = message.replace(/[\0\r\n]+/g, ' ').slice(0, 2_048);
  writeSync(descriptor, `${new Date().toISOString()} fatal-start ${safe}\n`);
}

function readJson(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label}-unreadable`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}-malformed`);
  }
  return value;
}

function activeInstall() {
  const value = readJson(manifestPath, 'active-install');
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION
      || typeof value.installationId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.installationId)
      || typeof value.versionKey !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.versionKey)
      || Object.keys(value).some((key) => !['schemaVersion', 'installationId', 'versionKey'].includes(key))) {
    throw new Error('active-install-malformed');
  }
  return value;
}

function serviceEnvironment(path) {
  const value = readJson(path, 'service-environment');
  if (value.schemaVersion !== ENVIRONMENT_SCHEMA_VERSION
      || !value.variables || typeof value.variables !== 'object' || Array.isArray(value.variables)
      || Object.keys(value).some((key) => !['schemaVersion', 'variables'].includes(key))) {
    throw new Error('service-environment-malformed');
  }
  const variables = {};
  const names = new Set();
  for (const [name, entry] of Object.entries(value.variables)) {
    const folded = name.toLowerCase();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || names.has(folded)
        || typeof entry !== 'string' || /[\0\r\n]/.test(entry)) {
      throw new Error('service-environment-malformed');
    }
    names.add(folded);
    variables[name] = entry;
  }
  return variables;
}

function mergeEnvironment(base, overrides) {
  const merged = { ...base };
  const overrideNames = new Set(Object.keys(overrides).map((name) => name.toLowerCase()));
  for (const name of Object.keys(merged)) {
    if (overrideNames.has(name.toLowerCase())) delete merged[name];
  }
  return { ...merged, ...overrides };
}

function logRequest(argv) {
  if (argv.length === 0) return undefined;
  if (argv[0] !== '--service-logs' || argv[1] !== '--lines' || !/^\d{1,5}$/.test(argv[2] ?? '')) {
    throw new Error('invalid-service-log-request');
  }
  const lines = Number(argv[2]);
  const follow = argv.length === 4 && argv[3] === '--follow';
  if (lines < 1 || lines > 10_000 || (!follow && argv.length !== 3)) {
    throw new Error('invalid-service-log-request');
  }
  return { lines, follow };
}

function readRange(descriptor, start, length) {
  if (length <= 0) return { text: '', position: start };
  const buffer = Buffer.allocUnsafe(length);
  const count = readSync(descriptor, buffer, 0, length, start);
  return { text: buffer.subarray(0, count).toString('utf8'), position: start + count };
}

async function readServiceLogs(request) {
  let identity;
  let position = 0;
  let initial = true;
  for (;;) {
    let descriptor;
    try {
      descriptor = openSync(logPath, 'r');
      // Windows file IDs can exceed Number's exact integer range. Keep their
      // full identity, and inspect/read the same open file even during rotation.
      const stat = fstatSync(descriptor, { bigint: true });
      const nextIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
      const size = Number(stat.size);
      if (identity !== nextIdentity || size < position) position = 0;
      const start = Math.max(initial ? 0 : position, size - MAX_LOG_READ_BYTES);
      const read = readRange(descriptor, start, size - start);
      let text = read.text;
      if (initial) {
        if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
        const rows = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        text = rows.slice(-request.lines).join('');
      }
      // Publish the cursor before emitting output: a caller may rotate or
      // append as soon as it receives the initial trailing lines.
      identity = nextIdentity;
      position = read.position;
      process.stdout.write(text);
    } catch (error) {
      // The name can be absent between renaming the old log and opening its
      // replacement. The next observation must still read that replacement.
      if (error?.code !== 'ENOENT') throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    initial = false;
    if (!request.follow) return;
    await Bun.sleep(250);
  }
}

/**
 * Task Scheduler launches this bootstrap with an interactive logon token, which hands a console
 * application a console window that lives exactly as long as the service does. The broker child is
 * already spawned with `windowsHide`, so this is the supervisor's own window and nothing else.
 *
 * Only the service path releases it. The log-following path below writes to stdout on purpose, because
 * an operator ran `logs` and is waiting to read it.
 *
 * Hiding precedes releasing: FreeConsole on its own can leave the window painted until conhost notices,
 * which the operator sees as a flash. A console that survives is a cosmetic fault and must never stop the
 * service from starting, so every failure here is swallowed deliberately.
 */
async function releaseServiceConsole() {
  if (process.platform !== 'win32') return;
  try {
    const { dlopen, FFIType } = await import('bun:ffi');
    const kernel32 = dlopen('kernel32.dll', {
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
      FreeConsole: { args: [], returns: FFIType.i32 },
    });
    const user32 = dlopen('user32.dll', {
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    const window = kernel32.symbols.GetConsoleWindow();
    if (window) user32.symbols.ShowWindow(window, 0);
    kernel32.symbols.FreeConsole();
  } catch {
    /* no console to release, or no FFI to release it with */
  }
}

async function runBroker() {
  await releaseServiceConsole();
  rotateLog();
  const log = openSync(logPath, 'a', 0o600);

  try {
    let exitCode = 1;
    for (let attempt = 0; attempt <= RESTART_ATTEMPTS; attempt += 1) {
      try {
        const active = activeInstall();
        const versionRoot = join(versionsRoot, active.versionKey);
        const applicationPath = join(versionRoot, 'cosyncing');
        const environmentPath = join(versionRoot, 'environment.json');
        const environment = serviceEnvironment(environmentPath);
        const childEnvironment = mergeEnvironment(process.env, {
          ...environment,
          COSYNCING_SERVICE_PROVIDER: 'task-scheduler',
        });
        const child = Bun.spawn([process.execPath, applicationPath, 'broker'], {
          cwd: stateRoot,
          env: childEnvironment,
          stdin: 'ignore',
          stdout: log,
          stderr: log,
          windowsHide: true,
        });
        exitCode = await child.exited;
      } catch (error) {
        appendFatal(log, error);
        exitCode = 1;
      }
      if (exitCode === 0 || attempt === RESTART_ATTEMPTS) break;
      await Bun.sleep(RESTART_INTERVAL_MS);
    }
    process.exitCode = exitCode;
  } finally {
    closeSync(log);
  }
}

const request = logRequest(process.argv.slice(2));
if (request) await readServiceLogs(request);
else await runBroker();
