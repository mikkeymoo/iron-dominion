import type {
  ArmyId,
  Campaign,
  Command,
  CommandResult,
  FactionId,
  ModuleId,
  OrderKind,
  ResearchId,
  Squad,
  UnitClass,
} from "./types";
import {
  ABILITY_DEFS,
  ARMIES,
  CORE_REGION,
  INCOME,
  MODULE_DEFS,
  RESEARCH_DEFS,
  RIVALS,
  SQUAD_CAP,
  UNIT_DEFS,
  WIN_REGIONS,
  FACTION_NAMES,
  makeSquad,
} from "./world";

/* All functions mutate the campaign in place and return it (cheap for 10 Hz phone simulation). */

export const isArmy = (f: FactionId): f is ArmyId => (ARMIES as string[]).includes(f);
const ok: CommandResult = { ok: true };
const fail = (error: string): CommandResult => ({ ok: false, error });

export function rand(s: Campaign): number {
  let t = (s.rng = (s.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function pushEvent(s: Campaign, text: string, tone: "info" | "good" | "bad" | "warn" = "info") {
  s.events.push({ id: s.nextId++, t: s.time, text, tone });
  if (s.events.length > 8) s.events.splice(0, s.events.length - 8);
}

export function regionCount(s: Campaign, f: FactionId) {
  return s.regions.reduce((n, r) => n + (r.owner === f ? 1 : 0), 0);
}

export function getStats(s: Campaign, sq: Pick<Squad, "owner" | "unit" | "vet">) {
  const d = UNIT_DEFS[sq.unit];
  let hp = d.hp, dps = d.dps, speed = d.speed, capture = d.capture;
  if (sq.owner === "player") {
    const done = s.research.done;
    if (done.includes("armor1")) hp *= 1.25;
    if (done.includes("armor2")) hp *= 1.25;
    if (done.includes("weapons1")) dps *= 1.25;
    if (done.includes("weapons2")) dps *= 1.25;
    const m = s.modules[sq.unit];
    if (m) {
      const md = MODULE_DEFS[m];
      hp *= md.hp; dps *= md.dps; speed *= md.speed; capture *= md.capture;
    }
  } else if (isArmy(sq.owner)) {
    const boost = 1 + Math.min(0.4, s.time / 1500);
    hp *= boost; dps *= boost;
  }
  hp *= sq.vet; dps *= sq.vet;
  return { hp, dps, speed, capture, range: d.range };
}

export function isDisrupted(s: Campaign, regionId: number) {
  return s.regions[regionId].disruptedUntil > s.time;
}

export function unitUnlocked(s: Campaign, f: FactionId, unit: UnitClass) {
  if (unit === "assault") return true;
  if (f === "player") return s.research.done.includes(unit === "scout" ? "scoutTech" : "artilleryTech");
  return s.time > (unit === "scout" ? 90 : 180);
}

export function spawnSquad(s: Campaign, owner: FactionId, unit: UnitClass, regionId: number, vet = 1) {
  const sq = makeSquad(s, owner, unit, regionId, vet);
  sq.hp = getStats(s, sq).hp;
  s.squads.push(sq);
  return sq;
}

export function findPath(s: Campaign, faction: FactionId, start: number, target: number): number[] | null {
  if (start === target) return [];
  const prev = new Map<number, number>([[start, -1]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift()!;
    if (cur !== start && cur !== target && faction !== "rogue" && s.regions[cur].owner !== faction) continue;
    for (const n of s.regions[cur].neighbors) {
      if (prev.has(n)) continue;
      prev.set(n, cur);
      if (n === target) {
        const path = [n];
        let p = cur;
        while (p !== start) (path.unshift(p), (p = prev.get(p)!));
        return path;
      }
      q.push(n);
    }
  }
  return null;
}

export function orderSquad(s: Campaign, faction: FactionId, squadId: number, kind: OrderKind, target: number): CommandResult {
  const sq = s.squads.find((q) => q.id === squadId);
  if (!sq) return fail("Robot not found");
  if (sq.owner !== faction) return fail("Not your robot");
  if (!s.regions[target]) return fail("Unknown region");
  const base = sq.to ?? sq.at;
  const path = findPath(s, faction, base, target);
  if (!path) return fail("Too far: target must border your territory");
  sq.path = path;
  sq.order = { kind, target };
  return ok;
}

export function enqueueUnit(s: Campaign, f: ArmyId, regionId: number, unit: UnitClass): CommandResult {
  const r = s.regions[regionId];
  if (!r || r.owner !== f) return fail("You don't control that site");
  if (r.kind !== "hq" && r.kind !== "factory") return fail("Only HQs and factories build robots");
  if (!unitUnlocked(s, f, unit)) return fail(`${UNIT_DEFS[unit].name} not researched`);
  if (r.queue.length >= 5) return fail("Queue full");
  const d = UNIT_DEFS[unit];
  const res = s.factions[f];
  if (res.metal < d.metal || res.energy < d.energy) return fail("Not enough resources");
  res.metal -= d.metal;
  res.energy -= d.energy;
  r.queue.push({ unit, owner: f, remaining: d.build });
  return ok;
}

export function fortify(s: Campaign, f: ArmyId, regionId: number): CommandResult {
  const r = s.regions[regionId];
  if (!r || r.owner !== f) return fail("You don't control that region");
  if (r.defense >= 3) return fail("Defenses at maximum");
  const metal = 60 * (r.defense + 1), energy = 20;
  const res = s.factions[f];
  if (res.metal < metal || res.energy < energy) return fail("Not enough resources");
  res.metal -= metal; res.energy -= energy;
  r.defense++;
  return ok;
}

export const fortifyCost = (level: number) => ({ metal: 60 * (level + 1), energy: 20 });
export const upgradeCost = (level: number) => ({ metal: 80, energy: 40 * (level + 1) });

export function upgradeProduction(s: Campaign, f: ArmyId, regionId: number): CommandResult {
  const r = s.regions[regionId];
  if (!r || r.owner !== f) return fail("You don't control that region");
  if (r.prodLevel >= 2) return fail("Already fully upgraded");
  const c = upgradeCost(r.prodLevel);
  const res = s.factions[f];
  if (res.metal < c.metal || res.energy < c.energy) return fail("Not enough resources");
  res.metal -= c.metal; res.energy -= c.energy;
  r.prodLevel++;
  return ok;
}

export function researchAvailable(s: Campaign, id: ResearchId) {
  return RESEARCH_DEFS[id].gate(s);
}

export function tryCommand(s: Campaign, cmd: Command): CommandResult {
  if (s.status !== "playing" && cmd.type !== "tutorial") return fail("Campaign over");
  const p = s.factions.player;
  switch (cmd.type) {
    case "order":
      return orderSquad(s, "player", cmd.squadId, cmd.kind, cmd.target);
    case "stop": {
      const sq = s.squads.find((q) => q.id === cmd.squadId && q.owner === "player");
      if (!sq) return fail("Not your robot");
      sq.path = [];
      sq.order = null;
      return ok;
    }
    case "recruit": {
      const r = enqueueUnit(s, "player", cmd.regionId, cmd.unit);
      if (r.ok) s.stats.recruited++;
      return r;
    }
    case "research": {
      const d = RESEARCH_DEFS[cmd.id];
      if (!d) return fail("Unknown research");
      if (s.research.done.includes(cmd.id)) return fail("Already researched");
      if (s.research.active) return fail("A project is already running");
      if (!d.gate(s)) return fail(`Locked: ${d.gateText}`);
      if (p.metal < d.metal || p.energy < d.energy) return fail("Not enough resources");
      p.metal -= d.metal; p.energy -= d.energy;
      s.research.active = { id: cmd.id, remaining: d.time };
      s.stats.researchStarted++;
      return ok;
    }
    case "module": {
      const md = MODULE_DEFS[cmd.module as ModuleId];
      if (!md || md.unit !== cmd.unit) return fail("Module doesn't fit that chassis");
      if (!s.research.done.includes("modules")) return fail("Research Module Bays first");
      const ratios = s.squads.filter((q) => q.owner === "player" && q.unit === cmd.unit).map((q) => [q, q.hp / getStats(s, q).hp] as const);
      s.modules[cmd.unit] = cmd.module;
      for (const [q, ratio] of ratios) q.hp = ratio * getStats(s, q).hp;
      return ok;
    }
    case "fortify":
      return fortify(s, "player", cmd.regionId);
    case "upgrade":
      return upgradeProduction(s, "player", cmd.regionId);
    case "hack": {
      if (!s.research.done.includes("hacking")) return fail("Research Intrusion Suite first");
      const def = ABILITY_DEFS[cmd.ability];
      const r = s.regions[cmd.regionId];
      if (!r) return fail("Unknown region");
      if (s.abilities[cmd.ability] > s.time) return fail(`${def.name} recharging`);
      if (p.energy < def.energy) return fail("Not enough energy");
      p.energy -= def.energy;
      s.abilities[cmd.ability] = s.time + def.cooldown;
      s.stats.hacks++;
      if (cmd.ability === "disrupt") r.disruptedUntil = s.time + ABILITY_DEFS.disrupt.duration;
      else {
        r.swarmUntil = s.time + 1.5;
        for (const q of s.squads) if (q.owner !== "player" && q.at === r.id && q.from === null) q.hp -= ABILITY_DEFS.swarm.damage;
        removeDead(s);
      }
      return ok;
    }
    case "tutorial":
      if (cmd.action === "skip") s.tutorial = { active: false, step: s.tutorial.step };
      else if (cmd.action === "restart") s.tutorial = { active: true, step: 0 };
      else s.tutorial.step++;
      return ok;
  }
}

export function issueCommand(s: Campaign, cmd: Command): Campaign {
  tryCommand(s, cmd);
  return s;
}

function removeDead(s: Campaign) {
  const before = s.squads.length;
  const dead = s.squads.filter((q) => q.hp <= 0);
  if (!dead.length) return;
  for (const d of dead) if (d.owner !== "player") s.stats.kills++;
  s.squads = s.squads.filter((q) => q.hp > 0);
  void before;
}

export function changeOwner(s: Campaign, regionId: number, f: FactionId) {
  const r = s.regions[regionId];
  const prev = r.owner;
  r.owner = f;
  r.capture = { faction: null, progress: 0 };
  r.queue = []; // former owner's production is cancelled, nothing spawns
  r.defense = r.kind === "hq" ? Math.max(0, r.defense - 1) : 0;
  r.prodLevel = 0;
  if (f === "player") {
    s.stats.captures++;
    pushEvent(s, `Captured ${r.name}`, "good");
  } else if (prev === "player") pushEvent(s, `Lost ${r.name} to ${FACTION_NAMES[f]}`, "bad");
  if (r.kind === "hq" && prev !== "player" && isArmy(prev) && s.factions[prev].alive) {
    s.factions[prev].alive = false;
    for (const o of s.regions) if (o.owner === prev) ((o.owner = "neutral"), (o.queue = []));
    s.squads = s.squads.filter((q) => q.owner !== prev);
    pushEvent(s, `${FACTION_NAMES[prev]} has been eliminated`, f === "player" ? "good" : "warn");
  }
}

function income(s: Campaign, f: ArmyId, dt: number) {
  const mult = f === "player" && s.research.done.includes("production1") ? 1.25 : 1;
  for (const r of s.regions) {
    if (r.owner !== f) continue;
    const inc = INCOME[r.kind];
    const m = (1 + 0.5 * r.prodLevel) * mult * dt;
    s.factions[f].metal += inc.metal * m;
    s.factions[f].energy += inc.energy * m;
  }
}

export function regionIncome(s: Campaign, regionId: number) {
  const r = s.regions[regionId];
  const mult = (1 + 0.5 * r.prodLevel) * (r.owner === "player" && s.research.done.includes("production1") ? 1.25 : 1);
  return { metal: INCOME[r.kind].metal * mult, energy: INCOME[r.kind].energy * mult };
}

export function step(s: Campaign, dt: number): Campaign {
  if (s.status !== "playing") return s;
  s.time += dt;

  // economy
  for (const f of ARMIES) if (s.factions[f].alive) income(s, f, dt);

  // research
  if (s.research.active) {
    s.research.active.remaining -= dt;
    if (s.research.active.remaining <= 0) {
      const id = s.research.active.id;
      s.research.done.push(id);
      s.research.active = null;
      pushEvent(s, `Research complete: ${RESEARCH_DEFS[id].name}`, "good");
    }
  }

  // production
  for (const r of s.regions) {
    const item = r.queue[0];
    if (!item) continue;
    if (item.owner !== r.owner) {
      r.queue = [];
      continue;
    }
    const speed = (1 + 0.25 * r.prodLevel) * (item.owner === "player" && s.research.done.includes("production1") ? 1.25 : 1);
    item.remaining -= dt * speed;
    if (item.remaining <= 0 && s.squads.length < SQUAD_CAP) {
      r.queue.shift();
      spawnSquad(s, item.owner, item.unit, r.id);
      if (item.owner === "player") pushEvent(s, `${UNIT_DEFS[item.unit].name} ready at ${r.name}`, "info");
    }
  }

  // index stationary squads by region
  const byRegion: Squad[][] = s.regions.map(() => []);
  for (const q of s.squads) if (q.from === null) byRegion[q.at].push(q);

  // movement
  for (const q of s.squads) {
    const frozen = q.owner !== "player" && isDisrupted(s, q.from === null ? q.at : q.from);
    if (frozen) continue;
    if (q.from === null) {
      if (!q.path.length) continue;
      const engaged = byRegion[q.at].some((o) => o.owner !== q.owner);
      if (engaged) continue;
      q.from = q.at;
      q.to = q.path.shift()!;
      q.t = 0;
    }
    const a = s.regions[q.from!], b = s.regions[q.to!];
    const len = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    q.t += (getStats(s, q).speed * dt) / len;
    if (q.t >= 1) {
      q.at = q.to!;
      q.from = q.to = null;
      q.t = 0;
    }
  }
  for (const list of byRegion) list.length = 0;
  for (const q of s.squads) if (q.from === null) byRegion[q.at].push(q);

  // combat
  const dmg = new Map<number, number>();
  const hit = (target: Squad, amount: number) => {
    const reduce = target.order?.kind === "defend" && target.order.target === target.at && !target.path.length ? 0.75 : 1;
    dmg.set(target.id, (dmg.get(target.id) ?? 0) + amount * reduce);
  };
  const weakest = (list: Squad[], owner: FactionId) => {
    let best: Squad | null = null;
    for (const o of list) if (o.owner !== owner && (!best || o.hp < best.hp)) best = o;
    return best;
  };
  let coreDamage = 0;
  for (const q of s.squads) {
    if (q.from !== null) continue;
    if (q.owner !== "player" && isDisrupted(s, q.at)) continue;
    const st = getStats(s, q);
    let target = weakest(byRegion[q.at], q.owner);
    if (!target && st.range > 0 && !q.path.length) {
      for (const n of s.regions[q.at].neighbors) {
        const t = weakest(byRegion[n], q.owner);
        if (t && (!target || t.hp < target.hp)) target = t;
      }
    }
    if (target) hit(target, st.dps * dt);
    else if (q.at === CORE_REGION && q.owner !== "rogue" && s.rogue.coreHp > 0) coreDamage += st.dps * dt;
  }
  for (const r of s.regions) {
    if (r.defense <= 0 || r.owner === "neutral") continue;
    if (r.owner !== "player" && isDisrupted(s, r.id)) continue;
    const t = weakest(byRegion[r.id], r.owner);
    if (t) hit(t, 7 * r.defense * dt);
  }
  for (const q of s.squads) {
    const d = dmg.get(q.id);
    if (d) q.hp -= d;
    else if (q.from === null && isArmy(q.owner) && s.regions[q.at].owner === q.owner) {
      q.hp = Math.min(getStats(s, q).hp, q.hp + 1.5 * dt);
    }
  }
  removeDead(s);
  if (coreDamage > 0) {
    s.rogue.coreHp = Math.max(0, s.rogue.coreHp - coreDamage);
    if (s.rogue.coreHp === 0) {
      s.rogue.stage = "destroyed";
      const core = s.regions[CORE_REGION];
      core.owner = "neutral";
      core.defense = 0;
      pushEvent(s, "The Rogue Core has been destroyed!", "good");
    }
  }

  // capture
  for (const list of byRegion) list.length = 0;
  for (const q of s.squads) if (q.from === null) byRegion[q.at].push(q);
  for (const r of s.regions) {
    const here = byRegion[r.id];
    const owners = new Set(here.map((q) => q.owner));
    const coreLocked = r.id === CORE_REGION && s.rogue.coreHp > 0;
    if (owners.size === 1 && !coreLocked) {
      const f = here[0].owner;
      if (f !== r.owner && f !== "neutral") {
        if (r.capture.faction !== f) r.capture = { faction: f, progress: 0 };
        r.capture.progress += here.reduce((n, q) => n + getStats(s, q).capture, 0) * dt;
        if (r.capture.progress >= 100) changeOwner(s, r.id, f);
        continue;
      }
    }
    if (owners.has(r.owner)) r.capture = { faction: null, progress: 0 };
    else if (owners.size === 0 && r.capture.progress > 0) {
      r.capture.progress = Math.max(0, r.capture.progress - 5 * dt);
      if (r.capture.progress === 0) r.capture.faction = null;
    }
  }

  // objectives
  const owned = regionCount(s, "player");
  const unlock = (key: keyof Campaign["flags"], cond: boolean, msg: string) => {
    if (!s.flags[key] && cond) {
      s.flags[key] = true;
      pushEvent(s, msg, "good");
    }
  };
  unlock("firstCapture", s.stats.captures > 0, "Objective complete — Scout Chassis research unlocked");
  unlock("fourRegions", owned >= 4, "Objective complete — Artillery research unlocked");
  unlock("twoResearch", s.research.done.length >= 2, "Objective complete — Module Bays research unlocked");
  unlock("sixRegions", owned >= 6, "Objective complete — Intrusion Suite (hacking) unlocked");

  // end conditions
  if (s.regions[0].owner !== "player") {
    s.status = "defeat";
    pushEvent(s, "Headquarters lost", "bad");
  } else if (s.rogue.coreHp <= 0 && owned >= WIN_REGIONS) {
    s.status = "victory";
    pushEvent(s, "Total dominion achieved", "good");
  }
  void RIVALS;
  return s;
}
