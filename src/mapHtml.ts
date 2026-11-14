// Leaflet map page rendered inside react-native-webview. Leaflet is inlined (no CDN, no API keys).
// RN -> page:  window.handleMsg({type, ...})      page -> RN:  ReactNativeWebView.postMessage(JSON)
import { LEAFLET_CSS, LEAFLET_JS } from './leafletAssets';

const APP_JS = String.raw`
(function () {
  function post(m) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(m)); }

  var map = L.map('map', { zoomControl: false, maxZoom: 22, attributionControl: true }).setView([20, 0], 3);
  ['areas', 'past', 'track', 'draft', 'me'].forEach(function (n, i) {
    map.createPane(n).style.zIndex = 400 + i * 10;
  });
  var R = {};
  ['areas', 'past', 'track', 'draft', 'me'].forEach(function (n) { R[n] = L.canvas({ pane: n, padding: 0.5 }); });

  var layers = {
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19, maxZoom: 22, attribution: '&copy; OpenStreetMap contributors' }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: 22, attribution: 'Imagery &copy; Esri' })
  };
  var base = null;
  function setBase(k) {
    if (base) map.removeLayer(base);
    base = layers[k] || layers.osm;
    base.addTo(map);
  }

  // ---- coverage track: width in real meters ----
  var widthM = 2;
  var CHUNK = 25; // split into short polylines so overlapping passes darken (60% opacity)
  var TRACK = { color: '#ff2d55', opacity: 0.6 };
  var PAST = { color: '#ff9500', opacity: 0.45 };
  var trackLines = [], pastLines = [];
  var cur = null; // { seg, line, n }
  var showPast = true;

  function weightPx() {
    var lat = map.getCenter().lat;
    var mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, map.getZoom());
    return Math.max(1, widthM / mpp);
  }
  function lineOpts(style, pane) {
    return { renderer: R[pane], pane: pane, color: style.color, opacity: style.opacity, weight: weightPx(),
             lineCap: 'round', lineJoin: 'round', interactive: false, smoothFactor: 0 };
  }
  function restyle() {
    var w = weightPx();
    for (var i = 0; i < trackLines.length; i++) trackLines[i].setStyle({ weight: w });
    for (var j = 0; j < pastLines.length; j++) pastLines[j].setStyle({ weight: w });
  }
  map.on('zoom zoomend moveend', restyle);

  function addSegments(segs, style, pane, list) {
    segs.forEach(function (seg) {
      if (seg.length === 1) seg = [seg[0], seg[0]]; // a single fix still shows as a dot
      for (var i = 0; i < seg.length - 1; i += CHUNK) {
        list.push(L.polyline(seg.slice(i, i + CHUNK + 1), lineOpts(style, pane)).addTo(map));
      }
    });
  }
  function setTrack(points) { // points: [lat, lon, acc, t, seg][]
    trackLines.forEach(function (l) { map.removeLayer(l); });
    trackLines = []; cur = null;
    appendPoints(points);
  }
  function appendPoints(points) {
    points.forEach(function (p) {
      var ll = [p[0], p[1]];
      if (!cur || cur.seg !== p[4]) {
        cur = { seg: p[4], line: L.polyline([ll, ll], lineOpts(TRACK, 'track')).addTo(map), n: 1 };
        trackLines.push(cur.line);
      } else if (cur.n >= CHUNK) {
        var lls = cur.line.getLatLngs(), prev = lls[lls.length - 1];
        cur.line = L.polyline([prev, ll], lineOpts(TRACK, 'track')).addTo(map);
        cur.n = 1;
        trackLines.push(cur.line);
      } else {
        cur.line.addLatLng(ll); // first point is doubled so a lone fix still renders as a dot
        cur.n++;
      }
    });
  }
  function setPast(segs) {
    pastLines.forEach(function (l) { map.removeLayer(l); });
    pastLines = [];
    if (showPast) addSegments(segs, PAST, 'past', pastLines);
  }

  // ---- search areas ----
  var drawMode = false;
  var areaLayers = [];
  function setAreas(areas) { // [{id, coords, label}]
    areaLayers.forEach(function (l) { map.removeLayer(l); });
    areaLayers = areas.map(function (a) {
      var poly = L.polygon(a.coords, { renderer: R.areas, pane: 'areas', color: '#d000ff', weight: 4,
        opacity: 1, fillColor: '#d000ff', fillOpacity: 0.08 }).addTo(map);
      poly.bindTooltip(a.label, { permanent: true, direction: 'center', className: 'area-label' });
      poly.on('click', function (e) {
        if (drawMode) return; // let the map handle it as a vertex tap
        L.DomEvent.stop(e);
        post({ type: 'areaTap', id: a.id });
      });
      return poly;
    });
  }
  var draftLine = null, draftDots = [];
  function setDraft(coords) {
    if (draftLine) map.removeLayer(draftLine);
    draftDots.forEach(function (d) { map.removeLayer(d); });
    draftDots = []; draftLine = null;
    if (!coords.length) return;
    var ring = coords.length > 2 ? coords.concat([coords[0]]) : coords;
    draftLine = L.polyline(ring, { renderer: R.draft, pane: 'draft', color: '#d000ff', weight: 3, dashArray: '8 6', interactive: false }).addTo(map);
    draftDots = coords.map(function (c, i) {
      return L.circleMarker(c, { renderer: R.draft, pane: 'draft', radius: i === 0 ? 9 : 7, color: '#fff', weight: 2,
        fillColor: '#d000ff', fillOpacity: 1, interactive: false }).addTo(map);
    });
  }
  map.on('click', function (e) {
    if (drawMode) post({ type: 'tap', lat: e.latlng.lat, lng: e.latlng.lng });
  });

  // ---- me ----
  var accCircle = null, meDot = null, haveView = false;
  function setMe(m) {
    var ll = [m.lat, m.lng];
    if (!meDot) {
      accCircle = L.circle(ll, { renderer: R.me, pane: 'me', radius: m.acc, color: '#0a84ff', weight: 1,
        fillColor: '#0a84ff', fillOpacity: 0.15, interactive: false }).addTo(map);
      meDot = L.circleMarker(ll, { renderer: R.me, pane: 'me', radius: 9, color: '#fff', weight: 3,
        fillColor: '#0a84ff', fillOpacity: 1, interactive: false }).addTo(map);
    } else {
      accCircle.setLatLng(ll); accCircle.setRadius(m.acc); meDot.setLatLng(ll);
    }
    if (!haveView) { haveView = true; map.setView(ll, 18); }
  }

  window.handleMsg = function (m) {
    switch (m.type) {
      case 'init':
        setBase(m.base); widthM = m.width; showPast = m.showPast;
        setAreas(m.areas); setPast(m.past); setTrack(m.track);
        if (m.track.length) {
          haveView = true;
          map.fitBounds(L.latLngBounds(m.track.map(function (p) { return [p[0], p[1]]; })), { maxZoom: 19, padding: [40, 40] });
        }
        break;
      case 'base': setBase(m.base); break;
      case 'width': widthM = m.width; restyle(); break;
      case 'track': setTrack(m.track); break;
      case 'append': appendPoints(m.points); break;
      case 'past': showPast = m.showPast; setPast(m.past); break;
      case 'areas': setAreas(m.areas); break;
      case 'draft': setDraft(m.coords); break;
      case 'draw': drawMode = m.on; break;
      case 'me': setMe(m); break;
      case 'center': if (meDot) map.setView(meDot.getLatLng(), Math.max(map.getZoom(), 18)); else post({ type: 'noFix' }); break;
    }
  };
  post({ type: 'ready' });
})();
`;

export const MAP_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>${LEAFLET_CSS}
html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: #cfd8dc; }
.area-label { background: #fff; color: #000; border: 2px solid #d000ff; font: bold 13px sans-serif; padding: 2px 6px; box-shadow: none; }
.area-label:before { display: none; }
.leaflet-control-attribution { font-size: 9px; }
</style>
</head><body>
<div id="map"></div>
<script>${LEAFLET_JS.replace(/<\/script/gi, '<\\/script')}</script>
<script>${APP_JS}</script>
</body></html>`;
