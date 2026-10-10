import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { Area, LatLon, Pack, Poi, POI_ICON, POI_LABEL, PoiType } from './models';
import { bearing, compass, compassWords, distance, fmtDistance, nearestTrail, project } from './geo';
import { PackStore } from './pack-store';
import { LocationService } from './location.service';
import { LocalAiService } from './local-ai.service';

interface Chip { id: string; label: string; question: string }
interface Answer { q: string; text: string; by: 'gemma' | 'offline'; thinking?: boolean }

const CHIPS: Chip[] = [
  { id: 'where', label: '📍 Where am I?', question: 'Where am I right now?' },
  { id: 'car', label: '🚗 Back to my car', question: 'How do I get back to my car?' },
  { id: 'water', label: '💧 Closest water', question: 'Where is the closest water?' },
  { id: 'view', label: '👀 Best nearby view', question: 'What is the closest viewpoint or peak?' },
  { id: 'lost', label: '🧭 I think I’m lost', question: 'I think I am lost. What should I do?' },
];

@Component({
  selector: 'app-root',
  imports: [NgTemplateOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private store = inject(PackStore);
  protected loc = inject(LocationService);
  protected ai = inject(LocalAiService);

  protected readonly icon = POI_ICON;
  protected readonly label = POI_LABEL;
  protected readonly chips = CHIPS;
  protected readonly fmt = fmtDistance;

  // ---------- app state ----------
  protected online = signal(navigator.onLine);
  protected swReady = signal(false);
  protected areas = signal<Area[]>([]);
  protected packs = signal<Pack[]>([]);
  protected busy = signal<string | null>(null);
  protected notice = signal<string | null>(null);

  protected pack = signal<Pack | null>(null);
  protected car = signal<LatLon | null>(null);
  protected crumbs = signal<LatLon[]>([]);
  protected answers = signal<Answer[]>([]);
  protected draft = signal('');

  // ---------- map view (meters, local projection) ----------
  protected viewW = signal(2500);
  protected center = signal<[number, number]>([0, 0]);
  protected follow = signal(true);

  protected origin = computed<LatLon>(() => {
    const b = this.pack()?.bbox ?? [0, 0, 0, 0];
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  });

  protected lines = computed(() => {
    const p = this.pack();
    if (!p) return [];
    const o = this.origin();
    return p.trails.map(t => ({
      id: t.id,
      named: !!t.name,
      kind: t.kind,
      points: t.coords.map(c => project(c, o).map(v => v.toFixed(1)).join(',')).join(' '),
    }));
  });

  protected poiMarks = computed(() => {
    const p = this.pack();
    if (!p) return [];
    const o = this.origin();
    return p.pois
      .filter(x => x.type !== 'toilets' && x.type !== 'parking')
      .map(x => ({ ...x, xy: project([x.lat, x.lon], o) }));
  });

  protected meXY = computed(() => {
    const pos = this.loc.pos();
    return pos ? project(pos, this.origin()) : null;
  });
  protected carXY = computed(() => {
    const c = this.car();
    return c ? project(c, this.origin()) : null;
  });
  protected crumbPoints = computed(() =>
    this.crumbs().map(c => project(c, this.origin()).map(v => v.toFixed(1)).join(',')).join(' '),
  );

  protected viewBox = computed(() => {
    const w = this.viewW();
    const h = w * 1.15;
    const me = this.meXY();
    const [cx, cy] = this.follow() && me ? me : this.center();
    return `${cx - w / 2} ${cy - h / 2} ${w} ${h}`;
  });
  /** Icon size in map meters so icons stay the same size on screen at any zoom. */
  protected iconSize = computed(() => this.viewW() / 16);

  // ---------- what the hiker needs to know ----------
  protected nearest = computed(() => {
    const p = this.pack(), pos = this.loc.pos();
    if (!p || !pos) return null;
    const n = nearestTrail(pos, p.trails);
    if (!n) return null;
    const b = bearing(pos, n.point);
    return { ...n, name: n.trail.name ?? `Unnamed ${n.trail.kind}`, dir: compassWords(b), onTrail: n.distance < 25 };
  });

  protected toCar = computed(() => {
    const pos = this.loc.pos(), c = this.car();
    if (!pos || !c) return null;
    const b = bearing(pos, c);
    return { distance: distance(pos, c), bearing: b, dir: compassWords(b), short: compass(b) };
  });

  protected nearby = computed(() => {
    const p = this.pack(), pos = this.loc.pos();
    if (!p || !pos) return [];
    return p.pois
      .filter(x => x.name || x.type === 'water' || x.type === 'waterfall' || x.type === 'trailhead')
      .map(x => {
        const at: LatLon = [x.lat, x.lon];
        return { ...x, d: distance(pos, at), dir: compass(bearing(pos, at)) };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, 6);
  });

  constructor() {
    window.addEventListener('online', () => this.online.set(true));
    window.addEventListener('offline', () => this.online.set(false));

    // Drop a breadcrumb every 10 m so there is always a way back.
    effect(() => {
      const pos = this.loc.pos(), p = this.pack();
      if (!pos || !p || this.loc.mode() === 'off') return;
      const list = this.crumbs();
      const last = list[list.length - 1];
      if (last && distance(last, pos) < 10) return;
      const next = [...list, pos].slice(-5000);
      this.crumbs.set(next);
      this.store.setCrumbs(p.id, next);
    });
  }

  async ngOnInit() {
    navigator.serviceWorker?.ready.then(() => this.swReady.set(true)).catch(() => {});
    this.packs.set(await this.store.listPacks().catch(() => []));
    const lastId = await this.store.get<string>('lastPack').catch(() => undefined);
    const last = this.packs().find(p => p.id === lastId);
    if (last) await this.open(last);
    this.ai.loadIfCached();
    if (this.online()) {
      fetch('/api/areas').then(r => r.json()).then(a => this.areas.set(a)).catch(() => {});
    }
  }

  // ---------- packs ----------
  protected isSaved(id: string) {
    return this.packs().some(p => p.id === id);
  }

  async download(area: Area) {
    await this.fetchPack(`/api/areas/${area.id}/pack`, area.name);
  }

  async packAroundMe() {
    this.busy.set('Finding you…');
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 20000 }),
      );
      const { latitude: lat, longitude: lon } = pos.coords;
      await this.fetchPack(`/api/pack-near?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&r=3000`, 'trails around you');
    } catch {
      this.busy.set(null);
      this.notice.set('Couldn’t get your location. Check that location is allowed for this site.');
    }
  }

  private async fetchPack(url: string, what: string) {
    this.busy.set(`Packing ${what}… (can take up to a minute)`);
    this.notice.set(null);
    try {
      const r = await fetch(url);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      const pack = body as Pack;
      await this.store.savePack(pack);
      this.packs.set(await this.store.listPacks());
      this.notice.set(`Saved ${pack.name}: ${pack.trails.length} trails, ${pack.pois.length} places. Works with no signal now.`);
    } catch (e) {
      this.notice.set(`Couldn’t download that pack: ${(e as Error).message}. Try again on Wi-Fi.`);
    } finally {
      this.busy.set(null);
    }
  }

  async open(p: Pack) {
    this.pack.set(p);
    this.car.set((await this.store.getCar(p.id)) ?? null);
    this.crumbs.set((await this.store.getCrumbs(p.id)) ?? []);
    this.answers.set([]);
    this.viewW.set(2500);
    this.center.set([0, 0]);
    this.follow.set(true);
    this.store.set('lastPack', p.id);
    window.scrollTo({ top: 0 });
  }

  close() {
    this.loc.stop();
    this.pack.set(null);
    this.store.set('lastPack', null);
  }

  async remove(p: Pack) {
    if (!confirm(`Remove ${p.name} from this phone?`)) return;
    await this.store.deletePack(p.id);
    this.packs.set(await this.store.listPacks());
  }

  // ---------- location ----------
  demoWalk() {
    const p = this.pack();
    if (!p) return;
    const named = p.trails.filter(t => t.name);
    const paths = named.filter(t => t.kind !== 'track');
    const t = [...(paths.length ? paths : named)].sort((a, b) => b.length - a.length)[0] ?? p.trails[0];
    this.loc.startDemo(t);
    this.follow.set(true);
  }

  // ---------- car + breadcrumbs ----------
  async dropCar() {
    const pos = this.loc.pos(), p = this.pack();
    if (!pos || !p) return;
    this.car.set(pos);
    await this.store.setCar(p.id, pos);
  }
  async clearCar() {
    const p = this.pack();
    if (!p) return;
    this.car.set(null);
    await this.store.setCar(p.id, null);
  }
  async clearCrumbs() {
    const p = this.pack();
    if (!p) return;
    this.crumbs.set([]);
    await this.store.setCrumbs(p.id, []);
  }

  // ---------- map controls ----------
  zoom(f: number) {
    this.viewW.update(w => Math.min(12000, Math.max(250, w * f)));
  }
  recenter() {
    this.follow.set(true);
  }

  private drag: { x: number; y: number; c: [number, number]; scale: number } | null = null;
  onDown(e: PointerEvent) {
    const svg = e.currentTarget as SVGSVGElement;
    const me = this.meXY();
    const [cx, cy] = this.follow() && me ? me : this.center();
    this.drag = { x: e.clientX, y: e.clientY, c: [cx, cy], scale: this.viewW() / svg.clientWidth };
    svg.setPointerCapture(e.pointerId);
  }
  onMove(e: PointerEvent) {
    if (!this.drag) return;
    const dx = (e.clientX - this.drag.x) * this.drag.scale;
    const dy = (e.clientY - this.drag.y) * this.drag.scale;
    if (Math.abs(dx) + Math.abs(dy) < 3) return;
    this.follow.set(false);
    this.center.set([this.drag.c[0] - dx, this.drag.c[1] - dy]);
  }
  onUp() {
    this.drag = null;
  }
  onWheel(e: WheelEvent) {
    e.preventDefault();
    this.zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2);
  }

  // ---------- Ask (Gemma on the phone, with an offline fallback) ----------
  private closest(types: PoiType[]): (Poi & { d: number; dir: string }) | null {
    const p = this.pack(), pos = this.loc.pos();
    if (!p || !pos) return null;
    let best: (Poi & { d: number; dir: string }) | null = null;
    for (const x of p.pois) {
      if (!types.includes(x.type)) continue;
      const d = distance(pos, [x.lat, x.lon]);
      if (!best || d < best.d) best = { ...x, d, dir: compassWords(bearing(pos, [x.lat, x.lon])) };
    }
    return best;
  }

  private placeName(x: Poi) {
    return x.name ? `${x.name} (${POI_LABEL[x.type].toLowerCase()})` : `a ${POI_LABEL[x.type].toLowerCase()}`;
  }

  /** Plain facts from the downloaded pack + GPS. Gemma may only use these. */
  private facts(): string {
    const p = this.pack(), pos = this.loc.pos();
    const lines: string[] = [];
    if (p) lines.push(`Area: ${p.name}, ${p.region}.`);
    if (!pos) lines.push('GPS position: unknown (location is off).');
    const n = this.nearest();
    if (n) {
      lines.push(n.onTrail
        ? `You are on or right next to ${n.name}.`
        : `Nearest trail: ${n.name}, ${fmtDistance(n.distance)} to the ${n.dir}.`);
      if (n.trail.difficulty) lines.push(`That trail is rated ${n.trail.difficulty}.`);
    }
    const c = this.toCar();
    lines.push(c ? `Car: ${fmtDistance(c.distance)} to the ${c.dir} in a straight line.` : 'Car: no pin dropped.');
    lines.push(`Breadcrumbs: ${this.crumbs().length > 1 ? 'the path walked so far is drawn on the map in orange' : 'none recorded yet'}.`);
    if (pos) {
      for (const x of this.nearby()) lines.push(`${this.placeName(x)}: ${fmtDistance(x.d)} ${compassWords(bearing(pos, [x.lat, x.lon]))}.`);
    }
    const w = this.closest(['water', 'waterfall']);
    if (w) lines.push(`Closest water: ${this.placeName(w)}, ${fmtDistance(w.d)} ${w.dir}. Treat or filter it before drinking.`);
    const v = this.closest(['viewpoint', 'peak']);
    if (v) lines.push(`Closest view: ${this.placeName(v)}, ${fmtDistance(v.d)} ${v.dir}.`);
    return lines.join('\n');
  }

  /** Answers that never need a model, so the app is useful on any phone. */
  private offlineAnswer(id: string): string {
    const pos = this.loc.pos();
    if (!pos && id !== 'lost') return 'Turn on location first (tap “Use my GPS”). GPS works without cell service.';
    const n = this.nearest(), c = this.toCar();
    const carLine = c ? `Your car is ${fmtDistance(c.distance)} ${c.dir} as the crow flies.` : 'You haven’t dropped a car pin yet.';
    switch (id) {
      case 'where':
        return n
          ? `${n.onTrail ? `You’re on ${n.name}.` : `The nearest trail is ${n.name}, ${fmtDistance(n.distance)} to the ${n.dir}.`} ${carLine}`
          : 'No trails in this pack near you.';
      case 'car':
        return c
          ? `${carLine} The safest way back is the way you came: follow your orange breadcrumbs on the map instead of cutting straight through the woods.`
          : 'No car pin yet. Next time, tap “I parked here” at the trailhead. For now, follow your orange breadcrumbs back.';
      case 'water': {
        const w = this.closest(['water', 'waterfall']);
        return w ? `${this.placeName(w)} is ${fmtDistance(w.d)} ${w.dir}. Filter or treat it before you drink.` : 'No mapped water in this pack. Ration what you have.';
      }
      case 'view': {
        const v = this.closest(['viewpoint', 'peak']);
        return v ? `${this.placeName(v)} is ${fmtDistance(v.d)} ${v.dir}.` : 'No mapped viewpoints nearby.';
      }
      default:
        return `Stop and take a breath. Stay where you are. ${n ? (n.onTrail ? `You’re on ${n.name}, so stay on it.` : `The nearest trail is ${n.name}, ${fmtDistance(n.distance)} ${n.dir}.`) : ''} ${c ? carLine : ''} Follow your breadcrumbs back if you can. If you’re hurt or it’s getting dark, stay put, stay warm and try calling or texting 911.`.replace(/\s+/g, ' ').trim();
    }
  }

  async ask(chip?: Chip) {
    const q = chip?.question ?? this.draft().trim();
    if (!q) return;
    this.draft.set('');
    const id = chip?.id ?? 'free';
    const fallback = id === 'free' ? null : this.offlineAnswer(id);

    if (this.ai.state() !== 'ready') {
      const text = fallback ?? 'Download Gemma (below) to ask your own questions. The buttons above work without it.';
      this.answers.update(a => [{ q, text, by: 'offline' }, ...a]);
      return;
    }
    const pending: Answer = { q, text: 'Thinking on your phone…', by: 'gemma', thinking: true };
    this.answers.update(a => [pending, ...a]);
    try {
      const text = await this.ai.ask(q, this.facts(), fallback);
      // Trust check: for a button, Gemma's version must keep the app's numbers, or we show the app's answer.
      const nums = fallback?.match(/\d[\d.,]*/g) ?? [];
      const trusted = !!text && nums.every(n => text.includes(n));
      const answer: Answer = trusted || !fallback
        ? { q, text: text || 'I don’t know from this trail pack.', by: 'gemma' }
        : { q, text: fallback, by: 'offline' };
      this.answers.update(a => a.map(x => (x === pending ? answer : x)));
    } catch {
      this.answers.update(a => a.map(x => (x === pending ? { q, text: fallback ?? 'Gemma had trouble. Try a button above.', by: 'offline' } : x)));
    }
  }

  setDraft(e: Event) {
    this.draft.set((e.target as HTMLInputElement).value);
  }

  // ---------- template helpers ----------
  protected ageOf(p: Pack) {
    const d = Math.round((Date.now() - Date.parse(p.packedAt)) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  }
  protected trailCount(p: Pack) {
    return p.trails.filter(t => t.name).length;
  }
}
