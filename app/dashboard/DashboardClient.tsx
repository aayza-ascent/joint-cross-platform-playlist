"use client";

import { useEffect, useState } from "react";

type Connections = { spotify: boolean; youtube: boolean };

type PairRow = {
  id: string;
  spotifyPlaylistId: string;
  youtubePlaylistId: string;
  broken: boolean;
  createdAt: string;
};

type SpPlaylist = { id: string; name: string; trackCount: number };
type YtPlaylist = { id: string; title: string; itemCount: number };

type FailureCandidate = {
  videoId: string;
  title: string;
  channelTitle: string;
  durationMs: number;
  score: number;
};

type Failure = {
  action: string;
  error: string | null;
  spotifyTrackId: string | null;
  youtubeVideoId: string | null;
  spotifyTitle: string | null;
  spotifyArtists: string[] | null;
  candidates: FailureCandidate[] | null;
};

type SyncProgress = {
  runId: string;
  status: "running" | "done" | "failed" | "paused_quota";
  addedYt: number;
  addedSp: number;
  removedYt: number;
  removedSp: number;
  failed: number;
  remaining: number;
  totalPlanned: number;
  isFirstSync: boolean;
  quotaRemainingToday: number;
  errorDetail?: string;
  failures?: Failure[];
};

export default function DashboardClient(props: {
  initialConnections: Connections;
  initialPairs: PairRow[];
}) {
  const [connections, setConnections] = useState(props.initialConnections);
  const [pairs, setPairs] = useState(props.initialPairs);

  const [spPlaylists, setSpPlaylists] = useState<SpPlaylist[] | null>(null);
  const [ytPlaylists, setYtPlaylists] = useState<YtPlaylist[] | null>(null);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);

  const [selectedSp, setSelectedSp] = useState<string | null>(null);
  const [selectedYt, setSelectedYt] = useState<string | null>(null);
  const [creatingPair, setCreatingPair] = useState(false);

  const [mirrorName, setMirrorName] = useState("");
  const [creatingMirror, setCreatingMirror] = useState(false);
  const [mirrorError, setMirrorError] = useState<string | null>(null);

  const [syncByPair, setSyncByPair] = useState<Record<string, SyncProgress>>(
    {},
  );

  const bothConnected = connections.spotify && connections.youtube;

  useEffect(() => {
    if (!bothConnected) return;
    let cancelled = false;
    setLoadingPlaylists(true);
    setPlaylistsError(null);
    Promise.all([
      fetch("/api/playlists/spotify").then(handleApi<{ playlists: SpPlaylist[] }>),
      fetch("/api/playlists/youtube").then(handleApi<{ playlists: YtPlaylist[] }>),
    ])
      .then(([sp, yt]) => {
        if (cancelled) return;
        setSpPlaylists(sp.playlists);
        setYtPlaylists(yt.playlists);
      })
      .catch((err) => {
        if (cancelled) return;
        setPlaylistsError(formatError(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingPlaylists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bothConnected]);

  async function handleDisconnect(provider: "spotify" | "youtube") {
    if (!confirm(`Disconnect ${provider}? You'll need to reconnect to sync.`))
      return;
    const res = await fetch(`/api/connections?provider=${provider}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setConnections((c) => ({ ...c, [provider]: false }));
      if (provider === "spotify") setSpPlaylists(null);
      if (provider === "youtube") setYtPlaylists(null);
    }
  }

  async function createPair() {
    if (!selectedSp || !selectedYt) return;
    setCreatingPair(true);
    try {
      const res = await fetch("/api/playlist-pairs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spotifyPlaylistId: selectedSp,
          youtubePlaylistId: selectedYt,
        }),
      });
      const json = await handleApi<{ pair: PairRow }>(res);
      setPairs((ps) => [json.pair, ...ps.filter((p) => p.id !== json.pair.id)]);
      setSelectedSp(null);
      setSelectedYt(null);
    } catch (err) {
      alert(formatError(err));
    } finally {
      setCreatingPair(false);
    }
  }

  async function createMirror() {
    if (!mirrorName.trim()) return;
    setCreatingMirror(true);
    setMirrorError(null);
    try {
      const res = await fetch("/api/playlist-pairs/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: mirrorName.trim() }),
      });
      const json = await handleApi<{ pair: PairRow }>(res);
      setPairs((ps) => [json.pair, ...ps.filter((p) => p.id !== json.pair.id)]);
      setMirrorName("");
      // Refresh playlist lists so the new playlists appear with their proper
      // names on the pair card (the lookup maps power both pickers and the
      // pair-card title rendering).
      const [sp, yt] = await Promise.all([
        fetch("/api/playlists/spotify").then(handleApi<{ playlists: SpPlaylist[] }>),
        fetch("/api/playlists/youtube").then(handleApi<{ playlists: YtPlaylist[] }>),
      ]);
      setSpPlaylists(sp.playlists);
      setYtPlaylists(yt.playlists);
    } catch (err) {
      setMirrorError(formatError(err));
    } finally {
      setCreatingMirror(false);
    }
  }

  async function deletePair(pairId: string) {
    if (!confirm("Delete this pair? Track mappings stay cached.")) return;
    const res = await fetch(`/api/playlist-pairs/${pairId}`, {
      method: "DELETE",
    });
    if (res.ok) setPairs((ps) => ps.filter((p) => p.id !== pairId));
  }

  async function startSync(pairId: string) {
    const baseProgress: SyncProgress = {
      runId: "",
      status: "running",
      addedYt: 0,
      addedSp: 0,
      removedYt: 0,
      removedSp: 0,
      failed: 0,
      remaining: 0,
      totalPlanned: 0,
      isFirstSync: false,
      quotaRemainingToday: 0,
    };
    setSyncByPair((s) => ({ ...s, [pairId]: baseProgress }));
    try {
      const planRes = await fetch(`/api/sync/${pairId}`, { method: "POST" });
      const plan = await handleApi<{
        runId: string;
        totalItems: number;
        plannedAddYt: number;
        plannedAddSp: number;
        plannedRemoveYt: number;
        plannedRemoveSp: number;
        plannedSkips: number;
        plannedQuotaUnits: number;
        isFirstSync: boolean;
      }>(planRes);
      setSyncByPair((s) => ({
        ...s,
        [pairId]: {
          ...baseProgress,
          runId: plan.runId,
          remaining: plan.totalItems,
          totalPlanned: plan.totalItems,
          isFirstSync: plan.isFirstSync,
        },
      }));
      await pollUntilDone(pairId, plan.runId, plan.isFirstSync, plan.totalItems);
    } catch (err) {
      setSyncByPair((s) => ({
        ...s,
        [pairId]: {
          ...(s[pairId] ?? baseProgress),
          status: "failed",
          errorDetail: formatError(err),
        },
      }));
    }
  }

  async function pollUntilDone(
    pairId: string,
    runId: string,
    isFirstSync: boolean,
    totalPlanned: number,
  ) {
    // Hard cap: ~5 minutes of polling at 1.5s/iteration. A run that hasn't
    // settled by then has either silently failed or is stuck on the server
    // — surface that explicitly instead of looping forever.
    const MAX_ITERATIONS = 200;
    const POLL_DELAY_MS = 1500;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const stepRes = await fetch(
        `/api/sync/${pairId}/step?runId=${encodeURIComponent(runId)}`,
        { method: "POST" },
      );
      const step = await handleApi<{
        processed: number;
        remaining: number;
        status: "running" | "done" | "failed" | "paused_quota";
        quotaRemainingToday: number;
      }>(stepRes);

      const runRes = await fetch(`/api/sync/runs/${encodeURIComponent(runId)}`);
      const runJson = await handleApi<{
        run: { addedCount: number; failedCount: number; removedCount: number };
        counts: {
          addedYt: number;
          addedSp: number;
          removedYt: number;
          removedSp: number;
          failed: number;
        };
        failures?: Failure[];
      }>(runRes);

      setSyncByPair((s) => ({
        ...s,
        [pairId]: {
          runId,
          status: step.status,
          addedYt: runJson.counts.addedYt,
          addedSp: runJson.counts.addedSp,
          removedYt: runJson.counts.removedYt,
          removedSp: runJson.counts.removedSp,
          failed: runJson.counts.failed,
          remaining: step.remaining,
          totalPlanned,
          isFirstSync,
          quotaRemainingToday: step.quotaRemainingToday,
          failures: runJson.failures,
        },
      }));

      if (step.status !== "running") return;
      await sleep(POLL_DELAY_MS);
    }
    setSyncByPair((s) => ({
      ...s,
      [pairId]: {
        ...(s[pairId] ?? {
          runId,
          status: "failed",
          addedYt: 0,
          addedSp: 0,
          removedYt: 0,
          removedSp: 0,
          failed: 0,
          remaining: 0,
          totalPlanned,
          isFirstSync,
          quotaRemainingToday: 0,
        }),
        status: "failed",
        errorDetail:
          "Sync ran longer than expected and is still in progress. Check back in a minute and press Sync now to resume.",
      },
    }));
  }

  return (
    <div className="space-y-8">
      <ConnectionsCard
        connections={connections}
        onDisconnect={handleDisconnect}
      />

      {bothConnected && (
        <MirrorCreator
          name={mirrorName}
          onName={setMirrorName}
          onCreate={createMirror}
          creating={creatingMirror}
          error={mirrorError}
        />
      )}

      {bothConnected && (
        <PairCreator
          loading={loadingPlaylists}
          error={playlistsError}
          spotify={spPlaylists}
          youtube={ytPlaylists}
          selectedSp={selectedSp}
          selectedYt={selectedYt}
          onSelectSp={setSelectedSp}
          onSelectYt={setSelectedYt}
          onCreate={createPair}
          creating={creatingPair}
        />
      )}

      <PairsList
        pairs={pairs}
        progress={syncByPair}
        spotifyById={mapBy(spPlaylists ?? [], (p) => p.id)}
        youtubeById={mapBy(ytPlaylists ?? [], (p) => p.id)}
        onSync={startSync}
        onDelete={deletePair}
      />
    </div>
  );
}

function ConnectionsCard(props: {
  connections: Connections;
  onDisconnect: (provider: "spotify" | "youtube") => void;
}) {
  return (
    <section className="rounded-lg border border-neutral-800 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Provider connections</h2>
        <p className="text-xs text-neutral-500">
          Both required to sync. Connect each separately.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ConnectButton
          provider="spotify"
          label="Spotify"
          connected={props.connections.spotify}
          onDisconnect={() => props.onDisconnect("spotify")}
        />
        <ConnectButton
          provider="youtube"
          label="YouTube"
          connected={props.connections.youtube}
          onDisconnect={() => props.onDisconnect("youtube")}
        />
      </div>
    </section>
  );
}

function ConnectButton(props: {
  provider: "spotify" | "youtube";
  label: string;
  connected: boolean;
  onDisconnect: () => void;
}) {
  if (props.connected) {
    return (
      <div className="flex items-center justify-between rounded-md bg-neutral-900 border border-neutral-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-sm">{props.label}</span>
          <span className="text-xs text-neutral-500">connected</span>
        </div>
        <button
          onClick={props.onDisconnect}
          className="text-xs text-neutral-400 hover:text-neutral-100"
        >
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <a
      href={`/api/connect/${props.provider}`}
      className="flex items-center justify-between rounded-md bg-neutral-900 border border-neutral-800 px-4 py-3 hover:border-neutral-600 transition"
    >
      <span className="text-sm">{props.label}</span>
      <span className="text-xs text-neutral-400">Connect →</span>
    </a>
  );
}

function MirrorCreator(props: {
  name: string;
  onName: (v: string) => void;
  onCreate: () => void;
  creating: boolean;
  error: string | null;
}) {
  return (
    <section className="rounded-lg border border-neutral-800 p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-medium">Create a fresh paired playlist</h2>
        <p className="text-xs text-neutral-500">
          Skip picking — we&apos;ll create a private playlist on each side with
          this name and pair them.
        </p>
      </div>
      {props.error && (
        <div className="text-sm text-rose-300 bg-rose-950/30 border border-rose-900 rounded-md px-3 py-2">
          {props.error}
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="text"
          value={props.name}
          onChange={(e) => props.onName(e.target.value)}
          placeholder="Playlist name (e.g. My Sync)"
          maxLength={80}
          className="flex-1 rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
        />
        <button
          disabled={!props.name.trim() || props.creating}
          onClick={props.onCreate}
          className="rounded-md bg-emerald-500 disabled:bg-neutral-700 disabled:text-neutral-400 text-neutral-950 px-4 py-2 text-sm font-medium hover:bg-emerald-400 transition"
        >
          {props.creating ? "Creating…" : "Create paired playlists"}
        </button>
      </div>
    </section>
  );
}

function PairCreator(props: {
  loading: boolean;
  error: string | null;
  spotify: SpPlaylist[] | null;
  youtube: YtPlaylist[] | null;
  selectedSp: string | null;
  selectedYt: string | null;
  onSelectSp: (id: string) => void;
  onSelectYt: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  return (
    <section className="rounded-lg border border-neutral-800 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Create a pair</h2>
        <p className="text-xs text-neutral-500">
          Pick one from each side, then Create pair.
        </p>
      </div>
      {props.error && (
        <div className="text-sm text-rose-300 bg-rose-950/30 border border-rose-900 rounded-md px-3 py-2">
          {props.error}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PlaylistColumn
          title="Spotify"
          loading={props.loading}
          selected={props.selectedSp}
          onSelect={props.onSelectSp}
          items={
            props.spotify?.map((p) => ({
              id: p.id,
              label: p.name,
              meta: `${p.trackCount} tracks`,
            })) ?? []
          }
        />
        <PlaylistColumn
          title="YouTube"
          loading={props.loading}
          selected={props.selectedYt}
          onSelect={props.onSelectYt}
          items={
            props.youtube?.map((p) => ({
              id: p.id,
              label: p.title,
              meta: `${p.itemCount} items`,
            })) ?? []
          }
        />
      </div>
      <button
        disabled={!props.selectedSp || !props.selectedYt || props.creating}
        onClick={props.onCreate}
        className="rounded-md bg-emerald-500 disabled:bg-neutral-700 disabled:text-neutral-400 text-neutral-950 px-4 py-2 text-sm font-medium hover:bg-emerald-400 transition"
      >
        {props.creating ? "Creating…" : "Create pair"}
      </button>
    </section>
  );
}

function PlaylistColumn(props: {
  title: string;
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  items: Array<{ id: string; label: string; meta: string }>;
}) {
  return (
    <div className="rounded-md bg-neutral-900 border border-neutral-800">
      <div className="px-3 py-2 border-b border-neutral-800 text-xs uppercase tracking-wide text-neutral-400">
        {props.title}
      </div>
      <div className="max-h-64 overflow-y-auto">
        {props.loading && (
          <div className="px-3 py-6 text-sm text-neutral-500">Loading…</div>
        )}
        {!props.loading && props.items.length === 0 && (
          <div className="px-3 py-6 text-sm text-neutral-500">
            No playlists found.
          </div>
        )}
        {props.items.map((it) => {
          const sel = props.selected === it.id;
          return (
            <button
              key={it.id}
              onClick={() => props.onSelect(it.id)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between border-b border-neutral-800 last:border-b-0 hover:bg-neutral-800 ${
                sel ? "bg-emerald-950/40" : ""
              }`}
            >
              <span className="truncate pr-2">{it.label}</span>
              <span className="text-xs text-neutral-500 shrink-0">
                {it.meta}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PairsList(props: {
  pairs: PairRow[];
  progress: Record<string, SyncProgress>;
  spotifyById: Map<string, SpPlaylist>;
  youtubeById: Map<string, YtPlaylist>;
  onSync: (pairId: string) => void;
  onDelete: (pairId: string) => void;
}) {
  if (props.pairs.length === 0) {
    return (
      <section className="rounded-lg border border-neutral-800 p-5">
        <p className="text-sm text-neutral-400">
          No pairs yet. Create one above.
        </p>
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Pairs</h2>
      {props.pairs.map((p) => {
        const sp = props.spotifyById.get(p.spotifyPlaylistId);
        const yt = props.youtubeById.get(p.youtubePlaylistId);
        const prog = props.progress[p.id];
        return (
          <article
            key={p.id}
            className="rounded-lg border border-neutral-800 p-5 space-y-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm space-y-0.5">
                <div>
                  <span className="text-neutral-500">Spotify:</span>{" "}
                  <span className="font-medium">
                    {sp?.name ?? p.spotifyPlaylistId}
                  </span>
                </div>
                <div>
                  <span className="text-neutral-500">YouTube:</span>{" "}
                  <span className="font-medium">
                    {yt?.title ?? p.youtubePlaylistId}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => props.onSync(p.id)}
                  disabled={prog?.status === "running"}
                  className="rounded-md bg-emerald-500 disabled:bg-neutral-700 disabled:text-neutral-400 text-neutral-950 px-3 py-1.5 text-xs font-medium hover:bg-emerald-400 transition"
                >
                  {prog?.status === "running" ? "Syncing…" : "Sync now"}
                </button>
                <button
                  onClick={() => props.onDelete(p.id)}
                  className="text-xs text-neutral-400 hover:text-neutral-100"
                >
                  Delete
                </button>
              </div>
            </div>
            {prog && (
              <div className="space-y-2 pt-2 border-t border-neutral-800">
                {prog.isFirstSync && prog.status === "running" && (
                  <div className="text-xs text-amber-300">
                    First sync for this pair — copying {prog.totalPlanned} tracks
                    across both sides. Soft-capped at ~150 to stay under
                    YouTube&apos;s daily quota.
                  </div>
                )}
                <div className="text-xs text-neutral-400 flex items-center gap-3 flex-wrap">
                  <span className="text-emerald-400">
                    + {prog.addedYt} → YT
                  </span>
                  <span className="text-emerald-400">
                    + {prog.addedSp} → SP
                  </span>
                  <span className="text-amber-400">
                    − {prog.removedYt} from YT
                  </span>
                  <span className="text-amber-400">
                    − {prog.removedSp} from SP
                  </span>
                  <span className="text-rose-400">! {prog.failed} failed</span>
                  <span>{prog.remaining} remaining</span>
                  {prog.failures && prog.failures.length > 0 && (
                    <FailureList failures={prog.failures} />
                  )}
                  {prog.status === "paused_quota" && (
                    <span className="ml-auto text-amber-300">
                      Paused — YouTube quota resets at 00:00 Pacific. Remaining
                      today: {prog.quotaRemainingToday}. Press Sync now after
                      reset to resume.
                    </span>
                  )}
                  {prog.status === "done" && prog.failed === 0 && (
                    <span className="ml-auto text-emerald-300">
                      Done — both sides in sync.
                    </span>
                  )}
                  {prog.status === "done" && prog.failed > 0 && (
                    <span className="ml-auto text-amber-300">
                      Done with {prog.failed} unsynced — see failures above.
                    </span>
                  )}
                  {prog.status === "failed" && (
                    <span className="ml-auto text-rose-300 truncate">
                      Failed{prog.errorDetail ? ": " + prog.errorDetail : ""}
                    </span>
                  )}
                </div>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

// ---- failure rendering ----

function FailureList({ failures }: { failures: Failure[] }) {
  // Cap the visible list so a 50-item failure batch doesn't blow up the card.
  // Users can act on the first dozen and re-sync; recurrent failures will keep
  // surfacing until manually resolved or the matcher cache catches them.
  const VISIBLE = 12;
  const visible = failures.slice(0, VISIBLE);
  const hidden = failures.length - visible.length;
  return (
    <div className="basis-full mt-1 space-y-1.5">
      {visible.map((f, i) => (
        <FailureRow key={i} failure={f} />
      ))}
      {hidden > 0 && (
        <div className="text-rose-300 text-xs">
          +{hidden} more failed track{hidden === 1 ? "" : "s"} not shown.
        </div>
      )}
    </div>
  );
}

function FailureRow({ failure: f }: { failure: Failure }) {
  const reason = translateItemFailure(f.action, f.error);
  const trackLabel =
    f.spotifyTitle && f.spotifyArtists?.length
      ? `${f.spotifyTitle} — ${f.spotifyArtists.join(", ")}`
      : f.spotifyTitle ?? f.spotifyTrackId ?? f.youtubeVideoId ?? null;

  return (
    <div className="text-xs">
      <div className="text-rose-300">
        {trackLabel ? (
          <>
            <span className="font-medium">{trackLabel}</span>
            {f.spotifyTrackId && (
              <>
                {" "}
                <a
                  href={`https://open.spotify.com/track/${f.spotifyTrackId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-neutral-500 hover:text-neutral-300 underline-offset-2 hover:underline"
                >
                  open
                </a>
              </>
            )}
            <span className="text-neutral-500"> — {reason}</span>
          </>
        ) : (
          reason
        )}
      </div>
      {f.candidates && f.candidates.length > 0 && (
        <div className="pl-3 mt-0.5 text-neutral-500">
          Closest matches:
          <ul className="list-none mt-0.5 space-y-0.5">
            {f.candidates.map((c) => (
              <li key={c.videoId}>
                <a
                  href={`https://www.youtube.com/watch?v=${c.videoId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sky-400 hover:text-sky-300 underline-offset-2 hover:underline"
                >
                  {c.title}
                </a>{" "}
                <span className="text-neutral-600">
                  · {c.channelTitle} · score {c.score.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---- helpers ----

async function handleApi<T>(res: Response): Promise<T> {
  // Read the body ONCE as text, then attempt to parse. Calling res.json()
  // and then res.text() (or vice-versa) on the same response throws
  // "body stream already read" — which previously masked every server
  // error behind a useless client-side exception.
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error ?? j.detail ?? JSON.stringify(j);
    } catch {
      // text wasn't JSON; keep the raw body as detail
    }
    throw new Error(`${res.status} ${detail.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Bad JSON from ${res.url}: ${text.slice(0, 200)}`);
  }
}

function formatError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "unknown error";
  return translateError(raw);
}

// Map known server-error patterns to actionable user-facing copy. The status
// code + JSON body is preserved for the "untranslated" tail so debugging
// info isn't lost.
function translateError(raw: string): string {
  if (/spotify_forbidden|spotify 403/i.test(raw)) {
    return "Spotify is refusing the write. Disconnect Spotify and reconnect to mint a fresh token; if that doesn't fix it, hit /api/debug/spotify-write to see why.";
  }
  if (/not_connected/i.test(raw)) {
    return "Provider isn't connected. Connect it in the Provider connections card.";
  }
  if (/broken_pair/i.test(raw)) {
    return "This pair is broken — one of the playlists no longer exists. Delete and recreate the pair.";
  }
  if (/quota_exceeded|paused_quota/i.test(raw)) {
    return "YouTube daily quota hit. Resumes after midnight Pacific.";
  }
  if (/rate_limited|429/.test(raw)) {
    return "Hitting provider rate limits. Wait a minute and try again.";
  }
  return raw;
}

function translateItemFailure(action: string, error: string | null): string {
  const a = action.replace(/_/g, " ");
  if (!error) return `${a}: failed`;
  if (/no_results/i.test(error)) {
    return `${a}: no match found on the other side`;
  }
  if (/low_confidence/i.test(error)) {
    return `${a}: candidates too uncertain to auto-match`;
  }
  if (/spotify 403/i.test(error)) {
    return `${a}: Spotify refused the write (reconnect Spotify)`;
  }
  if (/missing_playlist_item_id|missing_youtube_video_id|missing_spotify_track_id/i.test(error)) {
    return `${a}: missing reference (try syncing again)`;
  }
  return `${a}: ${error.slice(0, 120)}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mapBy<T, K>(arr: T[], keyFn: (t: T) => K): Map<K, T> {
  const m = new Map<K, T>();
  for (const item of arr) m.set(keyFn(item), item);
  return m;
}
