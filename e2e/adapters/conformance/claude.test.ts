/** Claude Code against the shared adapter conformance scenarios (see scenarios.ts). */
import { claudeKit } from '../kits/claude.ts';
import { conformanceSuite } from './scenarios.ts';

conformanceSuite(claudeKit);
