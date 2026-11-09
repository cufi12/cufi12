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
  if (req.path === "/health" || req.path.startsWith("/nuvio/")) return next();
  if (!APP_PASSWORD) return res.status(503).send("Admin setup required: set APP_PASSWORD in the service environment.");
  const auth = req.headers.authorization || "";
  const supplied = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : "";
  const expected = "manager:" + APP_PASSWORD;
  const suppliedHash = crypto.createHash("sha256").update(supplied).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(suppliedHash, expectedHash)) {
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
  const url = new URL(API + path);
  url.searchParams.set("auth_token", token);
  return rdFetch(url.toString());
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

app.get("/api/tvmaze/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 100);
    if (q.length < 2) return res.status(400).json({ error: "Bitte mindestens 2 Zeichen eingeben." });
    const response = await fetch("https://api.tvmaze.com/search/shows?q=" + encodeURIComponent(q));
    if (!response.ok) throw new Error("TVmaze antwortet mit HTTP " + response.status);
    const results = await response.json();
    res.json({ results: (Array.isArray(results) ? results : []).slice(0, 15).map(x => ({
      id: x.show?.id, name: x.show?.name || "", summary: x.show?.summary || "",
      premiered: x.show?.premiered || "", ended: x.show?.ended || "", status: x.show?.status || "",
      genres: x.show?.genres || [], image: x.show?.image?.medium || x.show?.image?.original || "", url: x.show?.url || ""
    })) });
  } catch (e) { res.status(502).json({ error: "TVmaze-Suche fehlgeschlagen: " + e.message }); }
});

app.get("/api/tvmaze/shows/:id/episodes", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "Ungültige Serien-ID." });
    const response = await fetch("https://api.tvmaze.com/shows/" + id + "/episodes");
    if (!response.ok) throw new Error("TVmaze antwortet mit HTTP " + response.status);
    const episodes = await response.json();
    res.json({ episodes: (Array.isArray(episodes) ? episodes : []).map(ep => ({
      name: ep.name || "", season: ep.season, number: ep.number, airdate: ep.airdate || "",
      runtime: ep.runtime || null, summary: ep.summary || ""
    })) });
  } catch (e) { res.status(502).json({ error: "Episoden konnten nicht geladen werden: " + e.message }); }
});

app.get("/api/torrents", async (_req, res) => {
  try { res.json(await rdApi("/torrents")); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/downloads", async (_req, res) => {
  try { res.json(await rdApi("/downloads")); }
  catch (e) { res.status(502).json({ error: e.message }); }
});


app.get("/api/library-search", async (req, res) => {
  try {
    const term = String(req.query.q || "").trim().slice(0, 100);
    if (term.length < 2) return res.status(400).json({ error: "Bitte mindestens 2 Zeichen eingeben." });
    const phrase = '"' + term.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    const query = 'mediatype:movies AND (title:' + phrase + ' OR creator:' + phrase + ')';
    const searchUrl = new URL("https://archive.org/advancedsearch.php");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("fl[]", "identifier,title,creator,date,year,licenseurl,rights");
    searchUrl.searchParams.set("rows", "12");
    searchUrl.searchParams.set("output", "json");
    const found = await rdFetch(searchUrl.toString());
    const docs = found.response?.docs || [];
    const results = await Promise.all(docs.map(async item => {
      const license = String(item.licenseurl || "");
      const rights = String(item.rights || "");
      const publicDomain = license.toLowerCase().includes("creativecommons.org/publicdomain") || rights.toLowerCase().includes("public domain");
      if (!publicDomain) return null;
      let torrentUrl = "";
      try {
        const metadata = await rdFetch("https://archive.org/metadata/" + encodeURIComponent(item.identifier));
        const torrent = (metadata.files || []).find(file => String(file.name || "").toLowerCase().endsWith(".torrent"));
        if (torrent) torrentUrl = "https://archive.org/download/" + encodeURIComponent(item.identifier) + "/" + encodeURIComponent(torrent.name);
      } catch {}
      return {
        title: item.title || item.identifier,
        creator: item.creator || "",
        year: item.year || item.date || "",
        identifier: item.identifier,
        itemUrl: "https://archive.org/details/" + encodeURIComponent(item.identifier),
        torrentUrl,
        license
      };
    }));
    res.json({ source: "Internet Archive", results: results.filter(Boolean) });
  } catch (e) { res.status(502).json({ error: "Suche im Internet Archive fehlgeschlagen: " + e.message }); }
});

app.post("/api/torrents/add-magnet", async (req, res) => {
  try {
    const magnet = String(req.body?.magnet || "").trim();
    if (!magnet.startsWith("magnet:?")) return res.status(400).json({ error: "Ungültiger Magnet-Link." });
    const token = await accessToken();
    const body = new URLSearchParams({ magnet });
    const result = await rdFetch(API + "/torrents/addMagnet?auth_token=" + encodeURIComponent(token), {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
    });
    res.json(result);
  } catch (e) { res.status(502).json({ error: e.message }); }
});


function nuvioAuthorized(req, res) {
  const supplied = String(req.params.key || "");
  const expected = String(process.env.NUVIO_ADDON_KEY || "");
  const a = crypto.createHash("sha256").update(supplied).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!expected || !crypto.timingSafeEqual(a, b)) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  return true;
}

function libraryType(filename) {
  return /S\d{1,2}E\d{1,2}|\bseason\s*\d+/i.test(filename) ? "series" : "movie";
}

function isHttps(value) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

async function nuvioLibrary() {
  const items = await rdApi("/downloads");
  return (Array.isArray(items) ? items : []).filter(x => x && (x.download || x.link));
}

app.get("/nuvio/:key/manifest.json", (req, res) => {
  if (!nuvioAuthorized(req, res)) return;
  res.json({
    id: "com.cufi12.realdebrid.library",
    version: "1.0.0",
    name: "Meine Real-Debrid-Bibliothek",
    description: "Durchsucht deine eigene Real-Debrid-Downloadliste nach Filmtiteln und Serien.",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: [
      { type: "movie", id: "rd-library-movies", name: "Meine RD-Filme", extra: [{ name: "search", isRequired: true }] },
      { type: "series", id: "rd-library-series", name: "Meine RD-Serien", extra: [{ name: "search", isRequired: true }] }
    ],
    idPrefixes: ["rd:"]
  });
});

app.get("/nuvio/:key/catalog/:type/:catalogId.json", async (req, res) => {
  if (!nuvioAuthorized(req, res)) return;
  try {
    const type = req.params.type;
    const expectedCatalog = type === "series" ? "rd-library-series" : "rd-library-movies";
    if (!["movie", "series"].includes(type) || req.params.catalogId !== expectedCatalog) return res.json({ metas: [] });
    const search = String(req.query.search || "").trim().slice(0, 100).toLocaleLowerCase();
    const items = await nuvioLibrary();
    const metas = items.filter(x => {
      const filename = String(x.filename || x.original_filename || "");
      return libraryType(filename) === type && (!search || filename.toLocaleLowerCase().includes(search));
    }).map(x => ({
        id: "rd:" + String(x.id),
        type,
        name: String(x.filename || x.original_filename || "Real-Debrid-Datei"),
        description: "Aus deiner Real-Debrid-Downloadliste"
      }));
    res.json({ metas });
  } catch (e) { res.status(502).json({ metas: [], error: e.message }); }
});

app.get("/nuvio/:key/meta/:type/:id.json", async (req, res) => {
  if (!nuvioAuthorized(req, res)) return;
  try {
    const id = decodeURIComponent(req.params.id).replace(/^rd:/, "");
    const items = await nuvioLibrary();
    const item = items.find(x => String(x.id) === id);
    if (!item) return res.json({ meta: null });
    const name = String(item.filename || item.original_filename || "Real-Debrid-Datei");
    res.json({ meta: { id: "rd:" + String(item.id), type: libraryType(name), name, description: "Real-Debrid-Download" } });
  } catch (e) { res.status(502).json({ meta: null, error: e.message }); }
});

app.get("/nuvio/:key/stream/:type/:id.json", async (req, res) => {
  if (!nuvioAuthorized(req, res)) return;
  try {
    const id = decodeURIComponent(req.params.id).replace(/^rd:/, "");
    const items = await nuvioLibrary();
    const item = items.find(x => String(x.id) === id);
    if (!item) return res.json({ streams: [] });
    let url = String(item.download || "");
    if (!isHttps(url) && item.link) {
      const token = await accessToken();
      const body = new URLSearchParams({ link: String(item.link) });
      const resolved = await rdFetch(API + "/unrestrict/link?auth_token=" + encodeURIComponent(token), {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
      });
      url = String(resolved.download || "");
    }
    if (!isHttps(url)) return res.json({ streams: [] });
    res.json({ streams: [{ name: "Real-Debrid", title: "Direkt abspielen", url }] });
  } catch (e) { res.status(502).json({ streams: [], error: e.message }); }
});

app.post("/api/disconnect", (_req, res) => {
  pendingDevice = null; credentials = null; tokens = null;
  res.json({ disconnected: true });
});

app.get("*", (_req, res) => res.sendFile(process.cwd() + "/public/index.html"));

app.listen(PORT, "0.0.0.0", () => console.log(`Real-Debrid Manager listening on ${PORT}`));
