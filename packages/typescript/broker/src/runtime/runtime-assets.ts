import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PI_BRIDGE_EMBEDDED_SOURCE } from '@cosyncing/adapter-pi/bridge-asset';
// @ts-expect-error Bun's text loader supports service templates that have no TypeScript module declaration.
import systemdServiceTemplateModule from '../../assets/systemd/cosyncing.service' with { type: 'text' };
// @ts-expect-error Bun's text loader supports service templates that have no TypeScript module declaration.
import launchdServiceTemplateModule from '../../assets/launchd/cosyncing.plist' with { type: 'text' };
// @ts-expect-error Bun's text loader supports the standalone Windows bootstrap as an embedded text asset.
import windowsServiceBootstrapModule from '../../assets/windows/service-bootstrap.mjs' with { type: 'text' };
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { AGENT_SKILL_SOURCE } from '../installation/agent-skill.ts';

// Bun returns strings for `type: 'text'` in source runs and compiled executables. TypeScript assigns a
// special module type to the service templates, so narrow once at this loader boundary.
const systemdServiceTemplate = systemdServiceTemplateModule as unknown as string;
const launchdServiceTemplate = launchdServiceTemplateModule as unknown as string;
const windowsServiceBootstrap = windowsServiceBootstrapModule as unknown as string;

export type RuntimeAssetId =
  | 'pi/cosyncing-bridge/index.ts'
  | 'service/systemd/cosyncing.service'
  | 'skill/cosyncing/SKILL.md'
  | 'service/launchd/cosyncing.plist'
  | 'service/windows/service-bootstrap.mjs'
  | 'flutter-web';

export type RuntimeAssetDelivery = 'embedded' | 'adjacent' | 'reserved';

export interface RuntimeAsset {
  id: RuntimeAssetId;
  delivery: RuntimeAssetDelivery;
  requiredForV1: boolean;
  stage: 'linux-v1' | 'darwin-v1' | 'optional' | 'macos-fast-follow';
  installTarget: string;
  mediaType?: string;
  content: string | null;
  sha256: string | null;
  bytes: number;
}

export interface RuntimeAssetCheck {
  id: RuntimeAssetId;
  required: boolean;
  status: 'ok' | 'missing' | 'hash-mismatch' | 'optional-missing' | 'staged';
  detail: string;
  sha256?: string;
}

export interface RuntimeAssetReport {
  schemaVersion: 1;
  ok: boolean;
  checks: RuntimeAssetCheck[];
}

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

function embeddedAsset(input: {
  id: RuntimeAssetId;
  content: string;
  installTarget: string;
  mediaType: string;
  stage?: RuntimeAsset['stage'];
}): RuntimeAsset {
  const { stage = 'linux-v1', ...rest } = input;
  return Object.freeze({
    ...rest,
    delivery: 'embedded' as const,
    requiredForV1: true,
    stage,
    sha256: sha256(input.content),
    bytes: Buffer.byteLength(input.content),
  });
}

/** D17's complete package inventory. The Claude hook is deliberately absent, and so is the PoC UI: it
 *  gated the broker token behind a removable DOM overlay rather than an auth boundary, so R9 stopped
 *  embedding and serving it. `apps/poc-ui` stays in the tree as a fixture source for capability scans. */
export const RUNTIME_ASSET_MANIFEST: readonly RuntimeAsset[] = Object.freeze([
  embeddedAsset({
    id: 'pi/cosyncing-bridge/index.ts',
    content: PI_BRIDGE_EMBEDDED_SOURCE,
    installTarget: '~/.pi/agent/extensions/cosyncing-bridge/index.ts',
    mediaType: 'application/typescript; charset=utf-8',
  }),
  embeddedAsset({
    id: 'service/systemd/cosyncing.service',
    content: systemdServiceTemplate,
    installTarget: '~/.config/systemd/user/cosyncing.service',
    mediaType: 'text/plain; charset=utf-8',
  }),
  embeddedAsset({
    id: 'skill/cosyncing/SKILL.md',
    content: AGENT_SKILL_SOURCE,
    installTarget: '~/{.claude,.agents}/skills/cosyncing/SKILL.md',
    mediaType: 'text/markdown; charset=utf-8',
  }),
  embeddedAsset({
    id: 'service/launchd/cosyncing.plist',
    content: launchdServiceTemplate,
    installTarget: '~/Library/LaunchAgents/dev.cosyncing.broker.plist',
    mediaType: 'application/xml; charset=utf-8',
    stage: 'darwin-v1',
  }),
  embeddedAsset({
    id: 'service/windows/service-bootstrap.mjs',
    content: windowsServiceBootstrap,
    installTarget: '~/.cosyncing/service/windows/service-bootstrap.mjs',
    mediaType: 'text/javascript; charset=utf-8',
    stage: 'optional',
  }),
  Object.freeze({
    id: 'flutter-web',
    delivery: 'adjacent',
    requiredForV1: false,
    stage: 'optional',
    installTarget: `${PRODUCT_IDENTITY.releaseAssetPrefix}-web-<version>/`,
    content: null,
    sha256: null,
    bytes: 0,
  }),
]);

export function runtimeAsset(
  id: RuntimeAssetId,
  manifest: readonly RuntimeAsset[] = RUNTIME_ASSET_MANIFEST,
): RuntimeAsset | undefined {
  return manifest.find((asset) => asset.id === id);
}

export function embeddedRuntimeAsset(id: RuntimeAssetId): RuntimeAsset {
  const asset = runtimeAsset(id);
  if (!asset || asset.delivery !== 'embedded' || asset.content == null || asset.sha256 == null) {
    throw new Error(`required embedded runtime asset is unavailable: ${id}`);
  }
  return asset;
}

export function resolveFlutterWebRoot(options: {
  override?: string;
  packaged: boolean;
  executablePath: string;
  version: string;
  sourceRoot?: string;
}): string {
  const override = options.override?.trim();
  if (override) return resolve(override);
  if (options.packaged) {
    return join(
      dirname(resolve(options.executablePath)),
      `${PRODUCT_IDENTITY.releaseAssetPrefix}-web-${options.version}`,
    );
  }
  if (!options.sourceRoot) throw new Error('source Flutter web root is required for a source build');
  return resolve(options.sourceRoot);
}

/**
 * The web root a durable service must be TOLD, because it cannot work it out.
 *
 * A packaged build resolves the sidecar beside the executable that is running. The unit does not exec the
 * acquisition executable — it execs `serviceExecutablePath`, the bootstrap copy at `<home>/bin/cosyncing` —
 * so a service left to resolve for itself looks for `<home>/bin/cosyncing-web-<version>`, which nothing ever
 * puts there. The result is a broker that serves "no web app" on a host where setup measured the sidecar and
 * told the operator it was there. Resolving from the ACQUISITION executable and carrying the answer in the
 * service environment makes the service see exactly the directory setup inspected.
 *
 * Setup, lifecycle, and the CLI MUST resolve this identically, or a written environment file reads back as
 * drifted — the same contract `serviceExecutablePath` carries, for the same reason.
 */
export function serviceFlutterWebRoot(options: {
  override?: string;
  packaged: boolean;
  executablePath: string;
  version: string;
}): string {
  // Durable service mode is offered to packaged builds only, so the source branch is unreachable in
  // practice; naming the monorepo build anyway keeps this total rather than throwing at a provider seam.
  return resolveFlutterWebRoot({
    ...options,
    sourceRoot: resolve(import.meta.dir, '../../../../../apps/client/build/web'),
  });
}

export function inspectRuntimeAssets(options: {
  manifest?: readonly RuntimeAsset[];
  flutterWebRoot?: string;
} = {}): RuntimeAssetReport {
  const manifest = options.manifest ?? RUNTIME_ASSET_MANIFEST;
  const checks: RuntimeAssetCheck[] = [];
  const expectedIds = RUNTIME_ASSET_MANIFEST.filter((asset) => asset.requiredForV1).map((asset) => asset.id);

  for (const id of expectedIds) {
    const asset = runtimeAsset(id, manifest);
    if (!asset || asset.content == null || asset.sha256 == null) {
      checks.push({ id, required: true, status: 'missing', detail: `Required runtime asset is missing: ${id}` });
      continue;
    }
    const actualHash = sha256(asset.content);
    if (actualHash !== asset.sha256) {
      checks.push({
        id,
        required: true,
        status: 'hash-mismatch',
        detail: `Runtime asset hash does not match its package manifest: ${id}`,
        sha256: actualHash,
      });
      continue;
    }
    checks.push({ id, required: true, status: 'ok', detail: 'Embedded asset is present and hash-valid.', sha256: asset.sha256 });
  }

  const flutterRoot = options.flutterWebRoot;
  const flutterPresent = !!flutterRoot && existsSync(join(flutterRoot, 'index.html'));
  checks.push({
    id: 'flutter-web',
    required: false,
    status: flutterPresent ? 'ok' : 'optional-missing',
    detail: flutterPresent
      ? 'Optional Flutter web bundle is available.'
      : 'Optional Flutter web bundle is absent; this build serves no browser client, so pair a device instead.',
  });

  return {
    schemaVersion: 1,
    ok: !checks.some((check) => check.required && check.status !== 'ok'),
    checks,
  };
}
