import { useEffect } from 'react';
import { AdvisorChip } from './AdvisorChip';
import { GhostChips } from './GhostChips';
import type { DepotModuleControls } from './DepotModules';
import { InfoCard } from './InfoCard';
import type { WhyStore } from './whyStore.ts';

interface Props {
  why: WhyStore;
  onJump(x: number, y: number): void;
  onBudget?(): void;
  onFollow?(key: number): boolean;
  modules?: DepotModuleControls;
}

/** "Why is this happening?": the advisor chip, the tap-for-details card and the placement chips, one mount for GameView. */
export function WhyUi({ why, onJump, onBudget, onFollow, modules }: Props) {
  useEffect(() => why.start(), [why]);
  return (
    <>
      <AdvisorChip why={why} onJump={onJump} onBudget={onBudget} />
      <InfoCard why={why} onJump={onJump} onFollow={onFollow} modules={modules} />
      <GhostChips why={why} />
    </>
  );
}
