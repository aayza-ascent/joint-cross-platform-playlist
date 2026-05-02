import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth/authjs";

// Diagnostic endpoint. Enabled only outside production. Returns the session
// object plus the names of cookies the request carried, so we can tell at a
// glance whether the Auth.js session cookie is reaching this route.
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ disabled: true }, { status: 404 });
  }
  const session = await auth();
  const jar = await cookies();
  const names = jar.getAll().map((c) => c.name);
  return NextResponse.json({
    session,
    cookieNames: names,
    nextauthUrl: process.env.NEXTAUTH_URL,
    nodeEnv: process.env.NODE_ENV,
  });
}
