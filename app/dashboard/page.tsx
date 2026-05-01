import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth, signOut } from "@/lib/auth/authjs";
import { db } from "@/db/client";
import { connectedAccounts, playlistPairs } from "@/db/schema";
import DashboardClient from "./DashboardClient";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const userId = session.user.id;

  const [conns, pairs] = await Promise.all([
    db.query.connectedAccounts.findMany({
      where: eq(connectedAccounts.userId, userId),
      columns: { provider: true },
    }),
    db.query.playlistPairs.findMany({
      where: eq(playlistPairs.userId, userId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    }),
  ]);

  const connections = {
    spotify: conns.some((c) => c.provider === "spotify"),
    youtube: conns.some((c) => c.provider === "youtube"),
  };

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Playlist Sync</h1>
          <form action={signOutAction}>
            <button
              type="submit"
              className="text-sm text-neutral-400 hover:text-neutral-100"
            >
              Sign out ({session.user.email ?? session.user.name})
            </button>
          </form>
        </div>
      </header>
      <div className="max-w-5xl mx-auto px-6 py-8">
        <DashboardClient
          initialConnections={connections}
          initialPairs={pairs.map((p) => ({
            id: p.id,
            spotifyPlaylistId: p.spotifyPlaylistId,
            youtubePlaylistId: p.youtubePlaylistId,
            broken: p.broken,
            createdAt: p.createdAt.toISOString(),
          }))}
        />
      </div>
    </main>
  );
}
