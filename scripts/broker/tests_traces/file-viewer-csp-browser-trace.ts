/**
 * Compatibility entry point for the opt-in file viewer policy trace.
 * The maintained real-app HTML interaction/isolation/lifecycle scenarios now
 * live in the existing web-artifacts suite, using isolated fixture brokers and
 * a request-recording server. Build the web client before this standalone run.
 */
export {};

const child = Bun.spawn([
  'bun', 'test', '--timeout', '120000',
  './e2e/web/web-artifacts.test.ts', '--test-name-pattern', 'HTML',
], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
