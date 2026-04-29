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
import { useHideManagementControls } from "../hooks/useHideManagementControls";
import { NoteIcon, NoteList, NoteCreateForm, buildListArgs } from "../components/NoteIcon";
import { RollSetDisplay } from "../components/RollSetDisplay";
import { Drawer } from "../components/Drawer";
import { GmTodoDrawer } from "../components/GmTodoDrawer";

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

  const [hideManagementControls, setHideManagementControls] =
    useHideManagementControls(gid);

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
        hideManagementControls={hideManagementControls}
        onHideManagementControlsChange={setHideManagementControls}
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
        {showRail && (
          <aside className="game-rail" aria-label="Game summary rail">
            <section>
              <h3>Call Queue</h3>
              <CallQueueRail
                gameId={gid}
                isGm={viewer.isGm}
                noteCounts={noteCounts}
                hideManagementControls={hideManagementControls}
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

        <div className="game-main">
          <CurrentCallSection
            gameId={gid}
            viewerIsGm={viewer.isGm}
            hideManagementControls={hideManagementControls}
          />

          <section>
            <h3 style={{ marginTop: 0 }}>Roster</h3>
            <RosterList
              gameId={gid}
              gameState={gameState}
              viewer={viewer}
              roster={roster}
              powerByPlayer={powerByPlayer}
              noteCounts={noteCounts}
              hideManagementControls={hideManagementControls}
            />
          </section>

          <PublicBidSection
            gameId={gid}
            gameState={gameState}
            viewerIsGm={viewer.isGm}
          />

          <TreasonGrantsSection
            gameId={gid}
            gameState={gameState}
            viewerIsGm={viewer.isGm}
            hideManagementControls={hideManagementControls}
          />

          <GoalsSection
            gameId={gid}
            gameState={gameState}
            viewerIsGm={viewer.isGm}
            viewerPlayerId={viewer.playerId}
            hideManagementControls={hideManagementControls}
          />

          {viewer.isGm && gameState === "ready" && (
            <section>
              <h3>Add Player</h3>
              <AddPlayerForm gameId={gid} />
            </section>
          )}

          {!viewer.isGm && viewer.playerId && gameState === "ready" && (
            <section>
              <h3>Your Syndicate</h3>
              {(() => {
                const selectedSyndicateId =
                  roster.find((p) => p._id === viewer.playerId)
                    ?.selectedSyndicateId ?? null;
                return (
                  <div className="stack">
                    <SyndicateSelector
                      gameId={gid}
                      currentSelection={selectedSyndicateId}
                    />
                    {selectedSyndicateId && (
                      <SelectedSyndicateDetails
                        syndicateId={selectedSyndicateId}
                      />
                    )}
                  </div>
                );
              })()}
            </section>
          )}
        </div>
      </div>

      {showYouStrip && (
        <BottomStrip
          gameId={gid}
          viewer={viewer}
          roster={roster}
          powerByPlayer={powerByPlayer}
          hideManagementControls={hideManagementControls}
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
  hideManagementControls,
  onHideManagementControlsChange,
}: {
  gameId: GameId;
  gameName: string;
  gameState: GameState;
  gmName: string;
  viewerIsGm: boolean;
  startedAt: number | null;
  rosterSize: number;
  gameNoteCount: number;
  hideManagementControls: boolean;
  onHideManagementControlsChange: (next: boolean) => void;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const [gmToolsOpen, setGmToolsOpen] = useState(false);
  const [gmTodoOpen, setGmTodoOpen] = useState(false);
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
          <button
            type="button"
            className="secondary"
            onClick={() => setGmToolsOpen(true)}
          >
            GM Tools
          </button>
        )}
        {viewerIsGm && (
          <button
            type="button"
            className="secondary"
            onClick={() => setGmTodoOpen(true)}
          >
            GM Todo
          </button>
        )}
        <NoteIcon
          gameId={gameId}
          target={{ kind: "game" }}
          count={gameNoteCount}
          label={gameName}
          hideManagementControls={hideManagementControls}
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
      {viewerIsGm && gmToolsOpen && (
        <GmToolsDrawer
          gameId={gameId}
          gameState={gameState}
          rosterSize={rosterSize}
          hideManagementControls={hideManagementControls}
          onHideManagementControlsChange={onHideManagementControlsChange}
          onClose={() => setGmToolsOpen(false)}
        />
      )}
      {viewerIsGm && gmTodoOpen && (
        <GmTodoDrawer
          gameId={gameId}
          onClose={() => setGmTodoOpen(false)}
        />
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

// ───────────────────────────────────────────────────────────────────────────
// GM Tools drawer
//
// A sectioned drawer for rarely-used GM utilities. Each tool occupies its
// own <section> so future additions are purely additive and don't require
// restructuring the layout.
// ───────────────────────────────────────────────────────────────────────────

function GmToolsDrawer({
  gameId,
  gameState,
  rosterSize,
  hideManagementControls,
  onHideManagementControlsChange,
  onClose,
}: {
  gameId: GameId;
  gameState: GameState;
  rosterSize: number;
  hideManagementControls: boolean;
  onHideManagementControlsChange: (next: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Drawer onClose={onClose} title="GM Tools">
      <section>
        <h4 style={{ margin: "0 0 0.5rem 0" }}>Game state</h4>
        <GameStateTransitionControls
          gameId={gameId}
          gameState={gameState}
          rosterSize={rosterSize}
        />
      </section>
      <section style={{ marginTop: "1rem" }}>
        <h4 style={{ margin: "0 0 0.5rem 0" }}>Display</h4>
        <label
          className="row"
          style={{ alignItems: "center", gap: "0.5rem", cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={hideManagementControls}
            onChange={(e) => onHideManagementControlsChange(e.target.checked)}
          />
          <span>Hide management controls</span>
        </label>
        <div
          className="muted"
          style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}
        >
          Hides + New Grant, + New Goal, and the Edit / Clear owner / Delete
          buttons on Treason Grants and Goals. The toggle is remembered for
          this game.
        </div>
      </section>
    </Drawer>
  );
}

function GameStateTransitionControls({
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
  const [busy, setBusy] = useState(false);

  async function go(target: "playing" | "archived", confirmMessage: string) {
    if (!window.confirm(confirmMessage)) return;
    setErr(null);
    setBusy(true);
    try {
      await transition({ gameId, target });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Transition failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {gameState === "ready" && (
        <div className="row-wrap" style={{ gap: "0.5rem" }}>
          <button
            type="button"
            onClick={() =>
              void go(
                "playing",
                "Start the game now? Players will no longer be able to change their Syndicate selection.",
              )
            }
            disabled={busy || rosterSize === 0}
            title={
              rosterSize === 0 ? "Add at least one Player first." : undefined
            }
          >
            Start game
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void go("archived", "Archive this game?")}
            disabled={busy}
          >
            Archive
          </button>
        </div>
      )}
      {gameState === "playing" && (
        <div className="row-wrap" style={{ gap: "0.5rem" }}>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void go(
                "archived",
                "Archive this game? It will become read-only.",
              )
            }
            disabled={busy}
          >
            Archive
          </button>
        </div>
      )}
      {gameState === "archived" && (
        <div className="muted">Game is archived.</div>
      )}
      {err && <div className="error-text">{err}</div>}
    </div>
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
      {gameState === "playing" && <CustomCallButton gameId={gameId} />}
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

function CustomCallButton({ gameId }: { gameId: GameId }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={anchorRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button type="button" onClick={() => setOpen((o) => !o)}>
        Custom Call
      </button>
      {open && (
        <ActionPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          title="Custom Call"
        >
          <CustomCallForm gameId={gameId} onSuccess={() => setOpen(false)} />
        </ActionPopover>
      )}
    </div>
  );
}

function CustomCallForm({
  gameId,
  onSuccess,
}: {
  gameId: GameId;
  onSuccess: () => void;
}) {
  const addOrReplaceCustomCall = useMutation(api.calls.addOrReplaceCustomCall);
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(value: string) {
    setErr(null);
    setBusy(true);
    try {
      await addOrReplaceCustomCall({ gameId, label: value });
      setLabel("");
      onSuccess();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not post custom call.");
    } finally {
      setBusy(false);
    }
  }

  const trimmed = label.trim();

  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (trimmed.length === 0) return;
        void submit(trimmed);
      }}
      className="stack"
    >
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label (e.g. Need GM)"
        aria-label="Custom call label"
        maxLength={80}
        style={{ width: "100%" }}
      />
      <div className="muted" style={{ fontSize: "0.85rem" }}>
        Replaces your current call, if any.
      </div>
      {err && <div className="error-text">{err}</div>}
      <div className="row-wrap" style={{ gap: "0.5rem" }}>
        <button type="submit" disabled={busy || trimmed.length === 0}>
          {busy ? "Posting…" : "Add custom call"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          title="Posts the text 'Private Call' to the queue."
          onClick={() => void submit("Private Call")}
        >
          Private Call
        </button>
      </div>
    </form>
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
          wide
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
  wide = false,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
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
      className={`action-popover${wide ? " wide" : ""}`}
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
// Game log drawer
//
// Drawer primitive itself lives in `src/components/Drawer.tsx` so other
// drawer consumers can reuse it without importing this 4000-line module.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Game log drawer.
 *
 * Section-based: each event source lives in its own section so the
 * layout extends without re-architecting.
 *   - Recently removed calls
 *   - Past Public Bids (Rule 27, only rendered if the game has any
 *     archived bid rounds)
 */
function GameLogDrawer({
  gameId,
  onClose,
}: {
  gameId: GameId;
  onClose: () => void;
}) {
  const removed = useQuery(api.calls.recentlyRemovedCalls, { gameId });
  const archivedBids = useQuery(api.publicBids.listArchivedBidRounds, {
    gameId,
  });
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
                {c.kind === "minion" ? (
                  <>
                    <span className="muted"> called </span>
                    <strong>{c.minionName}</strong>
                  </>
                ) : (
                  <>
                    <span className="muted"> posted </span>
                    <strong>{c.label}</strong>
                  </>
                )}
              </div>
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                Removed {new Date(c.removedAt).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      </section>
      {archivedBids && archivedBids.length > 0 && (
        <section style={{ marginTop: "1rem" }}>
          <h4 style={{ margin: "0 0 0.5rem 0" }}>Past Public Bids</h4>
          <ArchivedBidsList rows={archivedBids} />
        </section>
      )}
    </Drawer>
  );
}

type ArchivedBidsListRow = {
  _id: Id<"bidRounds">;
  label: string | undefined;
  createdAt: number;
  closedAt: number | null;
  archivedAt: number;
  wasSettled: boolean;
  bidCount: number;
  totalPaid: number;
};

function ArchivedBidsList({ rows }: { rows: ArchivedBidsListRow[] }) {
  const [expanded, setExpanded] = useState<Id<"bidRounds"> | null>(null);
  return (
    <div>
      {rows.map((r) => {
        const isOpen = expanded === r._id;
        const label = r.label && r.label.length > 0 ? r.label : "Public bid";
        return (
          <div key={r._id} className="row-divider">
            <div
              className="row"
              role="button"
              tabIndex={0}
              onClick={() => setExpanded(isOpen ? null : r._id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setExpanded(isOpen ? null : r._id);
                }
              }}
              style={{
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.5rem",
                cursor: "pointer",
              }}
              aria-expanded={isOpen}
            >
              <span className="row-wrap" style={{ gap: "0.5rem", minWidth: 0 }}>
                <span aria-hidden="true" style={{ color: "var(--fg-muted)" }}>
                  {isOpen ? "▾" : "▸"}
                </span>
                <strong>{label}</strong>
                <span
                  className={`badge ${r.wasSettled ? "" : "danger"}`}
                  style={{ fontSize: "0.7rem" }}
                >
                  {r.wasSettled ? "Settled" : "Cancelled"}
                </span>
              </span>
              <span className="row-wrap" style={{ gap: "0.5rem" }}>
                {r.wasSettled && (
                  <span style={{ fontSize: "0.85rem" }}>
                    <strong>{r.totalPaid}</strong>
                    <span
                      className="muted"
                      style={{ fontSize: "0.8rem" }}
                    >
                      {" "}
                      POWER · {r.bidCount} bidder
                      {r.bidCount === 1 ? "" : "s"}
                    </span>
                  </span>
                )}
                {!r.wasSettled && (
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    {r.bidCount} bid{r.bidCount === 1 ? "" : "s"}
                  </span>
                )}
                <span className="muted" style={{ fontSize: "0.8rem" }}>
                  {new Date(r.archivedAt).toLocaleTimeString()}
                </span>
              </span>
            </div>
            {isOpen && (
              <div style={{ marginTop: "0.4rem", marginLeft: "1rem" }}>
                <ArchivedBidExpansion roundId={r._id} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ArchivedBidExpansion({ roundId }: { roundId: Id<"bidRounds"> }) {
  const data = useQuery(api.publicBids.getRoundBids, { roundId });
  if (data === undefined) return <div className="muted">Loading…</div>;
  if (data === null) return <div className="muted">Round not found.</div>;
  if (data.bids.length === 0) {
    return <div className="muted">No bids were placed.</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Bidder</th>
          <th style={{ textAlign: "right" }}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {data.bids.map((b) => (
          <tr key={b._id}>
            <td>
              {b.displayName}
              {b.isMine && (
                <span className="muted" style={{ fontSize: "0.75rem" }}>
                  {" "}
                  (you)
                </span>
              )}
            </td>
            <td
              style={{
                textAlign: "right",
                fontFamily: "var(--font-mono)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <strong>{b.amount}</strong>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
  hideManagementControls,
}: {
  gameId: GameId;
  gameState: GameState;
  viewer: Viewer;
  roster: RosterEntry[];
  powerByPlayer: Map<PlayerId, number>;
  noteCounts: ReturnType<typeof useNotesCountMap>;
  hideManagementControls: boolean;
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
          hideManagementControls={hideManagementControls}
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
  hideManagementControls,
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
  hideManagementControls: boolean;
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
                  hideManagementControls={hideManagementControls}
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
            hideManagementControls={hideManagementControls}
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
  hideManagementControls,
}: {
  gameId: GameId;
  playerId: PlayerId;
  gameState: GameState;
  noteCounts: ReturnType<typeof useNotesCountMap>;
  hideManagementControls: boolean;
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
                hideManagementControls={hideManagementControls}
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
  hideManagementControls,
}: {
  gameId: GameId;
  isGm: boolean;
  noteCounts: ReturnType<typeof useNotesCountMap>;
  hideManagementControls: boolean;
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
          {active.map((c, i) => (
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
                  {c.kind === "minion" ? (
                    <strong>{c.minionName}</strong>
                  ) : (
                    <strong>{c.label}</strong>
                  )}
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    {" · "}
                    {new Date(c.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                <span className="row" style={{ gap: "0.25rem" }}>
                  {c.kind === "minion" && (
                    <NoteIcon
                      gameId={gameId}
                      target={{ kind: "minion", minionId: c.minionId }}
                      count={resolveNoteCount(noteCounts, {
                        kind: "minion",
                        minionId: c.minionId,
                      })}
                      label={c.minionName}
                      hideManagementControls={hideManagementControls}
                    />
                  )}
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
              {/* Dice: only for the FIFO head, only for GMs, only for
                  minion-kind rows. The `rolls` field is omitted from
                  non-GM payloads AND from custom rows (Task 6), so a
                  Player will never satisfy this branch and a custom
                  head will never render dice. */}
              {isGm && i === 0 && c.kind === "minion" && "rolls" in c && (
                <div style={{ marginTop: "0.4rem" }}>
                  <RollSetDisplay
                    rolls={c.rolls ?? null}
                    size="sm"
                  />
                </div>
              )}
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
// Selected syndicate details (ready state, non-GM, read-only)
// ───────────────────────────────────────────────────────────────────────────

function SelectedSyndicateDetails({
  syndicateId,
}: {
  syndicateId: Id<"syndicates">;
}) {
  const data = useQuery(api.syndicates.getWithChildren, { syndicateId });

  if (data === undefined) {
    return (
      <div className="card stack">
        <div className="muted">Loading syndicate details…</div>
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="card stack">
        <div className="muted">Syndicate not accessible.</div>
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="row-wrap" style={{ justifyContent: "space-between" }}>
        <strong>{data.name}</strong>
        <span className="row-wrap">
          {data.played && <span className="badge warning">Played</span>}
          {data.isShared && <span className="badge accent">Shared</span>}
        </span>
      </div>
      <div className="muted" style={{ fontSize: "0.9rem" }}>
        Leader {data.leader}
      </div>

      <div>
        {data.description.trim().length > 0 ? (
          <div style={{ whiteSpace: "pre-wrap" }}>{data.description}</div>
        ) : (
          <div className="muted">No description.</div>
        )}
      </div>

      <div>
        <h4 style={{ margin: "0 0 0.5rem 0" }}>
          Drawbacks ({data.drawbacks.length}/5)
        </h4>
        {data.drawbacks.length === 0 ? (
          <div className="muted">No drawbacks.</div>
        ) : (
          <div className="stack">
            {data.drawbacks.map((d) => (
              <div key={d._id} className="row-divider">
                <div style={{ fontWeight: 600 }}>{d.name}</div>
                {d.description.trim().length > 0 && (
                  <div
                    className="muted"
                    style={{ fontSize: "0.9rem", whiteSpace: "pre-wrap" }}
                  >
                    {d.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h4 style={{ margin: "0 0 0.5rem 0" }}>
          Minions ({data.minions.length}/8)
        </h4>
        {data.minions.length === 0 ? (
          <div className="muted">No Minions.</div>
        ) : (
          <div className="stack">
            {data.minions.map((m) => (
              <div key={m._id} className="row-divider">
                <div className="row-wrap" style={{ alignItems: "baseline" }}>
                  <strong>{m.name}</strong>
                  {m.accent && (
                    <span
                      className="muted"
                      style={{ fontSize: "0.85rem" }}
                    >
                      {m.accent}
                    </span>
                  )}
                </div>
                {m.description && m.description.trim().length > 0 && (
                  <div
                    style={{
                      fontSize: "0.9rem",
                      whiteSpace: "pre-wrap",
                      marginTop: "0.25rem",
                    }}
                  >
                    {m.description}
                  </div>
                )}
                {m.skills.length > 0 && (
                  <div
                    className="muted"
                    style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}
                  >
                    Skills: {m.skills.join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <Link to={`/syndicates/${syndicateId}`} className="muted">
          Open in Syndicate Editor →
        </Link>
      </div>
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
  hideManagementControls,
}: {
  gameId: GameId;
  viewer: Viewer;
  roster: RosterEntry[];
  powerByPlayer: Map<PlayerId, number>;
  hideManagementControls: boolean;
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
              hideManagementControls={hideManagementControls}
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

// ───────────────────────────────────────────────────────────────────────────
// Current Call (Rule 22) — GM-only deep-dive on the FIFO head
// ───────────────────────────────────────────────────────────────────────────

/**
 * GM-only section that pins the head of the call queue at the top of the
 * game-main column with all the context the GM needs to resolve it: the
 * caller, the called minion (accent, description, skills), the minion's
 * owning syndicate + drawbacks, the latest 5 notes on that minion, and an
 * inline create-note form. Returns `null` for non-GMs (and never
 * subscribes to the underlying queries) so Players issue zero extra
 * requests. The empty state ("No active call.") still renders for the GM
 * so the section's presence is discoverable.
 */
function CurrentCallSection({
  gameId,
  viewerIsGm,
  hideManagementControls,
}: {
  gameId: GameId;
  viewerIsGm: boolean;
  hideManagementControls: boolean;
}) {
  // Skip both subscriptions for non-GMs — defence in depth alongside the
  // server-side `requireGameGm` in `getCurrentCallDetails`.
  const data = useQuery(
    api.calls.getCurrentCallDetails,
    viewerIsGm ? { gameId } : "skip",
  );
  const removeCall = useMutation(api.calls.removeCall);
  const deleteNote = useMutation(api.notes.deleteNote);
  // Note timers v1: cycle the timer state on the GM-only timer cell.
  // The server enforces GM-only via `requireGameGm`, so this hook is
  // safe to call from the Player branch's mounted-but-unused state
  // (the early `if (!viewerIsGm) return null` below short-circuits
  // the JSX path before the mutation can ever fire).
  const cycleNoteTimer = useMutation(api.notes.cycleNoteTimer);

  // Notes only attach to a minion-kind head. Gate on `data.kind` so a
  // custom head doesn't subscribe `listNotesForTarget` against an
  // absent `data.minion._id` (which would crash the hook).
  const minionId =
    data && data.kind === "minion" ? data.minion._id : null;
  const noteListArgs = useMemo(() => {
    if (!minionId) return null;
    return buildListArgs(gameId, { kind: "minion", minionId });
  }, [gameId, minionId]);
  const notes = useQuery(
    api.notes.listNotesForTarget,
    noteListArgs ?? "skip",
  );

  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const [noteErr, setNoteErr] = useState<string | null>(null);

  if (!viewerIsGm) return null;

  async function handleRemoveCall(callId: Id<"calls">) {
    setRemoveErr(null);
    try {
      await removeCall({ callId });
    } catch (e) {
      setRemoveErr(e instanceof Error ? e.message : "Remove failed.");
    }
  }

  async function handleDeleteNote(noteId: Id<"notes">) {
    if (!window.confirm("Delete this note? This cannot be undone.")) return;
    setNoteErr(null);
    try {
      await deleteNote({ noteId });
    } catch (e) {
      setNoteErr(e instanceof Error ? e.message : "Failed to delete note.");
    }
  }

  async function handleCycleTimer(noteId: Id<"notes">) {
    setNoteErr(null);
    try {
      await cycleNoteTimer({ noteId });
    } catch (e) {
      setNoteErr(e instanceof Error ? e.message : "Failed to cycle timer.");
    }
  }

  // Loading: don't flash empty state.
  if (data === undefined) {
    return (
      <section>
        <h3 style={{ marginTop: 0 }}>Current Call</h3>
        <div className="muted">Loading…</div>
      </section>
    );
  }

  // Empty: queue empty (or defensive null for missing joins).
  if (data === null) {
    return (
      <section>
        <h3 style={{ marginTop: 0 }}>Current Call</h3>
        <div className="muted">No active call.</div>
      </section>
    );
  }

  // Custom head: render just the caller / label / time / Remove header.
  // Custom calls have no minion, syndicate, drawbacks, or rolls — there
  // is no Context column or Notes column to render.
  if (data.kind === "custom") {
    return (
      <section>
        <h3 style={{ marginTop: 0 }}>Current Call</h3>
        <div className="card tight" style={{ marginBottom: "0.75rem" }}>
          {removeErr && <div className="error-text">{removeErr}</div>}
          <div
            className="row"
            style={{
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <strong>{data.call.playerName}</strong>
              <span className="muted"> → </span>
              <strong>{data.label}</strong>
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                {" · "}
                {new Date(data.call.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <span
              className="row"
              style={{ gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
            >
              <button
                type="button"
                className="danger"
                onClick={() => void handleRemoveCall(data.call._id)}
                aria-label="Remove call"
              >
                Remove call
              </button>
            </span>
          </div>
          <div
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}
          >
            Custom calls have no Minion or Syndicate context.
          </div>
        </div>
      </section>
    );
  }

  // Minion head: existing render path. From here `data.kind === "minion"`,
  // so `data.minion`, `data.syndicate`, and `data.rolls` are all in scope.
  const visibleNotes = notes ? notes.slice(0, 5) : undefined;
  const olderCount = notes ? Math.max(0, notes.length - 5) : 0;

  return (
    <section>
      <h3 style={{ marginTop: 0 }}>Current Call</h3>

      {/* Header row: caller → minion + time + dice + Remove button */}
      <div className="card tight" style={{ marginBottom: "0.75rem" }}>
        {removeErr && <div className="error-text">{removeErr}</div>}
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <strong>{data.call.playerName}</strong>
            <span className="muted"> → </span>
            <strong>{data.minion.name}</strong>
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              {" · "}
              {new Date(data.call.createdAt).toLocaleTimeString()}
            </span>
          </div>
          <span
            className="row"
            style={{ gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
          >
            <RollSetDisplay rolls={data.rolls} size="md" />
            <NoteIcon
              gameId={gameId}
              target={{ kind: "minion", minionId: data.minion._id }}
              count={notes?.length ?? 0}
              label={data.minion.name}
              hideManagementControls={hideManagementControls}
            />
            <button
              type="button"
              className="danger"
              onClick={() => void handleRemoveCall(data.call._id)}
              aria-label="Remove call"
            >
              Remove call
            </button>
          </span>
        </div>
      </div>

      {/* Two-column body: Context (left) | Notes (right). Collapses to one
          column under 900px via the existing `section-grid` rule. */}
      <div className="section-grid">
        {/* Context column */}
        <section>
          <div className="card tight stack">
            <div>
              <div className="row-wrap" style={{ alignItems: "baseline" }}>
                <strong>{data.minion.name}</strong>
                {data.minion.accent && (
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    {data.minion.accent}
                  </span>
                )}
              </div>
              {data.minion.description &&
                data.minion.description.trim().length > 0 && (
                  <div
                    style={{
                      whiteSpace: "pre-wrap",
                      marginTop: "0.25rem",
                      fontSize: "0.95rem",
                    }}
                  >
                    {data.minion.description}
                  </div>
                )}
              {data.minion.skills.length > 0 && (
                <div
                  className="row-wrap"
                  style={{ gap: "0.25rem", marginTop: "0.5rem" }}
                >
                  {data.minion.skills.map((s, i) => (
                    <span key={`${s}-${i}`} className="badge">
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h4 style={{ margin: "0 0 0.25rem 0" }}>Syndicate</h4>
              <div>
                <strong>{data.syndicate.name}</strong>
              </div>
              <div className="muted" style={{ fontSize: "0.9rem" }}>
                Leader {data.syndicate.leader}
              </div>
            </div>

            <div>
              {/*
                Drawback rows render only (name, description) here, even
                for `isRolled === true` drawbacks. The abbreviation and
                isRolled flag are intentionally not surfaced in this
                list: the abbreviation appears solely as the dice-cell
                caption inside `RollSetDisplay`. Do not "helpfully" add
                a badge or "Rolled" marker here — see the visibility
                contract in `plans/2026-04-28-drawback-rolls-v1.md`.
              */}
              <h4 style={{ margin: "0 0 0.25rem 0" }}>
                Drawbacks ({data.syndicate.drawbacks.length})
              </h4>
              {data.syndicate.drawbacks.length === 0 ? (
                <div className="muted">No drawbacks.</div>
              ) : (
                <div className="stack">
                  {data.syndicate.drawbacks.map((d) => (
                    <div key={d._id} className="row-divider">
                      <div style={{ fontWeight: 600 }}>{d.name}</div>
                      {d.description.trim().length > 0 && (
                        <div
                          className="muted"
                          style={{
                            fontSize: "0.9rem",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {d.description}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Notes column */}
        <section>
          <div className="card tight stack">
            <div>
              <h4 style={{ margin: "0 0 0.5rem 0" }}>
                Latest notes
                {visibleNotes !== undefined && ` (${visibleNotes.length})`}
              </h4>
              {noteErr && <div className="error-text">{noteErr}</div>}
              <NoteList
                notes={visibleNotes}
                onDelete={handleDeleteNote}
                onCycleTimer={handleCycleTimer}
                hideManagementControls={hideManagementControls}
              />
              {olderCount > 0 && (
                <div
                  className="muted"
                  style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}
                >
                  +{olderCount} older
                </div>
              )}
            </div>

            <div>
              <h4 style={{ margin: "0 0 0.5rem 0" }}>Add a note</h4>
              <NoteCreateForm
                gameId={gameId}
                target={{ kind: "minion", minionId: data.minion._id }}
                /* The Current Call section only renders for the GM, and
                   the head minion is by definition the active head, so
                   timer eligibility is always true here. The server
                   re-validates so this gate is a UX optimisation, not
                   a security boundary. */
                timerEligible={true}
              />
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Treason Grants (Rule 26)
// ───────────────────────────────────────────────────────────────────────────

type GrantRow = {
  _id: Id<"treasonGrants">;
  keyword: string;
  power: number;
  description: string | null;
  ownerPlayerId: Id<"players"> | null;
  ownerDisplayName: string | null;
  takenAt: number | null;
  createdAt: number;
  isMine: boolean;
  canTake: boolean;
  canEditPower: boolean;
};

function TreasonGrantsSection({
  gameId,
  gameState,
  viewerIsGm,
  hideManagementControls,
}: {
  gameId: GameId;
  gameState: GameState;
  viewerIsGm: boolean;
  hideManagementControls: boolean;
}) {
  // Players never see Grants while the game is still being assembled.
  // GMs always see the panel so they can author grants pre-game.
  // Subscribe unconditionally so hook order is stable; skip the query
  // when the panel is hidden so we don't load data we won't render.
  const hidden = !viewerIsGm && gameState === "ready";
  const data = useQuery(
    api.treasonGrants.listGrantsForGame,
    hidden ? "skip" : { gameId },
  );
  if (hidden) return null;
  const writable = viewerIsGm && gameState !== "archived";
  const showCreateForm = writable && !hideManagementControls;

  return (
    <section>
      <div
        className="row"
        style={{ alignItems: "center", justifyContent: "space-between" }}
      >
        <h3 style={{ marginTop: 0 }}>Treason Grants</h3>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          {data ? `${data.grants.length} total` : ""}
        </span>
      </div>
      {showCreateForm && <NewGrantForm gameId={gameId} />}
      {data === undefined ? (
        <div className="muted">Loading…</div>
      ) : data.grants.length === 0 ? (
        <div className="muted">
          {viewerIsGm && !hideManagementControls
            ? "No grants yet. Author a treason grant to seed the pool."
            : viewerIsGm
              ? "No grants yet."
              : "No grants on offer."}
        </div>
      ) : (
        <div className="card" style={{ padding: "0.25rem 0.5rem" }}>
          {data.grants.map((g) => (
            <TreasonGrantRow
              key={g._id}
              grant={g}
              viewerIsGm={viewerIsGm}
              gameState={gameState}
              hideManagementControls={hideManagementControls}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function NewGrantForm({ gameId }: { gameId: GameId }) {
  const create = useMutation(api.treasonGrants.createGrant);
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [power, setPower] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setKeyword("");
    setPower("");
    setDescription("");
    setErr(null);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const n = Number(power);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      setErr("POWER must be a positive integer.");
      return;
    }
    setBusy(true);
    try {
      await create({
        gameId,
        keyword,
        power: n,
        description,
      });
      reset();
      setOpen(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={{ marginBottom: "0.5rem" }}>
        <button type="button" onClick={() => setOpen(true)}>
          + New Grant
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="card stack"
      style={{ marginBottom: "0.5rem" }}
    >
      <div className="row-wrap" style={{ gap: "0.5rem" }}>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="Keyword (1–40 chars)"
          aria-label="Keyword"
          maxLength={40}
          style={{ flex: 1, minWidth: "10rem" }}
        />
        <input
          value={power}
          onChange={(e) => setPower(e.target.value)}
          placeholder="POWER"
          aria-label="POWER amount"
          style={{ width: "6rem" }}
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (visible only to the owner once taken)"
        aria-label="Description"
        rows={3}
        maxLength={2000}
        style={{ width: "100%", resize: "vertical" }}
      />
      {err && <div className="error-text">{err}</div>}
      <div className="row" style={{ gap: "0.5rem" }}>
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function TreasonGrantRow({
  grant,
  viewerIsGm,
  gameState,
  hideManagementControls,
}: {
  grant: GrantRow;
  viewerIsGm: boolean;
  gameState: GameState;
  hideManagementControls: boolean;
}) {
  const take = useMutation(api.treasonGrants.takeGrant);
  const remove = useMutation(api.treasonGrants.deleteGrant);
  const clearOwner = useMutation(api.treasonGrants.clearGrantOwner);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const writable = viewerIsGm && gameState !== "archived";
  const showRowManagement = writable && !hideManagementControls;
  const owned = grant.ownerPlayerId !== null;

  async function handleTake() {
    if (
      !window.confirm(
        `Take grant '${grant.keyword}' for +${grant.power} POWER?`,
      )
    ) {
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await take({ grantId: grant._id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Take failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const msg = owned
      ? `Delete grant '${grant.keyword}'? POWER already paid out is NOT refunded.`
      : `Delete grant '${grant.keyword}'?`;
    if (!window.confirm(msg)) return;
    setErr(null);
    setBusy(true);
    try {
      await remove({ grantId: grant._id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    if (
      !window.confirm(
        `Clear owner of '${grant.keyword}'? POWER is NOT refunded; the grant becomes takeable again.`,
      )
    ) {
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await clearOwner({ grantId: grant._id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Clear failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row-divider">
      <div
        className="row-wrap"
        style={{
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <span
          className="row-wrap"
          style={{ alignItems: "center", gap: "0.5rem", minWidth: 0 }}
        >
          <strong>{grant.keyword}</strong>
          <span className="badge accent" style={{ fontSize: "0.75rem" }}>
            +{grant.power} POWER
          </span>
          {owned ? (
            <span
              className={`badge ${grant.isMine ? "success" : ""}`}
              style={{ fontSize: "0.75rem" }}
            >
              {grant.isMine
                ? "Yours"
                : `Held by ${grant.ownerDisplayName ?? "Unknown"}`}
            </span>
          ) : (
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              Unowned
            </span>
          )}
        </span>
        <span className="row-wrap" style={{ gap: "0.4rem" }}>
          {grant.canTake && (
            <button
              type="button"
              onClick={() => void handleTake()}
              disabled={busy}
              style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
            >
              {busy ? "Taking…" : "Take"}
            </button>
          )}
          {showRowManagement && (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing((v) => !v)}
                disabled={busy}
                style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
              >
                {editing ? "Cancel" : "Edit"}
              </button>
              {owned && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void handleClear()}
                  disabled={busy}
                  style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
                >
                  Clear owner
                </button>
              )}
              <button
                type="button"
                className="danger"
                onClick={() => void handleDelete()}
                disabled={busy}
                style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
              >
                Delete
              </button>
            </>
          )}
        </span>
      </div>
      {err && <div className="error-text">{err}</div>}
      {editing && writable && (
        <GrantEditor
          grant={grant}
          onDone={() => {
            setEditing(false);
            setErr(null);
          }}
        />
      )}
      {grant.description !== null && grant.description.length > 0 && (
        <div style={{ marginTop: "0.25rem" }}>
          <p
            style={{
              whiteSpace: "pre-wrap",
              margin: 0,
              fontSize: "0.9rem",
            }}
          >
            {grant.description}
          </p>
        </div>
      )}
    </div>
  );
}

function GrantEditor({
  grant,
  onDone,
}: {
  grant: GrantRow;
  onDone: () => void;
}) {
  const update = useMutation(api.treasonGrants.updateGrant);
  const [keyword, setKeyword] = useState(grant.keyword);
  const [power, setPower] = useState(String(grant.power));
  const [description, setDescription] = useState(grant.description ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const powerLocked = !grant.canEditPower;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const patch: {
      grantId: Id<"treasonGrants">;
      keyword?: string;
      power?: number;
      description?: string;
    } = { grantId: grant._id };
    const trimmedKeyword = keyword.trim();
    if (trimmedKeyword !== grant.keyword) patch.keyword = keyword;
    if (description !== (grant.description ?? "")) {
      patch.description = description;
    }
    if (!powerLocked) {
      const n = Number(power);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        setErr("POWER must be a positive integer.");
        return;
      }
      if (n !== grant.power) patch.power = n;
    }
    setBusy(true);
    try {
      await update(patch);
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="stack"
      style={{
        marginTop: "0.5rem",
        paddingTop: "0.5rem",
        borderTop: "1px dashed var(--border)",
      }}
    >
      <div className="row-wrap" style={{ gap: "0.5rem" }}>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          aria-label="Keyword"
          maxLength={40}
          style={{ flex: 1, minWidth: "10rem" }}
        />
        <input
          value={power}
          onChange={(e) => setPower(e.target.value)}
          aria-label="POWER amount"
          disabled={powerLocked}
          title={
            powerLocked
              ? "POWER is locked because this Grant has been taken."
              : undefined
          }
          style={{ width: "6rem" }}
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        aria-label="Description"
        rows={3}
        maxLength={2000}
        style={{ width: "100%", resize: "vertical" }}
      />
      {powerLocked && (
        <div className="muted" style={{ fontSize: "0.8rem" }}>
          POWER is locked because this Grant has been taken.
        </div>
      )}
      {err && <div className="error-text">{err}</div>}
      <div className="row" style={{ gap: "0.5rem" }}>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onDone}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Public Bids (Rule 27)
// ───────────────────────────────────────────────────────────────────────────

type ActiveBidRound = {
  _id: Id<"bidRounds">;
  status: "open" | "closed";
  label: string | undefined;
  createdAt: number;
  createdByUserId: Id<"users">;
  closedAt: number | null;
  closedByUserId: Id<"users"> | null;
};

type ActiveBidRow = {
  _id: Id<"bids">;
  playerId: PlayerId;
  displayName: string;
  amount: number;
  updatedAt: number;
  isMine: boolean;
};

type PendingBidder = {
  playerId: PlayerId;
  displayName: string;
};

type ActiveBidView = {
  round: ActiveBidRound | null;
  bids: ActiveBidRow[];
  pending: PendingBidder[];
  viewerRole: "gm" | "player";
  viewerPlayerId: PlayerId | null;
};

function PublicBidSection({
  gameId,
  gameState,
  viewerIsGm,
}: {
  gameId: GameId;
  gameState: GameState;
  viewerIsGm: boolean;
}) {
  // Hidden in `ready` and `archived` (Decisions 4, 17). Subscribe
  // unconditionally so hook order is stable; skip the query when the
  // panel is hidden.
  const hidden = gameState !== "playing";
  const data = useQuery(
    api.publicBids.getActiveBidRound,
    hidden ? "skip" : { gameId },
  ) as ActiveBidView | undefined;
  if (hidden) return null;
  // Players only see the section when a round actually exists. The
  // GM always sees it (so they can start a round).
  if (!viewerIsGm && (data === undefined || data.round === null)) {
    return null;
  }

  return (
    <section>
      <div
        className="row"
        style={{ alignItems: "center", justifyContent: "space-between" }}
      >
        <h3 style={{ marginTop: 0 }}>Public Bid</h3>
      </div>
      {data === undefined ? (
        <div className="muted">Loading…</div>
      ) : data.round === null ? (
        <NewBidRoundForm gameId={gameId} />
      ) : (
        <ActiveBidPanel data={data} viewerIsGm={viewerIsGm} />
      )}
    </section>
  );
}

function NewBidRoundForm({ gameId }: { gameId: GameId }) {
  const start = useMutation(api.publicBids.startBidRound);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await start({
        gameId,
        label: label.trim().length > 0 ? label : undefined,
      });
      setLabel("");
      setOpen(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Start failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          Start public bid
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="card stack"
      style={{ marginBottom: "0.5rem" }}
    >
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label (optional, ≤120 chars)"
        aria-label="Bid round label"
        maxLength={120}
        style={{ width: "100%" }}
      />
      {err && <div className="error-text">{err}</div>}
      <div className="row" style={{ gap: "0.5rem" }}>
        <button type="submit" disabled={busy}>
          {busy ? "Starting…" : "Start"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setOpen(false);
            setLabel("");
            setErr(null);
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ActiveBidPanel({
  data,
  viewerIsGm,
}: {
  data: ActiveBidView;
  viewerIsGm: boolean;
}) {
  const round = data.round!;
  const close = useMutation(api.publicBids.closeBidRound);
  const archive = useMutation(api.publicBids.archiveBidRound);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isOpen = round.status === "open";

  const label = round.label && round.label.length > 0 ? round.label : "Public bid";

  async function handleClose() {
    if (
      !window.confirm(
        "Close the bid? Each non-zero bidder will pay their bid to the bank. POWER may go negative. This cannot be undone.",
      )
    )
      return;
    setErr(null);
    setBusy(true);
    try {
      await close({ roundId: round._id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Close failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (
      !window.confirm(
        "Cancel the bid? No POWER will be taken. The round will be archived.",
      )
    )
      return;
    setErr(null);
    setBusy(true);
    try {
      await archive({ roundId: round._id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Cancel failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive() {
    if (
      !window.confirm(
        "Archive this bid? It will be hidden from the main panel and remain visible in the Game Log.",
      )
    )
      return;
    setErr(null);
    setBusy(true);
    try {
      await archive({ roundId: round._id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Archive failed.");
    } finally {
      setBusy(false);
    }
  }

  const nonZeroCount = data.bids.filter((b) => b.amount > 0).length;
  const totalPaid = data.bids.reduce(
    (s, b) => s + (b.amount > 0 ? b.amount : 0),
    0,
  );

  return (
    <div className="card stack">
      <div
        className="row-wrap"
        style={{ alignItems: "center", justifyContent: "space-between" }}
      >
        <span className="row-wrap" style={{ alignItems: "center", gap: "0.5rem" }}>
          <strong>{label}</strong>
          {!isOpen && (
            <span className="badge success" style={{ fontSize: "0.7rem" }}>
              Closed
            </span>
          )}
          {isOpen ? (
            <BidElapsed startedAt={round.createdAt} />
          ) : (
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              {round.closedAt !== null && (
                <>Closed {new Date(round.closedAt).toLocaleTimeString()}</>
              )}
            </span>
          )}
        </span>
        {viewerIsGm && (
          <span className="row-wrap" style={{ gap: "0.4rem" }}>
            {isOpen && (
              <>
                <button
                  type="button"
                  onClick={() => void handleClose()}
                  disabled={busy}
                >
                  {busy ? "…" : "Close (collect)"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void handleCancel()}
                  disabled={busy}
                >
                  Cancel (no payment)
                </button>
              </>
            )}
            {!isOpen && (
              <button
                type="button"
                className="secondary"
                onClick={() => void handleArchive()}
                disabled={busy}
              >
                Archive
              </button>
            )}
          </span>
        )}
      </div>
      {err && <div className="error-text">{err}</div>}

      <BidTable bids={data.bids} isOpen={isOpen} />

      {data.pending.length > 0 && (
        <div>
          <div
            className="muted"
            style={{ fontSize: "0.8rem", marginBottom: "0.25rem" }}
          >
            {isOpen ? "Not yet bid" : "Did not bid"}
          </div>
          <div
            className="row-wrap"
            style={{ gap: "0.4rem" }}
          >
            {data.pending.map((p) => (
              <span
                key={p.playerId}
                className="badge"
                style={{ fontSize: "0.75rem" }}
              >
                {p.displayName}
              </span>
            ))}
          </div>
        </div>
      )}

      {!isOpen && (
        <div className="muted" style={{ fontSize: "0.85rem" }}>
          ∑ <strong>{totalPaid}</strong> POWER paid to bank by{" "}
          <strong>{nonZeroCount}</strong> bidder
          {nonZeroCount === 1 ? "" : "s"}.
        </div>
      )}

      {isOpen && data.viewerRole === "player" && data.viewerPlayerId && (
        <BidInputForm
          roundId={round._id}
          currentBid={
            data.bids.find((b) => b.playerId === data.viewerPlayerId)?.amount ??
            null
          }
        />
      )}
    </div>
  );
}

function BidElapsed({ startedAt }: { startedAt: number }) {
  const ms = useElapsed(startedAt);
  return (
    <span className="muted" style={{ fontSize: "0.85rem" }}>
      Open for <strong>{formatElapsed(ms)}</strong>
    </span>
  );
}

function BidTable({
  bids,
  isOpen,
}: {
  bids: ActiveBidRow[];
  isOpen: boolean;
}) {
  if (bids.length === 0) {
    return (
      <div className="muted">
        {isOpen ? "No bids yet." : "No bids were placed."}
      </div>
    );
  }
  return (
    <div>
      {bids.map((b) => (
        <div
          key={b._id}
          className="row-divider"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.5rem",
            // Subtle highlight for the calling player's row using the
            // verified `--bg-muted` theme variable (THEME.md palette).
            background: b.isMine ? "var(--bg-muted)" : undefined,
            padding: b.isMine ? "0.25rem 0.5rem" : undefined,
          }}
        >
          <span style={{ minWidth: 0 }}>
            <strong>{b.displayName}</strong>
            {b.isMine && (
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                {" "}
                (you)
              </span>
            )}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <strong>{b.amount}</strong>
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              {" "}
              POWER
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function BidInputForm({
  roundId,
  currentBid,
}: {
  roundId: Id<"bidRounds">;
  currentBid: number | null;
}) {
  const place = useMutation(api.publicBids.placeBid);
  const [value, setValue] = useState<string>(
    currentBid === null ? "" : String(currentBid),
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-sync the input when the server-side value changes underneath us
  // (e.g. another tab updated). Track the last value we observed.
  const lastSeen = useRef<number | null>(currentBid);
  useEffect(() => {
    if (currentBid !== lastSeen.current) {
      lastSeen.current = currentBid;
      setValue(currentBid === null ? "" : String(currentBid));
    }
  }, [currentBid]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      setErr("Bid must be a non-negative integer.");
      return;
    }
    setBusy(true);
    try {
      await place({ roundId, amount: n });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Submit failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="row-wrap"
      style={{ alignItems: "center", gap: "0.5rem" }}
    >
      <label
        className="muted"
        style={{ fontSize: "0.8rem", letterSpacing: "0.08em" }}
      >
        Your bid
      </label>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0"
        aria-label="Your bid amount"
        inputMode="numeric"
        style={{ width: "6rem" }}
      />
      <button type="submit" disabled={busy}>
        {busy ? "Submitting…" : "Submit"}
      </button>
      {err && (
        <div className="error-text" style={{ flexBasis: "100%" }}>
          {err}
        </div>
      )}
    </form>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Goals (Rule 28)
// ───────────────────────────────────────────────────────────────────────────

type GoalType = "regular" | "shared" | "competitive";

type GoalRow = {
  _id: Id<"goals">;
  keyword: string;
  type: GoalType;
  description: string | null;
  fromPlayerId: Id<"players"> | null;
  fromDisplayName: string | null;
  toPlayerId: Id<"players"> | null;
  toDisplayName: string | null;
  carrot: number | null;
  stick: number | null;
  createdAt: number;
  isFromMe: boolean;
  isToMe: boolean;
  canAssignFromPlayer: boolean;
  canAssignToPlayer: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

type GoalsEligiblePlayer = {
  _id: PlayerId;
  displayName: string;
};

function formatGoalKeyword(keyword: string, type: GoalType): string {
  switch (type) {
    case "regular":
      return keyword;
    case "shared":
      return `${keyword} (S)`;
    case "competitive":
      return `${keyword} (C)`;
  }
}

/**
 * "C/-S" shorthand. `0` is treated identically to "absent" for display
 * purposes so a stored zero never renders as a meaningful 0/0 badge.
 */
function formatCarrotStick(
  carrot: number | null | undefined,
  stick: number | null | undefined,
): string {
  const c = carrot != null && carrot !== 0 ? carrot : null;
  const s = stick != null && stick !== 0 ? stick : null;
  if (c === null && s === null) return "---";
  if (c !== null && s !== null) return `${c}/${s}`;
  if (c !== null) return String(c);
  return String(s);
}

function GoalsSection({
  gameId,
  gameState,
  viewerIsGm,
  viewerPlayerId,
  hideManagementControls,
}: {
  gameId: GameId;
  gameState: GameState;
  viewerIsGm: boolean;
  viewerPlayerId: PlayerId | null;
  hideManagementControls: boolean;
}) {
  const hidden = !viewerIsGm && gameState === "ready";
  const data = useQuery(
    api.goals.listGoalsForGame,
    hidden ? "skip" : { gameId },
  );
  if (hidden) return null;
  const writable = viewerIsGm && gameState !== "archived";
  const showCreateForm = writable && !hideManagementControls;

  return (
    <section>
      <div
        className="row"
        style={{ alignItems: "center", justifyContent: "space-between" }}
      >
        <h3 style={{ marginTop: 0 }}>Goals</h3>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          {data ? `${data.goals.length} total` : ""}
        </span>
      </div>
      {showCreateForm && data && (
        <NewGoalForm
          gameId={gameId}
          eligiblePlayers={data.eligiblePlayers}
        />
      )}
      {data === undefined ? (
        <div className="muted">Loading…</div>
      ) : data.goals.length === 0 ? (
        <div className="muted">
          {viewerIsGm && !hideManagementControls
            ? "No goals yet. Author a goal to set expectations."
            : viewerIsGm
              ? "No goals yet."
              : "No goals on the table."}
        </div>
      ) : (
        <div className="card" style={{ padding: "0.25rem 0.5rem" }}>
          {data.goals.map((g) => (
            <GoalRowView
              key={g._id}
              goal={g}
              viewerIsGm={viewerIsGm}
              viewerPlayerId={viewerPlayerId}
              eligiblePlayers={data.eligiblePlayers}
              hideManagementControls={hideManagementControls}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function NewGoalForm({
  gameId,
  eligiblePlayers,
}: {
  gameId: GameId;
  eligiblePlayers: GoalsEligiblePlayer[];
}) {
  const create = useMutation(api.goals.createGoal);
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState<GoalType>("regular");
  const [fromId, setFromId] = useState<string>("");
  const [toId, setToId] = useState<string>("");
  const [carrot, setCarrot] = useState("");
  const [stick, setStick] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setKeyword("");
    setType("regular");
    setFromId("");
    setToId("");
    setCarrot("");
    setStick("");
    setDescription("");
    setErr(null);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);

    let carrotN: number | undefined;
    if (carrot.trim() !== "") {
      const n = Number(carrot);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        setErr("Carrot must be a non-negative integer.");
        return;
      }
      carrotN = n;
    }
    let stickN: number | undefined;
    if (stick.trim() !== "") {
      const n = Number(stick);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n > 0) {
        setErr("Stick must be a non-positive integer.");
        return;
      }
      stickN = n;
    }
    if (fromId !== "" && toId !== "" && fromId === toId) {
      setErr("from-player and to-player must be different Players.");
      return;
    }

    setBusy(true);
    try {
      await create({
        gameId,
        keyword,
        description,
        type,
        fromPlayerId: fromId === "" ? undefined : (fromId as PlayerId),
        toPlayerId: toId === "" ? undefined : (toId as PlayerId),
        carrot: carrotN,
        stick: stickN,
      });
      reset();
      setOpen(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={{ marginBottom: "0.5rem" }}>
        <button type="button" onClick={() => setOpen(true)}>
          + New Goal
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="card stack"
      style={{ marginBottom: "0.5rem" }}
    >
      <div className="row-wrap" style={{ gap: "0.5rem" }}>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="Keyword (1–40 chars)"
          aria-label="Keyword"
          maxLength={40}
          style={{ flex: 1, minWidth: "10rem" }}
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as GoalType)}
          aria-label="Type"
        >
          <option value="regular">Regular</option>
          <option value="shared">Shared</option>
          <option value="competitive">Competitive</option>
        </select>
      </div>
      <div className="row-wrap" style={{ gap: "0.5rem" }}>
        <label
          className="row"
          style={{ gap: "0.25rem", alignItems: "center" }}
        >
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            From
          </span>
          <select
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            aria-label="From player"
          >
            <option value="">Unassigned</option>
            {eligiblePlayers.map((p) => (
              <option key={p._id} value={p._id} disabled={p._id === toId}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <label
          className="row"
          style={{ gap: "0.25rem", alignItems: "center" }}
        >
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            To
          </span>
          <select
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            aria-label="To player"
          >
            <option value="">Unassigned</option>
            {eligiblePlayers.map((p) => (
              <option
                key={p._id}
                value={p._id}
                disabled={p._id === fromId}
              >
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <input
          type="number"
          value={carrot}
          onChange={(e) => setCarrot(e.target.value)}
          placeholder="Carrot"
          aria-label="Carrot"
          min={0}
          max={1000}
          step={1}
          style={{ width: "6rem" }}
        />
        <input
          type="number"
          value={stick}
          onChange={(e) => setStick(e.target.value)}
          placeholder="Stick"
          aria-label="Stick"
          min={-1000}
          max={0}
          step={1}
          style={{ width: "6rem" }}
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (visible only to GM, from-player, and to-player)"
        aria-label="Description"
        rows={3}
        maxLength={2000}
        style={{ width: "100%", resize: "vertical" }}
      />
      {err && <div className="error-text">{err}</div>}
      <div className="row" style={{ gap: "0.5rem" }}>
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function GoalRowView({
  goal,
  viewerIsGm,
  viewerPlayerId,
  eligiblePlayers,
  hideManagementControls,
}: {
  goal: GoalRow;
  viewerIsGm: boolean;
  viewerPlayerId: PlayerId | null;
  eligiblePlayers: GoalsEligiblePlayer[];
  hideManagementControls: boolean;
}) {
  const remove = useMutation(api.goals.deleteGoal);
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState<"from" | "to" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep the props available for future per-viewer affordances without
  // tripping the no-unused-vars lint.
  void viewerPlayerId;
  void viewerIsGm;

  async function handleDelete() {
    if (
      !window.confirm(
        `Delete goal '${goal.keyword}'? This cannot be undone.`,
      )
    ) {
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await remove({ goalId: goal._id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  const cs = formatCarrotStick(goal.carrot, goal.stick);

  return (
    <div className="row-divider">
      <div
        className="row-wrap"
        style={{
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <span
          className="row-wrap"
          style={{ alignItems: "center", gap: "0.5rem", minWidth: 0 }}
        >
          <strong>{formatGoalKeyword(goal.keyword, goal.type)}</strong>
          <span
            className="badge accent"
            style={{ fontSize: "0.75rem" }}
            title="Carrot / Stick"
          >
            {cs}
          </span>
          <span
            className={goal.fromDisplayName ? "badge" : "muted"}
            style={{ fontSize: "0.75rem" }}
          >
            From: {goal.fromDisplayName ?? "Unassigned"}
          </span>
          <span
            className={goal.toDisplayName ? "badge" : "muted"}
            style={{ fontSize: "0.75rem" }}
          >
            To: {goal.toDisplayName ?? "Unassigned"}
          </span>
          {goal.isFromMe && (
            <span className="badge success" style={{ fontSize: "0.7rem" }}>
              From you
            </span>
          )}
          {goal.isToMe && (
            <span className="badge success" style={{ fontSize: "0.7rem" }}>
              To you
            </span>
          )}
          {goal.description === null && (
            <span
              className="badge"
              style={{ fontSize: "0.7rem", letterSpacing: "0.05em" }}
              title="Only the GM, from-player, and to-player can read the description."
            >
              REDACTED
            </span>
          )}
        </span>
        <span className="row-wrap" style={{ gap: "0.4rem" }}>
          {goal.canAssignFromPlayer && assigning === null && (
            <button
              type="button"
              onClick={() => setAssigning("from")}
              disabled={busy}
              style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
            >
              Assign from…
            </button>
          )}
          {goal.canAssignToPlayer && assigning === null && (
            <button
              type="button"
              onClick={() => setAssigning("to")}
              disabled={busy}
              style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
            >
              Assign to…
            </button>
          )}
          {goal.canEdit && !hideManagementControls && (
            <button
              type="button"
              className="secondary"
              onClick={() => setEditing((v) => !v)}
              disabled={busy}
              style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
            >
              {editing ? "Cancel" : "Edit"}
            </button>
          )}
          {goal.canDelete && !hideManagementControls && (
            <button
              type="button"
              className="danger"
              onClick={() => void handleDelete()}
              disabled={busy}
              style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
            >
              Delete
            </button>
          )}
        </span>
      </div>
      {err && <div className="error-text">{err}</div>}
      {assigning === "from" && goal.canAssignFromPlayer && (
        <AssignFromPlayerForm
          goal={goal}
          eligiblePlayers={eligiblePlayers}
          onDone={() => setAssigning(null)}
        />
      )}
      {assigning === "to" && goal.canAssignToPlayer && (
        <AssignToPlayerForm
          goal={goal}
          eligiblePlayers={eligiblePlayers}
          onDone={() => setAssigning(null)}
        />
      )}
      {editing && goal.canEdit && (
        <GoalEditor
          goal={goal}
          eligiblePlayers={eligiblePlayers}
          onDone={() => {
            setEditing(false);
            setErr(null);
          }}
        />
      )}
      {goal.description !== null && goal.description.length > 0 && (
        <div style={{ marginTop: "0.25rem" }}>
          <p
            style={{
              whiteSpace: "pre-wrap",
              margin: 0,
              fontSize: "0.9rem",
            }}
          >
            {goal.description}
          </p>
        </div>
      )}
    </div>
  );
}

function AssignToPlayerForm({
  goal,
  eligiblePlayers,
  onDone,
}: {
  goal: GoalRow;
  eligiblePlayers: GoalsEligiblePlayer[];
  onDone: () => void;
}) {
  const assign = useMutation(api.goals.assignToPlayer);
  const [toId, setToId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Exclude the from-player from the eligible options (when set).
  const options = eligiblePlayers.filter((p) => p._id !== goal.fromPlayerId);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    if (toId === "") {
      setErr("Pick a Player to assign.");
      return;
    }
    const target = options.find((p) => p._id === toId);
    if (
      !window.confirm(
        `Assign goal '${goal.keyword}' to ${target?.displayName ?? "this player"}?`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await assign({ goalId: goal._id, toPlayerId: toId as PlayerId });
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Assign failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="stack"
      style={{
        marginTop: "0.5rem",
        paddingTop: "0.5rem",
        borderTop: "1px dashed var(--border)",
      }}
    >
      <div className="row-wrap" style={{ gap: "0.5rem" }}>
        <select
          value={toId}
          onChange={(e) => setToId(e.target.value)}
          aria-label="Assign to player"
        >
          <option value="">Pick a player…</option>
          {options.map((p) => (
            <option key={p._id} value={p._id}>
              {p.displayName}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy}>
          {busy ? "Assigning…" : "Assign"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onDone}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
      {err && <div className="error-text">{err}</div>}
    </form>
  );
}

function AssignFromPlayerForm({
  goal,
  eligiblePlayers,
  onDone,
}: {
  goal: GoalRow;
  eligiblePlayers: GoalsEligiblePlayer[];
  onDone: () => void;
}) {
  const assign = useMutation(api.goals.assignFromPlayer);
  const [fromId, setFromId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Exclude the existing to-player from the eligible options (when set),
  // since `from !== to` is enforced server-side.
  const options = eligiblePlayers.filter((p) => p._id !== goal.toPlayerId);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    if (fromId === "") {
      setErr("Pick a Player to give this Goal to.");
      return;
    }
    const target = options.find((p) => p._id === fromId);
    if (
      !window.confirm(
        `Give goal '${goal.keyword}' to ${target?.displayName ?? "this player"} as the from-player?`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await assign({ goalId: goal._id, fromPlayerId: fromId as PlayerId });
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Assign failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="stack"
      style={{
        marginTop: "0.5rem",
        paddingTop: "0.5rem",
        borderTop: "1px dashed var(--border)",
      }}
    >
      <div className="row-wrap" style={{ gap: "0.5rem" }}>
        <select
          value={fromId}
          onChange={(e) => setFromId(e.target.value)}
          aria-label="Assign from player"
        >
          <option value="">Pick a player…</option>
          {options.map((p) => (
            <option key={p._id} value={p._id}>
              {p.displayName}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy}>
          {busy ? "Assigning…" : "Assign"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onDone}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
      {err && <div className="error-text">{err}</div>}
    </form>
  );
}

function GoalEditor({
  goal,
  eligiblePlayers,
  onDone,
}: {
  goal: GoalRow;
  eligiblePlayers: GoalsEligiblePlayer[];
  onDone: () => void;
}) {
  const update = useMutation(api.goals.updateGoal);
  const [keyword, setKeyword] = useState(goal.keyword);
  const [type, setType] = useState<GoalType>(goal.type);
  const [fromId, setFromId] = useState<string>(goal.fromPlayerId ?? "");
  const [toId, setToId] = useState<string>(goal.toPlayerId ?? "");
  const [carrot, setCarrot] = useState(
    goal.carrot != null ? String(goal.carrot) : "",
  );
  const [stick, setStick] = useState(
    goal.stick != null ? String(goal.stick) : "",
  );
  const [description, setDescription] = useState(goal.description ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);

    type Patch = {
      goalId: Id<"goals">;
      keyword?: string;
      description?: string;
      type?: GoalType;
      fromPlayerId?: PlayerId | null;
      toPlayerId?: PlayerId | null;
      carrot?: number | null;
      stick?: number | null;
    };
    const patch: Patch = { goalId: goal._id };

    if (keyword.trim() !== goal.keyword) patch.keyword = keyword;
    if (description !== (goal.description ?? "")) {
      patch.description = description;
    }
    if (type !== goal.type) patch.type = type;

    const currentFrom = goal.fromPlayerId ?? "";
    if (fromId !== currentFrom) {
      patch.fromPlayerId = fromId === "" ? null : (fromId as PlayerId);
    }
    const currentTo = goal.toPlayerId ?? "";
    if (toId !== currentTo) {
      patch.toPlayerId = toId === "" ? null : (toId as PlayerId);
    }

    const currentCarrot = goal.carrot != null ? String(goal.carrot) : "";
    if (carrot !== currentCarrot) {
      if (carrot.trim() === "") {
        patch.carrot = null;
      } else {
        const n = Number(carrot);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
          setErr("Carrot must be a non-negative integer.");
          return;
        }
        patch.carrot = n;
      }
    }
    const currentStick = goal.stick != null ? String(goal.stick) : "";
    if (stick !== currentStick) {
      if (stick.trim() === "") {
        patch.stick = null;
      } else {
        const n = Number(stick);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n > 0) {
          setErr("Stick must be a non-positive integer.");
          return;
        }
        patch.stick = n;
      }
    }

    setBusy(true);
    try {
      await update(patch);
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="stack"
      style={{
        marginTop: "0.5rem",
        paddingTop: "0.5rem",
        borderTop: "1px dashed var(--border)",
      }}
    >
      <div className="row-wrap" style={{ gap: "0.5rem" }}>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          aria-label="Keyword"
          maxLength={40}
          style={{ flex: 1, minWidth: "10rem" }}
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as GoalType)}
          aria-label="Type"
        >
          <option value="regular">Regular</option>
          <option value="shared">Shared</option>
          <option value="competitive">Competitive</option>
        </select>
      </div>
      <div className="row-wrap" style={{ gap: "0.5rem" }}>
        <label
          className="row"
          style={{ gap: "0.25rem", alignItems: "center" }}
        >
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            From
          </span>
          <select
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            aria-label="From player"
          >
            <option value="">Unassigned</option>
            {eligiblePlayers.map((p) => (
              <option key={p._id} value={p._id} disabled={p._id === toId}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <label
          className="row"
          style={{ gap: "0.25rem", alignItems: "center" }}
        >
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            To
          </span>
          <select
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            aria-label="To player"
          >
            <option value="">Unassigned</option>
            {eligiblePlayers.map((p) => (
              <option
                key={p._id}
                value={p._id}
                disabled={p._id === fromId}
              >
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <input
          type="number"
          value={carrot}
          onChange={(e) => setCarrot(e.target.value)}
          placeholder="Carrot"
          aria-label="Carrot"
          min={0}
          max={1000}
          step={1}
          style={{ width: "6rem" }}
        />
        <input
          type="number"
          value={stick}
          onChange={(e) => setStick(e.target.value)}
          placeholder="Stick"
          aria-label="Stick"
          min={-1000}
          max={0}
          step={1}
          style={{ width: "6rem" }}
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        aria-label="Description"
        rows={3}
        maxLength={2000}
        style={{ width: "100%", resize: "vertical" }}
      />
      {err && <div className="error-text">{err}</div>}
      <div className="row" style={{ gap: "0.5rem" }}>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onDone}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
