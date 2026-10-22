export type RivalId = "red" | "amber" | "green";
export type ArmyId = "player" | RivalId;
export type FactionId = ArmyId | "rogue" | "neutral";
export type UnitClass = "scout" | "assault" | "artillery";
export type RegionKind = "hq" | "factory" | "metal" | "energy" | "plain" | "core";
export type OrderKind = "move" | "attack" | "defend";
export type AbilityId = "disrupt" | "swarm";
export type ModuleId = "optics" | "servos" | "plating" | "autocannon" | "shells" | "stabilizer";
export type ResearchId =
  | "scoutTech"
  | "artilleryTech"
  | "armor1"
  | "weapons1"
  | "production1"
  | "modules"
  | "hacking"
  | "armor2"
  | "weapons2";

export interface QueueItem {
  unit: UnitClass;
  owner: FactionId;
  remaining: number;
}

export interface Region {
  id: number;
  name: string;
  kind: RegionKind;
  x: number;
  y: number;
  neighbors: number[];
  owner: FactionId;
  capture: { faction: FactionId | null; progress: number };
  defense: number;
  prodLevel: number;
  queue: QueueItem[];
  disruptedUntil: number;
  swarmUntil: number;
}

export interface Squad {
  id: number;
  owner: FactionId;
  unit: UnitClass;
  hp: number;
  at: number;
  from: number | null;
  to: number | null;
  t: number;
  path: number[];
  order: { kind: OrderKind; target: number } | null;
  vet: number;
}

export interface GameEvent {
  id: number;
  t: number;
  text: string;
  tone: "info" | "good" | "bad" | "warn";
}

export interface Campaign {
  version: number;
  seed: number;
  rng: number;
  time: number;
  status: "playing" | "victory" | "defeat";
  regions: Region[];
  squads: Squad[];
  nextId: number;
  factions: Record<ArmyId, { metal: number; energy: number; alive: boolean }>;
  research: { done: ResearchId[]; active: { id: ResearchId; remaining: number } | null };
  modules: Record<UnitClass, ModuleId | null>;
  abilities: Record<AbilityId, number>;
  threat: number;
  rogue: {
    stage: "dormant" | "stirring" | "awake" | "destroyed";
    coreHp: number;
    wave: number;
    raidTimer: number;
    raidHistory: FactionId[];
  };
  ai: Record<RivalId, { attackTimer: number }>;
  aiAccumulator: number;
  flags: { firstCapture: boolean; fourRegions: boolean; twoResearch: boolean; sixRegions: boolean };
  stats: { captures: number; recruited: number; researchStarted: number; kills: number; hacks: number };
  tutorial: { active: boolean; step: number };
  events: GameEvent[];
}

export type Command =
  | { type: "order"; squadId: number; kind: OrderKind; target: number }
  | { type: "stop"; squadId: number }
  | { type: "recruit"; regionId: number; unit: UnitClass }
  | { type: "research"; id: ResearchId }
  | { type: "module"; unit: UnitClass; module: ModuleId }
  | { type: "fortify"; regionId: number }
  | { type: "upgrade"; regionId: number }
  | { type: "hack"; ability: AbilityId; regionId: number }
  | { type: "tutorial"; action: "advance" | "skip" | "restart" };

export interface CommandResult {
  ok: boolean;
  error?: string;
}
