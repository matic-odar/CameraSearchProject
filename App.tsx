import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { MAP_HTML } from './src/mapHtml';
import {
  Area,
  archiveTrack,
  clearTrack,
  formatArea,
  loadAreas,
  loadMeta,
  loadPastSessions,
  loadSettings,
  loadTrack,
  polygonAreaM2,
  saveAreas,
  saveSettings,
  segments,
  Settings,
  toGeoJson,
  toGpx,
  TrackPoint,
  trackLengthM,
  writeExport,
} from './src/storage';
import {
  isTracking,
  onTrackUpdate,
  requestPermissions,
  resetLastPoint,
  setTrackingSettings,
  startTracking,
  stopTracking,
} from './src/tracking';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const insets = useSafeAreaInsets();
  // WebView is typed as a FunctionComponent, so type the imperative handle we use explicitly.
  const web = useRef<{ injectJavaScript(js: string): void; reload(): void } | null>(null);
  const ready = useRef(false);
  const pending = useRef<object[]>([]);

  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [track, setTrack] = useState<TrackPoint[]>(loadTrack);
  const [areas, setAreas] = useState<Area[]>(loadAreas);
  const [past, setPast] = useState(loadPastSessions);
  const [tracking, setTracking] = useState(false);
  const [fix, setFix] = useState<{ acc: number; t: number } | null>(null);
  const [draft, setDraft] = useState<[number, number][] | null>(null); // non-null = draw mode
  const [showSettings, setShowSettings] = useState(false);

  // ---- bridge to the map page ----
  const send = useCallback((msg: object) => {
    if (!ready.current) {
      pending.current.push(msg);
      return;
    }
    web.current?.injectJavaScript(`window.handleMsg(${JSON.stringify(msg)});true;`);
  }, []);

  const areaMsgs = (list: Area[]) =>
    list.map((a) => ({ id: a.id, coords: a.coords, label: `${a.name}: ${formatArea(polygonAreaM2(a.coords))}` }));
  const pastSegs = (p = past) => p.flatMap((s) => segments(s.points));

  // ---- settings ----
  const updateSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
    setTrackingSettings(next);
    if (patch.strokeWidthM !== undefined) send({ type: 'width', width: next.strokeWidthM });
    if (patch.baseLayer) send({ type: 'base', base: next.baseLayer });
    if (patch.showPast !== undefined) send({ type: 'past', past: next.showPast ? pastSegs() : [], showPast: next.showPast });
  };

  useEffect(() => {
    if (settings.keepAwake) activateKeepAwakeAsync('search');
    else deactivateKeepAwake('search');
  }, [settings.keepAwake]);

  // ---- tracking: live points from the background task (same JS runtime while app is open) ----
  useEffect(
    () =>
      onTrackUpdate((kept, latest) => {
        if (kept.length) {
          setTrack((t) => t.concat(kept));
          send({ type: 'append', points: kept });
        }
        if (latest) setFix({ acc: latest.coords.accuracy ?? 999, t: latest.timestamp });
      }),
    [send],
  );

  // Foreground watcher: blue dot + accuracy readout even when not recording.
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
        (loc) => {
          const acc = loc.coords.accuracy ?? 999;
          setFix({ acc, t: loc.timestamp });
          send({ type: 'me', lat: loc.coords.latitude, lng: loc.coords.longitude, acc });
        },
      );
      if (cancelled) sub.remove();
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [send]);

  // Resume on reopen: reload the file (background task may have written while we were away)
  // and restart tracking if it was on when the app/phone died.
  const resync = useCallback(async () => {
    const t = loadTrack();
    setTrack(t);
    send({ type: 'track', track: t });
    const running = await isTracking();
    if (!running && loadMeta().wantTracking) {
      try {
        await startTracking();
        setTracking(true);
        return;
      } catch {
        // permission revoked etc. — fall through
      }
    }
    setTracking(running);
  }, [send]);

  useEffect(() => {
    resync();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && resync());
    return () => sub.remove();
  }, [resync]);

  const toggleTracking = async () => {
    if (tracking) {
      await stopTracking();
      setTracking(false);
      return;
    }
    const err = await requestPermissions();
    if (err) {
      Alert.alert('Permission needed', err, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    try {
      await startTracking();
      setTracking(true);
    } catch (e) {
      Alert.alert('Could not start tracking', String(e));
    }
  };

  // ---- map messages ----
  const onMessage = (e: WebViewMessageEvent) => {
    const m = JSON.parse(e.nativeEvent.data);
    if (m.type === 'ready') {
      ready.current = true;
      web.current?.injectJavaScript(
        `window.handleMsg(${JSON.stringify({
          type: 'init',
          base: settings.baseLayer,
          width: settings.strokeWidthM,
          showPast: settings.showPast,
          areas: areaMsgs(areas),
          past: settings.showPast ? pastSegs() : [],
          track,
        })});true;`,
      );
      pending.current.filter((p: any) => p.type === 'me').slice(-1).forEach(send);
      pending.current = [];
      if (draft) send({ type: 'draw', on: true }), send({ type: 'draft', coords: draft });
    } else if (m.type === 'tap' && draft) {
      const next: [number, number][] = [...draft, [m.lat, m.lng]];
      setDraft(next);
      send({ type: 'draft', coords: next });
    } else if (m.type === 'areaTap') {
      const a = areas.find((x) => x.id === m.id);
      if (!a) return;
      Alert.alert(a.name, formatArea(polygonAreaM2(a.coords)), [
        { text: 'Close', style: 'cancel' },
        { text: 'Delete area', style: 'destructive', onPress: () => commitAreas(areas.filter((x) => x.id !== a.id)) },
      ]);
    } else if (m.type === 'noFix') {
      Alert.alert('No GPS fix yet', 'Wait a moment outdoors with a clear view of the sky.');
    }
  };

  // ---- drawing ----
  const commitAreas = (list: Area[]) => {
    setAreas(list);
    saveAreas(list);
    send({ type: 'areas', areas: areaMsgs(list) });
  };
  const setDraftAndSend = (d: [number, number][] | null) => {
    setDraft(d);
    send({ type: 'draw', on: d !== null });
    send({ type: 'draft', coords: d ?? [] });
  };
  const finishArea = () => {
    if (!draft || draft.length < 3) {
      Alert.alert('Need at least 3 points', 'Tap the map to add the corners of the area.');
      return;
    }
    const n = areas.reduce((mx, a) => Math.max(mx, Number(a.name.replace(/\D/g, '')) || 0), 0) + 1;
    commitAreas([...areas, { id: String(Date.now()), name: `Area ${n}`, coords: draft }]);
    setDraftAndSend(null);
  };

  // ---- session actions ----
  const confirm = (title: string, msg: string, action: () => void) =>
    Alert.alert(title, msg, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Yes', style: 'destructive', onPress: action },
    ]);

  const clearCurrent = () =>
    confirm('Clear track?', 'This permanently deletes the current track. Areas are kept.', () => {
      clearTrack();
      resetLastPoint();
      setTrack([]);
      send({ type: 'track', track: [] });
    });

  const newSession = () =>
    confirm(
      'Start new session?',
      'The current track is archived (still exported, and shown in orange if "Show past sessions" is on) and a fresh track begins. Areas are kept.',
      () => {
        archiveTrack();
        resetLastPoint();
        const p = loadPastSessions();
        setPast(p);
        setTrack([]);
        send({ type: 'track', track: [] });
        send({ type: 'past', past: settings.showPast ? pastSegs(p) : [], showPast: settings.showPast });
      },
    );

  const doExport = async (kind: 'gpx' | 'geojson') => {
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const uri =
        kind === 'gpx'
          ? writeExport(`search-${stamp}.gpx`, toGpx(track, past, areas))
          : writeExport(`search-${stamp}.geojson`, toGeoJson(track, past, areas, settings.strokeWidthM));
      await Sharing.shareAsync(uri, {
        mimeType: kind === 'gpx' ? 'application/gpx+xml' : 'application/geo+json',
        dialogTitle: 'Export search data',
      });
    } catch (e) {
      Alert.alert('Export failed', String(e));
    }
  };

  // ---- derived ----
  const lengthM = useMemo(() => trackLengthM(track), [track]);
  const draftArea = draft ? polygonAreaM2(draft) : 0;
  const accColor = !fix ? '#666' : fix.acc <= 5 ? '#0a7d2c' : fix.acc <= settings.maxAccuracyM ? '#a86400' : '#c4001a';

  return (
    <View style={styles.root}>
      <WebView
        ref={web as never}
        style={styles.map}
        originWhitelist={['*']}
        source={{ html: MAP_HTML, baseUrl: 'https://search-tracker.local/' }}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        overScrollMode="never"
        onContentProcessDidTerminate={() => {
          web.current?.reload();
        }}
        onRenderProcessGone={() => {
          web.current?.reload();
        }}
        onLoadStart={() => {
          ready.current = false;
        }}
      />

      {/* status */}
      <View style={[styles.status, { top: insets.top + 8 }]} pointerEvents="none">
        <Text style={[styles.statusText, { color: accColor }]}>
          GPS {fix ? `±${fix.acc.toFixed(1)} m` : 'waiting…'}
        </Text>
        <Text style={styles.statusSub}>
          {tracking ? '● REC' : 'Not recording'} · {(lengthM / 1000).toFixed(2)} km · {track.length} pts
        </Text>
      </View>

      {/* center on me */}
      <Pressable style={[styles.fab, { top: insets.top + 8 }]} onPress={() => send({ type: 'center' })}>
        <Text style={styles.fabText}>◎</Text>
      </Pressable>

      {/* draw toolbar */}
      {draft && (
        <View style={[styles.drawBar, { bottom: insets.bottom + 96 }]}>
          <Text style={styles.drawInfo}>
            Tap map to add corners · {draft.length} pts{draft.length >= 3 ? ` · ${formatArea(draftArea)}` : ''}
          </Text>
          <View style={styles.row}>
            <Btn label="Undo" onPress={() => setDraftAndSend(draft.slice(0, -1))} />
            <Btn label="Clear" onPress={() => setDraftAndSend([])} />
            <Btn label="Cancel" onPress={() => setDraftAndSend(null)} />
            <Btn label="Finish" primary onPress={finishArea} />
          </View>
        </View>
      )}

      {/* bottom bar */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 8 }]}>
        <Btn
          big
          label={tracking ? '■ Stop' : '▶ Start'}
          color={tracking ? '#c4001a' : '#0a7d2c'}
          onPress={toggleTracking}
        />
        <Btn big label={draft ? 'Drawing…' : '⬠ Draw area'} active={!!draft} onPress={() => setDraftAndSend(draft ? null : [])} />
        <Btn
          big
          label={settings.baseLayer === 'sat' ? '🛰 Satellite' : '🗺 Map'}
          onPress={() => updateSettings({ baseLayer: settings.baseLayer === 'sat' ? 'osm' : 'sat' })}
        />
        <Btn big label="⚙ Settings" onPress={() => setShowSettings(true)} />
      </View>

      <Modal visible={showSettings} animationType="slide" onRequestClose={() => setShowSettings(false)}>
        <ScrollView contentContainerStyle={[styles.settings, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}>
          <Text style={styles.h1}>Settings</Text>

          <NumberSetting
            label="Coverage line width"
            unit="m"
            value={settings.strokeWidthM}
            min={0.5}
            max={10}
            step={0.5}
            onChange={(v) => updateSettings({ strokeWidthM: v })}
          />
          <NumberSetting
            label="Ignore fixes worse than"
            unit="m"
            value={settings.maxAccuracyM}
            min={3}
            max={100}
            step={1}
            onChange={(v) => updateSettings({ maxAccuracyM: v })}
          />
          <NumberSetting
            label="Minimum movement"
            unit="m"
            value={settings.minMoveM}
            min={0}
            max={10}
            step={0.5}
            onChange={(v) => updateSettings({ minMoveM: v })}
          />
          <ToggleRow label="Keep screen awake" value={settings.keepAwake} onChange={(v) => updateSettings({ keepAwake: v })} />
          <ToggleRow
            label={`Show past sessions (${past.length})`}
            value={settings.showPast}
            onChange={(v) => updateSettings({ showPast: v })}
          />

          <Text style={styles.h2}>Export</Text>
          <View style={styles.row}>
            <Btn label="Export GPX" onPress={() => doExport('gpx')} />
            <Btn label="Export GeoJSON" onPress={() => doExport('geojson')} />
          </View>

          <Text style={styles.h2}>Data</Text>
          <View style={styles.row}>
            <Btn label="New session" onPress={newSession} />
            <Btn label="Clear track" color="#c4001a" onPress={clearCurrent} />
          </View>
          <View style={styles.row}>
            <Btn
              label="Delete all areas"
              color="#c4001a"
              onPress={() => confirm('Delete all areas?', 'This removes every search area.', () => commitAreas([]))}
            />
          </View>
          <Text style={styles.help}>
            Tip: tap a purple area on the map to delete just that one. For reliable background logging, set Android
            battery usage for Search Tracker to "Unrestricted".
          </Text>

          <Btn big label="Done" primary onPress={() => setShowSettings(false)} />
        </ScrollView>
      </Modal>
    </View>
  );
}

// ---------- small UI pieces ----------
function Btn(p: {
  label: string;
  onPress: () => void;
  big?: boolean;
  primary?: boolean;
  active?: boolean;
  color?: string;
}) {
  const bg = p.color ?? (p.primary || p.active ? '#0a62d0' : '#ffffff');
  const fg = p.color || p.primary || p.active ? '#ffffff' : '#000000';
  return (
    <Pressable
      onPress={p.onPress}
      style={({ pressed }) => [styles.btn, p.big && styles.btnBig, { backgroundColor: bg, opacity: pressed ? 0.7 : 1 }]}
    >
      <Text style={[styles.btnText, p.big && styles.btnTextBig, { color: fg }]} numberOfLines={1} adjustsFontSizeToFit>
        {p.label}
      </Text>
    </Pressable>
  );
}

function NumberSetting(p: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(p.value));
  useEffect(() => setText(String(p.value)), [p.value]);
  const clamp = (v: number) => Math.min(p.max, Math.max(p.min, Math.round(v * 10) / 10));
  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (isNaN(v)) setText(String(p.value));
    else p.onChange(clamp(v));
  };
  return (
    <View style={styles.setting}>
      <Text style={styles.settingLabel}>
        {p.label} ({p.min}–{p.max} {p.unit})
      </Text>
      <View style={styles.row}>
        <Btn big label="−" onPress={() => p.onChange(clamp(p.value - p.step))} />
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          onEndEditing={commit}
          onSubmitEditing={commit}
          keyboardType="decimal-pad"
          selectTextOnFocus
        />
        <Text style={styles.unit}>{p.unit}</Text>
        <Btn big label="+" onPress={() => p.onChange(clamp(p.value + p.step))} />
      </View>
    </View>
  );
}

function ToggleRow(p: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable style={[styles.setting, styles.toggle]} onPress={() => p.onChange(!p.value)}>
      <Text style={styles.settingLabel}>{p.label}</Text>
      <Switch value={p.value} onValueChange={p.onChange} />
    </Pressable>
  );
}

const shadow = { elevation: 6, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } };

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#cfd8dc' },
  map: { flex: 1 },
  status: {
    position: 'absolute',
    left: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 2,
    borderColor: '#000',
    ...shadow,
  },
  statusText: { fontSize: 24, fontWeight: '800' },
  statusSub: { fontSize: 14, fontWeight: '600', color: '#000' },
  fab: {
    position: 'absolute',
    right: 12,
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow,
  },
  fabText: { fontSize: 38, color: '#0a62d0', fontWeight: '900', marginTop: -4 },
  drawBar: {
    position: 'absolute',
    left: 8,
    right: 8,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 10,
    borderWidth: 2,
    borderColor: '#d000ff',
    gap: 8,
    ...shadow,
  },
  drawInfo: { fontSize: 16, fontWeight: '700', color: '#000', textAlign: 'center' },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 6,
    paddingTop: 8,
    backgroundColor: '#f2f2f2',
    borderTopWidth: 2,
    borderColor: '#000',
  },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  btn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  btnBig: { minHeight: 68 },
  btnText: { fontSize: 16, fontWeight: '800' },
  btnTextBig: { fontSize: 17 },
  settings: { padding: 16, gap: 14, backgroundColor: '#fff' },
  h1: { fontSize: 30, fontWeight: '900', color: '#000' },
  h2: { fontSize: 20, fontWeight: '800', color: '#000', marginTop: 8 },
  setting: { gap: 8 },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 52 },
  settingLabel: { fontSize: 18, fontWeight: '700', color: '#000', flexShrink: 1 },
  input: {
    width: 90,
    height: 68,
    borderWidth: 2,
    borderColor: '#000',
    borderRadius: 12,
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
    color: '#000',
  },
  unit: { fontSize: 20, fontWeight: '700', color: '#000' },
  help: { fontSize: 15, color: '#222' },
});
