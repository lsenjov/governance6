# Theme Redesign — Cyber-Bureaucracy / Deus Ex (v1)

## Concept

A 2040s shadow-government console: the look of a surveillance-state HUD that
also has to file paperwork. Angular clipped corners, cyan data displays,
hazard-amber alerts, glowing focus, ID-coded entities (`SYN-04A2`), faint
grid backdrop, and a single rare magenta accent reserved for high-severity
warnings.

## Palette

Replace `:root` (`src/index.css:1-28`):

| Token             | Value      | Role                                  |
| ----------------- | ---------- | ------------------------------------- |
| `--bg`            | `#080a0c`  | Near-black                            |
| `--bg-elevated`   | `#0e141a`  | Panel                                 |
| `--bg-muted`      | `#121a22`  | Inset                                 |
| `--bg-grid`       | `#0c1218`  | Grid line color (very dim)            |
| `--fg`            | `#d8e6f0`  | Cool white text                       |
| `--fg-muted`      | `#6a8090`  | Secondary                             |
| `--border`        | `#1f2c38`  | Hairline panel                        |
| `--accent`        | `#00e5ff`  | Cyan — data, primary action           |
| `--accent-fg`     | `#001016`  | Inverted text on cyan                 |
| `--accent-glow`   | rgba(0,229,255,0.35) | For shadow glows           |
| `--hazard`        | `#ffb000`  | Amber alerts / warnings               |
| `--alert`         | `#ff2bd6`  | Magenta — rare, severe                |
| `--success`       | `#00ffa0`  | Mint — confirms                       |
| `--danger`        | `#ff4a4a`  | Red — destructive                     |
| `--warning`       | `#ffb000`  | Same as hazard                        |
| `--id-mono`       | `#9bb4c4`  | Entity ID color                       |

## Typography

```css
:root {
  --font-body: "Inter", "Rajdhani", system-ui, sans-serif;
  --font-display: "Rajdhani", "Orbitron", "Inter", sans-serif;
  --font-mono: "JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace;
}
```

- Body: 14px Inter, line-height 1.5.
- Display: Rajdhani 600/700, ALL CAPS for `h1/h2`, `letter-spacing: 0.08em`.
  (Orbitron is an alternative if a more "sci-fi" feel is wanted; Rajdhani
  is more legible.)
- Mono: JetBrains Mono for IDs, timestamps, numerics.

Add to `index.html`:

```html
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Rajdhani:wght@500;600;700&family=JetBrains+Mono:wght@400;600&display=swap"
  rel="stylesheet"
/>
```

## Motifs

1. **Clipped angular corners.** Define `--clip` once and apply to cards,
   buttons, popovers, the drawer:
   ```css
   --clip: polygon(
     0 0, calc(100% - 12px) 0, 100% 12px,
     100% 100%, 12px 100%, 0 calc(100% - 12px)
   );
   ```
   Replaces `border-radius` for the major surfaces. Border can't be drawn
   on clip-path; use a `::before` 1px-inset background-clip trick or drop
   the border entirely and rely on surface contrast.
2. **Grid background.** Subtle 32px grid on `body`:
   `background:
     linear-gradient(var(--bg-grid) 1px, transparent 1px) 0 0/32px 32px,
     linear-gradient(90deg, var(--bg-grid) 1px, transparent 1px) 0 0/32px 32px,
     var(--bg);`. Layered below content; never on top.
3. **Glowing focus.** Replace outlines with cyan rings:
   `box-shadow: 0 0 0 1px var(--accent), 0 0 16px var(--accent-glow);`.
4. **HUD scan-line.** A 1px animated gradient bar travels horizontally
   across `.game-hud` once on mount, then settles. Honor
   `prefers-reduced-motion` to disable.
5. **Entity IDs.** Every syndicate / minion / drawback rendered with a
   short mono ID next to its name (`SYN-04A2`, `MIN-1F`, `DRW-7C`).
   This is data-driven; theme provides the styling utility.
6. **Holographic active nav.** The active route in `.top-nav` gets a
   conic-gradient text fill or a cyan-to-magenta linear gradient text:
   `background-clip: text; -webkit-text-fill-color: transparent;`.
7. **Hazard stripes.** Warning banners and the read-only banner get a
   1px top/bottom edge in `repeating-linear-gradient(45deg, hazard 0 8px,
   transparent 8px 14px)`.
8. **Severity language.** Three severities, three accents: cyan
   (informational / default), hazard (warning), magenta (critical). Use
   magenta sparingly — at most one element on screen at a time.

## CSS impact map

- `:root` (`1-28`) — palette + clip variable + font tokens.
- `body` / `html` (`30-42`) — grid background, dark fg, font stack.
- `button` (`53-82`) — cyan fill, dark fg, clipped corners (`clip-path:
  var(--clip);`), uppercase Rajdhani label, `padding: 0.55rem 1rem`.
  Hover: brighter cyan + glow shadow. Active: -1px translate.
- `button.secondary` — transparent fill, cyan text, 1px cyan border (no
  clip-path so the border renders cleanly).
- `button.danger` — red fill; magenta is reserved for critical alerts
  only.
- `input/textarea/select` (`83-105`) — `background: var(--bg-muted);
  border: 1px solid var(--border); color: var(--fg); border-radius: 2px;`
  Focus: glow ring (motif 3).
- `.top-nav` (`120-127`) — panel surface with a cyan 1px bottom rule,
  uppercase Rajdhani link labels, mono session ID on the right
  (`OPERATOR: <user-id>`).
- `.card` (`161-176`) — panel surface, clipped corners, 1px hairline
  border in `--border`, optional cyan top accent rule for active state.
- `h2/h3` — Rajdhani 600, uppercase, `letter-spacing: 0.08em`.
- `.badge` (`367-393`) — clipped angular pill (`clip-path` variant for a
  hex/parallelogram look), fills tied to severity tokens.
- `.power-bar-track/-fill` (`591-601`) — track with a 1px cyan glow
  border, fill as a cyan→mint gradient with a subtle moving sheen
  animation (gated on reduced-motion).
- `.notes-popover` / `.action-popover` / `.drawer` (`484-565`) — clipped
  corners (where feasible — drawer keeps a straight edge), panel
  background, cyan 1px accent strip on the active edge, drop the heavy
  blur shadow and use a cyan glow shadow instead.

## New utilities

```css
.clipped       { clip-path: var(--clip); }
.glow-cyan     { box-shadow: 0 0 0 1px var(--accent), 0 0 16px var(--accent-glow); }
.id-tag        { font-family: var(--font-mono); font-size: 0.75rem;
                 color: var(--id-mono); letter-spacing: 0.04em; }
.holo-text     { background: linear-gradient(90deg, var(--accent), var(--alert));
                 -webkit-background-clip: text; background-clip: text;
                 -webkit-text-fill-color: transparent; color: transparent; }
.hex-badge     { clip-path: polygon(8% 0, 92% 0, 100% 50%, 92% 100%, 8% 100%, 0 50%); }
.severity-info { background: var(--accent); color: var(--accent-fg); }
.severity-warn { background: var(--hazard); color: #100a00; }
.severity-crit { background: var(--alert);  color: #170016; }
.hazard-stripe {
  background: repeating-linear-gradient(45deg,
    var(--hazard) 0 8px, transparent 8px 14px);
}
.hud-scan::before {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, var(--accent-glow),
                              transparent);
  animation: scan 2.4s ease-out 1;
}
@keyframes scan { from { transform: translateX(-100%); }
                  to   { transform: translateX(100%); } }
```

## Component-level notes

- **HUD (`.game-hud` `241-262`):** position-relative + `.hud-scan` overlay
  on mount; title `[ GAME // <id> ]` in Rajdhani caps; phase as a hex
  badge; turn counter in mono with a faint cyan underline.
- **Power standings:** rows show `SYN-04A2  ALPHA_HOUSE  [▓▓▓▓▓▓▓▓░░] 80`
  with the bar in cyan, leader getting a 1px cyan glow on the row.
- **Drawbacks:** amber clipped badge `[ HAZARD ]` and a 1px hazard top
  border on the card.
- **Sign-in (`.sign-in-wrapper` `425-433`):** "OPERATOR AUTHENTICATION"
  header in Rajdhani caps; cyan CTA `[ AUTHENTICATE ]`; small mono
  build/version line in the footer.
- **Read-only banner (`.read-only-banner` `435-442`):** swap to
  `.severity-warn` fill plus `.hazard-stripe` 4px top edge.
- **Notes popover:** timestamps in mono cyan, body in Inter; entries
  prefixed by `>>`.

## Accessibility

- Cyan `#00e5ff` on `#080a0c` ≈ 13:1 — fine. Magenta `#ff2bd6` on
  `#080a0c` ≈ 7:1 — fine for text but only used on small badges.
- Provide a `[data-theme="cyber-flat"]` toggle that disables grid,
  glows, and animations for users who find the chrome distracting.
- Honor `prefers-reduced-motion`: disable HUD scan, bar sheen, and any
  `transition` longer than 120ms.
- Do not rely on glow alone for focus — keep the 1px ring as the
  primary indicator.
- Hex/clipped corners are decorative; ensure semantic `<button>` /
  `<a>` elements still render hit areas correctly (clip-path doesn't
  affect hit testing).

## Verification

- [ ] Grid background does not paint over content (z-index correct).
- [ ] All clipped surfaces still respond to clicks across the entire
      visual area (clip-path crops paint, not events — verify on the
      drawer/popover edges).
- [ ] Glow shadows don't cause horizontal scroll on mobile (no shadow
      offsets larger than 24px; viewport overflow hidden where needed).
- [ ] Magenta usage audit: target ≤ 2 elements visible at once.
- [ ] Reduced-motion path verified — no `scan` animation, no bar
      sheen, transitions ≤ 120ms.
- [ ] Print stylesheet falls back to flat panels (no glows, no grid).

## Out of scope

- Animated background particles / parallax — explicitly avoided to keep
  the look corporate-grade rather than gamey.
- 3D / WebGL chrome.
- Sound design.
