import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useElapsed, formatElapsed } from "../hooks/useElapsed";
import { resolveNoteCount, useNotesCountMap } from "../hooks/useNotesCountMap";
import { NoteIcon } from "../components/NoteIcon";

type GameId = Id<"games">;
type PlayerId = Id<"players">;

export function GameDetailPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const gid = gameId as GameId | undefined;
  const view = useQuery(api.games.getGameView, gid ? { gameId: gid } : "skip");
  const noteCounts = useNotesCountMap(gid);

  if (!gid) return <div>Missing game id.</div>;
  if (view === undefined) return <div className="muted">Loading…</div>;
  if (view === null)
    return <div>Game not found or you do not have access.</div>;

  const { game, gm, roster, viewer } = view;
  return (
    <div>
      <Link to="/games" className="muted">
        ← Back to Games
      </Link>
      <div
        className="row-wrap"
        style={{ marginTop: "0.5rem", alignItems: "center" }}
      >
        <h2 style={{ marginRight: "auto" }}>{game.name ?? "Untitled game"}</h2>
        <NoteIcon
          gameId={gid}
          target={{ kind: "game" }}
          count={resolveNoteCount(noteCounts, { kind: "game" })}
          label={game.name ?? "this game"}
        />
        <span
          className={`badge ${
            game.state === "playing"
              ? "success"
              : game.state === "archived"
                ? "warning"
                : ""
          }`}
        >
          {game.state}
        </span>
      </div>
      <div className="muted">
        GM: {gm.displayName}
        {viewer.isGm && " (you)"}
      </div>

      {game.state === "playing" && game.startedAt && (
        <ElapsedDisplay startedAt={game.startedAt} />
      )}

      {viewer.isGm && (
        <GmControls
          gameId={gid}
          gameState={game.state}
          rosterSize={roster.length}
        />
      )}

      <div className="section-masonry" style={{ marginTop: "1.5rem" }}>
        {game.state !== "ready" && (
          <>
            <section>
              <h3>Call Queue</h3>
              <CallQueuePanel gameId={gid} isGm={viewer.isGm} />
            </section>

            {viewer.playerId && (
              <section>
                <h3>Your Minions</h3>
                <MinionBuyPanel
                  gameId={gid}
                  playerId={viewer.playerId}
                  gameState={game.state}
                  noteCounts={noteCounts}
                />
              </section>
            )}

            <section>
              <h3>POWER</h3>
              <PowerPanel
                gameId={gid}
                viewer={viewer}
                gameState={game.state}
                roster={roster}
              />
            </section>
          </>
        )}

        <section>
          <h3>Roster</h3>
          <RosterList
            gameId={gid}
            gameState={game.state}
            viewer={viewer}
            roster={roster}
            noteCounts={noteCounts}
          />
        </section>

        {viewer.isGm && game.state === "ready" && (
          <section>
            <h3>Add Player</h3>
            <AddPlayerForm gameId={gid} />
          </section>
        )}

        {!viewer.isGm && viewer.playerId && game.state === "ready" && (
          <section>
            <h3>Your Syndicate</h3>
            <SyndicateSelector
              gameId={gid}
              currentSelection={
                roster.find((p) => p._id === viewer.playerId)
                  ?.selectedSyndicateId ?? null
              }
            />
          </section>
        )}
      </div>
    </div>
  );
}

function ElapsedDisplay({ startedAt }: { startedAt: number }) {
  const ms = useElapsed(startedAt);
  return (
    <div
      className="card"
      aria-live="polite"
      style={{ marginTop: "1rem", fontSize: "1.1rem" }}
    >
      <span className="muted">Elapsed: </span>
      <strong>{formatElapsed(ms)}</strong>
    </div>
  );
}

function GmControls({
  gameId,
  gameState,
  rosterSize,
}: {
  gameId: GameId;
  gameState: "ready" | "playing" | "archived";
  rosterSize: number;
}) {
  const transition = useMutation(api.games.transitionState);
  const [err, setErr] = useState<string | null>(null);

  async function go(target: "playing" | "archived") {
    setErr(null);
    try {
      await transition({ gameId, target });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Transition failed.");
    }
  }

  return (
    <div className="card row-wrap" style={{ marginTop: "1rem" }}>
      <strong>GM:</strong>
      {gameState === "ready" && (
        <>
          <button
            type="button"
            onClick={() => void go("playing")}
            disabled={rosterSize === 0}
            title={
              rosterSize === 0 ? "Add at least one Player first." : undefined
            }
          >
            Start game (→ playing)
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void go("archived")}
          >
            Archive
          </button>
        </>
      )}
      {gameState === "playing" && (
        <button
          type="button"
          className="secondary"
          onClick={() => void go("archived")}
        >
          Archive
        </button>
      )}
      {gameState === "archived" && (
        <span className="muted">Game is archived.</span>
      )}
      {err && (
        <div className="error-text" style={{ flexBasis: "100%" }}>
          {err}
        </div>
      )}
    </div>
  );
}

function AddPlayerForm({ gameId }: { gameId: GameId }) {
  const [q, setQ] = useState("");
  const results = useQuery(
    api.users.searchUsers,
    q.trim().length > 0 ? { query: q, excludeGameId: gameId } : "skip",
  );
  const addPlayer = useMutation(api.games.addPlayer);
  const [err, setErr] = useState<string | null>(null);

  async function add(userId: Id<"users">) {
    setErr(null);
    try {
      await addPlayer({ gameId, userId });
      setQ("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed.");
    }
  }

  return (
    <div className="card stack">
      <div>
        <label>Search users by display name or email</label>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type to search…"
          style={{ width: "100%" }}
        />
      </div>
      {err && <div className="error-text">{err}</div>}
      {q.trim().length > 0 && results === undefined && (
        <div className="muted">Searching…</div>
      )}
      {results && results.length === 0 && (
        <div className="muted">No matching users.</div>
      )}
      <div className="stack">
        {results?.map((u) => (
          <div
            key={u._id}
            className="row"
            style={{ justifyContent: "space-between" }}
          >
            <div>
              <div>{u.displayName}</div>
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                {u.email}
              </div>
            </div>
            <button type="button" onClick={() => void add(u._id)}>
              Add
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RosterList({
  gameId,
  gameState,
  viewer,
  roster,
  noteCounts,
}: {
  gameId: GameId;
  gameState: "ready" | "playing" | "archived";
  viewer: { userId: Id<"users">; isGm: boolean; playerId: PlayerId | null };
  roster: Array<{
    _id: PlayerId;
    userId: Id<"users">;
    displayName: string;
    power: number;
    selectedSyndicateId: Id<"syndicates"> | null;
    selectedSyndicate: {
      _id: Id<"syndicates">;
      name: string;
      leader: string;
    } | null;
  }>;
  noteCounts: ReturnType<typeof useNotesCountMap>;
}) {
  const removePlayer = useMutation(api.games.removePlayer);
  const [err, setErr] = useState<string | null>(null);

  if (roster.length === 0) {
    return <div className="muted">No Players yet.</div>;
  }

  async function handleRemove(playerId: PlayerId, name: string) {
    if (!window.confirm(`Remove ${name} from this game?`)) return;
    setErr(null);
    try {
      await removePlayer({ gameId, playerId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Remove failed.");
    }
  }

  return (
    <div className="stack">
      {err && <div className="error-text">{err}</div>}
      {roster.map((p) => (
        <div
          key={p._id}
          className="card row"
          style={{ justifyContent: "space-between" }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>
              {p.displayName}
              {p.userId === viewer.userId && " (you)"}
            </div>
            <div className="muted row-wrap" style={{ fontSize: "0.85rem" }}>
              {p.selectedSyndicate ? (
                <>
                  <span>
                    Syndicate: {p.selectedSyndicate.name} · Leader{" "}
                    {p.selectedSyndicate.leader}
                  </span>
                  <NoteIcon
                    gameId={gameId}
                    target={{
                      kind: "syndicate",
                      syndicateId: p.selectedSyndicate._id,
                    }}
                    count={resolveNoteCount(noteCounts, {
                      kind: "syndicate",
                      syndicateId: p.selectedSyndicate._id,
                    })}
                    label={p.selectedSyndicate.name}
                  />
                </>
              ) : (
                <span>
                  {gameState === "ready"
                    ? "No Syndicate selected"
                    : "No Syndicate"}
                </span>
              )}
            </div>
          </div>
          {viewer.isGm && gameState === "ready" && (
            <button
              type="button"
              className="danger"
              onClick={() => void handleRemove(p._id, p.displayName)}
            >
              Remove
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function SyndicateSelector({
  gameId,
  currentSelection,
}: {
  gameId: GameId;
  currentSelection: Id<"syndicates"> | null;
}) {
  const options = useQuery(api.syndicates.listSelectable);
  const select = useMutation(api.games.selectSyndicate);
  const [err, setErr] = useState<string | null>(null);

  async function pick(syndicateId: Id<"syndicates"> | null) {
    setErr(null);
    try {
      await select({ gameId, syndicateId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Selection failed.");
    }
  }

  if (options === undefined) return <div className="muted">Loading…</div>;
  if (options.length === 0) {
    return (
      <div className="muted">
        You have no selectable Syndicates. Create one or wait for a shared
        Syndicate to appear.
      </div>
    );
  }

  return (
    <div className="card stack">
      {err && <div className="error-text">{err}</div>}
      <div className="stack">
        {options.map((s) => (
          <label
            key={s._id}
            className="row"
            style={{ cursor: "pointer", justifyContent: "space-between" }}
          >
            <span>
              <input
                type="radio"
                name="syndicate"
                checked={currentSelection === s._id}
                onChange={() => void pick(s._id)}
                style={{ marginRight: "0.5rem" }}
              />
              {s.name}{" "}
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                — leader {s.leader}
              </span>
            </span>
            <span className="row-wrap">
              {s.played && <span className="badge warning">Played</span>}
              {s.isShared && <span className="badge accent">Shared</span>}
            </span>
          </label>
        ))}
        {currentSelection && (
          <button
            type="button"
            className="secondary"
            onClick={() => void pick(null)}
          >
            Clear selection
          </button>
        )}
      </div>
    </div>
  );
}

function PowerPanel({
  gameId,
  viewer,
  gameState,
  roster,
}: {
  gameId: GameId;
  viewer: { userId: Id<"users">; isGm: boolean; playerId: PlayerId | null };
  gameState: "ready" | "playing" | "archived";
  roster: Array<{
    _id: PlayerId;
    userId: Id<"users">;
    displayName: string;
    power: number;
  }>;
}) {
  const balances = useQuery(api.ledger.getPlayerBalances, { gameId });

  return (
    <div className="stack">
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th style={{ textAlign: "right" }}>POWER</th>
            </tr>
          </thead>
          <tbody>
            {(balances ?? []).map((b) => (
              <tr key={b.playerId}>
                <td>
                  {b.displayName}
                  {b.userId === viewer.userId && " (you)"}
                </td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>
                  {b.power}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {viewer.playerId && (
        <>
          <OwnLedger gameId={gameId} />
          {gameState === "playing" && (
            <TransferForm
              gameId={gameId}
              myPlayerId={viewer.playerId}
              roster={roster}
            />
          )}
        </>
      )}

      {viewer.isGm && gameState !== "archived" && (
        <GmLedgerPanel gameId={gameId} roster={roster} />
      )}
    </div>
  );
}

function OwnLedger({ gameId }: { gameId: GameId }) {
  const entries = useQuery(api.ledger.getOwnLedger, { gameId });
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <button
        type="button"
        className="secondary"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide" : "Show"} my ledger ({entries?.length ?? "…"})
      </button>
      {open && <LedgerTable entries={entries ?? []} />}
    </div>
  );
}

function GmLedgerPanel({
  gameId,
  roster,
}: {
  gameId: GameId;
  roster: Array<{ _id: PlayerId; displayName: string }>;
}) {
  const [expanded, setExpanded] = useState<PlayerId | null>(null);
  return (
    <div className="card stack">
      <strong>GM Tools</strong>
      {roster.map((p) => (
        <GmPlayerRow
          key={p._id}
          gameId={gameId}
          player={p}
          isExpanded={expanded === p._id}
          onToggle={() => setExpanded((cur) => (cur === p._id ? null : p._id))}
        />
      ))}
    </div>
  );
}

function GmPlayerRow({
  gameId,
  player,
  isExpanded,
  onToggle,
}: {
  gameId: GameId;
  player: { _id: PlayerId; displayName: string };
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{player.displayName}</strong>
        <button type="button" className="secondary" onClick={onToggle}>
          {isExpanded ? "Collapse" : "Expand"}
        </button>
      </div>
      {isExpanded && (
        <div className="stack" style={{ marginTop: "0.5rem" }}>
          <GmEditPowerForm gameId={gameId} playerId={player._id} />
          <GmPlayerLedger gameId={gameId} playerId={player._id} />
        </div>
      )}
    </div>
  );
}

function GmEditPowerForm({
  gameId,
  playerId,
}: {
  gameId: GameId;
  playerId: PlayerId;
}) {
  const edit = useMutation(api.ledger.gmEditPower);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    const n = Number(delta);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n === 0) {
      setErr("Delta must be a non-zero integer.");
      return;
    }
    try {
      await edit({
        gameId,
        playerId,
        delta: n,
        reason: reason.trim() || undefined,
      });
      setDelta("");
      setReason("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Edit failed.");
    }
  }

  return (
    <div className="row-wrap">
      <div>
        <label style={{ fontSize: "0.8rem" }}>Delta (± integer)</label>
        <input
          value={delta}
          onChange={(e) => setDelta(e.target.value)}
          style={{ width: "8rem" }}
          placeholder="e.g. -3"
        />
      </div>
      <div style={{ flex: 1 }}>
        <label style={{ fontSize: "0.8rem" }}>Reason (optional)</label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      <button type="button" onClick={() => void submit()}>
        Apply
      </button>
      {err && (
        <div className="error-text" style={{ flexBasis: "100%" }}>
          {err}
        </div>
      )}
    </div>
  );
}

function GmPlayerLedger({
  gameId,
  playerId,
}: {
  gameId: GameId;
  playerId: PlayerId;
}) {
  const entries = useQuery(api.ledger.getAnyLedger, { gameId, playerId });
  return <LedgerTable entries={entries ?? []} />;
}

function LedgerTable({
  entries,
}: {
  entries: Array<{
    _id: string;
    createdAt: number;
    delta: number;
    source: string;
    reason?: string;
    counterpartyName: string | null;
  }>;
}) {
  if (entries.length === 0) {
    return <div className="muted">No ledger entries yet.</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Source</th>
          <th style={{ textAlign: "right" }}>Δ</th>
          <th>Counterparty</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e._id}>
            <td style={{ fontSize: "0.85rem" }}>
              {new Date(e.createdAt).toLocaleTimeString()}
            </td>
            <td>{e.source}</td>
            <td
              style={{
                textAlign: "right",
                fontWeight: 600,
                color: e.delta >= 0 ? "var(--success)" : "var(--danger)",
              }}
            >
              {e.delta > 0 ? `+${e.delta}` : e.delta}
            </td>
            <td>{e.counterpartyName ?? "—"}</td>
            <td>{e.reason ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TransferForm({
  gameId,
  myPlayerId,
  roster,
}: {
  gameId: GameId;
  myPlayerId: PlayerId;
  roster: Array<{ _id: PlayerId; displayName: string }>;
}) {
  const toPlayer = useMutation(api.ledger.transferPlayerToPlayer);
  const toBank = useMutation(api.ledger.transferPlayerToBank);
  const [recipient, setRecipient] = useState<string>("bank");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    const n = Number(amount);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      setErr("Amount must be a positive integer.");
      return;
    }
    const r = reason.trim();
    if (r.length === 0) {
      setErr("Reason is required.");
      return;
    }
    try {
      if (recipient === "bank") {
        await toBank({ gameId, amount: n, reason: r });
      } else {
        await toPlayer({
          gameId,
          recipientPlayerId: recipient as PlayerId,
          amount: n,
          reason: r,
        });
      }
      setAmount("");
      setReason("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Transfer failed.");
    }
  }

  const otherPlayers = roster.filter((p) => p._id !== myPlayerId);

  return (
    <div className="card stack">
      <strong>Transfer POWER</strong>
      <div>
        <label>Recipient</label>
        <select
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          style={{ width: "100%" }}
        >
          <option value="bank">Bank</option>
          {otherPlayers.map((p) => (
            <option key={p._id} value={p._id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </div>
      <div className="row-wrap">
        <div>
          <label>Amount</label>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ width: "8rem" }}
            placeholder="positive int"
          />
        </div>
        <div style={{ flex: 1 }}>
          <label>Reason *</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>
      </div>
      {err && <div className="error-text">{err}</div>}
      <button type="button" onClick={() => void submit()}>
        Transfer
      </button>
    </div>
  );
}

function MinionBuyPanel({
  gameId,
  playerId,
  gameState,
  noteCounts,
}: {
  gameId: GameId;
  playerId: PlayerId;
  gameState: "ready" | "playing" | "archived";
  noteCounts: ReturnType<typeof useNotesCountMap>;
}) {
  const data = useQuery(api.minionBuys.listForPlayer, { gameId, playerId });
  const buy = useMutation(api.minionBuys.buyMinion);
  const addCall = useMutation(api.calls.addOrReplaceCall);
  const [err, setErr] = useState<string | null>(null);

  if (data === undefined) return <div className="muted">Loading…</div>;
  if (data === null) return <div>Not accessible.</div>;
  if (!data.syndicateId)
    return <div className="muted">No Syndicate selected.</div>;

  async function handleBuy(minionId: Id<"minions">) {
    setErr(null);
    try {
      await buy({ gameId, minionId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Buy failed.");
    }
  }

  async function handleCall(minionId: Id<"minions">) {
    setErr(null);
    try {
      await addCall({ gameId, minionId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Call failed.");
    }
  }

  return (
    <div className="stack">
      {err && <div className="error-text">{err}</div>}
      <div className="muted" style={{ fontSize: "0.9rem" }}>
        Bought: {data.boughtCount}/8 ·
        {data.nextPrice !== null
          ? ` next buy costs ${data.nextPrice}`
          : " maximum reached"}
      </div>
      {data.minions.map((m) => (
        <div
          key={m._id}
          className="card row"
          style={{ justifyContent: "space-between" }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>
              {m.name}
              {m.accent && (
                <span
                  className="muted"
                  style={{ marginLeft: "0.5rem", fontWeight: 400 }}
                >
                  — {m.accent}
                </span>
              )}
            </div>
            {m.description && (
              <div style={{ fontSize: "0.85rem" }}>{m.description}</div>
            )}
            <div className="row-wrap" style={{ marginTop: "0.25rem" }}>
              {m.skills.map((s, i) => (
                <span key={i} className="badge">
                  {s}
                </span>
              ))}
            </div>
            {m.bought && (
              <div
                className="muted"
                style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}
              >
                Bought (paid {m.pricePaid ?? 0})
              </div>
            )}
          </div>
          <div className="row-wrap" style={{ alignItems: "center" }}>
            <NoteIcon
              gameId={gameId}
              target={{ kind: "minion", minionId: m._id }}
              count={resolveNoteCount(noteCounts, {
                kind: "minion",
                minionId: m._id,
              })}
              label={m.name}
            />
            {gameState === "playing" &&
              !m.bought &&
              data.isSelf &&
              data.nextPrice !== null && (
                <button
                  type="button"
                  onClick={() => void handleBuy(m._id)}
                  title={`Buy for ${data.nextPrice}`}
                >
                  Buy ({data.nextPrice})
                </button>
              )}
            {gameState === "playing" && m.bought && data.isSelf && (
              <button
                type="button"
                className="secondary"
                onClick={() => void handleCall(m._id)}
              >
                Call
              </button>
            )}
            {m.bought && <span className="badge success">Bought</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function CallQueuePanel({ gameId, isGm }: { gameId: GameId; isGm: boolean }) {
  const active = useQuery(api.calls.activeCalls, { gameId });
  const removed = useQuery(api.calls.recentlyRemovedCalls, { gameId });
  const removeCall = useMutation(api.calls.removeCall);
  const [err, setErr] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  async function handleRemove(callId: Id<"calls">) {
    setErr(null);
    try {
      await removeCall({ callId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Remove failed.");
    }
  }

  return (
    <div className="stack" aria-live="polite">
      {err && <div className="error-text">{err}</div>}
      {active === undefined && <div className="muted">Loading…</div>}
      {active?.length === 0 && <div className="muted">Queue is empty.</div>}
      <ol className="stack" style={{ paddingLeft: "1.2rem" }}>
        {active?.map((c) => (
          <li
            key={c._id}
            className="card row"
            style={{ justifyContent: "space-between" }}
          >
            <div>
              <strong>{c.playerName}</strong>
              <span className="muted"> called </span>
              <strong>{c.minionName}</strong>
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                {new Date(c.createdAt).toLocaleTimeString()}
              </div>
            </div>
            {isGm && (
              <button
                type="button"
                className="danger"
                onClick={() => void handleRemove(c._id)}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ol>
      <div>
        <button
          type="button"
          className="secondary"
          onClick={() => setShowHistory((s) => !s)}
        >
          {showHistory ? "Hide" : "Show"} recently removed (
          {removed?.length ?? 0})
        </button>
        {showHistory && (
          <div className="stack" style={{ marginTop: "0.5rem" }}>
            {removed?.length === 0 && (
              <div className="muted">No removed Calls.</div>
            )}
            {removed?.map((c) => (
              <div key={c._id} className="card">
                <strong>{c.playerName}</strong>
                <span className="muted"> called </span>
                <strong>{c.minionName}</strong>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Removed {new Date(c.removedAt).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
