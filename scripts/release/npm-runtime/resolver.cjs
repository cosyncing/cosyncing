#!/usr/bin/env node
/*
 * Fallback launcher for the `cosyncing` / `cosy` commands.
 *
 * The postinstall step normally REPLACES this file with the platform package's binary, so a normal install
 * execs the broker directly with no Node process in between — that is what keeps stdio, TTY ownership,
 * signal delivery, and the CLI's distinct exit codes (0/1/2/3/4) untouched.
 *
 * This code therefore runs only when that swap could not happen: `npm install --ignore-scripts`, a
 * read-only package directory, or a package manager that skips lifecycle scripts. It has to be a faithful
 * stand-in rather than a stub, so it inherits stdio, forwards the signals a long-running broker cares
 * about, and reproduces the child's exit code — or re-raises its terminating signal so the shell sees the
 * same cause of death it would have seen from the binary itself.
 */
'use strict';

const { spawn } = require('node:child_process');
const { existsSync, writeSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Write to stderr in a way that survives the very next line.
 *
 * `process.stderr.write` is only synchronous when fd 2 is a file or a TTY. Under npm, CI, or any capture,
 * it is a PIPE — and there the write is queued, so `process.exit()` on the following line tears the process
 * down before the queue drains and the operator sees nothing at all. That is precisely the case where this
 * message is the only evidence of what went wrong. `writeSync` goes straight to the descriptor and has
 * already been delivered when it returns, on every fd type.
 *
 * The alternative (setting `process.exitCode` and letting the process end naturally) also works, but only
 * where control flow can actually reach the end — not from inside the `child.on('error')` callback below,
 * which still holds an open child handle. One rule that holds everywhere beats two rules that each hold
 * somewhere.
 */
function fail(message) {
  writeSync(2, message);
  process.exit(1);
}

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/**
 * Tell the broker where the bundled web app is.
 *
 * A packaged broker resolves its web root as `dirname(<running executable>)/cosyncing-web-<version>`. After
 * the normal postinstall swap the executable IS this package's `bin/cosyncing`, so it finds the sidecar with
 * no help. On this path the swap did not happen and we are about to exec the PLATFORM package's binary
 * instead, whose directory holds nothing but the binary — so hand it the answer through COSYNCING_WEB_DIR,
 * the same documented override setup uses to tell a durable service where its sidecar is. An operator's own
 * COSYNCING_WEB_DIR always wins.
 */
function webSidecarEnvironment() {
  if (process.env.COSYNCING_WEB_DIR) return {};
  let version;
  try {
    version = require('../package.json').version;
  } catch {
    return {};
  }
  if (typeof version !== 'string' || !version) return {};
  const sidecar = join(__dirname, `cosyncing-web-${version}`);
  return existsSync(join(sidecar, 'index.html')) ? { COSYNCING_WEB_DIR: sidecar } : {};
}

function platformPackage() {
  return `@cosyncing/broker-${process.platform}-${process.arch}`;
}

function resolveBinary() {
  try {
    // The platform packages deliberately declare no `exports`, so this subpath resolution works and stays
    // independent of where the package manager physically placed them.
    return require.resolve(`${platformPackage()}/bin/cosyncing`);
  } catch {
    return undefined;
  }
}

const binary = resolveBinary();
if (!binary) {
  fail(
    `cosyncing: no broker binary is installed for ${process.platform}-${process.arch}.\n`
      + `Supported hosts are Linux x64/arm64 and Apple Silicon macOS.\n`
      + `If this host is supported, reinstall without --ignore-scripts so ${platformPackage()} is fetched.\n`,
  );
}

const child = spawn(binary, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ...webSidecarEnvironment() },
});

const forward = (signal) => {
  try {
    child.kill(signal);
  } catch {
    /* the child is already gone; nothing to forward to */
  }
};
for (const signal of FORWARDED_SIGNALS) process.on(signal, () => forward(signal));

child.on('error', (error) => {
  fail(`cosyncing: could not start the broker binary: ${error.message}\n`);
});

child.on('exit', (code, signal) => {
  for (const name of FORWARDED_SIGNALS) process.removeAllListeners(name);
  if (signal) {
    // Re-raise rather than translating to an exit code, so `$?` and any supervising process observe the
    // same termination the binary itself would have produced.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});
