import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth/authjs";

export default async function Home() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  async function googleSignIn() {
    "use server";
    await signIn("google", { redirectTo: "/dashboard" });
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-950 text-neutral-100">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h1 className="text-3xl font-semibold">Playlist Sync</h1>
          <p className="mt-2 text-neutral-400 text-sm">
            One-way sync from a Spotify playlist to a YouTube playlist. Press
            Sync Now whenever you want them aligned.
          </p>
        </div>
        <form action={googleSignIn}>
          <button
            type="submit"
            className="w-full rounded-md bg-white text-neutral-900 px-4 py-2.5 text-sm font-medium hover:bg-neutral-200 transition"
          >
            Sign in with Google
          </button>
        </form>
        <p className="text-xs text-neutral-500">
          You will then connect Spotify and YouTube as separate provider
          authorizations.
        </p>
      </div>
    </main>
  );
}
