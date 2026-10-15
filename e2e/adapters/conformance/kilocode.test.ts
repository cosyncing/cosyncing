/** Kilo Code (the managed `kilo serve`, SQLite store, `mode=live` Drive) against the shared adapter conformance scenarios. */
import { describe } from 'bun:test';
import { kilocodeKit } from '../kits/kilocode.ts';
import { conformanceSuite } from './scenarios.ts';

// The managed serve is a compiled fake whose process identity the broker proves (/proc, lsof): POSIX only.
if (process.platform === 'win32') describe.skip('Kilo Code adapter conformance', () => undefined);
else conformanceSuite(kilocodeKit);
