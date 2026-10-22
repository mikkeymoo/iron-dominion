import type { Campaign, FactionId, RivalId, UnitClass } from "./types";
import { CORE_REGION, RIVALS, SQUAD_CAP } from "./world";
import { enqueueUnit, findPath, fortify, orderSquad, pushEvent, rand, regionCount, spawnSquad } from "./simulation";

/** Strategic AI: accumulates time and decides once per simulated second. */
export function updateAI(s: Campaign, dt: number): Campaign {
  if (s.status !== "playing") return s;
  updateThreat(s, dt);
  s.aiAccumulator += dt;
  while (s.aiAccumulator >= 1 - 1e-9) {
    s.aiAccumulator -= 1;
    for (const f of RIVALS) if (s.factions[f].alive) rivalTurn(s, f);
    rogueTurn(s);
  }
  return s;
}

function updateThreat(s: Campaign, dt: number) {
  if (s.rogue.stage === "destroyed") return;
  const growth = 0.12 + 0.035 * regionCount(s, "player") + 0.01 * RIVALS.reduce((n, f) => n + regionCount(s, f), 0);
  s.threat = Math.min(100, s.threat + growth * dt);
}

function idleSquads(s: Campaign, f: FactionId) {
  return s.squads.filter((q) => q.owner === f && q.from === null && !q.path.length);
}

function rivalTurn(s: Campaign, f: RivalId) {
  const res = s.factions[f];
  const army = s.squads.filter((q) => q.owner === f).length;
  // Recruit
  for (const r of s.regions) {
    if (r.owner !== f || (r.kind !== "hq" && r.kind !== "factory") || r.queue.length >= 2) continue;
    if (army + r.queue.length >= 16 || s.squads.length >= SQUAD_CAP) break;
    const roll = rand(s);
    const unit: UnitClass = roll < 0.2 && s.time > 90 ? "scout" : roll > 0.78 && s.time > 180 ? "artillery" : "assault";
    enqueueUnit(s, f, r.id, unit);
  }
  const hq = s.regions.find((r) => r.owner === f && r.kind === "hq");
  if (hq && res.metal > 260 && hq.defense < 2) fortify(s, f, hq.id);

  // Defend threatened regions
  const idle = idleSquads(s, f);
  for (const r of s.regions) {
    if (r.owner !== f) continue;
    const enemies = s.squads.some((q) => q.at === r.id && q.from === null && q.owner !== f);
    if (!enemies) continue;
    const helpers = idle.filter((q) => q.at !== r.id).slice(0, 3);
    for (const h of helpers) {
      if (orderSquad(s, f, h.id, "defend", r.id).ok) idle.splice(idle.indexOf(h), 1);
    }
  }

  // Attack an adjacent region periodically
  s.ai[f].attackTimer -= 1;
  if (s.ai[f].attackTimer > 0) return;
  const garrison = hq ? idle.filter((q) => q.at === hq.id).slice(0, 2) : [];
  const force = idle.filter((q) => !garrison.includes(q));
  if (force.length < 3) {
    s.ai[f].attackTimer = 4;
    return;
  }
  const frontier = s.regions.filter(
    (r) => r.owner !== f && r.neighbors.some((n) => s.regions[n].owner === f) && !(r.id === CORE_REGION && s.rogue.coreHp > 0 && s.time < 400),
  );
  if (!frontier.length) return;
  const score = (id: number) =>
    s.squads.filter((q) => q.at === id && q.owner !== f).length * 2 + (s.regions[id].owner === "neutral" ? 0 : 1) + rand(s) * 1.5;
  const target = frontier.map((r) => ({ id: r.id, sc: score(r.id) })).sort((a, b) => a.sc - b.sc)[0].id;
  let sent = 0;
  for (const q of force) if (orderSquad(s, f, q.id, "attack", target).ok) sent++;
  if (sent && s.regions[target].owner === "player") pushEvent(s, `${s.regions[target].name} is under attack!`, "warn");
  s.ai[f].attackTimer = 12 + Math.floor(rand(s) * 8);
}

function rogueTurn(s: Campaign) {
  const rg = s.rogue;
  if (rg.stage === "destroyed") return;
  if (rg.stage === "dormant" && s.threat >= 70) {
    rg.stage = "stirring";
    pushEvent(s, "Warning: the Rogue Core is stirring. Awakening imminent.", "warn");
  }
  if (rg.stage === "stirring" && s.threat >= 100) {
    rg.stage = "awake";
    rg.raidTimer = 20;
    pushEvent(s, "THE ROGUE AI HAS AWAKENED. Raids incoming.", "bad");
  }
  if (rg.stage !== "awake") return;
  rg.raidTimer -= 1;
  if (rg.raidTimer > 0) return;
  // Pick next victim faction in rotation
  const victims: FactionId[] = (["player", ...RIVALS] as FactionId[]).filter((f) => f === "player" || s.factions[f as RivalId].alive);
  const last = rg.raidHistory[rg.raidHistory.length - 1];
  const victim = victims[(Math.max(-1, victims.indexOf(last as FactionId)) + 1) % victims.length];
  const targets = s.regions.filter((r) => r.owner === victim);
  if (!targets.length) return;
  const dist = (id: number) => findPath(s, "rogue", CORE_REGION, id)?.length ?? 99;
  const target = targets.sort((a, b) => dist(a.id) - dist(b.id))[0].id;
  rg.wave++;
  const count = Math.min(2 + rg.wave, 7);
  const vet = 1 + 0.12 * rg.wave;
  let spawned = 0;
  for (let i = 0; i < count && s.squads.length < SQUAD_CAP; i++) {
    const unit: UnitClass = i % 4 === 3 ? "artillery" : i % 3 === 2 ? "scout" : "assault";
    const q = spawnSquad(s, "rogue", unit, CORE_REGION, vet);
    orderSquad(s, "rogue", q.id, "attack", target);
    spawned++;
  }
  rg.raidHistory.push(victim);
  if (rg.raidHistory.length > 12) rg.raidHistory.shift();
  rg.raidTimer = Math.max(25, 50 - rg.wave * 2);
  if (spawned) pushEvent(s, `Rogue raid (wave ${rg.wave}) heading for ${s.regions[target].name}`, victim === "player" ? "bad" : "warn");
}
