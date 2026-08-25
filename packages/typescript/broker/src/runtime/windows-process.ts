/** Compatibility export for the broker test path; implementation lives at the shared adapter boundary. */
export {
  captureWindowsProcessSnapshot,
  HostProcessProvider as WindowsProcessProvider,
  parseWindowsProcessSnapshot,
  terminateHostProcessTree as terminateWindowsProcessTree,
  type WindowsListenerEntry,
  type WindowsProcessEntry,
  type WindowsProcessSnapshot,
  type WindowsProcessSnapshotRunner,
} from '@cosyncing/adapter-api';
