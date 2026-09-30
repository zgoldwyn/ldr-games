---
name: claymorphism
description: Design and implement claymorphic web or app interfaces with soft 3D volume, rounded forms, tactile motion, accessible contrast, and platform-appropriate shadows. Use when a user asks for claymorphism, soft 3D UI, inflated controls, playful tactile surfaces, or wants an existing clay interface reviewed or refined.
metadata:
  source: https://www.setproduct.com/blog/claymorphism-design-guide
  source_type: web
---

# Claymorphism

Build interfaces that feel molded from soft clay: colorful solid surfaces, oversized continuous corners, a soft outer shadow, and opposing inset highlights that create volume.

## Decide whether clay fits

Use claymorphism for playful consumer apps, games, onboarding, compact dashboards, cards, selectors, and prominent actions.

Use it selectively in dense or text-heavy screens. Keep long-form content, tables, legal copy, and utility-heavy areas visually quiet. Clay is an emphasis system, not a coating for every nested view.

## Apply the visual recipe

For a raised clay surface, combine all of these:

1. A pastel or saturated fill distinct from the page background.
2. A broad, hue-matched outer shadow that lifts the object.
3. A bright inset highlight toward the top-left.
4. A darker, hue-matched inset shadow toward the bottom-right.
5. A large continuous radius: usually 24–32 for cards and 16–20 for buttons.

Do not substitute a neutral gray shadow or a white border for the full treatment. Shadows should borrow the surface hue so the volume feels molded rather than dirty.

For a recessed surface, use inset shadows only. This suits wells, selected cells, inputs, sockets, and the cutout inside a clay ring.

## Control depth and hierarchy

- Use no more than two stacked clay layers. A raised card may contain raised controls, but avoid a third nested elevation.
- Let one layer dominate. Secondary elements need shorter offsets, smaller blur, and less opacity.
- Keep at least 16 points or pixels between sibling clay objects so their shadows do not collide.
- Give shadows room to render. Do not clip a shadow with an overflow-hidden parent or a content container that ends before the physical screen edge.
- Keep game geometry honest. Styling must not distort a grid, hit target, board coordinate, or draggable footprint.

## Color, type, and content

- Prefer a softly tinted page background with related pastel surfaces.
- Use dark readable text on light clay. Verify WCAG AA contrast; never assume a pastel combination passes.
- Rounded type can support the style, but clarity and the product's established typography come first.
- Do not encode state through depth or color alone. Pair selected, disabled, win, loss, hit, and miss states with labels, shapes, or accessible state metadata.
- Keep labels direct. Heavy decoration needs simpler copy.

## Make interaction tactile

- On press, scale to about `0.97` and tighten or invert the shadow treatment so the control appears compressed.
- Prefer short, interruptible spring motion. Avoid long elastic bouncing that delays the action.
- Keep motion on transform and opacity when possible.
- Honor reduced-motion preferences and retain an immediate non-motion state change.
- Preserve minimum touch targets even when the visible clay shape is smaller.

## React Native and Expo

- Reuse the project's shared clay style helpers and theme tokens instead of creating one-off shadow constants.
- When supported, use a `boxShadow` array for one hue-matched outer shadow plus top-left and bottom-right inset shadows.
- If the project uses Reanimated and Gesture Handler, use those for press, drag, and layout motion. Do not introduce core `Animated` for the same interaction system.
- Put horizontal padding on the scroll content rather than narrowing the scroll viewport. This lets shadows continue naturally toward the screen edge.
- Avoid `overflow: 'hidden'` on a raised object's ancestors unless clipping is intentional.
- Test compact and large phone widths with deterministic geometry tests. Visual polish must not change board math.

## Web

Use the same three-part shadow recipe:

```css
.clay-raised {
  background: var(--clay-surface);
  border-radius: 32px;
  box-shadow:
    10px 12px 24px color-mix(in srgb, var(--clay-surface) 62%, transparent),
    inset 7px 7px 13px rgb(255 255 255 / 42%),
    inset -7px -7px 13px rgb(90 45 75 / 16%);
}

.clay-raised:active {
  transform: scale(0.97);
  box-shadow:
    4px 5px 12px color-mix(in srgb, var(--clay-surface) 45%, transparent),
    inset 4px 4px 9px rgb(90 45 75 / 14%),
    inset -3px -3px 7px rgb(255 255 255 / 30%);
}
```

Tune colors and opacity to the actual palette rather than copying fixed gray shadows.

## Game-board patterns

- Build a board as a raised outer tray containing explicit rows and rounded cells.
- Use spacing between cells instead of rigid divider lines when the game rules permit it.
- Keep the exact row and column count apparent at a glance.
- Give occupied marks their own modest clay volume without exceeding two perceived elevation layers.
- Construct an O as a raised outer disc with an inset center matching its cell. A border-only ring reads flat and usually shadows unevenly.
- Preserve semantic labels such as row, column, mark, availability, and turn state for assistive technology.

## Review checklist

- Does each raised element have a fill, outer lift, and two-direction inset modeling?
- Are radii large and consistent without turning unrelated containers into pills?
- Are there at most two visible clay elevations?
- Do shadows have room to render at every viewport width?
- Are press and drag states tactile, interruptible, and reduced-motion safe?
- Is text contrast verified and is state communicated by more than color or shadow?
- Are grids, touch targets, and draggable footprints still exact?
- Does the interface remain readable before the shadows load or on a platform with reduced shadow support?

## Reference

This guidance is distilled from Setproduct's claymorphism design guide and adapted for this project's React Native and Expo architecture. Revisit the source only when researching a new platform capability or materially changing the design system.
