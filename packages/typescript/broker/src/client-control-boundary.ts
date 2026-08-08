import { trustTierForAddress } from './r2-policy.ts';

/** Authentication and filesystem trust are deliberately separate decisions. */
export function remoteFilesystemAllowed(address: string | undefined, explicitRemoteEnable: boolean): boolean {
  return trustTierForAddress(address) === 'T1' || explicitRemoteEnable;
}
