import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    // Module-level imports of db/client.ts throw if this is missing. Tests
    // that actually use the DB are integration tests (not yet present);
    // unit tests transitively import the module but never execute queries.
    env: {
      NEON_DATABASE_URL: "postgres://placeholder@example.invalid/db",
    },
  },
});
