import { auth } from "@/lib/auth/authjs";
import { NextResponse } from "next/server";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

export async function requireSession(): Promise<{ userId: string }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new UnauthorizedError();
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
