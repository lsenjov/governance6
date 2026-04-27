# Theme — Brutalist Civic Bulletin

This is the canonical theme reference for the app. It supersedes
`plans/2026-04-25-theme-redesign-brutalist-v1.md`, which described the
intent; this document describes the shipped system.

## Concept

A municipal notice board rendered as software. Aggressively un-pretty,
ultra-legible, single hot accent. Heavy type, hard borders, zero
ornament, deliberate grid. The look of a city ordinance posted on a
tram stop in 1978 — softened only by a mint accent in place of signal
yellow.

## Palette

Defined in `src/index.css:1-36` on `:root`. Two surfaces, two accents,
void black. Greys are forbidden except `--fg-muted` for tiny captions.

| Token           | Value     | Role                              |
| --------------- | --------- | --------------------------------- |
| `--bg`          | `#f4f1ea` | Newsprint off-white               |
| `--bg-elevated` | `#ffffff` | Posted notice                     |
| `--bg-muted`    | `#e9e4d6` | Inset / banded rows               |
| `--fg`          | `#0a0a0a` | Void black                        |
| `--fg-muted`    | `#555555` | Secondary, captions only          |
| `--border`      | `#0a0a0a` | Hard 2px black                    |
| `--accent`      | `#7dc4c0` | Teal/mint (primary action)        |
| `--accent-fg`   | `#0a0a0a` | Black on mint                     |
| `--alt-accent`  | `#ff3a2e` | Riot red — destructive / alerts   |
| `--success`     | `#0a0a0a` | No green; success uses bold rule  |
| `--danger`      | `#ff3a2e` | Riot red                          |
| `--warning`     | `#7dc4c0` | Same as accent                    |

**Accent rule:** mint is for fills, strips, and CTAs only. Never use
mint as a text color against the page background — contrast fails.

## Typography

Font tokens at `src/index.css:20-22`:

```css
--font-body:    "Inter", "Helvetica Neue", Arial, sans-serif;
--font-display: "Archivo Black", "Space Grotesk", "Inter", sans-serif;
--font-mono:    "JetBrains Mono", ui-monospace, monospace;
```

Loaded in `index.html` via Google Fonts (`Inter 400/600/700`,
`Archivo Black`, `JetBrains Mono 400/600`).

| Use                  | Font          | Treatment                                       |
| -------------------- | ------------- | ----------------------------------------------- |
| Body                 | Inter 14px    | line-height 1.5                                 |
| `h1` / `h2` / `h3`   | Archivo Black | UPPERCASE, `letter-spacing: 0.02em`             |
| Section labels       | Inter 700     | UPPERCASE, `letter-spacing: 0.12em`, `0.72rem`  |
| Numerals (POWER, $)  | JetBrains Mono | `font-variant-numeric: tabular-nums`           |
| Buttons              | Archivo Black | UPPERCASE, `letter-spacing: 0.06em`, `0.85rem`  |

Heading sizes: `h1 = 2rem`, `h2 = 1.5rem`, `h3 = 1.125rem`
(`src/index.css:67-80`).

## Geometry

- **Zero radius.** `--radius: 0`; reinforced by a global
  `* { border-radius: 0 }` reset at `src/index.css:38-41`. There are
  no pills, no rounded cards, no rounded buttons.
- **Hard 2px borders.** Cards, inputs, buttons, drawers, popovers,
  badges, tables, and the right-rail tracks all use
  `border: 2px solid var(--border)`.
- **No blurred shadows.** Every `box-shadow` is a hard offset
  (`Npx Npx 0 var(--border)`). Blur radius is forbidden.

## Motion

- Buttons translate `2px 2px` on `:hover` / `:active` and lose their
  drop shadow, simulating a physical press
  (`src/index.css:135-143`).
- The hard shadow itself **does not** animate — there is no
  `transition` on `box-shadow`. Verify before adding any.
- No fade-ins, no slides, no spinners with motion. Empty states use
  diagonal stripes; loading uses an uppercase mono caption
  (`.centered-loader`, `src/index.css:281-290`).

## Components

### Buttons (`src/index.css:120-168`)

- **Primary** — mint fill, 2px black border, `4px 4px 0 #0a0a0a`
  hard shadow. Press: shadow vanishes, content shifts `2px 2px`.
- **Secondary** — white fill, otherwise identical.
- **Danger** — riot red fill, white text.
- **Disabled** — opacity 0.5, shadow remains, no press transform.
- **HUD / nav buttons** — compact, no shadow, white background that
  flips to mint on hover (`src/index.css:236-255`, `403-423`).

### Inputs (`src/index.css:170-202`)

White background, 2px black border. Focus state is a `4px solid`
mint outline with `outline-offset: 0` (sits flush against the
border, not floating). Labels are uppercase 0.72rem, letter-spacing
0.12em.

### Top nav (`src/index.css:210-261`)

Black bar, white Archivo-Black wordmark, **4px mint underline strip**
along the bottom edge. Nav links use the marker-underline treatment.

### Cards (`src/index.css:292-321`)

White surface, 2px black border, no shadow. Variants:

- `.card.tight` — 0.75rem / 1rem padding for dense lists.
- `.card.flush` — strips bottom margin.
- `.card.drawback` — 6px riot-red top border for destructive content
  (`src/index.css:974-977`).

### Bulletin numerals (`src/index.css:946-958`)

Wrap a page-level container in `.bulletin` to auto-number every
card heading as `§01`, `§02`, … in mono using CSS counters. This is
the signature motif — use it on dashboard-style pages.

### Badges (`src/index.css:538-574`)

Square, 2px black border, mono 0.7rem uppercase. Variants:
`accent` (mint), `warning` (mint), `success` (white-on-black, no
green), `danger` (riot red, white text).

### Tables (`src/index.css:600-635`)

2px outer border, 2px row dividers. Header row is solid black with
white Archivo-Black 0.72rem uppercase text. Body alternates
`--bg-elevated` and `--bg-muted`.

### Game HUD (`src/index.css:371-423`)

Sticky black bar with white Archivo-Black text and a 4px mint bottom
strip. On mobile the right rail is preceded by a caution-tape
divider (`src/index.css:480-489`).

### Power standings (`src/index.css:835-871`)

Three-column grid (rank, bar, score) in mono with tabular-nums.
Top rank gets a full mint row fill. The bar track is white with a
2px black border; the fill is mint. Bar height is `0.875rem`.

### Drawer & popovers (`src/index.css:737-830`)

`.drawer`, `.notes-popover`, `.action-popover` — all 2px black
borders on white. Popovers use `6px 6px 0 #0a0a0a` hard shadow.
Drawer backdrop is `rgba(10,10,10,0.4)`, no blur.

### Sign-in (`src/index.css:637-663`)

Centered notice card, 2px border, `8px 8px 0 #0a0a0a` shadow. The
body element gains a translucent diagonal-stripe background while
the unauthenticated wrapper is mounted (uses `:has()`).

### Read-only banner (`src/index.css:665-685`)

Mint background, void-black uppercase Archivo. Top and bottom are
caution-tape stripes drawn via `border-image`.

### Links (`src/index.css:101-118`)

Color does not change on hover. Instead a 4px mint strip sits behind
the text via `box-shadow: inset 0 -4px 0 var(--accent)`, thickening
to 6px on hover. Focus is a 4px mint outline with 2px offset.

## Utilities (`src/index.css:925-989`)

| Class             | Use                                              |
| ----------------- | ------------------------------------------------ |
| `.section-label`  | Tiny uppercase 0.72rem caption                   |
| `.hard-shadow`    | `4px 4px 0 var(--border)` drop                   |
| `.bulletin`       | Wrapper that numbers child card headings         |
| `.marker-link`    | Manual mint highlight strip behind text          |
| `.tape`           | 8px diagonal mint/black caution-tape strip       |
| `.empty-stripes`  | Diagonal hatch for empty states                  |
| `.mono`/`.tabular`| JetBrains Mono with tabular-nums                 |

## Verification checklist

When adding new components or reviewing changes, confirm:

- [ ] No `border-radius` other than `0`. The `*` reset enforces this
      but custom values can re-introduce roundness.
- [ ] No `box-shadow` with a non-zero blur radius. Only hard
      `Npx Npx 0` offsets are allowed.
- [ ] Mint (`--accent`) is never used as a text color against
      `--bg`, `--bg-elevated`, or `--bg-muted`.
- [ ] Headings use `var(--font-display)` and are UPPERCASE.
- [ ] Quantitative numerals use `var(--font-mono)` with
      `tabular-nums`.
- [ ] Borders inside the design system are 2px (or 4px on the nav
      and HUD bottom strips, 6px on `.card.drawback`).
- [ ] Mobile (≤ 360px) remains legible with 2px borders.
- [ ] No `transition` on `box-shadow` properties.

## Out of scope

- Custom illustrations / wood-cut iconography (separate art pass).
- Light/dark switch — brutalism is light by default; a "blackout"
  inversion is a future variant.
