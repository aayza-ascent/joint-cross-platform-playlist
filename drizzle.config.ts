import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const url = process.env.NEON_DATABASE_URL;
if (!url) {
  throw new Error("NEON_DATABASE_URL is not set (check .env.local)");
}

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
