import { buildApp } from "./app.js";

const app = buildApp();
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ host: "0.0.0.0", port });
