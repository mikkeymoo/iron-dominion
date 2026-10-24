import { ARCH, BFLAG } from './catalog.ts';
import { BMAX, type World } from './layers.ts';

// Megaproject balance and stage data. A megaproject is a placeable catalog building that robots build in several stages: each
// stage is a construction pass with its own material need and builder-ticks of work (robots/jobs.ts advances bLevel, the stage
// index, when a pass completes). While it is under construction bLevel is the stage being built; once complete it is
// `stages.length`, which the renderer reads as the finished model.

export interface MegaStage { name: string; /** Material units this pass needs. */ material: number; /** Builder-ticks of work: one builder at 1x. */ work: number }

export interface MegaSpec {
  stages: MegaStage[];
  /** Requirements checked when the project is started: population, and spare rated power (MW) and water (ML) in the city. */
  req: { pop: number; power: number; water: number };
  /** Draw while operating (the utilities solve serves it like any consumer). */
  powerUse: number;
  waterUse: number;
  /** Effects while operating: rated output (MW), residents, commercial jobs, visitors (they add commercial demand), monthly income. */
  mw: number;
  residents: number;
  jobsC: number;
  visitors: number;
  income: number;
  /** Land value bonus at the centre and the Chebyshev radius it fades out to. */
  aura: { value: number; radius: number };
}

export const MEGA: Readonly<Record<number, MegaSpec>> = {
  [ARCH.FUSION_SPIRE]: {
    stages: [
      { name: 'Foundation ring', material: 120, work: 5000 },
      { name: 'Containment spire', material: 160, work: 6500 },
      { name: 'Plasma core', material: 200, work: 8000 },
    ],
    req: { pop: 25000, power: 0, water: 80 },
    powerUse: 0, waterUse: 40, mw: 2000, residents: 0, jobsC: 0, visitors: 0, income: 0,
    aura: { value: 40, radius: 14 },
  },
  [ARCH.ARCOLOGY]: {
    stages: [
      { name: 'Foundations', material: 150, work: 6000 },
      { name: 'Lower terraces', material: 200, work: 8000 },
      { name: 'Upper terraces', material: 250, work: 9000 },
      { name: 'Gardens and crown', material: 300, work: 10000 },
    ],
    req: { pop: 30000, power: 150, water: 220 },
    powerUse: 90, waterUse: 140, mw: 0, residents: 5000, jobsC: 600, visitors: 0, income: 6000,
    aura: { value: 0, radius: 0 },
  },
  [ARCH.MECH_ARENA]: {
    stages: [
      { name: 'Bowl excavation', material: 100, work: 5000 },
      { name: 'Stands', material: 140, work: 6500 },
      { name: 'Floodlights and roof ring', material: 180, work: 8000 },
    ],
    req: { pop: 25000, power: 100, water: 60 },
    powerUse: 70, waterUse: 40, mw: 0, residents: 0, jobsC: 300, visitors: 3000, income: 1800,
    aura: { value: 0, radius: 0 },
  },
  [ARCH.SPACE_ELEVATOR]: {
    stages: [
      { name: 'Anchor foundation', material: 100, work: 5000 },
      { name: 'Terminal tower', material: 160, work: 7000 },
      { name: 'Tether spool', material: 200, work: 8000 },
      { name: 'Tether ascent', material: 240, work: 9000 },
      { name: 'Climber and orbital head', material: 300, work: 10000 },
    ],
    req: { pop: 80000, power: 500, water: 100 },
    powerUse: 300, waterUse: 60, mw: 0, residents: 0, jobsC: 800, visitors: 0, income: 40000,
    aura: { value: 0, radius: 0 },
  },
};

export const MEGA_ARCHS: readonly number[] = [ARCH.FUSION_SPIRE, ARCH.ARCOLOGY, ARCH.MECH_ARENA, ARCH.SPACE_ELEVATOR];

export const isMega = (arch: number): boolean => MEGA[arch] !== undefined;
export const megaOf = (arch: number): MegaSpec | undefined => MEGA[arch];
export const megaStages = (arch: number): number => MEGA[arch]?.stages.length ?? 0;

/** Most builders that work one megaproject stage at once (ordinary jobs take three). */
export const MEGA_BUILDERS = 6;

/** Bit of S.mega set when a project of this archetype has ever been completed (it survives the building being bulldozed). */
export const megaBit = (arch: number): number => {
  const i = MEGA_ARCHS.indexOf(arch);
  return i < 0 ? 0 : 1 << i;
};

/** Material units the pass for `stage` needs. */
export const megaStageNeed = (arch: number, stage: number): number =>
  MEGA[arch]?.stages[Math.min(stage, megaStages(arch) - 1)]?.material ?? 0;

/** JOB_MAX / work: progress per builder-tick for a stage. Mirrors rateFor() for ordinary jobs. */
export const megaRate = (arch: number, stage: number): number => {
  const st = MEGA[arch]?.stages[Math.min(stage, megaStages(arch) - 1)];
  return st ? Math.max(1, Math.floor(65535 / st.work)) : 1;
};

export interface Aura { cx: number; cy: number; value: number; radius: number }

/** Land value auras of the finished megaprojects that have one (centre in tile units, whole numbers). */
export function megaAuras(w: World): Aura[] {
  const out: Aura[] = [];
  for (let s = 0; s < BMAX; s++) {
    const spec = MEGA[w.bArch[s]!];
    if (!spec || spec.aura.value <= 0 || !megaOperating(w, s)) continue;
    out.push({ cx: w.bX[s]! + (w.bW[s]! >> 1), cy: w.bY[s]! + (w.bH[s]! >> 1), value: spec.aura.value, radius: spec.aura.radius });
  }
  return out;
}

export interface MegaSums { residents: number; jobsC: number; visitors: number; income: number }

/** A finished megaproject that is not dark: only these give residents, jobs, visitors and income. */
export const megaOperating = (w: World, slot: number): boolean =>
  MEGA[w.bArch[slot]!] !== undefined && (w.bFlags[slot]! & (BFLAG.CONSTRUCTING | BFLAG.UNPOWERED | BFLAG.ABANDONED | BFLAG.RUBBLE)) === 0;

/** What every operating megaproject adds to the city, summed over the building table. */
export function megaSums(w: World): MegaSums {
  const out: MegaSums = { residents: 0, jobsC: 0, visitors: 0, income: 0 };
  for (let s = 0; s < BMAX; s++) {
    const spec = MEGA[w.bArch[s]!];
    if (!spec || !megaOperating(w, s)) continue;
    out.residents += spec.residents; out.jobsC += spec.jobsC; out.visitors += spec.visitors; out.income += spec.income;
  }
  return out;
}
