#!/usr/bin/env bun
/**
 * The managed Cline Hub must never bind the owner's own Hub port.
 *
 * Every ownership guarantee in the Cline adapter rests on the managed Hub
 * living at an address the owner's personal `cline` does not use. 3.0.61 made
 * that boundary easier to cross by accident: it moved the daemon's address out
 * of argv and into the environment, so a single wrong value in
 * `COSYNCING_CLINE_HUB_PORT` is enough to point a broker-managed daemon at
 * 25463 — where the owner's Hub is expected to be. Nothing rejected it.
 *
 * Two guards, tested here. The adapter refuses the value when resolving, and
 * the service writer refuses to persist it, so a typo never reaches
 * `broker.env` where it would later read as a reviewed decision.
 */
export {};
import {
  CLINE_MANAGED_HUB_PORT,
  CLINE_OWNER_DEFAULT_HUB_PORT,
  clineManagedHubPort,
} from '../../../adapters/cline/src/hub.ts';
import { serviceAgentConfigurationOverrides } from '../../src/installation/service-manager.ts';

let failures = 0;
let total = 0;

function check(name: string, ok: boolean, detail?: string): void {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

// Pinned to their literal values rather than compared to each other: both carry
// literal types, so `owner !== managed` is a compile-time tautology TS rejects
// outright. Asserting each value separately is the stronger check anyway — it
// catches a future edit that moves either port, not just one that collapses
// them onto the same number.
const ownerPort: number = CLINE_OWNER_DEFAULT_HUB_PORT;
const managedPort: number = CLINE_MANAGED_HUB_PORT;
check('the owner default and the managed port are the two expected, distinct ports',
  ownerPort === 25_463 && managedPort === 25_464,
  `owner=${ownerPort} managed=${managedPort}`);

// The adapter side.
{
  const resolved = clineManagedHubPort({
    COSYNCING_CLINE_HUB_PORT: String(CLINE_OWNER_DEFAULT_HUB_PORT),
  });
  check('resolving refuses the owner default and falls back to the managed port',
    resolved === CLINE_MANAGED_HUB_PORT, `resolved=${resolved}`);
}
{
  // Whitespace must not smuggle it past the comparison: the resolver trims
  // before parsing, so " 25463 " has to be refused exactly like "25463".
  const resolved = clineManagedHubPort({ COSYNCING_CLINE_HUB_PORT: '  25463  ' });
  check('a padded owner default is refused too', resolved === CLINE_MANAGED_HUB_PORT,
    `resolved=${resolved}`);
}
{
  const resolved = clineManagedHubPort({ COSYNCING_CLINE_HUB_PORT: '25465' });
  check('an ordinary configured port is still honored', resolved === 25_465,
    `resolved=${resolved}`);
}
{
  const resolved = clineManagedHubPort({});
  check('an unset port resolves to the managed default', resolved === CLINE_MANAGED_HUB_PORT,
    `resolved=${resolved}`);
}

// The service-writer side.
{
  const overrides = serviceAgentConfigurationOverrides({
    COSYNCING_CLINE_HUB_PORT: String(CLINE_OWNER_DEFAULT_HUB_PORT),
  }, 'linux');
  check('the owner default is never persisted to the service environment',
    overrides.COSYNCING_CLINE_HUB_PORT === undefined,
    JSON.stringify(overrides));
}
{
  const overrides = serviceAgentConfigurationOverrides({
    COSYNCING_CLINE_HUB_PORT: '25465',
  }, 'linux');
  check('an ordinary configured port is still persisted',
    overrides.COSYNCING_CLINE_HUB_PORT === '25465', JSON.stringify(overrides));
}
{
  // The Windows branch looks the name up case-insensitively, which is a second
  // path into the same field and therefore a second way to smuggle the port in.
  const overrides = serviceAgentConfigurationOverrides({
    cosyncing_cline_hub_port: String(CLINE_OWNER_DEFAULT_HUB_PORT),
  } as Record<string, string>, 'win32');
  check('the case-insensitive Windows lookup refuses it as well',
    overrides.COSYNCING_CLINE_HUB_PORT === undefined, JSON.stringify(overrides));
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${total - failures}/${total} owner-port refusal checks passed.`);
if (failures > 0) process.exit(1);
