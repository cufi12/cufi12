import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD;
const PUBLIC_CLIENT_ID = "X245A4XAIBGVM";
const OAUTH = "https://api.real-debrid.com/oauth/v2";
const API = "https://api.real-debrid.com/rest/1.0";

let pendingDevice = null;
let credentials = null;
let tokens = null;

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!APP_PASSWORD) return res.status(503).send("Admin setup required: set APP_PASSWORD in the service environment.");
  const auth = req.headers.authorization || "";
  const expected = "Basic " + Buffer.from("manager:" + APP_PASSWORD).toString("base64");
  if (!crypto.timingSafeEqual(Buffer.from(auth.padEnd(expected.length)), Buffer.from(expected.padEnd(auth.length || 0))) || auth !== expected) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Real-Debrid Manager"');
    return res.status(401).send("Login required");
  }
  next();
});

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));

async function rdFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Real-Debrid returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function tokenRequest(params) {
  return rdFetch(OAUTH + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
}

async function accessToken() {
  if (!tokens?.access_token) throw new Error("Bitte zuerst Real-Debrid verbinden.");
  if (tokens.expires_at < Date.now() + 30000) {
    const refreshed = await tokenRequest({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      code: tokens.refresh_token,
      grant_type: "http://oauth.net/grant_type/device/1.0"
    });
    tokens = { ...refreshed, expires_at: Date.now() + (refreshed.expires_in || 3600) * 1000 };
  }
  return tokens.access_token;
}

async function rdApi(path) {
  const token = await accessToken();
  return rdFetch(API + path, { headers: { Authorization: "Bearer " + token } });
}

app.post("/api/device/start", async (_req, res) => {
  try {
    const data = await rdFetch(OAUTH + "/device/code?client_id=" + PUBLIC_CLIENT_ID + "&new_credentials=yes");
    pendingDevice = { device_code: data.device_code, user_code: data.user_code, expires_at: Date.now() + data.expires_in * 1000 };
    res.json({ user_code: data.user_code, verification_url: data.verification_url, expires_in: data.expires_in, interval: data.interval || 5 });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/api/device/poll", async (_req, res) => {
  try {
    if (!pendingDevice || pendingDevice.expires_at < Date.now()) {
      pendingDevice = null;
      return res.status(400).json({ error: "Der Gerätecode ist abgelaufen. Bitte neu starten." });
    }
    const params = new URLSearchParams({ client_id: PUBLIC_CLIENT_ID, code: pendingDevice.device_code });
    const creds = await rdFetch(OAUTH + "/device/credentials?" + params);
    if (!creds.client_id || !creds.client_secret) return res.status(202).json({ pending: true });
    credentials = creds;
    const result = await tokenRequest({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      code: pendingDevice.device_code,
      grant_type: "http://oauth.net/grant_type/device/1.0"
    });
    tokens = { ...result, expires_at: Date.now() + (result.expires_in || 3600) * 1000 };
    pendingDevice = null;
    res.json({ connected: true });
  } catch (e) {
    if ([400, 403].includes(e.status)) return res.status(202).json({ pending: true });
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/status", async (_req, res) => {
  try {
    if (!tokens) return res.json({ connected: false });
    const user = await rdApi("/user");
    res.json({ connected: true, user: { username: user.username, type: user.type, premium: user.premium, expiration: user.expiration } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/torrents", async (_req, res) => {
  try { res.json(await rdApi("/torrents")); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/downloads", async (_req, res) => {
  try { res.json(await rdApi("/downloads")); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/api/disconnect", (_req, res) => {
  pendingDevice = null; credentials = null; tokens = null;
  res.json({ disconnected: true });
});

app.get("*", (_req, res) => res.sendFile(process.cwd() + "/public/index.html"));

app.listen(PORT, "0.0.0.0", () => console.log(`Real-Debrid Manager listening on ${PORT}`));
