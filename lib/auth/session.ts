import { auth } from "@/lib/auth/authjs";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

export async function requireSession(): Promise<{ userId: string }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) {
    if (process.env.NODE_ENV !== "production") {
      const jar = await cookies();
      const names = jar.getAll().map((c) => c.name);
      console.warn(
        "[auth] requireSession failed:",
        JSON.stringify({
          hasSessionObject: !!session,
          hasSessionUser: !!session?.user,
          sessionUserKeys: session?.user ? Object.keys(session.user) : null,
          cookieNames: names,
        }),
      );
    }
    throw new UnauthorizedError();
  }
  return { userId: id };
}

export function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function withSession<T>(
  handler: (ctx: { userId: string }) => Promise<T | NextResponse>,
): Promise<NextResponse | T> {
  try {
    const ctx = await requireSession();
    return await handler(ctx);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized();
    throw err;
  }
}
