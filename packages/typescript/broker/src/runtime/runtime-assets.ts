import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PI_BRIDGE_EMBEDDED_SOURCE } from '@cosyncing/adapter-pi/bridge-asset';
import { OMP_BRIDGE_EMBEDDED_SOURCE } from '@cosyncing/adapter-omp/bridge-asset';
// @ts-expect-error Bun's text loader supports service templates that have no TypeScript module declaration.
import systemdServiceTemplateModule from '../../assets/systemd/cosyncing.service' with { type: 'text' };
// @ts-expect-error Bun's text loader supports service templates that have no TypeScript module declaration.
import launchdServiceTemplateModule from '../../assets/launchd/cosyncing.plist' with { type: 'text' };
// @ts-expect-error Bun's text loader supports the standalone Windows bootstrap as an embedded text asset.
import windowsServiceBootstrapModule from '../../assets/windows/service-bootstrap.mjs' with { type: 'text' };
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { AGENT_SKILL_SOURCE } from '../installation/agent-skill.ts';
import { modSocketPathDialable } from '../sessions/mod-socket-path.ts';
// The Claude mod marketplace is embedded as four text assets rather than shipped as a directory
// beside the executable. The broker's published JavaScript distribution is ONE file, and the npm
// tarball carries that file; an adjacent directory would need a second publication surface, and a
// marketplace whose copy moves on upgrade is the failure the web sidecar already had.
// @ts-expect-error Bun's text loader embeds the mod source so the shipped copy cannot drift from the tree.
import claudeModRegisterModule from '../../../../../mods/cosyncing-claude/hooks/register.js' with { type: 'text' };
import claudeModHooksModule from '../../../../../mods/cosyncing-claude/hooks/hooks.json' with { type: 'text' };
import claudeModPluginManifestModule from '../../../../../mods/cosyncing-claude/.claude-plugin/plugin.json' with { type: 'text' };
import claudeModMarketplaceManifestModule from '../../../../../mods/marketplace.json' with { type: 'text' };

// Bun returns strings for `type: 'text'` in source runs and compiled executables. TypeScript assigns a
// special module type to the service templates, so narrow once at this loader boundary.
const systemdServiceTemplate = systemdServiceTemplateModule as unknown as string;
const launchdServiceTemplate = launchdServiceTemplateModule as unknown as string;
const windowsServiceBootstrap = windowsServiceBootstrapModule as unknown as string;
const claudeModRegister = claudeModRegisterModule as unknown as string;
const claudeModHooks = claudeModHooksModule as unknown as string;
const claudeModPluginManifest = claudeModPluginManifestModule as unknown as string;
const claudeModMarketplaceManifest = claudeModMarketplaceManifestModule as unknown as string;

export type RuntimeAssetId =
  | 'pi/cosyncing-bridge/index.ts'
  | 'omp/cosyncing-bridge/index.ts'
  | 'service/systemd/cosyncing.service'
  | 'skill/cosyncing/SKILL.md'
  | 'service/launchd/cosyncing.plist'
  | 'service/windows/service-bootstrap.mjs'
  | 'claude-mod-marketplace'
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

/**
 * The Claude mod's directory marketplace, as one embedded document.
 *
 * Four files, taken from `mods/` — the same tree the public repository publishes and the same
 * tree `scripts/mod/build-mod-marketplace.ts` stages for a manual install. Embedding the tree
 * means a running broker can materialize the marketplace with no network and no path into a
 * package directory that would move on upgrade.
 *
 * The two manifests are stored WITHOUT a version. Claude compares the version in
 * `marketplace.json` against the installed copy, and the broker's version is what a setup run
 * knows that a build does not have to hard-code; `stampClaudeModMarketplace()` writes it when
 * the directory is materialized, so the marketplace a host ends up with always names the
 * broker that installed it.
 */
export const CLAUDE_MOD_MARKETPLACE_FILES: readonly { path: string; content: string }[] = Object.freeze([
  { path: 'cosyncing-claude/hooks/register.js', content: claudeModRegister },
  { path: 'cosyncing-claude/hooks/hooks.json', content: claudeModHooks },
  { path: 'cosyncing-claude/.claude-plugin/plugin.json', content: claudeModPluginManifest },
  { path: '.claude-plugin/marketplace.json', content: claudeModMarketplaceManifest },
]);

/** The manifest's plugin name and marketplace name, read from the manifest rather than repeated. */
export const CLAUDE_MOD_MARKETPLACE_NAME = 'cosyncing';
export const CLAUDE_MOD_PLUGIN_NAME = 'cosyncing-claude';

export const CLAUDE_MOD_MARKETPLACE_BUNDLE_SOURCE = JSON.stringify({
  schemaVersion: 1,
  marketplace: CLAUDE_MOD_MARKETPLACE_NAME,
  plugin: `${CLAUDE_MOD_PLUGIN_NAME}@${CLAUDE_MOD_MARKETPLACE_NAME}`,
  files: CLAUDE_MOD_MARKETPLACE_FILES.map((file) => ({
    path: file.path,
    sha256: sha256(file.content),
    content: file.content,
  })),
});

/** The one line of `register.js` setup rewrites, exactly as the tracked file spells it. */
export const CLAUDE_MOD_SOCKET_STAMP_LINE = "const STAMPED_SOCKET_PATH = '';";

/**
 * The marketplace tree as it must land on disk: the embedded files with the broker's version
 * stamped into the two manifests that carry one, and the broker's socket path stamped into the mod.
 *
 * A marketplace entry version and a `plugin.json` version that disagree is a `claude plugin
 * tag`-detectable inconsistency (the CLI checks exactly that), so both are stamped from the
 * same argument here rather than at two call sites.
 *
 * The socket path is the second stamp. A terminal does not inherit the broker's environment, so a
 * broker whose state lives under a moved `COSYNCING_HOME` was unreachable from every terminal that
 * did not export the same variable: the mod fell through to `~/.cosyncing`. Setup knows the answer,
 * so it writes it into the installed copy, and the receipt's hash covers the stamped bytes. An empty
 * `socketPath` leaves the tracked line alone, which is what a `--plugin-dir` run off a checkout gets.
 * The marker must appear exactly once: a mod that lost or doubled the line is a build that no longer
 * matches this code, and stamping it anyway would ship a copy whose socket rule nobody reviewed.
 */
export function stampClaudeModMarketplace(
  version: string,
  files: readonly { path: string; content: string }[] = CLAUDE_MOD_MARKETPLACE_FILES,
  socketPath = '',
): { path: string; content: string }[] {
  if (!/^\d+\.\d+\.\d+[-\w.]*$/.test(version)) {
    throw new Error(`refusing to stamp a Claude mod marketplace version that is not a version: ${version}`);
  }
  if (socketPath !== '' && !modSocketPathDialable(socketPath)) {
    throw new Error(`refusing to stamp a Claude mod socket path the mod could not dial: ${JSON.stringify(socketPath)}`);
  }
  return files.map((file) => {
    if (file.path === 'cosyncing-claude/hooks/register.js') {
      const occurrences = file.content.split(CLAUDE_MOD_SOCKET_STAMP_LINE).length - 1;
      if (occurrences !== 1) {
        throw new Error(`the Claude mod carries ${occurrences} socket stamp lines; expected exactly one`);
      }
      if (socketPath === '') return { ...file };
      // A replacer function, never a replacement string: a string expands `$$`, `$&`, `$'` and `` $` ``,
      // so a state home whose path held one of them was stamped as a different path, or with part of
      // the file spliced into the literal, and the receipt then vouched for those bytes.
      const stampedLine = `const STAMPED_SOCKET_PATH = ${JSON.stringify(socketPath)};`;
      return {
        path: file.path,
        content: file.content.replace(CLAUDE_MOD_SOCKET_STAMP_LINE, () => stampedLine),
      };
    }
    if (file.path !== '.claude-plugin/marketplace.json'
      && file.path !== 'cosyncing-claude/.claude-plugin/plugin.json') {
      return { ...file };
    }
    const manifest = JSON.parse(file.content) as Record<string, unknown>;
    if (Array.isArray(manifest.plugins)) {
      manifest.plugins = (manifest.plugins as Record<string, unknown>[]).map((entry) => ({
        ...entry,
        version,
      }));
    } else {
      manifest.version = version;
    }
    return { path: file.path, content: JSON.stringify(manifest, null, 2) + '\n' };
  });
}

/**
 * D17's complete package inventory.
 *
 * The legacy Claude HOOK stays absent: it gated the broker token behind a removable DOM overlay rather
 * than an auth boundary. What ships for Claude instead is the mod marketplace below, which carries no
 * token and reaches only the session that installed it. The PoC UI stays absent for the same R9 reason,
 * and `apps/poc-ui` remains in the tree as a fixture source for capability scans.
 */
export const RUNTIME_ASSET_MANIFEST: readonly RuntimeAsset[] = Object.freeze([
  embeddedAsset({
    id: 'pi/cosyncing-bridge/index.ts',
    content: PI_BRIDGE_EMBEDDED_SOURCE,
    installTarget: '~/.pi/agent/extensions/cosyncing-bridge/index.ts',
    mediaType: 'application/typescript; charset=utf-8',
  }),
  embeddedAsset({
    id: 'omp/cosyncing-bridge/index.ts',
    content: OMP_BRIDGE_EMBEDDED_SOURCE,
    installTarget: '~/.omp/agent/extensions/cosyncing-bridge/index.ts',
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
  embeddedAsset({
    id: 'claude-mod-marketplace',
    content: CLAUDE_MOD_MARKETPLACE_BUNDLE_SOURCE,
    installTarget: '~/.cosyncing/claude-mod/marketplace/',
    mediaType: 'application/json; charset=utf-8',
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
