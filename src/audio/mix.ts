// Pure audio mixing rules: no Web Audio, no DOM. Ambience weights and thunder timing are functions of camera and city state.

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Weather kinds as the sim numbers them (WEATHER in sim/layers.ts); kept here so the mix stays free of sim imports. */
export const W = { CLEAR: 0, RAIN: 1, SNOW: 2, STORM: 3 } as const;

export interface AmbienceInput {
  /** Camera orbit distance in tiles: about 3 at street level, 300 at the highest view. */
  camDist: number;
  population: number;
  weather: number;
  /** 0..1 */
  weatherIntensity: number;
  /** 0..1 over the day, 0.5 = noon. */
  dayFrac: number;
  /** Buildings within earshot of the camera focus. */
  nearBuildings: number;
  /** Construction sites, builder robots and hauler drones near the focus. */
  nearSites: number;
  nearRobots: number;
  nearDrones: number;
}

export const AMBIENCE_LAYERS = ['wind', 'birds', 'cityHum', 'traffic', 'servo', 'drone', 'construction', 'rain', 'crickets'] as const;
export type AmbienceLayer = (typeof AMBIENCE_LAYERS)[number];
export type AmbienceWeights = Record<AmbienceLayer, number>;

/** 0 in full daylight, 1 deep night; dawn and dusk blend. */
export const nightness = (dayFrac: number): number => {
  const f = ((dayFrac % 1) + 1) % 1;
  const sunHeight = Math.sin((f - 0.25) * Math.PI * 2);
  return 1 - smoothstep(-0.25, 0.25, sunHeight);
};

/** 0 for an empty map, 1 around ten thousand people. */
export const populationLevel = (pop: number): number => clamp01(Math.log10(1 + Math.max(0, pop)) / 4);

/** 1 at street level, falling to 0 once the camera is well above the rooftops. */
export const streetLevel = (camDist: number): number => 1 - smoothstep(12, 55, camDist);
/** 0 at street level, 1 high above the city. */
export const altitude = (camDist: number): number => smoothstep(40, 220, camDist);

/** Share of the sky the city does not cover: wind and birds belong to open land. */
export const natureShare = (nearBuildings: number): number => 1 - smoothstep(0, 80, nearBuildings);

export function ambienceWeights(i: AmbienceInput): AmbienceWeights {
  const alt = altitude(i.camDist);
  const street = streetLevel(i.camDist);
  const night = nightness(i.dayFrac);
  const pop = populationLevel(i.population);
  const nature = natureShare(i.nearBuildings);
  const rainy = i.weather === W.RAIN || i.weather === W.STORM;
  const rainAmount = rainy ? clamp01(i.weatherIntensity) * (i.weather === W.STORM ? 1 : 0.8) : 0;
  const hush = i.weather === W.SNOW ? 0.5 * clamp01(i.weatherIntensity) : 0;
  const calm = 1 - rainAmount * 0.5;
  const nearness = (n: number, full: number): number => clamp01(n / full);
  const detail = street * (1 - 0.7 * hush);
  return {
    wind: clamp01((0.12 + 0.75 * alt + 0.35 * nature + (i.weather === W.STORM ? 0.3 : 0)) * (1 - 0.3 * hush)),
    birds: clamp01((0.15 * alt + 0.6 * nature) * (1 - night) * (1 - rainAmount) * (1 - hush) * (0.4 + 0.6 * (1 - alt * 0.4))),
    cityHum: clamp01(pop * (1 - 0.55 * alt) * (0.5 + 0.5 * (1 - nature)) * (0.8 + 0.2 * (1 - night))),
    traffic: clamp01(pop * pop * (1 - 0.7 * street) * (0.3 + 0.7 * (1 - night * 0.7)) * (1 - 0.8 * alt) + 0.4 * pop * street * (1 - night * 0.6)) * calm,
    servo: clamp01(detail * nearness(i.nearRobots, 6)),
    drone: clamp01(detail * nearness(i.nearDrones, 4) * 0.9),
    construction: clamp01(detail * nearness(i.nearSites, 3) * calm),
    rain: rainAmount,
    crickets: clamp01(night * (0.25 + 0.75 * nature) * (1 - alt * 0.7) * (1 - rainAmount) * (1 - hush) * (1 - 0.6 * pop)),
  };
}

/** One tile is taken as about 12 m, sound travels 343 m/s. */
export const TILE_METERS = 12;
export const SPEED_OF_SOUND = 343;
export const THUNDER_MAX_DELAY_S = 8;

/** Seconds between a lightning flash and its thunder for a strike `tiles` away. */
export const thunderDelay = (tiles: number): number =>
  Math.min(THUNDER_MAX_DELAY_S, 0.12 + (Math.max(0, tiles) * TILE_METERS) / SPEED_OF_SOUND);

/** Thunder loudness 0..1: close strikes crack, far ones rumble quietly. */
export const thunderLevel = (tiles: number): number => 0.12 + 0.88 * (1 - smoothstep(4, 220, tiles));

/** Thunder low-pass cutoff in Hz: distance rounds the sound off. */
export const thunderTone = (tiles: number): number => 1800 - 1450 * smoothstep(5, 200, tiles);

/** Master-bus factor while the game is paused behind the HUD: the music and ambience duck, UI sounds stay. */
export const PAUSE_DUCK = 0.3;

export interface MixSettings { muted: boolean; volume: number; music: number; ambience: number; sfx: number; musicOn: boolean }

export interface BusGains { master: number; music: number; ambience: number; sfx: number }

/** Target gain for each bus. Mute zeroes the master; `paused` ducks only the music and ambience buses. */
export function busGains(s: MixSettings, paused = false): BusGains {
  const duck = paused ? PAUSE_DUCK : 1;
  return {
    master: s.muted ? 0 : clamp01(s.volume),
    music: s.musicOn ? clamp01(s.music) * duck : 0,
    ambience: clamp01(s.ambience) * duck,
    sfx: clamp01(s.sfx),
  };
}
