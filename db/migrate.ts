import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

async function main() {
  const url = process.env.NEON_DATABASE_URL;
  if (!url) throw new Error("NEON_DATABASE_URL is not set");
  const sql = neon(url);
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: "./db/migrations" });
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
