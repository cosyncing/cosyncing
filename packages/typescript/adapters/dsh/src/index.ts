/**
 * @cosyncing/adapter-dsh — the narrow broker-facing facade.
 *
 * Only what the broker composes with: the adapter class and the host link it
 * owns, plus the handful of enrollment primitives a broker CLI has to hold to
 * obtain a session cookie on an operator's behalf. The RPC client, the downlink
 * socket manager, the mapping, the session connection, the write path, and the
 * diagnosis all stay package-internal, so no dsh-shaped payload or transport
 * handle can be reached from outside; the package's own tests import those
 * modules directly by path.
 *
 * The enrollment surface is deliberately the smallest thing that lets `cosy dsh
 * connect` do the exchange rather than reimplement it: parse the URL the host
 * printed, compute the same credential scope the adapter will look up, and run
 * the same state machine. A CLI that hand-rolled the exchange would be a second
 * implementation of redirect handling and cookie recognition, and the second
 * implementation is where the token leaks.
 */
export * from './implementation.ts';
export {
  DshAuthSession,
  dshApplicationUrl,
  dshCookieNameForOrigin,
  dshCredentialScope,
  parseDshLaunchUrl,
  DshAuthUrlError,
  type DshAuthOutcome,
  type DshAuthState,
  type DshCookie,
  type DshCredentialStore,
  type DshLaunchUrl,
} from './auth.ts';
export {
  classifyDshVersion,
  DSH_QUALIFIED_VERSIONS,
  type DshContractFamily,
  type DshVersionVerdict,
} from './compatibility.ts';
export { resolveDshHome } from './diagnostics.ts';
export { DSH_BASE_URL_ENV, DSH_DEFAULT_BASE_URL, resolveDshBaseUrl } from './server.ts';
