/**
 * The mod's own unit tests (mods/cosyncing-claude/hooks/register.test.ts), run in `check`.
 *
 * That file is written for `claude plugin test`, which supplies `claude-code/testing` and needs a
 * supported Claude on the machine, so until now CI never ran it: a change to the answer rule, the
 * input summary or the socket order could ship with the mod's own tests red. This runner supplies
 * the part of `claude-code/testing` those tests use -- `test`, `describe` and `expect` with the
 * matchers below -- as a virtual module, imports the real file against the real register.js, and
 * runs every test it registered.
 *
 * It is a shim, and it says so where it cannot stand in: a test whose body takes the engine's `$`
 * (`test(name, async ($, on) => ...)`) is FAILED here, not skipped, because only Claude's own
 * harness can give it a real `$`. Such a test belongs in a file `claude plugin test` runs, or in a
 * seam suite with a real ModSocketServer.
 *
 *   bun run packages/typescript/broker/test/claude/test-claude-mod-register-unit.ts   (exit 0 = all pass)
 */
import { plugin } from 'bun';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testFile = join(here, '..', '..', '..', '..', '..', 'mods', 'cosyncing-claude', 'hooks', 'register.test.ts');

interface Registered {
  name: string;
  body: (...args: unknown[]) => unknown;
}
const registered: Registered[] = [];
const prefixes: string[] = [];

class ExpectationFailed extends Error {}

function describeValue(value: unknown): string {
  try {
    return typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value) ?? value);
  } catch {
    return String(value);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function matchers(actual: unknown, negate: boolean) {
  const assert = (ok: boolean, what: string): void => {
    if (ok === negate) throw new ExpectationFailed(`expected ${describeValue(actual)} ${negate ? 'not ' : ''}${what}`);
  };
  return {
    toBe: (expected: unknown) => assert(Object.is(actual, expected), `to be ${describeValue(expected)}`),
    toEqual: (expected: unknown) => assert(deepEqual(actual, expected), `to equal ${describeValue(expected)}`),
    toBeLessThan: (bound: number) => assert(typeof actual === 'number' && actual < bound, `to be less than ${bound}`),
    toBeGreaterThan: (bound: number) => assert(typeof actual === 'number' && actual > bound, `to be greater than ${bound}`),
    toBeTruthy: () => assert(Boolean(actual), 'to be truthy'),
    toBeFalsy: () => assert(!actual, 'to be falsy'),
    toContain: (item: unknown) => assert(
      (typeof actual === 'string' && typeof item === 'string' && actual.includes(item))
        || (Array.isArray(actual) && actual.some((entry) => deepEqual(entry, item))),
      `to contain ${describeValue(item)}`,
    ),
    toMatch: (pattern: RegExp | string) => assert(
      typeof actual === 'string' && (typeof pattern === 'string' ? actual.includes(pattern) : pattern.test(actual)),
      `to match ${String(pattern)}`,
    ),
  };
}

function expect(actual: unknown) {
  // Anything the file reaches for that is not here fails by name, rather than as an undefined call.
  const wrap = (negate: boolean) => new Proxy(matchers(actual, negate), {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      throw new ExpectationFailed(`matcher ${String(key)} is not provided by this runner; run the file under \`claude plugin test\` or add it here`);
    },
  });
  return Object.assign(wrap(false), { not: wrap(true) });
}

plugin({
  name: 'claude-code-testing-shim',
  setup(build) {
    build.module('claude-code/testing', () => ({
      loader: 'object',
      exports: {
        test: (name: string, body: Registered['body']) => {
          registered.push({ name: [...prefixes, name].join(' › '), body });
        },
        describe: (name: string, body: () => void) => {
          prefixes.push(name);
          try {
            body();
          } finally {
            prefixes.pop();
          }
        },
        expect,
      },
    }));
  },
});

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

try {
  await import(testFile);
} catch (error) {
  check('the mod test file loads', false, String((error as Error)?.stack ?? error).slice(0, 300));
}
check('the mod test file registered tests', registered.length > 0, `${registered.length} registered`);

for (const entry of registered) {
  if (entry.body.length > 0) {
    check(entry.name, false, "this test takes the engine's `$`, which only `claude plugin test` can supply");
    continue;
  }
  try {
    await entry.body();
    check(entry.name, true);
  } catch (error) {
    check(entry.name, false, String((error as Error)?.message ?? error).slice(0, 240));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
