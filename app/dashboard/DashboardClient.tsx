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

type SyncProgress = {
  runId: string;
  status: "running" | "done" | "failed" | "paused_quota";
  added: number;
  failed: number;
  remaining: number;
  quotaRemainingToday: number;
  errorDetail?: string;
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

  async function deletePair(pairId: string) {
    if (!confirm("Delete this pair? Track mappings stay cached.")) return;
    const res = await fetch(`/api/playlist-pairs/${pairId}`, {
      method: "DELETE",
    });
    if (res.ok) setPairs((ps) => ps.filter((p) => p.id !== pairId));
  }

  async function startSync(pairId: string) {
    setSyncByPair((s) => ({
      ...s,
      [pairId]: {
        runId: "",
        status: "running",
        added: 0,
        failed: 0,
        remaining: 0,
        quotaRemainingToday: 0,
      },
    }));
    try {
      const planRes = await fetch(`/api/sync/${pairId}`, { method: "POST" });
      const plan = await handleApi<{
        runId: string;
        totalItems: number;
        plannedAdds: number;
        plannedSkips: number;
        plannedQuotaUnits: number;
      }>(planRes);
      setSyncByPair((s) => ({
        ...s,
        [pairId]: { ...s[pairId], runId: plan.runId, remaining: plan.totalItems },
      }));
      await pollUntilDone(pairId, plan.runId);
    } catch (err) {
      setSyncByPair((s) => ({
        ...s,
        [pairId]: {
          ...(s[pairId] ?? {
            runId: "",
            added: 0,
            failed: 0,
            remaining: 0,
            quotaRemainingToday: 0,
          }),
          status: "failed",
          errorDetail: formatError(err),
        },
      }));
    }
  }

  async function pollUntilDone(pairId: string, runId: string) {
    while (true) {
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

      // Re-fetch authoritative counters from /runs to keep added/failed in sync.
      const runRes = await fetch(`/api/sync/runs/${encodeURIComponent(runId)}`);
      const runJson = await handleApi<{
        run: {
          addedCount: number;
          failedCount: number;
        };
      }>(runRes);

      setSyncByPair((s) => ({
        ...s,
        [pairId]: {
          runId,
          status: step.status,
          added: runJson.run.addedCount,
          failed: runJson.run.failedCount,
          remaining: step.remaining,
          quotaRemainingToday: step.quotaRemainingToday,
        },
      }));

      if (step.status !== "running") return;
    }
  }

  return (
    <div className="space-y-8">
      <ConnectionsCard
        connections={connections}
        onDisconnect={handleDisconnect}
      />

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
              <div className="text-xs text-neutral-400 flex items-center gap-3 pt-2 border-t border-neutral-800">
                <span className="text-emerald-400">+ {prog.added} added</span>
                <span className="text-rose-400">! {prog.failed} failed</span>
                <span>{prog.remaining} remaining</span>
                {prog.status === "paused_quota" && (
                  <span className="ml-auto text-amber-300">
                    Paused — YouTube quota resets at 00:00 Pacific. Remaining
                    today: {prog.quotaRemainingToday}.
                  </span>
                )}
                {prog.status === "done" && (
                  <span className="ml-auto text-emerald-300">Done.</span>
                )}
                {prog.status === "failed" && (
                  <span className="ml-auto text-rose-300 truncate">
                    Failed{prog.errorDetail ? ": " + prog.errorDetail : ""}
                  </span>
                )}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

// ---- helpers ----

async function handleApi<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.error ?? JSON.stringify(j);
    } catch {
      detail = await res.text();
    }
    throw new Error(`${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

function mapBy<T, K>(arr: T[], keyFn: (t: T) => K): Map<K, T> {
  const m = new Map<K, T>();
  for (const item of arr) m.set(keyFn(item), item);
  return m;
}
