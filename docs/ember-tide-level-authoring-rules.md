# Ember & Tide Level Authoring Rules

**Status:** Required authoring contract
**Audience:** Agents and developers creating online Ember & Tide levels
**Goal:** Every submitted level must be provably beatable by two networked players, readable on a phone, progressively more interesting, and compatible with the authoritative server.

This document is normative. “Must” and “must not” are acceptance requirements. “Should” is a strong default that may be broken only with a written reason and playtest evidence.

## 1. Source of truth and current engine contract

Level data lives in [`packages/core/src/domain/elemental-platformer.ts`](../packages/core/src/domain/elemental-platformer.ts). The Colyseus server is authoritative for movement, hazards, collection, mechanisms, gate state, death, and completion. The mobile client renders and predicts that state but must not invent different gameplay rules.

Current online physics:

| Quantity                |                                   Value |
| ----------------------- | --------------------------------------: |
| Player width and height |                       `1.6` world units |
| Move speed              |                  `8.4–8.6` units/second |
| Jump speed              |                       `13` units/second |
| Gravity                 |                     `-24` units/second² |
| Simulation              | `30 Hz`, two substeps (`60 Hz` physics) |
| Server patches          |                 Every `50 ms` (`20 Hz`) |
| Camera viewport         |                   `38` world units wide |

The continuous jump envelope is:

- Time to apex: `13 / 24 = 0.542 seconds`.
- Maximum theoretical rise: `13² / (2 × 24) = 3.521 units`.
- Same-height flight time: `2 × 13 / 24 = 1.083 seconds`.
- Same-height horizontal travel at speed `8.4`: about `9.1 units`.

Do not author to those theoretical limits. Input timing, discrete integration, reconciliation, phone controls, and network jitter require margin.

## 2. Hard geometry limits

`number` is both explicit level identity and sequence and must be a positive whole number. It is never inferred from `name`, `chapter`, or title text. Renumbering existing live levels publishes the complete catalog order atomically. When publishing geometry, choose the live slot deliberately; the builder archives the displaced live level before installing the edited level into that slot.

Every required route must obey all of these limits:

| Geometry                                   | Hard limit | Preferred target |
| ------------------------------------------ | ---------: | ---------------: |
| Upward landing height difference           |    `≤ 3.2` |          `≤ 2.7` |
| Clear horizontal gap at equal/lower height |    `≤ 6.0` |          `≤ 4.5` |
| Required landing width                     |    `≥ 3.2` |          `≥ 4.5` |
| Run-up before a required hazard jump       |    `≥ 2.5` |          `≥ 3.5` |
| Safe landing after a required hazard jump  |    `≥ 2.5` |          `≥ 3.5` |
| Required blind jump                        |      Never |            Never |
| Consecutive maximum-difficulty jumps       |      `≤ 2` |              `1` |

Additional geometry rules:

1. Coordinates use `x` from the left edge and `y` upward from the floor.
2. Every platform, hazard, spawn, gate, crystal, and mechanism must be fully inside `0...level.width`.
3. Required platforms must be reachable through a chain beginning at that role’s spawn. A high platform existing inside the world bounds is not evidence of reachability.
4. A platform chain must be checked in both directions when the player must return. A safe ascent does not prove a safe descent.
5. Platforms are one-way landing surfaces. Players pass through them from below. Never design a puzzle that depends on a platform acting as a wall or ceiling.
6. Players do not collide with one another. Never require standing on, boosting, blocking, or pushing the other player.
7. Gates are floor interactions. Each matching gate must be reachable while grounded at `y = 0`.
8. Keep required gameplay between `y = 0` and `y = 17`. The vertical camera is tested for that range; extending it requires new camera tests and device playtesting.
9. Put a visible destination, platform edge, crystal, beacon, or landmark inside the camera’s likely view before every required jump.

## 3. Role-specific traversal graph

Before writing level data, create a traversal graph for **each** role.

- A node is a floor segment or landable platform.
- A directed edge is a jump, drop, walk, or activated bridge that the role can traverse.
- Neutral platforms create edges for both roles.
- Ember platforms create landing edges only for Ember.
- Tide platforms create landing edges only for Tide.
- A platform of the other element is pass-through, not solid and not lethal.
- A hazard splits the floor into separate safe segments for any role it kills.

For each role, the graph must prove:

1. Spawn reaches at least the authored `requiredCrystals` count for that role; identify which placed shards form a viable route.
2. Every required shard location has a non-suicidal route onward or back.
3. The final required shard reaches the matching gate.
4. Any required lever or cooperative mechanism has a reachable operator position.
5. No required route depends on the other player standing still as a physical object.
6. No state transition removes the only route needed to finish.

The review description must include a route in this form:

```text
Ember: spawn -> center floor -> ember ledge -> shard E1 -> neutral crown
       -> shard E2 -> lever -> deployed bridge -> shard E3 -> ember gate

Tide:  spawn -> tide stair -> shard T1 -> neutral crown -> shard T2
       -> deployed bridge -> shard T3 -> tide gate
```

If a route cannot be written unambiguously, the level is not ready to implement.

## 4. Hazards

Supported hazard meanings:

- `safeRole: 'ember'`: Ember may cross; Tide dies.
- `safeRole: 'tide'`: Tide may cross; Ember dies.
- `safeRole: 'none'`: both roles die.

Current hazards kill only when a player is near floor height (`y ≤ 0.05`) and the player’s center enters the hazard interval. They are not vertical colliders. Do not depict a tall wall of danger or rely on airborne contact until the engine supports it.

Hazard requirements:

1. A spawn’s player center must never begin inside a lethal hazard.
2. A respawn must have at least `3.0` safe horizontal units before the first lethal hazard.
3. A required universal-hazard jump should be at most `4.5` units wide; the absolute maximum is `5.5` with generous run-up and landing space. A lever-bridged chasm may exceed the full jump envelope only when the lever is reachable from the starting side.
4. Never place a lethal hazard directly under the only required landing edge.
5. Death may be a recovery mechanism, but it must never be the required solution.
6. Because death resets only the dead role’s shards, never require a player to die after collecting a mandatory shard.
7. The player must be able to understand the hazard type from color **and** symbol. Color alone is insufficient.
8. Ground hazards are recessed pools, not raised mounds. Their visual top begins at the floor line and extends downward into the ground.
9. Poison is exempt from the soft clay palette. Ember-safe pools use deep red, Tide-safe pools use deep blue, and universally lethal pools use a near-black oxblood or similarly dark danger color.
10. Every pool needs a subtle liquid-surface animation plus a static reduced-motion presentation. Animate only `transform` or `opacity` on the UI thread; do not animate layout.
11. A platform at `y ≤ 4.7` must not horizontally overlap a poison interval. Higher bridges may cross above a pool only when that crossing is intentional and the pool remains clearly visible.

## 5. Platforms and elemental routing

1. Every elemental platform must have an intentional role-routing purpose.
2. If a required route uses an elemental platform, the other role must have a distinct valid route or must not need to reach that destination.
3. Do not recolor neutral platforms merely for variety; color communicates collision rules.
4. Provide a forgiving neutral recovery platform after a demanding elemental sequence.
5. Avoid more than three role-specific landings in a row. Reunite the routes visually or physically before increasing difficulty again.
6. A drop greater than the visible camera height must have a visible safe landing or a directional cue.

## 5A. Level archetypes and solid-wall chambers

Authors may use three level archetypes. Do not force every level into the same floating-platform silhouette.

1. **Open platform level:** traversal is primarily one-way landing platforms, jumps, and floor hazards.
2. **Chamber level:** traversal uses solid floors, walls, shafts, rooms, ramps, and separated corridors in the tradition of Fireboy and Watergirl.
3. **Hybrid level:** solid chambers establish the main topology while a smaller number of platforms create vertical or elemental branches.

The collision engine supports one-way `platforms` and four-sided rectangular `solids`. Solid geometry must use the shared level data and identical server/client collision behavior. A visual rectangle without authoritative collision is forbidden.

Solid-wall engine acceptance requirements:

1. Resolve floor, ceiling, left-wall, and right-wall contact without tunneling at maximum movement and fall speeds.
2. A player may stand on a solid, hit its underside, and slide along either side without being teleported through a corner.
3. Corridors must provide at least `2.4` world units of clear height and `2.4` units of clear width. Required turning or pushing rooms must be wider.
4. The movable block must collide with solids and may never be required to fit through an opening narrower than `block.width + 0.5`.
5. Server and prediction tests must replay the same approach from all four directions and agree on the final position.
6. Camera occlusion must not hide the player behind a wall. Use cutaways or foreground fading before shipping an enclosed room.

Route design requirements for chamber and hybrid levels:

1. Ember and Tide each receive a distinct route to their matching gate. At least `60%` of required route segments must be role-specific or spatially separate; a shared hallway recolored twice does not count.
2. Route difficulty is measured before implementation. For each role, record required jumps, lethal crossings, mechanism actions, direction reversals, and mandatory backtracking distance.
3. In an equal-route level, the two route scores must remain within `20%` of one another and their blind-play completion times within `30 seconds`.
4. A deliberately asymmetric level may differ by up to `35%` only when the easier traversal role performs an additional meaningful partner-enabling action. Document that compensation in the traversal proof.
5. Difficulty may differ in kind—precision for one role, sequencing or observation for the other—but neither role may spend more than `20 seconds` waiting without an action, useful view, or mechanism to manage.
6. Every route needs its own readable destination chain: current room exit, next landmark, personal shards, and matching gate.
7. Routes should reconnect visually or mechanically at least once before the final gates so both players can perceive their cooperation.
8. Never make one role complete both routes, escort an idle partner, or solve a substantially longer path without a documented narrative and mechanical reason.

Exterior-to-dungeon transitions follow these additional rules:

1. Author spatial `environmentZones` for every outside and underground region. Do not infer environment from wall color or level number.
2. A level containing both environments must include at least one `entrances` record connecting `outside` and `underground`.
3. If the level starts entirely underground because the previous level ended underground, do not add a fictional outside entrance. Use only underground zones until the route genuinely exits.
4. Returning to outside play requires an authored `underground -> outside` exit. The following level may then begin outside without another underground entrance.
5. Entrance and exit rectangles are visual route markers, not collision. The solids and platforms inside them must still prove a safe traversable path.
6. The first zone containing the spawns and the final zone containing the gates define the level's environmental continuity. Record both in the route proof.

Additional transition geometry rules:

1. Use an elevated exterior spawn surface and an authored `spawnY`; do not fake the descent by moving only the background.
2. Provide one unmistakable entrance silhouette. If both players share the entrance, its descent must safely accommodate both without player collision.
3. The entrance must descend through landings no more than `3.2` vertical units apart, with the first underground objective visible before the exterior leaves the camera.
4. The underground region needs a distinct backdrop, floor treatment, solid-wall language, and lighting landmarks—not merely a darker tint.
5. Once underground, each role’s route must split clearly and satisfy the parity table below.
6. A player must never be required to return outdoors unless the route proof and camera treatment explicitly include that return.

Multi-storey dungeon rules:

1. Each underground storey must be a real solid floor with an authored opening; a row of unrelated floating platforms does not count as a floor.
2. Successive shaft openings must alternate horizontal position by at least `10` world units so players traverse each storey instead of falling straight to the bottom.
3. Every descent uses a visible landing, and every required upward return uses rises no greater than `3.2` units.
4. A tunnel below a solid floor needs at least `playerWidth + 0.25` vertical clearance. Test jumping into its ceiling from both directions.
5. Never place a gate where its five-unit visual envelope intersects a platform, slab, wall, or ceiling.
6. Give each storey a local objective or choice—such as a personal shard on opposing sides—so it is gameplay space rather than decorative walking distance.
7. If the final routes cross in a tunnel, both roles must face equivalent travel and no role may be forced through a pool that kills it without a tested jump or safe mechanism.
8. A roof accessible from the outdoor approach must either be an intentional route or extend above the approach's maximum jump height. Keep at least `playerWidth` of clearance beneath it at the entrance.

Level records use the server's active simulation ticks as elapsed time. The clock pauses until both players are connected, pauses during a disconnect, resets on restart or advance, and freezes on completion. The fastest completion for each level is stored on each player's device for the current pairing. A deterministic fingerprint of the complete authored level catalog invalidates all earlier records when any level definition changes; the per-level fingerprint also guards individual entries.

Every chamber-level review must include this comparison table:

| Measure                    |       Ember |        Tide | Allowed difference |
| -------------------------- | ----------: | ----------: | -----------------: |
| Required jumps             |       count |       count |            `≤ 20%` |
| Lethal crossings           |       count |       count |     `≤ 1` crossing |
| Mechanism actions          |       count |       count |       `≤ 1` action |
| Mandatory backtracking     | world units | world units |            `≤ 35%` |
| Blind-play completion time |     seconds |     seconds |     `≤ 30 seconds` |

## 6. Shards and gate unlocking

Shard counts and gate requirements may vary independently for Ember and Tide. Each level sets `requiredCrystals: { ember, tide }` to whole numbers from zero through the number of placed shards for that role. No more than sixteen shards may be placed in total. The synchronized `uint16` collection mask gives each authored shard a unique bit. A gate opens when its role has collected at least its required count; if more shards are placed, any qualifying set counts. A zero requirement opens that role's gate without shards, subject to shared mechanics.

Shard placement rules:

1. A shard must match the role that can actually reach it.
2. A shard on a platform should be placed about `platform.y + 1.25` vertically.
3. Collection checks the player center within `1.2` horizontal units and a vertical overlap around the player body. Keep shards centered over a stable landing area, not at an extreme platform edge.
4. At least one shard per role may encourage crossing into the other side of the map, but that cross-map route must remain role-valid.
5. Never hide a shard needed to meet the requirement behind scenery, the status card, the control overlay, or outside the camera’s vertical range.
6. Collecting the shard that meets the requirement must not strand the player.
7. Ember shards unlock only Ember’s gate. Tide shards unlock only Tide’s gate.
8. Shared mechanism requirements may additionally lock both gates.
9. Completion requires both unlocked players to occupy their own gates simultaneously. Leaving a gate before both arrive cancels completion; do not design around a latched victory state.

## 7. Lever and activated-platform rules

Levers are reversible toggles. Pressing Interact once changes the linked target on; releasing and pressing again changes it off. Holding Interact must never toggle repeatedly. Pressure plates are held controls: their target is active only while a player or the pushable block overlaps the plate. A control may target `activatedPlatform` or `gates`.

Every lever must satisfy:

1. The lever is reachable before its own bridge is active. A lever may never unlock the only path to itself.
2. At least one role can stand grounded within `lever.reach` and press Interact.
3. If the activated platform bridges a hazard, `activatedPlatform.hazardId` names that exact hazard. It is lethal before activation and disabled only while the platform is active.
4. The activated platform precisely covers its authored interval and becomes a server-authoritative, landable one-way platform only while active.
5. Activating the lever must create meaningful connectivity, shorten a required route, or enable the partner. A lever that only changes a label is not allowed.
6. The pre-activation route to the lever and post-activation route across the bridge must both appear in the traversal proof.
7. Prove both states. Turning a lever off or releasing a plate must retract the target immediately, and neither state may trap a player inside solid geometry.
8. Provide explicit state feedback: handle position, indicator light, `PULL`/`ON` label, plate travel, and activated-platform motion.

## 8. Movable block and pressure plate rules

The movable object is a grounded clay block. It does not jump, fall, ride platforms, or cross hazards. Players may stand on it, and riders move with it while another player pushes. There is no artificial minimum or maximum push interval: the world bounds and the sides of authored solids, platforms, and activated platforms constrain it.

Every block puzzle must satisfy:

1. The complete intended route from `pushable.x` to the plate is free of hazards and has no blocking solid or platform side.
2. The block starts completely inside `[0, level.width]` and outside all solid geometry.
3. The pressure plate overlaps a reachable block position on that collision-bounded route.
4. The block can completely overlap enough of the pressure plate to hold it.
5. There is at least `playerWidth + 0.7` safe standing room on the side from which the block must be pushed.
6. No gate, world boundary, or hazard prevents the player from getting onto the required pushing side.
7. Conflicting pushes from opposite sides must not be required. The server intentionally cancels simultaneous opposite directions.
8. The plate is held, not latched. Releasing it deactivates its target on the next server tick. If both players must occupy their gates, the block—not a player—must be able to remain on a gate-targeting plate.
9. Pushing the block to the plate must not block the only path to either gate.
10. The intended push distance should be `4–14` units. Longer pushes are repetitive rather than difficult.
11. A block may enter or move along a ramp only while both players are grounded, contacting it, and pushing in the same direction. Provide safe standing room for both roles at the ramp entrance and throughout the cooperative push.

Ramps use `x`, `y`, `width`, `height`, `direction` (`up-left` or `up-right`), and `element`. Their visible slope is their collision surface. Do not cover a ramp with a flat platform, place an impassable wall at its high end, or require the wrong role to traverse an elemental ramp.

The current server supports one block, one plate, and one lever. Adding multiples requires a schema and protocol change; level data alone is insufficient.

## 9. Cooperative puzzle dependency rules

Write the puzzle as a dependency graph. It must be acyclic unless every cycle has a guaranteed starting state and escape.

Valid example:

```text
Reach lever
  -> deploy bridge
  -> Tide crosses for final shard

Push block onto plate
  -> shared mechanism ready

Ember shards + Tide shards + shared mechanism ready
  -> both gates open
  -> both players occupy gates
```

Invalid examples:

- The lever is beyond the bridge that lever deploys.
- The block must cross the hazard that the block cannot cross.
- A player must hold the plate while also occupying a distant gate.
- Ember must use a Tide-only platform to reach an Ember shard.
- A required shard is collected only after an unavoidable death that resets it.
- Both players must interact within a sub-second timing window.

Networked cooperation requirements:

1. No mandatory timing window shorter than `2 seconds`.
2. No frame-perfect simultaneous jumps or interactions.
3. One player waiting must have a safe, obvious place to stand.
4. A waiting player should be able to see the partner, the relevant mechanism, or clear state feedback.
5. Mechanism state must be server authoritative and readable after reconnect.

## 10. Difficulty progression

Difficulty should grow through combinations and decisions, not smaller margins.

| Tier     | Intended content                                                                                |
| -------- | ----------------------------------------------------------------------------------------------- |
| Tutorial | Move, jump, role identity, gates; no lethal precision challenge                                 |
| Level 1  | Elemental hazards, role-specific platforms, four shards each, two-player exit                   |
| Level 2  | Reuse Level 1 skills; add one reversible lever/platform and one block/held-plate puzzle         |
| Level 3  | Exterior approach into three solid dungeon storeys, alternating shafts, and crossed exit routes |
| Level 4+ | Increase dependency depth, route crossover, and coordination; retain generous movement margins  |

Rules for progression:

1. Introduce at most one new mechanic family per level.
2. Teach a mechanic safely before combining it with death hazards.
3. Never increase difficulty by exceeding the geometry limits in Section 2.
4. Alternate demanding traversal with recovery space or a readable puzzle beat.
5. Every level needs at least one meaningful partner-enabling action.
6. Every level needs at least one moment where both players’ routes are visually related.
7. Avoid mandatory full-map backtracking more than once per player.
8. Target an initial blind completion time of `3–6 minutes`; reject empty walking added only to lengthen the level.

## 11. Fun and readability checklist

A merely beatable level is not automatically acceptable. It must also satisfy:

- The player can state the next local goal from the screen without opening instructions.
- Important objects have distinct silhouettes: shard, gate, lever, bridge, block, plate, hazard.
- A mechanism visibly changes the world when used.
- The partner’s action creates a benefit the other player can perceive.
- Failed jumps teach something and allow a quick retry.
- The level has a rhythm: traversal, observation, cooperation, payoff.
- Required objects are not hidden behind clay shadows or decorative layers.
- Clay styling never changes the authored collision footprint.
- State is conveyed by shape or text in addition to color.

## 12. Required automated validation

Every new level change must add or extend tests in:

- `packages/core/src/domain/elemental-platformer.test.ts`
- `apps/game-server/src/platformer/simulation.test.ts`

At minimum, tests must prove:

1. All authored objects are in bounds.
2. Each role's `requiredCrystals` value is a whole number between zero and its placed shard count; the two roles may differ.
3. Each crystal bit is unique and fits the current `uint16` mask. The schema supports at most sixteen total crystals.
4. Consecutive required platform rises do not exceed `3.2`.
5. Required horizontal gaps and landing widths meet Section 2.
6. Each role has a traversal path from spawn to enough personal shards to meet its requirement and then its gate.
7. Elemental platforms are landable only by the intended role.
8. Each lethal hazard kills the intended roles and spares any declared safe role.
9. Death clears only the dead role’s shard bits.
10. A lever-linked hazard kills before activation and is safe after activation.
11. The block route overlaps no hazard, can reach the pressure plate, and supports a standing player.
12. The block never moves more than once per tick, respects side contact, carries a rider, and clamps to its track.
13. Each gate remains locked until its role's shard count meets its authored requirement and all shared requirements are satisfied.
14. Completion is true only while both players are grounded in matching gates.
15. Leaving either gate makes completion false again.
16. Elevated spawns stand on authored solid geometry at the declared `spawnY`.
17. Players collide with every solid from the left, right, top, and underside on both client and server.
18. Exterior-to-interior transitions have a traversable entrance and descent steps within the Section 2 rise limit.

Required commands:

```bash
npm run build -w @ldr/core
npm run typecheck
npm run lint -- --no-cache
npm test -- packages/core/src/domain/elemental-platformer.test.ts apps/game-server/src/platformer/simulation.test.ts
```

The core build is required before server tests because `@ldr/core` runtime imports resolve through `packages/core/dist`.

## 13. Manual acceptance run

Automated geometry checks do not replace a two-client playthrough. Test with one simulator and one physical phone when possible.

Run all of these cases:

1. Ember completes every Ember route while Tide remains connected but idle.
2. Tide completes every Tide route while Ember remains connected but idle.
3. Both move and jump simultaneously.
4. Each player dies before and after collecting a shard.
5. Disconnect and reconnect one client after a mechanism is activated.
6. Push the orb from both sides, reverse direction, and attempt opposing pushes.
7. Pull the lever, verify its animation, cross the deployed bridge with both roles, and verify the old hazard no longer kills.
8. Put the orb on the plate, walk both players to their gates, then move one player out before completion.
9. Complete the level on compact and large phone sizes without page scrolling.
10. Verify keyboard controls in Simulator: arrows, Space, and `E`.

## 14. Adding another level: required integration work

A new level is not complete when its geometry is appended. An agent adding Level 4 or later must update all of these integration points:

1. Add the new level constant and include it in `ElementalLevel`.
2. Add the level to `elementalLevel(levelNumber)` and continue to reject unknown numbers.
3. Extend the server’s `advance-level` ceiling to the new final level.
4. Keep the mobile completion overlay and next-level label correct at both intermediate and final levels.
5. Preserve room state compatibility or deliberately version the state schema if adding new mechanism types.
6. Update gate objective copy for the new dependency sequence.
7. Add geometry, role-route, hazard, mechanism, progression, and completion tests.
8. Verify the camera at the new level’s highest and widest required locations.

Do not silently map unknown level numbers back to Level 1.

## 15. Agent submission contract

Every level-building agent must return all of the following:

1. A one-paragraph level concept and its new mechanic, if any.
2. The Ember traversal route.
3. The Tide traversal route.
4. The cooperative dependency graph.
5. A table of every required jump with start height, end height, rise, horizontal gap, and landing width.
6. A table of every hazard and which roles it kills.
7. A shard table with role, coordinates, supporting surface, and escape route.
8. A mechanism proof showing no circular dependency or softlock.
9. Code changes across core, server, mobile rendering, and tests as required.
10. Passing output for the commands in Section 12.
11. Results of the manual acceptance run, with any untested device case stated explicitly.

Agents must not claim a level is beatable solely because it compiles or because all coordinates are in bounds.

## 16. Reusable assignment prompt

Use this when delegating a new level:

```text
Build the next Ember & Tide level. Read and follow
docs/ember-tide-level-authoring-rules.md as a required contract.

Do not change movement constants merely to make your geometry pass. First provide
the two role traversal routes, cooperative dependency graph, and required-jump
table. Then implement the level, any genuinely necessary engine support, mobile
rendering, progression, and tests. Preserve server authority and 30 Hz deterministic
simulation. Run every command in Section 12 and report the Section 15 deliverables.
Do not call the level complete until both role routes, death/reset behavior,
mechanism states, and simultaneous gate completion are verified.
```
