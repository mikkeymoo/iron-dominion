// UNIT-0, the city's overseer, talks when nothing is wrong. Dry, a little proud of the robots, never alarmed. The advisor chip rotates
// through these while the issue list is empty (SimCity 4 does the same with its ticker).

export const UNIT0_HEADLINES: readonly string[] = [
  'UNIT-0: All systems nominal. I checked twice. Then a third time, for fun.',
  'UNIT-0: No problems found. This is statistically suspicious, but I will allow it.',
  'UNIT-0: The hauler drones report a perfect morning. One of them is humming.',
  'UNIT-0: Your citizens are content. I did not ask the pigeons.',
  'UNIT-0: Power on, water on, nobody on fire. A good day to be a city.',
  'UNIT-0: The builder bots have asked me to say they enjoy the work. I think they mean it.',
  'UNIT-0: I have counted every road tile. There are many. All of them are roads.',
  'UNIT-0: Traffic is flowing. A taxi just waved at a truck. I have no explanation.',
  'UNIT-0: Zero alarms. I filed the quiet under "earned".',
  'UNIT-0: The treasury is healthy. I polished it anyway.',
  'UNIT-0: A depot drone has named the nearest crane Gerald. I am not stopping it.',
  'UNIT-0: Local weather is behaving. I cannot take credit, but I will.',
  'UNIT-0: The city runs smoothly. Please enjoy this rare and beautiful dashboard.',
  'UNIT-0: Nothing to report. I rehearsed a dramatic warning just in case. It was good.',
  'UNIT-0: Fire stations are bored, which is how fire stations like to be.',
  'UNIT-0: Everything is humming. Possibly the power plant. Possibly me.',
];

/** The headline for a rotation step; any integer is a valid step. */
export const headlineAt = (step: number): string => UNIT0_HEADLINES[((Math.floor(step) % UNIT0_HEADLINES.length) + UNIT0_HEADLINES.length) % UNIT0_HEADLINES.length]!;

/** How long a headline stays up, and the step the wall clock is at. */
export const HEADLINE_MS = 12000;
export const stepAt = (nowMs: number): number => Math.floor(nowMs / HEADLINE_MS);
