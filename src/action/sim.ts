import { REGION_DEFS, EDGES, FACTION_NAMES } from '../game/world';
import type { RegionKind } from '../game/types';

/**
 * Real-time 3D action mode. Positions live on the ground plane (x, z).
 * stepAction mutates the state in place for speed and appends visual/audio
 * cues to state.fx; the caller clears fx after rendering.
 */
export type Team = 'player' | 'red' | 'amber' | 'green' | 'rogue' | 'neutral';
export type RivalTeam = 'red' | 'amber' | 'green';
export type BotKind = 'scout' | 'assault' | 'artillery' | 'sentinel';
export type PickupKind = 'repair' | 'overdrive' | 'shield';
export type ShotKind = 'bolt' | 'orb' | 'missile' | 'shell';

export const RIVAL_TEAMS: RivalTeam[] = ['red', 'amber', 'green'];
export const SCALE = 0.25;
export const BOUNDS = { x: 135, z: 185 };
export const PAD_RADIUS = 8;
export const PLAYER_HQ = 0;
export const CORE_PAD = 10;
export const CORE_RADIUS = 6.5;
export const MECH_RADIUS = 1.5;
export const MAX_LIVES = 3;
export const MAX_MISSILES = 3;
export const CORE_WAKE_PADS = 6;
export const CORE_WAKE_TIME = 300;
const ALLY_CAP = 8;
const RIVAL_CAP = 10;
const ROGUE_CAP = 8;
const MAX_DT = 0.05;

export const TEAM_NAMES: Record<Team, string> = {
  player: FACTION_NAMES.player,
  red: FACTION_NAMES.red,
  amber: FACTION_NAMES.amber,
  green: FACTION_NAMES.green,
  rogue: FACTION_NAMES.rogue,
  neutral: FACTION_NAMES.neutral,
};

export interface BotDef {
  hp: number;
  speed: number;
  range: number;
  cooldown: number;
  radius: number;
  score: number;
}

export const BOT_DEFS: Record<BotKind, BotDef> = {
  scout: { hp: 30, speed: 12.5, range: 17, cooldown: 0.55, radius: 1.1, score: 100 },
  assault: { hp: 85, speed: 8, range: 20, cooldown: 1.5, radius: 1.5, score: 150 },
  artillery: { hp: 65, speed: 5.5, range: 38, cooldown: 3.8, radius: 1.8, score: 200 },
  sentinel: { hp: 55, speed: 11, range: 19, cooldown: 0.8, radius: 1.3, score: 175 },
};

export interface Pad {
  id: number;
  name: string;
  kind: RegionKind;
  x: number;
  z: number;
  owner: Team;
  capture: { team: Team | null; progress: number };
  spawnTimer: number;
  turretCd: number;
  turretAngle: number;
}

export interface Mech {
  x: number;
  z: number;
  vx: number;
  vz: number;
  aim: number;
  hp: number;
  maxHp: number;
  shield: number;
  dashCd: number;
  dashTime: number;
  dashX: number;
  dashZ: number;
  fireCd: number;
  gunSide: number;
  missiles: number;
  missileCharge: number;
  overdrive: number;
  invuln: number;
  lives: number;
  alive: boolean;
  respawn: number;
}

export interface Bot {
  id: number;
  team: Team;
  kind: BotKind;
  x: number;
  z: number;
  angle: number;
  hp: number;
  maxHp: number;
  fireCd: number;
  goal: number | null;
  retarget: number;
  flash: number;
  moving: boolean;
  dead?: boolean;
}

export interface Shot {
  id: number;
  team: Team;
  kind: ShotKind;
  byMech: boolean;
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  dmg: number;
  life: number;
  aoe: number;
  target: number | null;
  sx: number;
  sz: number;
  tx: number;
  tz: number;
  t: number;
  dur: number;
  dead?: boolean;
}

export interface Pickup {
  id: number;
  kind: PickupKind;
  x: number;
  z: number;
  life: number;
  dead?: boolean;
}

export interface Rock {
  x: number;
  z: number;
  r: number;
}

export interface Core {
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  awake: boolean;
  alive: boolean;
  spin: number;
  fireCd: number;
  ringCd: number;
  spawnCd: number;
}

export type Tone = 'info' | 'good' | 'bad' | 'warn' | 'epic';

export type Fx =
  | { type: 'boom'; x: number; z: number; size: number; team: Team }
  | { type: 'muzzle'; x: number; z: number; angle: number; team: Team; byMech: boolean }
  | { type: 'hit'; x: number; z: number; team: Team; shield?: boolean }
  | { type: 'announce'; text: string; tone: Tone }
  | { type: 'shake'; amount: number }
  | { type: 'capture'; pad: number; team: Team }
  | { type: 'pickup'; x: number; z: number; kind: PickupKind }
  | { type: 'dash'; x: number; z: number }
  | { type: 'missile' }
  | { type: 'hurt' }
  | { type: 'slowmo'; seconds: number };

export interface ActionInput {
  moveX: number;
  moveZ: number;
  /** Aim direction on the ground plane; ignored when both are 0. */
  aimX: number;
  aimZ: number;
  fire: boolean;
  dash: boolean;
  missile: boolean;
  autoAim: boolean;
}

export const IDLE_INPUT: ActionInput = { moveX: 0, moveZ: 0, aimX: 0, aimZ: 0, fire: false, dash: false, missile: false, autoAim: false };

export interface ActionState {
  seed: number;
  rng: number;
  time: number;
  status: 'playing' | 'victory' | 'defeat';
  mech: Mech;
  bots: Bot[];
  shots: Shot[];
  pickups: Pickup[];
  pads: Pad[];
  rocks: Rock[];
  core: Core;
  nextId: number;
  score: number;
  kills: number;
  combo: number;
  comboTimer: number;
  bestCombo: number;
  streak: number;
  streakTimer: number;
  fx: Fx[];
}

export const toWorld = (x: number, y: number) => ({ x: (x - 500) * SCALE, z: (y - 700) * SCALE });

function rand(s: ActionState) {
  s.rng = (s.rng + 0x6d2b79f5) | 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const dist2 = (ax: number, az: number, bx: number, bz: number) => (ax - bx) ** 2 + (az - bz) ** 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function hostile(a: Team, b: Team) {
  return a !== b && a !== 'neutral' && b !== 'neutral';
}

function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return dist2(px, pz, ax + t * dx, az + t * dz);
}

export function createAction(seed: number): ActionState {
  const pads: Pad[] = REGION_DEFS.map((d, id) => {
    const p = toWorld(d.x, d.y);
    return {
      id, name: d.name, kind: d.kind, x: p.x, z: p.z, owner: d.owner,
      capture: { team: null, progress: 0 }, spawnTimer: 3 + (id % 4), turretCd: 0, turretAngle: 0,
    };
  });
  const hq = pads[PLAYER_HQ];
  const core = pads[CORE_PAD];
  const s: ActionState = {
    seed, rng: seed | 0, time: 0, status: 'playing',
    mech: {
      x: hq.x, z: hq.z - 6, vx: 0, vz: 0, aim: Math.PI, hp: 200, maxHp: 200, shield: 0,
      dashCd: 0, dashTime: 0, dashX: 0, dashZ: 0, fireCd: 0, gunSide: 1,
      missiles: MAX_MISSILES, missileCharge: 0, overdrive: 0, invuln: 0,
      lives: MAX_LIVES, alive: true, respawn: 0,
    },
    bots: [], shots: [], pickups: [], pads, rocks: [],
    core: { x: core.x, z: core.z, hp: 3000, maxHp: 3000, awake: false, alive: true, spin: 0, fireCd: 0, ringCd: 4, spawnCd: 3 },
    nextId: 1, score: 0, kills: 0, combo: 0, comboTimer: 0, bestCombo: 0, streak: 0, streakTimer: 0, fx: [],
  };
  for (let tries = 0; tries < 600 && s.rocks.length < 55; tries++) {
    const x = (rand(s) * 2 - 1) * (BOUNDS.x - 4);
    const z = (rand(s) * 2 - 1) * (BOUNDS.z - 4);
    const r = 1.5 + rand(s) * 2.5;
    if (pads.some(p => dist2(x, z, p.x, p.z) < (PAD_RADIUS + r + 5) ** 2)) continue;
    if (EDGES.some(([a, b]) => segDist2(x, z, pads[a].x, pads[a].z, pads[b].x, pads[b].z) < (r + 5) ** 2)) continue;
    if (s.rocks.some(k => dist2(x, z, k.x, k.z) < (r + k.r + 4) ** 2)) continue;
    s.rocks.push({ x, z, r });
  }
  for (const p of pads) {
    if (p.owner === 'red' || p.owner === 'amber' || p.owner === 'green') {
      spawnBot(s, p.owner, 'assault', p.x + 3, p.z);
      spawnBot(s, p.owner, 'scout', p.x - 3, p.z);
    }
  }
  spawnBot(s, 'player', 'assault', hq.x + 4, hq.z - 2);
  spawnBot(s, 'player', 'assault', hq.x - 4, hq.z - 2);
  return s;
}

export function spawnBot(s: ActionState, team: Team, kind: BotKind, x: number, z: number): Bot {
  const def = BOT_DEFS[kind];
  const b: Bot = { id: s.nextId++, team, kind, x, z, angle: 0, hp: def.hp, maxHp: def.hp, fireCd: 1 + rand(s), goal: null, retarget: 0, flash: 0, moving: false };
  s.bots.push(b);
  return b;
}

export function padsOwned(s: ActionState, team: Team) {
  return s.pads.reduce((n, p) => n + (p.owner === team ? 1 : 0), 0);
}

/** Bonuses the player earns from held territory. */
export function playerMods(s: ActionState) {
  let metal = 0, energy = 0, factories = 0;
  for (const p of s.pads) {
    if (p.owner !== 'player') continue;
    if (p.kind === 'metal') metal++;
    else if (p.kind === 'energy') energy++;
    else if (p.kind === 'factory') factories++;
  }
  return { damage: 1 + 0.1 * metal, recharge: 1 + 0.2 * energy, factories };
}

export function rivalHqStatus(s: ActionState) {
  return RIVAL_TEAMS.map(team => {
    const pad = s.pads.find(p => p.kind === 'hq' && REGION_DEFS[p.id].owner === team)!;
    return { team, pad: pad.id, captured: pad.owner === 'player', owner: pad.owner };
  });
}

function announce(s: ActionState, text: string, tone: Tone) {
  s.fx.push({ type: 'announce', text, tone });
}

function addShot(s: ActionState, team: Team, kind: ShotKind, x: number, z: number, angle: number, speed: number, dmg: number, life: number, byMech = false, y = 1.8): Shot {
  const shot: Shot = {
    id: s.nextId++, team, kind, byMech, x, z, y, vx: Math.sin(angle) * speed, vz: Math.cos(angle) * speed,
    dmg, life, aoe: 0, target: null, sx: x, sz: z, tx: x, tz: z, t: 0, dur: 0,
  };
  s.shots.push(shot);
  return shot;
}

export function stepAction(s: ActionState, input: ActionInput, dt: number) {
  while (dt > 1e-6) {
    const h = Math.min(dt, MAX_DT);
    tick(s, input, h);
    dt -= h;
    // Edge-triggered buttons fire once per frame, not once per sub-step.
    input = { ...input, dash: false, missile: false };
  }
}

function tick(s: ActionState, input: ActionInput, dt: number) {
  if (s.status !== 'playing') return;
  s.time += dt;
  updateMech(s, input, dt);
  updateCore(s, dt);
  updatePads(s, dt);
  updateBots(s, dt);
  updateShots(s, dt);
  updatePickups(s, dt);
  s.comboTimer -= dt;
  if (s.comboTimer <= 0) s.combo = 0;
  s.streakTimer -= dt;
  if (s.streakTimer <= 0) s.streak = 0;
  s.bots = s.bots.filter(b => !b.dead);
  s.shots = s.shots.filter(b => !b.dead);
  s.pickups = s.pickups.filter(b => !b.dead);
  checkEnd(s);
}

function pushOut(s: ActionState, e: { x: number; z: number }, radius: number) {
  for (const r of s.rocks) {
    const d2 = dist2(e.x, e.z, r.x, r.z);
    const min = r.r + radius;
    if (d2 < min * min && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      e.x = r.x + ((e.x - r.x) / d) * min;
      e.z = r.z + ((e.z - r.z) / d) * min;
    }
  }
  if (s.core.alive) {
    const min = CORE_RADIUS + radius;
    const d2 = dist2(e.x, e.z, s.core.x, s.core.z);
    if (d2 < min * min && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      e.x = s.core.x + ((e.x - s.core.x) / d) * min;
      e.z = s.core.z + ((e.z - s.core.z) / d) * min;
    }
  }
  e.x = clamp(e.x, -BOUNDS.x, BOUNDS.x);
  e.z = clamp(e.z, -BOUNDS.z, BOUNDS.z);
}

interface Target { x: number; z: number; kind: 'mech' | 'bot' | 'core'; bot?: Bot; vx: number; vz: number }

function nearestHostile(s: ActionState, team: Team, x: number, z: number, range: number, ignoreCore = false): Target | null {
  let best: Target | null = null;
  let bd = range * range;
  const m = s.mech;
  if (m.alive && hostile(team, 'player') && team !== 'player') {
    const d = dist2(x, z, m.x, m.z);
    if (d < bd) { bd = d; best = { x: m.x, z: m.z, kind: 'mech', vx: m.vx, vz: m.vz }; }
  }
  for (const b of s.bots) {
    if (b.dead || !hostile(team, b.team)) continue;
    const d = dist2(x, z, b.x, b.z);
    if (d < bd) { bd = d; best = { x: b.x, z: b.z, kind: 'bot', bot: b, vx: 0, vz: 0 }; }
  }
  if (!ignoreCore && s.core.alive && s.core.awake && hostile(team, 'rogue')) {
    const d = Math.max(0, Math.sqrt(dist2(x, z, s.core.x, s.core.z)) - CORE_RADIUS) ** 2;
    if (d < bd) best = { x: s.core.x, z: s.core.z, kind: 'core', vx: 0, vz: 0 };
  }
  return best;
}

function updateMech(s: ActionState, input: ActionInput, dt: number) {
  const m = s.mech;
  if (!m.alive) {
    m.respawn -= dt;
    if (m.respawn <= 0 && m.lives > 0 && s.pads[PLAYER_HQ].owner === 'player') {
      const hq = s.pads[PLAYER_HQ];
      Object.assign(m, { alive: true, x: hq.x, z: hq.z - 6, hp: m.maxHp, shield: 40, invuln: 2.5, missiles: MAX_MISSILES, dashTime: 0, vx: 0, vz: 0 });
      announce(s, 'Mech redeployed', 'info');
    }
    return;
  }
  const mods = playerMods(s);
  m.dashCd -= dt;
  m.fireCd -= dt;
  m.invuln -= dt;
  m.overdrive = Math.max(0, m.overdrive - dt);

  let mx = input.moveX, mz = input.moveZ;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  if (input.dash && m.dashCd <= 0) {
    let dx = mx, dz = mz;
    if (Math.hypot(dx, dz) < 0.2) { dx = Math.sin(m.aim); dz = Math.cos(m.aim); }
    const l = Math.hypot(dx, dz);
    m.dashX = dx / l; m.dashZ = dz / l;
    m.dashTime = 0.2;
    m.dashCd = 1.4;
    m.invuln = Math.max(m.invuln, 0.3);
    s.fx.push({ type: 'dash', x: m.x, z: m.z });
  }
  if (m.dashTime > 0) {
    m.dashTime -= dt;
    m.vx = m.dashX * 46; m.vz = m.dashZ * 46;
  } else {
    const speed = 16;
    const k = 1 - Math.exp(-14 * dt);
    m.vx += (mx * speed - m.vx) * k;
    m.vz += (mz * speed - m.vz) * k;
  }
  m.x += m.vx * dt;
  m.z += m.vz * dt;
  pushOut(s, m, MECH_RADIUS);

  let firing = input.fire;
  if (Math.hypot(input.aimX, input.aimZ) > 0.15) {
    m.aim = Math.atan2(input.aimX, input.aimZ);
  } else if (input.autoAim) {
    const t = nearestHostile(s, 'player', m.x, m.z, 30);
    if (t) { m.aim = Math.atan2(t.x - m.x, t.z - m.z); firing = true; }
  }
  if (firing && m.fireCd <= 0) {
    const od = m.overdrive > 0;
    m.fireCd = od ? 1 / 18 : 1 / 9;
    m.gunSide = -m.gunSide;
    const ox = Math.cos(m.aim) * 0.95 * m.gunSide, oz = -Math.sin(m.aim) * 0.95 * m.gunSide;
    const spread = (rand(s) - 0.5) * (od ? 0.12 : 0.04);
    const gx = m.x + ox + Math.sin(m.aim) * 1.6, gz = m.z + oz + Math.cos(m.aim) * 1.6;
    addShot(s, 'player', 'bolt', gx, gz, m.aim + spread, 80, 9 * mods.damage, 0.55, true, 2.3);
    s.fx.push({ type: 'muzzle', x: gx, z: gz, angle: m.aim, team: 'player', byMech: true });
  }
  if (m.missiles < MAX_MISSILES) {
    m.missileCharge += (dt * mods.recharge) / 5;
    if (m.missileCharge >= 1) { m.missiles++; m.missileCharge = 0; }
  } else m.missileCharge = 0;
  if (input.missile && m.missiles > 0) {
    m.missiles--;
    const used = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const a = m.aim + (i - 2.5) * 0.22;
      const shot = addShot(s, 'player', 'missile', m.x, m.z, a, 26, 30 * mods.damage, 2.6, true, 3.6);
      shot.aoe = 5;
      let best: Bot | null = null, bd = 50 * 50;
      for (const b of s.bots) {
        if (!hostile('player', b.team) || used.has(b.id)) continue;
        const d = dist2(m.x, m.z, b.x, b.z);
        if (d < bd) { bd = d; best = b; }
      }
      if (best) { shot.target = best.id; used.add(best.id); }
      else if (s.core.awake && s.core.alive && dist2(m.x, m.z, s.core.x, s.core.z) < 60 * 60) shot.target = -1;
    }
    s.fx.push({ type: 'missile' });
  }
  const hq = s.pads[PLAYER_HQ];
  if (hq.owner === 'player' && dist2(m.x, m.z, hq.x, hq.z) < PAD_RADIUS * PAD_RADIUS) m.hp = Math.min(m.maxHp, m.hp + 30 * dt);
}

function damageMech(s: ActionState, dmg: number) {
  const m = s.mech;
  if (!m.alive || m.invuln > 0 || m.dashTime > 0) return;
  if (m.shield > 0) {
    const a = Math.min(m.shield, dmg);
    m.shield -= a;
    dmg -= a;
  }
  m.hp -= dmg;
  s.fx.push({ type: 'hurt' });
  s.fx.push({ type: 'shake', amount: Math.min(0.5, 0.12 + dmg / 60) });
  if (m.hp <= 0) {
    m.hp = 0;
    m.alive = false;
    m.lives--;
    m.respawn = 3;
    m.overdrive = 0;
    s.combo = 0;
    s.fx.push({ type: 'boom', x: m.x, z: m.z, size: 3, team: 'player' });
    s.fx.push({ type: 'shake', amount: 1 });
    announce(s, m.lives > 0 ? `Mech destroyed · ${m.lives} ${m.lives === 1 ? 'life' : 'lives'} left` : 'Mech destroyed', 'bad');
  }
}

function damageBot(s: ActionState, b: Bot, dmg: number, byMech: boolean) {
  if (b.dead) return;
  b.hp -= dmg;
  b.flash = 0.09;
  if (b.hp > 0) return;
  b.dead = true;
  const big = b.kind === 'assault' || b.kind === 'artillery';
  s.fx.push({ type: 'boom', x: b.x, z: b.z, size: big ? 1.6 : 1.1, team: b.team });
  if (!byMech) return;
  s.kills++;
  s.combo++;
  s.comboTimer = 3;
  s.bestCombo = Math.max(s.bestCombo, s.combo);
  s.score += BOT_DEFS[b.kind].score * Math.min(10, s.combo);
  s.streak++;
  s.streakTimer = 1.4;
  const call: Record<number, string> = { 2: 'Double kill', 3: 'Triple kill', 5: 'Rampage', 8: 'Unstoppable', 12: 'Iron god' };
  if (call[s.streak]) announce(s, call[s.streak], 'epic');
  if (rand(s) < 0.16) {
    const roll = rand(s);
    const kind: PickupKind = roll < 0.5 ? 'repair' : roll < 0.78 ? 'overdrive' : 'shield';
    s.pickups.push({ id: s.nextId++, kind, x: b.x, z: b.z, life: 15 });
  }
}

function damageCore(s: ActionState, dmg: number, x: number, z: number) {
  const c = s.core;
  if (!c.alive) return;
  if (!c.awake) {
    s.fx.push({ type: 'hit', x, z, team: 'rogue', shield: true });
    return;
  }
  c.hp -= dmg;
  s.fx.push({ type: 'hit', x, z, team: 'rogue' });
  if (c.hp <= 0) {
    c.hp = 0;
    c.alive = false;
    s.score += 5000;
    const pad = s.pads[CORE_PAD];
    pad.owner = 'neutral';
    pad.capture = { team: null, progress: 0 };
    for (let i = 0; i < 6; i++) s.fx.push({ type: 'boom', x: c.x + (rand(s) - 0.5) * 10, z: c.z + (rand(s) - 0.5) * 10, size: 2.5 + i * 0.3, team: 'rogue' });
    s.fx.push({ type: 'shake', amount: 1.5 });
    s.fx.push({ type: 'slowmo', seconds: 1.5 });
    for (const b of s.bots) if (b.team === 'rogue') { b.dead = true; s.fx.push({ type: 'boom', x: b.x, z: b.z, size: 1.2, team: 'rogue' }); }
    announce(s, 'Rogue Core destroyed', 'epic');
  }
}

function explode(s: ActionState, x: number, z: number, radius: number, dmg: number, team: Team, byMech: boolean) {
  s.fx.push({ type: 'boom', x, z, size: radius / 4, team });
  const r2 = radius * radius;
  if (hostile(team, 'player') && team !== 'player' && dist2(x, z, s.mech.x, s.mech.z) < r2) damageMech(s, dmg);
  for (const b of s.bots) if (hostile(team, b.team) && dist2(x, z, b.x, b.z) < r2) damageBot(s, b, dmg, byMech);
  if (hostile(team, 'rogue') && dist2(x, z, s.core.x, s.core.z) < (radius + CORE_RADIUS) ** 2) damageCore(s, dmg, x, z);
}

function updateCore(s: ActionState, dt: number) {
  const c = s.core;
  if (!c.alive) return;
  if (!c.awake && (padsOwned(s, 'player') >= CORE_WAKE_PADS || s.time >= CORE_WAKE_TIME)) {
    c.awake = true;
    announce(s, 'Warning · Rogue Core awakened', 'warn');
    s.fx.push({ type: 'shake', amount: 0.8 });
  }
  if (!c.awake) return;
  const rage = c.hp < c.maxHp / 2;
  c.spin += dt * (rage ? 1.7 : 1.1);
  c.fireCd -= dt;
  if (c.fireCd <= 0) {
    c.fireCd = rage ? 0.12 : 0.18;
    const arms = rage ? 4 : 3;
    for (let k = 0; k < arms; k++) {
      const a = c.spin + (k * Math.PI * 2) / arms;
      addShot(s, 'rogue', 'orb', c.x + Math.sin(a) * CORE_RADIUS, c.z + Math.cos(a) * CORE_RADIUS, a, 17, 9, 4.5, false, 3);
    }
  }
  c.ringCd -= dt;
  if (c.ringCd <= 0) {
    c.ringCd = rage ? 3.5 : 5;
    for (let k = 0; k < 28; k++) {
      const a = (k * Math.PI * 2) / 28 + c.spin * 0.5;
      addShot(s, 'rogue', 'orb', c.x + Math.sin(a) * CORE_RADIUS, c.z + Math.cos(a) * CORE_RADIUS, a, 12, 12, 6, false, 3);
    }
    s.fx.push({ type: 'boom', x: c.x, z: c.z, size: 0.8, team: 'rogue' });
  }
  c.spawnCd -= dt;
  if (c.spawnCd <= 0) {
    c.spawnCd = rage ? 4.5 : 7;
    if (s.bots.filter(b => b.team === 'rogue').length < ROGUE_CAP) {
      const a = rand(s) * Math.PI * 2;
      spawnBot(s, 'rogue', 'sentinel', c.x + Math.sin(a) * (CORE_RADIUS + 3), c.z + Math.cos(a) * (CORE_RADIUS + 3));
    }
  }
}

function changeOwner(s: ActionState, pad: Pad, team: Team) {
  const prev = pad.owner;
  pad.owner = team;
  pad.capture = { team: null, progress: 0 };
  pad.spawnTimer = 4;
  s.fx.push({ type: 'capture', pad: pad.id, team });
  if (team === 'player') {
    s.score += pad.kind === 'hq' ? 1500 : 250;
    if (pad.kind === 'hq' && prev !== 'player') announce(s, `${TEAM_NAMES[prev]} HQ seized`, 'epic');
    else announce(s, `${pad.name} captured`, 'good');
  } else if (prev === 'player') {
    announce(s, `${pad.name} lost to ${TEAM_NAMES[team]}`, 'bad');
  }
}

const presence = new Map<Team, number>();

function updatePads(s: ActionState, dt: number) {
  const r2 = PAD_RADIUS * PAD_RADIUS;
  const m = s.mech;
  for (const pad of s.pads) {
    presence.clear();
    if (m.alive && dist2(m.x, m.z, pad.x, pad.z) < r2) presence.set('player', 2);
    for (const b of s.bots) {
      if (!b.dead && dist2(b.x, b.z, pad.x, pad.z) < r2) presence.set(b.team, (presence.get(b.team) || 0) + 1);
    }
    const lockedCore = pad.id === CORE_PAD && s.core.alive;
    if (!lockedCore) {
      const cap = pad.capture;
      if (presence.size === 1) {
        const [team, weight] = presence.entries().next().value as [Team, number];
        if (team === pad.owner) {
          cap.progress = Math.max(0, cap.progress - 30 * dt);
        } else if (cap.team !== team) {
          cap.progress -= 45 * dt;
          if (cap.progress <= 0) { cap.team = team; cap.progress = 0; }
        } else {
          const rate = (pad.kind === 'hq' ? 6 : 12) * Math.min(weight, 4);
          cap.progress += rate * dt;
          if (cap.progress >= 100) changeOwner(s, pad, team);
        }
      } else if (presence.size === 0) {
        cap.progress = Math.max(0, cap.progress - 10 * dt);
      }
      if (cap.progress <= 0 && presence.size !== 1) cap.team = null;
    }
    spawnFrom(s, pad, dt);
    turret(s, pad, dt);
  }
}

function spawnFrom(s: ActionState, pad: Pad, dt: number) {
  if (pad.kind !== 'hq' && pad.kind !== 'factory') return;
  const team = pad.owner;
  if (team === 'neutral' || team === 'rogue') return;
  pad.spawnTimer -= dt;
  if (pad.spawnTimer > 0) return;
  const count = s.bots.reduce((n, b) => n + (b.team === team ? 1 : 0), 0);
  const a = rand(s) * Math.PI * 2;
  const x = pad.x + Math.sin(a) * 4, z = pad.z + Math.cos(a) * 4;
  if (team === 'player') {
    pad.spawnTimer = 12;
    if (count < ALLY_CAP) spawnBot(s, 'player', rand(s) < 0.65 ? 'assault' : 'scout', x, z);
    return;
  }
  pad.spawnTimer = Math.max(4.5, 10 - s.time / 80) + rand(s) * 2;
  if (count >= RIVAL_CAP + Math.floor(s.time / 120)) return;
  const roll = rand(s);
  spawnBot(s, team, roll < 0.4 ? 'scout' : roll < 0.8 ? 'assault' : 'artillery', x, z);
}

function turret(s: ActionState, pad: Pad, dt: number) {
  if (pad.kind !== 'hq' || pad.owner === 'neutral' || pad.owner === 'rogue') return;
  pad.turretCd -= dt;
  const t = nearestHostile(s, pad.owner, pad.x, pad.z, 26, true);
  if (!t) return;
  pad.turretAngle = Math.atan2(t.x - pad.x, t.z - pad.z);
  if (pad.turretCd > 0) return;
  pad.turretCd = 0.45;
  addShot(s, pad.owner, 'bolt', pad.x + Math.sin(pad.turretAngle) * 2.5, pad.z + Math.cos(pad.turretAngle) * 2.5, pad.turretAngle, 48, 7, 0.65, false, 5.2);
  s.fx.push({ type: 'muzzle', x: pad.x, z: pad.z, angle: pad.turretAngle, team: pad.owner, byMech: false });
}

function chooseGoal(s: ActionState, b: Bot): number | null {
  let best: number | null = null, bd = Infinity;
  for (const p of s.pads) {
    if (p.owner === b.team) continue;
    if (p.id === CORE_PAD && s.core.alive) continue;
    let d = Math.sqrt(dist2(b.x, b.z, p.x, p.z));
    if (p.owner === 'player') d -= b.team === 'rogue' ? 80 : 30;
    if (p.owner === 'neutral') d -= 10;
    d += ((b.id * 7 + p.id * 13) % 11) * 2;
    if (d < bd) { bd = d; best = p.id; }
  }
  return best;
}

function updateBots(s: ActionState, dt: number) {
  const m = s.mech;
  for (const b of s.bots) {
    if (b.dead) continue;
    const def = BOT_DEFS[b.kind];
    b.flash -= dt;
    b.fireCd -= dt;
    b.retarget -= dt;
    const target = nearestHostile(s, b.team, b.x, b.z, def.range + 10);
    let gx: number | null = null, gz = 0, stop = 3;
    if (target) {
      b.angle = Math.atan2(target.x - b.x, target.z - b.z);
      const d = Math.sqrt(dist2(b.x, b.z, target.x, target.z)) - (target.kind === 'core' ? CORE_RADIUS : 0);
      if (d > def.range * 0.8) { gx = target.x; gz = target.z; stop = def.range * 0.7; }
      else {
        // Strafe around the target to stay hard to hit.
        const side = (b.id % 2 ? 1 : -1) * Math.sin(s.time * 0.8 + b.id);
        gx = b.x + Math.cos(b.angle) * side * 4;
        gz = b.z - Math.sin(b.angle) * side * 4;
        stop = 0.5;
      }
      if (b.fireCd <= 0 && d <= def.range) botFire(s, b, target);
    } else if (b.team === 'player' && m.alive && dist2(b.x, b.z, m.x, m.z) > 12 * 12) {
      const a = (b.id * 2.4) % (Math.PI * 2);
      gx = m.x + Math.sin(a) * 6; gz = m.z + Math.cos(a) * 6; stop = 2;
    } else if (b.team !== 'player') {
      if (b.retarget <= 0 || b.goal === null || s.pads[b.goal].owner === b.team) {
        b.goal = chooseGoal(s, b);
        b.retarget = 6;
      }
      if (b.goal !== null) {
        const p = s.pads[b.goal];
        const a = (b.id * 2.4) % (Math.PI * 2);
        gx = p.x + Math.sin(a) * 3; gz = p.z + Math.cos(a) * 3; stop = 1;
      }
    }
    b.moving = false;
    if (gx !== null) {
      const dx = gx - b.x, dz = gz - b.z;
      const d = Math.hypot(dx, dz);
      if (d > stop) {
        const step = Math.min(d - stop, def.speed * dt);
        b.x += (dx / d) * step;
        b.z += (dz / d) * step;
        if (!target) b.angle = Math.atan2(dx, dz);
        b.moving = true;
      }
    }
    for (const o of s.bots) {
      if (o === b || o.dead) continue;
      const min = def.radius + BOT_DEFS[o.kind].radius;
      const d2 = dist2(b.x, b.z, o.x, o.z);
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2), push = (min - d) * 0.5;
        b.x += ((b.x - o.x) / d) * push;
        b.z += ((b.z - o.z) / d) * push;
      }
    }
    pushOut(s, b, def.radius);
  }
}

function botFire(s: ActionState, b: Bot, t: Target) {
  const def = BOT_DEFS[b.kind];
  b.fireCd = def.cooldown * (0.85 + rand(s) * 0.3);
  const mx = b.x + Math.sin(b.angle) * def.radius, mz = b.z + Math.cos(b.angle) * def.radius;
  if (b.kind === 'artillery') {
    const lead = 0.8;
    const shot = addShot(s, b.team, 'shell', b.x, b.z, b.angle, 0, 26, 99, false, 3);
    shot.tx = t.x + t.vx * lead + (rand(s) - 0.5) * 3;
    shot.tz = t.z + t.vz * lead + (rand(s) - 0.5) * 3;
    shot.dur = 1.6;
    shot.aoe = 6;
  } else if (b.kind === 'assault') {
    for (let i = -1; i <= 1; i++) addShot(s, b.team, 'bolt', mx, mz, b.angle + i * 0.09, 34, 6, 0.75);
  } else {
    addShot(s, b.team, 'bolt', mx, mz, b.angle + (rand(s) - 0.5) * 0.06, b.kind === 'scout' ? 38 : 36, b.kind === 'scout' ? 4 : 7, 0.6);
  }
  s.fx.push({ type: 'muzzle', x: mx, z: mz, angle: b.angle, team: b.team, byMech: false });
}

function updateShots(s: ActionState, dt: number) {
  const m = s.mech;
  for (const sh of s.shots) {
    if (sh.dead) continue;
    if (sh.kind === 'shell') {
      sh.t += dt;
      const u = Math.min(1, sh.t / sh.dur);
      sh.x = sh.sx + (sh.tx - sh.sx) * u;
      sh.z = sh.sz + (sh.tz - sh.sz) * u;
      sh.y = 3 + 14 * u * (1 - u) - 3 * u;
      if (u >= 1) { sh.dead = true; explode(s, sh.tx, sh.tz, sh.aoe, sh.dmg, sh.team, false); }
      continue;
    }
    if (sh.kind === 'missile') {
      let tx: number | null = null, tz = 0;
      if (sh.target === -1 && s.core.alive) { tx = s.core.x; tz = s.core.z; }
      else if (sh.target !== null) {
        const t = s.bots.find(b => b.id === sh.target && !b.dead);
        if (t) { tx = t.x; tz = t.z; } else sh.target = null;
      }
      const speed = Math.min(60, Math.hypot(sh.vx, sh.vz) + 50 * dt);
      let a = Math.atan2(sh.vx, sh.vz);
      if (tx !== null) {
        let diff = Math.atan2(tx - sh.x, tz - sh.z) - a;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        a += clamp(diff, -5 * dt, 5 * dt);
      }
      sh.vx = Math.sin(a) * speed; sh.vz = Math.cos(a) * speed;
    }
    sh.x += sh.vx * dt;
    sh.z += sh.vz * dt;
    sh.life -= dt;
    let hit = false;
    if (sh.team !== 'player' && m.alive && dist2(sh.x, sh.z, m.x, m.z) < (MECH_RADIUS + 0.3) ** 2) {
      if (sh.kind === 'missile') explode(s, sh.x, sh.z, sh.aoe, sh.dmg, sh.team, sh.byMech);
      else { damageMech(s, sh.dmg); s.fx.push({ type: 'hit', x: sh.x, z: sh.z, team: sh.team }); }
      hit = true;
    }
    if (!hit) {
      for (const b of s.bots) {
        if (b.dead || !hostile(sh.team, b.team)) continue;
        const r = BOT_DEFS[b.kind].radius + 0.3;
        if (dist2(sh.x, sh.z, b.x, b.z) < r * r) {
          if (sh.kind === 'missile') explode(s, sh.x, sh.z, sh.aoe, sh.dmg, sh.team, sh.byMech);
          else { damageBot(s, b, sh.dmg, sh.byMech); s.fx.push({ type: 'hit', x: sh.x, z: sh.z, team: sh.team }); }
          hit = true;
          break;
        }
      }
    }
    if (!hit && s.core.alive && hostile(sh.team, 'rogue') && dist2(sh.x, sh.z, s.core.x, s.core.z) < CORE_RADIUS * CORE_RADIUS) {
      if (sh.kind === 'missile' && s.core.awake) explode(s, sh.x, sh.z, sh.aoe, sh.dmg, sh.team, sh.byMech);
      else damageCore(s, sh.dmg, sh.x, sh.z);
      hit = true;
    }
    if (!hit && sh.kind !== 'orb') {
      for (const r of s.rocks) {
        if (dist2(sh.x, sh.z, r.x, r.z) < r.r * r.r) {
          if (sh.kind === 'missile') explode(s, sh.x, sh.z, sh.aoe, sh.dmg, sh.team, sh.byMech);
          else s.fx.push({ type: 'hit', x: sh.x, z: sh.z, team: sh.team });
          hit = true;
          break;
        }
      }
    }
    if (!hit && sh.life <= 0) {
      if (sh.kind === 'missile') explode(s, sh.x, sh.z, sh.aoe, sh.dmg, sh.team, sh.byMech);
      hit = true;
    }
    if (hit || Math.abs(sh.x) > BOUNDS.x + 20 || Math.abs(sh.z) > BOUNDS.z + 20) sh.dead = true;
  }
}

function updatePickups(s: ActionState, dt: number) {
  const m = s.mech;
  for (const p of s.pickups) {
    p.life -= dt;
    if (p.life <= 0) { p.dead = true; continue; }
    if (!m.alive || dist2(p.x, p.z, m.x, m.z) > 3 * 3) continue;
    p.dead = true;
    if (p.kind === 'repair') m.hp = Math.min(m.maxHp, m.hp + 60);
    else if (p.kind === 'overdrive') { m.overdrive = 8; announce(s, 'Overdrive', 'good'); }
    else m.shield = Math.min(120, m.shield + 70);
    s.score += 50;
    s.fx.push({ type: 'pickup', x: p.x, z: p.z, kind: p.kind });
  }
}

function checkEnd(s: ActionState) {
  if (s.status !== 'playing') return;
  if (s.mech.lives <= 0 && !s.mech.alive) {
    s.status = 'defeat';
    announce(s, 'Dominion has fallen', 'bad');
  } else if (s.pads[PLAYER_HQ].owner !== 'player') {
    s.status = 'defeat';
    announce(s, 'Dominion HQ overrun', 'bad');
  } else if (!s.core.alive && rivalHqStatus(s).every(r => r.captured)) {
    s.status = 'victory';
    s.score += s.mech.lives * 1000;
    announce(s, 'Total dominion', 'epic');
  }
}

export function objective(s: ActionState): string {
  const hqs = rivalHqStatus(s);
  const left = hqs.filter(h => !h.captured).length;
  if (!s.core.awake && s.core.alive) return `Capture regions to draw out the Rogue Core (${Math.min(padsOwned(s, 'player'), CORE_WAKE_PADS)}/${CORE_WAKE_PADS})`;
  if (s.core.alive && left) return `Destroy the Rogue Core and seize ${left} rival HQ${left === 1 ? '' : 's'}`;
  if (s.core.alive) return 'Destroy the Rogue Core';
  return `Seize ${left} remaining rival HQ${left === 1 ? '' : 's'}`;
}
