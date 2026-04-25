# Theme Redesign — Terminal / Sysop Console (v1)

## Concept

You administer the syndicate from a green-phosphor CRT. Everything is monospace,
bordered with ASCII box-drawing, and gently scanlined. Power bars render as
character fills, prompts have blinking carets, and the whole UI reads like
`gov://syndicate/edit >`. Cheap to ship (mostly fonts + colors + a single
overlay), maximum identity payoff.

## Palette

Replace `:root` (`src/index.css:1-28`):

| Token             | Value      | Role                                |
| ----------------- | ---------- | ----------------------------------- |
| `--bg`            | `#020a02`  | CRT black with green tint           |
| `--bg-elevated`   | `#061206`  | Panel surface                       |
| `--bg-muted`      | `#0a1a0a`  | Inset / inactive                    |
| `--fg`            | `#22ff88`  | Phosphor green                      |
| `--fg-muted`      | `#3a8a55`  | Dim phosphor                        |
| `--fg-bright`     | `#a8ffc8`  | Highlighted text                    |
| `--border`        | `#1f5a32`  | Grid line                           |
| `--accent`        | `#22ff88`  | Same as fg — focus is via glow      |
| `--accent-fg`     | `#020a02`  | Inverted block on hover/active      |
| `--warning`       | `#ffb300`  | Amber alerts                        |
| `--danger`        | `#ff4040`  | Critical                            |
| `--success`       | `#22ff88`  | OK                                  |
| `--cursor`        | `#22ff88`  | Blinking caret                      |

Optional alt palette: amber (`#ffb000` on `#0c0703`) for a Plan-9 vibe —
toggle via `[data-theme="terminal-amber"]`.

## Typography

```css
:root {
  --font-body: "JetBrains Mono", "IBM Plex Mono", "Fira Code", ui-monospace,
               monospace;
  --font-display: "VT323", "JetBrains Mono", monospace;
}
* { font-family: var(--font-body); font-feature-settings: "calt" 0; }
```

- 14px body, line-height 1.45.
- Headings use `VT323` at 1.5–2x size for a deliberately chunky CRT feel
  (or stay on JetBrains Mono Bold if `VT323` feels too kitsch).
- Tabular numerals everywhere (it's monospace — free).

Add to `index.html`:

```html
<link
  href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=VT323&display=swap"
  rel="stylesheet"
/>
```

## Motifs

1. **Scanlines.** Fixed `body::after` with
   `background: repeating-linear-gradient(to bottom, transparent 0 2px,
   rgba(0,0,0,0.18) 2px 3px); pointer-events: none; z-index: 9999;`.
   Optionally a faint vignette via radial gradient on `body::before`.
2. **ASCII box borders.** A `.box` utility renders cards using
   `border-image` of a 9-slice SVG with `╭─╮ │ ╰─╯` glyphs, OR (simpler)
   a styled `::before` line with the corner glyphs and `border-top: 1px`.
   Recommended path: simple `border: 1px solid var(--border)` and a
   `::before` of `"╭" + dashes + "╮"` only on `.box.titled`.
3. **Prompts.** All headings prefixed by `> ` rendered as `::before`. The
   active section gets a blinking caret `▮` after the title.
4. **Glowing focus.** No outlines; `:focus-visible` adds
   `box-shadow: 0 0 0 1px var(--fg), 0 0 12px rgba(34,255,136,0.6);`.
5. **Character power bars.** `.power-bar-track` becomes a styled `<span>`
   filled with `█` and `░` characters via JS or a CSS-only approach using
   `background: repeating-linear-gradient(...)` clipped to `width: var(--p)`.
   Display label: `[████████░░] 80%`.
6. **Status pills as bracket text.** `.badge` renders as `[ACTIVE]`,
   `[FILED]`, `[!! WARN !!]` — no fill, just colored mono text.
7. **Path-like nav.** Top nav reads like a path: `gov://games / SYN-04A2 /
   edit`. Each segment is a link with `:hover { color: var(--fg-bright); }`.
8. **Command bar.** Optional bottom dock pseudo-prompt `gov> _` that, on
   focus, accepts slash commands (`/transfer`, `/note`, `/end-phase`) —
   future enhancement, not required for the theme PR.

## CSS impact map

- `:root` (`1-28`) — palette + monospace stack.
- `body` / `html` (`30-42`) — black bg, phosphor color, add scanline overlay
  and optional CRT curvature via `transform: perspective(...)` (skip on
  `prefers-reduced-motion`).
- `button` (`53-82`) — `background: transparent; color: var(--fg); border:
  1px solid var(--fg); padding: 0.4rem 0.75rem; text-transform: uppercase;
  letter-spacing: 0.06em;`. Hover inverts (`background: var(--fg);
  color: var(--bg);`). Label format: `[ EXECUTE ]` on primary CTAs.
- `input/textarea/select` (`83-105`) — `background: var(--bg-muted);
  border: 1px solid var(--border); border-radius: 0; color: var(--fg);
  caret-color: var(--cursor);` Add a `::before` `> ` prompt on focused
  text inputs via a wrapper.
- `.top-nav` (`120-127`) — single hairline bottom border, path-style links,
  uptime/clock readout in `--fg-muted` on the right.
- `.card` (`161-176`) — `border: 1px solid var(--border); border-radius: 0;
  background: var(--bg-elevated);` plus optional `.box.titled` ASCII corners
  for emphasized cards (HUD, power standings).
- `.badge` (`367-393`) — bracket-text restyle (no fill, no border).
- `.power-bar-track` / `-fill` (`591-601`) — character fill (see motif 5).
  Keep DOM the same; restyle visually so React code is untouched.
- `.notes-popover` / `.action-popover` / `.drawer` (`484-565`) — black
  surfaces with dashed `1px var(--border)` borders, no blur shadow, optional
  glow shadow `0 0 24px rgba(34,255,136,0.15)`.
- `table` (`407-423`) — header row `text-transform: uppercase` with
  `border-bottom: 1px dashed var(--border)`.

## New utilities

```css
.box        { border: 1px solid var(--border); padding: 0.75rem 1rem; }
.box.titled { position: relative; padding-top: 1.25rem; }
.box.titled::before {
  content: "╭─ " attr(data-title) " ─╮";
  position: absolute; top: -0.6rem; left: 0.5rem;
  background: var(--bg); padding: 0 0.4rem;
  font-family: var(--font-body); color: var(--fg-muted);
}
.prompt::before { content: "> "; color: var(--fg-muted); }
.caret::after   { content: "▮"; animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.tag-bracket    { color: var(--fg); }
.tag-bracket.warn  { color: var(--warning); }
.tag-bracket.crit  { color: var(--danger); }
.bar-chars { font-family: var(--font-body); letter-spacing: 0; }
```

## Component-level notes

- **HUD (`.game-hud` `241-262`):** title rendered as
  `gov://game/<id> [phase: 03] [turn: 12] ▮`.
- **Power standings:** `01. SYNDICATE_NAME [████████░░] 80% (POWER 12)`.
- **Drawbacks:** prefixed with `! ` in amber.
- **Notes popover:** styled as a chat log with `[<timestamp>] <user>:` lines.
- **Sign-in (`.sign-in-wrapper` `425-433`):** boot-screen aesthetic —
  ASCII art logo at top, `login: ▮` prompt, `[ AUTHENTICATE ]` button.
- **Loading state (`.centered-loader` `153-159`):** show
  `loading [▰▰▰▱▱▱▱]` cycling via CSS animation.

## Accessibility

- Pure-green-on-black fails some tritanopia tests; provide a high-contrast
  setting that bumps `--fg` to `#a8ffc8` and dims scanlines.
- Honor `prefers-reduced-motion`: disable caret blink and scanline scroll.
- All focus rings stay glow + 1px ring (visible without color).
- Keep an a11y escape hatch: `[data-theme="terminal-hc"]` removes scanline
  overlay entirely.

## CSS impact summary

Touch points in `src/index.css:1-651`:

- `1-28` palette + fonts.
- `30-66` body + button.
- `83-105` inputs.
- `114-159` shell + nav + main.
- `161-185` card + dividers.
- `367-405` badges + status text.
- `407-423` tables.
- `484-565` popovers + drawer.
- `583-601` power bars.

Estimated diff size: **moderate** (most changes are in tokens; structural
CSS stays). Total new CSS for utilities: ~80 lines.

## Verification

- [ ] Scanline overlay does not block clicks (`pointer-events: none`).
- [ ] Caret blink respects `prefers-reduced-motion`.
- [ ] Contrast ≥ 7:1 (phosphor green on near-black easily passes).
- [ ] Character power bars render correctly with the chosen mono font (no
      gaps between `█` glyphs — JetBrains Mono is fine).
- [ ] Print stylesheet falls back to plain ink (drop scanlines + glows).
- [ ] No layout shift caused by `::before` prompts on headings.

## Out of scope

- Slash-command bar implementation (mentioned as a future hook).
- CRT screen-curvature transform (toggleable extra; ships off by default).
- Sound effects (key clicks, modem dial-up) — separate proposal.
