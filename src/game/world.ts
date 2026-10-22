import type {
  ArmyId,
  Campaign,
  FactionId,
  ModuleId,
  RegionKind,
  ResearchId,
  RivalId,
  Squad,
  UnitClass,
} from "./types";

export const SAVE_VERSION = 1;
export const SQUAD_CAP = 60;
export const RIVALS: RivalId[] = ["red", "amber", "green"];
export const ARMIES: ArmyId[] = ["player", ...RIVALS];
export const ALL_FACTIONS: FactionId[] = ["player", "red", "amber", "green", "rogue", "neutral"];
export const CORE_REGION = 10;
export const CORE_MAX_HP = 1500;
export const WIN_REGIONS = 18;

export const FACTION_NAMES: Record<FactionId, string> = {
  player: "Dominion",
  red: "Crimson Legion",
  amber: "Amber Syndicate",
  green: "Verdant Collective",
  rogue: "Rogue AI",
  neutral: "Unclaimed",
};

interface RegionDef {
  name: string;
  kind: RegionKind;
  x: number;
  y: number;
  owner: FactionId;
}

export const REGION_DEFS: RegionDef[] = [
  { name: "Dominion HQ", kind: "hq", x: 500, y: 1300, owner: "player" },
  { name: "Scrapyard", kind: "metal", x: 290, y: 1170, owner: "neutral" },
  { name: "Dynamo Flats", kind: "energy", x: 710, y: 1170, owner: "neutral" },
  { name: "Rust Gate", kind: "plain", x: 500, y: 1060, owner: "neutral" },
  { name: "West Foundry", kind: "factory", x: 160, y: 930, owner: "neutral" },
  { name: "East Foundry", kind: "factory", x: 840, y: 930, owner: "neutral" },
  { name: "Crimson HQ", kind: "hq", x: 120, y: 640, owner: "red" },
  { name: "Ashfield", kind: "metal", x: 340, y: 830, owner: "neutral" },
  { name: "Coil Ridge", kind: "energy", x: 660, y: 830, owner: "neutral" },
  { name: "Amber HQ", kind: "hq", x: 880, y: 640, owner: "amber" },
  { name: "The Core", kind: "core", x: 500, y: 680, owner: "rogue" },
  { name: "Slag Pits", kind: "energy", x: 320, y: 520, owner: "neutral" },
  { name: "Relay Spire", kind: "metal", x: 680, y: 520, owner: "neutral" },
  { name: "Verdant HQ", kind: "hq", x: 500, y: 110, owner: "green" },
  { name: "Iron Mire", kind: "factory", x: 160, y: 340, owner: "neutral" },
  { name: "Glass Wastes", kind: "plain", x: 840, y: 340, owner: "neutral" },
  { name: "North Works", kind: "factory", x: 500, y: 380, owner: "neutral" },
  { name: "Cinder Vault", kind: "metal", x: 300, y: 190, owner: "neutral" },
];

export const EDGES: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [1, 3], [2, 3], [1, 4], [2, 5], [3, 7], [3, 8],
  [4, 7], [4, 6], [5, 8], [5, 9], [6, 7], [6, 11], [6, 14], [7, 10], [8, 10],
  [8, 9], [9, 12], [9, 15], [10, 11], [10, 12], [10, 16], [11, 14], [11, 16],
  [12, 15], [12, 16], [13, 16], [13, 17], [13, 15], [14, 17],
];

export const WORLD = { width: 1000, height: 1400 };

export interface UnitDef {
  name: string;
  hp: number;
  dps: number;
  speed: number;
  range: number;
  capture: number;
  metal: number;
  energy: number;
  build: number;
  role: string;
}

export const UNIT_DEFS: Record<UnitClass, UnitDef> = {
  scout: { name: "Scout", hp: 55, dps: 6, speed: 95, range: 0, capture: 25, metal: 30, energy: 10, build: 4, role: "Fast, captures quickly" },
  assault: { name: "Assault", hp: 130, dps: 12, speed: 50, range: 0, capture: 10, metal: 50, energy: 10, build: 6, role: "Main battle line" },
  artillery: { name: "Artillery", hp: 70, dps: 17, speed: 34, range: 1, capture: 4, metal: 70, energy: 30, build: 8, role: "Hits adjacent regions; fragile" },
};

export interface ModuleDef {
  unit: UnitClass;
  name: string;
  desc: string;
  hp: number;
  dps: number;
  speed: number;
  capture: number;
}

export const MODULE_DEFS: Record<ModuleId, ModuleDef> = {
  optics: { unit: "scout", name: "Sprint Optics", desc: "+30% speed, +30% capture", hp: 1, dps: 1, speed: 1.3, capture: 1.3 },
  servos: { unit: "scout", name: "Combat Servos", desc: "+40% damage, +20% hull", hp: 1.2, dps: 1.4, speed: 1, capture: 1 },
  plating: { unit: "assault", name: "Heavy Plating", desc: "+45% hull, -15% speed", hp: 1.45, dps: 1, speed: 0.85, capture: 1 },
  autocannon: { unit: "assault", name: "Autocannon", desc: "+35% damage", hp: 1, dps: 1.35, speed: 1, capture: 1 },
  shells: { unit: "artillery", name: "Plasma Shells", desc: "+40% damage", hp: 1, dps: 1.4, speed: 1, capture: 1 },
  stabilizer: { unit: "artillery", name: "Stabilizer Frame", desc: "+50% hull, +15% speed", hp: 1.5, dps: 1, speed: 1.15, capture: 1 },
};

export interface ResearchDef {
  name: string;
  desc: string;
  metal: number;
  energy: number;
  time: number;
  gate: (s: Campaign) => boolean;
  gateText: string;
}

export const RESEARCH_DEFS: Record<ResearchId, ResearchDef> = {
  scoutTech: { name: "Scout Chassis", desc: "Unlocks Scout robots", metal: 60, energy: 40, time: 15, gate: (s) => s.flags.firstCapture, gateText: "Capture a region" },
  artilleryTech: { name: "Artillery Platform", desc: "Unlocks Artillery robots", metal: 100, energy: 60, time: 20, gate: (s) => s.flags.fourRegions, gateText: "Hold 4 regions" },
  armor1: { name: "Composite Armor", desc: "+25% robot hull", metal: 80, energy: 40, time: 20, gate: () => true, gateText: "" },
  weapons1: { name: "Rail Weapons", desc: "+25% robot damage", metal: 80, energy: 60, time: 20, gate: () => true, gateText: "" },
  production1: { name: "Smart Foundries", desc: "+25% income, +25% build speed", metal: 100, energy: 50, time: 25, gate: () => true, gateText: "" },
  modules: { name: "Module Bays", desc: "Choose one module per robot class", metal: 80, energy: 80, time: 20, gate: (s) => s.flags.twoResearch, gateText: "Complete 2 research projects" },
  hacking: { name: "Intrusion Suite", desc: "Unlocks Disruption and Drone Swarm", metal: 120, energy: 120, time: 30, gate: (s) => s.flags.sixRegions, gateText: "Hold 6 regions" },
  armor2: { name: "Reactive Armor", desc: "+25% more hull", metal: 150, energy: 100, time: 30, gate: (s) => s.research.done.includes("armor1"), gateText: "Requires Composite Armor" },
  weapons2: { name: "Ion Lances", desc: "+25% more damage", metal: 150, energy: 120, time: 30, gate: (s) => s.research.done.includes("weapons1"), gateText: "Requires Rail Weapons" },
};

export const ABILITY_DEFS = {
  disrupt: { name: "Disruption", desc: "Freeze enemy robots in a region for 8s", energy: 30, cooldown: 30, duration: 8 },
  swarm: { name: "Drone Swarm", desc: "Deal 45 damage to every enemy in a region", energy: 40, cooldown: 45, damage: 45 },
} as const;

export const INCOME: Record<RegionKind, { metal: number; energy: number }> = {
  hq: { metal: 4, energy: 2 },
  metal: { metal: 4, energy: 0 },
  energy: { metal: 0, energy: 4 },
  factory: { metal: 2, energy: 1 },
  plain: { metal: 1.5, energy: 0.5 },
  core: { metal: 3, energy: 3 },
};

export function makeSquad(state: Campaign, owner: FactionId, unit: UnitClass, regionId: number, vet = 1): Squad {
  const squad: Squad = {
    id: state.nextId++,
    owner,
    unit,
    hp: 0,
    at: regionId,
    from: null,
    to: null,
    t: 0,
    path: [],
    order: null,
    vet,
  };
  return squad;
}

export function createCampaign(seed: number): Campaign {
  const regions = REGION_DEFS.map((d, id) => ({
    id,
    name: d.name,
    kind: d.kind,
    x: d.x,
    y: d.y,
    neighbors: EDGES.filter((e) => e.includes(id)).map((e) => (e[0] === id ? e[1] : e[0])).sort((a, b) => a - b),
    owner: d.owner,
    capture: { faction: null, progress: 0 },
    defense: d.kind === "hq" ? 1 : d.kind === "core" ? 2 : 0,
    prodLevel: 0,
    queue: [],
    disruptedUntil: 0,
    swarmUntil: 0,
  }));
  const state: Campaign = {
    version: SAVE_VERSION,
    seed,
    rng: seed | 0,
    time: 0,
    status: "playing",
    regions,
    squads: [],
    nextId: 1,
    factions: {
      player: { metal: 120, energy: 60, alive: true },
      red: { metal: 120, energy: 60, alive: true },
      amber: { metal: 120, energy: 60, alive: true },
      green: { metal: 120, energy: 60, alive: true },
    },
    research: { done: [], active: null },
    modules: { scout: null, assault: null, artillery: null },
    abilities: { disrupt: 0, swarm: 0 },
    threat: 0,
    rogue: { stage: "dormant", coreHp: CORE_MAX_HP, wave: 0, raidTimer: 0, raidHistory: [] },
    ai: { red: { attackTimer: 25 }, amber: { attackTimer: 30 }, green: { attackTimer: 35 } },
    aiAccumulator: 0,
    flags: { firstCapture: false, fourRegions: false, twoResearch: false, sixRegions: false },
    stats: { captures: 0, recruited: 0, researchStarted: 0, kills: 0, hacks: 0 },
    tutorial: { active: true, step: 0 },
    events: [],
  };
  const add = (owner: FactionId, unit: UnitClass, region: number) => {
    const s = makeSquad(state, owner, unit, region);
    s.hp = UNIT_DEFS[unit].hp;
    state.squads.push(s);
  };
  for (const army of ARMIES) {
    const hq = regions.find((r) => r.kind === "hq" && r.owner === army)!;
    add(army, "assault", hq.id);
    add(army, "assault", hq.id);
  }
  for (const r of regions) {
    if (r.owner === "neutral") add("neutral", r.kind === "factory" ? "assault" : "scout", r.id);
  }
  add("rogue", "assault", CORE_REGION);
  add("rogue", "artillery", CORE_REGION);
  return state;
}
