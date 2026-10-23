import { describe, it, expect } from 'vitest';
import {
  createAction, stepAction, spawnBot, padsOwned, rivalHqStatus, playerMods,
  IDLE_INPUT, BOUNDS, PLAYER_HQ, CORE_PAD, CORE_WAKE_PADS, PAD_RADIUS,
  type ActionState,
} from './sim';

const quiet = (s: ActionState) => { s.bots = []; s.shots = []; for (const p of s.pads) p.spawnTimer = 1e9; return s; };
const run = (s: ActionState, seconds: number, input = IDLE_INPUT) => { for (let t = 0; t < seconds; t += 1 / 60) stepAction(s, input, 1 / 60); };

describe('3D action simulation', () => {
  it('builds 18 regions with the player at Dominion HQ and three rival HQs', () => {
    const s = createAction(7);
    expect(s.pads).toHaveLength(18);
    expect(s.pads[PLAYER_HQ].owner).toBe('player');
    expect(rivalHqStatus(s).map(r => r.owner)).toEqual(['red', 'amber', 'green']);
    expect(s.rocks.length).toBeGreaterThan(10);
    expect(Math.hypot(s.mech.x - s.pads[PLAYER_HQ].x, s.mech.z - s.pads[PLAYER_HQ].z)).toBeLessThan(PAD_RADIUS);
  });

  it('moves the mech with input and keeps it inside the arena', () => {
    const s = quiet(createAction(1));
    const z0 = s.mech.z;
    run(s, 0.5, { ...IDLE_INPUT, moveZ: -1 });
    expect(s.mech.z).toBeLessThan(z0 - 4);
    run(s, 30, { ...IDLE_INPUT, moveX: 1 });
    expect(s.mech.x).toBeLessThanOrEqual(BOUNDS.x);
  });

  it('dashes once per cooldown and is invulnerable while dashing', () => {
    const s = quiet(createAction(1));
    stepAction(s, { ...IDLE_INPUT, dash: true, moveX: 1 }, 1 / 60);
    expect(s.mech.dashTime).toBeGreaterThan(0);
    const hp = s.mech.hp;
    s.shots.push({ id: 999, team: 'red', kind: 'bolt', byMech: false, x: s.mech.x, z: s.mech.z, y: 2, vx: 0, vz: 0, dmg: 50, life: 1, aoe: 0, target: null, sx: 0, sz: 0, tx: 0, tz: 0, t: 0, dur: 0 });
    stepAction(s, IDLE_INPUT, 1 / 60);
    expect(s.mech.hp).toBe(hp);
  });

  it('shoots and destroys an enemy, scoring a kill and combo', () => {
    const s = quiet(createAction(2));
    s.mech.x = 0; s.mech.z = 120;
    const bot = spawnBot(s, 'red', 'scout', 0, 108);
    bot.fireCd = 99;
    run(s, 2, { ...IDLE_INPUT, autoAim: true });
    expect(s.bots.find(b => b.id === bot.id)).toBeUndefined();
    expect(s.kills).toBe(1);
    expect(s.score).toBeGreaterThan(0);
    expect(s.fx.some(f => f.type === 'boom')).toBe(true);
  });

  it('missile salvos spend a charge and recharge over time', () => {
    const s = quiet(createAction(3));
    stepAction(s, { ...IDLE_INPUT, missile: true }, 1 / 60);
    expect(s.mech.missiles).toBe(2);
    expect(s.shots.filter(x => x.kind === 'missile')).toHaveLength(6);
    run(s, 6);
    expect(s.mech.missiles).toBe(3);
  });

  it('captures a neutral region by standing on it, and stalls when contested', () => {
    const s = quiet(createAction(4));
    const pad = s.pads[3];
    s.mech.x = pad.x; s.mech.z = pad.z;
    run(s, 2);
    const mid = pad.capture.progress;
    expect(pad.capture.team).toBe('player');
    const enemy = spawnBot(s, 'red', 'assault', pad.x + 2, pad.z);
    enemy.fireCd = 1e9;
    s.mech.invuln = 1e9;
    run(s, 1);
    expect(pad.capture.progress).toBeCloseTo(mid, 0);
    enemy.dead = true;
    s.bots = [];
    run(s, 4);
    expect(pad.owner).toBe('player');
  });

  it('keeps the core shielded until the player holds enough territory', () => {
    const s = quiet(createAction(5));
    s.mech.invuln = 1e9;
    const pad = s.pads[CORE_PAD];
    s.mech.x = pad.x; s.mech.z = pad.z + 14;
    run(s, 1, { ...IDLE_INPUT, aimZ: -1, fire: true });
    expect(s.core.hp).toBe(s.core.maxHp);
    for (const p of s.pads.slice(1, CORE_WAKE_PADS)) p.owner = 'player';
    run(s, 2, { ...IDLE_INPUT, aimZ: -1, fire: true });
    expect(s.core.awake).toBe(true);
    expect(s.core.hp).toBeLessThan(s.core.maxHp);
  });

  it('owning metal and energy regions boosts damage and recharge', () => {
    const s = createAction(6);
    const base = playerMods(s);
    s.pads.find(p => p.kind === 'metal')!.owner = 'player';
    s.pads.find(p => p.kind === 'energy')!.owner = 'player';
    const mods = playerMods(s);
    expect(mods.damage).toBeGreaterThan(base.damage);
    expect(mods.recharge).toBeGreaterThan(base.recharge);
  });

  it('wins when the core falls and every rival HQ is seized', () => {
    const s = quiet(createAction(8));
    for (const r of rivalHqStatus(s)) s.pads[r.pad].owner = 'player';
    s.core.awake = true;
    s.core.hp = 1;
    s.mech.invuln = 1e9;
    s.mech.x = s.core.x; s.mech.z = s.core.z + 12;
    run(s, 1, { ...IDLE_INPUT, aimZ: -1, fire: true });
    expect(s.core.alive).toBe(false);
    expect(s.status).toBe('victory');
    expect(padsOwned(s, 'player')).toBeGreaterThanOrEqual(4);
  });

  it('loses when the last life is spent or the HQ falls', () => {
    const s = quiet(createAction(9));
    s.mech.lives = 1;
    s.mech.hp = 5;
    s.shots.push({ id: 999, team: 'red', kind: 'bolt', byMech: false, x: s.mech.x, z: s.mech.z, y: 2, vx: 0, vz: 0, dmg: 50, life: 1, aoe: 0, target: null, sx: 0, sz: 0, tx: 0, tz: 0, t: 0, dur: 0 });
    stepAction(s, IDLE_INPUT, 1 / 60);
    expect(s.status).toBe('defeat');

    const t = quiet(createAction(9));
    t.pads[PLAYER_HQ].owner = 'red';
    stepAction(t, IDLE_INPUT, 1 / 60);
    expect(t.status).toBe('defeat');
  });

  it('does not advance when given zero elapsed time', () => {
    const s = createAction(10);
    const snapshot = JSON.stringify(s);
    stepAction(s, IDLE_INPUT, 0);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('runs a long chaotic battle without invalid numbers', () => {
    const s = createAction(11);
    s.mech.invuln = 1e9;
    run(s, 120, { ...IDLE_INPUT, fire: true, autoAim: true });
    for (const b of s.bots) expect(Number.isFinite(b.x + b.z + b.hp)).toBe(true);
    expect(s.bots.length).toBeLessThan(60);
    expect(s.shots.length).toBeLessThan(1500);
  });
});
