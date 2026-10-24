import { describe, expect, it } from 'vitest';
import { ARCH, BFLAG } from '../sim/catalog.ts';
import { MAP, S } from '../sim/layers.ts';
import type { IconAnchor } from './instances.ts';
import { RenderMirror } from './mirror.ts';
import {
  ICON, ICON_CRIME, ICON_FAR, ICON_SMOG, MAX_ICONS, StatusIconSystem, farLevel, pickIcon, selectIcons, type IconKind, type IconSample, type StatusRec,
} from './statusIcons.ts';

const sample = (over: Partial<IconSample> = {}): IconSample => ({ flags: 0, zone: 1, level: 1, crime: 0, smog: 0, landValue: 120, demand: 0.2, unemployment: 0, ...over });

describe('pickIcon', () => {
  it('shows nothing for a healthy building, a ruin, or a fresh construction site', () => {
    expect(pickIcon(sample())).toBe(-1);
    expect(pickIcon(sample({ flags: BFLAG.RUBBLE | BFLAG.UNPOWERED | BFLAG.BURNING }))).toBe(-1);
    expect(pickIcon(sample({ flags: BFLAG.CONSTRUCTING, level: 1 }))).toBe(-1);
    expect(pickIcon(sample({ flags: BFLAG.CONSTRUCTING | BFLAG.DEMOLISHING, level: 3 }))).toBe(-1);
  });

  it('picks one icon by priority: fire, power, water, jobs, crime, smog, upgrade', () => {
    const all = sample({ flags: BFLAG.BURNING | BFLAG.UNPOWERED | BFLAG.UNWATERED | BFLAG.ABANDONED, crime: 255, smog: 255 });
    expect(pickIcon(all)).toBe(ICON.FIRE);
    expect(pickIcon({ ...all, flags: BFLAG.UNPOWERED | BFLAG.UNWATERED | BFLAG.ABANDONED })).toBe(ICON.POWER);
    expect(pickIcon({ ...all, flags: BFLAG.UNWATERED | BFLAG.ABANDONED })).toBe(ICON.WATER);
    expect(pickIcon({ ...all, flags: BFLAG.ABANDONED })).toBe(ICON.JOBS);
    expect(pickIcon({ ...all, flags: 0 })).toBe(ICON.CRIME);
    expect(pickIcon({ ...all, flags: 0, crime: ICON_CRIME - 1 })).toBe(ICON.SMOG);
    expect(pickIcon({ ...all, flags: 0, crime: 0, smog: ICON_SMOG - 1 })).toBe(-1);
    expect(pickIcon(sample({ flags: BFLAG.CONSTRUCTING, level: 2 }))).toBe(ICON.UPGRADE);
  });

  it('flags abandonment risk (weak demand on cheap land) and unemployment, but only unemployment for homes and smog never for industry', () => {
    expect(pickIcon(sample({ demand: -0.5, landValue: 70 }))).toBe(ICON.JOBS);
    expect(pickIcon(sample({ demand: -0.5, landValue: 150 }))).toBe(-1);
    expect(pickIcon(sample({ unemployment: 0.6 }))).toBe(ICON.JOBS);
    expect(pickIcon(sample({ zone: 2, unemployment: 0.6 }))).toBe(-1);
    expect(pickIcon(sample({ zone: 3, smog: 255 }))).toBe(-1);
    expect(pickIcon(sample({ zone: 2, smog: 255 }))).toBe(ICON.SMOG);
  });

  it('shows power or water only for finished buildings', () => {
    expect(pickIcon(sample({ flags: BFLAG.CONSTRUCTING | BFLAG.UNPOWERED, level: 1 }))).toBe(-1);
    expect(pickIcon(sample({ zone: 0, flags: BFLAG.UNPOWERED }))).toBe(ICON.POWER);
  });
});

const rec = (slot: number, kind: IconKind, x: number, z: number): StatusRec & { slot: number } => ({ slot, kind, x, y: 3, z });

describe('selectIcons', () => {
  it('hides the mood icons first when the camera is far, and everything farther still', () => {
    expect(farLevel(ICON_FAR.mood)).toBe(0);
    expect(farLevel(ICON_FAR.mood + 1)).toBe(1);
    expect(farLevel(ICON_FAR.critical + 1)).toBe(2);
    const recs = [rec(0, ICON.POWER, 10, 10), rec(1, ICON.SMOG, 11, 10), rec(2, ICON.FIRE, 12, 10), rec(3, ICON.CRIME, 13, 10), rec(4, ICON.WATER, 14, 10), rec(5, ICON.UPGRADE, 15, 10), rec(6, ICON.JOBS, 16, 10)];
    const focus = { x: 10, z: 10 };
    expect(selectIcons(recs, 60, focus)).toHaveLength(7);
    expect(selectIcons(recs, 120, focus).map((r) => r.kind).sort()).toEqual([ICON.POWER, ICON.WATER, ICON.FIRE]);
    expect(selectIcons(recs, 250, focus)).toEqual([]);
  });

  it('orders by priority, then distance to the focus, and cuts to the cap keeping the most important', () => {
    const recs = [rec(0, ICON.SMOG, 100, 100), rec(1, ICON.POWER, 50, 50), rec(2, ICON.POWER, 11, 10), rec(3, ICON.FIRE, 90, 90), rec(4, ICON.SMOG, 12, 10)];
    const out = selectIcons(recs, 40, { x: 10, z: 10 });
    expect(out.map((r) => [r.kind, r.x])).toEqual([[ICON.FIRE, 90], [ICON.POWER, 11], [ICON.POWER, 50], [ICON.SMOG, 12], [ICON.SMOG, 100]]);
    expect(selectIcons(recs, 40, { x: 10, z: 10 }, 3).map((r) => r.kind)).toEqual([ICON.FIRE, ICON.POWER, ICON.POWER]);
    const many = Array.from({ length: MAX_ICONS + 50 }, (_, i) => rec(i, ICON.SMOG, i % 200, Math.floor(i / 200)));
    expect(selectIcons(many, 40, { x: 0, z: 0 })).toHaveLength(MAX_ICONS);
  });

  it('is deterministic for ties', () => {
    const recs = [rec(5, ICON.POWER, 20, 20), rec(2, ICON.POWER, 20, 20), rec(9, ICON.POWER, 20, 20)];
    expect(selectIcons(recs, 40, { x: 0, z: 0 })).toEqual(selectIcons([...recs].reverse(), 40, { x: 0, z: 0 }));
  });
});

describe('StatusIconSystem', () => {
  function world() {
    const m = new RenderMirror();
    const t = m.table;
    const set = (s: number, arch: number, x: number, y: number, flags = 0, level = 1): void => {
      t.bArch[s] = arch; t.bX[s] = x; t.bY[s] = y; t.bW[s] = 1; t.bH[s] = 1; t.bLevel[s] = level; t.bFlags[s] = flags;
    };
    set(0, 16, 10, 10, BFLAG.UNPOWERED);
    set(1, 16, 14, 10);
    set(2, 16, 18, 10);
    set(3, ARCH.POLICE, 22, 10, BFLAG.UNWATERED);
    const anchors = new Map<number, IconAnchor>();
    for (const s of [0, 1, 2, 3]) anchors.set(s, { x: t.bX[s]! + 0.5, y: 4, z: t.bY[s]! + 0.5, gy: 1 });
    let version = 1;
    const sys = new StatusIconSystem(m, () => anchors, () => version);
    return { m, t, sys, anchors, bump: () => { version++; } };
  }

  it('reads flags and overlay layers from the mirror and reports each icon kind', () => {
    const { m, sys } = world();
    m.layers.crime![1 * 0 + 10 * MAP + 18] = 200;
    const recs = sys.refresh({ x: 10, z: 10 }, 40, 1000)!;
    expect(recs.map((r) => r.kind)).toEqual([ICON.POWER, ICON.WATER, ICON.CRIME]);
    expect(sys.byKind).toEqual({ power: 1, water: 1, crime: 1 });
    expect(sys.count).toBe(3);
    m.scalars[S.unemployment] = 0.9;
    m.buildingVersion++;
    const again = sys.refresh({ x: 10, z: 10 }, 40, 2000)!;
    expect(again.filter((r) => r.kind === ICON.JOBS)).toHaveLength(2);
  });

  it('returns null while nothing changed, throttles rescans, and rescans at once when the zoom crosses a cut-off', () => {
    const { m, sys, bump } = world();
    expect(sys.refresh({ x: 10, z: 10 }, 40, 1000)).not.toBeNull();
    expect(sys.refresh({ x: 10, z: 10 }, 40, 1100)).toBeNull();
    m.buildingVersion++;
    expect(sys.refresh({ x: 10, z: 10 }, 40, 1100), 'throttled to 4 scans a second').toBeNull();
    expect(sys.refresh({ x: 10, z: 10 }, 40, 1300)).not.toBeNull();
    bump();
    expect(sys.refresh({ x: 10, z: 10 }, 40, 1310)).toBeNull();
    expect(sys.refresh({ x: 10, z: 10 }, 120, 1320)!.map((r) => r.kind), 'far: only the outage-grade icons remain').toEqual([ICON.POWER, ICON.WATER]);
    expect(sys.refresh({ x: 10, z: 10 }, 250, 1330)).toEqual([]);
    expect(sys.refresh({ x: 10, z: 10 }, 30, 1340)).toHaveLength(2);
  });
});
