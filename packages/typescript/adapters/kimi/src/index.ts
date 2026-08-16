/**
 * @cosyncing/adapter-kimi — the narrow broker-facing facade.
 *
 * Only what the broker composes with: the adapter class and the registration
 * gate. The read-only HTTP door, the instance registry, the mapping, the
 * observe connection, and the diagnosis all stay package-internal so no
 * Kimi-shaped payload or transport handle can be reached from outside; the
 * package's own tests import those modules directly by path.
 */
export * from './implementation.ts';
