import type { Campaign } from "./types";
import { ALL_FACTIONS, ARMIES, MODULE_DEFS, RESEARCH_DEFS, RIVALS, SAVE_VERSION, REGION_DEFS, EDGES, SQUAD_CAP } from "./world";

export const SAVE_KEY = "iron-dominion-save-v1";
export const BACKUP_KEY = "iron-dominion-save-v1-backup";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const defaultStorage = (): StorageLike | null => (typeof localStorage === "undefined" ? null : localStorage);

export class SaveError extends Error {}

const fin = (v: unknown, path: string, min = -Infinity) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new SaveError(`Invalid number at ${path}`);
  if (v < min) throw new SaveError(`Out-of-range value at ${path}`);
  return v;
};
const bool = (v: unknown, path: string) => {
  if (typeof v !== "boolean") throw new SaveError(`Invalid flag at ${path}`);
};
const faction = (v: unknown, path: string) => {
  if (typeof v !== "string" || !ALL_FACTIONS.includes(v as never)) throw new SaveError(`Invalid faction at ${path}`);
};
const obj = (v: unknown, path: string): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SaveError(`Missing ${path}`);
  return v as Record<string, any>;
};
const arr = (v: unknown, path: string): any[] => {
  if (!Array.isArray(v)) throw new SaveError(`Missing ${path}`);
  return v;
};

export function validateCampaign(raw: unknown): Campaign {
  const s = obj(raw, "save");
  if (s.version !== SAVE_VERSION) throw new SaveError(`Unsupported save version: ${String(s.version)}`);
  for (const k of ["seed", "rng", "time", "nextId", "threat", "aiAccumulator"]) fin(s[k], k);
  fin(s.time, "time", 0);
  fin(s.threat, "threat", 0);
  if (!["playing", "victory", "defeat"].includes(s.status)) throw new SaveError("Invalid status");
  const regions = arr(s.regions, "regions");
  if (regions.length !== 18) throw new SaveError("Map must have 18 regions");
  regions.forEach((r, i) => {
    const p = `regions[${i}]`;
    obj(r, p);
    if (r.id !== i) throw new SaveError(`Bad id at ${p}`);
    if (typeof r.name !== "string") throw new SaveError(`Bad name at ${p}`);
    if (r.kind !== REGION_DEFS[i].kind) throw new SaveError(`Bad region kind at ${p}`);
    if (r.x !== REGION_DEFS[i].x || r.y !== REGION_DEFS[i].y) throw new SaveError(`Bad coordinates at ${p}`);
    faction(r.owner, `${p}.owner`);
    for (const k of ["x", "y", "defense", "prodLevel", "disruptedUntil", "swarmUntil"]) fin(r[k], `${p}.${k}`);
    arr(r.neighbors, `${p}.neighbors`).forEach((n) => {
      if (!Number.isInteger(n) || n < 0 || n >= 18) throw new SaveError(`Bad neighbor at ${p}`);
    });
    const expected=EDGES.filter(e=>e.includes(i)).map(e=>e[0]===i?e[1]:e[0]).sort((a,b)=>a-b);
    if(JSON.stringify(r.neighbors)!==JSON.stringify(expected)) throw new SaveError(`Bad map links at ${p}`);
    if(!Number.isInteger(r.defense)||r.defense<0||r.defense>3||!Number.isInteger(r.prodLevel)||r.prodLevel<0||r.prodLevel>2) throw new SaveError(`Bad upgrade level at ${p}`);
    const c = obj(r.capture, `${p}.capture`);
    if (c.faction !== null) faction(c.faction, `${p}.capture.faction`);
    fin(c.progress, `${p}.capture.progress`, 0);
    arr(r.queue, `${p}.queue`).forEach((q, j) => {
      obj(q, `${p}.queue[${j}]`);
      faction(q.owner, `${p}.queue[${j}].owner`);
      if (!["scout", "assault", "artillery"].includes(q.unit)) throw new SaveError("Bad unit");
      fin(q.remaining, `${p}.queue[${j}].remaining`);
    });
  });
  arr(s.squads, "squads").forEach((q, i) => {
    const p = `squads[${i}]`;
    obj(q, p);
    faction(q.owner, `${p}.owner`);
    if (!["scout", "assault", "artillery"].includes(q.unit)) throw new SaveError(`Bad unit at ${p}`);
    for (const k of ["id", "hp", "t", "vet"]) fin(q[k], `${p}.${k}`);
    if(!Number.isInteger(q.id)||q.id<1||q.hp<0||q.vet<=0||q.t<0||q.t>1)throw new SaveError(`Bad squad values at ${p}`);
    if((q.from===null)!==(q.to===null))throw new SaveError(`Broken movement at ${p}`);
    const reg = (v: unknown, k: string) => {
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= 18) throw new SaveError(`Bad region at ${p}.${k}`);
    };
    reg(q.at, "at");
    if (q.from !== null) reg(q.from, "from");
    if (q.to !== null) reg(q.to, "to");
    arr(q.path, `${p}.path`).forEach((n) => reg(n, "path"));
    if (q.order !== null) {
      obj(q.order, `${p}.order`);
      if (!["move", "attack", "defend"].includes(q.order.kind)) throw new SaveError("Bad order");
      reg(q.order.target, "order.target");
    }
  });
  if(s.squads.length>SQUAD_CAP||new Set(s.squads.map((q:any)=>q.id)).size!==s.squads.length)throw new SaveError('Bad squad roster');
  if(!Number.isInteger(s.nextId)||s.nextId<1||s.squads.some((q:any)=>q.id>=s.nextId))throw new SaveError('Bad next squad ID');
  const f = obj(s.factions, "factions");
  for (const a of ARMIES) {
    const fa = obj(f[a], `factions.${a}`);
    fin(fa.metal, `factions.${a}.metal`, 0);
    fin(fa.energy, `factions.${a}.energy`, 0);
    bool(fa.alive, `factions.${a}.alive`);
  }
  const res = obj(s.research, "research");
  arr(res.done, "research.done").forEach((id) => {
    if (!Object.hasOwn(RESEARCH_DEFS,id)) throw new SaveError("Unknown research");
  });
  if (res.active !== null) {
    obj(res.active, "research.active");
    if (!Object.hasOwn(RESEARCH_DEFS,res.active.id)) throw new SaveError("Unknown research");
    fin(res.active.remaining, "research.active.remaining");
  }
  const mods = obj(s.modules, "modules");
  for (const u of ["scout", "assault", "artillery"]) if (mods[u] !== null && (!Object.hasOwn(MODULE_DEFS,mods[u])||MODULE_DEFS[mods[u] as keyof typeof MODULE_DEFS].unit!==u)) throw new SaveError("Unknown module");
  const ab = obj(s.abilities, "abilities");
  fin(ab.disrupt, "abilities.disrupt");
  fin(ab.swarm, "abilities.swarm");
  const rg = obj(s.rogue, "rogue");
  if (!["dormant", "stirring", "awake", "destroyed"].includes(rg.stage)) throw new SaveError("Bad rogue stage");
  fin(rg.coreHp, "rogue.coreHp", 0);
  fin(rg.wave, "rogue.wave", 0);
  fin(rg.raidTimer, "rogue.raidTimer");
  arr(rg.raidHistory, "rogue.raidHistory").forEach((x) => faction(x, "rogue.raidHistory"));
  const ai = obj(s.ai, "ai");
  for (const r of RIVALS) fin(obj(ai[r], `ai.${r}`).attackTimer, `ai.${r}.attackTimer`);
  const fl = obj(s.flags, "flags");
  for (const k of ["firstCapture", "fourRegions", "twoResearch", "sixRegions"]) bool(fl[k], `flags.${k}`);
  const st = obj(s.stats, "stats");
  for (const k of ["captures", "recruited", "researchStarted", "kills", "hacks"]) fin(st[k], `stats.${k}`, 0);
  const tu = obj(s.tutorial, "tutorial");
  bool(tu.active, "tutorial.active");
  fin(tu.step, "tutorial.step", 0);
  arr(s.events, "events").forEach((e,i)=>{obj(e,`events[${i}]`);fin(e.id,'event id',0);fin(e.t,'event time',0);if(typeof e.text!=='string'||!["info","good","bad","warn"].includes(e.tone))throw new SaveError('Bad event');});
  return s as Campaign;
}

export function parseSave(json: string): Campaign {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SaveError("File is not valid JSON");
  }
  return validateCampaign(raw);
}

export function exportSave(state: Campaign): string {
  return JSON.stringify(state);
}

export function saveCampaign(state: Campaign, storage: StorageLike | null = defaultStorage()): { ok: boolean; error?: string } {
  if (!storage) return { ok: false, error: "Browser storage unavailable" };
  try {
    const text = exportSave(state);
    const prev = storage.getItem(SAVE_KEY);
    storage.setItem(SAVE_KEY, text);
    if (prev && prev !== text) {
      try {
        storage.setItem(BACKUP_KEY, prev);
      } catch {
        /* backup is best effort */
      }
    }
    return { ok: true };
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    return { ok: false, error: name.includes("Quota") ? "Storage is full" : `Save failed${e instanceof Error ? `: ${e.message}` : ""}` };
  }
}

export type LoadResult =
  | { status: "none" }
  | { status: "ok"; campaign: Campaign }
  | { status: "corrupt"; error: string; raw: string; backup: Campaign | null };

export function loadSave(storage: StorageLike | null = defaultStorage()): LoadResult & { campaign?: Campaign } {
  if (!storage) return { status: "none" };
  const raw = storage.getItem(SAVE_KEY);
  if (!raw) return { status: "none" };
  try {
    return { status: "ok", campaign: parseSave(raw) };
  } catch (e) {
    let backup: Campaign | null = null;
    const b = storage.getItem(BACKUP_KEY);
    if (b) {
      try {
        backup = parseSave(b);
      } catch {
        backup = null;
      }
    }
    return { status: "corrupt", error: (e as Error).message, raw, backup };
  }
}

export function importSave(json: string, storage: StorageLike | null = defaultStorage()): { ok: boolean; campaign?: Campaign; error?: string } {
  let campaign: Campaign;
  try {
    campaign = parseSave(json);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const r = saveCampaign(campaign, storage);
  return { ok: true, campaign, error: r.ok ? undefined : r.error };
}

export function clearSave(storage: StorageLike | null = defaultStorage()) {
  storage?.removeItem(SAVE_KEY);
}
