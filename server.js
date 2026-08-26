const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");
const PORT = process.env.PORT || 4001;

function loadJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return fallback;
  }
}
function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
function hashPin(pin) {
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}

let config = loadJSON(CONFIG_PATH, { pinHash: null });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// simple request logger
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.path);
  next();
});

function requirePin(req, res, next) {
  if (!config.pinHash) {
    return res.status(428).json({ error: "no_pin_set", message: "Call /api/setup first to set a PIN." });
  }
  const pin = req.header("x-pin");
  if (!pin || hashPin(pin) !== config.pinHash) {
    return res.status(401).json({ error: "invalid_pin" });
  }
  next();
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, pinSet: !!config.pinHash, time: new Date().toISOString() });
});

// One-time (or PIN-authenticated) setup/change of the sync PIN
app.post("/api/setup", (req, res) => {
  const { pin, newPin } = req.body || {};
  if (!config.pinHash) {
    if (!pin || String(pin).length < 4) {
      return res.status(400).json({ error: "pin_too_short", message: "PIN must be at least 4 characters." });
    }
    config.pinHash = hashPin(pin);
    saveJSON(CONFIG_PATH, config);
    return res.json({ ok: true, message: "PIN set." });
  }
  // changing an existing PIN requires the current one
  const currentPin = req.header("x-pin");
  if (!currentPin || hashPin(currentPin) !== config.pinHash) {
    return res.status(401).json({ error: "invalid_pin" });
  }
  if (!newPin || String(newPin).length < 4) {
    return res.status(400).json({ error: "pin_too_short" });
  }
  config.pinHash = hashPin(newPin);
  saveJSON(CONFIG_PATH, config);
  res.json({ ok: true, message: "PIN changed." });
});

app.get("/api/state", requirePin, (req, res) => {
  const saved = loadJSON(STATE_PATH, null);
  res.json({ ok: true, state: saved ? saved.state : null, updatedAt: saved ? saved.updatedAt : null });
});

app.post("/api/state", requirePin, (req, res) => {
  const { state, updatedAt, device } = req.body || {};
  if (!state) return res.status(400).json({ error: "missing_state" });

  const existing = loadJSON(STATE_PATH, null);
  // last-write-wins by client-supplied updatedAt timestamp to avoid an old device clobbering a newer save
  if (existing && existing.updatedAt && updatedAt && existing.updatedAt > updatedAt) {
    return res.status(409).json({
      error: "conflict",
      message: "Server has a newer save than this device. Pull latest before pushing.",
      serverUpdatedAt: existing.updatedAt,
    });
  }

  saveJSON(STATE_PATH, { state, updatedAt: updatedAt || Date.now(), device: device || "unknown" });
  res.json({ ok: true, savedAt: Date.now() });
});

app.listen(PORT, () => {
  console.log(`CA Command backend listening on http://localhost:${PORT}`);
  console.log(`PIN configured: ${config.pinHash ? "yes" : "NO — call POST /api/setup first"}`);
});
