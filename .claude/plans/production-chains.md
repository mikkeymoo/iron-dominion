# Production chains + zone needs (architect plan, 2026-10-24, base 3e35744)

## Decisions
1. Ore is the old "material": `bStock` keeps its meaning (Ore); Alloy and Components are new zero-default layers, so saves, start stock, `materialFor()` and the L1 path stay byte-identical.
2. Exchange: 1 Alloy = 2 Ore, 1 Component = 4 Ore. A job asks `ceil(materialFor / 2^res)` units of its resource.
3. Dedicated placeable buildings after ROBOTICS_LAB=47: Mine (3x3, $1500, upkeep 40, tier 1, >= half footprint on TERRAIN.ORE else reason `noOre`), Smelter (3x3, $2500, upkeep 80, tier 2), Factory (4x4, $6000, upkeep 160, tier 3). Zoned I keeps producing Ore as today (protects `legacy` hashes). All need power.
4. Three resources max: 0 Ore, 1 Alloy, 2 Components.
5. Exports are an abstract monthly sale (no map-edge trucks).
6. Commercial goods = supply by reach (Factory or depot with >= 1 Component within 40 Manhattan tiles, road-connected), not hauled.

## Data model (additive; zero in old saves; no PROTOCOL_VERSION bump)
Layers (render:false, dirty:'none'): `jRes` U8 BMAX, `bAlloy` U16 BMAX, `bParts` U16 BMAX, `bIn` U16 BMAX*3, `aRes` U8 RMAX, plus monthly export accumulator (use a small layer, not a scalar, to avoid scalar-index collisions with parallel units). Budget close adds exports to `incomeI`; do not change `BUDGET_FIELDS`. Add new layer names to `FIRMWARE_LAYERS` in determinism.test.ts; keep `legacy` unchanged.

## Rules
- Production every 40 ticks when finished, powered, not abandoned: Mine +6 Ore; Smelter 4 Ore -> 2 Alloy; Factory 2 Alloy -> 1 Component. Output cap 40; input buffers Smelter 16 Ore, Factory 8 Alloy; depot cap 80 per resource. Check before decrement (Uint16 wrap).
- Overflow sells: Ore $2, Alloy $6, Components $14.
- Job resource: L1 build Ore; level-up to L2 Alloy; to L3 Components; megaproject stages Components (`ceil(stage.material/4)`). Set `jRes` in startBuild, startLevelUp, advanceMega, adoptOrphans.
- Transfers: Smelter wants Ore, Factory wants Alloy, depots want all three (targets 12, 6, 32). Sources: producers, and depots above reserve 24. Depots receive only from producers. Dispatch serves construction first. HAUL arrival credits target stock for transfers. goHome refunds carried units by `aRes`. clearBuilding and undo guard handle new layers.
- Zone needs via one pure `needsOf(w, slot)` used by levelUpCandidates and info.ts: R1->2 operating C within 20; R2->3 covHealth and covEdu >= COVERED_MIN plus C within 20; C level-ups need goods supplied (bAux > 0); I needs power + water only.
- Goods pass every 600 ticks: bAux = 2 on supplied C, else decrement; C L2 consumes 1 Component, L3 consumes 2, from nearest supplier (ties by slot).
- Import fallback at depots only while a live job needs the resource and reachable stock < outstanding need: 1 unit per 30 ticks; Ore $3, Alloy $10, Components $28.
- Demand/abandonment untouched (no starvation penalties).
- Stall gate: a level-up starts only if reachable stock - outstanding need > 0 or fewer than 2 chain jobs are live.

## UI/render
Crate tint per resource (Ore amber, Alloy cyan, Components magenta) via hauler state bits; HUD resource chip with three dots + numbers; `production` overlay (ore tile tint + chain building fill/starved/full icons, Stats list capped at 64); InfoCard `needs` checklist and `stocks` bars; advisor issues split by resource ("Alloy shortage blocks 6 upgrades", "4 homes want a clinic or school").

## Tests
legacy hashes unchanged; conservation per resource each tick; L2 job jRes=1 and correct need; unpowered/no-input producers idle, cap -> exports; depot-only city finishes an L2 via Alloy import with exact spend; old in-flight job (jRes=0) completes with Ore; needsOf agrees with levelUpCandidates; snapshot resume equality; no reservation leaks on destroy mid-haul; UI render tests.

## Cut order if it grows
production overlay icons -> goods consumption -> R2->3 service needs -> megaproject Components -> export sale -> depot restocking.
