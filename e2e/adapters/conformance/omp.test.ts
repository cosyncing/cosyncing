/** omp (oh-my-pi) against the shared adapter conformance scenarios (see scenarios.ts). */
import { ompKit } from '../kits/omp.ts';
import { conformanceSuite } from './scenarios.ts';

conformanceSuite(ompKit);
