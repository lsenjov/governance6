/**
 * RollSetDisplay — GM-only dice readout.
 *
 * Two render variants:
 *
 *   - `stacked` (default) — the original brutalist square cells
 *     (Skill, Chaos, extras), each a caption over a big mono numeral
 *     over an optional footer + Pass/Fail badge. Used by the Current
 *     Call section, minion detail, and the GM Todo drawer.
 *   - `terminal` — design 19: inline mono text for the note's
 *     terminal prefix bar (`skill 7/4 OK  chaos 5  drw 3 FAIL`). The
 *     component returns a bare fragment of `.term-stat` spans; the
 *     caller wraps them in the `.note-terminal-bar` strip. Result is
 *     shown as an OK / FAIL word, coloured for legibility on the bar's
 *     black background.
 *
 * Universal natural-1 rule (defence-in-depth): the helper writes the
 * derived `*Result` fields at insert time, but this component
 * re-derives them on render so any historical row, or any future code
 * path that bypasses the helper, still highlights a 1 as a failure.
 * The chaos die additionally reads a natural-6 as a success at render
 * time (see `chaosEffective`).
 *
 * Visibility is enforced server-side: non-GM viewers never receive
 * the `rolls` payload, so the component never renders for them.
 */

import type { ReactNode } from "react";

export type RollExtra = {
  kind: string;
  name: string;
  value: number;
  result?: "success" | "failure";
};

export type RollSet = {
  skillRoll: number;
  skillCount: number;
  skillResult: "success" | "failure";
  chaosRoll: number;
  chaosResult: "success" | "failure" | null;
  extras: RollExtra[];
};

type Size = "sm" | "md";

type Variant = "stacked" | "terminal";

type Effective = "failure" | "success" | "neutral";

/** Re-applies the natural-1 rule and folds in the persisted result. */
function effective(
  value: number,
  stored: "success" | "failure" | null | undefined,
): Effective {
  if (value === 1) return "failure";
  if (stored === "failure") return "failure";
  if (stored === "success") return "success";
  return "neutral";
}

/**
 * Chaos-specific effective result. Same natural-1 failure rule as
 * `effective`, plus a render-time natural-6 → success rule: a chaos
 * die showing its max value reads as a success (mint OK) even though
 * the data layer leaves `chaosResult` unscored for 2..6. Kept as a
 * display rule so the persisted shape (chaos scored only on a 1) is
 * untouched.
 */
function chaosEffective(
  value: number,
  stored: "success" | "failure" | null | undefined,
): Effective {
  if (value === 1) return "failure";
  if (value === 6) return "success";
  return effective(value, stored);
}

function cellClassName(size: Size, result: Effective): string {
  const parts = ["roll-cell"];
  if (size === "sm") parts.push("sm");
  if (result === "failure") parts.push("failure");
  else if (result === "success") parts.push("success");
  return parts.join(" ");
}

function ResultBadge({ result }: { result: Effective }) {
  if (result === "failure") {
    return <span className="roll-cell-badge fail">Fail</span>;
  }
  if (result === "success") {
    return <span className="roll-cell-badge pass">Pass</span>;
  }
  return null;
}

/** One inline stat for the terminal bar: `label value [OK|FAIL]`. */
function TermStat({
  label,
  value,
  result,
}: {
  label: string;
  value: ReactNode;
  result: Effective;
}) {
  return (
    <span className="term-stat">
      <span className="term-key">{label}</span>
      <span className="term-val">{value}</span>
      {result === "success" && <span className="term-res ok">OK</span>}
      {result === "failure" && <span className="term-res fail">FAIL</span>}
    </span>
  );
}

export function RollSetDisplay({
  rolls,
  size = "md",
  variant = "stacked",
  trailing,
}: {
  rolls: RollSet | null;
  size?: Size;
  variant?: Variant;
  /**
   * Optional additional content rendered after the Skill / Chaos /
   * extras stats. In `stacked` mode pass `.roll-cell`-shaped children
   * (e.g. the note timer cell); in `terminal` mode pass a
   * `.term-stat`-shaped node (the terminal-variant timer).
   */
  trailing?: ReactNode;
}) {
  // ---- Terminal variant: inline mono text, no cell chrome. ----------
  if (variant === "terminal") {
    if (rolls === null) {
      return (
        <>
          <span className="term-stat">
            <span className="term-key">skill</span>
            <span className="term-val">—</span>
          </span>
          <span className="term-stat">
            <span className="term-key">chaos</span>
            <span className="term-val">—</span>
          </span>
          {trailing}
        </>
      );
    }
    return (
      <>
        <TermStat
          label="skill"
          value={`${rolls.skillRoll}/${rolls.skillCount}`}
          result={effective(rolls.skillRoll, rolls.skillResult)}
        />
        <TermStat
          label="chaos"
          value={rolls.chaosRoll}
          result={chaosEffective(rolls.chaosRoll, rolls.chaosResult)}
        />
        {rolls.extras.map((extra, i) => (
          <TermStat
            key={`${extra.kind}-${i}`}
            label={extra.name.toLowerCase()}
            value={extra.value}
            result={effective(extra.value, extra.result ?? null)}
          />
        ))}
        {trailing}
      </>
    );
  }

  // ---- Stacked variant (default). -----------------------------------
  // Race-only branch: roll generation runs in the same mutation
  // transaction as the call insert, so external readers should never
  // observe `null`. We render a quiet pending state anyway so the
  // presence of the component is well-defined.
  if (rolls === null) {
    return (
      <div className="roll-set" aria-label="Rolls pending">
        <div className={cellClassName(size, "neutral")}>
          <span className="roll-cell-caption">Skill</span>
          <span className="roll-cell-value">—</span>
          <span className="roll-cell-footer">Pending</span>
        </div>
        <div className={cellClassName(size, "neutral")}>
          <span className="roll-cell-caption">Chaos</span>
          <span className="roll-cell-value">—</span>
          <span className="roll-cell-footer">Pending</span>
        </div>
        {trailing}
      </div>
    );
  }

  const skillEffective = effective(rolls.skillRoll, rolls.skillResult);
  const chaosEff = chaosEffective(rolls.chaosRoll, rolls.chaosResult);

  return (
    <div className="roll-set" aria-label="Dice rolls (GM)">
      {/* Skill cell */}
      <div
        className={cellClassName(size, skillEffective)}
        aria-label={`Skill ${rolls.skillRoll} versus ${rolls.skillCount}`}
      >
        <span className="roll-cell-caption">Skill</span>
        <span className="roll-cell-value">{rolls.skillRoll}</span>
        <span className="roll-cell-footer">vs §{rolls.skillCount}</span>
        <ResultBadge result={skillEffective} />
      </div>

      {/* Chaos cell — neutral unless natural-1 (fail) or natural-6 (pass). */}
      <div
        className={cellClassName(size, chaosEff)}
        aria-label={`Chaos ${rolls.chaosRoll}`}
      >
        <span className="roll-cell-caption">Chaos</span>
        <span className="roll-cell-value">{rolls.chaosRoll}</span>
        <ResultBadge result={chaosEff} />
      </div>

      {/* Extras: every entry has a required `name` (schema + helper
       * guarantee). The component MUST NOT fall back to `kind`.
       *
       * Drawback dice are first-class extras (kind: "drawback") and
       * flow through this iteration unchanged. The natural-1 rule
       * applies via `effective(...)` above, the caption comes from
       * `extra.name` (already truncated to ≤6 chars at the trigger
       * site in `convex/lib/rolls.ts`), and no kind-specific styling
       * is required. Do not introduce `if (extra.kind === "drawback")`
       * branches here — future extras kinds (e.g. allies, hazards)
       * should likewise be rendered uniformly. */}
      {rolls.extras.map((extra, i) => {
        const extraEffective = effective(extra.value, extra.result ?? null);
        return (
          <div
            key={`${extra.kind}-${i}`}
            className={cellClassName(size, extraEffective)}
            aria-label={`${extra.name} ${extra.value}`}
          >
            <span className="roll-cell-caption">
              {extra.name.toUpperCase()}
            </span>
            <span className="roll-cell-value">{extra.value}</span>
            <ResultBadge result={extraEffective} />
          </div>
        );
      })}
      {trailing}
    </div>
  );
}
