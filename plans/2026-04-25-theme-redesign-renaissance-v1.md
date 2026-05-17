# Theme Redesign — Renaissance Court / Illuminated Ledger (v1)

## Concept

Medici-era power play. Heavy, ornate, expensive-feeling. The app reads as a
gilded ledger from a banking dynasty: parchment surfaces, oxblood rules,
gilt accents, drop-caps, wax-seal status, and small-caps headings. Plays
naturally against the existing vocabulary ("syndicate", "drawback",
"power", "ledger").

## Palette

Replace `:root` (`src/index.css:1-28`):

| Token           | Value     | Role                                |
| --------------- | --------- | ----------------------------------- |
| `--bg`          | `#f3ead3` | Parchment                           |
| `--bg-elevated` | `#fbf3dc` | Vellum card                         |
| `--bg-muted`    | `#e8dcb8` | Aged inset                          |
| `--fg`          | `#1c1209` | Iron-gall ink                       |
| `--fg-muted`    | `#6a553a` | Faded ink                           |
| `--border`      | `#b8893a` | Gilt rule                           |
| `--accent`      | `#5a1a1a` | Oxblood — primary action            |
| `--accent-fg`   | `#fbf3dc` | Vellum on oxblood                   |
| `--gilt`        | `#b8893a` | Gold leaf accents                   |
| `--gilt-bright` | `#d8a955` | Highlight gilt                      |
| `--verdigris`   | `#2f5a4f` | Secondary accent — success / sealed |
| `--lapis`       | `#1d3a5f` | Tertiary accent — info              |
| `--danger`      | `#7a1410` | Deep oxblood                        |
| `--success`     | `#2f5a4f` | Verdigris                           |
| `--warning`     | `#a8741a` | Aged amber                          |

## Typography

```css
:root {
  --font-body: "EB Garamond", "Cormorant Garamond", "Georgia", serif;
  --font-display: "Cinzel", "Trajan Pro", "EB Garamond", serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
}
```

- Body: 16.5px Garamond, line-height 1.6, slightly increased letter-spacing
  (`0.005em`) for readability at that size.
- Headings: Cinzel small-caps, `letter-spacing: 0.08em`, weight 500–600.
- Numerals in tables/ledger: monospaced _and_ tabular for currency-like
  alignment (`font-feature-settings: "tnum" 1;`).
- Drop caps on the first paragraph of each card via `::first-letter`
  (font-size: 3em; float: left; line-height: 0.85; padding-right: 0.4rem;
  color: var(--accent); font-family: var(--font-display);).

Add to `index.html`:

```html
<link
  href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,600;1,400&family=Cinzel:wght@500;600&family=IBM+Plex+Mono:wght@400;600&display=swap"
  rel="stylesheet"
/>
```

## Motifs

1. **Gilded double rules.** Cards use a 1px solid + 1px solid offset border
   in `--gilt` (via `border` + `outline-offset: 2px; outline: 1px solid
var(--gilt);`). Reads as a hand-illuminated frame.
2. **Drop caps.** First paragraph of every `.card` body gets a Cinzel
   drop cap in oxblood.
3. **Small-caps section headers.** `h2/h3` rendered in Cinzel with
   `font-variant: small-caps;` and a centered `· · CHAPTER · ·` prefix
   utility for major sections.
4. **Wax-seal badges.** `.badge` becomes a circular seal: 28px circle,
   gilt 2px ring, oxblood fill, white embossed initial. Used for
   syndicate sigils and rank markers. Non-circular variants keep a
   parchment-strip look (rounded ends, ribbon notches via `clip-path`).
5. **Ribbon banners.** A `.ribbon` utility renders an oxblood banner with
   pointed/notched ends used for the HUD title and major callouts.
6. **Decorative corner flourishes.** SVG fleurons placed via
   `background-image` in the corners of `.drawer` and the sign-in card
   (small, ~24px, gilt color, low opacity).
7. **Filigree dividers.** `.row-divider` becomes a centered ornament line:
   `· ❦ ·` glyph in `--gilt-muted` flanked by hairline rules.
8. **Quill cursor on text inputs.** `caret-color: var(--accent);` and a
   slight `:focus` ring glow in oxblood.

## CSS impact map

- `:root` (`1-28`) — palette + serif font stack + new tokens (`--gilt`,
  `--verdigris`, `--lapis`).
- `body` (`30-42`) — parchment background; optional fixed pseudo-element
  for a faint paper-fiber SVG at 4% opacity.
- `button` (`53-82`) — oxblood fill, vellum text, Cinzel small-caps,
  `padding: 0.55rem 1.1rem`, `border-radius: 3px`, gilt 1px hairline
  border, `box-shadow: inset 0 -1px 0 rgba(0,0,0,0.2);`. Hover: brighten
  to a slightly lighter oxblood.
- `button.secondary` — vellum fill, oxblood text, gilt border.
- `input/textarea/select` (`83-105`) — vellum fill, gilt 1px border,
  serif font inherited, `border-radius: 3px`.
- `.top-nav` (`120-127`) — vellum strip with a gilt double rule below
  (top: 1px solid `--gilt`, then a 2px gap, then the card). Title in
  Cinzel.
- `.card` (`161-176`) — vellum surface, double-rule border, generous
  `padding: 1.25rem 1.5rem`. Heading area separated by a centered
  ornament rule.
- `h2/h3` — Cinzel, small-caps, `--accent` color for `h2`, `--fg` for
  `h3`. Add an underline via `border-bottom: 1px solid var(--gilt);
padding-bottom: 0.4rem;`.
- `.badge` (`367-393`) — restyle to wax-seal variants.
- `.row-divider` (`178-185`) — replace plain rule with the fleuron
  divider utility.
- `.power-bar-track/-fill` (`591-601`) — track in `--bg-muted`, fill in
  oxblood with a 1px gilt top-edge highlight (`box-shadow: inset 0 1px 0
var(--gilt-bright);`).
- `.drawer` / `.notes-popover` / `.action-popover` (`484-565`) —
  vellum surfaces, gilt double-rule borders, soft shadow
  `0 12px 32px rgba(28,18,9,0.18)`, corner fleurons via background
  images.
- `table` (`407-423`) — `th` in Cinzel small-caps, `--gilt` bottom rule,
  banded rows in `--bg-muted` at 40% opacity.

## New utilities

```css
.ribbon {
  display: inline-block;
  background: var(--accent);
  color: var(--accent-fg);
  font-family: var(--font-display);
  font-variant: small-caps;
  letter-spacing: 0.08em;
  padding: 0.35rem 1.25rem;
  clip-path: polygon(
    8px 0,
    calc(100% - 8px) 0,
    100% 50%,
    calc(100% - 8px) 100%,
    8px 100%,
    0 50%
  );
}
.fleuron-rule {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--gilt);
}
.fleuron-rule::before,
.fleuron-rule::after {
  content: "";
  flex: 1;
  border-top: 1px solid var(--gilt);
}
.fleuron-rule::after {
  content: "";
}
.fleuron-rule .glyph::before {
  content: "❦";
}
.dropcap::first-letter {
  font-family: var(--font-display);
  font-size: 3.2em;
  float: left;
  line-height: 0.85;
  padding: 0.1em 0.3rem 0 0;
  color: var(--accent);
}
.seal {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-fg);
  border: 2px solid var(--gilt);
  font-family: var(--font-display);
  display: inline-grid;
  place-items: center;
  font-size: 0.75rem;
  letter-spacing: 0;
}
.smallcaps {
  font-variant: small-caps;
  letter-spacing: 0.06em;
}
```

## Component-level notes

- **HUD (`.game-hud` `241-262`):** title wrapped in `.ribbon`; phase shown
  as a wax seal on the right (`.seal` with the phase initial).
- **Power standings:** rank as Roman numerals (`I`, `II`, `III`); each
  syndicate gets a colored `.seal` sigil; bar fill in oxblood.
- **Drawbacks card:** heading prefixed by `· · DRAWBACKS · ·` fleuron rule;
  list items with `❦` bullets in `--gilt`.
- **Minions list:** each minion as a small parchment strip card with a
  `.seal` initial and Cinzel name.
- **Ledger entries (transfer / power transactions):** monospace numerals,
  oxblood `DR` / verdigris `CR` small-caps tags, gilt hairline between
  rows.
- **Sign-in (`.sign-in-wrapper` `425-433`):** vellum card with corner
  fleurons, ribbon title "Letters of Introduction", oxblood CTA.
- **Notes popover:** each note as a folded-letter visual; date in Roman
  numerals optional gimmick (toggle off if it hurts scanability).

## Accessibility

- Verify oxblood `#5a1a1a` on parchment `#f3ead3` ≥ 7:1 (passes — it's
  ~9:1).
- Drop caps: ensure `::first-letter` doesn't break screen-reader flow
  (it doesn't — character is part of the same text node).
- Roman numerals only as decoration; underlying data stays Arabic for
  sort order and assistive tech (use `aria-label` on the rendered
  numeral if it's the only readable indicator).
- Avoid pure-color status conveyance; pair verdigris/oxblood with
  text labels (`SEALED`, `VOID`).

## Verification

- [ ] Garamond renders correctly on Linux/Windows/macOS — fall back to
      Georgia gracefully.
- [ ] Drop caps don't overflow on narrow cards (cap with `min-width`
      check or disable below 360px).
- [ ] Gilt double-rule borders survive zoom (they do — they're CSS
      borders, not images).
- [ ] Print stylesheet looks correct as a printed ledger (already does
      with this palette).
- [ ] All seal/ribbon clip-paths fall back to rectangles in unsupported
      browsers (graceful — they just become squares).

## Out of scope

- Hand-drawn SVG fleurons / illuminated initials beyond a small set.
- Custom marbled-paper backgrounds (heavy assets; consider as opt-in).
- Latin flavor text (could be added to empty states later).
