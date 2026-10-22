# SDD ledger — plan: docs/iron-dominion-plan.md

Baseline: recovered simulation and map code. 48 tests passed locally. Existing code was not implemented in this execution; prior test-first evidence is unavailable.
Ruling: use direct local implementation and public GitHub Pages — user prohibited Lovable and authorized public GitHub source — cost if wrong: hosting migration.
Fix: original engine prematurely awarded victory at 12 regions. Added failing regression (victory vs playing), corrected threshold to all 18 to match approved design.
Pre-flight: Task 1/2 state interfaces match persistence in Task 3. Task 3 lifecycle clock exists but UI integration is missing. Task 4 map API is implemented; HUD must supply its callbacks and CSS sizing.
Task 1: existing foundation baseline verified 15 tests.
Task 2: existing AI/progression baseline verified 14 tests.
Task 3: persistence/clock baseline verified 14 tests; lifecycle hook remains to implement.
Task 4: existing gesture baseline verified 5 tests; playable UI and deployment remain.
Task 3: lifecycle hook added. Tests written before implementation (initial missing-module failure); subsequent two hook tests pass. Hidden-tab 10-minute gap remains paused; resume adds only one tick.
Task 4: App test written before UI (initial missing-module failure); new campaign/recruit/import verified. 390x844 portrait inspected in browser, no horizontal UI overflow; desktop title works. Physical touch device and complete manual campaign not verified.
Final review: fresh review found incomplete import schema (Important), final pointerup displacement (regraded Important: accidental commands), and maxed production enabled action (regraded Important: visible control always fails).
Final: fixed malformed import — region kind/event/inherited research ID imports RED→GREEN, saved progress preserved. Added canonical map topology and squad bounds validation.
Final: fixed final-release tap cancellation — displaced down/up without pointermove RED→GREEN.
Final: fixed maxed production action — max upgrade disabled test RED→GREEN.
Ruling: use new GitHub repository via browser because GitHub connector cannot create repositories or configure Pages; file publication uses connector — authorized public source and free hosting — cost if wrong: repo/Pages cleanup.
No deferred minors.
