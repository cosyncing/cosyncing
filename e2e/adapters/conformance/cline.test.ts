/** Cline (the managed Hub daemon, isolated profile, Drive through `run.start`) against the shared adapter conformance scenarios. */
import { describe } from 'bun:test';
import { clineKit } from '../kits/cline.ts';
import { conformanceSuite } from './scenarios.ts';

// The Hub is a compiled fake whose process identity the broker proves (/proc, lsof): POSIX only.
if (process.platform === 'win32') describe.skip('Cline adapter conformance', () => undefined);
else conformanceSuite(clineKit);
