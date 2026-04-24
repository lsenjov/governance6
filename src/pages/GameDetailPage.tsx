import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useElapsed, formatElapsed } from "../hooks/useElapsed";
import { resolveNoteCount, useNotesCountMap } from "../hooks/useNotesCountMap";
import { useRosterExpandedSet } from "../hooks/useRosterExpandedSet";
import { NoteIcon } from "../components/NoteIcon";

type GameId = Id<"games">;
type PlayerId = Id<"players">;
type GameState = "ready" | "playing" | "archived";

type Viewer = {
  userId: Id<"users">;
  isGm: boolean;
  playerId: PlayerId | null;
};

type RosterEntry = {
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
};

type Balance = {
  playerId: PlayerId;
  userId: Id<"users">;
  displayName: string;
  power: number;
};

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export function GameDetailPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const gid = gameId as GameId | undefined;
  const view = useQuery(api.games.getGameView, gid ? { gameId: gid } : "skip");
  const noteCounts = useNotesCountMap(gid);
  const balances = useQuery(
    api.ledger.getPlayerBalances,
    gid ? { gameId: gid } : "skip",
  );

  if (!gid) return <div>Missing game id.</div>;
  if (view === undefined) return <div className="muted">Loading…</div>;
  if (view === null)
    return <div>Game not found or you do not have access.</div>;

  const { game, gm, roster, viewer } = view;
  const gameState: GameState = game.state;
  const powerByPlayer = indexBalances(balances, roster);
  const showRail = gameState !== "ready";
  const showYouStrip = showRail && viewer.playerId !== null;

  return (
    <div className="game-shell">
      <GameHud
        gameId={gid}
        gameName={game.name ?? "Untitled game"}
        gameState={gameState}
        gmName={gm.displayName}
        viewerIsGm={viewer.isGm}
        startedAt={game.startedAt ?? null}
        rosterSize={roster.length}
        gameNoteCount={resolveNoteCount(noteCounts, { kind: "game" })}
      />

      {showYouStrip && (
        <YouStrip
          gameId={gid}
          viewer={viewer}
          roster={roster}
          powerByPlayer={powerByPlayer}
          gameState={gameState}
        />
      )}

      <div className={`game-grid${showRail ? "" : " single-column"}`}>
        <div className="game-main">
          <section>
            <h3 style={{ marginTop: 0 }}>Roster</h3>
            <RosterList
              gameId={gid}
              gameState={gameState}
              viewer={viewer}
              roster={roster}
              powerByPlayer={powerByPlayer}
              noteCounts={noteCounts}
            />
          </section>

          {viewer.isGm && gameState === "ready" && (
            <section>
              <h3>Add Player</h3>
              <AddPlayerForm gameId={gid} />
            </section>
          )}

          {!viewer.isGm && viewer.playerId && gameState === "ready" && (
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

        {showRail && (
          <aside className="game-rail" aria-label="Game summary rail">
            <section>
              <h3>Call Queue</h3>
              <CallQueueRail
                gameId={gid}
                isGm={viewer.isGm}
                noteCounts={noteCounts}
              />
            </section>
            <section>
              <h3>POWER Standings</h3>
              <PowerStandingsRail
                viewer={viewer}
                roster={roster}
                powerByPlayer={powerByPlayer}
                balancesLoading={balances === undefined}
              />
            </section>
          </aside>
        )}
      </div>

      {showYouStrip && (
        <BottomStrip
          gameId={gid}
          viewer={viewer}
          roster={roster}
          powerByPlayer={powerByPlayer}
        />
      )}
    </div>
  );
}

function indexBalances(
  balances: Balance[] | undefined,
  roster: RosterEntry[],
): Map<PlayerId, number> {
  const map = new Map<PlayerId, number>();
  // Seed from roster so we always have something to display; overwritten
  // by the authoritative ledger-backed balances when they arrive.
  for (const r of roster) map.set(r._id, r.power);
  if (balances) {
    for (const b of balances) map.set(b.playerId, b.power);
  }
  return map;
}

// ───────────────────────────────────────────────────────────────────────────
// HUD
// ───────────────────────────────────────────────────────────────────────────

function GameHud({
  gameId,
  gameName,
  gameState,
  gmName,
  viewerIsGm,
  startedAt,
  rosterSize,
  gameNoteCount,
}: {
  gameId: GameId;
  gameName: string;
  gameState: GameState;
  gmName: string;
  viewerIsGm: boolean;
  startedAt: number | null;
  rosterSize: number;
  gameNoteCount: number;
}) {
  const [logOpen, setLogOpen] = useState(false);
  return (
    <>
      <header className="game-hud">
        <Link to="/games" className="muted">
          ← Games
        </Link>
        <h2>{gameName}</h2>
        <span
          className={`badge ${
            gameState === "playing"
              ? "success"
              : gameState === "archived"
                ? "warning"
                : ""
          }`}
        >
          {gameState}
        </span>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          GM: {gmName}
          {viewerIsGm && " (you)"}
        </span>
        {gameState === "playing" && startedAt && (
          <ElapsedInline startedAt={startedAt} />
        )}
        <span className="spacer" />
        {viewerIsGm && (
          <GmControlsInline
            gameId={gameId}
            gameState={gameState}
            rosterSize={rosterSize}
          />
        )}
        <NoteIcon
          gameId={gameId}
          target={{ kind: "game" }}
          count={gameNoteCount}
          label={gameName}
        />
        <button
          type="button"
          className="secondary"
          onClick={() => setLogOpen(true)}
        >
          Log
        </button>
      </header>
      {logOpen && (
        <GameLogDrawer gameId={gameId} onClose={() => setLogOpen(false)} />
      )}
    </>
  );
}

function ElapsedInline({ startedAt }: { startedAt: number }) {
  const ms = useElapsed(startedAt);
  return (
    <span aria-live="polite">
      <span className="muted" style={{ fontSize: "0.85rem" }}>
        Elapsed{" "}
      </span>
      <strong>{formatElapsed(ms)}</strong>
    </span>
  );
}

function GmControlsInline({
  gameId,
  gameState,
  rosterSize,
}: {
  gameId: GameId;
  gameState: GameState;
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
    <>
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
            Start game
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
      {err && <span className="error-text">{err}</span>}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// "You" context strip + popovers
// ───────────────────────────────────────────────────────────────────────────

function YouStrip({
  gameId,
  viewer,
  roster,
  powerByPlayer,
  gameState,
}: {
  gameId: GameId;
  viewer: Viewer;
  roster: RosterEntry[];
  powerByPlayer: Map<PlayerId, number>;
  gameState: GameState;
}) {
  const me = roster.find((p) => p._id === viewer.playerId);
  if (!me) return null;
  const power = powerByPlayer.get(me._id) ?? me.power;
  return (
    <div className="game-you-strip">
      <strong>You:</strong>
      <span>{me.displayName}</span>
      <span className="muted">·</span>
      {me.selectedSyndicate ? (
        <span className="muted">
          {me.selectedSyndicate.name} (Leader {me.selectedSyndicate.leader})
        </span>
      ) : (
        <span className="muted">No Syndicate</span>
      )}
      <span className="muted">·</span>
      <span>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          POWER{" "}
        </span>
        <strong>{power}</strong>
      </span>
      <span className="spacer" />
      {gameState === "playing" && (
        <TransferButton gameId={gameId} myPlayerId={me._id} roster={roster} />
      )}
      <LedgerButton gameId={gameId} />
    </div>
  );
}

function TransferButton({
  gameId,
  myPlayerId,
  roster,
}: {
  gameId: GameId;
  myPlayerId: PlayerId;
  roster: RosterEntry[];
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={anchorRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button type="button" onClick={() => setOpen((o) => !o)}>
        Transfer
      </button>
      {open && (
        <ActionPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          title="Transfer POWER"
        >
          <TransferForm
            gameId={gameId}
            myPlayerId={myPlayerId}
            roster={roster}
            onSuccess={() => setOpen(false)}
          />
        </ActionPopover>
      )}
    </div>
  );
}

function LedgerButton({ gameId }: { gameId: GameId }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const entries = useQuery(
    api.ledger.getOwnLedger,
    open ? { gameId } : "skip",
  );
  return (
    <div
      ref={anchorRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        className="secondary"
        onClick={() => setOpen((o) => !o)}
      >
        Ledger
      </button>
      {open && (
        <ActionPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          title="My ledger"
        >
          {entries === undefined ? (
            <div className="muted">Loading…</div>
          ) : (
            <LedgerTable entries={entries} />
          )}
        </ActionPopover>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ActionPopover primitive (Transfer, Ledger)
// ───────────────────────────────────────────────────────────────────────────

function ActionPopover({
  anchorRef,
  onClose,
  title,
  children,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{
    vertical: "below" | "above";
    horizontal: "left" | "right";
  }>({ vertical: "below", horizontal: "left" });

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    const GAP = 6;
    function reposition() {
      if (!anchor || !popover) return;
      const a = anchor.getBoundingClientRect();
      const p = popover.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const fitsRight = a.left + p.width <= vw;
      const fitsBelow = a.bottom + GAP + p.height <= vh;
      const fitsAbove = a.top - GAP - p.height >= 0;
      setPlacement({
        horizontal: fitsRight ? "left" : "right",
        vertical: !fitsBelow && fitsAbove ? "above" : "below",
      });
    }
    reposition();
    const ro = new ResizeObserver(reposition);
    ro.observe(popover);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (anchorRef.current && anchorRef.current.contains(t)) return;
      if (popoverRef.current && popoverRef.current.contains(t)) return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose, anchorRef]);

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={title}
      className="action-popover"
      style={{
        top: placement.vertical === "below" ? "calc(100% + 6px)" : "auto",
        bottom: placement.vertical === "above" ? "calc(100% + 6px)" : "auto",
        left: placement.horizontal === "left" ? 0 : "auto",
        right: placement.horizontal === "right" ? 0 : "auto",
      }}
    >
      <div
        className="row"
        style={{ justifyContent: "space-between", alignItems: "center" }}
      >
        <h4>{title}</h4>
        <button
          type="button"
          className="secondary"
          onClick={onClose}
          aria-label="Close"
          style={{ padding: "0.125rem 0.5rem", fontSize: "0.85rem" }}
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Drawer primitive + Game log
// ───────────────────────────────────────────────────────────────────────────

function Drawer({
  onClose,
  title,
  bottom,
  children,
}: {
  onClose: () => void;
  title: string;
  bottom?: boolean;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside
        role="dialog"
        aria-label={title}
        className={`drawer${bottom ? " bottom" : ""}`}
      >
        <div className="drawer-header">
          <h3>{title}</h3>
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: "auto",
              padding: "0.125rem 0.5rem",
              fontSize: "0.85rem",
            }}
          >
            ✕
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}

/**
 * Game log drawer.
 *
 * Currently renders only "Recently removed calls". The layout is
 * deliberately section-based so future event sources (ledger events,
 * state transitions, ...) can be appended as additional sections without
 * re-architecting.
 */
function GameLogDrawer({
  gameId,
  onClose,
}: {
  gameId: GameId;
  onClose: () => void;
}) {
  const removed = useQuery(api.calls.recentlyRemovedCalls, { gameId });
  return (
    <Drawer onClose={onClose} title="Game Log">
      <section>
        <h4 style={{ margin: "0 0 0.5rem 0" }}>Recently removed calls</h4>
        {removed === undefined && <div className="muted">Loading…</div>}
        {removed?.length === 0 && (
          <div className="muted">No removed calls.</div>
        )}
        <div>
          {removed?.map((c) => (
            <div key={c._id} className="row-divider">
              <div>
                <strong>{c.playerName}</strong>
                <span className="muted"> called </span>
                <strong>{c.minionName}</strong>
              </div>
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                Removed {new Date(c.removedAt).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      </section>
    </Drawer>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Roster
// ───────────────────────────────────────────────────────────────────────────

function RosterList({
  gameId,
  gameState,
  viewer,
  roster,
  powerByPlayer,
  noteCounts,
}: {
  gameId: GameId;
  gameState: GameState;
  viewer: Viewer;
  roster: RosterEntry[];
  powerByPlayer: Map<PlayerId, number>;
  noteCounts: ReturnType<typeof useNotesCountMap>;
}) {
  const livePlayerIds = useMemo(() => roster.map((p) => p._id), [roster]);
  const { isExpanded, toggle } = useRosterExpandedSet(
    gameId,
    viewer.playerId,
    livePlayerIds,
  );

  if (roster.length === 0) {
    return <div className="muted">No Players yet.</div>;
  }

  return (
    <div className="card" style={{ padding: "0.25rem 0.5rem" }}>
      {roster.map((p) => (
        <RosterRow
          key={p._id}
          gameId={gameId}
          gameState={gameState}
          viewer={viewer}
          player={p}
          power={powerByPlayer.get(p._id) ?? p.power}
          noteCounts={noteCounts}
          expanded={isExpanded(p._id)}
          onToggle={() => toggle(p._id)}
          isSelf={p._id === viewer.playerId}
        />
      ))}
    </div>
  );
}

function RosterRow({
  gameId,
  gameState,
  viewer,
  player,
  power,
  noteCounts,
  expanded,
  onToggle,
  isSelf,
}: {
  gameId: GameId;
  gameState: GameState;
  viewer: Viewer;
  player: RosterEntry;
  power: number;
  noteCounts: ReturnType<typeof useNotesCountMap>;
  expanded: boolean;
  onToggle: () => void;
  isSelf: boolean;
}) {
  const removePlayer = useMutation(api.games.removePlayer);
  const [err, setErr] = useState<string | null>(null);

  async function handleRemove(e: ReactMouseEvent) {
    e.stopPropagation();
    if (!window.confirm(`Remove ${player.displayName} from this game?`))
      return;
    setErr(null);
    try {
      await removePlayer({ gameId, playerId: player._id });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Remove failed.");
    }
  }

  const canToggle = !isSelf; // Self is always expanded.
  const showGmTools =
    expanded && viewer.isGm && gameState !== "archived" && gameState !== "ready";
  const showMinions =
    expanded && gameState !== "ready" && player.selectedSyndicateId !== null;

  return (
    <div className="row-divider">
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          alignItems: "center",
          cursor: canToggle ? "pointer" : "default",
          gap: "0.5rem",
        }}
        onClick={canToggle ? onToggle : undefined}
        role={canToggle ? "button" : undefined}
        aria-expanded={canToggle ? expanded : undefined}
        tabIndex={canToggle ? 0 : undefined}
        onKeyDown={
          canToggle
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
      >
        <span
          className="row-wrap"
          style={{ alignItems: "center", gap: "0.5rem", minWidth: 0 }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: "0.8rem",
              color: "var(--fg-muted)",
            }}
          >
            {isSelf ? "●" : expanded ? "▾" : "▸"}
          </span>
          <strong>
            {player.displayName}
            {isSelf && " (you)"}
          </strong>
          <span className="muted">·</span>
          {player.selectedSyndicate ? (
            <>
              <span className="muted" style={{ fontSize: "0.9rem" }}>
                {player.selectedSyndicate.name} (Leader{" "}
                {player.selectedSyndicate.leader})
              </span>
              <span
                onClick={(e) => e.stopPropagation()}
                style={{ display: "inline-flex" }}
              >
                <NoteIcon
                  gameId={gameId}
                  target={{
                    kind: "syndicate",
                    syndicateId: player.selectedSyndicate._id,
                  }}
                  count={resolveNoteCount(noteCounts, {
                    kind: "syndicate",
                    syndicateId: player.selectedSyndicate._id,
                  })}
                  label={player.selectedSyndicate.name}
                />
              </span>
            </>
          ) : (
            <span className="muted" style={{ fontSize: "0.9rem" }}>
              No Syndicate
            </span>
          )}
        </span>
        <span className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
          <span>
            <strong>{power}</strong>
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              {" "}
              POWER
            </span>
          </span>
          {viewer.isGm && gameState === "ready" && (
            <button
              type="button"
              className="danger"
              onClick={handleRemove}
              style={{ padding: "0.25rem 0.5rem", fontSize: "0.85rem" }}
            >
              Remove
            </button>
          )}
        </span>
      </div>
      {err && <div className="error-text">{err}</div>}
      {showMinions && (
        <div style={{ marginTop: "0.25rem", marginLeft: "1.4rem" }}>
          <MinionBuyPanel
            gameId={gameId}
            playerId={player._id}
            gameState={gameState}
            noteCounts={noteCounts}
          />
        </div>
      )}
      {showGmTools && (
        <div
          style={{
            marginTop: "0.5rem",
            marginLeft: "1.4rem",
            paddingTop: "0.5rem",
            borderTop: "1px dashed var(--border)",
          }}
        >
          <GmPlayerTools gameId={gameId} playerId={player._id} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Minion buy panel (row-divider list)
// ───────────────────────────────────────────────────────────────────────────

function MinionBuyPanel({
  gameId,
  playerId,
  gameState,
  noteCounts,
}: {
  gameId: GameId;
  playerId: PlayerId;
  gameState: GameState;
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

  async function handleBuy(e: ReactMouseEvent, minionId: Id<"minions">) {
    e.stopPropagation();
    setErr(null);
    try {
      await buy({ gameId, minionId });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Buy failed.");
    }
  }

  async function handleCall(e: ReactMouseEvent, minionId: Id<"minions">) {
    e.stopPropagation();
    setErr(null);
    try {
      await addCall({ gameId, minionId });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Call failed.");
    }
  }

  return (
    <div>
      {err && <div className="error-text">{err}</div>}
      <div className="muted" style={{ fontSize: "0.85rem", padding: "0.25rem" }}>
        Bought {data.boughtCount}/8 ·{" "}
        {data.nextPrice !== null
          ? `next buy ${data.nextPrice}`
          : "max reached"}
      </div>
      <div>
        {data.minions.map((m) => (
          <div
            key={m._id}
            className="row-divider"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              justifyContent: "space-between",
            }}
          >
            <div style={{ minWidth: 0 }} title={m.description ?? undefined}>
              <span style={{ fontWeight: 600 }}>{m.name}</span>
              {m.accent && (
                <span
                  className="muted"
                  style={{ marginLeft: "0.35rem", fontWeight: 400 }}
                >
                  — {m.accent}
                </span>
              )}
              {m.skills.length > 0 && (
                <span
                  className="row-wrap"
                  style={{
                    display: "inline-flex",
                    marginLeft: "0.5rem",
                    gap: "0.25rem",
                  }}
                >
                  {m.skills.map((s, i) => (
                    <span
                      key={i}
                      className="badge"
                      style={{ fontSize: "0.7rem" }}
                    >
                      {s}
                    </span>
                  ))}
                </span>
              )}
            </div>
            <span
              className="row"
              style={{ alignItems: "center", gap: "0.4rem" }}
              onClick={(e) => e.stopPropagation()}
            >
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
                    onClick={(e) => void handleBuy(e, m._id)}
                    title={`Buy for ${data.nextPrice}`}
                    style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
                  >
                    Buy {data.nextPrice}
                  </button>
                )}
              {gameState === "playing" && m.bought && data.isSelf && (
                <button
                  type="button"
                  className="secondary"
                  onClick={(e) => void handleCall(e, m._id)}
                  style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
                >
                  Call
                </button>
              )}
              {m.bought && (
                <span className="badge success" style={{ fontSize: "0.7rem" }}>
                  Bought
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// GM per-player tools (inline in roster row)
// ───────────────────────────────────────────────────────────────────────────

function GmPlayerTools({
  gameId,
  playerId,
}: {
  gameId: GameId;
  playerId: PlayerId;
}) {
  return (
    <div className="stack">
      <GmEditPowerForm gameId={gameId} playerId={playerId} />
      <GmPlayerLedger gameId={gameId} playerId={playerId} />
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

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Edit failed.");
    }
  }

  return (
    <form
      onSubmit={submit}
      onClick={(e) => e.stopPropagation()}
      className="row-wrap"
      style={{ alignItems: "center", gap: "0.4rem" }}
    >
      <input
        value={delta}
        onChange={(e) => setDelta(e.target.value)}
        placeholder="Δ ± int"
        aria-label="Delta (non-zero integer)"
        style={{ width: "6rem" }}
      />
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        aria-label="Reason"
        style={{ flex: 1, minWidth: "8rem" }}
      />
      <button type="submit">Apply</button>
      {err && (
        <div className="error-text" style={{ flexBasis: "100%" }}>
          {err}
        </div>
      )}
    </form>
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
  if (entries === undefined) return <div className="muted">Loading…</div>;
  return <LedgerTable entries={entries} />;
}

// ───────────────────────────────────────────────────────────────────────────
// Right rail: Call Queue + POWER Standings
// ───────────────────────────────────────────────────────────────────────────

function CallQueueRail({
  gameId,
  isGm,
  noteCounts,
}: {
  gameId: GameId;
  isGm: boolean;
  noteCounts: ReturnType<typeof useNotesCountMap>;
}) {
  const active = useQuery(api.calls.activeCalls, { gameId });
  const removeCall = useMutation(api.calls.removeCall);
  const [err, setErr] = useState<string | null>(null);

  async function handleRemove(callId: Id<"calls">) {
    setErr(null);
    try {
      await removeCall({ callId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Remove failed.");
    }
  }

  return (
    <div className="card tight" aria-live="polite">
      {err && <div className="error-text">{err}</div>}
      {active === undefined && <div className="muted">Loading…</div>}
      {active?.length === 0 && <div className="muted">Queue is empty.</div>}
      {active && active.length > 0 && (
        <ol style={{ paddingLeft: "1.4rem", margin: 0 }}>
          {active.map((c) => (
            <li key={c._id} className="row-divider">
              <div
                className="row"
                style={{
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <strong>{c.playerName}</strong>
                  <span className="muted"> → </span>
                  <strong>{c.minionName}</strong>
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    {" · "}
                    {new Date(c.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                <span className="row" style={{ gap: "0.25rem" }}>
                  <NoteIcon
                    gameId={gameId}
                    target={{ kind: "minion", minionId: c.minionId }}
                    count={resolveNoteCount(noteCounts, {
                      kind: "minion",
                      minionId: c.minionId,
                    })}
                    label={c.minionName}
                  />
                  {isGm && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void handleRemove(c._id)}
                      style={{ padding: "0.125rem 0.4rem", fontSize: "0.8rem" }}
                      aria-label="Remove call"
                    >
                      ✕
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PowerStandingsRail({
  viewer,
  roster,
  powerByPlayer,
  balancesLoading,
}: {
  viewer: Viewer;
  roster: RosterEntry[];
  powerByPlayer: Map<PlayerId, number>;
  balancesLoading: boolean;
}) {
  if (roster.length === 0) {
    return <div className="muted">No players.</div>;
  }
  const rows = roster
    .map((r) => ({
      player: r,
      power: powerByPlayer.get(r._id) ?? r.power,
    }))
    .sort((a, b) => b.power - a.power);
  const maxPower = Math.max(
    1,
    ...rows.map((r) => (r.power > 0 ? r.power : 0)),
  );
  return (
    <div className="card tight">
      {balancesLoading && (
        <div className="muted" style={{ fontSize: "0.8rem" }}>
          Updating…
        </div>
      )}
      {rows.map(({ player, power }) => {
        const pct = Math.max(0, Math.min(100, (power / maxPower) * 100));
        return (
          <div key={player._id} className="power-bar-row">
            <span
              title={player.displayName}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {player.displayName}
              {player.userId === viewer.userId && (
                <span className="muted" style={{ fontSize: "0.75rem" }}>
                  {" "}
                  (you)
                </span>
              )}
            </span>
            <div className="power-bar-track" aria-hidden="true">
              <div
                className="power-bar-fill"
                style={{ width: `${pct}%` }}
              />
            </div>
            <strong>{power}</strong>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Transfer form (used inside the Transfer popover)
// ───────────────────────────────────────────────────────────────────────────

function TransferForm({
  gameId,
  myPlayerId,
  roster,
  onSuccess,
}: {
  gameId: GameId;
  myPlayerId: PlayerId;
  roster: RosterEntry[];
  onSuccess: () => void;
}) {
  const toPlayer = useMutation(api.ledger.transferPlayerToPlayer);
  const toBank = useMutation(api.ledger.transferPlayerToBank);
  const [recipient, setRecipient] = useState<string>("bank");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
    setBusy(true);
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
      onSuccess();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Transfer failed.");
    } finally {
      setBusy(false);
    }
  }

  const otherPlayers = roster.filter((p) => p._id !== myPlayerId);

  return (
    <form onSubmit={submit} className="stack">
      <select
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
        aria-label="Recipient"
        style={{ width: "100%" }}
      >
        <option value="bank">Bank</option>
        {otherPlayers.map((p) => (
          <option key={p._id} value={p._id}>
            {p.displayName}
          </option>
        ))}
      </select>
      <div className="row-wrap" style={{ gap: "0.5rem" }}>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          aria-label="Amount"
          style={{ width: "8rem" }}
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required)"
          aria-label="Reason"
          style={{ flex: 1, minWidth: "10rem" }}
        />
      </div>
      {err && <div className="error-text">{err}</div>}
      <button type="submit" disabled={busy}>
        {busy ? "Transferring…" : "Transfer"}
      </button>
    </form>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Ledger table (kept structurally identical)
// ───────────────────────────────────────────────────────────────────────────

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

// ───────────────────────────────────────────────────────────────────────────
// Add Player form (ready state, GM only)
// ───────────────────────────────────────────────────────────────────────────

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
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search users by display name or email…"
        aria-label="Search users"
        style={{ width: "100%" }}
      />
      {err && <div className="error-text">{err}</div>}
      {q.trim().length > 0 && results === undefined && (
        <div className="muted">Searching…</div>
      )}
      {results && results.length === 0 && (
        <div className="muted">No matching users.</div>
      )}
      <div>
        {results?.map((u) => (
          <div
            key={u._id}
            className="row-divider row"
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

// ───────────────────────────────────────────────────────────────────────────
// Syndicate selector (ready state, non-GM)
// ───────────────────────────────────────────────────────────────────────────

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
      <div>
        {options.map((s) => (
          <label
            key={s._id}
            className="row-divider row"
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
      </div>
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
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Mobile bottom strip + queue sheet (narrow viewports only; see index.css)
// ───────────────────────────────────────────────────────────────────────────

function BottomStrip({
  gameId,
  viewer,
  roster,
  powerByPlayer,
}: {
  gameId: GameId;
  viewer: Viewer;
  roster: RosterEntry[];
  powerByPlayer: Map<PlayerId, number>;
}) {
  const active = useQuery(api.calls.activeCalls, { gameId });
  const noteCounts = useNotesCountMap(gameId);
  const [sheetOpen, setSheetOpen] = useState(false);
  const me = roster.find((p) => p._id === viewer.playerId);
  const myPower = me ? (powerByPlayer.get(me._id) ?? me.power) : 0;
  return (
    <>
      <div className="game-bottom-strip">
        <span>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            POWER{" "}
          </span>
          <strong>{myPower}</strong>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {" · "}Queue{" "}
          </span>
          <strong>{active?.length ?? 0}</strong>
        </span>
        <button
          type="button"
          className="secondary"
          onClick={() => setSheetOpen(true)}
        >
          Queue ▾
        </button>
      </div>
      {sheetOpen && (
        <Drawer
          onClose={() => setSheetOpen(false)}
          title="Game summary"
          bottom
        >
          <section>
            <h4 style={{ margin: "0 0 0.5rem 0" }}>Call Queue</h4>
            <CallQueueRail
              gameId={gameId}
              isGm={viewer.isGm}
              noteCounts={noteCounts}
            />
          </section>
          <section>
            <h4 style={{ margin: "0 0 0.5rem 0" }}>POWER Standings</h4>
            <PowerStandingsRail
              viewer={viewer}
              roster={roster}
              powerByPlayer={powerByPlayer}
              balancesLoading={false}
            />
          </section>
        </Drawer>
      )}
    </>
  );
}
