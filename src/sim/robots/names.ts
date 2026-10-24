import { RMAX, S, type World } from '../layers.ts';
import type { NamedBot } from '../protocol.ts';
import type { Sim } from '../world.ts';
import { AKIND } from './constants.ts';

/** Jobs a robot finishes before it earns a name and a hat. */
export const NAMED_JOBS = 100;
/** Most bots the stats list carries. */
export const HALL_CAP = 30;
export const HAT_VARIANTS = 3;

const FIRST = [
  'Rivet', 'Sprocket', 'Bolt', 'Gizmo', 'Cog', 'Widget', 'Ratchet', 'Torque', 'Flange', 'Gasket', 'Piston', 'Dynamo',
  'Clank', 'Servo', 'Spanner', 'Anvil', 'Pixel', 'Nimbus', 'Ember', 'Quill', 'Bracket', 'Lug', 'Truss', 'Girder',
] as const;

/** 32-bit integer mix of a slot and generation (xorshift-multiply), so neighbouring slots do not get neighbouring names. */
function mix(slot: number, gen: number): number {
  let h = (Math.imul(slot + 1, 0x9e3779b1) ^ Math.imul(gen + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** The name an agent slot and generation earn: "Rivet-7", "Sprocket" (no suffix when the digit is 0). The same pair always gives the same name. */
export function botName(slot: number, gen: number): string {
  const h = mix(slot, gen);
  const first = FIRST[h % FIRST.length]!;
  const n = (h >>> 8) % 10;
  return n === 0 ? first : `${first}-${n}`;
}

/** Which hat or antenna a named bot wears, 1..HAT_VARIANTS. */
export const hatVariant = (slot: number, gen: number): number => 1 + ((mix(slot, gen) >>> 16) % HAT_VARIANTS);

/** The two look fields packed into the high bits of an agent's second Agents word: paint scheme in bits 20-22, hat in bits 24-25. */
export const LOOK_SHIFT = { LIVERY: 20, HAT: 24 } as const;
export const packLook = (livery: number, hat: number): number => ((livery & 7) << LOOK_SHIFT.LIVERY) | ((hat & 3) << LOOK_SHIFT.HAT);
export const liveryOfMeta = (meta: number): number => (meta >>> LOOK_SHIFT.LIVERY) & 7;
export const hatOfMeta = (meta: number): number => (meta >>> LOOK_SHIFT.HAT) & 3;

/** Whether a robot slot is a bot that can earn a name: builders and hauler drones (firefighters keep their role). */
export const canBeNamed = (w: World, a: number): boolean => a < RMAX && (w.aKind[a] === AKIND.BUILDER || w.aKind[a] === AKIND.HAULER);

/** Count one finished job for robot `a`. The job that reaches NAMED_JOBS earns the name and fires a botNamed event. */
export function creditJob(sim: Sim, a: number): void {
  const w = sim.world;
  if (!canBeNamed(w, a) || w.aJobs[a]! >= 0xffff) return;
  const n = ++w.aJobs[a]!;
  if (n === NAMED_JOBS) sim.events.push({ type: 'botNamed', tick: w.scalars[S.tick]!, slot: a, gen: w.aGen[a]!, kind: w.aKind[a]!, name: botName(a, w.aGen[a]!) });
}

/** Named bots, the busiest first, at most HALL_CAP, for the Hall of Bots list. `key` is the agent key (slot | generation << 16). */
export function hallOfBots(w: World): NamedBot[] {
  const out: NamedBot[] = [];
  for (let a = 0; a < RMAX; a++) {
    if (!canBeNamed(w, a) || w.aJobs[a]! < NAMED_JOBS) continue;
    const gen = w.aGen[a]!;
    out.push({ key: (a | (gen << 16)) >>> 0, akind: w.aKind[a]!, name: botName(a, gen), jobs: w.aJobs[a]! });
  }
  out.sort((x, y) => y.jobs - x.jobs || x.key - y.key);
  return out.slice(0, HALL_CAP);
}
