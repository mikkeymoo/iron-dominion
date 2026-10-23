import { execute } from './commands.ts';
import { DAY_TICKS, MAP, S, WEATHER } from './layers.ts';
import { economySystem } from './economy/index.ts';
import { roadsSystem } from './roads/index.ts';
import { nextFloat, nextInt } from './rng.ts';
import type { Sim } from './world.ts';

export const TICK_HZ = 10;

type System = (sim: Sim) => void;

export function commandsSystem(sim: Sim): void {
  const tick = sim.world.scalars[S.tick]!;
  if (sim.queue.length === 0) return;
  const rest = [];
  for (const cmd of sim.queue) {
    if (cmd.tick <= tick) execute(sim, cmd);
    else rest.push(cmd);
  }
  sim.queue = rest;
}

function clockWeather(sim: Sim): void {
  const w = sim.world, s = w.scalars;
  s[S.tick]!++;
  s[S.tickOfDay]!++;
  if (s[S.tickOfDay]! >= DAY_TICKS) { s[S.tickOfDay] = 0; s[S.day]!++; }
  s[S.dayFrac] = s[S.tickOfDay]! / DAY_TICKS;

  s[S.weatherTimer]!--;
  if (s[S.weatherTimer]! <= 0) {
    const r = nextInt(w.rng, 100);
    const next = r < 55 ? WEATHER.CLEAR : r < 80 ? WEATHER.RAIN : r < 90 ? WEATHER.SNOW : WEATHER.STORM;
    s[S.weatherTimer] = 300 + nextInt(w.rng, 600);
    s[S.weatherTarget] = next === WEATHER.CLEAR ? 0 : 0.3 + 0.7 * nextFloat(w.rng);
    if (next !== s[S.weather]) {
      s[S.weather] = next;
      sim.events.push({ type: 'weather', tick: s[S.tick]!, weather: next });
    }
  }
  // Intensity ramps linearly toward the target; at zero a cleared sky is reported as CLEAR.
  const target = s[S.weather] === WEATHER.CLEAR ? 0 : s[S.weatherTarget]!;
  const cur = s[S.weatherIntensity]!;
  s[S.weatherIntensity] = cur < target ? Math.min(target, cur + 0.01) : Math.max(target, cur - 0.01);

  if (s[S.weather] === WEATHER.STORM && s[S.weatherIntensity]! > 0.3 && nextFloat(w.rng) < s[S.weatherIntensity]! * 0.01) {
    const x = nextInt(w.rng, MAP), y = nextInt(w.rng, MAP);
    s[S.lightningCount]!++;
    sim.events.push({ type: 'lightning', tick: s[S.tick]!, x, y });
  }
}

// Named no-op hooks reserve each future system's slot in the fixed order.
const growth: System = () => {};
const utilities: System = () => {};
const traffic: System = () => {};
const services: System = () => {};
const disasters: System = () => {};

/** Fixed system order: later units fill the hooks, they never reorder. */
export const SYSTEMS: readonly { name: string; run: System }[] = [
  { name: 'commands', run: commandsSystem },
  { name: 'roads', run: roadsSystem },
  { name: 'clockWeather', run: clockWeather },
  { name: 'growth', run: growth },
  { name: 'economy', run: economySystem },
  { name: 'utilities', run: utilities },
  { name: 'traffic', run: traffic },
  { name: 'services', run: services },
  { name: 'disasters', run: disasters },
];

export function runTick(sim: Sim): void {
  for (const sys of SYSTEMS) sys.run(sim);
}
