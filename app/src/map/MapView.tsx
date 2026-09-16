import { useEffect, useRef, useState } from 'react';
import { Map as MLMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
/**
 * MapLibre resolves its worker with `new URL('./maplibre-gl-worker.mjs',
 * import.meta.url)`, which after bundling points at a path that does not exist.
 *
 * `?worker&url` is what makes this work. The obvious `?url` copies the file
 * verbatim as an opaque asset — and MapLibre's worker is itself an ES module
 * that imports `./maplibre-gl-shared.mjs`, which then never gets emitted. The
 * worker 404s on its own import, MapLibre parses no source at all, and the map
 * renders nothing — not the basemap, and not our own GeoJSON layers, since
 * those are parsed in the worker too. `?worker&url` bundles the worker with its
 * dependencies and returns the URL of the result.
 */
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import circleOf from '@turf/circle';
import { featureCollection } from '@turf/helpers';
import type { FeatureCollection } from 'geojson';
import type { GameData } from '../data/load';
import type { Fix } from '../location/useLocation';
import type { LngLat, Station } from '../engine/types';
import type { ResolvedAsk } from '../engine/candidates';
import { LAYER_DEFS } from '../data/load';

setWorkerUrl(workerUrl);

const BASEMAP = 'https://tiles.openfreemap.org/styles/positron';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * MapLibre defaults to an "Open Sans Regular, Arial Unicode MS Regular" stack,
 * which the basemap's glyph server does not host — every label request 404'd
 * and the glyphs silently failed to draw. Match what the basemap itself uses.
 */
const LABEL_FONT = ['Noto Sans Regular'];

type Props = {
  data: GameData;
  aliveIds: Set<string>;
  resolved: ResolvedAsk[];
  hiddenOverlays: string[];
  visibleLayers: string[];
  /** The single "ruled out" polygon, or null when nothing is eliminated yet. */
  outOfPlay: any | null;
  mapLayers: { outOfPlay: boolean; zoneBuffers: boolean; stationDots: boolean };
  fix: Fix | null;
  pins: { start?: LngLat; end?: LngLat; seekers?: LngLat };
  hiderStation?: Station | null;
  onMapClick?: (ll: LngLat) => void;
  onStationClick?: (id: string, ll: LngLat) => void;
  /** Tap-and-hold, used to place a manual position. */
  onLongPress?: (ll: LngLat) => void;
  /** The hand-placed position, when manual location is on. */
  manualPoint?: LngLat | null;
  /** Measuring-tool drawing, prebuilt with its labels. */
  measureFc: FeatureCollection;
  /** Candidate regions from the plan, prebuilt in slot colours. */
  planFc: FeatureCollection;
};

/**
 * MapLibre needs both WebGL and web workers — it parses every source, including
 * our own GeoJSON layers, off the main thread. iOS Safari silently withholds
 * workers on an origin with a certificate error, which produced a blank grey
 * rectangle with no error anywhere. Check up front and say so.
 */
function mapBlocker(): string | null {
  try {
    const c = document.createElement('canvas');
    if (!(c.getContext('webgl2') ?? c.getContext('webgl'))) {
      return 'This browser has no WebGL, which the map needs to draw.';
    }
  } catch {
    return 'This browser refused to create a WebGL context.';
  }
  if (typeof Worker === 'undefined') {
    return 'This browser is blocking web workers, so the map cannot load its layers.';
  }
  return null;
}

export function MapView(props: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [blocked, setBlocked] = useState<string | null>(mapBlocker);

  // ---- init once
  useEffect(() => {
    if (!holder.current || map.current || blocked) return;
    let m: MLMap;
    try {
      m = new MLMap({
        container: holder.current,
        style: BASEMAP,
        bounds: props.data.bbox as [number, number, number, number],
        fitBoundsOptions: { padding: 24 },
        attributionControl: { compact: true },
      });
    } catch (e) {
      setBlocked(e instanceof Error ? e.message : 'The map failed to start.');
      return;
    }

    map.current = m;
    // Exposed for the verification harness; harmless in production.
    (window as any).__map = m;
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');

    /**
     * Install the game layers as soon as the *style* is parsed.
     *
     * The obvious hook is `load`, but that waits for the basemap's tiles,
     * sprites and glyphs. When those are slow or unreachable — a tunnel, a
     * captive portal, a blocked CDN — `load` never fires, and the player is
     * left with no zones, no stations and no shading at exactly the moment
     * they need them. `style.load` fires on the parsed style alone, and the
     * guard makes the handler safe to call from several events.
     */
    const install = () => {
      if (ready.current) return;
      // Not gated on isStyleLoaded(): that stays false while tiles are still
      // in flight, which is precisely the case this needs to survive. The
      // style-parsed events below are enough for addSource/addLayer to be safe.
      try {
        installLayers(m, latest.current.data);
        ready.current = true;
        redraw(m, latest.current);
        (window as any).__mapReady = true;
      } catch {
        // Style not parsed yet; a later event will retry.
      }
    };
    m.on('style.load', install);
    m.on('load', install);
    m.on('idle', install);

    /**
     * If the basemap itself cannot be fetched, fall back to a plain background
     * so the game board still draws. A grey rectangle with the right zones on
     * it is far more useful than nothing.
     */
    m.on('error', (e: any) => {
      const msg = String(e?.error?.message ?? '');
      if (ready.current || !/style|sprite|glyph|Failed to fetch/i.test(msg)) return;
      console.warn('Basemap unavailable, falling back to a blank board:', msg);
      m.setStyle({
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef2f7' } }],
      });
    });

    /**
     * Tap and hold to drop a manual point.
     *
     * `contextmenu` covers desktop right-click and most touch long-presses, but
     * iOS Safari is unreliable about synthesising it over a WebGL canvas — so
     * the touch timer below is the one that actually carries the feature on a
     * phone. A small movement threshold keeps a pan from registering as a hold.
     */
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdFrom: { x: number; y: number } | null = null;
    const cancelHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

    m.on('contextmenu', (e: any) => {
      cancelHold();
      latest.current.onLongPress?.([e.lngLat.lng, e.lngLat.lat]);
    });

    m.on('touchstart', (e: any) => {
      if (e.points?.length !== 1) { cancelHold(); return; }
      holdFrom = { x: e.point.x, y: e.point.y };
      cancelHold();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        latest.current.onLongPress?.([e.lngLat.lng, e.lngLat.lat]);
      }, 500);
    });
    m.on('touchmove', (e: any) => {
      if (!holdTimer || !holdFrom) return;
      if (Math.hypot(e.point.x - holdFrom.x, e.point.y - holdFrom.y) > 12) cancelHold();
    });
    m.on('touchend', cancelHold);
    m.on('touchcancel', cancelHold);
    m.on('dragstart', cancelHold);
    m.on('zoomstart', cancelHold);

    m.on('click', (e: MapMouseEvent) => {
      const hits = m.queryRenderedFeatures(e.point, { layers: ['stations-dot', 'stations-hit'] });
      const id = hits[0]?.properties?.id as string | undefined;
      const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (id && latest.current.onStationClick) latest.current.onStationClick(id, ll);
      else latest.current.onMapClick?.(ll);
    });

    return () => { m.remove(); map.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);

  /**
   * Redraw only when something that is actually drawn changes.
   *
   * An effect with no dependency array reruns on every render, which meant
   * rebuilding eight GeoJSON sources — including 276 zone polygons — on each
   * GPS tick. The primitives below are what the draw depends on; arrays are
   * joined so a new array with the same contents does not retrigger.
   */
  useEffect(() => {
    if (map.current && ready.current) redraw(map.current, latest.current);
  }, [
    props.data,
    props.aliveIds,
    props.resolved,
    props.hiddenOverlays.join(','),
    props.visibleLayers.join(','),
    props.outOfPlay,
    props.mapLayers.outOfPlay,
    props.mapLayers.zoneBuffers,
    props.mapLayers.stationDots,
    props.fix?.coords[0],
    props.fix?.coords[1],
    props.fix?.accuracyM,
    props.manualPoint?.join(','),
    props.pins.start?.join(','),
    props.pins.end?.join(','),
    // Omitting this meant placing the seekers' pin never repainted the map —
    // it only appeared later, by luck, when some other prop changed.
    props.pins.seekers?.join(','),
    props.hiderStation?.id,
    // Both are memoized upstream, so identity changes exactly when the drawing
    // does. Leaving either out means a measurement or a plan that never appears.
    props.measureFc,
    props.planFc,
  ]);

  if (blocked) {
    return (
      <div className="map blocked">
        <div>
          <b>The map can’t render on this browser.</b>
          <p className="small">{blocked}</p>
          <p className="small">
            On iPhone, Safari blocks workers on an address with a certificate
            warning — open the deployed <code>https://…pages.dev</code> URL
            instead of a <code>192.168.x.x</code> one.
          </p>
          <p className="small">
            The game still works — questions, answers and elimination all run
            without the map. Tap <b>?</b> above for details.
          </p>
        </div>
      </div>
    );
  }

  return <div ref={holder} className="map" />;
}

// --------------------------------------------------------------------------

function src(m: MLMap, id: string, data: any = EMPTY) {
  if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data });
}

function installLayers(m: MLMap, data: GameData) {
  src(m, 'boundary', featureCollection([data.boundary as any]));
  src(m, 'districts', data.districts);
  src(m, 'zones', data.zones);
  src(m, 'stations', EMPTY);
  src(m, 'overlays', EMPTY);
  src(m, 'outofplay', EMPTY);
  src(m, 'pois', EMPTY);
  src(m, 'voronoi', EMPTY);
  src(m, 'me', EMPTY);
  src(m, 'pins', EMPTY);
  src(m, 'hider', EMPTY);
  src(m, 'plan', EMPTY);
  src(m, 'measure', EMPTY);

  // Everything outside the board is not in play — dim it hard.
  m.addLayer({
    id: 'outside-mask',
    type: 'fill',
    source: 'boundary',
    paint: { 'fill-color': '#0b1020', 'fill-opacity': 0.06 },
  });
  m.addLayer({
    id: 'boundary-line',
    type: 'line',
    source: 'boundary',
    paint: { 'line-color': '#1f2937', 'line-width': 2, 'line-opacity': 0.75 },
  });

  m.addLayer({
    id: 'districts-line',
    type: 'line',
    source: 'districts',
    layout: { visibility: 'none' },
    paint: { 'line-color': '#7c3aed', 'line-width': 1.4, 'line-dasharray': [3, 2], 'line-opacity': 0.85 },
  });
  m.addLayer({
    id: 'districts-label',
    type: 'symbol',
    source: 'districts',
    layout: { visibility: 'none', 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 12 },
    paint: { 'text-color': '#6d28d9', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });

  /**
   * Everywhere the answers have ruled out, as one shape.
   *
   * Drawn before the zones so surviving ground stays bright and eliminated
   * ground is knocked back — the map should read at a glance, from arm's
   * length, while walking.
   */
  m.addLayer({
    id: 'outofplay-fill',
    type: 'fill',
    source: 'outofplay',
    paint: { 'fill-color': '#0f172a', 'fill-opacity': 0.42 },
  });
  m.addLayer({
    id: 'outofplay-line',
    type: 'line',
    source: 'outofplay',
    paint: { 'line-color': '#0f172a', 'line-width': 1, 'line-opacity': 0.5 },
  });

  // Zone circles: alive vs eliminated.
  m.addLayer({
    id: 'zones-dead',
    type: 'fill',
    source: 'zones',
    filter: ['==', ['get', 'alive'], false],
    paint: { 'fill-color': '#94a3b8', 'fill-opacity': 0.05 },
  });
  m.addLayer({
    id: 'zones-alive',
    type: 'fill',
    source: 'zones',
    filter: ['==', ['get', 'alive'], true],
    paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.14 },
  });
  m.addLayer({
    id: 'zones-alive-line',
    type: 'line',
    source: 'zones',
    filter: ['==', ['get', 'alive'], true],
    paint: { 'line-color': '#d97706', 'line-width': 1, 'line-opacity': 0.6 },
  });

  // Shaded answer overlays sit above the zones.
  m.addLayer({
    id: 'overlay-fill',
    type: 'fill',
    source: 'overlays',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 },
  });
  m.addLayer({
    id: 'overlay-line',
    type: 'line',
    source: 'overlays',
    paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.5 },
  });

  /**
   * Voronoi cells: outline plus a very light tint. A matching answer of "yes"
   * means the hider is somewhere inside the seeker's own cell, so seeing the
   * cell boundaries turns that answer from abstract into obvious.
   */
  m.addLayer({
    id: 'voronoi-fill',
    type: 'fill',
    source: 'voronoi',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.07 },
  });
  m.addLayer({
    id: 'voronoi-line',
    type: 'line',
    source: 'voronoi',
    paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.75 },
  });

  /**
   * Cell labels.
   *
   * The useful thing to read off the map is "which park's area am I in", so the
   * name belongs on the Voronoi cell rather than pinned to the point. MapLibre
   * places a polygon symbol at the cell's interior point, so the label lands in
   * the area it names.
   */
  m.addLayer({
    id: 'voronoi-label',
    type: 'symbol',
    source: 'voronoi',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': LABEL_FONT,
      'text-size': 11,
      'text-max-width': 8,
      'text-allow-overlap': false,
      'text-optional': true,
      'text-padding': 3,
      'symbol-placement': 'point',
    },
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': '#fff',
      'text-halo-width': 1.8,
    },
  });

  m.addLayer({
    id: 'pois',
    type: 'circle',
    source: 'pois',
    paint: {
      'circle-radius': 4,
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1,
    },
  });

  // Names for whichever POI layers are switched on.
  m.addLayer({
    id: 'pois-label',
    type: 'symbol',
    source: 'pois',
    filter: ['==', ['get', 'labelled'], true],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': LABEL_FONT,
      'text-size': 11,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-optional': true,
      'text-max-width': 9,
      // Keep labels off each other and off the dots; MapLibre drops the rest.
      'text-padding': 4,
    },
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': '#fff',
      'text-halo-width': 1.6,
    },
  });

  m.addLayer({
    id: 'stations-hit',
    type: 'circle',
    source: 'stations',
    paint: { 'circle-radius': 12, 'circle-color': 'transparent' },
  });
  m.addLayer({
    id: 'stations-dot',
    type: 'circle',
    source: 'stations',
    // Eliminated stations stay visible — you still want to see the transit
    // network — but knocked well back, so the surviving ones read first
    // against the out-of-play shading.
    paint: {
      'circle-radius': ['case', ['get', 'alive'], 5, 2.5],
      'circle-color': ['case', ['get', 'alive'], '#b45309', '#e2e8f0'],
      'circle-opacity': ['case', ['get', 'alive'], 1, 0.45],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': ['case', ['get', 'alive'], 1.5, 0],
    },
  });
  m.addLayer({
    id: 'stations-label',
    type: 'symbol',
    source: 'stations',
    minzoom: 13.5,
    filter: ['==', ['get', 'alive'], true],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': LABEL_FONT,
      'text-size': 11,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: { 'text-color': '#78350f', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });

  /**
   * Plan candidates: outlines only.
   *
   * A hypothesis must never render like an answer. The answered overlays are
   * filled; these are dashed outlines in their own palette, so a glance can
   * always tell what the board knows from what you are still considering.
   */
  m.addLayer({
    id: 'plan-line',
    type: 'line',
    source: 'plan',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 2.5,
      'line-dasharray': [2, 1.5],
      'line-opacity': 0.9,
    },
  });
  m.addLayer({
    id: 'plan-label',
    type: 'symbol',
    source: 'plan',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': LABEL_FONT,
      'text-size': 12,
      'text-optional': true,
      'text-allow-overlap': false,
      'symbol-placement': 'line',
      'symbol-spacing': 320,
    },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });

  /**
   * The measuring tool. Deliberately monochrome and unfilled: it is scratch
   * work, not game state, and it has to stay legible on top of everything else.
   */
  m.addLayer({
    id: 'measure-line',
    type: 'line',
    source: 'measure',
    filter: ['!=', ['get', 'draft'], true],
    paint: { 'line-color': '#111827', 'line-width': 2, 'line-opacity': 0.9 },
  });
  m.addLayer({
    id: 'measure-draft',
    type: 'line',
    source: 'measure',
    filter: ['==', ['get', 'draft'], true],
    paint: { 'line-color': '#111827', 'line-width': 2, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.8 },
  });
  m.addLayer({
    id: 'measure-vertex',
    type: 'circle',
    source: 'measure',
    filter: ['==', ['get', 'kind'], 'vertex'],
    paint: { 'circle-radius': 4, 'circle-color': '#111827', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 },
  });
  // Leg lengths ride along the leg they describe.
  m.addLayer({
    id: 'measure-seg-label',
    type: 'symbol',
    source: 'measure',
    filter: ['==', ['get', 'kind'], 'segment'],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': LABEL_FONT,
      'text-size': 11,
      'symbol-placement': 'line-center',
      'text-allow-overlap': false,
      'text-optional': true,
    },
    paint: { 'text-color': '#111827', 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  m.addLayer({
    id: 'measure-label',
    type: 'symbol',
    source: 'measure',
    filter: ['==', ['get', 'kind'], 'centre'],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': LABEL_FONT,
      'text-size': 12,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#111827', 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });

  // The hider's own claimed zone.
  m.addLayer({
    id: 'hider-zone',
    type: 'line',
    source: 'hider',
    paint: { 'line-color': '#059669', 'line-width': 2.5, 'line-dasharray': [2, 1] },
  });

  m.addLayer({
    id: 'me-accuracy',
    type: 'fill',
    source: 'me',
    filter: ['==', ['get', 'kind'], 'accuracy'],
    paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.12 },
  });
  m.addLayer({
    id: 'me-dot',
    type: 'circle',
    source: 'me',
    filter: ['==', ['get', 'kind'], 'dot'],
    paint: { 'circle-radius': 6, 'circle-color': '#2563eb', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
  // A hand-placed point is deliberately a different shape and colour from the
  // GPS dot — you should never mistake an assumption for a measurement.
  m.addLayer({
    id: 'me-manual',
    type: 'circle',
    source: 'me',
    filter: ['==', ['get', 'kind'], 'manual'],
    paint: {
      'circle-radius': 8,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#2563eb',
      'circle-stroke-width': 3,
    },
  });

  m.addLayer({
    id: 'pins',
    type: 'circle',
    source: 'pins',
    paint: {
      'circle-radius': 7,
      'circle-color': [
        'match', ['get', 'role'],
        'start', '#0ea5e9',
        'seekers', '#7c3aed',
        '#ef4444',
      ],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2,
    },
  });
  m.addLayer({
    id: 'pins-label',
    type: 'symbol',
    source: 'pins',
    layout: { 'text-field': ['get', 'role'], 'text-font': LABEL_FONT, 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
    paint: { 'text-color': '#0f172a', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });
}

const OVERLAY_COLORS = ['#dc2626', '#7c3aed', '#0891b2', '#ea580c', '#65a30d', '#db2777'];

/**
 * A layer's colour follows the layer, not its position in the visible list —
 * otherwise turning one layer off would recolour every other one.
 */
function colorFor(key: string, visible: string[]): string {
  const bases = visible.map((k) => (k.endsWith(':voronoi') ? k.slice(0, -':voronoi'.length) : k));
  const order = [...new Set(bases)];
  const i = order.indexOf(key);
  return OVERLAY_COLORS[(i < 0 ? 0 : i) % OVERLAY_COLORS.length];
}

function redraw(m: MLMap, p: Props) {
  // Zones + stations carry an `alive` flag the style keys off.
  const zones: FeatureCollection = {
    type: 'FeatureCollection',
    features: p.data.zones.features.map((f) => ({
      ...f,
      properties: { ...f.properties, alive: p.aliveIds.has(f.properties?.id) },
    })),
  };
  (m.getSource('zones') as GeoJSONSource)?.setData(zones);
  // Draw counters, for the verification harness only.
  (window as any).__drawn = { zones: zones.features.length, alive: p.aliveIds.size };

  const stations: FeatureCollection = {
    type: 'FeatureCollection',
    features: p.data.stations.map((s) => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name, alive: p.aliveIds.has(s.id) },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })),
  };
  (m.getSource('stations') as GeoJSONSource)?.setData(stations);
  (window as any).__drawn.stations = stations.features.length;

  // One shaded polygon per answered question. The *eliminated* side is drawn,
  // since that is what "shade out where the hider is not" means.
  const overlays: FeatureCollection = { type: 'FeatureCollection', features: [] };
  p.resolved.forEach((r, i) => {
    if (!r.region || p.hiddenOverlays.includes(r.entry.id)) return;
    // For an inverted answer the yes-region itself is the excluded area.
    if (!r.inverted) return;
    overlays.features.push({
      ...(r.region as any),
      properties: { color: OVERLAY_COLORS[i % OVERLAY_COLORS.length], askId: r.entry.id },
    });
  });
  (m.getSource('overlays') as GeoJSONSource)?.setData(overlays);

  // Visible POI layers.
  const pois: FeatureCollection = { type: 'FeatureCollection', features: [] };
  p.visibleLayers.forEach((key) => {
    if (key.endsWith(':voronoi')) return;
    const layer = p.data.layers[key];
    if (!layer) return;
    const color = colorFor(key, p.visibleLayers);
    // If this layer's cells are on, the cell carries the name — labelling the
    // point too would print every name twice.
    const labelled = !p.visibleLayers.includes(`${key}:voronoi`);
    for (const f of layer.features) {
      if (f.geometry?.type !== 'Point') continue;
      pois.features.push({ ...f, properties: { ...f.properties, color, labelled } });
    }
  });
  (m.getSource('pois') as GeoJSONSource)?.setData(pois);

  (m.getSource('outofplay') as GeoJSONSource)?.setData(
    p.outOfPlay ? { type: 'FeatureCollection', features: [p.outOfPlay] } : EMPTY,
  );

  const vis = (on: boolean) => (on ? 'visible' : 'none');
  for (const id of ['outofplay-fill', 'outofplay-line']) {
    m.setLayoutProperty(id, 'visibility', vis(p.mapLayers.outOfPlay));
  }
  for (const id of ['zones-dead', 'zones-alive', 'zones-alive-line']) {
    m.setLayoutProperty(id, 'visibility', vis(p.mapLayers.zoneBuffers));
  }
  for (const id of ['stations-dot', 'stations-label', 'stations-hit']) {
    m.setLayoutProperty(id, 'visibility', vis(p.mapLayers.stationDots));
  }

  // Voronoi cells for any layer whose "<key>:voronoi" toggle is on. They share
  // their parent layer's colour so cells and points read as one thing.
  const cells: FeatureCollection = { type: 'FeatureCollection', features: [] };
  p.visibleLayers.forEach((key) => {
    if (!key.endsWith(':voronoi')) return;
    const base = key.slice(0, -':voronoi'.length);
    const fc = p.data.voronoi[base];
    if (!fc) return;
    const color = colorFor(base, p.visibleLayers);
    for (const f of fc.features) {
      cells.features.push({ ...f, properties: { ...f.properties, color } });
    }
  });
  (m.getSource('voronoi') as GeoJSONSource)?.setData(cells);

  const showDistricts = p.visibleLayers.includes('districts') ? 'visible' : 'none';
  m.setLayoutProperty('districts-line', 'visibility', showDistricts);
  // If the Voronoi cells are on too, they carry the name — labelling the
  // outline as well would print every district name twice.
  const districtsLabelled = showDistricts === 'visible' && !p.visibleLayers.includes('districts:voronoi');
  m.setLayoutProperty('districts-label', 'visibility', districtsLabelled ? 'visible' : 'none');

  // GPS dot + accuracy ring.
  const me: FeatureCollection = { type: 'FeatureCollection', features: [] };
  if (p.manualPoint) {
    me.features.push({
      type: 'Feature',
      properties: { kind: 'manual' },
      geometry: { type: 'Point', coordinates: p.manualPoint },
    });
  }
  if (p.fix && !p.manualPoint) {
    me.features.push({
      type: 'Feature',
      properties: { kind: 'dot' },
      geometry: { type: 'Point', coordinates: p.fix.coords },
    });
    if (p.fix.accuracyM > 5) {
      const ring = circleOf(p.fix.coords, p.fix.accuracyM, { steps: 48, units: 'meters' });
      me.features.push({ ...ring, properties: { kind: 'accuracy' } } as any);
    }
  }
  (m.getSource('me') as GeoJSONSource)?.setData(me);

  const pins: FeatureCollection = { type: 'FeatureCollection', features: [] };
  if (p.pins.start) pins.features.push(pinAt(p.pins.start, 'start'));
  if (p.pins.end) pins.features.push(pinAt(p.pins.end, 'end'));
  if (p.pins.seekers) pins.features.push(pinAt(p.pins.seekers, 'seekers'));
  (m.getSource('pins') as GeoJSONSource)?.setData(pins);

  (m.getSource('plan') as GeoJSONSource)?.setData(p.planFc);
  (m.getSource('measure') as GeoJSONSource)?.setData(p.measureFc);

  const hider: FeatureCollection = { type: 'FeatureCollection', features: [] };
  if (p.hiderStation) {
    hider.features.push(
      circleOf([p.hiderStation.lon, p.hiderStation.lat], 500, { steps: 64, units: 'meters' }) as any,
    );
  }
  (m.getSource('hider') as GeoJSONSource)?.setData(hider);
}

function pinAt(ll: LngLat, role: 'start' | 'end' | 'seekers') {
  return { type: 'Feature' as const, properties: { role }, geometry: { type: 'Point' as const, coordinates: ll } };
}

export { LAYER_DEFS };
