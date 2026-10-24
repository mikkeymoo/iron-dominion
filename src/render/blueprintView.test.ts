import { describe, expect, it } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import type { CommandBody } from '../sim/commands.ts';
import { MAP, S, TERRAIN } from '../sim/layers.ts';
import type { BlueprintStat, ProductionStat, Stats } from '../sim/protocol.ts';
import { PRODUCTION_CAP } from '../sim/robots/constants.ts';
import { tileIdx } from '../sim/tiles.ts';
import { MAX_TIER } from '../sim/unlocks.ts';
import { allocWorld } from '../sim/world.ts';
import { hologramPose } from './blueprints.ts';
import type { IconAnchor } from './instances.ts';
import { RenderMirror } from './mirror.ts';
import { overlayLayersOf, paintAll } from './overlayPaint.ts';
import { ICON, StatusIconSystem } from './statusIcons.ts';
import { ToolController, type ToolWorld } from './tools/controller.ts';
import { ghostTints } from './tools/toolSpec.ts';
import { OVERLAY_MODES } from './viewState.ts';

function controller(treasury = 0) {
  const w = allocWorld();
  w.terrain.fill(TERRAIN.GRASS);
  w.height.fill(160);
  w.scalars[S.treasury] = treasury;
  w.scalars[S.tier] = MAX_TIER;
  const world: ToolWorld = { layers: w as unknown as Record<string, ArrayLike<number>>, scalars: w.scalars, tick: 0 };
  const sent: CommandBody[] = [];
  const c = new ToolController({ world, submit: (b) => { sent.push(b); return sent.length; } });
  return { c, sent };
}

describe('Plan toggle', () => {
  it('turns a building placement into a free blueprint command, whatever the treasury holds', () => {
    const { c, sent } = controller(0);
    c.select({ tool: 'service', arch: ARCH.CLINIC });
    c.begin({ x: 40, y: 40 });
    expect(c.plan?.cmd.type).toBe('placeBuilding');
    expect(c.plan?.est.reason).toBe('funds');
    c.abortDrag();
    c.setPlanning(true);
    c.begin({ x: 40, y: 40 });
    expect(c.plan?.cmd).toMatchObject({ type: 'placeBlueprint', arch: ARCH.CLINIC });
    expect(c.plan?.est.cost).toBe(0);
    expect(c.plan?.est.reason).toBeUndefined();
    expect(c.end()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'placeBlueprint', arch: ARCH.CLINIC });
  });

  it('still refuses a blocked site, and leaves depots and megaprojects as direct placements', () => {
    const { c, sent } = controller(1e6);
    c.setPlanning(true);
    c.select({ tool: 'service', arch: ARCH.DEPOT });
    c.begin({ x: 40, y: 40 });
    expect(c.plan?.cmd.type).toBe('placeBuilding');
    c.abortDrag();
    c.select({ tool: 'service', arch: ARCH.FUSION_SPIRE });
    c.begin({ x: 60, y: 60 });
    expect(c.plan?.cmd.type).toBe('placeBuilding');
    c.abortDrag();
    c.select({ tool: 'service', arch: ARCH.CLINIC });
    c.begin({ x: 255, y: 255 });
    expect(c.plan?.cmd.type).toBe('placeBlueprint');
    expect(c.plan?.est.reason).toBe('bounds');
    expect(c.end()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('paints a valid blueprint cyan and a valid building green', () => {
    const e = { cost: 0, validTiles: [1], invalidTiles: [] };
    expect(ghostTints(e).valid).not.toEqual(ghostTints(e, true).valid);
    const [r, g, b] = ghostTints(e, true).valid;
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(0.9);
    expect(g).toBeGreaterThan(r);
  });
});

describe('hologram pose', () => {
  it('stands at the footprint centre, a quarter turn per rotation', () => {
    expect(hologramPose({ x: 10, y: 20, w: 3, h: 2, rot: 0 })).toEqual({ x: 11.5, z: 21, yaw: 0 });
    expect(hologramPose({ x: 10, y: 20, w: 2, h: 3, rot: 1 })).toEqual({ x: 11, z: 21.5, yaw: Math.PI / 2 });
  });
});

const bp = (slot: number, order: number): BlueprintStat => ({ slot, order, arch: ARCH.CLINIC, name: 'clinic', x: 10 + slot * 4, y: 10, w: 2, h: 2, rot: 0, cost: 900, etaSec: 20 + order });

describe('mirror stats', () => {
  const stats = (extra: Partial<Stats>): Stats => ({
    type: 'stats', tick: 5, treasury: 100, population: 0, rciDemand: [0, 0, 0], unemployment: 0, dayFrac: 0, day: 0, weather: 0, weatherIntensity: 0, ...extra,
  } as unknown as Stats);

  it('keeps the blueprint queue and the production list, and bumps a version only when one changed', () => {
    const m = new RenderMirror();
    const list = [bp(0, 0), bp(1, 1)];
    const production = { total: 1, list: [{ slot: 3, arch: ARCH.MINE, x: 5, y: 5, state: 'filling' as const }] };
    m.apply(stats({ blueprints: list, production }));
    expect([m.blueprints.map((b) => b.slot), m.blueprintVersion, m.productionVersion]).toEqual([[0, 1], 1, 1]);
    m.apply(stats({ blueprints: list.map((b) => ({ ...b })), production: { ...production } }));
    expect([m.blueprintVersion, m.productionVersion]).toEqual([1, 1]);
    m.apply(stats({ blueprints: [bp(1, 0)], production }));
    expect([m.blueprints.map((b) => b.slot), m.blueprintVersion, m.productionVersion]).toEqual([[1], 2, 1]);
  });
});

describe('production overlay', () => {
  it('is a Views choice and tints only ore ground', () => {
    expect(OVERLAY_MODES).toContain('production');
    const w = allocWorld();
    w.terrain.fill(TERRAIN.GRASS);
    w.terrain[tileIdx(20, 20)] = TERRAIN.ORE;
    w.terrain[tileIdx(21, 20)] = TERRAIN.ROCK;
    const out = new Uint8Array(MAP * MAP * 4);
    paintAll('production', overlayLayersOf(w as unknown as Record<string, ArrayLike<number>>), out);
    const px = (x: number, y: number): number[] => Array.from(out.subarray(tileIdx(x, y) * 4, tileIdx(x, y) * 4 + 4));
    expect(px(20, 20)[3]).toBeGreaterThan(100);
    expect(px(20, 20)[0]).toBeGreaterThan(px(20, 20)[2]!);
    expect(px(21, 20)).toEqual([0, 0, 0, 0]);
    expect(px(5, 5)).toEqual([0, 0, 0, 0]);
    expect(out.reduce((n, v, i) => n + (i % 4 === 3 && v > 0 ? 1 : 0), 0)).toBe(1);
  });

  function iconWorld(n: number) {
    const m = new RenderMirror();
    const anchors = new Map<number, IconAnchor>();
    const list: ProductionStat[] = [];
    const states = ['filling', 'starved', 'full'] as const;
    for (let s = 0; s < n; s++) {
      m.table.bArch[s] = ARCH.SMELTER; m.table.bX[s] = 10 + (s % 16) * 4; m.table.bY[s] = 10 + ((s / 16) | 0) * 4; m.table.bW[s] = 3; m.table.bH[s] = 3;
      anchors.set(s, { x: m.table.bX[s]! + 1.5, y: 4, z: m.table.bY[s]! + 1.5, gy: 1 });
      list.push({ slot: s, arch: ARCH.SMELTER, x: m.table.bX[s]!, y: m.table.bY[s]!, state: states[s % 3]! });
    }
    m.production = { total: n, list };
    m.productionVersion = 1;
    const sys = new StatusIconSystem(m, () => anchors, () => 1);
    return { m, sys };
  }

  it('shows filling, starved and full icons only while the overlay is on, starved first', () => {
    const { sys } = iconWorld(3);
    expect(sys.scan({ x: 20, z: 20 }, 40)).toEqual([]);
    sys.production = true;
    const recs = sys.scan({ x: 20, z: 20 }, 40);
    expect(recs.map((r) => r.kind)).toEqual([ICON.STARVED, ICON.FILLING, ICON.FULL]);
    expect(sys.byKind).toEqual({ starved: 1, filling: 1, full: 1 });
  });

  it('draws up to the 64 the Stats list carries, and the key follows the list', () => {
    const { m, sys } = iconWorld(PRODUCTION_CAP);
    sys.production = true;
    expect(sys.scan({ x: 40, z: 20 }, 40)).toHaveLength(PRODUCTION_CAP);
    expect(sys.refresh({ x: 40, z: 20 }, 40, 1000)).not.toBeNull();
    expect(sys.refresh({ x: 40, z: 20 }, 40, 2000)).toBeNull();
    m.productionVersion++;
    expect(sys.refresh({ x: 40, z: 20 }, 40, 3000)).not.toBeNull();
    expect(sys.scan({ x: 40, z: 20 }, 120)).toHaveLength(PRODUCTION_CAP);
  });
});
