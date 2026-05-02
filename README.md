# joint-cross-platform-playlist

One-way Spotify → YouTube playlist sync. Press *Sync now*, the chunked sync engine
walks the diff against a quota budget, and your YouTube playlist matches your
Spotify playlist.

Architecture and the four hard free-tier constraints are documented in
[CLAUDE.md](./CLAUDE.md). Implementation plan lives in
`~/.claude/plans/review-this-plan-in-federated-shell.md`.

## Stack

- Next.js 16 (App Router) on Vercel Hobby
- Postgres on Neon (no auto-pause)
- Auth.js v5 with Google sign-in
- Drizzle ORM
- Spotify Web API + YouTube Data API v3
- libsodium-wrappers for at-rest token encryption

## Local development

### 1. Provision external services

You will need accounts on:

- **Neon** (neon.tech) — free Postgres
- **Google Cloud Console** — OAuth client + YouTube Data API
- **Spotify Developer Dashboard** (developer.spotify.com)

#### Google Cloud (one project for both Auth.js sign-in and YouTube connect)

1. Enable **YouTube Data API v3** under APIs & Services → Library.
2. Configure the **OAuth consent screen** with scopes:
   - `openid`, `email`, `profile`
   - `https://www.googleapis.com/auth/youtube.force-ssl`
3. Create a single OAuth 2.0 Client (Web application) and add **both** of these
   authorized redirect URIs:
   - `http://127.0.0.1:3000/api/auth/callback/google` (Auth.js sign-in)
   - `http://127.0.0.1:3000/api/connect/youtube/callback` (YouTube connect)
4. **Submit a quota-increase request** (APIs → YouTube Data API v3 → Quotas →
   *Apply for higher quota*). The default 10,000 units/day cap is exhausted
   after roughly one 100-track first sync. Free, takes a few business days.

The same Client ID / Client Secret goes into `.env.local` as **both**
`AUTH_GOOGLE_*` and `YOUTUBE_CLIENT_*` — one Google client serving both flows.

#### Spotify

1. Create an app at developer.spotify.com → Dashboard.
2. Add redirect URI `http://127.0.0.1:3000/api/connect/spotify/callback`.
3. Copy Client ID and Client Secret.

> **Spotify rejects `localhost` for new apps.** The whole app is configured for
> `http://127.0.0.1:3000` in dev — visit that URL, not `http://localhost:3000`,
> or cookies and OAuth state will not line up.

### 2. Configure environment

Copy `.env.example` to `.env.local` and fill in:

```bash
NEXTAUTH_URL=http://127.0.0.1:3000
NEXTAUTH_SECRET=$(openssl rand -base64 32)
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000

NEON_DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Generate once. Rotating this invalidates ALL stored OAuth tokens.
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)

AUTH_GOOGLE_ID=...apps.googleusercontent.com
AUTH_GOOGLE_SECRET=...

YOUTUBE_CLIENT_ID=...apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=...

SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

### 3. Database

```bash
npm install
npm run db:migrate   # applies all migrations to NEON_DATABASE_URL
```

### 4. Run

```bash
npm run dev
# open http://127.0.0.1:3000
```

Sign in with Google → connect Spotify → connect YouTube → pick one playlist
each → Create pair → Sync now.

## Scripts

```bash
npm run dev          # dev server
npm run build        # production build
npm run typecheck    # tsc --noEmit
npm run lint         # next lint
npm test             # vitest run
npm run db:generate  # generate migration from db/schema.ts
npm run db:migrate   # apply migrations
npm run db:studio    # browse data
```

## Deploy to Vercel

Production URL: **https://joint-cross-platform-playlist.vercel.app**

Once the app works locally:

1. **Vercel** → New Project → import this GitHub repo.
2. **Environment Variables** (Production environment): copy every value from
   `.env.local` *except* the URL ones, which become:
   - `NEXTAUTH_URL=https://joint-cross-platform-playlist.vercel.app`
   - `NEXT_PUBLIC_APP_URL=https://joint-cross-platform-playlist.vercel.app`
3. **Add production redirect URIs to your OAuth clients** before deploying:
   - Google OAuth client → Authorized redirect URIs, add:
     - `https://joint-cross-platform-playlist.vercel.app/api/auth/callback/google`
     - `https://joint-cross-platform-playlist.vercel.app/api/connect/youtube/callback`
   - Spotify app → Redirect URIs, add:
     - `https://joint-cross-platform-playlist.vercel.app/api/connect/spotify/callback`
4. Push to `main` (or click *Deploy* in Vercel) — Vercel builds and deploys.
5. After first deploy, sign in and run a small sync to verify.

### Production checklist

- [ ] All env vars set in Vercel (production environment).
- [ ] Production redirect URIs added to both OAuth clients.
- [ ] YouTube quota-increase request submitted to Google.
- [ ] First sync tested with a small playlist (≤ 20 tracks).

## Known limitations

- **No real YouTube Music API.** The app manages playlists on the
  youtube.com surface, which YouTube Music *usually* mirrors but not always.
- **Imperfect cross-platform availability.** Tracks unavailable or unmatched
  go to `unmatched_tracks` rather than failing silently.
- **Daily YouTube quota.** Even with mapping cache + ISRC short-circuit, the
  first sync of a very large playlist may need to span multiple days.

## Tests

```
npm test
```

5 test files, 66 tests covering: token vault round-trip + tampering, matcher
normalization + ISRC short-circuit + fuzzy + channel-suffix stripping,
Spotify client pagination + chunking + 429/401 retries, YouTube client
quota accounting + 403-quota vs 403-rate distinction + batch fetches, sync
engine plan + step state machine + idempotency + cross-user rejection.
