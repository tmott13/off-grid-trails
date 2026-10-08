// Run on your own computer: `npm run bake`
// Downloads every preset area from OpenStreetMap once and saves it in packs/.
// Commit packs/ and the deployed app serves them without calling Overpass.
// Optional: `npm run bake -- amicalola` to bake just one area.
import fs from 'node:fs/promises';
import { AREAS } from './areas.mjs';
import { buildPack, fetchOverpass } from './server.mjs';

const only = process.argv.slice(2);
await fs.mkdir(new URL('./packs/', import.meta.url), { recursive: true });
for (const a of AREAS.filter(a => !only.length || only.includes(a.id))) {
  process.stdout.write(`Packing ${a.name}… `);
  try {
    const pack = buildPack(await fetchOverpass(a.bbox), { id: a.id, name: a.name, region: a.region, bbox: a.bbox });
    await fs.writeFile(new URL(`./packs/${a.id}.json`, import.meta.url), JSON.stringify(pack));
    console.log(`${pack.trails.filter(t => t.name).length} named trails, ${pack.pois.length} places ✓`);
  } catch (e) {
    console.log(`failed: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, Number(process.env.BAKE_PAUSE_MS ?? 5000))); // be gentle with the public Overpass servers
}
