/**
 * Type shim so repo-side tsc can check code that imports the pi extension module
 * (test-pi-bridge-rehello.ts). The real `@earendil-works/pi-coding-agent` package only exists inside
 * a pi installation; the bridge imports it as `import type` only, so runtime (bun) never needs it.
 */
declare module '@earendil-works/pi-coding-agent' {
  export type ExtensionAPI = any;
}
