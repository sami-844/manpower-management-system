/**
 * The Cloudflare client demo (DECISIONS A32): fictional data only; production stays on AWS (A10).
 * Static files (the web app, and the browser-only demo under /demo/) are served from Workers assets;
 * /api/* goes to one Cloudflare Container running the API's own Docker image, which sleeps when idle.
 */
import { Container, getContainer } from "@cloudflare/containers";
import { containerEnv, forApi, isApiPath, MissingSecrets, type DemoSecrets } from "./config";

interface Env extends DemoSecrets {
  API: DurableObjectNamespace<MmsApi>;
  ASSETS: Fetcher;
}

/** First start against a new database migrates and seeds before the port opens, so allow minutes, not seconds. */
const START_TIMEOUT_MS = 180_000;
const API_NOT_STARTED =
  "The client demo's API did not start. In Cloudflare open Workers → manpower-management-system → Logs: the container's last line says why (usually DATABASE_URL, or an R2 key). Fix the secret and reload.";

export class MmsApi extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "15m";
  enableInternet = true; // the Postgres database and R2 are on the internet
  // Run from apps/api, the image's working directory: migrate, seed once, demo accounts, then the API.
  entrypoint = ["bun", "src/deploy/client-demo.ts"];

  override async fetch(request: Request): Promise<Response> {
    // Built at every start, so a secret changed in the dashboard applies the next time the container wakes.
    const envVars = await containerEnv(this.env, new URL(request.url).origin);
    try {
      await this.startAndWaitForPorts({ startOptions: { envVars }, cancellationOptions: { portReadyTimeoutMS: START_TIMEOUT_MS } });
    } catch (err) {
      // The start-up exits with one clear line in the container log (a database it can't reach, a refused R2 key).
      console.error("API container did not start:", err);
      return Response.json({ code: "API_NOT_STARTED", message: API_NOT_STARTED }, { status: 503 });
    }
    return this.containerFetch(request);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!isApiPath(url.pathname)) return env.ASSETS.fetch(request);
    try {
      await containerEnv(env, url.origin);
    } catch (err) {
      // Say exactly what to set instead of failing inside the container.
      if (err instanceof MissingSecrets) return Response.json({ code: "NOT_CONFIGURED", message: err.message }, { status: 503 });
      throw err;
    }
    return getContainer(env.API, "api").fetch(forApi(request));
  },
} satisfies ExportedHandler<Env>;
