#!/usr/bin/env bun
/**
 * Prints the handoff document the broker serves at `/cosy-handoff` (N3b).
 *
 * One source of truth, two consumers. The broker owns the document; the
 * real-browser regression in `tests/test-startup-shell-browser.mjs` runs under
 * plain node against its own deterministic server and cannot import the
 * broker's TypeScript, so it shells out to this instead of keeping a second
 * copy that would drift.
 *
 *   bun run scripts/client/print-web-handoff.ts
 */
import { WEB_HANDOFF_DOCUMENT } from '../../packages/typescript/broker/src/artifacts/web-handoff.ts';

process.stdout.write(WEB_HANDOFF_DOCUMENT);
