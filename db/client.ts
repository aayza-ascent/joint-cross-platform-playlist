import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let _db: Db | undefined;

export function getDb(): Db {
  if (!_db) {
    const url = process.env.NEON_DATABASE_URL;
    if (!url) throw new Error("NEON_DATABASE_URL is not set");
    _db = drizzle(neon(url), { schema });
  }
  return _db;
}

// Lazy accessor preserving the typed surface — callers can still use
// `db.query.foo.findFirst(...)`. The proxy resolves the real connection
// on first property access, so importing this file in tests that don't
// touch the DB is harmless.
export const db: Db = new Proxy({} as Db, {
  get(_t, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
});

export { schema };
