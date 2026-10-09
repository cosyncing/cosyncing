/**
 * Build the Claude mod's directory marketplace from `mods/`.
 *
 * The public repository is the marketplace root, so the layout is a public-tree path and
 * nothing about it depends on the private lineage. This copies that layout to a staging
 * directory and stamps the broker's version into the two files that carry it, which is the
 * only transformation the build does. Claude is then told a path that does not move on
 * upgrade (`<stateDir>/claude-mod/marketplace`), because a versioned directory is how the
 * 0.6.3 web sidecar path went stale: the marketplace keeps its name, the plugin inside it
 * changes version.
 *
 *   bun run scripts/mod/build-mod-marketplace.ts [--out <dir>] [--version X.Y.Z]
 */
export {};
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const SOURCE = join(ROOT, 'mods');

const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const at = argv.indexOf(name);
  const value = argv[at + 1];
  return at >= 0 && value !== undefined ? value : fallback;
}

const out = flag('--out', join(ROOT, 'output/mod/marketplace'));
const version = flag('--version', JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string);

if (!/^\d+\.\d+\.\d+[-\w.]*$/.test(version)) {
  console.error(`build-mod-marketplace: refusing to stamp a version that is not a version: ${version}`);
  process.exit(1);
}

// Staged clean rather than updated in place: a stale file left under the plugin directory
// would be installed into every Claude session that refreshes from this copy.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(SOURCE, 'cosyncing-claude'), join(out, 'cosyncing-claude'), {
  recursive: true,
  filter: (src) => !src.includes(`${sep}.claude-plugin${sep}types`)
    // The mod's own test file runs in CI and is not part of what a session loads. The embedded
    // bundle has always left it out; a staged copy that kept it made the two build routes of the
    // same marketplace produce different trees, which is exactly the drift the receipt hashes catch
    // -- and a stray `.test.ts` inside an installed plugin is a file nothing asked for.
    && !src.endsWith('.test.ts'),
});

const stamped = [
  { path: join(out, '.claude-plugin/marketplace.json'), source: join(SOURCE, 'marketplace.json') },
  { path: join(out, 'cosyncing-claude/.claude-plugin/plugin.json'), source: join(SOURCE, 'cosyncing-claude/.claude-plugin/plugin.json') },
];

for (const file of stamped) {
  mkdirSync(join(file.path, '..'), { recursive: true });
  const manifest = JSON.parse(readFileSync(file.source, 'utf8')) as Record<string, unknown>;
  // A marketplace manifest carries no version of its own; the version belongs to each
  // entry, which is what `claude plugin marketplace update` compares. A plugin manifest
  // carries its version at the top level. Stamping the wrong one is a schema error the
  // build would rather not discover at someone's first `claude plugin install`.
  if (Array.isArray(manifest.plugins)) {
    manifest.plugins = (manifest.plugins as Record<string, unknown>[]).map((entry) => ({ ...entry, version }));
  } else {
    manifest.version = version;
  }
  writeFileSync(file.path, JSON.stringify(manifest, null, 2) + '\n');
}

console.log(`build-mod-marketplace: ${out} at version ${version}`);
