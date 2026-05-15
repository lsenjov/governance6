# Site Admin: View and Edit All Syndicates

## Objective

Extend site admin (`users.isSiteAdmin === true`) capabilities so that an admin can:

1. **See** every Syndicate in the system (their own, others' shared, others' private), each with its owner, drawbacks, and minions.
2. **Edit** every Syndicate (core fields, share toggle, delete, and all child Drawback/Minion CRUD) with the same permissions as the legitimate owner — subject to existing data-integrity locks (Rule 5/7: `played === true` remains permanently frozen for everyone, including admins).

This must be enforced server-side (Rule 24) and surfaced naturally in the existing UI without confusing or weakening the per-user experience.

## Initial Assessment

### Project Structure Summary

- Convex backend in `convex/` with auth helpers centralised in `convex/lib/auth.ts`.
- Syndicate domain split across `convex/syndicates.ts`, `convex/drawbacks.ts`, `convex/minions.ts`. All three rely on two gating helpers: `requireSyndicateOwner` (ownership only) and `assertSyndicateEditable` (ownership + `played === false`).
- React frontend in `src/`, with pages `SyndicatesListPage.tsx`, `SharedSyndicatesPage.tsx`, `SyndicateEditorPage.tsx`, and `AdminPage.tsx`. Top-level routing in `src/App.tsx`.
- Existing admin surface is gated entirely on `users.isSiteAdmin` (set only via the Convex dashboard) and currently scopes to preset skills/drawbacks.

### Relevant Files Examination

- `convex/schema.ts:15-30` — `users.isSiteAdmin: v.optional(v.boolean())` already exists; no schema change required.
- `convex/lib/auth.ts:36-42` — `requireSiteAdmin` helper exists and is the standard admin gate (used by `presetSkills`, `presetDrawbacks`).
- `convex/lib/auth.ts:127-138` — `requireSyndicateOwner` throws unless `syndicate.ownerId === userId`. This is the choke point that excludes admins.
- `convex/lib/auth.ts:144-155` — `assertSyndicateEditable` delegates to `requireSyndicateOwner` then asserts `!played`. Used by `syndicates.update`, `syndicates.setIsShared`, every drawback mutation, every minion mutation.
- `convex/syndicates.ts:32-170` — `create` (no admin concern), `update` (uses `assertSyndicateEditable`), `setIsShared` (uses `assertSyndicateEditable`), `remove` (uses `requireSyndicateOwner` directly because the played-check has a custom error message).
- `convex/syndicates.ts:172-202` — `listMine` (owner-scoped) and `listShared` (decorated with `ownerName`). Neither returns others' private syndicates.
- `convex/syndicates.ts:204-235` — `getWithChildren` visibility gate at line 211 (`if (syndicate.ownerId !== userId && !syndicate.isShared) return null;`) and `canEdit = isOwner && !syndicate.played`.
- `convex/syndicates.ts:240-265` — `listSelectable` for the join-game flow. Out of scope: admin-visibility should not silently widen the selectable list during normal game flow.
- `convex/drawbacks.ts:53,96,142` — every mutation routes through `assertSyndicateEditable`.
- `convex/minions.ts:85,128,179` — every mutation routes through `assertSyndicateEditable`.
- `src/pages/SyndicateEditorPage.tsx:48-54,170-184` — Read-only banner copy (`"Read-only view (you are not the owner)"` at line 52) and share-toggle button gated on `isOwner && canEdit` (line 174). Both will display wrong content for an editing admin until updated.
- `src/pages/SyndicatesListPage.tsx:9` — uses `api.syndicates.listMine`. Admin won't see others' syndicates here.
- `src/pages/SharedSyndicatesPage.tsx:6` — uses `api.syndicates.listShared`. Admin won't see others' private syndicates here.
- `src/pages/AdminPage.tsx:14-79` — admin console scoped to preset catalogues; a natural host for an "All Syndicates" section or link.
- `src/App.tsx:24,60` — top-nav `Admin` link gated on `me?.isSiteAdmin`; routes include `/admin`.

### Prioritised Challenges and Risks

1. **Highest priority — server-side enforcement gap.** Every existing mutation routes through ownership helpers that reject admins. Until the helpers are updated, no UI change will let an admin actually edit another user's syndicate (Rule 24).
2. **Medium — preserve the `played` lock.** Admins must not become a back-door around Rule 5/7. The played frozen state exists for historical-integrity reasons (rolls, notes, ledger entries reference frozen content). Lifting it just for admins would silently break the immutability contract that downstream tables rely on.
3. **Medium — visibility should not silently widen `listSelectable` or other gameplay flows.** Admins are normal users in every other gameplay context; their wide-visibility power is only for the management view.
4. **Lower — UI clarity.** A site admin editing someone else's syndicate must be able to tell that's what's happening (owner attribution; explicit "as admin" copy) so it isn't mistaken for their own content. Read-only banner copy must also stop falsely saying "you are not the owner" when an admin can in fact edit.
5. **Lower — share-toggle semantics for admin.** Deciding whether the admin should be able to flip `isShared` on someone else's syndicate. Treat this as part of "edit" since `setIsShared` is gated by the same editability rule.

## Assumptions

- **Played frozen rule applies to admins too.** Played syndicates remain permanently read-only for everyone. (Mitigates risk 2.)
- **Existing `requireSiteAdmin` is the canonical admin check.** No new admin-grant flow.
- **Admins act through the same mutations.** No new admin-only mutation surface; instead, the existing helpers are widened to admit admins, so server logic, validation, and cascades stay in one place.
- **`listSelectable` is NOT widened.** Admin sees-all-syndicates power is for the management/editor surface only. Game-play flows (`listSelectable`, the join/select-syndicate path) stay user-scoped.
- **No new "as admin" audit log in v1.** The `users.isSiteAdmin` flag is already manually granted and trusted. Adding an audit ledger is out of scope; can be added later if needed.
- **Admins are surfaced via a dedicated "All Syndicates" view rather than mixing others' syndicates into "My Syndicates".** Keeps the personal list focused on the admin's own authored content and avoids confusing the editor surface.

## Implementation Plan

### Backend — auth helpers

- [x] Task 1. Add two new helpers to `convex/lib/auth.ts`: `requireSyndicateOwnerOrAdmin(ctx, syndicateId)` and `assertSyndicateEditableForAdminOrOwner(ctx, syndicateId)`. The first returns the `syndicates` doc when the caller is either the owner or a site admin (rejects otherwise). The second additionally rejects when `played === true`, regardless of caller role. Rationale: introducing new named helpers (rather than mutating the existing two) keeps the existing semantics intact for any future caller that genuinely needs owner-only enforcement and makes the widening explicit at every adoption site.

- [x] Task 2. Re-export the new helpers alongside existing ones; document at the helper definitions (file-level JSDoc on `convex/lib/auth.ts`) that admin parity is intentional, that played remains frozen for everyone, and that `requireSyndicateOwner` is preserved as the strict-owner check for any future use case (currently no callers; the helper is left exported for symmetry and is referenced only by the admin-aware variant internally).

### Backend — syndicates module

- [x] Task 3. Update `convex/syndicates.ts:update` and `convex/syndicates.ts:setIsShared` to call `assertSyndicateEditableForAdminOrOwner` instead of `assertSyndicateEditable`. Rationale: these are the two non-create write paths and they share the same lock-on-played semantics for everyone.

- [x] Task 4. Update `convex/syndicates.ts:remove` to fetch the syndicate via `requireSyndicateOwnerOrAdmin`, retaining the bespoke played-check error message (`"Cannot delete a Syndicate that has been played. Games reference its content."`). Rationale: admin can delete unplayed syndicates owned by anyone, but the cascade and played-lock logic is unchanged. Cascade behaviour (drawbacks, minions, gamePlayerMinions, notes, player.selectedSyndicateId unselection in `ready` games) remains identical because it depends only on the syndicate id, not the caller.

- [x] Task 5. Update `convex/syndicates.ts:getWithChildren` to (a) treat the caller as authorised to view when they are the owner, the syndicate is shared, OR the caller is a site admin; (b) return an additional flag `isAdminView: boolean` on the result; (c) compute `canEdit` as `(isOwner || isAdmin) && !syndicate.played`. The `isOwner` flag continues to reflect literal ownership (not admin), so the editor can show owner attribution distinctly. Rationale: a single query change wires admin edit-rights through to every existing consumer (the editor page derives `canEdit` from the server already).

- [x] Task 6. Add new query `listAll` in `convex/syndicates.ts`: admin-only (calls `requireSiteAdmin`), returns every `syndicates` row decorated with `ownerName` and `ownerEmail`, sorted by `played` ascending then `_creationTime` descending. Rationale: gives the admin UI a single source of truth without disturbing `listMine` / `listShared` consumers.

- [x] Task 7. Verify `listSelectable` (`convex/syndicates.ts:240`) and any other gameplay query are NOT widened. Add an inline comment at `listSelectable` clarifying that admin parity intentionally does not extend to game-selection visibility. Rationale: keep admin power scoped to the management surface only.

### Backend — drawbacks and minions

- [x] Task 8. Replace `assertSyndicateEditable` with `assertSyndicateEditableForAdminOrOwner` at every call site in `convex/drawbacks.ts` (`create`, `update`, `remove`). Rationale: the editor page already calls these mutations for any user; widening enforcement here is the only way an admin's edits to others' syndicates' drawbacks actually persist.

- [x] Task 9. Replace `assertSyndicateEditable` with `assertSyndicateEditableForAdminOrOwner` at every call site in `convex/minions.ts` (`create`, `update`, `remove`). Rationale: same as drawbacks; minion cascade logic (gamePlayerMinions, minion-target notes) is caller-agnostic so no further changes are required.

### Backend — tests

- [x] Task 10. Extend `convex/drawbacks.test.ts` with an "admin-as-non-owner" test harness branch: an admin user creates/updates/removes a drawback on a syndicate owned by someone else (unplayed) and succeeds; the same operations on a played syndicate still throw. Rationale: locks both halves of the requirement (admin can edit; played still frozen).

- [x] Task 11. Add an equivalent test suite for the minion module at `convex/minions.test.ts` (or extend the existing minion test file if one is present) covering admin create/update/remove on a non-owned unplayed syndicate, and rejection on played. Rationale: keeps minion CRUD parity-tested alongside drawback CRUD.

- [x] Task 12. Add a syndicate-level admin test file `convex/syndicatesAdmin.test.ts` covering: (a) `update` and `setIsShared` succeed for an admin on a non-owned unplayed syndicate; (b) `remove` succeeds for an admin on a non-owned unplayed syndicate and cascades correctly; (c) `getWithChildren` returns the syndicate (and `isAdminView: true`, `canEdit: true`) when an admin queries a private non-owned unplayed syndicate; (d) `listAll` returns rows authored by other users; (e) `listSelectable` does NOT return non-owned non-shared syndicates for an admin (negative test for scope-creep). Rationale: locks the cross-cutting requirements that span query and mutation surfaces.

### Frontend — admin surface

- [x] Task 13. Add a new admin-only page component `src/pages/AdminSyndicatesListPage.tsx` that uses `api.syndicates.listAll`. The page renders a table/list of every syndicate showing name, leader, owner display name, shared/played badges, and a link to the existing `/syndicates/:syndicateId` editor route. Rationale: the editor route already works once the server widens visibility; admins only need a way to discover others' syndicates.

- [x] Task 14. Register the new page in `src/App.tsx` at `/admin/syndicates` (admin-only at the route level by redirecting non-admins to `/games` inside the component, mirroring the existing `AdminPage` gating idiom at `src/pages/AdminPage.tsx:22-32`). Rationale: keep admin URLs grouped under `/admin/*` consistent with the existing admin console URL.

- [x] Task 15. Add a link to "All Syndicates" inside `src/pages/AdminPage.tsx` (e.g. a new section header with a link to `/admin/syndicates`), and optionally a top-nav shortcut in `TopNav` inside `src/App.tsx` shown only when `me?.isSiteAdmin` (decision: add a single dropdown or keep using the existing single `Admin` link as the entry point — recommendation: keep top-nav minimal, add the link inside the Admin page only, to avoid nav clutter). Rationale: discoverability without nav bloat.

### Frontend — editor parity

- [x] Task 16. Update `src/pages/SyndicateEditorPage.tsx` to consume the new `isAdminView` flag from `getWithChildren`. Change the read-only banner logic so it no longer renders when an admin has edit rights, and rewrite the "non-owner" copy to differentiate three cases: (a) played → "permanently read-only" (unchanged), (b) non-owner viewing a shared syndicate → "Read-only view (you are not the owner)", (c) admin viewing a non-owned syndicate that they CAN edit → no banner, but display an "Editing as site admin — owned by {ownerName}" notice above the form. Rationale: explicit owner attribution prevents an admin from mistaking another user's syndicate for their own; existing player flow copy is preserved.

- [x] Task 17. Change the share-toggle button gate at `src/pages/SyndicateEditorPage.tsx:174` from `isOwner && canEdit` to simply `canEdit`. With the server widening, admins now have a legitimate edit path and may toggle `isShared`. Rationale: aligns the UI with the server permission model.

- [x] Task 18. Add owner attribution to the editor header (e.g. small caption under the syndicate name showing `Owner: {ownerName}`) whenever `isAdminView === true`. Surface owner display name in the `getWithChildren` response (denormalised in the same call to avoid a second round-trip). Rationale: makes admin context unmistakable.

### Frontend — list page polish

- [ ] Task 19. Optionally extend `src/pages/SyndicatesListPage.tsx` to render a callout (admin-only) explaining that the "All Syndicates" admin view exists. Optional — only worthwhile if the existing top-nav Admin link is judged insufficiently discoverable. Default recommendation: skip in v1 to minimise UI churn.

- [x] Task 20. Confirm `src/pages/SharedSyndicatesPage.tsx` continues to use `listShared` (no admin change needed — the page is intentionally about cross-user discovery of shared syndicates, not admin oversight). Rationale: keep player flows untouched.

### Verification round

- [x] Task 21. Manually walk every modified mutation/query call site to confirm no other consumer relied on the strict ownership semantics of `requireSyndicateOwner` or `assertSyndicateEditable` (a search for these symbol names should match only the four affected modules: `syndicates.ts`, `drawbacks.ts`, `minions.ts`, `lib/auth.ts`). Rationale: catch silent regressions.

- [x] Task 22. Confirm no existing tests rely on the rejection path that admin parity changes (e.g. a test that asserts `update` throws when a non-owner-but-admin caller invokes it). Update any such tests to reflect the new contract. Rationale: keep CI green.

- [x] Task 23. Run the full Convex test suite (`npx vitest`) and verify all existing and new tests pass. Rationale: regression coverage.

## Verification Criteria

- An authenticated user with `users.isSiteAdmin === true` can fetch (via `api.syndicates.listAll`) and view in the admin UI every syndicate row in the database with its owner attribution.
- The same admin can navigate to `/syndicates/:syndicateId` for ANY syndicate (including private non-owned ones) and the page renders the full editor with no "read-only" banner when the syndicate is not played.
- The admin can save edits to `name`, `leader`, `description`, `isShared`, add/edit/remove drawbacks, add/edit/remove minions, and delete the syndicate, on any non-owned non-played syndicate, with all server-side validation and cascade semantics unchanged.
- Played syndicates remain read-only for everyone, including admins, with the existing copy and lockouts.
- Non-admin users see no behaviour change anywhere: `listMine`, `listShared`, `listSelectable`, `getWithChildren` visibility, and all mutations behave exactly as before for them; their attempts to call `listAll` fail with the same site-admin error message used elsewhere in the codebase.
- The admin editor view shows explicit owner attribution so the admin cannot mistake another user's syndicate for their own.
- All new and existing tests pass under the existing `convex-test` harness.

## Potential Risks and Mitigations

1. **Accidentally lifting the `played === true` lock for admins.**
   Mitigation: the new `assertSyndicateEditableForAdminOrOwner` helper preserves the `played` check unconditionally, and Tasks 10-12 add explicit negative tests asserting that played-state rejection still applies to admin callers.

2. **`listSelectable` (or another gameplay query) silently widened, letting an admin pick any private syndicate when joining a game.**
   Mitigation: Task 7 explicitly leaves `listSelectable` untouched and adds an inline comment; Task 12 adds a negative test verifying that admins are not given selection visibility into non-owned, non-shared syndicates.

3. **Cascade logic in `remove` misbehaves when triggered by a non-owner admin.**
   Mitigation: the cascade reads the syndicate id only and performs no owner-scoped queries; Task 12 covers the cascade explicitly with an admin caller against a non-owned syndicate that has drawbacks, minions, notes, and player selections referencing it.

4. **UI mistakes another user's syndicate for the admin's own, leading to accidental edits.**
   Mitigation: Task 16 + Task 18 add explicit "Editing as site admin — owned by …" attribution above the form; the share-toggle behaviour is unchanged for owners and gains identical capability for admins.

5. **Future contributors re-introduce `requireSyndicateOwner`/`assertSyndicateEditable` at a new mutation site without realising admin parity is now the norm.**
   Mitigation: file-level JSDoc on `convex/lib/auth.ts` documents the convention; Task 21 confirms current call sites; the strict-owner helpers remain exported so the choice is intentional and reviewable.

6. **`getWithChildren` payload grows (added `isAdminView`, owner name) and breaks a TypeScript consumer.**
   Mitigation: the new fields are additive; existing consumers (`SyndicateEditorPage.tsx`) destructure named fields only and are updated in the same change set.

## Alternative Approaches

1. **Widen the existing `requireSyndicateOwner` / `assertSyndicateEditable` helpers in place** instead of adding new admin-aware helpers. Trade-offs: smaller diff, but loses the explicit signal at call sites — every mutation silently gains admin parity, making it harder to spot future call sites that should be strict-owner only. Rejected for clarity.

2. **Create dedicated admin-only mutations (e.g. `syndicates.adminUpdate`)** that the admin UI uses, leaving the user-facing mutations untouched. Trade-offs: duplicate validation/cascade code and a divergent surface that's easy to drift from. Rejected.

3. **Lift the `played` lock for admins as part of "edit all".** Trade-offs: would let an admin retroactively rewrite a played syndicate, but other tables (`callRollSets`, `notes` with frozen `attachedRollSetId`, `gamePlayerMinions`) assume the played syndicate's content is immutable; lifting the lock would corrupt the data-integrity contract. Rejected.

4. **Surface "All Syndicates" by mixing others' syndicates into `listMine`.** Trade-offs: simpler frontend change, but pollutes "My Syndicates" with content the admin didn't author and confuses the share-toggle / delete affordances on their own page. Rejected in favour of a dedicated admin route.

5. **Add an audit log (`syndicateAdminActions` table) recording every admin write.** Trade-offs: adds traceability but expands scope significantly; not requested. Documented here as a follow-up.
