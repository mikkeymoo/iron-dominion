import { useEffect } from 'react';
import { AdvisorChip } from './AdvisorChip';
import { GhostChips } from './GhostChips';
import { InfoCard } from './InfoCard';
import type { WhyStore } from './whyStore.ts';

interface Props {
  why: WhyStore;
  onJump(x: number, y: number): void;
  onBudget?(): void;
  onFollow?(key: number): boolean;
}

/** "Why is this happening?": the advisor chip, the tap-for-details card and the placement chips, one mount for GameView. */
export function WhyUi({ why, onJump, onBudget, onFollow }: Props) {
  useEffect(() => why.start(), [why]);
  return (
    <>
      <AdvisorChip why={why} onJump={onJump} onBudget={onBudget} />
      <InfoCard why={why} onJump={onJump} onFollow={onFollow} />
      <GhostChips why={why} />
    </>
  );
}
