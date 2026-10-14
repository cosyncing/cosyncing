/** Pi conformance kit: the shared Pi-family profile and fake (`pi-family.ts`) plus Pi's extras (`pi-extras.ts`). */
import { piFamilyExtras } from './pi-extras.ts';
import { PI_DIALECT_FACTS, piFamilyKit } from './pi-family.ts';

export const piKit = piFamilyKit(PI_DIALECT_FACTS, piFamilyExtras(PI_DIALECT_FACTS));
