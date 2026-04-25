# Theme Redesign — Soft Civic / Calm Governance (v1)

## Concept

The deliberate opposite of edgy. Trust-building, public-service feel — the
polish of a well-funded Nordic government portal or a modern public-records
site. Generous whitespace, warm off-white background, sage-green primary,
terracotta accent, semantic category colors per entity (POWER, DRAWBACK,
MINION, SYNDICATE), comfortable typography, large tap targets. Light by
default; comfortable dark mode toggleable.

## Palette

Replace `:root` (`src/index.css:1-28`) and add semantic category tokens:

| Token             | Value      | Role                                  |
| ----------------- | ---------- | ------------------------------------- |
| `--bg`            | `#faf8f4`  | Warm off-white                        |
| `--bg-elevated`   | `#ffffff`  | Card surface                          |
| `--bg-muted`      | `#f1ede5`  | Inset / subtle bands                  |
| `--fg`            | `#1f2933`  | Ink, slightly cool                    |
| `--fg-muted`      | `#5a6573`  | Secondary text                        |
| `--border`        | `#e3ddd1`  | Soft hairline                         |
| `--accent`        | `#4a7c59`  | Sage green — primary action           |
| `--accent-fg`     | `#ffffff`  | White on sage                         |
| `--accent-soft`   | `#dfe9e1`  | Tint surface for accent badges        |
| `--c-power`       | `#4a7c59`  | Sage — POWER                          |
| `--c-syndicate`   | `#3d5a8a`  | Indigo — SYNDICATE                    |
| `--c-drawback`    | `#c66b4a`  | Terracotta — DRAWBACK                 |
| `--c-minion`      | `#3d7ea6`  | Sky — MINION                          |
| `--c-note`        | `#a07a3a`  | Mustard — NOTE                        |
| `--success`       | `#3d7a4f`  | Deeper sage                           |
| `--danger`        | `#b34a3a`  | Warm red                              |
| `--warning`       | `#c9912e`  | Amber                                 |
| `--info`          | `#3d7ea6`  | Sky                                   |

Dark-mode tokens (under `[data-theme="soft-civic-night"]`):

| Token             | Value     |
| ----------------- | --------- |
| `--bg`            | `#15181d` |
| `--bg-elevated`   | `#1c2027` |
| `--bg-muted`      | `#22272f` |
| `--fg`            | `#e6eaf0` |
| `--fg-muted`      | `#9aa4b0` |
| `--border`        | `#2c323b` |
| `--accent`        | `#7aaf8c` |

Category hues stay similar but shift ~10% lighter for the dark surface.

## Typography

```css
:root {
  --font-body: "Inter", "Source Sans 3", system-ui, sans-serif;
  --font-display: "Source Serif 4", "Source Serif Pro", Georgia, serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
}
```

- Body: 15.5px Inter, line-height 1.6, letter-spacing 0.
- Display: Source Serif 4 for `h1` / `h2` (sentence case, *not* uppercase),
  weight 600, letter-spacing -0.01em. `h3` stays Inter 600.
- Numerics: tabular-nums Inter for inline; IBM Plex Mono for ledger /
  log columns.

Add to `index.html`:

```html
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:wght@500;600&family=IBM+Plex+Mono:wght@400;600&display=swap"
  rel="stylesheet"
/>
```

## Motifs

1. **Larger radii.** `--radius-sm: 6px; --radius-md: 12px; --radius-lg:
   16px;`. Cards: 12px. Buttons: 8px. Popovers/drawer: 16px (drawer keeps
   its outer edge straight against the viewport).
2. **Soft elevation tokens.** Three steps:
   ```css
   --shadow-1: 0 1px 2px rgba(15, 20, 28, 0.06);
   --shadow-2: 0 6px 16px rgba(15, 20, 28, 0.08);
   --shadow-3: 0 16px 40px rgba(15, 20, 28, 0.10);
   ```
3. **Generous spacing.** Card padding `1.25rem 1.5rem`. Section gaps
   `1.25rem`. Inputs at 40–44px tall for comfortable tap targets.
4. **Category-coded left border.** Cards representing entities take a 4px
   left border in the matching category color (`--c-power`,
   `--c-syndicate`, etc.). Pure structural cards stay borderless on the
   left.
5. **Soft pill badges.** `.badge` uses tinted background (`*-soft`) +
   matching darker text + no border. E.g. POWER badge:
   `background: #dfe9e1; color: #2f5a3f;`.
6. **Inline icons.** Lucide / Heroicons for entity types — small (16px),
   stroked, paired with category color. Add a single icon set; theme
   provides the size + color tokens.
7. **Quiet focus ring.** `:focus-visible` uses a 3px sage outline at 35%
   opacity plus a 1px solid sage inner ring — visible but not loud.
8. **Kind microcopy hooks.** Theme reserves space in headings/empty
   states for slightly warmer copy ("Nothing to review yet — you're all
   caught up.") rather than terse defaults. Implementation lives in
   components, but the theme commits visual room for it.

## CSS impact map

- `:root` (`1-28`) — palette + radius + shadow + font tokens; add
  `[data-theme="soft-civic-night"]` block with the dark overrides.
- `body` (`30-42`) — warm off-white bg, slightly cool ink.
- `button` (`53-82`) — sage fill, 8px radius, `padding: 0.625rem 1.1rem`,
  font weight 600, `box-shadow: var(--shadow-1)`. Hover: `--shadow-2`,
  background lightens 4%. Disabled: `opacity: 0.5`.
- `button.secondary` — white fill, 1px sage border, sage text.
- `button.danger` — `--danger` fill.
- `input/textarea/select` (`83-105`) — white fill, 1px `--border`,
  8px radius, `padding: 0.625rem 0.85rem`, focus ring (motif 7).
- `.top-nav` (`120-127`) — white surface with 1px `--border` bottom rule
  (no full-width shadow); active link gets a 2px sage underline.
- `.main-content` (`135-141`) — increase max-width breakpoint padding;
  consider a center column at `max-width: 72ch` for text-heavy pages
  (Profile / Admin info screens).
- `.card` (`161-176`) — white surface, 12px radius, `--shadow-1`,
  optional 4px category-color left border via `.card.entity-power`,
  `.card.entity-drawback`, etc.
- `h2/h3` — Source Serif 4 600 for `h2`; Inter 600 for `h3`. No uppercase.
  `margin-bottom: 0.5rem`.
- `.badge` (`367-393`) — soft pill restyle with category variants
  (`.badge.power`, `.badge.syndicate`, `.badge.drawback`,
  `.badge.minion`).
- `.row-divider` (`178-185`) — `border-bottom: 1px solid var(--border)`
  with extra vertical padding (0.625rem) for breathing room.
- `.power-bar-track/-fill` (`591-601`) — track in `--bg-muted`, fill in
  `--c-power` sage; rounded fully (4px). Optional small label inside the
  fill for high values.
- `.notes-popover` / `.action-popover` / `.drawer` (`484-565`) — white
  surface, 16px radius, `--shadow-3`, increased internal padding
  (`0.875rem 1rem`).
- `.read-only-banner` (`435-442`) — `--bg-muted` fill, `--warning`
  4px left border, mustard icon.
- `table` (`407-423`) — header row in `--bg-muted`, larger row height
  (44px), 1px `--border` rules.

## New utilities

```css
.entity-power     { border-left: 4px solid var(--c-power); }
.entity-syndicate { border-left: 4px solid var(--c-syndicate); }
.entity-drawback  { border-left: 4px solid var(--c-drawback); }
.entity-minion    { border-left: 4px solid var(--c-minion); }
.entity-note      { border-left: 4px solid var(--c-note); }

.badge.power     { background: color-mix(in oklch, var(--c-power) 18%, transparent);
                   color: color-mix(in oklch, var(--c-power) 75%, var(--fg)); }
.badge.syndicate { background: color-mix(in oklch, var(--c-syndicate) 18%, transparent);
                   color: color-mix(in oklch, var(--c-syndicate) 75%, var(--fg)); }
.badge.drawback  { background: color-mix(in oklch, var(--c-drawback) 18%, transparent);
                   color: color-mix(in oklch, var(--c-drawback) 75%, var(--fg)); }
.badge.minion    { background: color-mix(in oklch, var(--c-minion) 18%, transparent);
                   color: color-mix(in oklch, var(--c-minion) 75%, var(--fg)); }

.surface-1 { background: var(--bg-elevated); box-shadow: var(--shadow-1); }
.surface-2 { background: var(--bg-elevated); box-shadow: var(--shadow-2); }
.surface-3 { background: var(--bg-elevated); box-shadow: var(--shadow-3); }

.focus-ring:focus-visible {
  outline: 3px solid color-mix(in oklch, var(--accent) 35%, transparent);
  outline-offset: 2px;
}
```

## Component-level notes

- **HUD (`.game-hud` `241-262`):** white surface, sage 2px bottom rule,
  serif title with phase as a soft sage badge.
- **Power standings:** sage progress bars, syndicate name in serif,
  small mono `+12 / -3` deltas in `--fg-muted`. Leader row gets a
  `--accent-soft` tint background.
- **Drawbacks card:** `.entity-drawback` left border; warm-red drawback
  count badge.
- **Minions list:** `.entity-minion` left border per row; sky badge for
  status.
- **Sign-in (`.sign-in-wrapper` `425-433`):** centered card with
  `--shadow-2`, serif heading "Welcome back", sage CTA, supportive
  helper copy below.
- **Profile / Admin / Lists:** generous spacing, serif H1, Inter body,
  category-coded entity rows.
- **Notes popover:** white surface, `--shadow-3`, mustard `.entity-note`
  left border on each note.

## Theme switching

- Toggle implemented by setting `data-theme` on `<html>`. Persist in
  `localStorage`. Default to `prefers-color-scheme` if unset.
- `[data-theme="soft-civic"]` (light, default) and
  `[data-theme="soft-civic-night"]` (dark) tokens both live in
  `:root`-scoped selectors.

## Accessibility

- All category colors verified against `--bg` and `--bg-elevated`:
  - Sage `#4a7c59` on white ≈ 4.6:1 (pass for body text at ≥ 16px).
  - Terracotta `#c66b4a` on white ≈ 3.4:1 — use only for non-text
    accents (left borders, icons), or pair with darker text token.
  - Indigo `#3d5a8a` on white ≈ 5.9:1 (pass).
  - Sky `#3d7ea6` on white ≈ 4.0:1 — same caveat as terracotta.
  - Mustard `#a07a3a` on white ≈ 4.5:1 (pass).
- Pair every category color with a text label / icon so it isn't the
  sole signal.
- Larger tap targets (≥ 44×44 on phones) — already covered by the new
  button / input padding.
- `prefers-reduced-motion` — limit transitions to 150ms; no decorative
  animations.

## Verification

- [ ] Light + dark themes both pass WCAG AA on body text.
- [ ] Category left-borders coexist with the existing `.card.tight` /
      `.card.flush` modifiers (`src/index.css:169-176`) — verify
      stacking.
- [ ] `color-mix(in oklch, …)` fallbacks for older browsers — provide
      static fallback colors via a build step or duplicate declarations.
- [ ] Increased radii do not break the existing `.notes-popover`
      positioning math (`src/index.css:484-498`).
- [ ] Mobile bottom strip (`.game-bottom-strip` `321-344`) reads as
      consistent with the new card surfaces (white, top hairline,
      `--shadow-3` upward).
- [ ] Empty states have room for warmer microcopy — visual rhythm
      tested with 2-line headlines.

## Out of scope

- Iconography selection / vendoring (do as a separate PR; theme reserves
  size + color hooks).
- Microcopy rewrite across screens.
- Internationalization typography tweaks (Source Serif 4 has good
  Latin/Cyrillic; CJK would need a different stack).
