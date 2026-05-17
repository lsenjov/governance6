# Theme Redesign — Dossier / Redacted Files (v1)

## Concept

The app _is_ a confidential intelligence file. Every screen feels like a manila
folder pulled from a cabinet: typewritten body copy, rubber-stamp badges,
red-string accents, paper grain, and `[REDACTED]` blocks for sensitive fields.
The "governance / syndicate / drawback" vocabulary already in the data model
maps directly onto the metaphor.

## Palette

Semantic tokens (replace `:root` block in `src/index.css:1-28`):

| Token           | Value     | Role                               |
| --------------- | --------- | ---------------------------------- |
| `--bg`          | `#e8dcc4` | Manila folder body                 |
| `--bg-elevated` | `#f1e7d2` | Document / card surface            |
| `--bg-muted`    | `#dccfb3` | Inset fields, table stripes        |
| `--fg`          | `#1a1612` | Ink                                |
| `--fg-muted`    | `#6b6357` | Faded carbon copy                  |
| `--border`      | `#a89a7a` | Hairline document rule             |
| `--accent`      | `#a3201d` | CLASSIFIED red — links, focus      |
| `--accent-fg`   | `#f1e7d2` | Stamp text on red                  |
| `--stamp-blue`  | `#1d3a5f` | Secondary stamps (FILED, RECEIVED) |
| `--danger`      | `#a3201d` | Same as accent                     |
| `--success`     | `#3f6b3a` | Olive approval ink                 |
| `--warning`     | `#b8893a` | Aged-tape amber                    |

## Typography

```css
:root {
  --font-body: "Special Elite", "Courier Prime", "JetBrains Mono", monospace;
  --font-display: "Bebas Neue", "Oswald", "Impact", sans-serif;
  --font-stamp: "Stardos Stencil", "Bebas Neue", sans-serif;
}
```

- Body copy: typewriter, 15px, line-height 1.55.
- Headings (`h1..h3`): condensed display, uppercase, tracked `0.04em`.
- Numerals in tables/ledger: tabular-nums on the typewriter face.

Add to `index.html`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link
  href="https://fonts.googleapis.com/css2?family=Special+Elite&family=Bebas+Neue&family=Stardos+Stencil:wght@400;700&display=swap"
  rel="stylesheet"
/>
```

## Motifs

1. **Paper grain.** A fixed `body::before` overlay using an inline SVG noise
   filter at ~6% opacity, `pointer-events: none`, `z-index: -1`.
2. **Folder tabs.** `.card` gets `border-radius: 0 10px 0 0` plus a 4px top
   accent strip in `--accent`, mimicking a tabbed file divider.
3. **Rubber stamps.** `.badge` becomes a stamped impression: stencil font,
   double 2px border in `--accent`, `transform: rotate(-3deg)`, slight
   `letter-spacing` and `opacity: 0.9`. Variants: `CLASSIFIED`, `EYES ONLY`,
   `FILED`, `VOID`.
4. **Dotted leaders.** Replace `border-bottom` rules in tables and
   `.row-divider` (`src/index.css:178-185`, `412-417`) with
   `border-bottom: 1px dashed var(--border)`.
5. **Redaction blocks.** Utility class `.redact` renders text as a solid
   `--fg` bar; on hover or `.revealed` it fades back. Useful for hiding
   opponent syndicate details.
6. **Red string.** The `.power-bar-fill` becomes a thin red thread (2–3px) with
   small "pin" circles at each end instead of a solid bar.
7. **Carbon-copy duplicates.** Important confirmations show a faint duplicate
   text shadow offset 1px right / 1px down in `--fg-muted` at 30% opacity.

## CSS impact map

Concrete edits to `src/index.css:1-651`:

- `:root` (`1-28`) — swap palette + add font tokens.
- `body` / `html` (`30-42`) — set `background: var(--bg)`, add the noise
  pseudo-element.
- `button` (`53-66`) — switch to `--accent` red, square-ish corners
  (`border-radius: 2px`), uppercase stencil label, no gradient.
- `button.secondary` (`73-77`) — outlined ink button on paper.
- `input/textarea/select` (`83-105`) — paper-inset look:
  `background: var(--bg-muted); border-bottom: 1px solid var(--fg);
border-radius: 0;` (form-on-form style).
- `.top-nav` (`120-127`) — taller bar styled as a file header strip with
  a dotted bottom rule and a `FILE №` field on the left.
- `.card` (`161-176`) — folder-tab corners, faint inner shadow, top
  accent strip via `::before`.
- `.badge` and variants (`367-393`) — full restyle as stamps (see motifs).
- `.power-bar-track` / `-fill` (`591-601`) — thread + pin variant.
- `.notes-popover`, `.action-popover`, `.drawer` (`484-565`) — tinted-paper
  surfaces with a `.drawer` left edge styled as a "tear strip" using a
  `repeating-linear-gradient` border-image.

## New utilities

```css
.stamp {
  /* generic stamped label */
}
.stamp.classified {
  color: var(--accent);
  border-color: var(--accent);
}
.stamp.eyes-only {
  color: var(--stamp-blue);
  border-color: var(--stamp-blue);
}
.redact {
  background: var(--fg);
  color: transparent;
  border-radius: 1px;
}
.redact.revealed {
  background: transparent;
  color: inherit;
}
.dotted-rule {
  border-bottom: 1px dashed var(--border);
}
.file-tab {
  /* card with folder-tab corner */
}
.carbon {
  text-shadow: 1px 1px 0 rgba(26, 22, 18, 0.25);
}
```

## Component-level notes

- **HUD (`.game-hud` `241-262`):** prefix the title with `FILE №` and a
  zero-padded id, stamp the current phase as a rotated badge on the right.
- **Power standings:** rank rows as `01`, `02`, … with carbon-copy numerals;
  red-thread bars; small `[CLASSIFIED]` stamp next to opponent names while
  hidden info is in play.
- **Ledger entries:** dotted-leader rows, right-aligned tabular numerals,
  `CR` / `DR` stamps.
- **Sign-in (`.sign-in-wrapper` `425-433`):** styled as a clearance request
  form with a stamped "PENDING" until submitted, then "APPROVED".

## Verification

- [ ] All text contrast ≥ 4.5:1 on `--bg` and `--bg-elevated` (manila + ink
      passes; verify red on manila — may need `#8a1a17` for body text use).
- [ ] Stamp badges remain legible at 12px and don't break flex row heights
      due to rotation (use `transform-origin: center` and reserve space).
- [ ] Noise overlay is GPU-friendly (single fixed element, not repeated
      backgrounds on every card).
- [ ] Print stylesheet looks _correct_ with this theme — bonus: it already
      reads as a printout.
- [ ] Dark mode opt-out via `[data-theme="dossier-night"]` using a
      desk-lamp palette (`#2a241b` paper, `#e8dcc4` ink).

## Out of scope

- Iconography overhaul (separate pass).
- Animation system beyond stamp hover.
- Per-entity color coding (handled in the cross-cutting token PR).
