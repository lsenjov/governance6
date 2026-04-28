/**
 * RollSetDisplay — brutalist GM-only dice readout.
 *
 * Renders a row of square cells (Skill, Chaos, then any conditional
 * extras) for a roll set produced by `convex/lib/rolls.ts`. Visual
 * primitives reuse the existing brutalist tokens — hard 2px borders,
 * zero radius, mono numerals, riot-red top rule for failures, mint
 * bottom strip for successes. No new design tokens.
 *
 * Universal natural-1 rule (defence-in-depth): the helper writes the
 * derived `*Result` fields at insert time, but this component
 * re-derives them on render so any historical row, or any future code
 * path that bypasses the helper, still highlights a 1 as a failure.
 *
 * Visibility is enforced server-side: non-GM viewers never receive
 * the `rolls` payload, so the component never renders for them.
 */

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

export function RollSetDisplay({
  rolls,
  size = "md",
}: {
  rolls: RollSet | null;
  size?: Size;
}) {
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
      </div>
    );
  }

  const skillEffective = effective(rolls.skillRoll, rolls.skillResult);
  const chaosEffective = effective(rolls.chaosRoll, rolls.chaosResult);

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

      {/* Chaos cell — neutral unless natural-1. */}
      <div
        className={cellClassName(size, chaosEffective)}
        aria-label={`Chaos ${rolls.chaosRoll}`}
      >
        <span className="roll-cell-caption">Chaos</span>
        <span className="roll-cell-value">{rolls.chaosRoll}</span>
        <ResultBadge result={chaosEffective} />
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
    </div>
  );
}
