const express = require("express");
const cors = require("cors");
const https = require("https");

const PORT = process.env.PORT || 4001;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || "sc29082000-byte/ca-command-backend"; // owner/repo
const DATA_BRANCH = process.env.DATA_BRANCH || "main";
const STATE_PATH = "data/state.json";

if (!GITHUB_TOKEN) {
  console.warn("WARNING: GITHUB_TOKEN not set — persistent storage will not work.");
}

// --- Minimal GitHub Contents API client (no extra deps) ---
function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/repos/${GITHUB_REPO}/contents/${path}`,
        method,
        headers: {
          "User-Agent": "ca-command-backend",
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = chunks ? JSON.parse(chunks) : null;
          } catch (e) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ghReadJSON(path) {
  const res = await ghRequest("GET", path);
  if (res.status === 404) return { data: null, sha: null };
  if (res.status !== 200) throw new Error(`GitHub read failed (${res.status}): ${JSON.stringify(res.body)}`);
  const content = Buffer.from(res.body.content, "base64").toString("utf8");
  return { data: JSON.parse(content), sha: res.body.sha };
}

async function ghWriteJSON(path, data, sha, message) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
  const res = await ghRequest("PUT", path, {
    message: message || `update ${path}`,
    content,
    branch: DATA_BRANCH,
    ...(sha ? { sha } : {}),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`GitHub write failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

// In-memory cache to avoid hammering the GitHub API on every request; still
// backed by GitHub as the source of truth so data survives Render restarts.
let stateCache = null;
let stateSha = null;

async function loadState(force) {
  if (stateCache && !force) return stateCache;
  const { data, sha } = await ghReadJSON(STATE_PATH);
  stateCache = data;
  stateSha = sha;
  return stateCache;
}
async function saveState(st) {
  const res = await ghWriteJSON(STATE_PATH, st, stateSha, "update state");
  stateCache = st;
  stateSha = res.content ? res.content.sha : stateSha;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.path);
  next();
});

app.get("/api/health", async (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// No auth — this is a private URL for a single personal user across their own devices.
app.get("/api/state", async (req, res) => {
  try {
    const saved = await loadState(true);
    res.json({ ok: true, state: saved ? saved.state : null, updatedAt: saved ? saved.updatedAt : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error", message: String(e.message || e) });
  }
});

app.post("/api/state", async (req, res) => {
  try {
    const { state, updatedAt, device } = req.body || {};
    if (!state) return res.status(400).json({ error: "missing_state" });

    const existing = await loadState(true);
    if (existing && existing.updatedAt && updatedAt && existing.updatedAt > updatedAt) {
      return res.status(409).json({
        error: "conflict",
        message: "Server has a newer save than this device. Pull latest before pushing.",
        serverUpdatedAt: existing.updatedAt,
      });
    }

    await saveState({ state, updatedAt: updatedAt || Date.now(), device: device || "unknown" });
    res.json({ ok: true, savedAt: Date.now() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error", message: String(e.message || e) });
  }
});

/* ============== PRESENCE (real-time "View Here" arbitration) ============== */
const PRESENCE_TIMEOUT_MS = 25000;
let presence = { device: null, since: 0, label: "" };

app.get("/api/presence", (req, res) => {
  const isStale = !presence.device || Date.now() - presence.since > PRESENCE_TIMEOUT_MS;
  res.json({ ok: true, active: isStale ? null : presence.device, label: isStale ? "" : presence.label, since: presence.since });
});

app.post("/api/presence/claim", (req, res) => {
  const { device, label } = req.body || {};
  if (!device) return res.status(400).json({ error: "missing_device" });
  const isStale = !presence.device || Date.now() - presence.since > PRESENCE_TIMEOUT_MS;
  if (!isStale && presence.device !== device) {
    return res.status(409).json({ error: "in_use", device: presence.device, label: presence.label });
  }
  presence = { device, since: Date.now(), label: label || "" };
  res.json({ ok: true });
});

app.post("/api/presence/heartbeat", (req, res) => {
  const { device, label } = req.body || {};
  if (presence.device === device) {
    presence.since = Date.now();
    if (label) presence.label = label;
    return res.json({ ok: true });
  }
  const isStale = !presence.device || Date.now() - presence.since > PRESENCE_TIMEOUT_MS;
  if (isStale) {
    presence = { device, since: Date.now(), label: label || "" };
    return res.json({ ok: true });
  }
  res.status(409).json({ error: "in_use", device: presence.device, label: presence.label });
});

app.post("/api/presence/release", (req, res) => {
  const { device } = req.body || {};
  if (presence.device === device) presence = { device: null, since: 0, label: "" };
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`CA Command backend listening on port ${PORT}`);
  console.log(`Persistent storage: GitHub repo ${GITHUB_REPO} (${GITHUB_TOKEN ? "token set" : "NO TOKEN — will fail"})`);
});
