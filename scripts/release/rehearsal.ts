/** Manual release rehearsals are confined to public branch dispatches. */
export function isReleaseRehearsal(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RELEASE_REHEARSAL !== 'true') return false;
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF_TYPE !== 'branch'
    || env.GITHUB_REPOSITORY !== 'cosyncing/cosyncing' || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '')) {
    throw new Error('release rehearsal requires a public branch workflow_dispatch at an exact commit');
  }
  return true;
}
