/**
 * @cosyncing/adapter-dsh — the narrow broker-facing facade.
 *
 * Only what the broker composes with: the adapter class and the host link it
 * owns. The RPC client, the downlink socket manager, the mapping, the session
 * connection, the write path, and the diagnosis all stay package-internal, so no
 * dsh-shaped payload or transport handle can be reached from outside; the
 * package's own tests import those modules directly by path.
 */
export * from './implementation.ts';
