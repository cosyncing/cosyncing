import { inspectBrokerToken, readBrokerToken } from '../../packages/typescript/broker/src/security/credentials.ts';

/** Read review API state without putting credentials in argv, URLs, or logs. */
export async function reviewBrokerRequest(url: string, tokenFile: string, timeoutMs: number): Promise<string> {
  const inspection = inspectBrokerToken(tokenFile);
  if (inspection.status !== 'ok' && inspection.status !== 'missing') {
    throw new Error('Review broker credential is unsafe or unreadable');
  }
  const headers: Record<string, string> = inspection.status === 'ok'
    ? { 'x-cosyncing-token': readBrokerToken(tokenFile) } : {};
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Review API returned HTTP ${response.status}`);
  return response.text();
}

if (import.meta.main) {
  const [url, tokenFile, timeout] = process.argv.slice(2);
  if (!url || !tokenFile || !/^\d+$/.test(timeout ?? '') || Number(timeout) < 1) {
    throw new Error('Expected review URL, credential file, and positive timeout');
  }
  try { process.stdout.write(await reviewBrokerRequest(url, tokenFile, Number(timeout))); }
  catch { console.error('Review API request failed; credential values are not logged'); process.exitCode = 1; }
}
