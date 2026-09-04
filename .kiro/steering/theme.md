---
inclusion: always
---

# Theme & Visual Design

The LDR Companion App uses a soft **pastel, minimalist, and cute** visual style. The vibe is calm and cozy, not busy or bright. Prioritize whitespace, gentle contrast, rounded shapes, and restraint. When in doubt, do less.

## Design Principles

- **Minimalist first.** Generous whitespace, few elements per screen, clear hierarchy. Avoid clutter, heavy borders, and dense layouts.
- **Soft, not saturated.** Use muted pastel tones. Never use pure/neon or fully saturated colors for large surfaces. Bright accents are used sparingly and only for small, meaningful highlights.
- **Gentle contrast.** Keep contrast comfortable and easy on the eyes, but never below WCAG AA for text (4.5:1 for body text, 3:1 for large text). Prefer dark-enough text on light pastel backgrounds.
- **Rounded and friendly.** Rounded corners, soft shadows, and cute-but-subtle touches (small heart motifs, gentle icons). Keep decoration light.
- **Cohesive.** Both platform shells (mobile Expo, desktop Electron/web) must present the same theme so the experience is identical across devices (Req 5.1).

## Theming Architecture

- The theme is **swappable via a single active color option**. Implement it as a set of design tokens (semantic names → color values), not hardcoded hex values scattered in components.
- Live in the shared TypeScript core so both shells consume the same tokens.
- Ship multiple named **color options**; the user can pick one in settings.
- **Default color option: `pink`.**
- Persist the selected color option as an account/shared setting so it stays consistent across platforms.
- Support both **light** and (optionally) a soft **dark** variant per color option. Light is the primary target.

## Semantic Design Tokens

Reference colors by role, not by hue. Components use these token names only:

- `background` — app canvas (lightest tint)
- `surface` — cards, sheets, list rows (slightly elevated from background)
- `surfaceMuted` — secondary/inactive surfaces
- `primary` — main accent (the selected color option's core pastel)
- `primaryStrong` — pressed/active state, small emphasis (a step deeper than `primary`)
- `onPrimary` — text/icons on top of `primary`
- `accent` — secondary highlight, used sparingly
- `textPrimary` — main text (soft near-black, not pure #000)
- `textSecondary` — supporting text
- `textMuted` — hints, placeholders, timestamps
- `border` — hairline dividers and outlines (low contrast)
- `success` / `warning` / `error` — status colors, kept in the pastel family
- `shadow` — soft, low-opacity shadow color

## Color Options

All options are muted pastels. Values below are starting points — tune for AA contrast on text.

### `pink` (default)
- `background` `#FFF6F8`
- `surface` `#FFFFFF`
- `surfaceMuted` `#FDEFF3`
- `primary` `#F7B8CC`
- `primaryStrong` `#E896B2`
- `onPrimary` `#5A2A3A`
- `accent` `#F6C9B8` (soft peach)
- `textPrimary` `#3A2A31`
- `textSecondary` `#7A6670`
- `textMuted` `#B29CA6`
- `border` `#F3E1E8`
- `success` `#AED9C0`
- `warning` `#F5D9A8`
- `error` `#EBA9A9`
- `shadow` `rgba(233, 150, 178, 0.18)`

### `lavender`
- `background` `#F8F6FD`
- `surface` `#FFFFFF`
- `surfaceMuted` `#F0ECFA`
- `primary` `#C9BCEB`
- `primaryStrong` `#A995DE`
- `onPrimary` `#33285A`
- `accent` `#BFD3F2`
- `textPrimary` `#2F2A3A`
- `textSecondary` `#6E6780`
- `textMuted` `#A69FB8`
- `border` `#E7E1F5`

### `mint`
- `background` `#F4FBF7`
- `surface` `#FFFFFF`
- `surfaceMuted` `#E8F5EE`
- `primary` `#AEE0C6`
- `primaryStrong` `#86CBA6`
- `onPrimary` `#1F4736`
- `accent` `#CDEBDD`
- `textPrimary` `#28362F`
- `textSecondary` `#5F7269`
- `textMuted` `#98AAA1`
- `border` `#DCEFE5`

### `sky`
- `background` `#F4F9FD`
- `surface` `#FFFFFF`
- `surfaceMuted` `#E8F1FA`
- `primary` `#B4D3EE`
- `primaryStrong` `#8CB8E0`
- `onPrimary` `#1F3A52`
- `accent` `#CBE3D9`
- `textPrimary` `#293440`
- `textSecondary` `#5F6E7C`
- `textMuted` `#9AA8B4`
- `border` `#DCE9F4`

### `butter`
- `background` `#FFFBF2`
- `surface` `#FFFFFF`
- `surfaceMuted` `#FBF2DE`
- `primary` `#F3DFA6`
- `primaryStrong` `#E6C878`
- `onPrimary` `#5A4718`
- `accent` `#F5CBB0`
- `textPrimary` `#3B3527`
- `textSecondary` `#7A7160`
- `textMuted` `#B4AB96`
- `border` `#F1E6CE`

## Typography

- Use a soft, rounded, friendly sans-serif (e.g., Nunito, Quicksand, or Poppins). One family across both shells.
- Limited scale: display, title, body, caption. Keep weights light-to-medium; avoid heavy bold everywhere.
- Comfortable line height (~1.4–1.5) and generous letter spacing on small caps/labels.

## Shape, Spacing & Elevation

- Corner radius: cards/sheets ~16px, buttons/inputs ~12px, pills fully rounded.
- Spacing scale in multiples of 4 (4, 8, 12, 16, 24, 32). Favor the larger end for breathing room.
- Shadows are soft and low-opacity using the `shadow` token — subtle depth, never harsh.
- Hairline borders only where needed; prefer separation via spacing and surface tint over lines.

## Depth & Stacking

Use layered cards instead of long lists when a view shows a small set of peers (paired partner cards, game history, quiz results, memory cards).

- One item is **active and upright**; neighbors sit behind it, slightly scaled down, slightly rotated, and dimmed. Depth reads through position and opacity, not through heavy shadow.
- Keep the fan shallow: a few degrees of rotation, a few percent of scale, so it looks like a soft stack of paper rather than a card trick.
- Compute a card's appearance from its **distance to the active index, wrapped** around the collection. The stack is a loop, not a line: paging past the last item returns to the first, and there is no dead end at either edge.
- Prev/next controls (or a horizontal swipe) drive the active index. Never require dragging to reach an item; tapping a visible neighbor also promotes it.
- Only the active card is interactive and in the tab order. Neighbors are decorative (`aria-hidden` / `accessibilityElementsHidden`) and never receive focus.
- Cap the visible depth (about two cards behind the active one) and don't render z-order by DOM order alone — set it explicitly so it survives reordering.

## Placeholder Art & Avatars

Illustration is drawn, not fetched. Screens must look finished before any real asset exists.

- Draw placeholders with shapes and type (initials on a tinted `surfaceMuted` disc, simple rounded portrait silhouettes) using theme tokens. No stock photos, no image files, no icon-font dependencies.
- Derive placeholder tint deterministically from a stable id, and pick it from the active option's palette so it re-themes with everything else.
- **Swap-safe by construction:** a placeholder and a real image occupy the same box with the same radius, aspect ratio, and clipping. Dropping in an `<Image>` must not disturb layout, rotation, z-order, or the stack geometry around it.
- Never let a missing avatar collapse or resize a card. Reserve the space, show initials, and let the image replace the fill.
- Keep drawn art low-detail and rounded — a couple of shapes, one accent at most. Cute, not illustrative.

## Motion & Reduced Motion

- Motion is short and soft: ~150–250ms for state changes, ~250–350ms for card transitions, gentle ease-out. Nothing bounces hard or overshoots much.
- Animate transform and opacity only. Don't animate layout, color, or shadow on every frame.
- Motion clarifies where something came from. If a transition doesn't explain a change, cut it.
- Honor `prefers-reduced-motion` (web) / `isReduceMotionEnabled` (Expo) **by degrading to a readable static state, never by freezing mid-animation**. Reduced motion means: no rotation or fan, cards stack squarely or fall into a plain vertical list, transitions become instant, and every item stays reachable via the same prev/next controls. The reduced-motion path is a first-class layout, not a broken one.
- Reduced motion must not remove information: whatever the animation communicated has to remain visible in the static state.

## Component Craft

- Components are **self-contained and portable**: theme tokens in, rendered UI out. No animation libraries, gesture libraries, or global stylesheets for effects that a few transforms can produce.
- Prefer one small component that does one thing well over a configurable widget. If it needs more than a handful of props, split it.
- Design mobile-first down to a **390px-wide viewport** (iPhone 14/15) with no horizontal scroll and no clipped controls; scale up from there.
- Tap targets at least 44×44pt, including prev/next controls, even when the visual chevron is smaller.
- Handle empty, loading, and single-item states explicitly. A stack of one is just a card; a stack of zero is a quiet empty state, not an invisible component.

## Do / Don't

- Do keep screens quiet: one primary action, minimal chrome.
- Do use `primary` for the main call-to-action; reserve `accent` for occasional highlights.
- Do keep illustrations/icons simple, rounded, and low-detail.
- Do draw placeholders from tokens so a screen is presentable with zero assets, and size them so a real image drops in without moving anything.
- Do treat the reduced-motion rendering as a design you'd ship on its own.
- Don't use neon, high-saturation, or pure black/white as dominant colors.
- Don't reach for an animation or gesture library for a few transforms.
- Don't hide content behind motion — if only the animation explains it, the layout is wrong.
- Don't stack many bright colors together — pick one accent per view.
- Don't hardcode hex values in components; always go through the theme tokens.
- Don't sacrifice text legibility for softness — verify AA contrast.
