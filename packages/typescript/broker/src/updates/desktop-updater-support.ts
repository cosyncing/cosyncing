import type { DesktopClientHost } from './desktop-client-types.ts';
import type { BrokerServiceProvider } from '../runtime/service-boundary.ts';

export const DESKTOP_UPDATE_HELPER_VERSION = '1.0.0';
export const DESKTOP_HELPER_RESOURCE_ID = 'desktop-update-helper';

/**
 * Signed feed enablement is separate from compiling the native adapter. Keep a
 * host absent until replacement, relaunch, failed-start recovery and tray exit
 * have been accepted on that host with this helper format. An empty list ships
 * the bootstrap helper and truthful download guidance, never a false promise.
 */
export const QUALIFIED_DESKTOP_UPDATER_HOSTS: readonly DesktopClientHost[] = [];

/** Native providers require independent handoff, restart and rollback acceptance.
 * Windows uses the isolated signed-upgrade journey in the native Windows suite. */
export const QUALIFIED_BROKER_UPDATE_PROVIDERS: readonly BrokerServiceProvider[] = ['systemd', 'task-scheduler'];
