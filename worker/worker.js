// Cloudflare Worker: lets the website trigger the "Update counts" workflow
// without exposing a GitHub token in the page.
//
// Needs one secret on the Worker: GH_TOKEN
//   = a fine-grained GitHub token, only this repo, permission "Actions: Read and write".
//
// Endpoints:
//   POST /run     start a run (skipped if one is running or one finished in the last few minutes)
//   GET  /status  latest run of the workflow

const OWNER = "jayo86";
const REPO = "echo-chamber-prevention";
const WORKFLOW = "update.yml";
const ALLOWED_ORIGIN = "https://jayo86.github.io";
const COOLDOWN_MINUTES = 5;

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!env.GH_TOKEN) return json({ error: "GH_TOKEN secret not set on the Worker" }, 500);

    const gh = (path, init = {}) =>
      fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "echo-chamber-worker",
          ...(init.headers || {}),
        },
      });

    async function latestRun() {
      const r = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=1`);
      if (!r.ok) throw new Error(`GitHub said ${r.status} listing runs`);
      const run = (await r.json()).workflow_runs?.[0];
      if (!run) return null;
      return {
        id: run.id,
        status: run.status, // queued | in_progress | completed ...
        conclusion: run.conclusion, // success | failure | null
        created_at: run.created_at,
        updated_at: run.updated_at,
      };
    }

    const path = new URL(req.url).pathname;
    try {
      if (path === "/status" && req.method === "GET") {
        return json({ run: await latestRun(), now: new Date().toISOString() });
      }

      if (path === "/run" && req.method === "POST") {
        if (req.headers.get("Origin") !== ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);

        const run = await latestRun();
        if (run && run.status !== "completed") {
          return json({ result: "running", run });
        }
        if (run && Date.now() - Date.parse(run.updated_at) < COOLDOWN_MINUTES * 60000) {
          return json({ result: "fresh", run });
        }

        const since = new Date().toISOString();
        const d = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: "main" }),
        });
        if (!d.ok) return json({ error: `GitHub said ${d.status} starting the run` }, 502);
        return json({ result: "started", since });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};
