import { defineConfig } from "drizzle-kit";

export default defineConfig({ schema: "./src/schema.ts", out: "./migrations", dialect: "postgresql", dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://avogadro:avogadro@localhost:5432/avogadro" } });
