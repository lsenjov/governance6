# Soundboard

## Objective

Give the GM a panel of one-click buttons inside an active Game that
broadcast a short audio clip to every participant — GM and Players
alike — in real time. Each button corresponds to a curated sound clip
in a site-admin-managed catalogue (mirroring the existing
`presetSkills` and `presetDrawbacks` patterns). Clicking a button:

- Inserts a "play this sound now" event row scoped to the current
  game.
- Triggers every connected client (GM included, so the GM hears what
  the table hears) to fetch the audio asset and play it once.
- Survives reconnects: a participant who joins the game after the
  click does NOT retroactively hear the clip; only events that happen
  after their initial subscription fire.

Out of scope for v1 (called out explicitly in Alternative Approaches
below): per-GM personal sound libraries, per-game custom uploads,
volume controls per participant, queueing / overlap rules, looping
sounds, ambient music tracks, or sound categories / tabs.

## Background — what the spec maps to

- "A selection of buttons the GM can see" → a flat list of buttons
  rendered from `api.presetSounds.list` results, gated on
  `viewer.isGm`. Visibility model parallels the existing GM-only
  affordances (`src/pages/GameDetailPage.tsx:170-175` "Add Player",
  `src/pages/GameDetailPage.tsx:286-303` "GM Tools" / "GM Todo").
- "Each button plays a specific sound" → each button mutates
  `api.soundboard.trigger({ gameId, presetSoundId })`, which inserts
  a `soundEvents` row.
- "To all players" → every participant's `GameDetailPage` subscribes
  to `api.soundboard.latestEvent({ gameId })`. When the returned
  event id changes from the initial-load snapshot, the client plays
  the audio via `new Audio(url).play()`. The GM hears it too because
  they are also a participant on the same subscription.

The model deliberately uses event-style fan-out (a single "latest
event" pointer per game) rather than push notifications or signed
webhooks. Convex reactivity over a query already gives us the fan-out
we need; no new transport is required.

## Design

### Catalogue (sounds the GM can pick from)

A site admin uploads MP3/OGG/WAV clips in the existing `/admin`
console (`src/pages/AdminPage.tsx:34-79`). Each upload becomes a
`presetSounds` row. Read access is open to any authenticated user (so
the GM can list + trigger them); write access is gated on
`requireSiteAdmin` exactly like `presetSkills` and `presetDrawbacks`.

Rationale for site-admin curation rather than per-GM upload in v1:

- Uniform asset library across every game in the deployment matches
  the existing curated-catalogue pattern (`presetSkills`,
  `presetDrawbacks`) and reuses the same admin gate
  (`convex/lib/auth.ts:36-42`).
- No new authorisation flow ("only GMs can upload" plus per-GM
  storage quotas) to design and verify in v1.
- A future v2 (Alternative Approach 1) can layer per-GM uploads on
  top without breaking the v1 catalogue.

### Trigger surface (where the buttons live)

A new `<SoundboardSection>` component renders on `GameDetailPage` for
the GM only, anchored in the main column near the existing GM-only
sections. Exact placement: between `<GoalsSection>`
(`src/pages/GameDetailPage.tsx:162-168`) and the "Add Player" GM
section, so it sits with the other GM-authored controls without
disrupting the player-facing reading order.

Visibility rules:

- Render only when `viewer.isGm`. Players never see the section, the
  buttons, or any reference to it.
- Render in `ready`, `playing`, AND `archived` states. The GM may
  want to test sounds before starting (`ready`) or replay a sound
  during post-mortem review (`archived`). Server-side mutation also
  permits any state — there's no rules-driven reason to gate by game
  state.
- The section is intentionally NOT gated by
  `hideManagementControls` — sounds are a live-table affordance, not
  a destructive management control (mirrors the timer-cell carve-out
  documented at `src/components/NoteIcon.tsx:322-326`).

Visual treatment (per `THEME.md`):

- Square buttons in a `row-wrap` grid, each with the sound name in
  Archivo Black uppercase and a 2px black border with a `4px 4px 0`
  hard mint shadow (the standard primary-button treatment, lines
  88–89 of `THEME.md`).
- A small "playing…" indicator (no spinner — uppercase mono
  caption per the THEME's motion rules) shows on the most recent
  triggered button for a few seconds after the click.
- An empty state ("No sounds in catalogue.") with a link to `/admin`
  for site admins.

### Playback surface (how every participant hears it)

A `<SoundPlayer>` component mounts once on `GameDetailPage` for every
participant (GM + Players). Behaviour:

1. Subscribes to `api.soundboard.latestEvent({ gameId })`.
2. On the FIRST non-undefined response, captures the event id (or
   `null` if none) into a `useRef`. This is the "starting baseline".
   No sound plays for this baseline.
3. On every subsequent response where the event id ≠ the ref value,
   constructs `new Audio(url)`, calls `.play()`, and updates the ref
   to the new id.
4. If `.play()` rejects (autoplay blocked because the page has not
   yet seen a user interaction), surfaces a small persistent banner:
   "Click anywhere to enable game sounds." Once any click anywhere
   in the document fires, the banner clears and subsequent plays
   succeed. Implementation: a `pointerdown` listener on `document`
   that calls a silent priming `Audio` element; from that point
   forward `play()` will resolve.
5. Multiple events arriving in quick succession (rare, but possible
   if the GM mashes buttons): each new event id swaps the active
   `Audio` element — there is no overlap; the previous clip is
   `.pause()`d and discarded. v1 does not queue — the GM's intent in
   double-clicking is "play the latest, not both".

### Schema additions

Two new tables in `convex/schema.ts`:

```
presetSounds: defineTable({
  name: v.string(),                // display label on the button
  storageId: v.id("_storage"),     // the audio blob in Convex storage
  contentType: v.optional(v.string()), // e.g. "audio/mpeg"; metadata
                                       // copied at upload time
  createdByUserId: v.id("users"),  // site admin who uploaded
  createdAt: v.number(),
}).index("by_name", ["name"]),

soundEvents: defineTable({
  gameId: v.id("games"),
  presetSoundId: v.id("presetSounds"),
  // Denormalised at write time so the per-event fetch needs only
  // the row + a single signed-URL call (avoids a second hop).
  storageId: v.id("_storage"),
  triggeredByUserId: v.id("users"),
  triggeredAt: v.number(),
}).index("by_game_time", ["gameId", "triggeredAt"]),
```

Rationale:

- `presetSounds` mirrors `presetSkills` (single "name" column,
  case-insensitive uniqueness) plus a storage pointer.
- `soundEvents` is append-only and event-shaped (matches the existing
  `powerLedgerEntries` pattern, `convex/schema.ts:146-165`). A
  dedicated table keeps audit history (the GM can see in a future
  v2 a "sounds played" log) and cleanly separates the trigger from
  the catalogue.
- Storing `storageId` denormalised on the event row keeps the
  reactive `latestEvent` query a single index walk + one
  `ctx.storage.getUrl` call. If a site admin later deletes the
  underlying preset, the event row still resolves (until storage
  gc'd separately), which is fine — historical events frozen at
  trigger time matches the immutability pattern used by `notes`
  carrying `attachedRollSetId` (`convex/schema.ts:301-302`).

No changes to existing tables.

### Storage / upload flow

Audio blobs live in Convex's built-in `_storage` table. Upload uses
the standard Convex pattern:

1. `presetSounds.generateUploadUrl` (mutation, site-admin gated)
   returns an upload URL via `await ctx.storage.generateUploadUrl()`.
2. The `/admin` page POSTs the file directly to that URL.
3. On success, the page calls `presetSounds.create` with the
   returned `storageId`, the chosen `name`, and the file's
   `contentType`.

`ctx.storage.getUrl(storageId)` in the `latestEvent` query returns a
signed URL the browser can `new Audio(url)` against directly — no CORS
shim, no proxy.

### Server functions

- `presetSounds.list` (query, any authenticated user): returns rows
  sorted by name. Mirrors `presetSkills.list`
  (`convex/presetSkills.ts:30-38`).
- `presetSounds.generateUploadUrl` (mutation, site-admin only):
  returns the upload URL.
- `presetSounds.create` (mutation, site-admin only): args
  `{ name, storageId, contentType? }`. Validates name (non-empty,
  ≤120 chars, case-insensitive unique), ensures the storage object
  exists (`ctx.db.system.get("_storage", storageId)` returns
  non-null), and inserts the row.
- `presetSounds.update` (mutation, site-admin only): rename only;
  uploads are immutable (admin removes + reuploads to swap audio).
- `presetSounds.remove` (mutation, site-admin only): deletes the row
  AND `ctx.storage.delete(storageId)` so we don't orphan the asset.
  Existing `soundEvents` rows pinning that `storageId` will return a
  null URL after this; the player's `latestEvent` subscription will
  ignore null-URL events (no playback, no error spam).
- `soundboard.trigger` (mutation, GM only via `requireGameGm`): args
  `{ gameId, presetSoundId }`. Reads the preset to copy `storageId`
  onto the new `soundEvents` row. Inserts the row and returns its
  id.
- `soundboard.latestEvent` (query, any participant via
  `requireGameParticipant`): returns the most-recently-inserted
  `soundEvents` row for the game with `url` resolved via
  `ctx.storage.getUrl(storageId)`. Returns `null` when the game has
  no events. Projection:
  ```
  {
    _id, presetSoundId, name, url, triggeredAt, triggeredByUserId
  } | null
  ```
  `name` is joined from the preset row at query time so the client
  can display "Bellringer just played: Air horn." without an extra
  round trip.

### Client wiring

- `<SoundboardSection>` (new file
  `src/components/SoundboardSection.tsx`): renders the grid of
  buttons + click handler. Uses
  `useQuery(api.presetSounds.list)` and
  `useMutation(api.soundboard.trigger)`. Local state tracks the
  most-recently-triggered preset id for the brief "playing…" badge.
- `<SoundPlayer>` (new file
  `src/components/SoundPlayer.tsx`): the playback observer described
  in "Playback surface". Mounts once at the top of
  `GameDetailPage`, gated on the existence of a viewer (don't mount
  for null-viewer error branches). Internally manages its own ref
  and active `Audio` element.
- `GameDetailPage` mounts both: `<SoundboardSection>` inside the
  main-column GM-only stack, `<SoundPlayer>` near the top of the
  page tree (above `game-grid`) so it survives layout reflows.
- An "Enable sounds" banner is rendered conditionally inside
  `<SoundPlayer>` when the autoplay-blocked state flag is set.

### Authorisation matrix

- Listing the catalogue: any authenticated user (so the GM's UI can
  load it; Players will not call this query because the section that
  invokes it is gated).
- Uploading / deleting catalogue entries: site admin only.
- Triggering: game's GM only.
- Listening (latest event subscription): any participant (GM or
  Player) of the game.

Defence in depth: the GM-only UI gate is a courtesy; the
`requireGameGm` server gate is authoritative (Rule 24 pattern from
`convex/lib/auth.ts:53-63`).

## Implementation Plan

### Schema + storage primitives

- [ ] **Task 1.** Add the `presetSounds` and `soundEvents` table
  definitions in `convex/schema.ts` per the schema block above. Keep
  the diff to two new table definitions and no edits to existing
  tables. Add a docblock on each table mirroring the explanatory
  style of `presetSkills` (`convex/schema.ts:32-39`) and
  `powerLedgerEntries` (`convex/schema.ts:138-165`) so future
  contributors find the rationale at the schema site.

- [ ] **Task 2.** Add `convex/presetSounds.ts` modelled on
  `convex/presetSkills.ts:1-87`. Implement `list`,
  `generateUploadUrl`, `create`, `update` (rename only), and
  `remove`. `remove` MUST also call `ctx.storage.delete(storageId)`
  inside the same mutation transaction so the blob and the row drop
  atomically; document this contract in a doc comment so a later
  refactor doesn't split them. Use the same `normalizeName` helper
  shape (trim, max 120 chars, case-insensitive uniqueness) as
  `presetSkills`.

- [ ] **Task 3.** Add `convex/soundboard.ts` containing two
  functions:
  - `trigger` (mutation): gates on `requireGameGm`; loads the
    preset, copies its `storageId`, inserts a `soundEvents` row,
    returns the new id.
  - `latestEvent` (query): gates on `requireGameParticipant`; reads
    the `by_game_time` index in descending order with `.first()`
    (or `.take(1)`); joins the preset by id for the `name` field;
    resolves `url` via `ctx.storage.getUrl(storageId)`; projects
    the public shape; returns `null` when the game has no events.
    Document inline why we chose a "latest pointer" projection over
    streaming the full history (only the most recent event drives
    UX, the table itself is the audit trail).

### Server tests

- [ ] **Task 4.** Tests in `convex/presetSounds.test.ts` (mirror the
  shape of `convex/presetDrawbacks.test.ts`):
  - `list` succeeds for any authenticated user; rejects unauthed.
  - `create` rejects non-admins; succeeds for site admin; rejects
    duplicate names case-insensitively; rejects empty / overlong
    names.
  - `remove` deletes the row AND removes the underlying storage
    blob (assert via `ctx.storage` being mocked or by querying the
    `_storage` system table after the mutation).
  - `update` rename collision check matches `create`.

- [ ] **Task 5.** Tests in `convex/soundboard.test.ts`:
  - `trigger` rejects callers who are not the GM of the supplied
    game (player and stranger both rejected).
  - `trigger` succeeds for the GM, inserts a `soundEvents` row,
    and the inserted row carries the denormalised `storageId`.
  - `trigger` rejects when the supplied `presetSoundId` does not
    exist (defensive — the GM UI shouldn't allow it, but Rule 24).
  - `latestEvent` rejects non-participants of the game.
  - `latestEvent` returns `null` for a game with no events.
  - `latestEvent` returns the most recent event regardless of
    creation order (insert two events out of `triggeredAt` order
    and assert the higher-timestamp one wins).
  - `latestEvent` resolves `url` to a non-null string when the
    storage blob exists; resolves `url` to `null` when the blob has
    been deleted underneath it (verifies the catalogue-removal
    graceful-degradation path).
  - Cross-game isolation: an event in game A does not show up in
    game B's `latestEvent`.

### Admin UI (catalogue management)

- [ ] **Task 6.** Extend `src/pages/AdminPage.tsx` with a new
  "Preset sounds" section after the existing "Preset drawbacks"
  section. Mirror the structure of the existing sections:
  - `<AddPresetSoundForm>`: name input + file picker (accept
    `audio/*`). On submit, calls
    `api.presetSounds.generateUploadUrl`, POSTs the file to the
    returned URL with a `Content-Type` header derived from
    `file.type`, then calls `api.presetSounds.create` with the
    returned `storageId`, the trimmed name, and `file.type` as
    `contentType`.
  - `<PresetSoundRow>`: shows the name, an inline `<audio
    controls src={...} />` for preview (URL fetched via a
    sibling query that returns the signed URL by id), a Save
    (rename) button, and a Delete button. Confirm-on-delete
    matches the existing `PresetDrawbackRow`
    (`src/pages/AdminPage.tsx:305-315`).
  - Document acceptable file size (≤2 MiB recommended; absolute
    cap inherited from Convex's storage limits) in muted helper
    text under the form. v1 does NOT enforce a server-side size
    cap — Convex's transport layer already caps storage uploads;
    surfacing the practical recommendation to the admin is
    sufficient.

- [ ] **Task 7.** Add a small `presetSounds.getOneUrl` query
  (or `presetSounds.listWithUrls`) so the admin row's
  `<audio controls>` element has a URL to play. The query gates on
  `requireSiteAdmin` since it's only used by the admin UI (saves
  generating signed URLs for every authenticated lister). Decide
  between per-row `getOneUrl` vs. `listWithUrls` based on N: the
  catalogue is bounded to dozens at most, so `listWithUrls` is
  acceptable and simpler. Document the choice in a comment.

### Game UI (trigger + playback)

- [ ] **Task 8.** Create `src/components/SoundboardSection.tsx`. The
  component:
  - Takes `{ gameId: Id<"games">; viewerIsGm: boolean }` and
    returns `null` when `viewerIsGm === false` (defence in depth
    against accidental mounts in non-GM render paths).
  - Reads `api.presetSounds.list`. Empty state: a card with
    "No sounds in catalogue. Site admins can add sounds in" + a
    `<Link to="/admin">Admin</Link>`.
  - Renders one button per row with `font-family:
    var(--font-display)`, uppercase label, theme primary button
    treatment.
  - On click, calls `api.soundboard.trigger`. Tracks
    `lastTriggeredId` in local state and a `lastTriggeredAt` so
    the button shows a "playing" badge for ~3 seconds after the
    click. Errors surface inline (`error-text` class).
  - Wraps the section in an `<h3>Soundboard</h3>` heading so it
    integrates with the existing `.bulletin` numbering that
    `GameDetailPage` already uses for main-column sections.

- [ ] **Task 9.** Create `src/components/SoundPlayer.tsx`. The
  component:
  - Takes `{ gameId: Id<"games"> }`.
  - Subscribes to `api.soundboard.latestEvent({ gameId })`.
  - Maintains a `useRef<Id<"soundEvents"> | null>(null)` set on
    the FIRST non-undefined response (initial-load suppression).
  - On every subsequent response whose `_id` differs from the ref
    AND `url` is non-null, constructs `new Audio(url)`, sets
    `volume = 1.0`, and calls `.play()`. If the previous `Audio`
    is still active, `.pause()` it first; replace the ref to the
    new active element. Update the event-id ref to the new id.
  - Tracks an `autoplayBlocked` state. On a `.play()` rejection
    (NotAllowedError), set the flag true and render a small
    persistent banner: "Click anywhere to enable game sounds."
    Attach a one-shot `pointerdown` listener on `document` that
    creates a silent priming Audio element, calls `.play()` on it,
    flips the flag back to false, and detaches itself.
  - Cleans up on unmount: pause the active Audio, detach any
    listeners.
  - The component renders the banner only; the Audio element is
    purely imperative (not in the React tree).

- [ ] **Task 10.** Wire both components into
  `src/pages/GameDetailPage.tsx`:
  - Mount `<SoundPlayer gameId={gid} />` near the top of the
    returned JSX (above `<GameHud>` is fine — its render output is
    a single conditionally-rendered banner so it doesn't disrupt
    the HUD's layout).
  - Insert `<SoundboardSection gameId={gid}
    viewerIsGm={viewer.isGm} />` between the existing
    `<GoalsSection>` mount (`src/pages/GameDetailPage.tsx:162-168`)
    and the GM-only "Add Player" branch
    (`src/pages/GameDetailPage.tsx:170-175`). The section's own
    `viewerIsGm` gate makes the placement safe for Player
    sessions; rendering it unconditionally avoids the layout
    flicker that comes from gating on the parent.

### Theme + accessibility

- [ ] **Task 11.** No new CSS classes. Reuse the existing primary
  button styling (`.primary` is the default per `THEME.md` lines
  86–89). The "playing" badge reuses the `.badge.accent` class
  (`THEME.md` lines 124–127). The "Enable sounds" banner reuses
  `.read-only-banner` styling (`THEME.md` lines 159–162) for visual
  consistency with other top-of-page notices. Audit the diff for
  accidental new tokens; if a button needs a tweak (e.g. a
  monospace count badge), prefer inline styles rather than
  introducing a new class.

- [ ] **Task 12.** Accessibility:
  - Each button: `aria-label="Play sound: <name>"` plus visible
    text label.
  - The Soundboard section: a `<section aria-label="Soundboard">`
    wrapper.
  - The "Enable sounds" banner: `role="status"`,
    `aria-live="polite"`. The banner is dismissed implicitly by
    the user click that primes audio; no explicit close button.

### Client tests

- [ ] **Task 13.** Tests in
  `src/components/SoundboardSection.test.ts`:
  - Renders nothing when `viewerIsGm === false`.
  - Renders the empty-state link when `presetSounds` returns `[]`.
  - Renders one button per preset and invokes
    `api.soundboard.trigger` with the correct `presetSoundId` on
    click (mock `useMutation`).
  - Surfaces a thrown mutation error inline.

- [ ] **Task 14.** Tests in `src/components/SoundPlayer.test.ts`:
  - On first non-undefined response, no `Audio` is constructed
    (initial-load suppression).
  - On a subsequent response with a new event id, `Audio` is
    constructed with the URL and `.play()` is called. Use a
    `vi.spyOn(window, "Audio")` or stub the constructor.
  - Two events arriving back-to-back: the first `Audio` is
    `.pause()`d before the second is constructed.
  - When `.play()` rejects with a `NotAllowedError`, the banner
    renders.
  - A subsequent `pointerdown` on `document` clears the banner
    state.
  - Unmount: the active `Audio` is paused and the document
    listener is removed (assert via the spy).

### Documentation / housekeeping

- [ ] **Task 15.** Add a top-of-file docblock to
  `convex/soundboard.ts` describing the trigger/latest-event split,
  the GM-only mutation gate, the participant-only query gate, the
  initial-load suppression contract on the client side (referenced
  but not implemented here — the doc is a forward-pointer for
  future readers), and the storage-id denormalisation rationale.
  Mirror the prose style used at the top of `convex/notes.ts`.

- [ ] **Task 16.** Add a top-of-file docblock to
  `src/components/SoundPlayer.tsx` describing:
  - The "subscribe to latest, suppress initial baseline" contract.
  - The autoplay-policy banner and the one-shot priming click.
  - Why playback is imperative (an out-of-tree `Audio` element)
    rather than declarative — autoplay rules require the play call
    to come from a non-React-render code path.

- [ ] **Task 17.** No standalone documentation file. The plan above
  is the spec; code comments cover the implementation.

## Verification Criteria

- A site admin uploads two MP3 clips named "Air horn" and "Drumroll"
  via `/admin`. Both appear under "Preset sounds" with an inline
  `<audio>` preview that plays the clip locally.
- The GM of an active game opens `GameDetailPage` and sees a
  Soundboard section with two buttons labelled "Air horn" and
  "Drumroll".
- A second browser logged in as a Player in the same game sees NO
  Soundboard section, no Soundboard button anywhere, and no
  reference in the rendered HTML.
- The GM clicks "Air horn". Within ~1 second:
  - The GM's browser plays the clip audibly.
  - The Player's browser plays the clip audibly.
  - A second Player (joined later, see below) does NOT replay any
    earlier clip on their initial mount.
- Reconnect / late-join: a Player logs in 5 seconds after the GM
  played "Air horn". The Player loads `GameDetailPage` and hears
  silence — the captured baseline event id matches the stored event
  id, so no playback fires. If the GM presses "Drumroll" 10 seconds
  later, both browsers play it.
- Autoplay-policy fallback: load the page, do NOT click anywhere,
  then have the GM trigger a sound from a different browser. The
  Player browser surfaces "Click anywhere to enable game sounds."
  Clicking anywhere clears the banner; subsequent triggers play
  audibly.
- Rapid double-click: the GM clicks "Air horn" then "Drumroll" within
  ~200 ms. Both browsers play exactly one sound (Drumroll) — Air
  horn is interrupted, not queued.
- Catalogue removal: a site admin deletes "Air horn" while a player
  is connected. The button disappears from the GM's section. No
  errors in the player's console; if the GM had triggered Air horn
  earlier, the historical `soundEvents` row remains but its
  resolved `url` is `null` and triggers no playback for any later
  joiner.
- Cross-game isolation: GM A in game A presses Air horn; GM B and
  the players in unrelated game B hear nothing.
- Server-side rule enforcement: a Player crafting a direct call to
  `api.soundboard.trigger` is rejected with the `requireGameGm`
  error. A non-participant calling `api.soundboard.latestEvent` is
  rejected with the `requireGameParticipant` error. Both verified
  via direct test invocation.
- Theme audit: every new button passes the THEME.md verification
  checklist (no `border-radius`, no blurred shadows, mint accent
  used as a fill not a text color, mono numerals where applicable).

## Potential Risks and Mitigations

1. **Browser autoplay policy blocks the first sound.**
   Mitigation: the `<SoundPlayer>` component handles the
   `NotAllowedError` from `play()` and surfaces a one-shot
   "click anywhere" banner. Once the user clicks, a silent priming
   Audio unlocks the audio context for the rest of the session.
   The banner reuses the existing `.read-only-banner` styling so
   no new design tokens are introduced.

2. **Initial-load replay (a player joining mid-session hears every
   historical sound).**
   Mitigation: the client captures the latest event id at mount
   into a `useRef` and only plays on `_id !== ref.current`. The
   server query returns only the latest event, never a list, so
   the client cannot accidentally iterate history.

3. **Audio overlap when the GM mashes buttons.**
   Mitigation: `<SoundPlayer>` keeps a ref to the active `Audio`
   element; on each new event it `.pause()`s the previous element
   before constructing the new one. v1 chooses
   "play-the-latest-only" semantics; queueing is an explicit
   non-goal.

4. **Catalogue blob deleted while an event references it.**
   Mitigation: `latestEvent` returns `url: null` for missing blobs
   and `<SoundPlayer>` ignores null-URL events (no playback, no
   error). The graceful-degradation behaviour is covered by the
   server test in Task 5 and the verification criterion above.

5. **Storage cost / orphan blobs if `presetSounds.remove` doesn't
   delete the underlying file.**
   Mitigation: Task 2 explicitly calls
   `ctx.storage.delete(storageId)` inside the same mutation. Test
   coverage in Task 4 asserts the side effect.

6. **Unbounded `soundEvents` table growth.**
   Mitigation: each row is small (4 ids + a timestamp), and v1 only
   ever reads the latest one — older rows have no read amplification
   cost. A future cron-style cleanup (drop events older than 7 days
   per game) can be added without touching the v1 contract. Track
   in a follow-up plan.

7. **Cross-tab confusion (a single user logged into two tabs hears
   the sound twice).**
   Mitigation: this is the desired behaviour. Two tabs == two
   subscriptions == two playback paths. v1 ships as-is; if field
   reports complain, a future v2 can use a `BroadcastChannel` to
   deduplicate within a single browser, but that is not on the v1
   critical path.

8. **Site admin uploads a file that is not actually audio.**
   Mitigation: the `<audio>` preview in the admin UI fails loudly
   in the admin's own browser before they save the row — it's an
   immediate visual signal. Defence in depth: validate
   `contentType.startsWith("audio/")` server-side in
   `presetSounds.create`; reject otherwise with a clear error.

9. **`GameDetailPage.tsx` already exceeds 4000 lines; mounting two
   new components inline could grow it further.**
   Mitigation: both new components live in
   `src/components/SoundboardSection.tsx` and
   `src/components/SoundPlayer.tsx` from the start. The
   `GameDetailPage.tsx` diff is limited to two new imports plus two
   element mounts.

10. **`latestEvent` projection forces a `ctx.storage.getUrl` call
    on every reactive query re-run, including no-op re-runs caused
    by unrelated game writes.**
    Mitigation: `getUrl` is cheap (Convex caches signed URLs
    internally for the request lifetime). If profiling shows it's
    a hotspot, introduce a cached `signedUrl` field on the
    `soundEvents` row populated at trigger time with a long TTL —
    but the schema as drafted leaves room for that without a
    breaking change. v1 stays simple.

## Alternative Approaches

1. **Per-GM (or per-game) sound libraries instead of a global
   site-admin catalogue.** Each GM uploads their own clips,
   scoped to their account or to a specific game. Trade-off: more
   personalisation, but adds per-user storage quotas, a per-game
   upload UI, and a copy-vs-reference question (does archiving a
   game freeze the audio? does a leader leaving the campaign tear
   down their library?). Rejected for v1 because the
   site-admin-curated path matches the existing
   `presetSkills` / `presetDrawbacks` shape and avoids the design
   work. Layer on top in a v2.

2. **Use the latest-event pointer on the `games` table directly
   (`games.currentSoundEventId`) instead of an indexed
   `soundEvents` table.** Trade-off: one fewer table, simpler
   query (just `ctx.db.get(gameId).currentSoundEventId`).
   Rejected because (a) `games` is a stable
   document and high-frequency soundboard writes would inflate its
   write churn (separate-high-churn-data guideline at
   `convex/_generated/ai/guidelines.md:158`), and (b) keeping the
   audit trail is easier with a dedicated event table.

3. **Push notifications via Convex scheduler / actions instead of
   a reactive query.** Trade-off: more "real" push semantics, but
   adds an HTTP/webhook layer the codebase does not currently have
   (`convex/http.ts` is empty save for auth). Rejected — Convex's
   reactive queries already deliver the fan-out we need with no
   extra infrastructure.

4. **Render the soundboard inside the existing `GmToolsDrawer`
   (`src/pages/GameDetailPage.tsx:362-411`) rather than as an
   inline section.** Trade-off: keeps the main column shorter at
   the cost of a click to open the drawer every time the GM wants
   to play a sound. Rejected because the GM Tools drawer is
   positioned for "rarely-used GM utilities" (see the existing
   docblock); a soundboard is a frequently-used live affordance,
   matching the rationale used by the GM Todo plan
   (`plans/2026-04-28-gm-todo-drawer-v1.md` Alternative Approach
   5).

5. **Stream playback over WebRTC / WebSockets so all players hear
   exactly the same waveform position.** Trade-off: tight
   synchronisation. Rejected — sound effects are short (<5s) and
   the human ear tolerates ~250ms drift across browsers,
   well within Convex's reactive latency. The complexity is not
   justified.

6. **Allow players to trigger sounds (e.g. for taunts).** Trade-off:
   more table interaction. Rejected — the spec is explicit that
   only the GM sees the buttons. A future feature could add a
   curated "player taunt" subset gated separately, but it is out
   of v1 scope.
