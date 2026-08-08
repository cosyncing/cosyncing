#!/usr/bin/env node
/*
 * Postinstall swap.
 *
 * Replace this package's `bin/cosyncing` — which ships as a Node resolver — with the actual platform
 * binary, so every steady-state invocation execs the broker directly. npm links the global command as a
 * symlink to that path, so overwriting the file in place redirects the command without touching the link.
 *
 * Two outcomes are NOT the same and are handled differently:
 *
 *   1. The platform package is present and only the swap fails (cross-device link, read-only package dir).
 *      Non-fatal: the resolver it would have replaced is a correct, fully functional launcher, so the cost
 *      is one extra process per invocation. Failing the install would turn a performance detail into a
 *      broken install.
 *
 *   2. The platform package is ABSENT on a host we publish a binary for. Nothing can run cosyncing, and
 *      exiting 0 would let `npm install -g cosyncing` report success while installing no usable broker.
 *      That is a lie, so this fails loudly and names the causes that actually produce it.
 *
 * Unsupported hosts (anything outside the published set) exit 0 by design: npm evaluates the os/cpu
 * constraints and legitimately installs none of the platform packages, and the resolver already prints an
 * accurate "no broker binary for <host>" message if the command is ever invoked. Failing the install there
 * would break `npm install cosyncing` as a transitive dependency on an unrelated machine.
 *
 * Installs that skip lifecycle scripts never reach this file at all; the resolver covers them.
 */
'use strict';

const { chmodSync, copyFileSync, linkSync, renameSync, rmSync, writeSync } = require('node:fs');
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
 * where control flow can actually reach the end — not from inside an event callback with handles still
 * open, which is exactly where the resolver's error paths live. One rule that holds everywhere beats two
 * rules that each hold somewhere.
 */
function fail(message) {
  writeSync(2, message);
  process.exit(1);
}

/** Hosts a platform package is published for; must stay in step with NPM_TARGETS in build-npm-package.ts. */
const SUPPORTED_HOSTS = ['linux-x64', 'linux-arm64', 'darwin-arm64'];

const host = `${process.platform}-${process.arch}`;
const platformPackage = `@cosyncing/broker-${host}`;

function resolvePlatformBinary() {
  try {
    return require.resolve(`${platformPackage}/bin/cosyncing`);
  } catch {
    return undefined;
  }
}

const source = resolvePlatformBinary();
if (!source) {
  if (!SUPPORTED_HOSTS.includes(host)) process.exit(0);
  fail(
    `cosyncing: ${platformPackage} was not installed, so no broker binary is available for ${host}.\n`
      + 'This usually means optional dependencies were skipped (--omit=optional / --no-optional), or a\n'
      + 'lockfile pruned for another platform was used. Reinstall with optional dependencies enabled.\n',
  );
}

try {
  const target = join(__dirname, 'bin', 'cosyncing');
  // Stage beside the target and rename, so an interrupted swap can never leave a truncated command.
  const staged = `${target}.${process.pid}.tmp`;
  rmSync(staged, { force: true });
  try {
    linkSync(source, staged);
  } catch {
    copyFileSync(source, staged);
  }
  chmodSync(staged, 0o755);
  renameSync(staged, target);
} catch {
  /* the shipped resolver remains in place and works; never fail the install over a swap failure */
}
process.exit(0);
