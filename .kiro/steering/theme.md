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

## Do / Don't

- Do keep screens quiet: one primary action, minimal chrome.
- Do use `primary` for the main call-to-action; reserve `accent` for occasional highlights.
- Do keep illustrations/icons simple, rounded, and low-detail.
- Don't use neon, high-saturation, or pure black/white as dominant colors.
- Don't stack many bright colors together — pick one accent per view.
- Don't hardcode hex values in components; always go through the theme tokens.
- Don't sacrifice text legibility for softness — verify AA contrast.
