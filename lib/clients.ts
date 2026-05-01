import { SpotifyClient } from "@/lib/spotify/client";
import { YouTubeClient } from "@/lib/youtube/client";
import { DbQuotaAccounter } from "@/lib/youtube/quota-db";
import { getValidAccessToken } from "@/lib/auth/tokens";

export function spotifyForUser(userId: string): SpotifyClient {
  return new SpotifyClient(() => getValidAccessToken(userId, "spotify"));
}

export function youtubeForUser(userId: string): {
  client: YouTubeClient;
  quota: DbQuotaAccounter;
} {
  const quota = new DbQuotaAccounter();
  return {
    client: new YouTubeClient(
      () => getValidAccessToken(userId, "youtube"),
      quota,
    ),
    quota,
  };
}
