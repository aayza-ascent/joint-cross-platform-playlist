import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const url = process.env.NEON_DATABASE_URL;
if (!url) {
  throw new Error("NEON_DATABASE_URL is not set");
}

export const db = drizzle(neon(url), { schema });
export { schema };
