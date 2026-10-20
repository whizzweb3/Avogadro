import { buildApp } from "./app.js";
import { createCampaignStore, createContractStore, createDatabase, createSiweStore } from "@avogadro/db";

if (process.env.NODE_ENV === "production") {
  const domain = process.env.SIWE_DOMAIN;
  const uri = process.env.SIWE_URI;
  if (!domain || !uri || process.env.SIWE_CHAIN_ID !== "4663") throw new Error("Production SIWE requires SIWE_DOMAIN, SIWE_URI, and SIWE_CHAIN_ID=4663");
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new Error("Production SIWE_URI must be a valid HTTPS URL"); }
  if (parsed.protocol !== "https:" || parsed.host !== domain) throw new Error("Production SIWE_URI must use HTTPS and match SIWE_DOMAIN");
}

const database = createDatabase();
const app = buildApp({ contractStore: createContractStore(database.db), campaignStore: createCampaignStore(database.db), authStore: createSiweStore(database.db) });
const port = Number(process.env.API_PORT ?? 4000);
app.addHook("onClose", async () => database.close());
await app.listen({ host: "0.0.0.0", port });
