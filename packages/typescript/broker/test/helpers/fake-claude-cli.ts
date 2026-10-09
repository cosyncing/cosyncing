/**
 * A stand-in for Claude's CLI, written as a real executable so the real spawn is what runs.
 *
 * It answers `--version` and the six `plugin` commands with the machine lines Claude Code 2.1.289 printed
 * on Linux (measured 2026-10-05), keeps the two settings keys in the shape the real CLI keeps
 * them in (including the empty-object residue the reversal leaves), and appends every argv it was given
 * to a log next to itself, so a caller can assert the ORDER as well as the content.
 *
 * Two properties the suites lean on:
 *  - The settings file is `$CLAUDE_CONFIG_DIR/settings.json`, read from the ENVIRONMENT the CLI was given.
 *    A runner that dropped the context's environment would leave the variable unset, and the fake then
 *    refuses with `no_config_dir` instead of writing anywhere: it never falls back to `$HOME/.claude`, so a
 *    leak can fail a check but can never touch a real Claude configuration.
 *  - Every invocation records the environment names the mod's lifecycle depends on, plus one probe name
 *    (`COSYNCING_TEST_SECRET`) that an allowlist must NOT pass, so a suite can prove what reached `claude`.
 *
 * Steps can be made to misbehave the three ways a real CLI does: refuse with a failure code, hang until the
 * runner kills it, or answer with something that is not JSON. A hang `exec`s into `sleep`, so the runner's
 * kill reaches the sleeping process itself and leaves no orphan behind; its pid is recorded so a suite that
 * kills the PARENT instead can still stop it.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeClaude {
  bin: string;
  binDir: string;
  configDir: string;
  stateDir: string;
  settingsPath: string;
  /** The `claude plugin` invocations only; the agent preflight's `--version` probe is not part of any sequence. */
  calls(): string[];
  /** One record per invocation: `NAME=value` pairs for the environment names listed above. */
  environments(): Record<string, string>[];
  reset(): void;
  /** Make `plugin <step>` (or `plugin marketplace <step>`) answer `policy_blocked`. */
  refuse(step: string, failureCode?: string): void;
  /** Make the step hang until killed. */
  hang(step: string): void;
  /** Make the step print a line that is not JSON and exit 0. */
  garble(step: string): void;
  clearMisbehaviour(): void;
  /** The pid a hanging step recorded, if one is hanging. */
  hangingPid(): number | undefined;
  /**
   * The state a user leaves behind when they uninstalled inside Claude: cosyncing's marketplace directory
   * still on disk, the plugin entry EMPTIED (measured), and both reversal commands answering not_installed
   * and not_configured. `keepMarketplace` keeps the marketplace key, which is what `plugin uninstall` alone
   * leaves.
   */
  forgetInsideClaude(options?: { keepMarketplace?: boolean }): void;
}

const LOGGED_ENVIRONMENT = [
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'PATH',
  'USER',
  'LANG',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'COSYNCING_HOME',
  'COSYNCING_CACHE_DIR',
  'COSYNCING_CLAUDE_BIN',
  'COSYNCING_TEST_SECRET',
] as const;

export function fakeClaude(root: string, label: string, version: string): FakeClaude {
  const base = join(root, `fake-${label}`);
  const binDir = join(base, 'bin');
  const stateDir = join(base, 'state');
  const configDir = join(base, 'claude-config');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const settingsPath = join(configDir, 'settings.json');
  // Joined with a real tab inside a double-quoted shell word, so each value expands and none is read as a
  // printf format.
  const envLine = LOGGED_ENVIRONMENT
    .map((name) => `${name}=\${${name}-<unset>}`)
    .join('\t');
  // The environment is logged FIRST, with builtins only, and only then is PATH widened for the coreutils
  // this script itself uses: the caller's PATH is part of what is being recorded, and a fixture keeps it
  // narrow on purpose so that no other host executable (a service manager, say) is found through it.
  const script = `#!/bin/sh
STATE=${JSON.stringify(stateDir)}
VERSION=${JSON.stringify(version)}
printf '%s\\n' "$*" >> "$STATE/calls.log"
printf '%s\\n' "${envLine}" >> "$STATE/env.log"
PATH=/usr/bin:/bin
export PATH
if [ "$1" = "--version" ]; then
  printf '%s (Claude Code)\\n' "$VERSION"
  exit 0
fi
if [ -z "$CLAUDE_CONFIG_DIR" ]; then
  printf '{"outcome":"failed","failureCode":"no_config_dir"}\\n'
  exit 1
fi
SETTINGS="$CLAUDE_CONFIG_DIR/settings.json"
mktxt() {
  if [ -f "$STATE/marketplace" ]; then
    printf '{"cosyncing":{"source":{"source":"directory","path":"%s"}}}' "$(cat "$STATE/marketplace")"
  else
    printf '{}'
  fi
}
entxt() {
  if [ -f "$STATE/enabled" ]; then
    printf '{"cosyncing-claude@cosyncing":true}'
  else
    printf '{}'
  fi
}
emit() {
  mkdir -p "$(dirname "$SETTINGS")"
  printf '{"extraKnownMarketplaces":%s,"enabledPlugins":%s}\\n' "$(mktxt)" "$(entxt)" > "$SETTINGS"
}
if [ "$1" != plugin ]; then
  printf '{"outcome":"failed","failureCode":"not_plugin"}\\n'
  exit 1
fi
STEP="$2"
if [ "$2" = marketplace ]; then STEP="$3"; fi
if [ -f "$STATE/misbehave" ]; then
  MODE=$(sed -n 1p "$STATE/misbehave")
  WHICH=$(sed -n 2p "$STATE/misbehave")
  CODE=$(sed -n 3p "$STATE/misbehave")
  if [ "$WHICH" = "$STEP" ]; then
    case "$MODE" in
    refuse)
      printf '{"command":"refused","outcome":"failed","failureCode":"%s"}\\n' "$CODE"
      exit 1
      ;;
    garble)
      printf 'Installed. (this build printed prose instead of JSON)\\n'
      exit 0
      ;;
    hang)
      printf '%s' "$$" > "$STATE/hanging.pid"
      exec sleep 30
      ;;
    esac
  fi
fi
if [ "$2" = marketplace ]; then
  case "$3" in
  add)
    printf '%s' "$4" > "$STATE/marketplace"
    emit
    printf '{"command":"marketplace-add","outcome":"ok","message":"added"}\\n'
    exit 0
    ;;
  update)
    printf '{"command":"marketplace-update","outcome":"ok","message":"updated"}\\n'
    exit 0
    ;;
  remove)
    if [ -f "$STATE/marketplace" ]; then
      rm -f "$STATE/marketplace"
      emit
      printf '{"command":"marketplace-remove","outcome":"ok"}\\n'
      exit 0
    fi
    printf '{"command":"marketplace-remove","outcome":"failed","failureCode":"not_configured"}\\n'
    exit 1
    ;;
  esac
  printf '{"outcome":"failed","failureCode":"unknown_marketplace_command"}\\n'
  exit 1
fi
case "$2" in
install)
  printf 'true' > "$STATE/enabled"
  emit
  printf '{"command":"plugin-install","outcome":"ok","message":"installed"}\\n'
  exit 0
  ;;
update)
  printf '{"command":"plugin-update","outcome":"updated"}\\n'
  exit 0
  ;;
uninstall)
  if [ -f "$STATE/enabled" ]; then
    rm -f "$STATE/enabled"
    emit
    printf '{"command":"plugin-uninstall","outcome":"ok"}\\n'
    exit 0
  fi
  printf '{"command":"plugin-uninstall","outcome":"failed","failureCode":"not_installed"}\\n'
  exit 1
  ;;
esac
printf '{"outcome":"failed","failureCode":"unknown_command"}\\n'
exit 1
`;
  const bin = join(binDir, 'claude');
  writeFileSync(bin, script, { mode: 0o755 });
  chmodSync(bin, 0o755);
  const misbehave = (mode: string, step: string, code = ''): void => {
    writeFileSync(join(stateDir, 'misbehave'), `${mode}\n${step}\n${code}\n`);
  };
  const readLines = (file: string): string[] => {
    try {
      return readFileSync(join(stateDir, file), 'utf8').split('\n').filter((line) => line.length > 0);
    } catch {
      return [];
    }
  };
  return {
    bin,
    binDir,
    configDir,
    stateDir,
    settingsPath,
    calls: () => readLines('calls.log').filter((line) => line.startsWith('plugin ')),
    environments: () => readLines('env.log').map((line) => Object.fromEntries(line.split('\t').map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    }))),
    reset: () => {
      rmSync(join(stateDir, 'calls.log'), { force: true });
      rmSync(join(stateDir, 'env.log'), { force: true });
    },
    refuse: (step, failureCode = 'policy_blocked') => misbehave('refuse', step, failureCode),
    hang: (step) => misbehave('hang', step),
    garble: (step) => misbehave('garble', step),
    clearMisbehaviour: () => {
      rmSync(join(stateDir, 'misbehave'), { force: true });
      rmSync(join(stateDir, 'hanging.pid'), { force: true });
    },
    hangingPid: () => {
      const raw = readLines('hanging.pid')[0];
      const pid = raw ? Number(raw) : NaN;
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    },
    forgetInsideClaude: (options = {}) => {
      rmSync(join(stateDir, 'enabled'), { force: true });
      if (!options.keepMarketplace) rmSync(join(stateDir, 'marketplace'), { force: true });
      const marketplace = options.keepMarketplace
        ? (() => {
            try {
              return readFileSync(join(stateDir, 'marketplace'), 'utf8');
            } catch {
              return undefined;
            }
          })()
        : undefined;
      writeFileSync(settingsPath, `${JSON.stringify({
        extraKnownMarketplaces: marketplace
          ? { cosyncing: { source: { source: 'directory', path: marketplace } } }
          : {},
        enabledPlugins: {},
      })}\n`);
    },
  };
}
