import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { PRODUCT_IDENTITY } from '../../../packages/typescript/protocol/src/product.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const BUN_LICENSE_PATH = join(ROOT, 'docs/legal/bun-1.3.8-LICENSE.md');
const BUN_LICENSE_SHA256 = '7068a9711ef8196d654e143447ed7976b3678ce21145b9da16e1f786528f15bb';

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  dependencies?: Record<string, string>;
  repository?: string | { url?: string };
}

export interface SoftwareInventoryPackage {
  name: string;
  version: string;
  license: string;
  internal: boolean;
  dependencies: string[];
  source?: string;
}

export interface CompiledSoftwareInventory {
  schemaVersion: 1;
  format: 'cosyncing-compiled-software-inventory';
  product: typeof PRODUCT_IDENTITY.productName;
  version: string;
  sourceCommit: string;
  generatedAt: string;
  packages: SoftwareInventoryPackage[];
  reviewedSupplyChain: {
    clackPrompts: {
      root: '@clack/prompts@1.7.0';
      licenses: ['MIT'];
      packages: string[];
    };
  };
}

export interface SpdxSoftwareBom {
  spdxVersion: 'SPDX-2.3';
  dataLicense: 'CC0-1.0';
  SPDXID: 'SPDXRef-DOCUMENT';
  name: string;
  documentNamespace: string;
  creationInfo: {
    created: string;
    creators: ['Tool: cosyncing-release-assembler'];
  };
  packages: Array<Record<string, unknown>>;
  relationships: Array<{
    spdxElementId: string;
    relationshipType: 'DESCRIBES' | 'DEPENDS_ON';
    relatedSpdxElement: string;
  }>;
}

const REVIEWED_CLACK_PACKAGES = Object.freeze([
  '@clack/core@1.4.3',
  '@clack/prompts@1.7.0',
  'fast-string-truncated-width@3.0.3',
  'fast-string-width@3.0.2',
  'fast-wrap-ansi@0.2.2',
  'sisteransi@1.0.5',
]);

function readPackageJson(path: string): PackageJson {
  const value = JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  if (!value.name) throw new Error(`package metadata is incomplete: ${path}`);
  return value;
}

function workspacePackages(): Map<string, string> {
  const packages = new Map<string, string>();
  const glob = new Bun.Glob('packages/**/package.json');
  for (const relative of glob.scanSync({ cwd: ROOT, onlyFiles: true })) {
    const path = join(ROOT, relative);
    const value = readPackageJson(path);
    packages.set(value.name!, path);
  }
  return packages;
}

function externalPackageJson(name: string, fromDirectory: string): string {
  let entry: string;
  try {
    entry = realpathSync(Bun.resolveSync(name, fromDirectory));
  } catch {
    entry = realpathSync(Bun.resolveSync(name, ROOT));
  }
  let directory = dirname(entry);
  const root = parse(directory).root;
  while (directory !== root) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      try {
        if (readPackageJson(candidate).name === name) return candidate;
      } catch {
        // Keep walking: bundles may contain non-package JSON named package.json.
      }
    }
    directory = dirname(directory);
  }
  throw new Error(`could not resolve package metadata for ${name}`);
}

function installedPackageJson(name: string, version: string): string {
  try {
    const direct = externalPackageJson(name, ROOT);
    if (readPackageJson(direct).version === version) return direct;
  } catch {
    // Isolated Bun installs may expose transitive packages only under .bun.
  }
  const glob = new Bun.Glob('node_modules/.bun/*/node_modules/**/package.json');
  for (const relative of glob.scanSync({ cwd: ROOT, onlyFiles: true, dot: true })) {
    const path = join(ROOT, relative);
    try {
      const value = readPackageJson(path);
      if (value.name === name && value.version === version) return path;
    } catch {
      // Ignore package-like JSON without complete package metadata.
    }
  }
  throw new Error(`installed runtime dependency metadata is missing: ${name}@${version}`);
}

function packageLicenseText(name: string, version: string): string {
  const packageJson = installedPackageJson(name, version);
  const directory = dirname(packageJson);
  const candidates = [
    'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'license.txt',
  ];
  for (const candidate of candidates) {
    const path = join(directory, candidate);
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  }
  const alternate = readdirSync(directory)
    .filter((candidate) => /^licen[cs]e(?:[._-].*)?$/i.test(candidate))
    .sort()[0];
  if (alternate) return readFileSync(join(directory, alternate), 'utf8').trim();
  throw new Error(`runtime dependency license text is missing: ${name}`);
}

function pinnedBunLicenseText(): string {
  const text = readFileSync(BUN_LICENSE_PATH, 'utf8');
  const digest = createHash('sha256').update(text).digest('hex');
  if (digest !== BUN_LICENSE_SHA256) {
    throw new Error(`Bun 1.3.8 license hash mismatch: ${digest}`);
  }
  return text.trim();
}

/**
 * Third-party notices for the JavaScript npm distribution.
 *
 * Same per-package licence texts as the compiled notices, and deliberately WITHOUT the Bun runtime section:
 * that package ships no Bun, no JavaScriptCore, and no WebKit, so reproducing Bun's licence in it would
 * misstate what is being distributed. Removing the embedded runtime does not remove the ordinary obligation
 * to carry notices for the JavaScript dependencies that ARE bundled, which is what this emits.
 */
export function createJavaScriptThirdPartyNotices(inventory: CompiledSoftwareInventory): string {
  const lines = [
    `Third-party notices for the cosyncing ${inventory.version} npm package`,
    '',
    'This package contains one self-contained JavaScript application bundle. It does not',
    'contain the Bun runtime, JavaScriptCore, or WebKit; Bun is installed separately by the',
    'operator and is not redistributed here.',
    '',
    'Bundled npm dependency closure',
    '==============================',
  ];
  for (const item of inventory.packages.filter((candidate) => !candidate.internal)) {
    lines.push(
      '',
      `${item.name}@${item.version} (${item.license})`,
      '-'.repeat(Math.min(78, item.name.length + item.version.length + item.license.length + 4)),
      packageLicenseText(item.name, item.version),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Render exact third-party notices for every external package in the compiled closure. */
export function createThirdPartyNotices(inventory: CompiledSoftwareInventory): string {
  const lines = [
    `Third-party notices for cosyncing broker ${inventory.version}`,
    '',
    'Bun 1.3.8 runtime',
    '=================',
    '',
    pinnedBunLicenseText(),
    '',
    'Compiled npm dependency closure',
    '===============================',
  ];
  for (const item of inventory.packages.filter((candidate) => !candidate.internal)) {
    lines.push(
      '',
      `${item.name}@${item.version} (${item.license})`,
      '-'.repeat(Math.min(78, item.name.length + item.version.length + item.license.length + 4)),
      packageLicenseText(item.name, item.version),
    );
  }
  return `${lines.join('\n')}\n`;
}

function repositoryUrl(value: PackageJson['repository']): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && typeof value.url === 'string' && value.url.trim()) {
    return value.url.trim();
  }
  return undefined;
}

function dependencyClosure(root: string, byName: Map<string, SoftwareInventoryPackage>): string[] {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dependency of byName.get(name)?.dependencies ?? []) visit(dependency);
  };
  visit(root);
  return [...seen]
    .map((name) => {
      const item = byName.get(name);
      if (!item) throw new Error(`inventory dependency ${name} is missing`);
      return `${item.name}@${item.version}`;
    })
    .sort();
}

/** Resolve the exact runtime dependency graph that is eligible for the compiled broker. */
export function createCompiledSoftwareInventory(options: {
  version: string;
  sourceCommit: string;
  generatedAt: string;
}): CompiledSoftwareInventory {
  const workspaces = workspacePackages();
  const rootPath = join(ROOT, 'package.json');
  const queue: Array<{ path: string; internal: boolean }> = [
    { path: rootPath, internal: true },
    { path: workspaces.get('@cosyncing/broker')!, internal: true },
  ];
  const visitedPaths = new Set<string>();
  const inventory = new Map<string, SoftwareInventoryPackage>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const packagePath = realpathSync(current.path);
    if (visitedPaths.has(packagePath)) continue;
    visitedPaths.add(packagePath);
    const value = readPackageJson(packagePath);
    const packageVersion = value.version ?? (current.internal ? options.version : undefined);
    if (!packageVersion) throw new Error(`package version is missing: ${packagePath}`);
    const dependencyNames = Object.keys(value.dependencies ?? {}).sort();
    const source = repositoryUrl(value.repository);
    inventory.set(value.name!, {
      name: value.name!,
      version: packageVersion,
      license: current.internal ? 'Apache-2.0' : value.license || 'NOASSERTION',
      internal: current.internal,
      dependencies: dependencyNames,
      ...(source ? { source } : {}),
    });
    for (const dependency of dependencyNames) {
      const workspace = workspaces.get(dependency);
      queue.push(workspace
        ? { path: workspace, internal: true }
        : { path: externalPackageJson(dependency, dirname(packagePath)), internal: false });
    }
  }

  const clack = inventory.get('@clack/prompts');
  if (!clack || clack.version !== '1.7.0') {
    throw new Error('@clack/prompts must remain pinned to reviewed version 1.7.0');
  }
  const clackClosure = dependencyClosure('@clack/prompts', inventory);
  if (JSON.stringify(clackClosure) !== JSON.stringify(REVIEWED_CLACK_PACKAGES)) {
    throw new Error(`@clack/prompts dependency review is stale: ${clackClosure.join(', ')}`);
  }
  const clackLicenses = [...new Set(clackClosure.map((id) => {
    const name = id.slice(0, id.lastIndexOf('@'));
    return inventory.get(name)?.license;
  }))];
  if (clackLicenses.length !== 1 || clackLicenses[0] !== 'MIT') {
    throw new Error(`@clack/prompts license review is stale: ${clackLicenses.join(', ')}`);
  }

  return {
    schemaVersion: 1,
    format: 'cosyncing-compiled-software-inventory',
    product: PRODUCT_IDENTITY.productName,
    version: options.version,
    sourceCommit: options.sourceCommit,
    generatedAt: options.generatedAt,
    packages: [...inventory.values()].sort((left, right) => left.name.localeCompare(right.name)),
    reviewedSupplyChain: {
      clackPrompts: {
        root: '@clack/prompts@1.7.0',
        licenses: ['MIT'],
        packages: clackClosure,
      },
    },
  };
}

function spdxPackageId(name: string): string {
  return `SPDXRef-Package-${name.replace(/[^A-Za-z0-9.-]+/g, '-')}`;
}

/** Render the compiled broker inventory as a deterministic SPDX 2.3 SBOM. */
export function createSpdxSoftwareBom(
  inventory: CompiledSoftwareInventory,
): SpdxSoftwareBom {
  const packageIds = new Map(
    inventory.packages.map((item) => [item.name, spdxPackageId(item.name)]),
  );
  const rootId = packageIds.get('cosyncing');
  if (!rootId) throw new Error('SPDX SBOM requires the cosyncing root package');

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `cosyncing-broker-${inventory.version}`,
    documentNamespace:
      `https://github.com/cosyncing/cosyncing/spdx/${inventory.sourceCommit}/${inventory.version}`,
    creationInfo: {
      created: inventory.generatedAt,
      creators: ['Tool: cosyncing-release-assembler'],
    },
    packages: inventory.packages.map((item) => ({
      SPDXID: packageIds.get(item.name),
      name: item.name,
      versionInfo: item.version,
      downloadLocation: item.source ?? 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: item.license,
      licenseDeclared: item.license,
      copyrightText: 'NOASSERTION',
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator:
          `pkg:npm/${encodeURIComponent(item.name).replace('%2F', '/')}@${item.version}`,
      }],
    })),
    relationships: [
      {
        spdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DESCRIBES',
        relatedSpdxElement: rootId,
      },
      ...inventory.packages.flatMap((item) =>
        item.dependencies.map((dependency) => {
          const dependencyId = packageIds.get(dependency);
          if (!dependencyId) {
            throw new Error(`SPDX dependency is missing from inventory: ${dependency}`);
          }
          return {
            spdxElementId: packageIds.get(item.name)!,
            relationshipType: 'DEPENDS_ON' as const,
            relatedSpdxElement: dependencyId,
          };
        }),
      ),
    ],
  };
}
