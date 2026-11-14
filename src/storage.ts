// Persistence (expo-file-system), geo helpers and GPX/GeoJSON export.
import { Directory, File, Paths } from 'expo-file-system';

export type Settings = {
  strokeWidthM: number; // coverage line width in real meters
  maxAccuracyM: number; // drop fixes with worse accuracy than this
  minMoveM: number; // ignore jitter smaller than this
  keepAwake: boolean;
  baseLayer: 'osm' | 'sat';
  showPast: boolean; // draw tracks of previous sessions
};

export const DEFAULT_SETTINGS: Settings = {
  strokeWidthM: 2,
  maxAccuracyM: 15,
  minMoveM: 1,
  keepAwake: false,
  baseLayer: 'sat',
  showPast: true,
};

/** [lat, lon, accuracyM, timestampMs, segmentId] */
export type TrackPoint = [number, number, number, number, number];
export type Area = { id: string; name: string; coords: [number, number][] };
export type Meta = { seg: number; wantTracking: boolean };
export type PastSession = { name: string; points: TrackPoint[] };

const dir = Paths.document;
const settingsFile = new File(dir, 'settings.json');
const areasFile = new File(dir, 'areas.json');
const metaFile = new File(dir, 'meta.json');
export const trackFile = new File(dir, 'track.ndjson');
const sessionsDir = new Directory(dir, 'sessions');

function readJson<T>(f: File, fallback: T): T {
  try {
    if (!f.exists) return fallback;
    return { ...fallback, ...JSON.parse(f.textSync()) };
  } catch {
    return fallback;
  }
}

function writeJson(f: File, v: unknown) {
  if (!f.exists) f.create();
  f.writeSync(JSON.stringify(v));
}

export const loadSettings = () => readJson(settingsFile, DEFAULT_SETTINGS);
export const saveSettings = (s: Settings) => writeJson(settingsFile, s);
export const loadMeta = () => readJson<Meta>(metaFile, { seg: 0, wantTracking: false });
export const saveMeta = (m: Meta) => writeJson(metaFile, m);

export function loadAreas(): Area[] {
  try {
    return areasFile.exists ? JSON.parse(areasFile.textSync()) : [];
  } catch {
    return [];
  }
}
export const saveAreas = (a: Area[]) => writeJson(areasFile, a);

function parseTrack(text: string): TrackPoint[] {
  const pts: TrackPoint[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      pts.push(JSON.parse(line));
    } catch {
      // a half-written last line after a crash is simply skipped
    }
  }
  return pts;
}

export function loadTrack(): TrackPoint[] {
  return trackFile.exists ? parseTrack(trackFile.textSync()) : [];
}

export async function appendPoints(pts: TrackPoint[]) {
  if (!pts.length) return;
  if (!trackFile.exists) trackFile.create();
  await trackFile.write(pts.map((p) => JSON.stringify(p)).join('\n') + '\n', { append: true });
}

export function clearTrack() {
  if (trackFile.exists) trackFile.delete();
}

/** Moves the current track into sessions/ so it is kept (and still drawn as "past"). */
export function archiveTrack() {
  if (!trackFile.exists) return;
  if (!sessionsDir.exists) sessionsDir.create();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  trackFile.move(new File(sessionsDir, `track-${stamp}.ndjson`));
}

export function loadPastSessions(): PastSession[] {
  if (!sessionsDir.exists) return [];
  return sessionsDir
    .list()
    .filter((e): e is File => e instanceof File && e.name.endsWith('.ndjson'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => ({ name: f.name.replace('.ndjson', ''), points: parseTrack(f.textSync()) }));
}

// ---------- geo ----------
const R = 6378137;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Geodesic polygon area in m² (same formula as Leaflet.draw). */
export function polygonAreaM2(coords: [number, number][]) {
  if (coords.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lat1, lon1] = coords[i];
    const [lat2, lon2] = coords[(i + 1) % coords.length];
    area += rad(lon2 - lon1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((area * R * R) / 2);
}

export function formatArea(m2: number) {
  return m2 >= 100000 ? `${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2).toLocaleString()} m²`;
}

/** Splits points into segments (one per Start→Stop) as [lat, lon] arrays. */
export function segments(points: TrackPoint[]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  let seg: number | null = null;
  for (const p of points) {
    if (p[4] !== seg) {
      if (cur.length) out.push(cur);
      cur = [];
      seg = p[4];
    }
    cur.push([p[0], p[1]]);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function trackLengthM(points: TrackPoint[]) {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a[4] === b[4]) d += distanceM(a[0], a[1], b[0], b[1]);
  }
  return d;
}

// ---------- export ----------
const iso = (t: number) => new Date(t).toISOString();

function gpxTrack(name: string, points: TrackPoint[]) {
  const segs: TrackPoint[][] = [];
  for (const p of points) {
    const last = segs[segs.length - 1];
    if (last && last[0][4] === p[4]) last.push(p);
    else segs.push([p]);
  }
  const body = segs
    .map(
      (s) =>
        '<trkseg>' +
        s.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"><time>${iso(p[3])}</time><hdop>${p[2].toFixed(1)}</hdop></trkpt>`).join('') +
        '</trkseg>',
    )
    .join('');
  return `<trk><name>${name}</name>${body}</trk>`;
}

export function toGpx(track: TrackPoint[], past: PastSession[], areas: Area[]) {
  const parts = [
    ...past.map((s) => gpxTrack(s.name, s.points)),
    gpxTrack('current-session', track),
    ...areas.map((a) => {
      const ring = [...a.coords, a.coords[0]];
      return `<trk><name>${a.name}</name><type>search-area</type><trkseg>${ring
        .map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"/>`)
        .join('')}</trkseg></trk>`;
    }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Search Tracker" xmlns="http://www.topografix.com/GPX/1/1">${parts.join('')}</gpx>\n`;
}

export function toGeoJson(track: TrackPoint[], past: PastSession[], areas: Area[], strokeWidthM: number) {
  const line = (name: string, pts: TrackPoint[]) => ({
    type: 'Feature',
    properties: { name, kind: 'track', strokeWidthM, start: pts[0] ? iso(pts[0][3]) : null },
    geometry: { type: 'MultiLineString', coordinates: segments(pts).map((s) => s.map(([la, lo]) => [lo, la])) },
  });
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      features: [
        ...past.map((s) => line(s.name, s.points)),
        line('current-session', track),
        ...areas.map((a) => ({
          type: 'Feature',
          properties: { name: a.name, kind: 'search-area', areaM2: Math.round(polygonAreaM2(a.coords)) },
          geometry: { type: 'Polygon', coordinates: [[...a.coords, a.coords[0]].map(([la, lo]) => [lo, la])] },
        })),
      ],
    },
    null,
    1,
  );
}

export function writeExport(name: string, content: string) {
  const f = new File(Paths.cache, name);
  if (f.exists) f.delete();
  f.create();
  f.writeSync(content);
  return f.uri;
}
