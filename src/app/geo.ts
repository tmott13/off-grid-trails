import { LatLon, Trail } from './models';

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in meters. */
export function distance(a: LatLon, b: LatLon): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, 0–360 degrees (0 = north). */
export function bearing(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function compass(b: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(b / 45) % 8];
}

export function compassWords(b: number): string {
  const words = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return words[Math.round(b / 45) % 8];
}

/** Friendly distance: feet under ~0.1 mi, otherwise miles. */
export function fmtDistance(m: number): string {
  const ft = m * 3.28084;
  if (ft < 528) return `${Math.round(ft / 10) * 10} ft`;
  const mi = m / 1609.34;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/** Local flat projection (meters) around an origin; fine for areas a few km wide. */
export function project(p: LatLon, origin: LatLon): [number, number] {
  const x = (p[1] - origin[1]) * 111320 * Math.cos(rad(origin[0]));
  const y = -(p[0] - origin[0]) * 110540;
  return [x, y];
}

function pointToSegment(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  const cx = a[0] + t * dx, cy = a[1] + t * dy;
  return { d: Math.hypot(p[0] - cx, p[1] - cy), cx, cy };
}

export interface NearestTrail {
  trail: Trail;
  distance: number; // meters to the closest point on the trail
  point: LatLon;    // that closest point
}

/** Closest trail to a position. Prefers named trails when an unnamed one is barely closer. */
export function nearestTrail(pos: LatLon, trails: Trail[]): NearestTrail | null {
  let best: NearestTrail | null = null;
  let bestNamed: NearestTrail | null = null;
  for (const trail of trails) {
    let local: { d: number; cx: number; cy: number } | null = null;
    for (let i = 1; i < trail.coords.length; i++) {
      const a = project(trail.coords[i - 1], pos);
      const b = project(trail.coords[i], pos);
      const r = pointToSegment([0, 0], a, b);
      if (!local || r.d < local.d) local = r;
    }
    if (!local) continue;
    const point: LatLon = [pos[0] - local.cy / 110540, pos[1] + local.cx / (111320 * Math.cos(rad(pos[0])))];
    const cand = { trail, distance: local.d, point };
    if (!best || cand.distance < best.distance) best = cand;
    if (trail.name && (!bestNamed || cand.distance < bestNamed.distance)) bestNamed = cand;
  }
  if (best && bestNamed && best !== bestNamed && bestNamed.distance - best.distance < 40) return bestNamed;
  return best;
}
