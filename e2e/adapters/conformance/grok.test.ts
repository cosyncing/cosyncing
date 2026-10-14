/** Grok Build against the shared adapter conformance scenarios (see scenarios.ts). */
import { grokKit } from '../kits/grok.ts';
import { conformanceSuite } from './scenarios.ts';

conformanceSuite(grokKit);
