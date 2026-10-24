import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createSim, snapshot } from '../sim/engine.ts';
import { ARCH } from '../sim/catalog.ts';
import { HAZ } from '../sim/layers.ts';
import type { SimEvent } from '../sim/world.ts';
import { createPlatformDb, openIdbAdapter } from './db.ts';
import { BUILT_BUCKET, JOURNAL_CAP, Journal, RECAP_TICKS, SAMPLE_CAP, SAMPLE_EVERY, awaySummary, parseJournal, type JournalData } from './journal.ts';
import { buildSave, parseSave, type SaveMeta } from './save.ts';
import { createPlatformService } from './service.ts';

const built = (tick: number): SimEvent => ({ type: 'buildingDone', tick, arch: 16, x: 100, y: 100 });
const council = (tick: number, phase: 'completed' | 'failed' | 'expired' | 'posted'): SimEvent => ({ type: 'council', tick, phase, id: 1, kind: 3, group: 1, x: 10, y: 20, cash: 800, approval: 5, rp: 2 });
const sample = (tick: number, treasury: number, approval: number, population = 100) => ({ tick, treasury, approval, population });

/** A session's worth of events: ten buildings over two minutes, a tier, a directive, a request, a storm and a fire. */
function session(): Journal {
  const j = new Journal();
  j.observe(sample(0, 50000, 50));
  const events: SimEvent[] = [];
  for (let i = 0; i < 5; i++) events.push(built(1000 + i * 20));
  for (let i = 0; i < 5; i++) events.push(built(1900 + i * 20));
  events.push({ type: 'milestone', tick: 2000, tier: 2, bonus: 5000 });
  events.push({ type: 'directiveReady', tick: 2100, index: 3 });
  events.push(council(2200, 'completed'));
  events.push({ type: 'hazardStart', tick: 2300, kind: HAZ.STORM, level: 1, prepared: false, applicable: true, coverage: 0, bonus: 0 });
  events.push({ type: 'disaster', tick: 2400, kind: 'fire', phase: 'start', x: 5, y: 6, radius: 0, arch: ARCH.DEPOT, impactTick: 0 });
  events.push({ type: 'disaster', tick: 2410, kind: 'fire', phase: 'start', x: 5, y: 6, radius: 0, arch: ARCH.DEPOT, impactTick: 0 });
  events.push({ type: 'rejected', cmd: 1, tick: 2420, reason: 'noop' });
  j.record(events);
  j.observe(sample(600, 52000, 55));
  j.observe(sample(1200, 51000, 58));
  j.observe(sample(3000, 49500, 41, 400));
  return j;
}

describe('journal aggregation', () => {
  it('folds buildings finished in the same stretch into one line with a count', () => {
    const j = new Journal();
    j.record([built(10), built(30), built(50)]);
    expect(j.data().entries).toMatchObject([{ kind: 'built', n: 3, text: '3 buildings finished' }]);
    j.record([built(BUILT_BUCKET + 5)]);
    const e = j.data().entries;
    expect(e).toHaveLength(2);
    expect(e[1]).toMatchObject({ kind: 'built', n: 1, text: '1 building finished' });
  });

  it('keeps tiers, directives, requests, hazards, fires, megaproject stages and named bots, and ignores the rest', () => {
    const j = new Journal();
    j.record([
      { type: 'milestone', tick: 1, tier: 1, bonus: 2000 },
      { type: 'directiveReady', tick: 2, index: 0 },
      council(3, 'completed'), council(4, 'failed'), council(5, 'expired'), council(6, 'posted'),
      { type: 'hazardStart', tick: 7, kind: HAZ.HEATWAVE, level: 1, prepared: true, applicable: true, coverage: 1, bonus: 100 },
      { type: 'disaster', tick: 8, kind: 'quake', phase: 'impact', x: 1, y: 2, radius: 5, arch: 0, impactTick: 8 },
      { type: 'disaster', tick: 9, kind: 'meteor', phase: 'start', x: 1, y: 2, radius: 5, arch: 0, impactTick: 20 },
      { type: 'disaster', tick: 20, kind: 'meteor', phase: 'impact', x: 1, y: 2, radius: 5, arch: 0, impactTick: 20 },
      { type: 'megaStage', tick: 21, arch: ARCH.FUSION_REACTOR, slot: 4, stage: 1, stages: 3, x: 1, y: 1, w: 3, h: 3 },
      { type: 'megaComplete', tick: 22, arch: ARCH.FUSION_REACTOR, slot: 4, x: 1, y: 1, w: 3, h: 3 },
      { type: 'botNamed', tick: 23, slot: 4, gen: 0, kind: 1, name: 'Rivet-7' },
      { type: 'approvalWarning', tick: 24, approval: 10, months: 3 },
      { type: 'rejected', cmd: 1, tick: 25, reason: 'x' },
      { type: 'weather', tick: 26, weather: 1 },
      { type: 'lightning', tick: 27, x: 1, y: 1 },
    ]);
    expect(j.data().entries.map((e) => e.kind)).toEqual(['tier', 'directive', 'request', 'missed', 'missed', 'disaster', 'disaster', 'disaster', 'mega', 'mega', 'bot', 'approval']);
    const texts = j.data().entries.map((e) => e.text);
    expect(texts).toContain('Reached Settlement');
    expect(texts).toContain('Heatwave began');
    expect(texts).toContain('Rivet-7 earned its name');
    expect(texts).toContain('Fusion reactor: stage 2 of 3 finished');
  });

  it('is a rolling log: the oldest lines fall off at the cap', () => {
    const j = new Journal();
    for (let i = 0; i < JOURNAL_CAP + 30; i++) j.record([{ type: 'milestone', tick: i, tier: 1, bonus: 0 }]);
    const e = j.data().entries;
    expect(e).toHaveLength(JOURNAL_CAP);
    expect(e[0]!.tick).toBe(30);
  });

  it('samples treasury, approval and population about once a minute, capped, and ends with the newest reading', () => {
    const j = new Journal();
    for (let t = 0; t <= SAMPLE_EVERY * (SAMPLE_CAP + 10); t += 100) j.observe(sample(t, t, 50));
    const s = j.data().samples;
    expect(s.length).toBeLessThanOrEqual(SAMPLE_CAP);
    expect(s[s.length - 1]!.tick).toBe(SAMPLE_EVERY * (SAMPLE_CAP + 10));
    for (let i = 1; i < s.length - 1; i++) expect(s[i]!.tick - s[i - 1]!.tick).toBeGreaterThanOrEqual(SAMPLE_EVERY);
  });

  it('ignores a stale reading from the sim a loaded save replaced', () => {
    const j = new Journal();
    j.load({ entries: [], samples: [sample(5000, 100, 50)] });
    j.observe(sample(120, 999, 10));
    expect(j.data().samples).toEqual([sample(5000, 100, 50)]);
  });

  it('round-trips through load()', () => {
    const j = session();
    const copy = new Journal();
    copy.load(j.data());
    expect(copy.data()).toEqual(j.data());
    copy.clear();
    expect(copy.data()).toEqual({ entries: [], samples: [] });
  });
});

describe('away summary', () => {
  it('recaps the last stretch of play from a synthetic event stream', () => {
    const sum = awaySummary(session().data());
    expect(sum.toTick).toBe(3000);
    expect(sum.fromTick).toBe(3000 - RECAP_TICKS);
    const text = sum.lines.map((l) => l.text);
    expect(text).toEqual([
      '10 buildings finished',
      'Reached Town',
      '1 UNIT-0 directive done',
      '1 council request completed',
      'Storm season began',
      'Fire at the depot',
      'Fire at the depot',
      'Treasury -$500',
      'Approval 50% to 41%',
    ]);
    expect(sum.money).toEqual({ from: 50000, to: 49500 });
    expect(sum.approval).toEqual({ from: 50, to: 41 });
    expect(sum.minutes).toBe(5);
  });

  it('carries the place of a disaster so the card can offer a Show', () => {
    const fire = awaySummary(session().data()).lines.find((l) => l.kind === 'disaster' && l.text.startsWith('Fire'));
    expect(fire).toMatchObject({ x: 5, y: 6 });
  });

  it('only covers the window: older events and an old treasury do not count', () => {
    const j = new Journal();
    j.observe(sample(0, 1000, 50));
    j.record([built(100), { type: 'milestone', tick: 150, tier: 1, bonus: 0 }]);
    j.observe(sample(600, 1500, 50));
    j.observe(sample(9000, 4000, 60));
    j.record([built(8900), built(8910)]);
    j.observe(sample(9500, 4400, 62));
    const sum = awaySummary(j.data());
    expect(sum.lines.map((l) => l.text)).toEqual(['2 buildings finished', 'Treasury +$2,900', 'Approval 50% to 62%']);
  });

  it('says nothing for a quiet stretch and for a save with no journal', () => {
    const quiet = new Journal();
    quiet.observe(sample(0, 100, 50));
    quiet.observe(sample(900, 100, 50));
    expect(awaySummary(quiet.data()).lines).toEqual([]);
    expect(awaySummary({ entries: [], samples: [] })).toMatchObject({ lines: [], toTick: 0, money: null, approval: null });
  });

  it('can be asked about an explicit tick and window', () => {
    const sum = awaySummary(session().data(), 2100, 400);
    expect(sum.lines.map((l) => l.text)).toContain('Reached Town');
    expect(sum.lines.map((l) => l.text)).not.toContain('10 buildings finished');
  });

  it('names several bots and several missed requests in one line each', () => {
    const j = new Journal();
    j.observe(sample(0, 1, 50));
    j.record([
      { type: 'botNamed', tick: 10, slot: 1, gen: 0, kind: 1, name: 'Bolt-2' }, { type: 'botNamed', tick: 11, slot: 2, gen: 0, kind: 2, name: 'Cog' },
      council(12, 'failed'), council(13, 'expired'),
    ]);
    j.observe(sample(100, 1, 50));
    expect(awaySummary(j.data()).lines.map((l) => l.text)).toEqual(['2 council requests missed', '2 bots earned names']);
  });
});

describe('parseJournal', () => {
  it('accepts what data() produced and drops malformed rows', () => {
    const good = session().data();
    expect(parseJournal(JSON.parse(JSON.stringify(good)))).toEqual(good);
    const messy = { entries: [{ tick: 1, kind: 'nope', text: 'x' }, { tick: 'a', kind: 'built', text: 'x' }, null, { tick: 3, kind: 'tier', text: 'ok' }], samples: [{ tick: 1 }, sample(4, 1, 2)] };
    expect(parseJournal(messy)).toEqual({ entries: [{ tick: 3, kind: 'tier', text: 'ok' }], samples: [sample(4, 1, 2)] });
  });

  it('rejects things that are not a journal and caps what it keeps', () => {
    for (const v of [undefined, null, 5, 'x', {}, { entries: [] }, { entries: 1, samples: [] }]) expect(parseJournal(v)).toBeUndefined();
    const big: JournalData = { entries: Array.from({ length: 500 }, (_, i) => ({ tick: i, kind: 'tier' as const, text: 'y'.repeat(900) })), samples: Array.from({ length: 80 }, (_, i) => sample(i, 1, 1)) };
    const out = parseJournal(big)!;
    expect(out.entries).toHaveLength(JOURNAL_CAP);
    expect(out.samples).toHaveLength(SAMPLE_CAP);
    expect(out.entries[0]!.text.length).toBeLessThanOrEqual(120);
  });
});

describe('journal in the save', () => {
  const META: SaveMeta = { name: 'Testville', population: 120, treasury: 4200, day: 9 };
  const snap = (): Uint8Array => snapshot(createSim(7));

  it('travels in the save header and comes back from parseSave', async () => {
    const journal = session().data();
    const parsed = await parseSave(await buildSave(snap(), { ...META, journal }, 1));
    expect(parsed.ok && parsed.value.meta.journal).toEqual(journal);
  });

  it('a save from before the journal existed loads with none, and a damaged journal is dropped without failing the save', async () => {
    const old = await parseSave(await buildSave(snap(), META, 1));
    expect(old.ok && old.value.meta.journal).toBeUndefined();
    const damaged = await parseSave(await buildSave(snap(), { ...META, journal: { entries: 'no', samples: [] } as unknown as JournalData }, 1));
    expect(damaged.ok).toBe(true);
    expect(damaged.ok && damaged.value.meta.journal).toBeUndefined();
  });

  it('is stored by the service on every write path, comes back from load(), and stays out of the slot list row', async () => {
    const db = createPlatformDb(await openIdbAdapter(new IDBFactory()));
    const journal = session().data();
    let loaded = 0;
    const sim = { requestSnapshot: async () => snap(), loadSnapshot: () => { loaded++; }, pause: () => undefined, requestHash: () => undefined };
    const svc = createPlatformService({ getDb: () => db, sim, journal: () => journal });
    svc.startNew('Journal city');
    const saved = await svc.writeSnapshot(snap(), { create: true });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const row = await db.getSlot(saved.slot!.id);
    expect(row.ok && row.value && 'journal' in row.value).toBe(false);

    const svc2 = createPlatformService({ getDb: () => db, sim });
    const back = await svc2.load(saved.slot!.id);
    expect(back.ok && back.value.journal).toEqual(journal);
    expect(loaded).toBe(1);

    const imported = await svc2.importBytes(await buildSave(snap(), { ...META, journal }, 2));
    expect(imported.ok && 'journal' in imported.value).toBe(false);
    const again = await svc2.load(imported.ok ? imported.value.id : '');
    expect(again.ok && again.value.journal).toEqual(journal);
  });
});
