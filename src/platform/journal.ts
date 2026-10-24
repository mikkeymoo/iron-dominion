import { GROUP_NAMES } from '../sim/council/tables.ts';
import { HAZARD_NAMES } from '../sim/disasters/hazardNames.ts';
import { placeName } from '../sim/disasters/names.ts';
import { TIERS } from '../sim/unlocks.ts';
import type { SimEvent } from '../sim/world.ts';
import { projectLabel } from '../ui/projects.ts';

// The event journal: a short rolling log of what mattered in a city (buildings finished, tiers, directives, council requests, disasters,
// megaproject stages, named bots), plus a thin series of treasury / approval / population samples. It lives on the main thread, is
// built from the sim's event stream and Stats, travels in the save's metadata header and is never part of the sim state or its hash.
// The "while you were away" card reads it back (awaySummary).

export type JournalKind = 'built' | 'tier' | 'directive' | 'request' | 'missed' | 'disaster' | 'mega' | 'bot' | 'approval';
export interface JournalEntry { tick: number; kind: JournalKind; text: string; /** Count for aggregated kinds (buildings finished, directives done). */ n?: number; x?: number; y?: number }
export interface JournalSample { tick: number; treasury: number; approval: number; population: number }
export interface JournalData { entries: JournalEntry[]; samples: JournalSample[] }

export const JOURNAL_CAP = 120;
export const SAMPLE_CAP = 24;
/** Ticks between samples (a minute of play at 1x). */
export const SAMPLE_EVERY = 600;
/** Buildings finished within one bucket of ticks share a journal line. */
export const BUILT_BUCKET = 600;
/** How far back the recap reaches: 5 minutes of play at 1x. */
export const RECAP_TICKS = 3000;
const TICKS_PER_MINUTE = 600;
const TEXT_CAP = 120;

const KINDS: readonly JournalKind[] = ['built', 'tier', 'directive', 'request', 'missed', 'disaster', 'mega', 'bot', 'approval'];
const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates a journal read from a save header; anything malformed is dropped rather than failing the save. */
export function parseJournal(v: unknown): JournalData | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const raw = v as { entries?: unknown; samples?: unknown };
  if (!Array.isArray(raw.entries) || !Array.isArray(raw.samples)) return undefined;
  const entries: JournalEntry[] = [];
  for (const e of raw.entries.slice(-JOURNAL_CAP)) {
    if (typeof e !== 'object' || e === null) continue;
    const r = e as Record<string, unknown>;
    if (!num(r.tick) || typeof r.text !== 'string' || !KINDS.includes(r.kind as JournalKind)) continue;
    const entry: JournalEntry = { tick: r.tick, kind: r.kind as JournalKind, text: r.text.slice(0, TEXT_CAP) };
    if (num(r.n)) entry.n = r.n;
    if (num(r.x) && num(r.y)) { entry.x = r.x; entry.y = r.y; }
    entries.push(entry);
  }
  const samples: JournalSample[] = [];
  for (const s of raw.samples.slice(-SAMPLE_CAP)) {
    if (typeof s !== 'object' || s === null) continue;
    const r = s as Record<string, unknown>;
    if (num(r.tick) && num(r.treasury) && num(r.approval) && num(r.population)) samples.push({ tick: r.tick, treasury: r.treasury, approval: r.approval, population: r.population });
  }
  return { entries, samples };
}

export class Journal {
  private entries: JournalEntry[] = [];
  private samples: JournalSample[] = [];
  private latest: JournalSample | null = null;

  /** Fold a batch of sim events into the log. Events the journal does not care about are ignored. */
  record(events: readonly SimEvent[]): void {
    for (const e of events) this.one(e);
  }

  private push(entry: JournalEntry): void {
    this.entries.push(entry);
    if (this.entries.length > JOURNAL_CAP) this.entries.splice(0, this.entries.length - JOURNAL_CAP);
  }

  private one(e: SimEvent): void {
    switch (e.type) {
      case 'buildingDone': {
        const last = this.entries[this.entries.length - 1];
        const bucket = Math.floor(e.tick / BUILT_BUCKET);
        if (last && last.kind === 'built' && Math.floor(last.tick / BUILT_BUCKET) === bucket) {
          last.n = (last.n ?? 1) + 1; last.tick = e.tick; last.text = `${plural(last.n, 'building')} finished`;
        } else this.push({ tick: e.tick, kind: 'built', n: 1, text: '1 building finished', x: e.x, y: e.y });
        break;
      }
      case 'milestone': this.push({ tick: e.tick, kind: 'tier', n: e.tier, text: `Reached ${TIERS[e.tier]?.name ?? `tier ${e.tier}`}` }); break;
      case 'directiveReady': this.push({ tick: e.tick, kind: 'directive', n: 1, text: `UNIT-0 directive ${e.index + 1} done` }); break;
      case 'council': {
        const who = GROUP_NAMES[e.group] ?? 'Citizens';
        if (e.phase === 'completed') this.push({ tick: e.tick, kind: 'request', n: 1, text: `${who}' request completed`, x: e.x, y: e.y });
        else if (e.phase === 'failed' || e.phase === 'expired') this.push({ tick: e.tick, kind: 'missed', n: 1, text: `${who}' request ${e.phase === 'failed' ? 'failed' : 'expired'}`, x: e.x, y: e.y });
        break;
      }
      case 'hazardStart': this.push({ tick: e.tick, kind: 'disaster', text: `${HAZARD_NAMES[e.kind] ?? 'A hazard'} began` }); break;
      case 'disaster':
        if (e.kind === 'fire' && e.phase === 'start') this.push({ tick: e.tick, kind: 'disaster', text: `Fire at ${placeName(e.arch)}`, x: e.x, y: e.y });
        else if (e.kind === 'quake' && e.phase === 'impact') this.push({ tick: e.tick, kind: 'disaster', text: 'Earthquake', x: e.x, y: e.y });
        else if (e.kind === 'meteor' && e.phase === 'impact') this.push({ tick: e.tick, kind: 'disaster', text: 'Meteor strike', x: e.x, y: e.y });
        break;
      case 'megaStage': this.push({ tick: e.tick, kind: 'mega', text: `${projectLabel(e.arch)}: stage ${e.stage + 1} of ${e.stages} finished`, x: e.x, y: e.y }); break;
      case 'megaComplete': this.push({ tick: e.tick, kind: 'mega', text: `${projectLabel(e.arch)} completed`, x: e.x, y: e.y }); break;
      case 'botNamed': this.push({ tick: e.tick, kind: 'bot', text: `${e.name} earned its name` }); break;
      case 'approvalWarning': this.push({ tick: e.tick, kind: 'approval', text: `Approval has been under 15 for ${e.months} months` }); break;
      default: break;
    }
  }

  /** Feed each Stats message: keeps the newest reading and stores a sample every SAMPLE_EVERY ticks. */
  observe(s: JournalSample): void {
    const prev = this.samples[this.samples.length - 1];
    // A reading older than the newest sample is a straggler from the sim this save replaced.
    if (prev && s.tick < prev.tick) return;
    this.latest = s;
    if (!prev || s.tick - prev.tick >= SAMPLE_EVERY) {
      this.samples.push(s);
      if (this.samples.length > SAMPLE_CAP) this.samples.splice(0, this.samples.length - SAMPLE_CAP);
    }
  }

  /** What goes into the save header: the log and the samples, with the newest reading appended as the last sample. */
  data(): JournalData {
    const samples = this.samples.map((s) => ({ ...s }));
    const last = samples[samples.length - 1];
    if (this.latest && (!last || this.latest.tick > last.tick)) samples.push({ ...this.latest });
    return { entries: this.entries.map((e) => ({ ...e })), samples: samples.slice(-SAMPLE_CAP) };
  }

  /** Replace the log with the one a loaded save carried (or empty when it had none). */
  load(data: JournalData | undefined): void {
    this.entries = data ? data.entries.map((e) => ({ ...e })) : [];
    this.samples = data ? data.samples.map((s) => ({ ...s })) : [];
    this.latest = this.samples.length > 0 ? { ...this.samples[this.samples.length - 1]! } : null;
  }

  clear(): void { this.load(undefined); }
}

export interface AwayLine { kind: JournalKind | 'money'; text: string; x?: number; y?: number }
export interface AwaySummary {
  fromTick: number;
  toTick: number;
  /** Minutes of play at 1x the recap covers. */
  minutes: number;
  lines: AwayLine[];
  /** Treasury and approval at the start and end of the window, when the samples reach that far. */
  money: { from: number; to: number } | null;
  approval: { from: number; to: number } | null;
}

const usd = (n: number): string => `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

/**
 * What happened in the last `window` ticks up to `nowTick` (default: the newest sample). The game is paused while the player is away, so
 * a resumed city has nothing newer than its save: the card recaps the previous session's last stretch instead.
 */
export function awaySummary(data: JournalData, nowTick?: number, window: number = RECAP_TICKS): AwaySummary {
  const newest = data.samples[data.samples.length - 1];
  const toTick = nowTick ?? newest?.tick ?? data.entries[data.entries.length - 1]?.tick ?? 0;
  const fromTick = Math.max(0, toTick - window);
  const within = data.entries.filter((e) => e.tick > fromTick && e.tick <= toTick);
  const lines: AwayLine[] = [];
  const total = (kind: JournalKind): number => within.filter((e) => e.kind === kind).reduce((n, e) => n + (e.n ?? 1), 0);

  const built = total('built');
  if (built > 0) lines.push({ kind: 'built', text: `${plural(built, 'building')} finished` });
  const tiers = within.filter((e) => e.kind === 'tier');
  if (tiers.length > 0) lines.push({ kind: 'tier', text: tiers[tiers.length - 1]!.text });
  const directives = total('directive');
  if (directives > 0) lines.push({ kind: 'directive', text: `${plural(directives, 'UNIT-0 directive')} done` });
  const done = total('request'), missed = total('missed');
  if (done > 0) lines.push({ kind: 'request', text: `${plural(done, 'council request')} completed` });
  if (missed > 0) lines.push({ kind: 'missed', text: `${plural(missed, 'council request')} missed` });
  for (const e of within.filter((x) => x.kind === 'disaster').slice(-3)) lines.push({ kind: 'disaster', text: e.text, x: e.x, y: e.y });
  const mega = within.filter((e) => e.kind === 'mega');
  if (mega.length > 0) { const e = mega[mega.length - 1]!; lines.push({ kind: 'mega', text: e.text, x: e.x, y: e.y }); }
  const bots = within.filter((e) => e.kind === 'bot');
  if (bots.length > 0) lines.push({ kind: 'bot', text: bots.length === 1 ? bots[0]!.text : `${plural(bots.length, 'bot')} earned names` });
  const warn = within.filter((e) => e.kind === 'approval');
  if (warn.length > 0) lines.push({ kind: 'approval', text: warn[warn.length - 1]!.text });

  // The start of the window is the newest sample at or before it, else the oldest sample there is.
  const end = [...data.samples].reverse().find((s) => s.tick <= toTick);
  let start = [...data.samples].reverse().find((s) => s.tick <= fromTick);
  if (!start && data.samples.length > 0) start = data.samples[0];
  let money: AwaySummary['money'] = null, approval: AwaySummary['approval'] = null;
  if (start && end && end.tick > start.tick) {
    if (Math.round(end.treasury) !== Math.round(start.treasury)) { money = { from: start.treasury, to: end.treasury }; lines.push({ kind: 'money', text: `Treasury ${usd(end.treasury - start.treasury)}` }); }
    if (Math.round(end.approval) !== Math.round(start.approval)) {
      approval = { from: start.approval, to: end.approval };
      lines.push({ kind: 'approval', text: `Approval ${Math.round(start.approval)}% to ${Math.round(end.approval)}%` });
    }
  }
  return { fromTick, toTick, minutes: Math.max(1, Math.round((toTick - fromTick) / TICKS_PER_MINUTE)), lines, money, approval };
}
