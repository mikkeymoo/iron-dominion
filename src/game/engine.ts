import type { Campaign } from "./types";
import { step } from "./simulation";
import { updateAI } from "./ai";

/** One fixed simulation tick: physics/economy then strategic AI. */
export function advance(s: Campaign, dt: number): Campaign {
  return updateAI(step(s, dt), dt);
}
