import type { BrokerConfigInspection } from './configuration.ts';

/**
 * Whether cosyncing's Claude true-sync kill switch is ON, from one reading of the broker config.
 *
 * ON means "do not hold": every prompt falls back to the terminal. A config that is missing reads as
 * the defaults, which is what the broker itself does with a missing file. A config that is there and
 * will not read, will not parse, or will not validate reads as ON. A broker that cannot read its own
 * settings has no business parking a person's terminal on an approval it may not be allowed to give,
 * and a file that is half-written by an editor is exactly the moment somebody is changing that answer.
 */
export function claudeTrueSyncKillSwitchFrom(inspection: BrokerConfigInspection, hostDefault: boolean): boolean {
  if (inspection.status === 'missing') return !hostDefault;
  if (inspection.status !== 'ok') return true;
  return !(inspection.config.features?.claudeTrueSyncMod ?? hostDefault);
}
