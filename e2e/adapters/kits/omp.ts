/** omp conformance kit: the shared Pi-family profile and fake (`pi-family.ts`) plus omp's extras (`pi-extras.ts`). */
import { piFamilyExtras } from './pi-extras.ts';
import { OMP_DIALECT_FACTS, piFamilyKit } from './pi-family.ts';

export const ompKit = piFamilyKit(OMP_DIALECT_FACTS, piFamilyExtras(OMP_DIALECT_FACTS));
