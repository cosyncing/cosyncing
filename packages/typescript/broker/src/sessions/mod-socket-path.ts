/**
 * Where the Claude mod's socket lives, spelled once for both sides of it.
 *
 * The broker binds it (`mod-socket-server.ts`) and setup stamps the same path into the installed copy
 * of the mod (`installation/claude-mod-ownership.ts`), so a terminal that does not carry the broker's
 * environment still dials the right broker. Two copies of the name or the ceiling would let the stamp
 * and the bind disagree, and the mod would dial a socket nobody listens on.
 */

/** Socket file name inside the state directory. */
export const MOD_SOCKET_FILENAME = 'claude-mod.sock';

/**
 * The length ceiling we hold ourselves to, tighter than the kernel's. macOS `sun_path` allows
 * 104 bytes, but the mod's own `HttpInit.socketPath` is documented as "near 100 B at most",
 * absolute, no NUL. CI temp roots and a deep `COSYNCING_HOME` eat the budget fast, so the bind
 * fails loudly with a named reason rather than truncating a path and failing later, elsewhere.
 */
export const MOD_SOCKET_PATH_MAX_BYTES = 100;

/**
 * True when a path is one the mod may be told to dial: absolute, no NUL or line break, and inside
 * the ceiling. The broker's bind refuses the same three things, so a path this accepts is one the
 * broker could actually listen on.
 */
export function modSocketPathDialable(path: string): boolean {
  return path.startsWith('/')
    && !/[\0\r\n]/.test(path)
    && Buffer.byteLength(path, 'utf8') <= MOD_SOCKET_PATH_MAX_BYTES;
}
