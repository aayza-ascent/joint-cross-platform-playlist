import { NextResponse, type NextRequest } from "next/server";

// Force every request that arrives via 'localhost' to be redirected to
// '127.0.0.1'. macOS resolves both to the same loopback so the dev server
// answers either, but the browser treats them as different origins for
// cookie purposes — and Auth.js v5 builds the OAuth redirect_uri from the
// request's Host header, so 'localhost' in the URL bar produces a redirect
// URI that isn't registered on the Google/Spotify OAuth client. Forcing
// 127.0.0.1 universally keeps the host stable across the whole flow.
//
// In production the host is the Vercel domain, so this branch never fires.
export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (host === "localhost:3000" || host.startsWith("localhost:")) {
    const url = req.nextUrl.clone();
    url.host = host.replace(/^localhost(:|$)/, "127.0.0.1$1");
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/:path*",
};
