import { Injectable, signal } from '@angular/core';
import { LatLon, Trail } from './models';
import { distance } from './geo';

export type LocMode = 'off' | 'gps' | 'demo';

/**
 * GPS works with no cell signal: the phone's GPS chip talks to satellites, not towers.
 * Demo mode walks along a trail so you can try the app from your couch.
 */
@Injectable({ providedIn: 'root' })
export class LocationService {
  readonly mode = signal<LocMode>('off');
  readonly pos = signal<LatLon | null>(null);
  readonly accuracy = signal<number | null>(null);
  readonly heading = signal<number | null>(null);
  readonly error = signal<string | null>(null);

  private watchId: number | null = null;
  private demoTimer: ReturnType<typeof setInterval> | null = null;

  startGps() {
    this.stop();
    if (!('geolocation' in navigator)) {
      this.error.set('This browser has no location support.');
      return;
    }
    this.mode.set('gps');
    this.error.set(null);
    this.watchId = navigator.geolocation.watchPosition(
      p => {
        this.pos.set([p.coords.latitude, p.coords.longitude]);
        this.accuracy.set(Math.round(p.coords.accuracy));
        this.heading.set(p.coords.heading ?? null);
        this.error.set(null);
      },
      e => {
        this.error.set(
          e.code === e.PERMISSION_DENIED
            ? 'Location is blocked. On iPhone: Settings → Privacy → Location Services → Safari Websites → While Using.'
            : 'Still looking for GPS. Step into the open sky for a moment.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
  }

  /** Walks along the trail at about 4 m every tick, so the whole app can be tried indoors. */
  startDemo(trail: Trail) {
    this.stop();
    this.mode.set('demo');
    this.error.set(null);
    this.accuracy.set(5);
    // Walk out and back so the loop never jumps from the end of the trail to the start.
    const out = densify(trail.coords, 4);
    const pts = [...out, ...out.slice(1, -1).reverse()];
    let i = 0;
    this.pos.set(pts[0]);
    this.demoTimer = setInterval(() => {
      i = (i + 1) % pts.length;
      this.pos.set(pts[i]);
    }, 250);
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.watchId = null;
    this.demoTimer = null;
    this.mode.set('off');
  }
}

/** Splits a line into points roughly `step` meters apart. */
function densify(coords: LatLon[], step: number): LatLon[] {
  const out: LatLon[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const n = Math.max(1, Math.round(distance(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
