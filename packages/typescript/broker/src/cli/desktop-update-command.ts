import type { CliWriter } from './cli.ts';
import { acknowledgeDesktopUpdate, armDesktopUpdate, cancelDesktopUpdate, inspectDesktopUpdater,
  prepareDesktopUpdate, inspectDesktopUpdateProgress, runDesktopUpdate,
  type DesktopUpdateDependencies, type DesktopUpdateJob } from '../updates/desktop-update.ts';

/** Only sanitized progress crosses the local process boundary. */
function publicJob(job: DesktopUpdateJob) {
  return { schemaVersion: 1, id: job.id, releaseId: job.releaseId, version: job.version,
    phase: job.phase, detailCode: job.detailCode, updatedAt: job.updatedAt,
    installationId: job.installationId };
}

export async function runDesktopUpdateCommand(args: string[], deps: DesktopUpdateDependencies,
  stdout: CliWriter): Promise<number> {
  try {
    const [action, ...rest] = args;
    if (!action || !['inspect', 'prepare', 'apply', 'status', 'cancel', 'ack', 'run'].includes(action)) {
      throw new Error('desktop-update-command-invalid');
    }
    const values = new Map<string, string>();
    let id: string | undefined;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!;
      if (index === 0 && !arg.startsWith('--')) { id = arg; continue; }
      if (!['--pid', '--executable', '--release', '--version'].includes(arg)
          || values.has(arg) || !rest[index + 1] || rest[index + 1]!.startsWith('--')) {
        throw new Error('desktop-update-command-invalid');
      }
      values.set(arg, rest[++index]!);
    }
    const pid = Number(values.get('--pid'));
    let result: unknown;
    if (action === 'inspect') {
      if (id || (values.size !== 2 && values.size !== 3)) throw new Error('desktop-update-command-invalid');
      result = inspectDesktopUpdater(deps, pid, values.get('--executable') ?? '', values.get('--version'));
    } else {
      if (!id) throw new Error('desktop-update-command-invalid');
      if (action === 'prepare') {
        if (values.size !== 3) throw new Error('desktop-update-command-invalid');
        result = publicJob(await prepareDesktopUpdate(deps, { id, pid,
          executable: values.get('--executable') ?? '', releaseId: values.get('--release') ?? '' }));
      } else if (action === 'ack') {
        if (values.size !== 2) throw new Error('desktop-update-command-invalid');
        result = acknowledgeDesktopUpdate(deps, id, pid, values.get('--version') ?? '');
      } else {
        if (values.size !== 0) throw new Error('desktop-update-command-invalid');
        result = publicJob(action === 'apply' ? await armDesktopUpdate(deps, id)
          : action === 'run' ? await runDesktopUpdate(deps, id)
          : action === 'cancel' ? cancelDesktopUpdate(deps, id) : await inspectDesktopUpdateProgress(deps, id));
      }
    }
    stdout.write(`${JSON.stringify({ ok: true, ...result as object })}\n`);
    return 0;
  } catch (error) {
    const detailCode = error instanceof Error && /^[a-z0-9-]{1,100}$/.test(error.message)
      ? error.message : 'desktop-update-failed';
    stdout.write(`${JSON.stringify({ ok: false, detailCode })}\n`);
    return 1;
  }
}
