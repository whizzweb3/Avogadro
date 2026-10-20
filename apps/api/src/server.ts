import { buildApp } from "./app.js";
import { createContractStore, createDatabase } from "@avogadro/db";

const database = createDatabase();
const app = buildApp({ contractStore: createContractStore(database.db) });
const port = Number(process.env.API_PORT ?? 4000);
app.addHook("onClose", async () => database.close());
await app.listen({ host: "0.0.0.0", port });
