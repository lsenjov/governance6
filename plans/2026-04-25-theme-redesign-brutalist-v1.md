# Theme Redesign — Brutalist Civic Bulletin (v1)

## Concept

A municipal notice board rendered as software. Aggressively un-pretty,
ultra-legible, single hot accent. Takes the word *governance* literally:
this is the look of a city ordinance posted on a tram stop in 1978.
Heavy type, hard borders, zero ornament, deliberate grid.

## Palette

Replace the entire `:root` color set in `src/index.css:1-28`:

| Token             | Value      | Role                                |
| ----------------- | ---------- | ----------------------------------- |
| `--bg`            | `#f4f1ea`  | Newsprint off-white                 |
| `--bg-elevated`   | `#ffffff`  | Posted notice                       |
| `--bg-muted`      | `#e9e4d6`  | Inset / banded rows                 |
| `--fg`            | `#0a0a0a`  | Void black                          |
| `--fg-muted`      | `#555555`  | Secondary, captions only            |
| `--border`        | `#0a0a0a`  | Hard 2px black                      |
| `--accent`        | `#ffcc00`  | Signal yellow (primary action)      |
| `--accent-fg`     | `#0a0a0a`  | Black on yellow                     |
| `--alt-accent`    | `#ff3a2e`  | Riot red — destructive / alerts     |
| `--success`       | `#0a0a0a`  | No green; success uses bold rule    |
| `--danger`        | `#ff3a2e`  | Riot red                            |
| `--warning`       | `#ffcc00`  | Same as accent                      |

Greys are forbidden except `--fg-muted` for tiny captions. The system has
exactly two surfaces and two accents.

## Typography

```css
:root {
  --font-body: "Inter", "Helvetica Neue", Arial, sans-serif;
  --font-display: "Archivo Black", "Space Grotesk", "Inter", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}
```

- Body: 14px Inter, line-height 1.5.
- Display: Archivo Black for `h1/h2`, ALL CAPS, `letter-spacing: 0.02em`.
- Section labels: `text-transform: uppercase; letter-spacing: 0.12em;
  font-size: 0.72rem;`.
- Numerals everywhere quantitative: monospace + tabular-nums.

Add to `index.html`:

```html
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Archivo+Black&family=JetBrains+Mono:wght@400;600&display=swap"
  rel="stylesheet"
/>
```

## Motifs

1. **Zero radius.** Set `--radius: 0` and remove every `border-radius` in
   `src/index.css:1-651` (or override via a single `*` rule then re-allow on
   pills only).
2. **Hard 2px borders.** Replace 1px `var(--border)` with `2px solid #0a0a0a`
   on cards, the top nav, drawers, popovers, and the form fields' bottom edge.
3. **No shadows.** Strip `box-shadow` from `.notes-popover`, `.action-popover`,
   `.drawer` (`src/index.css:484-565`). Elevation is communicated by border
   weight, not blur.
4. **Section numerals.** Each `.card` heading is preceded by a giant numeric
   counter (`§01`, `§02`, …) using CSS counters on a `.bulletin` wrapper.
5. **Banded tables.** Alternating `--bg` / `--bg-muted` rows; black header row
   with white text.
6. **Yellow CTAs.** Primary `button` is yellow with a 2px black border and
   `box-shadow: 4px 4px 0 #0a0a0a` "hard offset" — moves to `2px 2px` on
   `:active`, no shadow on `:hover`.
7. **Posted-notice headers.** `.top-nav` becomes a black bar with white
   Archivo-Black wordmark and yellow underline strip below it (4px).
8. **Marker underlines on links.** Links get a 4px yellow background strip
   behind the text (`box-shadow: inset 0 -4px 0 var(--accent)`), no color
   change.

## CSS impact map

- `:root` (`1-28`) — swap palette + radius + font tokens.
- `*` reset block — add `border-radius: 0` override (or a `--radius` var).
- `button` (`53-82`) — yellow fill, 2px black border, hard-offset shadow,
  uppercase Archivo Black label, `padding: 0.625rem 1rem`.
- `button.secondary` — white fill, 2px black border, same hard shadow.
- `button.danger` — riot red, white text.
- `input/textarea/select` (`83-105`) — `background: #fff; border: 2px solid
  #0a0a0a; border-radius: 0;` Focus state: `outline: 4px solid var(--accent);
  outline-offset: 0;`.
- `.top-nav` (`120-127`) — black background, white text, yellow 4px bottom
  strip.
- `.card` (`161-176`) — white bg, 2px black border, no shadow, `padding:
  1.25rem 1.5rem`.
- `h2/h3` inside cards — uppercase Archivo Black, larger size jump
  (1.5rem / 1.125rem).
- `.badge` (`367-393`) — square corners, 2px black border, solid fill.
  `accent` = yellow, `success` = white-on-black, `warning` = yellow,
  `danger` = riot red.
- `.row-divider` (`178-185`) — `border-bottom: 2px solid #0a0a0a`.
- `.power-bar-track/-fill` (`591-601`) — black-bordered track, yellow fill,
  zero radius, `height: 0.875rem`.
- `.drawer` / `.notes-popover` / `.action-popover` (`484-565`) — drop
  shadows, 2px black borders, white surface.
- Add `body` background diagonal-stripe option for empty states using
  `repeating-linear-gradient(45deg, #0a0a0a 0 2px, transparent 2px 14px)`.

## New utilities

```css
.section-label { text-transform: uppercase; letter-spacing: 0.12em;
                 font-size: 0.72rem; font-weight: 700; }
.hard-shadow   { box-shadow: 4px 4px 0 #0a0a0a; }
.bulletin      { counter-reset: section; }
.bulletin .card h2::before {
  counter-increment: section;
  content: "§" counter(section, decimal-leading-zero) "  ";
  font-family: var(--font-mono);
  color: var(--fg-muted);
}
.marker-link   { box-shadow: inset 0 -6px 0 var(--accent); }
.tape          { /* yellow caution-tape divider */
  background: repeating-linear-gradient(45deg,
    var(--accent) 0 12px, #0a0a0a 12px 18px);
  height: 8px;
}
```

## Component-level notes

- **HUD (`.game-hud` `241-262`):** black bar, white type, yellow phase strip
  underneath. Use the caution-tape divider above the right rail on mobile.
- **Power standings:** rank as `01.` / `02.` in mono, name in Archivo Black,
  bar in yellow with hard black border. Top rank gets a yellow background
  fill on the entire row.
- **Drawbacks:** riot-red top border on the card, the word "DRAWBACK" as a
  section label.
- **Sign-in:** centered notice on a striped diagonal background; yellow CTA
  with hard shadow.
- **Read-only banner (`.read-only-banner` `435-442`):** already yellow —
  upgrade to caution-tape stripes top + bottom.

## Verification

- [ ] No `border-radius` survives anywhere except intentional pills (none in
      this theme).
- [ ] No `box-shadow` with blur ≠ 0 anywhere; only hard offsets.
- [ ] Contrast: yellow `#ffcc00` on black ≥ 12:1; black on `--bg` ≥ 18:1.
- [ ] Yellow is *never* used for text, only fills/strips/CTAs.
- [ ] `prefers-reduced-motion` — no animations to gate, but verify the hard
      shadow doesn't ship as a transition.
- [ ] Mobile: 2px borders + no shadow remains legible at 360px width.

## Out of scope

- Custom illustrations / wood-cut iconography (would amplify the look but
  is a separate art pass).
- Light/dark switch — brutalism is light by default; a "blackout" inversion
  is a future variant.
