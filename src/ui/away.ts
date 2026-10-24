import type { AwaySummary } from '../platform/journal.ts';

/** Why the "while you were away" card opened: a saved city was resumed, or the page came back after being hidden for a while. */
export type AwayReason = 'resume' | 'return';

/** Holds the card's recap. The session fills it; ui/AwayCard.tsx reads it and closes it. */
export class AwayStore {
  summary: AwaySummary | null = null;
  reason: AwayReason | null = null;
  version = 0;
  private readonly listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(): void { this.version++; for (const fn of this.listeners) fn(); }

  open(summary: AwaySummary, reason: AwayReason): void {
    this.summary = summary;
    this.reason = reason;
    this.emit();
  }

  close(): void {
    if (!this.summary) return;
    this.summary = null;
    this.reason = null;
    this.emit();
  }

  dispose(): void { this.listeners.clear(); }
}
