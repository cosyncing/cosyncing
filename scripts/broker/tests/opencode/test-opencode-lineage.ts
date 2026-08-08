/**
 * Headless regression for the OpenCode adapter's roster LINEAGE mapping — the parentage that lets
 * the app nest sub-agent (Task) sessions under the session that spawned them instead of scattering
 * them across the roster as unrelated top-level rows.
 *
 * Zero-cost: pure function, no `opencode`, no serve, no model. The shape asserted here is the SAME
 * one codex emits (origin + parentThreadId + nativeId), which is what keeps the client's grouping
 * agent-neutral: it resolves `child.parentThreadId` against each row's `nativeId`, never a tool name
 * or a title heuristic.
 *
 *   bun run scripts/broker/tests/opencode/test-opencode-lineage.ts     (exit 0 = all pass)
 */
export {};
import { opencodeLineage } from '../../../../packages/typescript/adapters/opencode/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

{
  // A sub-agent child: OpenCode records the spawning session in `parentID`.
  const child = opencodeLineage({ id: 'ses_child1', parentID: 'ses_parent' });
  check(
    'sub-agent session classifies origin subagent + parent id',
    child.origin === 'subagent' && child.parentThreadId === 'ses_parent',
    JSON.stringify(child),
  );
  check(
    'sub-agent session carries its OWN native id (so nested children can resolve to it)',
    child.nativeId === 'ses_child1',
    JSON.stringify(child),
  );

  // A normal, human-started session: no positive evidence of a parent ⇒ no origin tag, so it stays
  // a visible top-level row (the app hides only rows it can prove are automated).
  const top = opencodeLineage({ id: 'ses_parent' });
  check(
    'top-level sessions carry NO origin tag and NO parent id',
    top.origin === undefined && top.parentThreadId === undefined,
    JSON.stringify(top),
  );
  check('top-level sessions still carry nativeId', top.nativeId === 'ses_parent', JSON.stringify(top));

  // An empty/absent parentID is NOT evidence of a sub-agent.
  const blank = opencodeLineage({ id: 'ses_x', parentID: '' });
  check('an empty parentID does not fabricate a sub-agent tag', blank.origin === undefined, JSON.stringify(blank));

  // The exact rule the client uses to group: a child's parentThreadId must equal the parent row's
  // nativeId, within the same tool. Mirrors SessionRosterProjection.build().
  const parentRow = opencodeLineage({ id: 'ses_parent' });
  const childRow = opencodeLineage({ id: 'ses_child2', parentID: 'ses_parent' });
  check(
    "a child's parentThreadId resolves to the parent row's nativeId (client grouping rule)",
    childRow.parentThreadId === parentRow.nativeId,
    `${childRow.parentThreadId} → ${parentRow.nativeId}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
