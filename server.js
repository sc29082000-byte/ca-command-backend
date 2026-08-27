const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const https = require("https");

const PORT = process.env.PORT || 4001;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || "sc29082000-byte/ca-command-backend"; // owner/repo
const DATA_BRANCH = process.env.DATA_BRANCH || "main";
const CONFIG_PATH = "data/config.json";
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

function hashPin(pin) {
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}

// In-memory cache to avoid hammering the GitHub API on every request; still
// backed by GitHub as the source of truth so data survives Render restarts.
let configCache = null;
let configSha = null;
let stateCache = null;
let stateSha = null;

async function loadConfig(force) {
  if (configCache && !force) return configCache;
  const { data, sha } = await ghReadJSON(CONFIG_PATH);
  configCache = data || { pinHash: null };
  configSha = sha;
  return configCache;
}
async function saveConfig(cfg) {
  const res = await ghWriteJSON(CONFIG_PATH, cfg, configSha, "update config");
  configCache = cfg;
  configSha = res.content ? res.content.sha : configSha;
}
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

async function requirePin(req, res, next) {
  try {
    const config = await loadConfig(false);
    if (!config.pinHash) {
      return res.status(428).json({ error: "no_pin_set", message: "Call /api/setup first to set a PIN." });
    }
    const pin = req.header("x-pin");
    if (!pin || hashPin(pin) !== config.pinHash) {
      return res.status(401).json({ error: "invalid_pin" });
    }
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error", message: String(e.message || e) });
  }
}

app.get("/api/health", async (req, res) => {
  try {
    const config = await loadConfig(true);
    res.json({ ok: true, pinSet: !!config.pinHash, time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/setup", async (req, res) => {
  try {
    const { pin, newPin } = req.body || {};
    const config = await loadConfig(true);
    if (!config.pinHash) {
      if (!pin || String(pin).length < 4) {
        return res.status(400).json({ error: "pin_too_short", message: "PIN must be at least 4 characters." });
      }
      await saveConfig({ pinHash: hashPin(pin) });
      return res.json({ ok: true, message: "PIN set." });
    }
    const currentPin = req.header("x-pin");
    if (!currentPin || hashPin(currentPin) !== config.pinHash) {
      return res.status(401).json({ error: "invalid_pin" });
    }
    if (!newPin || String(newPin).length < 4) {
      return res.status(400).json({ error: "pin_too_short" });
    }
    await saveConfig({ pinHash: hashPin(newPin) });
    res.json({ ok: true, message: "PIN changed." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error", message: String(e.message || e) });
  }
});

app.get("/api/state", requirePin, async (req, res) => {
  try {
    const saved = await loadState(true);
    res.json({ ok: true, state: saved ? saved.state : null, updatedAt: saved ? saved.updatedAt : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error", message: String(e.message || e) });
  }
});

app.post("/api/state", requirePin, async (req, res) => {
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

/* ============== PRESENCE (real-time "View Here" arbitration) ==============
 * Live, ephemeral — kept in memory only (not persisted to GitHub), since it's
 * just "who currently has the lock" and should reset naturally if the server
 * restarts. A device is considered active only while its heartbeat is recent.
 */
const PRESENCE_TIMEOUT_MS = 25000; // heartbeat must refresh within this window
let presence = { device: null, since: 0, label: "" };

app.get("/api/presence", requirePin, (req, res) => {
  const isStale = !presence.device || Date.now() - presence.since > PRESENCE_TIMEOUT_MS;
  res.json({ ok: true, active: isStale ? null : presence.device, label: isStale ? "" : presence.label, since: presence.since });
});

app.post("/api/presence/claim", requirePin, (req, res) => {
  const { device, label } = req.body || {};
  if (!device) return res.status(400).json({ error: "missing_device" });
  const isStale = !presence.device || Date.now() - presence.since > PRESENCE_TIMEOUT_MS;
  if (!isStale && presence.device !== device) {
    return res.status(409).json({ error: "in_use", device: presence.device, label: presence.label });
  }
  presence = { device, since: Date.now(), label: label || "" };
  res.json({ ok: true });
});

app.post("/api/presence/heartbeat", requirePin, (req, res) => {
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

app.post("/api/presence/release", requirePin, (req, res) => {
  const { device } = req.body || {};
  if (presence.device === device) presence = { device: null, since: 0, label: "" };
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`CA Command backend listening on port ${PORT}`);
  console.log(`Persistent storage: GitHub repo ${GITHUB_REPO} (${GITHUB_TOKEN ? "token set" : "NO TOKEN — will fail"})`);
});
