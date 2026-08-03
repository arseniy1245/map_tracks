import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

const baseRouteModules = import.meta.glob('./assets/base_routes/*.{gpx,fit,GPX,FIT}', {
  eager: true,
  import: 'default',
  query: '?url',
});
const routeSourceId = 'uploaded-routes';
const homeVeilSourceId = 'home-map-veil-source';
const homeVeilLayerId = 'home-map-veil';
const routeSolidLayerId = 'route-lines-solid';
const routeDashedLayerId = 'route-lines-dashed';
const unsortedGroupType = 'unsorted';
const unsortedGroupLabel = 'Unsorted';
const colors = ['#2f3432', '#e4572e', '#3f7cac', '#a23e48', '#2e933c', '#7b2cbf', '#5f6f89', '#006d77'];
const extendedColors = ['#1f2937', '#475569', '#0f766e', '#14b8a6', '#2563eb', '#38bdf8', '#9333ea', '#c084fc', '#be123c', '#f43f5e', '#b45309', '#f97316', '#ca8a04', '#eab308', '#4d7c0f', '#84cc16'];
const grayscaleColors = ['#000000', '#242424', '#444444', '#666666', '#888888', '#aaaaaa', '#c6c6c6', '#e2e2e2'];
const focusedRouteMutedColor = '#b4b8b5';
const baseRouteOptions = Object.entries(baseRouteModules)
  .map(([filePath, url]) => {
    const fileName = filePath.split('/').pop();

    return {
      id: filePath,
      name: trimExtension(fileName).replaceAll('_', ' '),
      fileName,
      url,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));
const basemaps = {
  osm: {
    label: 'OSM',
    style: {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '&copy; OpenStreetMap contributors',
        },
      },
      layers: [
        {
          id: 'osm',
          type: 'raster',
          source: 'osm',
        },
      ],
    },
  },
  positron: {
    label: 'Positron',
    style: 'https://tiles.openfreemap.org/styles/positron',
  },
  colorful: {
    label: 'Colorful',
    style: 'https://tiles.versatiles.org/assets/styles/colorful/style.json',
  },
  satellite: {
    label: 'Satellite',
    style: {
      version: 8,
      sources: {
        satellite: {
          type: 'raster',
          tiles: [
            'https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
            'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
            'https://mt2.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
            'https://mt3.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
          ],
          tileSize: 256,
        },
        terrarium: {
          type: 'raster-dem',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          tileSize: 256,
          encoding: 'terrarium',
        },
      },
      layers: [
        {
          id: 'satellite',
          type: 'raster',
          source: 'satellite',
        },
      ],
      terrain: { source: 'terrarium', exaggeration: 1.5 },
    },
  },
};

const calendarWeekdays = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const calendarMonths = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const state = {
  routes: [],
  groupSettings: {},
  selectedId: null,
  focusedRouteId: null,
  dataUpdateFrame: null,
  openMenuRouteId: null,
  openMenuGroupType: null,
  openMenuAnchor: null,
  basemap: 'colorful',
  layersCollapsed: false,
  routesRenderPending: false,
};

const elements = {
  app: document.querySelector('#app'),
  sidebar: document.querySelector('#layers-panel'),
  input: document.querySelector('#file-input'),
  mergeInput: document.querySelector('#merge-input'),
  dropZone: document.querySelector('#drop-zone'),
  mergeZone: document.querySelector('#merge-zone'),
  list: document.querySelector('#route-list'),
  summary: document.querySelector('#route-summary'),
  fitAll: document.querySelector('#fit-all'),
  toggleLayers: document.querySelector('#toggle-layers'),
  groupAdd: document.querySelector('#add-group'),
  mapShell: document.querySelector('.map-shell'),
  openMap: document.querySelector('#open-map'),
  zoomIn: document.querySelector('#zoom-in'),
  zoomOut: document.querySelector('#zoom-out'),
  resetNorth: document.querySelector('#reset-north'),
  basemapButtons: [...document.querySelectorAll('[data-basemap]')],
};

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(state.basemap),
  center: [37.6173, 55.7558],
  zoom: 11,
  maxPitch: 65,
  antialias: false,
});

map.on('load', async () => {
  ensureRouteLayer();
  await loadStoredRoutes();
});

map.on('style.load', () => {
  ensureRouteLayer();
  scheduleRoutesRender();
});

map.on('styledata', () => {
  if (map.isStyleLoaded() && !map.getSource(routeSourceId)) {
    ensureRouteLayer();
    scheduleRoutesRender();
  }
});

map.on('idle', () => {
  if (state.routesRenderPending) {
    scheduleRoutesRender();
  }
});

map.on('rotate', updateNorthButton);
map.on('pitch', updateNorthButton);

function ensureRouteLayer() {
  if (!map.isStyleLoaded()) {
    return;
  }

  if (!map.getSource(routeSourceId)) {
    map.addSource(routeSourceId, routeSourceDefinition());
  }

  if (!map.getSource(homeVeilSourceId)) {
    map.addSource(homeVeilSourceId, homeVeilSourceDefinition());
  }

  if (!map.getLayer(homeVeilLayerId)) {
    map.addLayer(homeVeilLayerDefinition(), map.getLayer(routeSolidLayerId) ? routeSolidLayerId : undefined);
  }

  if (!map.getLayer(routeSolidLayerId)) {
    map.addLayer(routeSolidLayerDefinition());
  }

  if (!map.getLayer(routeDashedLayerId)) {
    map.addLayer(routeDashedLayerDefinition());
  }

  applyMapModePaint();
}

function routeSourceDefinition(data = emptyCollection()) {
  return {
    type: 'geojson',
    data,
    promoteId: 'id',
    lineMetrics: false,
  };
}

function homeVeilSourceDefinition() {
  return {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-180, -85],
          [180, -85],
          [180, 85],
          [-180, 85],
          [-180, -85],
        ]],
      },
      properties: {},
    },
  };
}

function homeVeilLayerDefinition() {
  return {
    id: homeVeilLayerId,
    type: 'fill',
    source: homeVeilSourceId,
    paint: {
      'fill-color': '#ffffff',
      'fill-opacity': 0,
    },
  };
}

function routeSolidLayerDefinition() {
  return {
    id: routeSolidLayerId,
    type: 'line',
    source: routeSourceId,
    filter: ['!=', ['get', 'isDashed'], true],
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['get', 'lineWidthPx'],
      'line-opacity': ['case', ['==', ['get', 'isSelected'], true], 1, 0.78],
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-sort-key': ['get', 'sortKey'],
    },
  };
}

function routeDashedLayerDefinition() {
  return {
    id: routeDashedLayerId,
    type: 'line',
    source: routeSourceId,
    filter: ['==', ['get', 'isDashed'], true],
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['get', 'lineWidthPx'],
      'line-opacity': ['case', ['==', ['get', 'isSelected'], true], 1, 0.78],
      'line-dasharray': [3.4, 1.6],
    },
    layout: {
      'line-cap': 'butt',
      'line-join': 'round',
      'line-sort-key': ['get', 'sortKey'],
    },
  };
}

elements.input.addEventListener('change', (event) => {
  handleFiles([...event.target.files]);
  event.target.value = '';
});

elements.mergeInput.addEventListener('change', (event) => {
  handleMergeFiles([...event.target.files]);
  event.target.value = '';
});

elements.dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.dropZone.classList.add('is-dragging');
});

elements.dropZone.addEventListener('dragleave', () => {
  elements.dropZone.classList.remove('is-dragging');
});

elements.dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove('is-dragging');
  handleFiles([...event.dataTransfer.files]);
});

elements.fitAll?.addEventListener('click', fitAllRoutes);
elements.toggleLayers.addEventListener('click', toggleLayersPanel);
elements.groupAdd.addEventListener('click', (event) => {
  event.stopPropagation();
  openCreateGroupMenu(elements.groupAdd);
});
elements.basemapButtons.forEach((button) => {
  button.addEventListener('click', () => setBasemap(button.dataset.basemap));
});
elements.zoomIn.addEventListener('click', () => map.zoomIn({ duration: 280 }));
elements.zoomOut.addEventListener('click', () => map.zoomOut({ duration: 280 }));
elements.resetNorth.addEventListener('click', () => {
  map.easeTo({ bearing: 0, pitch: 0, duration: 360 });
});
elements.openMap.addEventListener('click', enterMapMode);
initTooltips();
document.addEventListener('click', (event) => {
  const menu = document.querySelector('.floating-menu');
  const clickedInsideMenu = menu?.contains(event.target);
  const clickedTrigger = event.target.closest?.('.route-menu-trigger, .summary-menu-trigger, .group-add-button');

  if (!clickedInsideMenu && !clickedTrigger) {
    closeFloatingMenu();
  }
});
window.addEventListener('resize', positionFloatingMenu);
elements.list.addEventListener('scroll', positionFloatingMenu);

function initTooltips() {
  const tooltip = document.createElement('div');
  let activeTarget = null;

  tooltip.className = 'site-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  document.body.append(tooltip);

  const showTooltip = (target) => {
    const text = target.dataset.tooltip;

    if (!text) {
      return;
    }

    activeTarget = target;
    tooltip.textContent = text;
    tooltip.classList.add('is-visible');
    positionTooltip();
  };

  const hideTooltip = () => {
    activeTarget = null;
    tooltip.classList.remove('is-visible');
  };

  const positionTooltip = () => {
    if (!activeTarget || !document.body.contains(activeTarget)) {
      hideTooltip();
      return;
    }

    const rect = activeTarget.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const gap = 8;
    const viewportGap = 10;
    const hasRoomAbove = rect.top >= tooltipRect.height + gap + viewportGap;
    const preferredTop = hasRoomAbove ? rect.top - tooltipRect.height - gap : rect.bottom + gap;
    const preferredLeft = rect.left + rect.width / 2 - tooltipRect.width / 2;
    const left = Math.min(
      Math.max(viewportGap, preferredLeft),
      window.innerWidth - tooltipRect.width - viewportGap,
    );
    const top = Math.min(
      Math.max(viewportGap, preferredTop),
      window.innerHeight - tooltipRect.height - viewportGap,
    );

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.dataset.placement = hasRoomAbove ? 'top' : 'bottom';
  };

  document.addEventListener('pointerover', (event) => {
    const target = event.target.closest?.('[data-tooltip]');

    if (target) {
      showTooltip(target);
    }
  });

  document.addEventListener('pointerout', (event) => {
    if (activeTarget && !activeTarget.contains(event.relatedTarget)) {
      hideTooltip();
    }
  });

  document.addEventListener('focusin', (event) => {
    const target = event.target.closest?.('[data-tooltip]');

    if (target) {
      showTooltip(target);
    }
  });

  document.addEventListener('focusout', hideTooltip);
  window.addEventListener('resize', positionTooltip);
  window.addEventListener('scroll', positionTooltip, true);
}

function enterMapMode() {
  if (!elements.app.classList.contains('is-home')) {
    return;
  }

  elements.app.classList.remove('is-home');
  elements.app.classList.add('is-map');
  closeFloatingMenu();
  requestAnimationFrame(() => {
    map.resize();
    applyMapModePaint();
    scheduleRoutesRender();
  });
}

function toggleLayersPanel() {
  setLayersPanelCollapsed(!state.layersCollapsed);
}

function setLayersPanelCollapsed(collapsed) {
  state.layersCollapsed = collapsed;
  elements.app.classList.toggle('is-layers-collapsed', collapsed);
  elements.toggleLayers.setAttribute('aria-expanded', String(!collapsed));
  elements.toggleLayers.setAttribute('aria-label', collapsed ? 'Expand layers panel' : 'Collapse layers panel');
  elements.toggleLayers.dataset.tooltip = collapsed ? 'Expand layers' : 'Collapse layers';
  closeFloatingMenu();

  requestAnimationFrame(() => {
    map.resize();
  });
}

function updateNorthButton() {
  const bearing = map.getBearing();
  const pitch = map.getPitch();
  elements.resetNorth.style.setProperty('--map-bearing', `${-bearing}deg`);
  elements.resetNorth.classList.toggle('is-active', Math.abs(bearing) > 0.5 || pitch > 0.5);
}

function applyMapModePaint() {
  if (!map.isStyleLoaded()) {
    return;
  }

  const isHome = elements.app.classList.contains('is-home');
  if (map.getLayer(homeVeilLayerId)) {
    map.setPaintProperty(homeVeilLayerId, 'fill-opacity', isHome ? 0.88 : 0);
  }

  [routeSolidLayerId, routeDashedLayerId].forEach((layerId) => {
    if (!map.getLayer(layerId)) {
      return;
    }

    map.setPaintProperty(layerId, 'line-color', isHome ? '#2f3432' : ['get', 'color']);
    map.setPaintProperty(
      layerId,
      'line-opacity',
      isHome ? 0.96 : ['case', ['==', ['get', 'isSelected'], true], 1, 0.78],
    );
  });
}

function setBasemap(name) {
  if (!basemaps[name] || state.basemap === name) {
    return;
  }

  state.basemap = name;
  state.routesRenderPending = true;
  updateBasemapButtons();
  map.setStyle(basemapStyle(name), {
    transformStyle: injectRouteOverlayIntoStyle,
  });
}

function basemapStyle(name) {
  const style = basemaps[name]?.style || basemaps.osm.style;
  return typeof style === 'string' ? style : structuredClone(style);
}

function injectRouteOverlayIntoStyle(previousStyle, nextStyle) {
  const style = structuredClone(nextStyle);
  const overlayLayerIds = new Set([homeVeilLayerId, routeSolidLayerId, routeDashedLayerId]);

  style.sources = {
    ...(style.sources || {}),
    [homeVeilSourceId]: homeVeilSourceDefinition(),
    [routeSourceId]: routeSourceDefinition(currentRouteFeatureCollection()),
  };

  style.layers = [
    ...(style.layers || []).filter((layer) => !overlayLayerIds.has(layer.id)),
    homeVeilLayerDefinition(),
    routeSolidLayerDefinition(),
    routeDashedLayerDefinition(),
  ];

  return style;
}

function updateBasemapButtons() {
  elements.basemapButtons.forEach((button) => {
    const isActive = button.dataset.basemap === state.basemap;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

async function loadStoredRoutes() {
  try {
    const [routes, groupSettings] = await Promise.all([
      api('/api/routes'),
      api('/api/group-settings'),
    ]);
    state.groupSettings = groupSettings || {};
    state.routes = routes.map(normalizeSavedRoute);
    state.selectedId = state.routes.find((route) => route.visible)?.id || state.routes[0]?.id || null;
    await pruneEmptyRouteGroups();
    scheduleRoutesRender();
    renderSidebar();

  } catch (error) {
    console.error(error);
    scheduleRoutesRender();
  }
}

async function handleFiles(files) {
  const routeFiles = files.filter((file) => /\.(gpx|fit)$/i.test(file.name));

  if (!routeFiles.length) {
    return;
  }

  const parsed = await Promise.allSettled(routeFiles.map(uploadRouteFile));
  const accepted = [];
  const rejected = [];

  parsed.forEach((result) => {
    if (result.status === 'fulfilled') {
      accepted.push(result.value);
    } else {
      rejected.push(result.reason);
      console.error(result.reason);
    }
  });

  state.routes.push(...accepted);
  if (!state.selectedId && accepted[0]) {
    state.selectedId = accepted[0].id;
  }

  scheduleRoutesRender();
  renderSidebar();

  if (accepted.length) {
    fitAllRoutes();
  }

  if (rejected.length) {
    alert(`Upload failed: ${rejected.map((error) => error.message || String(error)).join('\n')}`);
  }

}

async function uploadRouteFile(file) {
  const parsedRoute = await parseRouteFile(file);
  const form = new FormData();
  form.append('route', JSON.stringify(parsedRoute));
  form.append('file', file, file.name);

  const savedRoute = await api('/api/routes', {
    method: 'POST',
    body: form,
  });

  return normalizeSavedRoute(savedRoute);
}

async function handleMergeFiles(files) {
  const routeFiles = files.filter((file) => /\.(gpx|fit)$/i.test(file.name));

  if (routeFiles.length < 2) {
    return;
  }

  try {
    const parsedFiles = orderParsedRouteFiles(await Promise.all(routeFiles.map(parseRouteSegmentsFile)));
    const mergedRoute = buildMergedRoute(parsedFiles);
    const gpx = routeToGpx(mergedRoute.name, parsedFiles.flatMap((item) => item.segments));
    const form = new FormData();

    form.append('route', JSON.stringify(mergedRoute));
    form.append('file', new File([gpx], `${mergedRoute.name}.gpx`, { type: 'application/gpx+xml' }));

    const savedRoute = await api('/api/routes', {
      method: 'POST',
      body: form,
    });
    const route = normalizeSavedRoute(savedRoute);

    state.routes.push(route);
    state.selectedId = route.id;
    scheduleRoutesRender();
    renderSidebar();
    fitBounds(route.bounds);
  } catch (error) {
    console.error(error);
  }
}

async function mergeRouteWithBaseRoutes(routeId, menu) {
  const route = state.routes.find((item) => item.id === routeId);
  const selectedBaseRoutes = [...menu.querySelectorAll('.base-route-option input:checked')]
    .map((input) => baseRouteOptions.find((baseRoute) => baseRoute.id === input.value))
    .filter(Boolean);

  if (!route || !selectedBaseRoutes.length) {
    return;
  }

  const action = menu.querySelector('[data-base-route-merge]');
  action.disabled = true;

  try {
    const parsedRoutes = await Promise.all([
      parseStoredRouteSegments(route),
      ...selectedBaseRoutes.map(parseBaseRouteSegments),
    ]);
    const segments = parsedRoutes.flatMap((item) => item.segments);
    const mergedRoute = buildRouteFromSegments({
      id: route.id,
      name: route.name,
      color: route.color || colors[state.routes.length % colors.length],
      fileType: 'GPX',
      originalFileName: `${route.name}.gpx`,
      routeDate: route.routeDate,
      routeType: routeGroupType(route),
      segments,
    });
    mergedRoute.visible = route.visible !== false;
    mergedRoute.uploadedAt = route.uploadedAt || mergedRoute.uploadedAt;
    mergedRoute.storedFileName = route.storedFileName;
    mergedRoute.downloadUrl = route.downloadUrl;
    mergedRoute.geometryFile = route.geometryFile;

    const gpx = routeToGpx(mergedRoute.name, segments);
    const form = new FormData();

    form.append('route', JSON.stringify(mergedRoute));
    form.append('file', new File([gpx], `${mergedRoute.name}.gpx`, { type: 'application/gpx+xml' }));

    const savedRoute = await api(`/api/routes/${encodeURIComponent(route.id)}`, {
      method: 'PUT',
      body: form,
    });
    const updatedRoute = normalizeSavedRoute(savedRoute);
    const routeIndex = state.routes.findIndex((item) => item.id === route.id);

    if (routeIndex !== -1) {
      state.routes[routeIndex] = updatedRoute;
    }

    state.selectedId = updatedRoute.id;
    scheduleRoutesRender();
    closeFloatingMenu();
    renderSidebar();
    fitBounds(updatedRoute.bounds);
  } catch (error) {
    console.error(error);
    action.disabled = false;
  }
}

async function parseStoredRouteSegments(route) {
  if (route.downloadUrl) {
    return parseRouteSegmentsUrl(route.downloadUrl, route.storedFileName || route.originalFileName || `${route.name}.gpx`);
  }

  const segments = featureToSegments(route.feature);

  if (!segments.length) {
    throw new Error(`${route.name}: no route points`);
  }

  return {
    fileName: route.name,
    ext: 'geojson',
    segments,
    stats: calculateStats(segments),
  };
}

async function parseBaseRouteSegments(baseRoute) {
  return parseRouteSegmentsUrl(baseRoute.url, baseRoute.fileName);
}

async function parseRouteSegmentsUrl(url, fileName) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${fileName}: ${response.statusText}`);
  }

  const ext = fileName.split('.').pop().toLowerCase();
  const parsed = ext === 'fit'
    ? await parseFit(await response.arrayBuffer())
    : parseGpx(await response.text());

  if (!parsed.segments.length) {
    throw new Error(`${fileName}: no route points`);
  }

  return {
    fileName,
    ext,
    segments: parsed.segments,
    stats: calculateStats(parsed.segments),
  };
}

function featureToSegments(feature) {
  const geometry = feature?.geometry;

  if (!geometry) {
    return [];
  }

  if (geometry.type === 'LineString') {
    return [coordinatesToSegment(geometry.coordinates)].filter((segment) => segment.length > 1);
  }

  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.map(coordinatesToSegment).filter((segment) => segment.length > 1);
  }

  return [];
}

function coordinatesToSegment(coordinates) {
  return coordinates
    .map((coordinate) => {
      const [lon, lat, elevation = null] = coordinate;

      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
        return null;
      }

      return {
        lat: Number(lat),
        lon: Number(lon),
        elevation: numberOrNull(elevation),
        time: null,
      };
    })
    .filter(Boolean);
}

async function parseRouteFile(file) {
  const parsed = await parseRouteSegmentsFile(file);
  const id = createClientId();
  const name = trimExtension(file.name);
  const color = colors[state.routes.length % colors.length];

  return buildRouteFromSegments({
    id,
    name,
    color,
    fileType: parsed.ext.toUpperCase(),
    originalFileName: file.name,
    segments: parsed.segments,
  });
}

async function parseRouteSegmentsFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const parsed = ext === 'gpx'
    ? parseGpx(await file.text())
    : await parseFit(await file.arrayBuffer());

  if (!parsed.segments.length) {
    throw new Error(`${file.name}: no route points`);
  }

  return {
    file,
    ext,
    segments: parsed.segments,
    stats: calculateStats(parsed.segments),
  };
}

function buildMergedRoute(parsedFiles) {
  const id = createClientId();
  const segments = parsedFiles.flatMap((item) => item.segments);
  const stats = calculateStats(segments);
  const routeDate = formatInputDate(stats.startedAt) || todayInputDate();
  const name = `Merged ${formatLayerDate(routeDate)}`;
  const color = colors[state.routes.length % colors.length];

  return buildRouteFromSegments({
    id,
    name,
    color,
    fileType: 'GPX',
    originalFileName: `${name}.gpx`,
    segments,
  });
}

function orderParsedRouteFiles(parsedFiles) {
  return [...parsedFiles].sort((a, b) => {
    const aTime = a.stats.startedAt?.getTime() ?? 0;
    const bTime = b.stats.startedAt?.getTime() ?? 0;
    return aTime - bTime;
  });
}

function buildRouteFromSegments({ id, name, color, fileType, originalFileName, routeDate: routeDateOverride = null, routeType: routeTypeOverride = unsortedGroupType, segments }) {
  const optimizedSegments = segments.map((segment) => simplifyForMap(segment));
  const stats = calculateStats(segments);
  const routeDate = routeDateOverride || formatInputDate(stats.startedAt) || todayInputDate();
  const routeType = routeTypeOverride;

  return {
    id,
    name,
    color,
    fileType,
    routeDate,
    routeType,
    visible: true,
    originalFileName,
    distanceKm: stats.distanceKm,
    ascentM: stats.ascentM,
    descentM: stats.descentM,
    bounds: stats.bounds,
    startedAt: stats.startedAt?.toISOString() || null,
    finishedAt: stats.finishedAt?.toISOString() || null,
    pointCount: segments.reduce((sum, segment) => sum + segment.length, 0),
    feature: {
      type: 'Feature',
      id,
      properties: {
        id,
        name,
        color,
        routeType,
        isSelected: false,
      },
      geometry: {
        type: optimizedSegments.length === 1 ? 'LineString' : 'MultiLineString',
        coordinates: optimizedSegments.length === 1 ? optimizedSegments[0].map(toLngLat) : optimizedSegments.map((segment) => segment.map(toLngLat)),
      },
    },
  };
}

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('GPX file is damaged');
  }

  const segments = [...doc.querySelectorAll('trkseg')]
    .map((segment) => [...segment.querySelectorAll('trkpt')].map(parseGpxPoint).filter(Boolean))
    .filter((segment) => segment.length > 1);
  const routeSegments = [...doc.querySelectorAll('rte')]
    .map((route) => [...route.querySelectorAll('rtept')].map(parseGpxPoint).filter(Boolean))
    .filter((segment) => segment.length > 1);

  segments.push(...routeSegments);

  if (!segments.length && doc.querySelector('rtept')) {
    const route = [...doc.querySelectorAll('rtept')].map(parseGpxPoint).filter(Boolean);
    if (route.length > 1) {
      segments.push(route);
    }
  }

  return { segments };
}

function parseGpxPoint(point) {
  const lat = Number(point.getAttribute('lat'));
  const lon = Number(point.getAttribute('lon'));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return {
    lat,
    lon,
    elevation: numberOrNull(point.querySelector('ele')?.textContent),
    time: dateOrNull(point.querySelector('time')?.textContent),
  };
}

async function parseFit(buffer) {
  const { Decoder, Stream } = await import('@garmin/fitsdk');
  const bytes = Array.from(new Uint8Array(buffer));
  const stream = Stream.fromByteArray(bytes);
  const decoder = new Decoder(stream);

  if (!decoder.isFIT()) {
    throw new Error('This is not a FIT file');
  }

  const { messages, errors } = decoder.read();
  if (errors?.length) {
    console.warn('FIT decode warnings', errors);
  }

  const records = messages.recordMesgs || messages.records || messages.record || [];
  const points = records
    .map((record) => {
      const lat = normalizeCoordinate(record.positionLat ?? record.position_lat);
      const lon = normalizeCoordinate(record.positionLong ?? record.position_long);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }

      return {
        lat,
        lon,
        elevation: numberOrNull(record.enhancedAltitude ?? record.altitude),
        time: dateOrNull(record.timestamp),
      };
    })
    .filter(Boolean);

  return { segments: points.length > 1 ? [points] : [] };
}

function routeToGpx(name, segments) {
  const trackSegments = segments
    .filter((segment) => segment.length > 1)
    .map((segment) => `    <trkseg>
${segment.map(pointToGpx).join('\n')}
    </trkseg>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Route Map" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(name)}</name>
${trackSegments}
  </trk>
</gpx>
`;
}

function pointToGpx(point) {
  const elevation = Number.isFinite(Number(point.elevation)) ? `
        <ele>${roundGpxNumber(point.elevation)}</ele>` : '';
  const time = point.time ? `
        <time>${point.time.toISOString()}</time>` : '';

  return `      <trkpt lat="${roundGpxNumber(point.lat)}" lon="${roundGpxNumber(point.lon)}">${elevation}${time}
      </trkpt>`;
}

function roundGpxNumber(value) {
  return String(Math.round(Number(value) * 1e7) / 1e7);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function scheduleRoutesRender() {
  state.routesRenderPending = true;

  if (state.dataUpdateFrame) {
    cancelAnimationFrame(state.dataUpdateFrame);
  }

  state.dataUpdateFrame = requestAnimationFrame(() => {
    state.dataUpdateFrame = null;
    renderRoutesOnMap();
  });
}

function renderRoutesOnMap() {
  if (!map.isStyleLoaded()) {
    return false;
  }

  ensureRouteLayer();

  const source = map.getSource(routeSourceId);
  if (!source) {
    return false;
  }

  source.setData(currentRouteFeatureCollection());
  state.routesRenderPending = false;
  return true;
}

function currentRouteFeatureCollection() {
  const selectedId = state.selectedId;
  const visibleRoutes = state.routes.filter((route) => route.visible);
  const focusedId = visibleRoutes.some((route) => route.id === state.focusedRouteId) ? state.focusedRouteId : null;

  return {
    type: 'FeatureCollection',
    features: visibleRoutes
      .map((route) => ({
        ...route.feature,
        properties: {
          ...route.feature.properties,
          ...focusedRouteRenderProperties(route, focusedId),
          isSelected: route.id === selectedId,
          sortKey: route.id === focusedId ? 1 : 0,
        },
      })),
  };
}

function renderSidebar() {
  renderRouteSummary();

  const groups = groupRoutesByType(state.routes)
    .map((group) => ({
      ...group,
      routes: state.routes
        .filter((route) => routeGroupType(route) === group.type)
        .sort(compareRoutesByDateDesc),
    }))
    .filter((group) => group.routes.length);

  elements.list.replaceChildren(...groups.map(renderRouteGroup));

  if (state.openMenuRouteId) {
    const anchor = elements.list.querySelector(`[data-menu-route-id="${CSS.escape(state.openMenuRouteId)}"]`);
    if (!anchor) {
      closeFloatingMenu();
    }
  }
}

function renderRouteGroup(group) {
  const section = document.createElement('li');
  section.className = 'route-group';
  const isGroupVisible = group.routes.some((route) => route.visible);

  const header = document.createElement('div');
  header.className = 'route-group-header';
  header.innerHTML = `
    <span class="route-group-count">
      <span class="route-group-count-value">${formatSummaryDistance(group.distanceKm)}</span>
    </span>
    <span class="route-group-main">
      <span class="route-group-title">${escapeHtml(group.label)}</span>
      <button class="route-group-visibility${isGroupVisible ? ' is-visible' : ''}" type="button" data-tooltip="${isGroupVisible ? 'Hide group' : 'Show group'}" aria-label="${isGroupVisible ? `Hide ${escapeAttribute(group.label)}` : `Show ${escapeAttribute(group.label)}`}" aria-pressed="${String(isGroupVisible)}"></button>
    </span>
  `;
  header.querySelector('.route-group-visibility')?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleRouteGroupVisibility(group.type, !isGroupVisible);
  });

  const list = document.createElement('div');
  list.className = 'route-group-list';
  list.replaceChildren(...group.routes.map(renderRouteCard));

  section.append(header, list);
  return section;
}

function compareRoutesByDateDesc(a, b) {
  const dateDelta = routeSortTime(b.routeDate) - routeSortTime(a.routeDate);

  if (dateDelta !== 0) {
    return dateDelta;
  }

  const uploadedDelta = routeSortTime(b.uploadedAt) - routeSortTime(a.uploadedAt);

  if (uploadedDelta !== 0) {
    return uploadedDelta;
  }

  return String(a.name || '').localeCompare(String(b.name || ''), 'en');
}

function routeSortTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function renderRouteCard(route) {
  const item = document.createElement('div');
  const isSelected = route.id === state.selectedId;
  const isFocused = route.id === state.focusedRouteId;
  item.className = `route-card${isSelected ? ' is-selected' : ''}${isFocused ? ' is-focused' : ''}`;

  const button = document.createElement('button');
  button.className = 'route-select';
  button.type = 'button';
  button.addEventListener('click', () => selectRoute(route.id));
  button.innerHTML = `
    <span class="route-distance">${formatLayerDistance(route.distanceKm)}</span>
    <span class="route-main">
      <strong>${escapeHtml(route.name)}</strong>
      <span>${formatLayerDate(route.routeDate)}</span>
    </span>
  `;

  const visibility = document.createElement('button');
  visibility.className = `route-visibility${route.visible ? ' is-visible' : ''}`;
  visibility.type = 'button';
  visibility.setAttribute('aria-pressed', String(route.visible));
  visibility.setAttribute('aria-label', route.visible ? `Hide ${route.name}` : `Show ${route.name}`);
  visibility.dataset.tooltip = route.visible ? 'Hide layer' : 'Show layer';
  visibility.innerHTML = route.visible ? eyeIcon() : eyeOffIcon();
  visibility.addEventListener('click', () => toggleRouteVisibility(route.id, !route.visible));

  const menuButton = document.createElement('button');
  menuButton.className = 'route-menu-trigger';
  menuButton.type = 'button';
  menuButton.dataset.tooltip = 'Route details';
  menuButton.setAttribute('aria-label', `Route details ${route.name}`);
  menuButton.setAttribute('aria-expanded', String(state.openMenuRouteId === route.id));
  menuButton.innerHTML = dotsIcon();
  menuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleRouteMenu(route.id, menuButton);
  });

  item.append(button, visibility, menuButton);
  return item;
}

function renderRouteSummary() {
  const groups = groupRoutesByType(state.routes);

  if (!groups.length) {
    elements.summary.innerHTML = `
      <div class="summary-empty">
        <span>No routes</span>
      </div>
    `;
    return;
  }

  elements.summary.replaceChildren(...groups.map((group) => {
    const row = document.createElement('button');
    row.className = 'summary-row';
    row.type = 'button';
    row.dataset.tooltip = 'Group settings';
    row.setAttribute('aria-label', `Group settings ${group.label}`);
    row.setAttribute('aria-expanded', String(state.openMenuGroupType === group.type));
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleGroupMenu(group.type, row);
    });

    const content = document.createElement('div');
    content.className = 'summary-content';
    content.innerHTML = `
      <span class="summary-type">${escapeHtml(group.label)}</span>
      <span class="summary-distance">${formatSummaryDistance(group.distanceKm)}</span>
      <span class="summary-count">${group.count}</span>
    `;

    row.append(content);
    return row;
  }));
}

function groupRoutesByType(routes) {
  const groups = new Map();

  Object.keys(state.groupSettings).forEach((type) => {
    groups.set(type, {
      type,
      label: groupLabel(type),
      color: groupColor(type),
      lineWidth: groupLineWidth(type),
      lineStyle: groupLineStyle(type),
      distanceKm: 0,
      count: 0,
    });
  });

  routes.forEach((route) => {
    const type = routeGroupType(route);
    const current = groups.get(type) || {
      type,
      label: routeGroupLabel(route),
      color: groupColor(type, route.color),
      lineWidth: groupLineWidth(type),
      lineStyle: groupLineStyle(type),
      distanceKm: 0,
      count: 0,
    };

    current.distanceKm += Number(route.distanceKm) || 0;
    current.count += 1;
    groups.set(type, current);
  });

  return [...groups.values()].sort((a, b) => {
    return a.label.localeCompare(b.label, 'en');
  });
}

function routeGroupOptions() {
  return groupRoutesByType(state.routes);
}

function selectRoute(id) {
  const isFocused = state.focusedRouteId === id;
  state.selectedId = id;
  state.focusedRouteId = isFocused ? null : id;
  const route = state.routes.find((item) => item.id === id);
  if (route && !route.visible) {
    route.visible = true;
    persistRoute(route, { visible: true });
  }
  scheduleRoutesRender();
  renderSidebar();

  if (route) {
    fitBounds(route.bounds);
  }
}

async function toggleRouteVisibility(id, visible) {
  const route = state.routes.find((item) => item.id === id);
  if (!route) {
    return;
  }

  route.visible = visible;

  if (!visible && state.selectedId === id) {
    state.selectedId = state.routes.find((item) => item.visible)?.id || null;
  }

  if (!visible && state.focusedRouteId === id) {
    state.focusedRouteId = null;
  }

  if (visible) {
    state.selectedId = id;
  }

  scheduleRoutesRender();
  renderSidebar();

  try {
    await persistRoute(route, { visible });
  } catch (error) {
    console.error(error);
  }
}

async function toggleRouteGroupVisibility(type, visible) {
  const routes = state.routes.filter((route) => routeGroupType(route) === type);

  if (!routes.length) {
    return;
  }

  routes.forEach((route) => {
    route.visible = visible;
  });

  if (!visible && routes.some((route) => route.id === state.selectedId)) {
    state.selectedId = state.routes.find((route) => route.visible)?.id || null;
  }

  if (!visible && routes.some((route) => route.id === state.focusedRouteId)) {
    state.focusedRouteId = null;
  }

  if (visible && !state.selectedId) {
    state.selectedId = routes[0].id;
  }

  scheduleRoutesRender();
  renderSidebar();

  try {
    for (const route of routes) {
      await persistRoute(route, { visible });
    }
  } catch (error) {
    console.error(error);
  }
}

async function saveRouteDetails(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const route = state.routes.find((item) => item.id === form.dataset.routeId);
  if (!route) {
    return;
  }

  const previousGroupType = routeGroupType(route);

  const formData = new FormData(form);
  const patch = {
    name: String(formData.get('name') || '').trim(),
    routeDate: String(formData.get('routeDate') || ''),
    routeType: String(formData.get('routeType') || routeGroupType(route)),
    distanceKm: Number(formData.get('distanceKm')),
  };

  if (!patch.name || !patch.routeDate || !Number.isFinite(patch.distanceKm)) {
    return;
  }

  try {
    const updated = await persistRoute(route, patch);
    Object.assign(route, normalizeSavedRoute(updated));
    applyGroupStyleToRoute(route);
    await pruneEmptyRouteGroups([previousGroupType]);
    scheduleRoutesRender();
    closeFloatingMenu();
    renderSidebar();
  } catch (error) {
    console.error(error);
  }
}

async function deleteRouteLayer(id) {
  const route = state.routes.find((item) => item.id === id);

  if (!route) {
    return;
  }

  const groupType = routeGroupType(route);

  try {
    await api(`/api/routes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.routes = state.routes.filter((item) => item.id !== id);
    await pruneEmptyRouteGroups([groupType]);

    if (state.selectedId === id) {
      state.selectedId = state.routes.find((item) => item.visible)?.id || state.routes[0]?.id || null;
    }

    if (state.focusedRouteId === id) {
      state.focusedRouteId = null;
    }

    scheduleRoutesRender();
    closeFloatingMenu();
    renderSidebar();
  } catch (error) {
    console.error(error);
  }
}

async function pruneEmptyRouteGroups(types = Object.keys(state.groupSettings)) {
  const uniqueTypes = [...new Set(types)]
    .filter((type) => state.groupSettings[type])
    .filter((type) => !state.routes.some((route) => routeGroupType(route) === type));

  for (const type of uniqueTypes) {
    delete state.groupSettings[type];

    try {
      await api(`/api/group-settings/${encodeURIComponent(type)}`, { method: 'DELETE' });
    } catch (error) {
      console.warn('Empty group cleanup failed', error);
    }
  }
}

async function saveGroupDetails(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const type = form.dataset.groupType;
  const formData = new FormData(form);
  const patch = {
    label: String(formData.get('label') || '').trim(),
    color: String(formData.get('color') || ''),
    lineWidth: Number(formData.get('lineWidth')),
    lineStyle: String(formData.get('lineStyle') || 'solid'),
  };

  if (!patch.label || !/^#[0-9a-f]{6}$/i.test(patch.color) || !Number.isFinite(patch.lineWidth) || !isLineStyle(patch.lineStyle)) {
    return;
  }

  try {
    const updated = await api(`/api/group-settings/${encodeURIComponent(type)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    state.groupSettings[type] = updated;
    state.routes
      .filter((route) => route.routeType === type)
      .forEach(applyGroupStyleToRoute);
    scheduleRoutesRender();
    closeFloatingMenu();
    renderSidebar();
  } catch (error) {
    console.error(error);
  }
}

async function deleteRouteGroup(type) {
  const routesToDelete = state.routes.filter((route) => routeGroupType(route) === type);

  try {
    for (const route of routesToDelete) {
      await api(`/api/routes/${encodeURIComponent(route.id)}`, { method: 'DELETE' });
    }

    try {
      await api(`/api/group-settings/${encodeURIComponent(type)}`, { method: 'DELETE' });
    } catch (error) {
      console.warn('Group settings delete failed', error);
    }

    state.routes = state.routes.filter((route) => routeGroupType(route) !== type);
    delete state.groupSettings[type];

    if (!state.routes.some((route) => route.id === state.selectedId)) {
      state.selectedId = state.routes.find((route) => route.visible)?.id || state.routes[0]?.id || null;
    }

    if (!state.routes.some((route) => route.id === state.focusedRouteId)) {
      state.focusedRouteId = null;
    }

    scheduleRoutesRender();
    closeFloatingMenu();
    renderSidebar();
  } catch (error) {
    console.error(error);
  }
}

function toggleRouteMenu(routeId, anchor) {
  if (state.openMenuRouteId === routeId) {
    closeFloatingMenu();
    return;
  }

  openRouteMenu(routeId, anchor);
}

function openRouteMenu(routeId, anchor) {
  const route = state.routes.find((item) => item.id === routeId);
  if (!route) {
    return;
  }

  closeFloatingMenu();

  const menu = document.createElement('div');
  menu.className = 'floating-menu route-menu-popover';
  menu.innerHTML = routeMenuTemplate(route);
  initRouteTypeDropdown(menu);
  initRouteDatePicker(menu);
  initBaseRouteMergeControl(menu);
  menu.querySelector('form').addEventListener('submit', saveRouteDetails);
  menu.querySelector('[data-route-delete]')?.addEventListener('click', () => deleteRouteLayer(routeId));
  menu.querySelector('[data-base-route-merge]')?.addEventListener('click', () => mergeRouteWithBaseRoutes(routeId, menu));
  document.body.append(menu);

  state.openMenuRouteId = routeId;
  state.openMenuGroupType = null;
  state.openMenuAnchor = anchor;
  anchor.dataset.menuRouteId = routeId;
  anchor.setAttribute('aria-expanded', 'true');
  positionFloatingMenu();
}

function initBaseRouteMergeControl(menu) {
  const options = [...menu.querySelectorAll('.base-route-option')];
  const checkboxes = options.map((option) => option.querySelector('input')).filter(Boolean);
  const action = menu.querySelector('[data-base-route-merge]');

  if (!checkboxes.length || !action) {
    return;
  }

  const sync = () => {
    options.forEach((option) => {
      const input = option.querySelector('input');
      option.classList.toggle('is-selected', Boolean(input?.checked));
    });
    action.disabled = !checkboxes.some((input) => input.checked);
  };

  options.forEach((option) => {
    const input = option.querySelector('input');

    if (!input) {
      return;
    }

    input.required = false;
    input.tabIndex = -1;
    option.addEventListener('click', (event) => {
      event.preventDefault();
      input.checked = !input.checked;
      sync();
    });
  });
  sync();
}

function toggleGroupMenu(type, anchor) {
  if (state.openMenuGroupType === type) {
    closeFloatingMenu();
    return;
  }

  openGroupMenu(type, anchor);
}

function openGroupMenu(type, anchor) {
  const group = groupRoutesByType(state.routes).find((item) => item.type === type);
  if (!group) {
    return;
  }

  closeFloatingMenu();

  const menu = document.createElement('div');
  menu.className = 'floating-menu group-menu-popover';
  menu.innerHTML = groupMenuTemplate(group);
  initGroupColorPicker(menu);
  initGroupLineStyleDropdown(menu);
  initLineWidthControl(menu);
  menu.querySelector('form').addEventListener('submit', saveGroupDetails);
  menu.querySelector('[data-group-delete]')?.addEventListener('click', () => deleteRouteGroup(type));
  document.body.append(menu);

  state.openMenuRouteId = null;
  state.openMenuGroupType = type;
  state.openMenuAnchor = anchor;
  anchor.dataset.menuGroupType = type;
  anchor.setAttribute('aria-expanded', 'true');
  positionFloatingMenu();
}

function openCreateGroupMenu(anchor) {
  closeFloatingMenu();

  const group = {
    type: createGroupType(),
    label: 'New group',
    color: colors[Object.keys(state.groupSettings).length % colors.length],
    lineWidth: 1,
    lineStyle: 'solid',
    distanceKm: 0,
    count: 0,
  };
  const menu = document.createElement('div');
  menu.className = 'floating-menu group-menu-popover';
  menu.innerHTML = groupMenuTemplate(group);
  initGroupColorPicker(menu);
  initGroupLineStyleDropdown(menu);
  initLineWidthControl(menu);
  menu.querySelector('form').addEventListener('submit', saveGroupDetails);
  menu.querySelector('[data-group-delete]')?.addEventListener('click', () => deleteRouteGroup(group.type));
  document.body.append(menu);

  state.openMenuRouteId = null;
  state.openMenuGroupType = group.type;
  state.openMenuAnchor = anchor;
  anchor.dataset.menuGroupType = group.type;
  anchor.setAttribute('aria-expanded', 'true');
  positionFloatingMenu();
}

function closeFloatingMenu() {
  document.querySelector('.floating-menu')?.remove();

  if (state.openMenuAnchor) {
    state.openMenuAnchor.removeAttribute('data-menu-route-id');
    state.openMenuAnchor.removeAttribute('data-menu-group-type');
    state.openMenuAnchor.setAttribute('aria-expanded', 'false');
  }

  state.openMenuRouteId = null;
  state.openMenuGroupType = null;
  state.openMenuAnchor = null;
}

function positionFloatingMenu() {
  const menu = document.querySelector('.floating-menu');
  const anchor = state.openMenuAnchor;

  if (!menu || !anchor || !document.body.contains(anchor)) {
    return;
  }

  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const viewportGap = 10;

  if (menu.classList.contains('group-menu-popover')) {
    const gap = 8;
    const preferredLeft = rect.left;
    const left = Math.min(
      Math.max(viewportGap, preferredLeft),
      window.innerWidth - menuRect.width - viewportGap,
    );
    const top = Math.min(
      rect.bottom + gap,
      window.innerHeight - menuRect.height - viewportGap,
    );

    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(viewportGap, top)}px`;
    return;
  }

  const gap = menu.classList.contains('route-menu-popover') ? 44 : 18;
  const opensLeft = rect.left > window.innerWidth - rect.right;
  const preferredLeft = opensLeft ? rect.left - menuRect.width - gap : rect.right + gap;
  const left = Math.min(preferredLeft, window.innerWidth - menuRect.width - viewportGap);
  const top = Math.min(
    Math.max(viewportGap, rect.top),
    window.innerHeight - menuRect.height - viewportGap,
  );

  menu.style.left = `${Math.max(viewportGap, left)}px`;
  menu.style.top = `${top}px`;
}

function initRouteTypeDropdown(menu) {
  const dropdown = menu.querySelector('.type-dropdown');
  const trigger = dropdown?.querySelector('.type-dropdown-trigger');
  const list = dropdown?.querySelector('.type-dropdown-list');
  const options = [...(dropdown?.querySelectorAll('.type-dropdown-option') || [])];
  const input = menu.querySelector('input[name="routeType"]');
  const closeDuration = 520;
  let closeTimer = null;

  if (!dropdown || !trigger || !list || !input || !options.length) {
    return;
  }

  const updateDropdownHeight = () => {
    const optionHeight = 34;
    const gap = 4;
    const padding = 16;
    const contentHeight = options.length * optionHeight + Math.max(0, options.length - 1) * gap + padding;
    dropdown.style.setProperty('--type-dropdown-height', `${Math.min(contentHeight, 420)}px`);
  };

  const openDropdown = () => {
    window.clearTimeout(closeTimer);
    updateDropdownHeight();
    dropdown.classList.remove('is-closing');
    dropdown.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    positionFloatingMenu();
  };

  const closeDropdown = () => {
    if (!dropdown.classList.contains('is-open')) {
      return;
    }

    window.clearTimeout(closeTimer);
    dropdown.classList.add('is-closing');
    trigger.setAttribute('aria-expanded', 'false');
    closeTimer = window.setTimeout(() => {
      dropdown.classList.remove('is-open', 'is-closing');
      positionFloatingMenu();
    }, closeDuration);
  };

  trigger.addEventListener('click', () => {
    if (dropdown.classList.contains('is-open') && !dropdown.classList.contains('is-closing')) {
      closeDropdown();
    } else {
      openDropdown();
    }
  });

  menu.addEventListener('click', (event) => {
    if (!dropdown.contains(event.target)) {
      closeDropdown();
    }
  });

  options.forEach((option) => {
    option.addEventListener('click', () => {
      input.value = option.dataset.value;
      trigger.querySelector('span').textContent = option.textContent;
      options.forEach((item) => item.classList.toggle('is-selected', item === option));
      closeDropdown();
    });
  });
}

function initGroupLineStyleDropdown(menu) {
  const dropdown = menu.querySelector('.line-style-dropdown');
  const trigger = dropdown?.querySelector('.type-dropdown-trigger');
  const list = dropdown?.querySelector('.type-dropdown-list');
  const options = [...(dropdown?.querySelectorAll('.type-dropdown-option') || [])];
  const input = menu.querySelector('input[name="lineStyle"]');
  const closeDuration = 520;
  let closeTimer = null;

  if (!dropdown || !trigger || !list || !input || !options.length) {
    return;
  }

  const updateDropdownHeight = () => {
    const optionHeight = 34;
    const gap = 4;
    const padding = 16;
    const contentHeight = options.length * optionHeight + Math.max(0, options.length - 1) * gap + padding;
    dropdown.style.setProperty('--type-dropdown-height', `${contentHeight}px`);
  };

  const openDropdown = () => {
    window.clearTimeout(closeTimer);
    updateDropdownHeight();
    dropdown.classList.remove('is-closing');
    dropdown.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    positionFloatingMenu();
  };

  const closeDropdown = () => {
    if (!dropdown.classList.contains('is-open')) {
      return;
    }

    window.clearTimeout(closeTimer);
    dropdown.classList.add('is-closing');
    trigger.setAttribute('aria-expanded', 'false');
    closeTimer = window.setTimeout(() => {
      dropdown.classList.remove('is-open', 'is-closing');
      positionFloatingMenu();
    }, closeDuration);
  };

  trigger.addEventListener('click', () => {
    if (dropdown.classList.contains('is-open') && !dropdown.classList.contains('is-closing')) {
      closeDropdown();
    } else {
      openDropdown();
    }
  });

  menu.addEventListener('click', (event) => {
    if (!dropdown.contains(event.target)) {
      closeDropdown();
    }
  });

  options.forEach((option) => {
    option.addEventListener('click', () => {
      input.value = option.dataset.value;
      trigger.querySelector('span').textContent = option.textContent;
      options.forEach((item) => item.classList.toggle('is-selected', item === option));
      closeDropdown();
    });
  });
}

function initRouteDatePicker(menu) {
  const picker = menu.querySelector('.calendar-picker');
  const trigger = picker?.querySelector('.calendar-trigger');
  const value = picker?.querySelector('.calendar-trigger-value');
  const panel = picker?.querySelector('.calendar-panel');
  const input = menu.querySelector('input[name="routeDate"]');
  const closeDuration = 520;
  let closeTimer = null;

  if (!picker || !trigger || !value || !panel || !input) {
    return;
  }

  let selectedDate = parseInputDate(input.value) || new Date();
  let viewDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);

  const updateCalendarHeight = () => {
    const height = Math.min(panel.scrollHeight + 20, 360);
    picker.style.setProperty('--calendar-panel-height', `${height}px`);
  };

  const closeCalendar = () => {
    if (!picker.classList.contains('is-open')) {
      return;
    }

    window.clearTimeout(closeTimer);
    picker.classList.add('is-closing');
    trigger.setAttribute('aria-expanded', 'false');
    closeTimer = window.setTimeout(() => {
      picker.classList.remove('is-open', 'is-closing');
      positionFloatingMenu();
    }, closeDuration);
  };

  const openCalendar = () => {
    window.clearTimeout(closeTimer);
    renderCalendar();
    updateCalendarHeight();
    picker.classList.remove('is-closing');
    picker.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    positionFloatingMenu();
  };

  const renderCalendar = () => {
    panel.innerHTML = calendarTemplate(viewDate, selectedDate);
  };

  trigger.addEventListener('click', () => {
    if (picker.classList.contains('is-open')) {
      closeCalendar();
    } else {
      openCalendar();
    }
  });

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeCalendar();
    }
  });

  panel.addEventListener('click', (event) => {
    event.stopPropagation();

    const action = event.target.closest('[data-calendar-action]');
    const day = event.target.closest('[data-calendar-date]');

    if (action) {
      const direction = action.dataset.calendarAction === 'next' ? 1 : -1;
      viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + direction, 1);
      renderCalendar();
      updateCalendarHeight();
      positionFloatingMenu();
      return;
    }

    if (day) {
      selectedDate = parseInputDate(day.dataset.calendarDate) || selectedDate;
      input.value = formatInputDateLocal(selectedDate);
      value.textContent = formatCalendarDate(selectedDate);
      viewDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
      closeCalendar();
      trigger.focus();
    }
  });

  menu.addEventListener('click', (event) => {
    const path = event.composedPath?.() || [];

    if (!path.includes(picker) && !picker.contains(event.target)) {
      closeCalendar();
    }
  });

  value.textContent = formatCalendarDate(selectedDate);
  input.value = formatInputDateLocal(selectedDate);
  renderCalendar();
  updateCalendarHeight();
}

function initGroupColorPicker(menu) {
  const picker = menu.querySelector('.color-picker');
  const trigger = picker?.querySelector('.color-picker-trigger');
  const swatch = picker?.querySelector('.color-picker-trigger-swatch');
  const value = picker?.querySelector('.color-picker-value');
  const input = menu.querySelector('input[name="color"]');
  const options = [...(picker?.querySelectorAll('.color-picker-option') || [])];

  if (!picker || !trigger || !swatch || !value || !input || !options.length) {
    return;
  }

  const setColor = (color) => {
    input.value = color;
    value.textContent = color.toUpperCase();
    swatch.style.setProperty('--selected-color', color);
    options.forEach((option) => option.classList.toggle('is-selected', option.dataset.color === color));
  };

  const closePicker = () => {
    picker.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    positionFloatingMenu();
  };

  trigger.addEventListener('click', () => {
    const isOpen = picker.classList.toggle('is-open');
    trigger.setAttribute('aria-expanded', String(isOpen));
    positionFloatingMenu();
  });

  menu.addEventListener('click', (event) => {
    if (!picker.contains(event.target)) {
      closePicker();
    }
  });

  options.forEach((option) => {
    option.addEventListener('click', () => {
      setColor(option.dataset.color);
      closePicker();
      trigger.focus();
    });
  });

  setColor(input.value);
}

function initLineWidthControl(menu) {
  const input = menu.querySelector('input[name="lineWidth"]');
  const value = menu.querySelector('[data-line-width-value]');

  if (!input || !value) {
    return;
  }

  const updateValue = () => {
    value.textContent = `${formatLineWidthValue(input.value)} px`;
  };

  input.addEventListener('input', updateValue);
  updateValue();
}

function calendarTemplate(viewDate, selectedDate) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const startDate = new Date(year, month, 1 - startOffset);
  const today = new Date();
  const selectedIso = formatInputDateLocal(selectedDate);
  const todayIso = formatInputDateLocal(today);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + index);
    const iso = formatInputDateLocal(date);
    const classes = [
      'calendar-day',
      date.getMonth() !== month ? 'is-muted' : '',
      iso === selectedIso ? 'is-selected' : '',
      iso === todayIso ? 'is-today' : '',
    ].filter(Boolean).join(' ');

    return `
      <button class="${classes}" type="button" data-calendar-date="${iso}" aria-label="${escapeAttribute(formatCalendarDate(date))}">
        ${date.getDate()}
      </button>
    `;
  }).join('');

  return `
    <div class="calendar-header">
      <button class="calendar-month-button" type="button" data-calendar-action="prev" aria-label="Previous month"></button>
      <span class="calendar-month-label">${calendarMonths[month]} ${year}</span>
      <button class="calendar-month-button is-next" type="button" data-calendar-action="next" aria-label="Next month"></button>
    </div>
    <div class="calendar-weekdays" aria-hidden="true">
      ${calendarWeekdays.map((day) => `<span>${day}</span>`).join('')}
    </div>
    <div class="calendar-grid">
      ${days}
    </div>
  `;
}

function routeMenuTemplate(route) {
  const groups = routeGroupOptions();
  const selectedGroup = groups.find((group) => group.type === routeGroupType(route)) || groups[0];

  return `
    <form data-route-id="${route.id}">
      <label>
        <span>Name</span>
        <input name="name" type="text" value="${escapeAttribute(route.name)}" required />
      </label>
      <label class="date-field">
        <span>Date</span>
        <input class="date-input" name="routeDate" type="hidden" value="${escapeAttribute(route.routeDate)}" required />
        <div class="calendar-picker">
          <button class="calendar-trigger" type="button" aria-expanded="false">
            <span class="calendar-trigger-value">${escapeHtml(formatCalendarDate(parseInputDate(route.routeDate) || new Date()))}</span>
          </button>
          <div class="calendar-panel" aria-label="Choose date"></div>
        </div>
      </label>
      <label>
        <span>Type</span>
        <input name="routeType" type="hidden" value="${escapeAttribute(selectedGroup?.type || routeGroupType(route))}" />
        <div class="type-dropdown">
          <button class="type-dropdown-trigger" type="button" aria-expanded="false">
            <span>${escapeHtml(selectedGroup?.label || routeGroupLabel(route))}</span>
          </button>
          <div class="type-dropdown-list">
            ${groups.map((group) => `
              <button class="type-dropdown-option${group.type === selectedGroup?.type ? ' is-selected' : ''}" type="button" data-value="${escapeAttribute(group.type)}">
                ${escapeHtml(group.label)}
              </button>
            `).join('')}
          </div>
        </div>
      </label>
      <label>
        <span>Distance, km</span>
        <input name="distanceKm" type="number" min="0" step="0.1" value="${roundDistance(route.distanceKm)}" required />
      </label>
      <div class="editor-actions route-editor-actions">
        <a class="download-action" href="${route.downloadUrl || '#'}" download="${route.storedFileName || ''}" data-tooltip="Download" aria-label="Download route">
          <span aria-hidden="true"></span>
        </a>
        <div class="route-editor-action-group">
          <button class="delete-action" type="button" data-route-delete>Delete layer</button>
          <button class="save-action" type="submit">Save</button>
        </div>
      </div>
    </form>
    ${baseRouteOptions.length ? `
      <div class="base-route-merge">
        <span class="base-route-merge-title">Base routes</span>
        <div class="base-route-list">
          ${baseRouteOptions.map((baseRoute) => `
            <label class="base-route-option">
              <input type="checkbox" name="baseRouteIds" value="${escapeAttribute(baseRoute.id)}" />
              <span>${escapeHtml(baseRoute.name)}</span>
            </label>
          `).join('')}
        </div>
        <button class="base-route-merge-action" type="button" data-base-route-merge>Merge selected</button>
      </div>
    ` : ''}
  `;
}

function groupMenuTemplate(group) {
  return `
    <form data-group-type="${group.type}">
      <label>
        <span>Group name</span>
        <input name="label" type="text" value="${escapeAttribute(group.label)}" required />
      </label>
      <label>
        <span>Line color</span>
        <input name="color" type="hidden" value="${escapeAttribute(group.color)}" required />
        <div class="color-picker">
          <button class="color-picker-trigger" type="button" aria-expanded="false">
            <span class="color-picker-trigger-swatch" style="--selected-color: ${escapeAttribute(group.color)}"></span>
            <span class="color-picker-value">${escapeHtml(group.color.toUpperCase())}</span>
          </button>
          <div class="color-picker-panel" aria-label="Choose line color">
            <div class="color-picker-grid">
              ${[...colors, ...extendedColors, ...grayscaleColors].map((color) => `
                <button class="color-picker-option${color === group.color ? ' is-selected' : ''}" type="button" data-color="${escapeAttribute(color)}" style="--option-color: ${escapeAttribute(color)}" aria-label="${escapeAttribute(color)}"></button>
              `).join('')}
            </div>
          </div>
        </div>
      </label>
      <label>
        <span>Line width</span>
        <div class="range-control">
          <input name="lineWidth" type="range" min="0.4" max="3" step="0.1" value="${group.lineWidth}" />
          <output class="range-value" data-line-width-value>${formatLineWidthValue(group.lineWidth)} px</output>
        </div>
      </label>
      <label>
        <span>Line style</span>
        <input name="lineStyle" type="hidden" value="${escapeAttribute(group.lineStyle)}" required />
        <div class="type-dropdown line-style-dropdown">
          <button class="type-dropdown-trigger" type="button" aria-expanded="false">
            <span>${group.lineStyle === 'dashed' ? 'Dashed' : 'Solid'}</span>
          </button>
          <div class="type-dropdown-list" aria-label="Choose line style">
            <button class="type-dropdown-option${group.lineStyle === 'solid' ? ' is-selected' : ''}" type="button" data-value="solid">Solid</button>
            <button class="type-dropdown-option${group.lineStyle === 'dashed' ? ' is-selected' : ''}" type="button" data-value="dashed">Dashed</button>
          </div>
        </div>
      </label>
      <div class="group-editor-actions">
        <span class="group-editor-meta">${group.count} ${pluralTrack(group.count)} · ${formatDistance(group.distanceKm)}</span>
        <div class="group-editor-action-group">
          <button class="delete-action" type="button" data-group-delete>Delete group</button>
          <button class="save-action" type="submit">Save</button>
        </div>
      </div>
    </form>
  `;
}

async function persistRoute(route, patch) {
  return api(`/api/routes/${encodeURIComponent(route.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

function fitAllRoutes() {
  const bounds = state.routes
    .filter((route) => route.visible)
    .reduce((acc, route) => extendBounds(acc, route.bounds), null);
  if (bounds) {
    fitBounds(bounds);
  }
}

function calculateStats(segments) {
  let distanceKm = 0;
  let ascentM = 0;
  let descentM = 0;
  let bounds = null;
  let startedAt = null;
  let finishedAt = null;

  segments.forEach((segment) => {
    let previousElevation = null;

    segment.forEach((point, index) => {
      bounds = extendBounds(bounds, [point.lon, point.lat, point.lon, point.lat]);

      if (index > 0) {
        distanceKm += haversine(segment[index - 1], point);
      }

      if (point.time) {
        if (!startedAt || point.time < startedAt) startedAt = point.time;
        if (!finishedAt || point.time > finishedAt) finishedAt = point.time;
      }

      if (point.elevation !== null && previousElevation !== null) {
        const delta = point.elevation - previousElevation;
        if (delta > 0) ascentM += delta;
        if (delta < 0) descentM += Math.abs(delta);
      }

      if (point.elevation !== null) {
        previousElevation = point.elevation;
      }
    });
  });

  return { distanceKm, ascentM, descentM, bounds, startedAt, finishedAt };
}

function simplifyForMap(points) {
  if (points.length < 15000) {
    return points;
  }

  const tolerance = points.length > 60000 ? 0.00008 : 0.00004;
  return simplifyDouglasPeucker(points, tolerance);
}

function simplifyDouglasPeucker(points, tolerance) {
  if (points.length <= 2) {
    return points;
  }

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const toleranceSq = tolerance * tolerance;

  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDistance = 0;
    let index = 0;

    for (let i = start + 1; i < end; i += 1) {
      const distance = perpendicularDistanceSq(points[i], points[start], points[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }

    if (maxDistance > toleranceSq) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }

  return points.filter((_, index) => keep[index]);
}

function perpendicularDistanceSq(point, start, end) {
  const dx = end.lon - start.lon;
  const dy = end.lat - start.lat;

  if (dx === 0 && dy === 0) {
    return (point.lon - start.lon) ** 2 + (point.lat - start.lat) ** 2;
  }

  const t = Math.max(0, Math.min(1, ((point.lon - start.lon) * dx + (point.lat - start.lat) * dy) / (dx * dx + dy * dy)));
  const lon = start.lon + t * dx;
  const lat = start.lat + t * dy;
  return (point.lon - lon) ** 2 + (point.lat - lat) ** 2;
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    const requestError = new Error(error.error || response.statusText);
    requestError.status = response.status;
    throw requestError;
  }
  return response.json();
}

function normalizeSavedRoute(route) {
  const normalized = {
    ...route,
    distanceKm: Number(route.distanceKm) || 0,
    routeDate: route.routeDate || todayInputDate(),
    routeType: route.routeType || unsortedGroupType,
    visible: route.visible !== false,
    bounds: route.bounds || null,
    feature: route.feature,
  };

  return applyGroupStyleToRoute(normalized);
}

function normalizeCoordinate(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.abs(numeric) > 180 ? (numeric * 180) / 2 ** 31 : numeric;
}

function haversine(a, b) {
  const radiusKm = 6371.0088;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(h));
}

function extendBounds(bounds, next) {
  if (!next) {
    return bounds;
  }

  if (!bounds) {
    return [...next];
  }

  return [
    Math.min(bounds[0], next[0]),
    Math.min(bounds[1], next[1]),
    Math.max(bounds[2], next[2]),
    Math.max(bounds[3], next[3]),
  ];
}

function fitBounds(bounds) {
  if (!bounds) {
    return;
  }

  map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {
    padding: {
      top: 92,
      right: 56,
      bottom: 118,
      left: window.innerWidth > 760 && !state.layersCollapsed ? 420 : 56,
    },
    duration: 700,
    maxZoom: 15,
  });
}

function toLngLat(point) {
  return [point.lon, point.lat];
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function dateOrNull(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDistance(value) {
  return `${roundDistance(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} km`;
}

function formatSummaryDistance(value) {
  return String(Math.round(Number(value) || 0));
}

function formatLayerDistance(value) {
  return String(Math.round(Number(value) || 0));
}

function formatLayerDate(value) {
  const date = dateOrNull(value);

  if (!date) {
    return 'no date';
  }

  return `${date.getDate()} ${calendarMonths[date.getMonth()].slice(0, 3).toLowerCase()} ${date.getFullYear()}`;
}

function pluralTrack(count) {
  return Math.abs(count) === 1 ? 'track' : 'tracks';
}

function roundDistance(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function formatLineWidthValue(value) {
  const rounded = Math.round((Number(value) || 0) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function trimExtension(name) {
  return name.replace(/\.[^.]+$/, '');
}

function createClientId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);

  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return [...bytes].map((byte, index) => {
    const value = byte.toString(16).padStart(2, '0');
    return [4, 6, 8, 10].includes(index) ? `-${value}` : value;
  }).join('');
}

function emptyCollection() {
  return {
    type: 'FeatureCollection',
    features: [],
  };
}

function routeGroupType(route) {
  return route.routeType || unsortedGroupType;
}

function routeGroupLabel(route) {
  const type = routeGroupType(route);

  if (state.groupSettings[type]?.label || type === unsortedGroupType) {
    return groupLabel(type);
  }

  return route.name || type;
}

function groupLabel(value) {
  if (value === unsortedGroupType) {
    return state.groupSettings[value]?.label || unsortedGroupLabel;
  }

  return state.groupSettings[value]?.label || value;
}

function groupColor(value, fallback = '#2f3432') {
  return state.groupSettings[value]?.color || fallback;
}

function groupLineWidth(value) {
  const lineWidth = Number(state.groupSettings[value]?.lineWidth);
  return Number.isFinite(lineWidth) ? lineWidth : 1;
}

function groupLineStyle(value) {
  const lineStyle = state.groupSettings[value]?.lineStyle;
  return isLineStyle(lineStyle) ? lineStyle : 'solid';
}

function isLineStyle(value) {
  return value === 'solid' || value === 'dashed';
}

function createGroupType() {
  let type = `custom_${createClientId()}`;

  while (state.groupSettings[type]) {
    type = `custom_${createClientId()}`;
  }

  return type;
}

function routeRenderProperties(route) {
  return {
    name: route.name,
    color: groupColor(route.routeType, route.color),
    ...lineWidthProperties(route.routeType),
    isDashed: groupLineStyle(route.routeType) === 'dashed',
    routeType: route.routeType,
  };
}

function focusedRouteRenderProperties(route, focusedId) {
  const properties = routeRenderProperties(route);

  return focusedId && route.id !== focusedId
    ? { ...properties, color: focusedRouteMutedColor }
    : properties;
}

function applyGroupStyleToRoute(route) {
  if (route.feature?.properties) {
    Object.assign(route.feature.properties, routeRenderProperties(route));
  }

  return route;
}

function lineWidthProperties(routeType) {
  const scale = groupLineWidth(routeType);
  return {
    lineWidthPx: 4.2 * scale,
  };
}

function formatInputDate(value) {
  if (!value) {
    return '';
  }
  return value.toISOString().slice(0, 10);
}

function parseInputDate(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);

  if (!year || !month || !day) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function formatInputDateLocal(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatCalendarDate(value) {
  return `${calendarMonths[value.getMonth()]} ${value.getDate()}, ${value.getFullYear()}`;
}

function todayInputDate() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(value) {
  const [year, month, day] = String(value || '').split('-');
  return year && month && day ? `${day}.${month}.${year}` : 'no date';
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function eyeIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.7 12s3.3-6 9.3-6 9.3 6 9.3 6-3.3 6-9.3 6-9.3-6-9.3-6Z"></path>
      <circle cx="12" cy="12" r="2.6"></circle>
    </svg>
  `;
}

function eyeOffIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 5.2 19.5 19"></path>
      <path d="M8.1 7.1A9.4 9.4 0 0 1 12 6c6 0 9.3 6 9.3 6a16 16 0 0 1-2.5 3.2"></path>
      <path d="M15.2 16.8A8.8 8.8 0 0 1 12 18c-6 0-9.3-6-9.3-6a16.3 16.3 0 0 1 3.5-4"></path>
      <path d="M10.3 10.4a2.6 2.6 0 0 0 3.4 3.3"></path>
    </svg>
  `;
}

function dotsIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7"></circle>
      <circle cx="12" cy="12" r="1.7"></circle>
      <circle cx="12" cy="19" r="1.7"></circle>
    </svg>
  `;
}
