# Off-Grid Trails

An offline trail finder for when there's no cell service. Built for the North Georgia mountains and the Smokies.

Download a trail pack on Wi-Fi before you go. After that, everything works in airplane mode:

- **Map of nearby trails** (OpenStreetMap data, drawn on the phone, no map tiles needed)
- **Nearest trail** with distance and direction
- **"I parked here"** car pin and a live arrow back to it
- **Breadcrumbs** of the path you walked, so you can retrace your steps
- **Nearby** water, waterfalls, viewpoints, peaks, shelters and trailheads
- **Ask Gemma**: a small Gemma model runs *on the phone* with WebLLM (WebGPU). It only answers from the facts in your pack and your GPS. The question buttons also work without the model.

> This app is a companion, not a replacement for a paper map, water and telling someone your plan.

## Run it locally

Needs Node 22.22.3+ (Node 24 recommended).

```bash
npm install
npm run build
npm start            # http://localhost:3000
```

For live-reload development, run two terminals:

```bash
npm run api          # Express API on :3000
npm run dev          # Angular on :4200, proxies /api to :3000
```

The service worker only runs in the production build (`npm run build && npm start`).

## How it works

| Piece | What it does |
| --- | --- |
| `server.mjs` | Express 5. `/api/areas`, `/api/areas/:id/pack`, `/api/pack-near?lat&lon&r`. Queries the Overpass API once, trims the data into a small "pack", caches it 72 hours, rate-limits 20 packs/hour per IP. Serves the Angular build. |
| `areas.mjs` | Preset areas (Vogel/Blood Mountain, Amicalola, Laurel Falls, Clingmans Dome, Alum Cave). Add your own bounding boxes here. |
| `src/app/pack-store.ts` | IndexedDB: packs, car pin and breadcrumbs live on the phone. |
| `src/app/location.service.ts` | GPS (`watchPosition`) plus a **Demo walk** that walks a trail so you can test from the couch. |
| `src/app/local-ai.service.ts` | WebLLM. Loads `gemma3-1b-it-q4f16_1-MLC` (~700 MB, one-time), falls back to `gemma-2-2b-it-q4f16_1-MLC-1k`. |
| `ngsw-config.json` | Angular service worker caches the app so it opens with no signal. |

GPS works without cell service: the phone talks to satellites, not towers.

## Deploy to Render

1. Push this folder to a new GitHub repo.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` sets everything up.
3. Open the URL on your iPhone in Safari, then **Share → Add to Home Screen**.

Optional environment variables: `OVERPASS_URLS` (comma-separated Overpass endpoints), `CACHE_HOURS`, `PACKS_PER_HOUR`, `CACHE_DIR`.

## Test it offline on iPhone

1. On Wi-Fi: open the app, download a pack, tap **Download Gemma** and wait for "Ready offline".
2. Turn on **Airplane Mode** (leave Location Services on).
3. Open the app from your Home Screen. Open the pack, tap **Use my GPS**, drop a car pin, walk around, ask a question.

Gemma needs WebGPU (Safari on iOS 26+). If it isn't available, everything else still works.

## Credits

Trail data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL. Packs are fetched through the public Overpass API; please be gentle with it.
On-device AI: [Gemma](https://ai.google.dev/gemma) via [WebLLM](https://webllm.mlc.ai).
