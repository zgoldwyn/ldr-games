# Ember & Tide Level Forge

Run from the repository root:

```bash
npm run level-builder
```

Then open [http://localhost:4179](http://localhost:4179). The command builds the shared core first, so the editor loads the current Level 1–3 definitions rather than stale copies.

## Workflow

1. Choose an existing level or click **New**. **Number** is both the level's identity and its sequence. Use the arrow buttons beside the picker to swap numbers and publish the new order to the live catalog without renaming anything.
2. Select a build tool and click the canvas. Drag any object to move it; edit exact coordinates and types in the Inspector. Inspector X/Y values refer to the object's visual center, and X 0 is the stage midpoint. The editor converts these authoring coordinates back to the runtime's left-origin format when exporting.
3. Use normal click for an Ember gate/spawn and Shift-click for Tide. Gates and spawns already exist in every level and are repositioned rather than duplicated.
4. Resolve the Rule Check panel's blocking issues and review its warnings. The automated checks cover bounds, shard counts and protocol capacity, unsafe spawns, landing widths, low-platform/pool overlap, portal clearance, duplicate IDs, and suspicious rises.
5. Click **Copy TypeScript** to paste a core-ready `as const` definition into `packages/core/src/domain/elemental-platformer.ts`, or **Download JSON** to save a design artifact. **Import TypeScript** safely reopens a JSON-shaped `.ts` file produced by the builder; **Paste TypeScript** accepts the same source in a text box. Neither path executes imported code.
6. **Push update** asks which existing live slot to overwrite. It archives that slot's previous level as timestamped JSON in `apps/level-builder/archived-levels/`, installs the level currently being edited with the target slot's runtime number, formats and rebuilds `@ldr/core`, and touches the game-server reload token. **Archived** lists every displaced version and can reopen one as a workspace copy. Use pushing only in local development: the watched server restarts, connected matches reconnect, Metro refreshes the shared bundle, and the changed catalog fingerprint invalidates old best times.

The builder autosaves the complete workspace after edits and automatically restores every level plus the exact active level when reopened. **Save** forces an immediate checkpoint and **Open saved** manually restores it. The builder also saves synchronously before following any link and whenever its tab is hidden, closed, or reloaded. JSON and TypeScript import/export remain portable backup paths for moving work to another browser or computer.

**Archive active level** manually moves the selected workspace level into the same archive history and removes it from the working list. This does not alter a live game slot. Reopen it later with **Archived → Open copy**.

## Test jumps in the browser

- Choose Ember or Tide and click **Jump reach**, then click any intended standing position. Jump Reach is a one-click placement tool and disarms immediately after placing the test. Drag the resulting origin marker to update every trajectory continuously. Clicking or dragging near a usable platform or solid edge snaps the launch position to that edge and marks it with a green circle. A marker above level geometry projects vertically onto the highest usable surface below it instead of jumping from midair; hold Shift to bypass all snapping. All left, vertical, and right trajectories use the selected character's color. A tighter dash pattern marks a route that lands in a lethal pool. Jump Reach is cleared and hidden while Playtest is active.
- Click **Playtest** to spawn a character at the authored role spawn. Move with A/D or the arrow keys, jump with W, Up, or Space, press R to reset, and click the canvas to reposition the character for a focused test. Hold Shift while pushing to simulate the second partner's force on a ramp.
- The playtest uses the authored `moveSpeed`, `jumpSpeed`, `gravity`, player size, solid-wall collision, one-way elemental platform rules, and hazard role rules. It is useful for fast iteration, but the server remains authoritative and a two-device run is still required before shipping.

The validator does not claim that geometry alone proves a level beatable. Follow the linked authoring rules for per-role traversal proofs and complete a two-client playtest before shipping. When level fingerprinting is enabled, changing exported geometry changes that fingerprint and invalidates scores recorded against the older layout.

Trackpad gestures: two-finger scrolling pans horizontally and vertically, while pinching zooms around the pointer. You can also drag empty canvas space to pan.

Select several objects with Shift-click, Command-click, or Control-click on the canvas or object list. Drag any selected object to move the complete group. Shared Inspector fields edit the whole selection; setting Center X or Center Y aligns the selected centers. Copy/Paste buttons and Command/Ctrl-C/V duplicate ordinary level objects with a visible offset. Gates and spawns are fixed-role objects and are not duplicated or deleted.

Use **Paste ↔** or Command/Ctrl-Shift-V to reflect the copied selection across the stage's X 0 axis. Mirrored paste preserves each object's size, height, and element type.

Choose **Resize** and select an object to reveal resize handles. Platforms, pools, and gates expose horizontal edge handles; solids and ramps expose edges and corners. Center coordinates update as the bounds change. A ramp's Inspector also controls whether it rises left or right.

Mechanic tools author one server-backed lever, pressure plate, pushable block, and activated platform per level. In the Inspector, each control can target either the activated platform or the gates. Levers toggle on and off on separate Interact presses; pressure plates activate only while held by a player or block. The activated platform has collision only while all controls targeting it are active. Pushables have no authored min/max track: world edges and solid/platform sides stop them, and ramps require both partners pushing together.

Use **Environment Zone** to mark outside and underground rectangles and **Entrance** to author the visible transition between them. A mixed level fails validation without an outside↔underground transition. A wholly underground level must not invent an outside entrance; use an underground→outside entrance only where the route genuinely returns outdoors.

Keyboard shortcuts: `1`–`8` choose tools, Command/Ctrl-A selects all, Delete removes selected ordinary objects, Command/Ctrl-C/V copies and pastes, Command/Ctrl-Z undoes, and Escape returns to Select.
