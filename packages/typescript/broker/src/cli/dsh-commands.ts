/**
 * `cosy dsh …` — enrolling a DeepSeek Harness host the operator started.
 *
 * WHY THIS COMMAND EXISTS. A 0.2 `dsh web` host authenticates every API and
 * WebSocket request with a signed cookie, and the only way to earn one is to
 * exchange the URL that host printed when it started. cosyncing can do that
 * itself for a host it starts, because it is reading that child's own output. It
 * cannot do it for a host the operator started in a terminal: that URL was
 * printed to a different process's stdout, and no amount of probing gets a
 * cookie without the token. So the operator brings the URL here, once, and the
 * cookie outlasts both processes.
 *
 * WHY A PROMPT AND NOT A FLAG. The URL contains a token that buys full control of
 * an agent host. A `--token-url` flag puts it in the process table, in shell
 * history, and in any wrapper script that logged its arguments. The URL is
 * therefore read from a hidden prompt or from stdin, and the only thing this
 * command ever writes back out is the address and an expiry.
 *
 * WHY THE FILE AND NOT THE BROKER. Enrollment writes the broker's session file
 * directly rather than calling an HTTP route, so it works while the broker is
 * down — the ordinary state of someone setting a host up for the first time. The
 * running broker picks the enrollment up on its next credential read, which is
 * why no restart is asked for.
 */

import {
  DshAuthSession,
  dshCredentialScope,
  parseDshLaunchUrl,
  resolveDshBaseUrl,
  resolveDshHome,
  DSH_DEFAULT_BASE_URL,
} from '@cosyncing/adapter-dsh';
import { homedir } from 'node:os';
import { setupStateHome } from '../installation/setup-state.ts';
import {
  clearDshCookie,
  createDshCredentialStore,
  dshSessionsPath,
  inspectDshSessions,
  loadDshCookie,
} from '../security/dsh-credentials.ts';
import type { OperatorCommandResult, OperatorWriter } from './operator-commands.ts';
import { terminalSafeText } from './operator-commands.ts';

export interface DshCommandOptions {
  invocation: string;
  stdout: OperatorWriter;
  stderr: OperatorWriter;
  json: boolean;
  home?: string;
  /** Explicit host address; otherwise `COSYNCING_DSH_BASE_URL`, otherwise the documented default. */
  baseUrl?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface DshCommandDependencies {
  /** Read the launch URL: hidden prompt on a terminal, stdin when piped. */
  readLaunchUrl?: () => Promise<string>;
  now?: () => number;
}

class DshCommandError extends Error {
  constructor(readonly detailCode: string, message: string) {
    super(message);
    this.name = 'DshCommandError';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function configuredBaseUrl(options: DshCommandOptions): string {
  if (options.baseUrl) return options.baseUrl;
  return resolveDshBaseUrl(options.env ?? process.env, DSH_DEFAULT_BASE_URL);
}

function scopeFor(options: DshCommandOptions, baseUrl: string): string {
  const env = options.env ?? process.env;
  const homeDir = env.HOME ?? env.USERPROFILE ?? homedir();
  return dshCredentialScope(baseUrl, resolveDshHome(env, homeDir));
}

function formatExpiry(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return 'no stated expiry';
  const days = Math.floor((expiresAt - now) / 86_400_000);
  if (expiresAt <= now) return 'expired';
  return days >= 1 ? `expires in ${String(days)} day${days === 1 ? '' : 's'}` : 'expires today';
}

/** Read a line from stdin, for `printf '%s' "$URL" | cosy dsh connect`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function promptLaunchUrl(): Promise<string> {
  const prompts = await import('@clack/prompts');
  const answer = await prompts.password({
    message: 'Paste the URL printed by `dsh web` (it contains a token, so it is not echoed)',
  });
  if (prompts.isCancel(answer)) throw new DshCommandError('cancelled', 'Enrollment cancelled.');
  return String(answer ?? '').trim();
}

export async function runDshConnectCommand(
  options: DshCommandOptions,
  dependencies: DshCommandDependencies = {},
): Promise<OperatorCommandResult> {
  const home = options.home ?? setupStateHome();
  const baseUrl = configuredBaseUrl(options);
  try {
    const raw = dependencies.readLaunchUrl
      ? await dependencies.readLaunchUrl()
      : process.stdin.isTTY
        ? await promptLaunchUrl()
        : await readStdin();
    if (!raw) throw new DshCommandError('no-url', 'No URL was provided. Pipe the URL printed by `dsh web`, or run this on a terminal.');
    const parsed = parseDshLaunchUrl(raw, baseUrl);
    // The store is built with the RESOLVED home, so a non-default COSYNCING_HOME
    // cannot be bypassed by an injected implementation and a credential cannot be
    // written somewhere the running broker will never look.
    const auth = new DshAuthSession({
      baseUrl,
      scope: scopeFor(options, baseUrl),
      store: createDshCredentialStore(home),
    });
    auth.adoptLaunchToken(parsed.token);
    const outcome = await auth.ensure();
    if (outcome.state !== 'authenticated') {
      throw new DshCommandError(`auth-${outcome.reason}`, outcome.detail);
    }
    const line = `cosyncing is enrolled with the DeepSeek Harness host at ${hostOf(baseUrl)}.`;
    if (options.json) {
      options.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        detailCode: 'dsh-connect-complete',
        host: hostOf(baseUrl),
        state: outcome.state,
      }, null, 2)}\n`);
    } else {
      options.stdout.write(`${line}\n${outcome.detail}\n`);
      options.stdout.write('A running broker picks this up on its next request; nothing needs restarting.\n');
    }
    return { exitCode: 0, detailCode: 'dsh-connect-complete' };
  } catch (error) {
    if (error instanceof DshCommandError) {
      options.stderr.write(`${options.invocation} dsh connect: ${error.message}\n`);
      return { exitCode: 1, detailCode: error.detailCode };
    }
    // `parseDshLaunchUrl` and the store both fail with messages written to name
    // the problem without naming the token; nothing here adds the URL back.
    const message = error instanceof Error ? error.message : 'the enrollment could not be completed';
    options.stderr.write(`${options.invocation} dsh connect: ${message}\n`);
    return { exitCode: 1, detailCode: 'dsh-connect-failed' };
  }
}

export async function runDshDisconnectCommand(
  options: DshCommandOptions,
  _dependencies: DshCommandDependencies = {},
): Promise<OperatorCommandResult> {
  const home = options.home ?? setupStateHome();
  const baseUrl = configuredBaseUrl(options);
  const scope = scopeFor(options, baseUrl);
  try {
    const removed = clearDshCookie(scope, dshSessionsPath(home));
    const message = removed
      ? `Removed cosyncing's session for the DeepSeek Harness host at ${hostOf(baseUrl)}.`
      : `cosyncing had no stored session for ${hostOf(baseUrl)}.`;
    if (options.json) {
      options.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        detailCode: removed ? 'dsh-disconnect-removed' : 'dsh-disconnect-absent',
        host: hostOf(baseUrl),
      }, null, 2)}\n`);
    } else {
      options.stdout.write(`${message}\n`);
    }
    return { exitCode: 0, detailCode: removed ? 'dsh-disconnect-removed' : 'dsh-disconnect-absent' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the session could not be removed';
    options.stderr.write(`${options.invocation} dsh disconnect: ${detail}\n`);
    return { exitCode: 1, detailCode: 'dsh-disconnect-failed' };
  }
}

export async function runDshStatusCommand(
  options: DshCommandOptions,
  dependencies: DshCommandDependencies = {},
): Promise<OperatorCommandResult> {
  const home = options.home ?? setupStateHome();
  const baseUrl = configuredBaseUrl(options);
  const scope = scopeFor(options, baseUrl);
  const now = dependencies.now?.() ?? Date.now();
  try {
    const target = dshSessionsPath(home);
    const inspection = inspectDshSessions(target);
    const stored = inspection.status === 'ok' ? loadDshCookie(scope, target) : null;
    const enrollments = inspection.status === 'ok' ? inspection.enrollments : [];
    const lines: string[] = [];
    lines.push(`Configured host: ${hostOf(baseUrl)}`);
    if (inspection.status === 'missing') lines.push('Session store: none yet. Run `cosy dsh connect` for a host you started yourself.');
    else if (inspection.status === 'ok') {
      lines.push(stored
        ? `Session for this host: present, ${formatExpiry(stored.expiresAt, now)}.`
        : 'Session for this host: none. Run `cosy dsh connect`.');
      if (enrollments.length > 1) lines.push(`Other enrollments stored: ${String(enrollments.length - 1)}.`);
    } else lines.push(`Session store: ${inspection.status} (${inspection.detailCode}). Run \`cosyncing repair\`.`);
    if (options.json) {
      options.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        detailCode: 'dsh-status-complete',
        host: hostOf(baseUrl),
        store: inspection.status,
        enrolled: stored !== null,
        enrollments: enrollments.map((entry) => ({
          scope: entry.scope,
          revision: entry.revision,
          expiresAt: entry.expiresAt ?? null,
        })),
      }, null, 2)}\n`);
    } else {
      for (const line of lines) options.stdout.write(`${terminalSafeText(line)}\n`);
    }
    return { exitCode: 0, detailCode: 'dsh-status-complete' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the session state could not be read';
    options.stderr.write(`${options.invocation} dsh status: ${detail}\n`);
    return { exitCode: 1, detailCode: 'dsh-status-failed' };
  }
}
