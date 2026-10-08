// Off-Grid Trails server: serves the app and "packs" trail data from OpenStreetMap
// so the phone can use it later with no signal. Data © OpenStreetMap contributors (ODbL).
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AREAS } from './areas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const OVERPASS = (process.env.OVERPASS_URLS ||
  'https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter')
  .split(',').map(s => s.trim()).filter(Boolean);
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '.pack-cache');
const CACHE_HOURS = Number(process.env.CACHE_HOURS || 72);
const MAX_SPAN_DEG = 0.12; // keep custom areas small (~13 km)

const memCache = new Map();
let lastError = null;

// ---------- helpers ----------
const R = 6371000;
const toRad = d => (d * Math.PI) / 180;
function meters(a, b) {
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const round5 = n => Math.round(n * 1e5) / 1e5;

function poiType(t) {
  if (t.tourism === 'viewpoint') return 'viewpoint';
  if (t.natural === 'peak') return 'peak';
  if (t.waterway === 'waterfall' || t.natural === 'waterfall') return 'waterfall';
  if (t.natural === 'spring' || t.amenity === 'drinking_water') return 'water';
  if (t.highway === 'trailhead') return 'trailhead';
  if (t.amenity === 'parking') return 'parking';
  if (t.amenity === 'toilets') return 'toilets';
  if (t.amenity === 'shelter' || ['alpine_hut', 'wilderness_hut'].includes(t.tourism)) return 'shelter';
  if (t.tourism === 'camp_site') return 'campsite';
  return null;
}

function overpassQuery([s, w, n, e]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:90];
(
  way["highway"~"^(path|footway|track|steps|bridleway)$"](${b});
  node["tourism"~"^(viewpoint|camp_site|alpine_hut|wilderness_hut)$"](${b});
  node["natural"~"^(peak|spring|waterfall)$"](${b});
  node["waterway"="waterfall"](${b});
  node["amenity"~"^(drinking_water|parking|toilets|shelter)$"](${b});
  node["highway"="trailhead"](${b});
);
out geom;`;
}

// Turn raw Overpass JSON into a small "pack" the phone can store.
export function buildPack(raw, meta) {
  const trails = [];
  const pois = [];
  for (const el of raw.elements || []) {
    const t = el.tags || {};
    if (el.type === 'way' && el.geometry?.length > 1) {
      const coords = [];
      for (const g of el.geometry) {
        const p = [round5(g.lat), round5(g.lon)];
        if (!coords.length || meters(coords[coords.length - 1], p) >= 4) coords.push(p);
      }
      const last = el.geometry[el.geometry.length - 1];
      const end = [round5(last.lat), round5(last.lon)];
      if (meters(coords[coords.length - 1], end) > 0) coords.push(end);
      if (coords.length < 2) continue;
      let length = 0;
      for (let i = 1; i < coords.length; i++) length += meters(coords[i - 1], coords[i]);
      // Skip short unnamed service tracks; keep every named path.
      if (!t.name && t.highway === 'track' && length < 150) continue;
      trails.push({
        id: el.id,
        name: t.name || null,
        kind: t.highway,
        difficulty: t.sac_scale || null,
        length: Math.round(length),
        coords,
      });
    } else if (el.type === 'node') {
      const type = poiType(t);
      if (!type) continue;
      pois.push({ id: el.id, type, name: t.name || null, lat: round5(el.lat), lon: round5(el.lon), ele: t.ele ? Number(t.ele) : null });
    }
  }
  return {
    ...meta,
    packedAt: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
    trails,
    pois,
  };
}

async function fetchOverpass(bbox) {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  let err;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'off-grid-trails/1.0 (Hacktoberfest project)' },
        body,
        signal: AbortSignal.timeout(100_000),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status} at ${url}`);
      return await res.json();
    } catch (e) { err = e; console.error(e.message); }
  }
  throw err || new Error('Overpass unavailable');
}

async function getPack(key, bbox, meta) {
  const now = Date.now();
  const hit = memCache.get(key);
  if (hit && now - hit.at < CACHE_HOURS * 3600_000) return hit.pack;
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const stat = await fs.stat(file);
    if (now - stat.mtimeMs < CACHE_HOURS * 3600_000) {
      const pack = JSON.parse(await fs.readFile(file, 'utf8'));
      memCache.set(key, { at: stat.mtimeMs, pack });
      return pack;
    }
  } catch { /* not cached yet */ }
  const pack = buildPack(await fetchOverpass(bbox), meta);
  memCache.set(key, { at: now, pack });
  try { await fs.mkdir(CACHE_DIR, { recursive: true }); await fs.writeFile(file, JSON.stringify(pack)); } catch { /* cache is optional */ }
  return pack;
}

// Gentle rate limit so nobody hammers Overpass through us.
const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 3600_000);
  if (recent.length >= Number(process.env.PACKS_PER_HOUR || 20)) return false;
  recent.push(now); hits.set(ip, recent); return true;
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);

app.get('/api/health', (_req, res) => res.json({ ok: true, overpass: OVERPASS, cachedPacks: memCache.size, lastError }));
app.get('/api/areas', (_req, res) => res.json(AREAS));

app.get('/api/areas/:id/pack', async (req, res) => {
  const area = AREAS.find(a => a.id === req.params.id);
  if (!area) return res.status(404).json({ error: 'Unknown area' });
  if (!allowed(req.ip)) return res.status(429).json({ error: 'Too many packs, try again later.' });
  try {
    res.json(await getPack(area.id, area.bbox, { id: area.id, name: area.name, region: area.region, bbox: area.bbox }));
  } catch (e) {
    lastError = { at: new Date().toISOString(), message: String(e.message).slice(0, 300) };
    res.status(502).json({ error: 'Could not reach OpenStreetMap right now. Try again in a minute.' });
  }
});

// Pack the area around a point (for testing at a local park).
app.get('/api/pack-near', async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  const radius = Math.min(Math.max(Number(req.query.r) || 1500, 300), 5000);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) return res.status(400).json({ error: 'Bad location' });
  if (!allowed(req.ip)) return res.status(429).json({ error: 'Too many packs, try again later.' });
  const dLat = radius / 110540, dLon = radius / (111320 * Math.cos(toRad(lat)));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(round5);
  if (bbox[2] - bbox[0] > MAX_SPAN_DEG) return res.status(400).json({ error: 'Area too large' });
  const key = `near_${lat.toFixed(3)}_${lon.toFixed(3)}_${radius}`;
  try {
    res.json(await getPack(key, bbox, { id: key, name: 'Around me', region: `${radius} m radius`, bbox }));
  } catch (e) {
    lastError = { at: new Date().toISOString(), message: String(e.message).slice(0, 300) };
    res.status(502).json({ error: 'Could not reach OpenStreetMap right now. Try again in a minute.' });
  }
});

const dist = path.join(__dirname, 'dist', 'off-grid-trails', 'browser');
app.use(express.static(dist, { setHeaders: (res, p) => { if (p.endsWith('ngsw-worker.js') || p.endsWith('ngsw.json')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`Off-Grid Trails on http://localhost:${PORT}`));
}
