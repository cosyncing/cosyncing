/** OpenCode (shared serve, the product default) against the shared adapter conformance scenarios. */
import { opencodeKit, opencodeV2Kit } from '../kits/opencode.ts';
import { conformanceSuite } from './scenarios.ts';

conformanceSuite(opencodeKit);
conformanceSuite(opencodeV2Kit, 'OpenCode V2');
