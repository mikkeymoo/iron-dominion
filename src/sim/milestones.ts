import { ARCH, BFLAG } from './catalog.ts';
import { BMAX, S, type World } from './layers.ts';
import { MEGA, MEGA_ARCHS, megaBit, megaStages } from './megaprojects.ts';
import type { MilestoneStats, ProjectStatus } from './protocol.ts';
import { MAX_TIER, TIERS, tierOfPopulation } from './unlocks.ts';
import { SOLAR_PEAK_MW, TOWER_ML, fixedMwOf, isPowerProducer, isWaterSource, powerUseOf, producerKind, PRODUCER, waterUseOf } from './utilities/tables.ts';
import { pumpOutput } from './utilities/solve.ts';
import type { Sim } from './world.ts';

const finished = (w: World, s: number): boolean => (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.ABANDONED)) === 0;

/**
 * Milestone system (last in the tick order): the tier follows the population scalar upward only. Each tier reached fires one
 * `milestone` event and pays its bonus, so a city that later shrinks keeps what it unlocked and is never paid twice.
 */
export function milestonesSystem(sim: Sim): void {
  const w = sim.world, sc = w.scalars;
  const next = tierOfPopulation(sc[S.population]!);
  for (let t = sc[S.tier]! + 1; t <= next; t++) {
    sc[S.tier] = t;
    sc[S.treasury]! += TIERS[t]!.bonus;
    sim.events.push({ type: 'milestone', tick: sc[S.tick]!, tier: t, bonus: TIERS[t]!.bonus });
  }
}

export interface Balance { supply: number; demand: number }

/** Rated power of the finished producers (a solar farm at its noon peak, so the figure does not swing with the clock) against what finished consumers draw. */
export function powerBalance(w: World): Balance {
  let supply = 0, demand = 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0 || !finished(w, s)) continue;
    if (isPowerProducer(arch)) supply += producerKind(arch) === PRODUCER.SOLAR ? SOLAR_PEAK_MW : fixedMwOf(arch);
    demand += powerUseOf(arch);
  }
  return { supply, demand };
}

/** Pump output (towers add their reserve once a pump runs) against the draw of finished consumers. */
export function waterBalance(w: World): Balance {
  let pumps = 0, towers = 0, demand = 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0 || !finished(w, s)) continue;
    if (isWaterSource(arch)) { if (producerKind(arch) === PRODUCER.PUMP) pumps += pumpOutput(w, s); else towers += TOWER_ML; }
    demand += waterUseOf(arch);
  }
  return { supply: pumps > 0 ? pumps + towers : 0, demand };
}

export const megaExists = (w: World, arch: number): boolean => {
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] === arch) return true;
  return false;
};

export interface Requirements {
  pop: { have: number; need: number; ok: boolean };
  power: { have: number; need: number; ok: boolean };
  water: { have: number; need: number; ok: boolean };
  met: boolean;
}

/** Requirements of starting a megaproject, measured now: population, and spare rated power and water. */
export function megaRequirements(w: World, arch: number): Requirements {
  const req = MEGA[arch]!.req;
  const pop = w.scalars[S.population]!;
  const p = powerBalance(w), q = waterBalance(w);
  const power = p.supply - p.demand, water = q.supply - q.demand;
  const r = {
    pop: { have: pop, need: req.pop, ok: pop >= req.pop },
    power: { have: power, need: req.power, ok: power >= req.power },
    water: { have: water, need: req.water, ok: water >= req.water },
  };
  return { ...r, met: r.pop.ok && r.power.ok && r.water.ok };
}

/** Why a megaproject cannot be started, or null: only one of each may stand (or be under construction) at a time. */
export function megaBlock(w: World, arch: number): 'exists' | 'requirements' | null {
  if (megaExists(w, arch)) return 'exists';
  return megaRequirements(w, arch).met ? null : 'requirements';
}

/** Per-project state for the Projects panel: requirements now, and where a project under construction stands. */
export function projectStatuses(w: World): ProjectStatus[] {
  return MEGA_ARCHS.map((arch) => {
    let slot = -1;
    for (let s = 0; s < BMAX; s++) if (w.bArch[s] === arch) { slot = s; break; }
    const stages = megaStages(arch);
    const building = slot >= 0 && (w.bFlags[slot]! & BFLAG.CONSTRUCTING) !== 0;
    const r = megaRequirements(w, arch);
    return {
      arch, state: slot < 0 ? 'none' : building ? 'building' : 'done', stage: slot < 0 ? 0 : Math.min(stages, w.bLevel[slot]!), stages,
      progress: slot < 0 ? 0 : building ? (w.bLevel[slot]! + w.bProg[slot]! / 255) / stages : 1,
      everBuilt: (w.scalars[S.mega]! & megaBit(arch)) !== 0,
      req: { pop: r.pop, power: r.power, water: r.water }, met: r.met,
    };
  });
}

/** The milestone fields of a Stats message. */
export function milestoneStats(w: World): MilestoneStats {
  const tier = w.scalars[S.tier]!;
  return { tier, nextAt: tier < MAX_TIER ? TIERS[tier + 1]!.pop : null, projects: projectStatuses(w), victory: (w.scalars[S.mega]! & megaBit(ARCH.SPACE_ELEVATOR)) !== 0 };
}
