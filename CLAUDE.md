# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A web app that **bidirectionally** syncs a chosen Spotify playlist with a chosen YouTube playlist on demand ("Sync Now" button). A track added on either side propagates to the other; a track removed from either side propagates the removal. Convergence is per-press, not continuous. Personal/small-multi-user; deployed entirely on free tiers (Vercel Hobby + Neon Free).

> **Current implementation state:** the M0–M9 build (commits `d55f6c5`..`3bde157`) ships the one-way Spotify → YouTube path, additive only. Two-way semantics — reverse adds, removals on either side, and delta detection against a stored baseline — are **planned but not yet built**. Sections marked *(planned)* below describe the target; sections without that marker describe what's in main today.

The full revised spec lives at `/Users/aayzaahmed/.claude/plans/review-this-plan-in-federated-shell.md`. This document is the implementation reference: the plan tells you *what* to build, this tells you *how the system fits together* and *which constraints are non-negotiable*.

## The four hard constraints (every design decision traces back here)

These are not preferences. Violating them means the app fails or violates provider policy. Whenever you change architecture, sanity-check against this list.

1. **YouTube Data API quota is 10,000 units/day** (resets 00:00 America/Los_Angeles, not UTC).
   - `search.list` = 100 units. `playlistItems.insert` = 50 units. `playlistItems.delete` = 50 units. `playlistItems.list` = 1 unit/page. `videos.list` = 1 unit per call (up to 50 IDs).
   - A naive 100-track first sync = ~15,000 units → blown quota mid-sync.
   - Mitigations baked in: (a) `track_mappings` cache checked before every `search.list`, (b) ISRC-based join short-circuits search entirely when both sides expose it, (c) `videos.list` batched (50 IDs/call) for duration scoring instead of re-searching, (d) `quota_usage` table guards every call, (e) on `403 quotaExceeded` the run flips to `paused_quota` and resumes after midnight Pacific.
   - **Never add a code path that calls `search.list` without first checking `track_mappings`.**
   - *(planned, two-way)* Two-way doesn't worsen the worst case: only items new to YouTube cost search/insert; items new to Spotify only cost Spotify-side calls (Spotify is rate-limited but has no daily quota cap). Delta-based steady-state syncs are the *cheap* case — only changes since the last baseline cost any quota.

2. **Vercel Hobby = 10 seconds per serverless function invocation.** Fluid Compute can extend to 60s but the function still must return; do not assume it.
   - A 100-track sync doing sequential YouTube searches + inserts is ~30s minimum. Single-shot sync will 504 mid-flight and corrupt state.
   - Mitigation: chunked sync. `POST /api/sync/[pairId]` plans the run and persists `sync_runs` + `sync_run_items`. `POST /api/sync/[pairId]/step` processes ~5 items per call within an 8s wall budget (2s margin). Frontend polls `/step` until `status` is `done | failed | paused_quota`. Refresh-resilient because state lives in Postgres.
   - **Never put more than ~8 seconds of work in a single API route.** If you find yourself wanting to, persist intermediate state and return.

3. **Postgres is Neon (free tier), not Supabase.** Picked over Supabase because Supabase Free pauses projects after 7 days of inactivity, which collides with monthly-use sync patterns. Neon scales compute to zero with fast resume (~hundreds of ms) instead of pausing.
   - Connection via `@neondatabase/serverless` over HTTP from Vercel functions. Drizzle ORM for schema and queries.
   - **No Supabase code anywhere.** If a snippet from somewhere references `@supabase/supabase-js` or anon keys, it's wrong for this stack.

4. **OAuth refresh tokens stored plaintext violate Spotify's and Google's developer policies.**
   - Encrypted at rest with libsodium secretbox in `connected_accounts`. Key from `TOKEN_ENCRYPTION_KEY` env (32 bytes, `openssl rand -base64 32`).
   - Every Spotify/YouTube call goes through `lib/auth/tokens.ts → getValidAccessToken(userId, provider)`, which reads the encrypted row, refreshes if `expiry - now() < 60s`, persists rotated refresh tokens (Spotify rotates sometimes), decrypts, and returns the access_token.
   - **Never read `connected_accounts.access_token_*` directly from a route or client.** Always go through the helper.

## Architecture

```
Browser
  │  Auth.js Google session (HTTP-only cookie)
  ▼
Next.js App Router on Vercel
  │
  ├── app/api/auth/[...nextauth]   ← app login (Google)
  ├── app/api/connect/{spotify,youtube}   ← provider OAuth, writes connected_accounts
  ├── app/api/playlists/{spotify,youtube} ← uses getValidAccessToken
  ├── app/api/playlist-pairs              ← CRUD on playlist_pairs
  ├── app/api/sync/[pairId]               ← plans a 2-way diff vs baseline (planned)
  ├── app/api/sync/[pairId]/step          ← processes one chunk per invocation
  └── app/dashboard                       ← UI: connect, pick, pair, sync, history
        │
        ▼ polling
        sync_runs + sync_run_items rows progress
  │
  ▼  drizzle + @neondatabase/serverless (HTTP)
Neon Postgres
   │
   └─ playlist_pairs.last_known_* JSONB ← per-pair baseline snapshot (planned)
       written at end of every successful run; consulted by next planRun
       to compute deltas on each side instead of re-scanning everything.
```

App-level identity is **Auth.js** (NextAuth) with the Google provider, Drizzle adapter, sessions in Postgres. Auth.js owns `users` / `accounts` / `sessions` / `verification_tokens`.

Provider-level connections (Spotify, YouTube) are **separate from app login** and live in our own `connected_accounts` table. A user signed in via Google still has to click "Connect YouTube" to grant playlist scope. Clicking "Connect Spotify" runs a separate OAuth flow with its own state nonce.

Authorization model: every query includes `where user_id = session.user.id`. There is no Postgres-level RLS (Auth.js + Neon has no Postgres-side identity). All authorization is in app code — be rigorous.

## Data model (high level)

Schema definition lives in `db/schema.ts` (Drizzle). The full DDL is in the plan file. The non-obvious tables and why they exist:

- **`connected_accounts`** — encrypted Spotify and YouTube OAuth tokens. Unique `(user_id, provider)`. Distinct from Auth.js's `accounts` which holds the Google app-login token.
- **`track_mappings`** — `(user_id, spotify_track_id) → youtube_video_id` plus `isrc`, `confidence`, `match_method`. **The single most important table for staying under YouTube quota.** Persisted on every successful match. Indexed on `(user_id, isrc)` for ISRC short-circuit lookups.
- **`sync_runs`** — one row per Sync Now press. Status: `pending | running | done | failed | paused_quota`. Holds counters and `quota_units_spent` for the run.
- **`sync_run_items`** — one row per planned operation in a run (action: `add | remove | skip`, status: `pending | done | failed`, optional `youtube_video_id`). Lets `/step` resume after a timeout, refresh, or partial failure.
- **`unmatched_tracks`** — tracks below the 0.75 confidence threshold. Stores top-3 candidates as JSON for a future "fix matches" UI. **Never auto-add anything below threshold** — it lands here instead.
- **`quota_usage`** — `(date, units_used)` keyed in Pacific time. Every YouTube call increments it; every run pre-checks remaining budget.
- **`playlist_pairs`** — Spotify ↔ YouTube playlist pairing. `broken=true` if either playlist 404s. *(planned)* Adds `last_synced_at`, `last_known_spotify_track_ids` (jsonb `string[]`), and `last_known_youtube_items` (jsonb `[{videoId, playlistItemId}]`) — the per-pair baseline that `planRun` diffs against. The baseline is written at end-of-run only when `status=done`; `paused_quota` and `failed` runs leave it untouched so the next attempt starts from the same reference point.

## Sync state machine

State graph is the same in both directions:

```
sync_runs.status:
   pending  ──► running  ──► done   (writes new baseline)
       │          │  ▲         ▲
       ▼          │  └─ /step processes batches ─┐
   (planRun       │                              │
    fills         │                              │
    sync_run_items)                              │
                  │                              │
                  ├─► paused_quota  (resume next day, baseline not updated)
                  └─► failed       (terminal — surface error, baseline not updated)
```

### Current implementation: one-way, additive only

`planRun(pairId, userId)`:
1. Fetch both playlists fully (paginated reads).
2. Build `existingYouTubeVideoIds: Set<string>`.
3. For each Spotify track:
   - Look up `track_mappings` by `spotify_track_id` → if hit and videoId already in set, action = `skip`; else action = `add` with known videoId.
   - Else if ISRC matches an existing mapping by `(user_id, isrc)` → action = `add` with that videoId.
   - Else action = `add` with `youtube_video_id = null` (resolve at step time).
4. Insert `sync_runs` and `sync_run_items` rows, return `{runId, plannedAdds, plannedSkips, plannedQuotaUnits}`.

`stepRun(runId, budget)`:
1. Wall-clock budget = 8s. Quota budget = check `quota_usage`; refuse if `units_used + estimated > 9500`.
2. Take next N pending `sync_run_items` (e.g. 5).
3. For each item with `youtube_video_id = null`: call `searchVideos(track.title, track.artists)`, batch-validate via `getVideosByIds` for duration, score, pick best. If best ≥ 0.75 → match; else write `unmatched_tracks` and mark item `failed` with error `low_confidence`.
4. For each item with a videoId not already present in YouTube playlist: `playlistItems.insert`. Idempotency: skip if already member (we built the membership set at plan time and updated it as we add).
5. Persist `track_mappings` on every successful resolve.
6. Update `sync_runs` counters and `quota_units_spent`.
7. On `403 quotaExceeded` → `status = paused_quota`. On `429` → backoff and continue if budget allows. On other errors → mark item failed, continue.
8. Return `{processed, remaining, quotaRemainingToday, status}`.

### Planned: two-way delta-based sync

The shape is unchanged (planRun → multiple stepRun calls → done) but the body of `planRun` and the action vocabulary expand.

`sync_run_items.action` (planned) becomes one of:

```
add_to_yt    | add_to_sp    | remove_from_yt    | remove_from_sp    | skip
```

Each item names *one operation on one provider*; a single Spotify track that needs both directions is impossible by construction.

`planRun` algorithm (planned):

1. Read pair's baseline: `sp_baseline = pair.last_known_spotify_track_ids ?? []`, `yt_baseline = pair.last_known_youtube_items ?? []`.
2. Fetch both playlists fully (paginated reads). Build `sp_now: Set<spotifyTrackId>` and `yt_now: Map<videoId, playlistItemId>`.
3. **Compute deltas per side** vs baseline:
   - `sp_added = sp_now - sp_baseline`
   - `sp_removed = sp_baseline - sp_now`
   - `yt_added = yt_now.keys - yt_baseline.videoIds`
   - `yt_removed = yt_baseline.videoIds - yt_now.keys`
4. **First-time sync (no baseline):** treat `sp_baseline = ∅`, `yt_baseline = ∅`. Result: `sp_added = sp_now`, `yt_added = yt_now`, no removals. This is the *union* — every track on either side gets propagated to the other. Document the soft-cap of ~150 total tracks for first sync (quota).
5. **Conflict resolution** (deterministic, no surprises):
   - For each Spotify track in `sp_removed`, look up its mapping → if the mapped `videoId` is in `yt_added` for *this* run, treat as a re-add: drop from removal list, also drop from `yt_added` to avoid duplicate insert. **Adds win over removes**, on either side.
   - Same logic mirrored: a `yt_removed` whose Spotify counterpart appears in `sp_added` is collapsed.
6. **Generate operations**:
   - For each `track_id ∈ sp_added`: emit `add_to_yt` (resolve videoId now from `track_mappings`/ISRC, else null → step-time search).
   - For each `track_id ∈ sp_removed`: look up its mapping; if it points to a `videoId` still in `yt_now`, emit `remove_from_yt` carrying that `playlistItemId`. If no mapping or videoId already absent on YT, emit `skip` with reason `unmappable_removal`.
   - For each `videoId ∈ yt_added`: emit `add_to_sp` (resolve `spotify_track_id` now from a reverse lookup against `track_mappings(user_id, youtube_video_id)`; else null → step-time Spotify search).
   - For each `videoId ∈ yt_removed`: look up its mapping; if a `spotify_track_id` is still in `sp_now`, emit `remove_from_sp`. Else `skip`.
7. Insert `sync_runs` (status=`pending`) and the `sync_run_items` rows with their action types. Return `{runId, plannedAdds, plannedRemoves, plannedSkips, plannedQuotaUnits}` — counters now sum across both directions.

`stepRun` algorithm (planned): same wall + quota budget. Per item, dispatch on `action`:

- **add_to_yt**: identical to today's resolve-or-search path; on success, persist `track_mappings`, insert via `playlistItems.insert`.
- **add_to_sp**: if `spotify_track_id` known, `playlist_add_items` directly. Else `searchTracks(query)` against Spotify → score with the existing matcher (it's symmetric) → if ≥ 0.75 add and persist mapping; else `unmatched_tracks`. **No quota cost on the YouTube side for this branch.** Spotify search is rate-limited, not quota-limited.
- **remove_from_yt**: `playlistItems.delete(playlistItemId)`. Costs 50 units.
- **remove_from_sp**: `playlist_remove_items` with `{tracks: [{uri, positions}]}`.
- **skip**: write `done` with no provider call.

On terminal `done`, write the new baseline to `playlist_pairs` *atomically with* the run-status update — same transaction, so a crashed step never leaves a stale baseline next to a marked-done run.

### Why not propagate deletes by absence-of-mapping?

The whole reason we need a baseline: a track present on Spotify and absent from YouTube means *either* (a) it was just added on Spotify and needs to be added on YouTube, *or* (b) it was just removed from YouTube and needs to be removed from Spotify. Without a snapshot of last-time's state, those are indistinguishable, and you'd either spam re-adds or silently drop user removals.

## Track matching

Pipeline lives in `lib/match/normalize.ts`. **ISRC short-circuit before anything else.**

Normalization:
1. NFKD normalize, strip diacritics (`Beyoncé` → `beyonce`), lowercase, collapse whitespace.
2. Strip parenthetical noise: `(Remastered 2011)`, `(Live ...)`, `(Deluxe)`, `(Mono)`, `(Radio Edit)`, `- 2011 Remaster`. Regex set is in the file; don't expand it casually — false positives strip real distinguishing info.
3. Split featured artists: `feat.|ft.|featuring|with` → merge into artist set.
4. Compare artists as **sets** (Jaccard ≥ 0.5), not strings. Spotify gives `artists: Array<{name}>`; YouTube gives one `snippet.channelTitle` string.

Scoring:
- `titleSim` = fast-fuzzy token-set ratio (0..1).
- `artistJaccard` (0..1).
- `durationScore` = 1.0 if ±3s, 0.7 if ±10s, 0 if >15s.
- `score = 0.5 * titleSim + 0.3 * artistJaccard + 0.2 * durationScore`.
- Threshold = 0.75 to auto-accept. Below → `unmatched_tracks` with top-3.

`NormalizedTrack`:
```ts
type NormalizedTrack = {
  title: string;
  artists: string[];               // not artist: string
  durationMs: number;
  isrc?: string;                   // Spotify exposes this; YouTube usually doesn't
  source: 'spotify' | 'youtube';
  sourceTrackId: string;           // spotify trackId or youtube videoId
  sourcePlaylistItemId?: string;   // YT playlistItem.id, REQUIRED for removals
};
```

`sourcePlaylistItemId` is critical: YouTube removes by `playlistItem.id` (a synthetic per-membership ID), not by videoId. Without it, removals 404. Capture it on every `playlistItems.list` page.

### Reverse direction *(planned, two-way)*

`matchYouTubeToSpotify(yt_track, candidates)` reuses the same `scoreCandidate` function — title+artist+duration scoring is symmetric. Differences from the forward path:

- Candidates come from `spotify.searchTracks(query)` instead of `youtube.searchVideos(query)`. Spotify search has rate limits but no daily quota cap, so the reverse direction is essentially "free" relative to the YouTube quota budget.
- Spotify's results expose ISRC and a clean artist array, so artist Jaccard is more reliable than the forward direction (where YouTube gives only one `channelTitle` string).
- Reverse cache hit: a second-direction lookup on `track_mappings` keyed by `youtube_video_id`. The schema migration for two-way adds an index on `(user_id, youtube_video_id)` so this lookup stays fast.

## OAuth flow specifics

**Both providers**:
- Mandatory `state` nonce. Generate 32 random bytes, store in a signed short-lived HTTP-only cookie, verify on callback. Reject mismatches.
- Persist tokens via the encryption helper, never plaintext.

**Spotify** (`/api/connect/spotify` + `/api/connect/spotify/callback`):
- Scopes: `playlist-read-private playlist-modify-private`. **Drop `playlist-modify-public`** — MVP only touches private playlists.
- PKCE flow. Code verifier in cookie, code challenge in auth URL.
- Spotify rotates refresh tokens sometimes — always persist whatever comes back from token exchange/refresh.

**Google/YouTube** (`/api/connect/youtube` + `/api/connect/youtube/callback`):
- Scope: `https://www.googleapis.com/auth/youtube.force-ssl`.
- Auth URL **must** include `access_type=offline&prompt=consent`. Without `access_type=offline` the refresh_token is missing on first auth; without `prompt=consent` it's missing on re-auth.

**Disconnect** (`DELETE /api/connect/{provider}`):
- Decrypt token, call provider revoke endpoint (`accounts.spotify.com/api/token` revoke for Spotify, `oauth2.googleapis.com/revoke` for Google), then delete the row. Don't reverse the order — if revoke fails after the row is deleted, the token lives on with no record.

## Environment variables

Local: `.env.local`. Production: Vercel env vars.

```
# App
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=                    # openssl rand -base64 32
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Database (Neon)
NEON_DATABASE_URL=postgresql://...

# Token encryption (libsodium secretbox)
TOKEN_ENCRYPTION_KEY=               # openssl rand -base64 32 (must be 32 bytes decoded)

# App login (Auth.js Google provider)
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=

# Provider connect: YouTube (separate Google OAuth client is fine, or reuse)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=

# Provider connect: Spotify
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

The Auth.js Google client and the YouTube-connect Google client *can* be the same OAuth client (just merge the scopes), but treating them as separate clients with separate scopes makes the user grant only what's needed at each step. Default to separate.

## Provider client guidelines

- **Pagination is mandatory** for both reads and writes. Spotify tracks page at 100, YouTube playlistItems at 50. `playlist_add_items` takes up to 100 URIs per call (Spotify); YouTube `playlistItems.insert` is one-at-a-time and 50 units each.
- **Concurrency cap**: `p-limit` at 4 across all provider calls. Burst > 4 → 429s.
- **Spotify 429**: respect `Retry-After` header; back off and retry (max 3 retries).
- **YouTube 403**: distinguish `error.errors[0].reason`. `quotaExceeded` → terminal for the day, set `paused_quota`. `rateLimitExceeded` or `userRateLimitExceeded` → exponential backoff and retry.
- **Idempotent inserts**: at plan time, build `existingYouTubeVideoIds: Set<string>`. Update it as you insert in step time. Never call `playlistItems.insert` for a videoId already in the set.
- **Pacific-time quota reset**: surfacing "quota resets in X hours" needs America/Los_Angeles, not UTC. Use a timezone-aware computation; off-by-an-hour DST bugs are easy here.

## Commands

The Next.js app is not yet scaffolded (the repo is a fresh init at the time of writing). Once `npx create-next-app` runs in this directory and Drizzle is added, the standard commands will be:

```bash
npm run dev            # Next.js dev server, http://localhost:3000
npm run build          # production build
npm run typecheck      # tsc --noEmit
npm run lint           # next lint
npm run db:generate    # drizzle-kit generate (writes a migration from schema.ts)
npm run db:migrate     # drizzle-kit migrate (applies migrations to NEON_DATABASE_URL)
npm run db:studio      # drizzle-kit studio (browse data)
```

If the app is scaffolded but these scripts are missing, add them to `package.json` rather than running raw `drizzle-kit` invocations — keeps verification reproducible.

## Things that are easy to get wrong

- **Forgetting to check `track_mappings` before `search.list`.** Will silently re-burn quota on every re-sync. Always cache-first.
- **Reading `connected_accounts.access_token` directly.** Bypasses refresh; routes will start 401-ing one hour after each connect. Always go through `getValidAccessToken`.
- **Putting the whole sync in one route.** Vercel will 504 on real playlists. Always chunked + polled.
- **Treating YouTube videoId and playlistItemId as the same thing.** They aren't. Removals require `playlistItemId`; record it on every read.
- **Stringifying Spotify's `artists` array as `track.artists.join(", ")` and matching that against YouTube's `channelTitle`.** Misses many true matches. Always set-compare normalized artist tokens.
- **Using UTC for the quota reset.** YouTube quota is Pacific. Off by up to 8 hours.
- **Adding `playlist-modify-public` scope to Spotify because the original spec listed it.** MVP doesn't need it; broader scope = more user friction.
- **Using `@supabase/supabase-js` because some snippet referenced it.** This stack is Neon + Drizzle + Auth.js. No Supabase.
- **Skipping `access_type=offline` on Google OAuth.** First connect works, second doesn't, and you'll spend an hour figuring out why.
- **Lowercasing-and-dashing `${title}-${artist}` as a match key.** This is what the original spec proposed and what we explicitly rejected. Use the full normalize+fuzzy+ISRC pipeline.
- *(planned, two-way)* **Updating the baseline before the run is `done`.** A `paused_quota` or `failed` run that updates the baseline will misclassify later additions/removals as in-baseline. Baseline write must be atomic with `status=done`, in the same transaction.
- *(planned, two-way)* **Treating absence of mapping as "removed."** A track present on Spotify with no `track_mappings` row could be brand-new on Spotify *or* a track we never managed to match. Only the **baseline** distinguishes these. Don't infer removal from absence of mapping.
- *(planned, two-way)* **Conflict policy ambiguity.** When the same track appears in both `sp_added` and `yt_removed` (or vice versa), the rule is unconditional: **adds win, removes lose**, on either side. Document this loudly when it surfaces in the UI ("preserved on both sides").
- *(planned, two-way)* **Re-using `track_mappings` for reverse lookups without an index.** A `(user_id, spotify_track_id)` PK doesn't help when querying by `youtube_video_id`. Add the `(user_id, youtube_video_id)` index in the migration that introduces two-way; without it the reverse lookup degrades to a table scan per item.

## Where to look first when debugging

- Sync stuck at `pending` → `planRun` errored before persisting items. Check route logs.
- Sync stuck at `running` with no progress → either the frontend stopped polling or `/step` is returning early. Check `quota_usage` for the day.
- 401s from Spotify or YouTube an hour after connecting → `getValidAccessToken` not being awaited or token row not updating. Check the `expiry` column.
- Playlists not showing → user signed into Auth.js but hasn't connected the provider. `connected_accounts` has no row for that `(user_id, provider)`.
- Duplicate tracks on YouTube → `existingYouTubeVideoIds` set isn't being updated mid-step, or membership built from stale data.
- "Quota exceeded" hit on first sync of the day → mapping cache not being checked, or planRun is calling `search.list` instead of deferring to step time.
