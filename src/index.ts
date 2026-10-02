import { loadEnv } from "./config/env.js";
import { createRelay } from "./app.js";

const env = loadEnv();
const relay = createRelay(env);

relay.scheduler.start();
relay.wattsUp.start();
await relay.admin.listen({ host: env.HOST, port: env.ADMIN_PORT });
await relay.public.listen({ host: env.HOST, port: env.PUBLIC_PORT });
relay.log.info(`admin UI on :${env.ADMIN_PORT}, endpoints on :${env.PUBLIC_PORT} (${env.PUBLIC_BASE_URL})`);

let closing = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    relay.log.info(`${sig}: shutting down`);
    await relay.close();
    process.exit(0);
  });
}
