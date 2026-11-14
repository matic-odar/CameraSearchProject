// Background GPS tracking: an expo-task-manager task fed by expo-location with a
// foreground-service notification, so points keep being logged with the screen off.
// This file must be imported from index.ts so the task is defined at startup
// (Android may start the JS runtime headless just to run the task).
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  appendPoints,
  distanceM,
  loadMeta,
  loadSettings,
  loadTrack,
  saveMeta,
  Settings,
  TrackPoint,
} from './storage';

export const TASK = 'search-tracker-location';

type Listener = (kept: TrackPoint[], latest: Location.LocationObject | null) => void;
const listeners = new Set<Listener>();
export function onTrackUpdate(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// In-memory state; lazily (re)loaded from disk when running in a fresh headless runtime.
let settings: Settings | null = null;
let seg: number | null = null;
let last: TrackPoint | null = null;
let queue = Promise.resolve();

export function setTrackingSettings(s: Settings) {
  settings = s;
}

function ensureState() {
  if (!settings) settings = loadSettings();
  if (seg === null) {
    seg = loadMeta().seg;
    const t = loadTrack();
    const l = t[t.length - 1];
    last = l && l[4] === seg ? l : null;
  }
}

function processLocations(locs: Location.LocationObject[]) {
  ensureState();
  const s = settings!;
  const kept: TrackPoint[] = [];
  for (const loc of [...locs].sort((a, b) => a.timestamp - b.timestamp)) {
    const { latitude, longitude, accuracy } = loc.coords;
    const acc = accuracy ?? 999;
    if (acc > s.maxAccuracyM) continue; // too inaccurate
    if (last && distanceM(last[0], last[1], latitude, longitude) < s.minMoveM) continue; // stationary jitter
    const p: TrackPoint = [
      Math.round(latitude * 1e7) / 1e7,
      Math.round(longitude * 1e7) / 1e7,
      Math.round(acc * 10) / 10,
      loc.timestamp,
      seg!,
    ];
    kept.push(p);
    last = p;
  }
  const latest = locs.length ? locs.reduce((a, b) => (a.timestamp > b.timestamp ? a : b)) : null;
  listeners.forEach((l) => l(kept, latest));
  // Serialize appends so lines never interleave.
  queue = queue.then(() => appendPoints(kept)).catch((e) => console.warn('append failed', e));
  return queue;
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK, async ({ data, error }) => {
  if (error) {
    console.warn('location task error', error.message);
    return;
  }
  if (data?.locations?.length) await processLocations(data.locations);
});

export async function isTracking() {
  return Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false);
}

/** Asks for fine + background location. Returns a user-facing error string, or null when OK. */
export async function requestPermissions(): Promise<string | null> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'Location permission is required to track your path.';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted')
    return 'Background location was not allowed. In the settings page that opens, choose Location → "Allow all the time" so tracking continues with the screen off.';
  return null;
}

/** Starts a new segment (so the line doesn't jump from where you stopped) and begins logging. */
export async function startTracking() {
  if (await isTracking()) return;
  seg = loadMeta().seg + 1;
  last = null;
  saveMeta({ seg, wantTracking: true });
  await Location.startLocationUpdatesAsync(TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 1000,
    distanceInterval: 1,
    deferredUpdatesInterval: 0,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Fitness,
    foregroundService: {
      notificationTitle: 'Search Tracker is recording',
      notificationBody: 'Logging your walked path',
      notificationColor: '#0a62d0',
      killServiceOnDestroy: false,
    },
  });
}

export async function stopTracking() {
  saveMeta({ ...loadMeta(), wantTracking: false });
  if (await isTracking()) await Location.stopLocationUpdatesAsync(TASK);
}

/** Called after the track file is cleared/archived so the next point doesn't connect to old ones. */
export function resetLastPoint() {
  last = null;
}
