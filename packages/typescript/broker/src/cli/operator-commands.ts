import { parseQrPairingPayload, type QrPairingPayloadV2 } from '@cosyncing/crypto';
import { inspectBrokerConfig, type BrokerConfig } from '../runtime/configuration.ts';
import {
  brokerTokenPath,
  inspectBrokerToken,
  readBrokerToken,
} from '../security/credentials.ts';
import type { SetupDiagnosisContext } from '@cosyncing/adapter-api';
import { createSetupDiagnosisContext } from '../installation/diagnosis-context.ts';
import { inspectInstallState } from '../installation/install-state.ts';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { isDurableServiceChoice, readSetupState, setupStateHome } from '../installation/setup-state.ts';
import {
  DEFAULT_TERMINAL_COLUMNS,
  renderTerminalQr,
  terminalQrColorEnabled,
  terminalQrWidth,
} from './terminal-qr.ts';
import { SYSTEMD_SERVICE_NAME } from '../installation/service-manager.ts';
import {
  probeAdvertisedEndpointOnce,
  resolveTailscaleFallbackAddresses,
  type AdvertisedEndpointDirectProbe,
} from '../installation/tailscale-serve.ts';
import { APP_PATH } from '../transport/http-contracts.ts';

const RESPONSE_LIMIT = 256 * 1024;
const REQUEST_TIMEOUT_MS = 4_000;

export interface OperatorWriter {
  write(text: string): void;
}

export interface OperatorCommandResult {
  exitCode: number;
  detailCode: string;
}

export interface PairCommandOptions {
  json: boolean;
  wait: boolean;
  clientLabel?: string;
  home?: string;
  invocation: string;
  stdout: OperatorWriter;
  stderr: OperatorWriter;
  /**
   * Whether the operator can answer a "pair another device?" prompt after each accepted
   * device. Defaults to a real stdout TTY; never applies in `--json` mode.
   */
  interactive?: boolean;
}

export interface DevicesListCommandOptions {
  json: boolean;
  home?: string;
  invocation: string;
  stdout: OperatorWriter;
  stderr: OperatorWriter;
}

export interface DevicesRevokeCommandOptions extends DevicesListCommandOptions {
  peerId: string;
  yes: boolean;
  interactive: boolean;
}

export type OperatorFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export interface OperatorCommandDependencies {
  fetch?: OperatorFetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  renderQr?: (payload: string) => Promise<string> | string;
  /** Terminal width for the QR fit check. Defaults to the real stdout, then to 80. */
  columns?: () => number | undefined;
  confirmRevoke?: (peerId: string) => Promise<boolean>;
  confirmAnother?: (paired: number) => Promise<boolean>;
  /** Seams for the advertised endpoint's DNS-independent retry; production resolves all of this itself.
   *  Prefer supplying `diagnosisContext` over `advertisedFallbackAddresses`: the context still runs the
   *  real `tailscale status --json` resolution, so a test built on it fails if that wiring is removed. */
  diagnosisContext?: SetupDiagnosisContext;
  advertisedFallbackAddresses?: readonly string[];
  advertisedDirectProbe?: AdvertisedEndpointDirectProbe;
}

interface LocalBrokerAccess {
  home: string;
  config: BrokerConfig;
  token: string;
}

interface ApiResult {
  status: number;
  ok: boolean;
  json?: unknown;
}

class OperatorCommandError extends Error {
  constructor(
    readonly detailCode: string,
    message: string,
    readonly kind: 'configuration' | 'unreachable' | 'response' = 'response',
  ) {
    super(message);
    this.name = 'OperatorCommandError';
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function localAccess(home: string): LocalBrokerAccess {
  const installed = inspectInstallState(home);
  if (!installed.committed) {
    throw new OperatorCommandError(
      'setup-not-committed',
      `${PRODUCT_IDENTITY.productName} setup is not committed (${installed.reason}).`,
      'configuration',
    );
  }
  const config = inspectBrokerConfig(home);
  if (config.status !== 'ok') {
    throw new OperatorCommandError(
      config.status === 'missing' ? 'broker-config-missing' : config.detailCode,
      'The broker configuration is missing or unsafe.',
      'configuration',
    );
  }
  const tokenInspection = inspectBrokerToken(brokerTokenPath(home));
  if (tokenInspection.status !== 'ok') {
    throw new OperatorCommandError(
      tokenInspection.detailCode,
      'The local broker credential is missing or unsafe.',
      'configuration',
    );
  }
  return { home, config: config.config, token: readBrokerToken(tokenInspection.path) };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT) {
    throw new OperatorCommandError('broker-response-too-large', 'The broker returned an oversized response.');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > RESPONSE_LIMIT) {
    throw new OperatorCommandError('broker-response-too-large', 'The broker returned an oversized response.');
  }
  try { return text ? JSON.parse(text) : undefined; } catch {
    throw new OperatorCommandError('broker-response-malformed', 'The broker returned malformed JSON.');
  }
}

async function request(
  dependencies: OperatorCommandDependencies,
  access: LocalBrokerAccess,
  path: string,
  init: RequestInit = {},
  authenticated = true,
  baseUrl = access.config.broker.internalUrl,
): Promise<ApiResult> {
  const fetcher = dependencies.fetch ?? fetch;
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body != null) headers.set('content-type', 'application/json');
  if (authenticated) headers.set(PRODUCT_IDENTITY.tokenHeader, access.token);
  let response: Response;
  try {
    response = await fetcher(new URL(path, baseUrl), {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OperatorCommandError(
      'broker-unreachable',
      `The broker at ${baseUrl} is not reachable.`,
      'unreachable',
    );
  }
  return { status: response.status, ok: response.ok, json: await boundedJson(response) };
}

function assertBrokerHealth(result: ApiResult, access: LocalBrokerAccess, advertised: boolean): void {
  const body = object(result.json);
  if (!result.ok || body?.ok !== true || body.product !== PRODUCT_IDENTITY.productName
      || body.machine !== access.config.broker.machineLabel) {
    throw new OperatorCommandError(
      advertised ? 'advertised-broker-identity-mismatch' : 'local-broker-identity-mismatch',
      advertised
        ? 'The advertised endpoint did not return the expected cosyncing broker identity.'
        : 'The local endpoint is occupied by an unexpected or incompatible service.',
    );
  }
}

async function verifyLocalBroker(
  dependencies: OperatorCommandDependencies,
  access: LocalBrokerAccess,
): Promise<void> {
  assertBrokerHealth(await request(dependencies, access, '/api/health', {}, false), access, false);
}

async function verifyAdvertisedBroker(
  dependencies: OperatorCommandDependencies,
  access: LocalBrokerAccess,
): Promise<void> {
  const advertised = access.config.broker.advertisedUrl;
  if (!advertised || !advertised.startsWith('https://')) {
    throw new OperatorCommandError(
      'advertised-url-not-configured',
      'No private HTTPS advertised broker URL is configured.',
      'configuration',
    );
  }
  let unreachable: OperatorCommandError;
  try {
    assertBrokerHealth(
      await request(dependencies, access, '/api/health', {}, false, advertised),
      access,
      true,
    );
    return;
  } catch (error) {
    // Only a transport failure earns the retry. An identity mismatch means the endpoint answered and
    // answered wrongly, which no amount of re-routing fixes and which must stay a refusal.
    if (!(error instanceof OperatorCommandError) || error.kind !== 'unreachable') throw error;
    unreachable = error;
  }

  // The advertised NAME did not connect. Ask this node's own Tailscale addresses the same question, still
  // presenting and validating the advertised hostname, so pairing works on a host whose MagicDNS does not
  // resolve. Only the health check moves: the QR still carries the hostname, never an address literal,
  // because the paired device has to reach this broker by name from wherever it is.
  const context = dependencies.diagnosisContext ?? createSetupDiagnosisContext();
  const addresses = dependencies.advertisedFallbackAddresses
    ?? await resolveTailscaleFallbackAddresses(context);
  if (addresses.length === 0) throw unreachable;
  const probe = await probeAdvertisedEndpointOnce({
    // The name is already known to be unreachable; this context short-circuits re-asking it so the retry
    // spends its whole budget on the addresses.
    context: { ...context, fetchJson: async () => ({ status: 'unreachable' }) },
    advertisedUrl: advertised,
    fallbackAddresses: addresses,
    ...(dependencies.advertisedDirectProbe ? { directProbe: dependencies.advertisedDirectProbe } : {}),
  });
  if (probe.status === 'unreachable') throw unreachable;
  assertBrokerHealth(
    { ok: probe.status === 'ok', status: probe.statusCode ?? 0, json: probe.json },
    access,
    true,
  );
}

function pairingPayload(qr: string, pairingId: string, advertisedUrl: string): QrPairingPayloadV2 {
  const payload = parseQrPairingPayload(qr);
  if (payload.version !== 2) throw new OperatorCommandError('pairing-payload-version', 'The broker returned a non-v2 pairing QR.');
  const v2 = payload as QrPairingPayloadV2;
  const rootKeys = Object.keys(v2).sort().join(',');
  const transportKeys = Object.keys(v2.transport as unknown as Record<string, unknown>).sort().join(',');
  const rootShapeSupported = rootKeys === 'brokerId,pairingId,publicKey,transport,version'
    || rootKeys === 'broker,brokerId,pairingId,publicKey,transport,version';
  if (!rootShapeSupported
      || transportKeys !== 'kind,url'
      || v2.transport.kind !== 'tailscale-direct'
      || v2.transport.url !== advertisedUrl
      || v2.pairingId !== pairingId
      || /token|private/i.test(JSON.stringify(v2))) {
    throw new OperatorCommandError(
      'pairing-payload-invalid',
      'The broker returned a pairing QR with unexpected or private fields.',
    );
  }
  return v2;
}

async function stoppedGuidance(home: string, invocation: string): Promise<string> {
  let state;
  try { state = readSetupState(home); } catch { state = { schemaVersion: 1 as const }; }
  if (!isDurableServiceChoice(state.serviceChoice)) {
    return `Broker mode: foreground (not running). Start it with: ${invocation} broker`;
  }
  const context = createSetupDiagnosisContext();
  // `cosyncing start` drives whichever provider owns this host, so it is the guidance that stays correct on
  // both; the native probe below is best-effort colour on top of it.
  if (state.serviceChoice === 'launchd') {
    return `Broker service: launchd agent (not reachable). Start it with: ${invocation} start`;
  }
  const systemctl = context.resolveExecutable('systemctl');
  let serviceState = 'unknown';
  if (systemctl) {
    const probe = await context.runReadOnly(systemctl, ['--user', 'is-active', SYSTEMD_SERVICE_NAME]);
    serviceState = `${probe.stdout}\n${probe.stderr}`.trim().split(/\s+/)[0] || 'unknown';
  }
  return `Broker service: ${serviceState}. Start it with: systemctl --user start ${SYSTEMD_SERVICE_NAME}`;
}

async function reportFailure(
  error: unknown,
  options: { home: string; invocation: string; stderr: OperatorWriter },
): Promise<OperatorCommandResult> {
  const failure = error instanceof OperatorCommandError
    ? error
    : new OperatorCommandError('operator-command-failed', error instanceof Error ? error.message : String(error));
  let guidance = '';
  if (failure.kind === 'configuration') {
    guidance = `Run: ${options.invocation} setup`;
  } else if (failure.kind === 'unreachable') {
    guidance = await stoppedGuidance(options.home, options.invocation);
  } else {
    guidance = `Run: ${options.invocation} doctor`;
  }
  options.stderr.write(`[error] ${failure.detailCode}: ${failure.message}\n${guidance}\n`);
  return { exitCode: 1, detailCode: failure.detailCode };
}

export async function renderTerminalPairingQr(payload: string): Promise<string> {
  return renderTerminalQr(payload, {
    color: terminalQrColorEnabled({ env: process.env, tty: process.stdout.isTTY === true }),
  });
}

/**
 * Whether the symbol for `payload` fits, and the two numbers to say so with.
 *
 * The payload carries the operator's advertised MagicDNS URL, so its length — and with it the symbol size —
 * is not ours to fix. Dropping the redundant broker descriptor from the QR keeps every realistic tailnet URL
 * at 73–77 columns, but a long enough one still crosses 80. When it does, the terminal wraps the symbol into
 * something that reads as a QR to the operator and scans as nothing at all, and the operator has no way to
 * tell. Say it instead, and hand over the link the QR would have carried.
 */
function pairingQrFit(payload: string, dependencies: OperatorCommandDependencies): {
  fits: boolean;
  width: number;
  columns: number;
} {
  const reported = (dependencies.columns ?? (() => process.stdout.columns))();
  const columns = Number.isFinite(reported) && (reported as number) > 0
    ? Math.floor(reported as number)
    : DEFAULT_TERMINAL_COLUMNS;
  const width = terminalQrWidth(payload);
  return { fits: width <= columns, width, columns };
}

interface PairingOffer {
  pairingId: string;
  qr: string;
  expiresAt: string;
  expiration: number;
}

interface PairedDevice {
  peerId: string;
  label?: string;
}

/**
 * Printed once at the end of a non-`--json` `pair` invocation. Pairing already handed over a per-device,
 * revocable credential; this tells the operator where the *other* credential lives — the shared broker
 * token the web app (/cosy) prompts for directly — without ever printing its value.
 * Never called on a `--json` exit path, so the machine-readable document shape is untouched.
 */
function writeTokenGuidance(options: PairCommandOptions, home: string): void {
  const tokenPath = brokerTokenPath(home);
  options.stdout.write(`Authentication token file: ${tokenPath}\n`);
  options.stdout.write(`Read it: cat ${tokenPath}\n`);
  options.stdout.write(`The web app (${APP_PATH}) also accepts this token directly.\n`);
  options.stdout.write(
    'Paired devices get a revocable, per-device credential — prefer pairing for phones and tablets over sharing this master secret.\n',
  );
}

async function defaultConfirmAnother(paired: number): Promise<boolean> {
  const prompts = await import('@clack/prompts');
  const answer = await prompts.confirm({
    message: `Paired ${paired} device${paired === 1 ? '' : 's'}. Pair another device?`,
    initialValue: false,
  });
  return !prompts.isCancel(answer) && answer === true;
}

/** Creates one pairing offer; each offer pairs exactly one device. */
async function createPairingOffer(
  dependencies: OperatorCommandDependencies,
  access: LocalBrokerAccess,
  clientLabel: string | undefined,
  advertisedUrl: string,
): Promise<PairingOffer> {
  const created = await request(dependencies, access, '/api/transport/pairings', {
    method: 'POST',
    body: JSON.stringify({ ...(clientLabel ? { clientLabel } : {}) }),
  });
  const body = object(created.json);
  if (!created.ok || created.status !== 201 || body?.ok !== true
      || typeof body.pairingId !== 'string' || typeof body.qr !== 'string'
      || typeof body.expiresAt !== 'string' || typeof body.brokerPeerId !== 'string') {
    throw new OperatorCommandError(
      typeof body?.code === 'string' ? body.code : 'pairing-create-failed',
      typeof body?.error === 'string' ? body.error : 'The broker did not create a valid pairing offer.',
    );
  }
  pairingPayload(body.qr, body.pairingId, advertisedUrl);
  const expiration = Date.parse(body.expiresAt);
  if (!Number.isFinite(expiration)) throw new OperatorCommandError('pairing-expiry-invalid', 'The broker returned an invalid pairing expiry.');
  return { pairingId: body.pairingId, qr: body.qr, expiresAt: body.expiresAt, expiration };
}

/** Polls one offer until it is accepted, or throws once it expires or disappears. */
async function awaitPairingAcceptance(
  dependencies: OperatorCommandDependencies,
  access: LocalBrokerAccess,
  offer: PairingOffer,
): Promise<string> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  while (now() < offer.expiration) {
    const status = await request(
      dependencies,
      access,
      `/api/transport/pairings/${encodeURIComponent(offer.pairingId)}`,
    );
    const statusBody = object(status.json);
    if (status.ok && statusBody?.state === 'accepted' && typeof statusBody.peerId === 'string') {
      return statusBody.peerId;
    }
    if (statusBody?.state === 'expired' || status.status === 404) {
      throw new OperatorCommandError(
        statusBody?.state === 'expired' ? 'PAIRING_EXPIRED' : 'PAIRING_NOT_FOUND',
        statusBody?.state === 'expired'
          ? 'The pairing QR expired; generate a new one.'
          : 'The pairing offer disappeared; generate a new QR and review connected devices.',
      );
    }
    if (!status.ok || statusBody?.state !== 'pending') {
      throw new OperatorCommandError('pairing-status-invalid', 'The broker returned an invalid pairing status.');
    }
    await sleep(Math.min(1_000, Math.max(50, offer.expiration - now())));
  }
  throw new OperatorCommandError('PAIRING_EXPIRED', 'The pairing QR expired; generate a new one.');
}

export async function runPairCommand(
  options: PairCommandOptions,
  dependencies: OperatorCommandDependencies = {},
): Promise<OperatorCommandResult> {
  const home = options.home ?? setupStateHome();
  const paired: PairedDevice[] = [];
  const writeSummary = (): void => {
    options.stdout.write(`Paired ${paired.length} device${paired.length === 1 ? '' : 's'} this session:\n`);
    for (const device of paired) {
      options.stdout.write(`- ${device.peerId}${device.label ? ` (${device.label})` : ''}\n`);
    }
    options.stdout.write(`Review them with: ${options.invocation} devices list\n`);
  };
  try {
    const access = localAccess(home);
    const pairingLinkLabel = readSetupState(home).language === 'zh-Hans'
      ? '配对链接'
      : 'Pairing link';
    await verifyLocalBroker(dependencies, access);
    await verifyAdvertisedBroker(dependencies, access);
    const advertisedUrl = access.config.broker.advertisedUrl!;
    const presentOffer = async (offer: PairingOffer): Promise<void> => {
      const fit = pairingQrFit(offer.qr, dependencies);
      if (fit.fits) {
        const rendered = await (dependencies.renderQr ?? renderTerminalPairingQr)(offer.qr);
        options.stdout.write(`${rendered.endsWith('\n') ? rendered : `${rendered}\n`}`);
      } else {
        options.stdout.write(
          `This terminal is ${fit.columns} columns wide and the pairing QR needs ${fit.width}. `
            + 'A QR that wraps cannot be scanned, so here is the pairing link instead — open it on the '
            + `device, or widen the terminal to ${fit.width} columns and run ${options.invocation} pair again.\n`,
        );
      }
      // The QR and the selectable link are two renderings of the exact same
      // one-use payload. Always print the link: paste works on every client,
      // including desktop platforms without an in-app camera scanner.
      options.stdout.write(`${pairingLinkLabel}: ${offer.qr}\n`);
      options.stdout.write(
        `${fit.fits ? 'Scan' : 'Open'} before ${offer.expiresAt}. This pairing offer is one-use and expires in five minutes.\n`,
      );
      options.stdout.write('Warning: a paired device receives a revocable credential with full broker API access in v1.\n');
    };
    let offer = await createPairingOffer(dependencies, access, options.clientLabel, advertisedUrl);

    if (options.json && !options.wait) {
      options.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        pairingId: offer.pairingId,
        qr: offer.qr,
        expiresAt: offer.expiresAt,
        advertisedUrl,
        tokenScope: 'full-broker-api-v1',
      }, null, 2)}\n`);
      return { exitCode: 0, detailCode: 'pairing-created' };
    }

    if (!options.json) await presentOffer(offer);
    if (!options.wait) {
      if (!options.json) writeTokenGuidance(options, home);
      return { exitCode: 0, detailCode: 'pairing-created' };
    }

    // Interactive looping is a terminal-only affordance: --json stays single-shot and
    // machine-parseable, and a non-TTY caller keeps today's exact behaviour.
    const interactive = !options.json && (options.interactive ?? process.stdout.isTTY === true);
    try {
      for (;;) {
        const peerId = await awaitPairingAcceptance(dependencies, access, offer);
        paired.push({ peerId, ...(options.clientLabel ? { label: options.clientLabel } : {}) });
        if (options.json) {
          options.stdout.write(`${JSON.stringify({
            schemaVersion: 1,
            pairingId: offer.pairingId,
            state: 'accepted',
            peerId,
            expiresAt: offer.expiresAt,
            tokenScope: 'full-broker-api-v1',
          }, null, 2)}\n`);
          return { exitCode: 0, detailCode: 'pairing-accepted' };
        }
        options.stdout.write(`Paired device ${peerId}. Review it with: ${options.invocation} devices list\n`);
        if (!interactive) {
          if (!options.json) writeTokenGuidance(options, home);
          return { exitCode: 0, detailCode: 'pairing-accepted' };
        }
        const another = await (dependencies.confirmAnother ?? defaultConfirmAnother)(paired.length);
        if (!another) break;
        // One QR pairs exactly one device, so pairing another needs a fresh offer.
        offer = await createPairingOffer(dependencies, access, options.clientLabel, advertisedUrl);
        await presentOffer(offer);
      }
    } catch (error) {
      if (paired.length > 0) writeSummary();
      throw error;
    }
    writeSummary();
    if (!options.json) writeTokenGuidance(options, home);
    return { exitCode: 0, detailCode: 'pairing-accepted' };
  } catch (error) {
    return reportFailure(error, { home, invocation: options.invocation, stderr: options.stderr });
  }
}

interface PublicPeer {
  peerId: string;
  label?: string;
  identityPublicKey?: string;
  brokerPeerId?: string;
  brokerIdentityPublicKey?: string;
  acceptedAt?: string;
}

function publicPeers(value: unknown): PublicPeer[] {
  if (!Array.isArray(value)) throw new OperatorCommandError('peer-list-invalid', 'The broker returned an invalid device list.');
  return value.map((candidate): PublicPeer => {
    const peer = object(candidate);
    if (!peer || typeof peer.peerId !== 'string') {
      throw new OperatorCommandError('peer-list-invalid', 'The broker returned an invalid device entry.');
    }
    return {
      peerId: peer.peerId,
      ...(typeof peer.label === 'string' ? { label: peer.label } : {}),
      ...(typeof peer.identityPublicKey === 'string' ? { identityPublicKey: peer.identityPublicKey } : {}),
      ...(typeof peer.brokerPeerId === 'string' ? { brokerPeerId: peer.brokerPeerId } : {}),
      ...(typeof peer.brokerIdentityPublicKey === 'string' ? { brokerIdentityPublicKey: peer.brokerIdentityPublicKey } : {}),
      ...(typeof peer.acceptedAt === 'string' ? { acceptedAt: peer.acceptedAt } : {}),
    };
  });
}

export async function runDevicesListCommand(
  options: DevicesListCommandOptions,
  dependencies: OperatorCommandDependencies = {},
): Promise<OperatorCommandResult> {
  const home = options.home ?? setupStateHome();
  try {
    const access = localAccess(home);
    await verifyLocalBroker(dependencies, access);
    const response = await request(dependencies, access, '/api/transport/peers');
    const body = object(response.json);
    if (!response.ok || body?.ok !== true) {
      throw new OperatorCommandError('peer-list-failed', 'The broker could not list paired devices.');
    }
    const peers = publicPeers(body.peers);
    if (options.json) {
      options.stdout.write(`${JSON.stringify({ schemaVersion: 1, peers }, null, 2)}\n`);
    } else if (peers.length === 0) {
      options.stdout.write('No paired devices.\n');
    } else {
      options.stdout.write('Paired devices (v1 credentials have full broker API access):\n');
      for (const peer of peers) {
        options.stdout.write(`- ${peer.peerId}${peer.label ? ` (${peer.label})` : ''}${peer.acceptedAt ? ` — paired ${peer.acceptedAt}` : ''}\n`);
      }
    }
    return { exitCode: 0, detailCode: 'peer-list-complete' };
  } catch (error) {
    return reportFailure(error, { home, invocation: options.invocation, stderr: options.stderr });
  }
}

async function defaultConfirmRevoke(peerId: string): Promise<boolean> {
  const prompts = await import('@clack/prompts');
  const answer = await prompts.confirm({
    message: `Revoke full broker access for ${peerId}?`,
    initialValue: false,
  });
  return !prompts.isCancel(answer) && answer === true;
}

export async function runDevicesRevokeCommand(
  options: DevicesRevokeCommandOptions,
  dependencies: OperatorCommandDependencies = {},
): Promise<OperatorCommandResult> {
  const home = options.home ?? setupStateHome();
  try {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(options.peerId)) {
      throw new OperatorCommandError('peer-id-invalid', 'The device id is invalid.');
    }
    if (!options.yes) {
      if (!options.interactive) {
        throw new OperatorCommandError(
          'revoke-confirmation-required',
          `Non-interactive revocation requires: ${options.invocation} devices revoke ${options.peerId} --yes`,
          'configuration',
        );
      }
      const confirmed = await (dependencies.confirmRevoke ?? defaultConfirmRevoke)(options.peerId);
      if (!confirmed) {
        options.stdout.write('Revocation cancelled; device access is unchanged.\n');
        return { exitCode: 130, detailCode: 'peer-revoke-cancelled' };
      }
    }
    const access = localAccess(home);
    await verifyLocalBroker(dependencies, access);
    const response = await request(
      dependencies,
      access,
      `/api/transport/peers/${encodeURIComponent(options.peerId)}`,
      { method: 'DELETE' },
    );
    const body = object(response.json);
    if (!response.ok || body?.ok !== true) {
      throw new OperatorCommandError('peer-revoke-failed', 'The broker could not revoke this device.');
    }
    if (body.revoked !== true) {
      throw new OperatorCommandError(
        'peer-not-active',
        'No active paired device has that id; it may already be revoked.',
      );
    }
    if (options.json) {
      options.stdout.write(`${JSON.stringify({ schemaVersion: 1, peerId: options.peerId, revoked: true }, null, 2)}\n`);
    } else {
      options.stdout.write(`Revoked ${options.peerId}; its paired credential is invalid immediately.\n`);
    }
    return { exitCode: 0, detailCode: 'peer-revoked' };
  } catch (error) {
    return reportFailure(error, { home, invocation: options.invocation, stderr: options.stderr });
  }
}
