import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

const routeSourceId = 'uploaded-routes';
const routeLayerId = 'route-lines';
const colors = ['#0f8b8d', '#e4572e', '#3f7cac', '#a23e48', '#2e933c', '#7b2cbf', '#f2a900', '#006d77'];
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
};

const routeTypes = [
  { value: 'bicycle', label: 'Велосипед' },
  { value: 'walk', label: 'Пешком' },
  { value: 'run', label: 'Бег' },
  { value: 'car', label: 'Авто' },
  { value: 'train', label: 'Поезд' },
  { value: 'plane', label: 'Самолет' },
  { value: 'boat', label: 'Лодка' },
  { value: 'other', label: 'Другое' },
];

const state = {
  routes: [],
  groupSettings: {},
  selectedId: null,
  dataUpdateFrame: null,
  openMenuRouteId: null,
  openMenuGroupType: null,
  openMenuAnchor: null,
  basemap: 'colorful',
};

const elements = {
  input: document.querySelector('#file-input'),
  dropZone: document.querySelector('#drop-zone'),
  list: document.querySelector('#route-list'),
  summary: document.querySelector('#route-summary'),
  fitAll: document.querySelector('#fit-all'),
  groupAdd: document.querySelector('#add-group'),
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

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');

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

function ensureRouteLayer() {
  if (!map.isStyleLoaded()) {
    return;
  }

  if (!map.getSource(routeSourceId)) {
    map.addSource(routeSourceId, {
      type: 'geojson',
      data: emptyCollection(),
      promoteId: 'id',
      lineMetrics: false,
    });
  }

  if (map.getLayer(routeLayerId)) {
    return;
  }

  map.addLayer({
    id: routeLayerId,
    type: 'line',
    source: routeSourceId,
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['get', 'lineWidthPx'],
      'line-opacity': ['case', ['==', ['get', 'isSelected'], true], 1, 0.78],
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  });
}

elements.input.addEventListener('change', (event) => {
  handleFiles([...event.target.files]);
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

elements.fitAll.addEventListener('click', fitAllRoutes);
elements.groupAdd.addEventListener('click', (event) => {
  event.stopPropagation();
  openCreateGroupMenu(elements.groupAdd);
});
elements.basemapButtons.forEach((button) => {
  button.addEventListener('click', () => setBasemap(button.dataset.basemap));
});
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

function setBasemap(name) {
  if (!basemaps[name] || state.basemap === name) {
    return;
  }

  state.basemap = name;
  updateBasemapButtons();
  map.setStyle(basemapStyle(name), { diff: false });
}

function basemapStyle(name) {
  const style = basemaps[name]?.style || basemaps.osm.style;
  return typeof style === 'string' ? style : structuredClone(style);
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

  parsed.forEach((result) => {
    if (result.status === 'fulfilled') {
      accepted.push(result.value);
    } else {
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

async function parseRouteFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const parsed = ext === 'gpx'
    ? parseGpx(await file.text())
    : await parseFit(await file.arrayBuffer());

  if (!parsed.segments.length) {
    throw new Error(`${file.name}: нет точек маршрута`);
  }

  const id = crypto.randomUUID();
  const name = trimExtension(file.name);
  const optimizedSegments = parsed.segments.map((segment) => simplifyForMap(segment));
  const stats = calculateStats(parsed.segments);
  const routeDate = formatInputDate(stats.startedAt) || todayInputDate();
  const color = colors[state.routes.length % colors.length];

  return {
    id,
    name,
    color,
    fileType: ext.toUpperCase(),
    routeDate,
    routeType: 'bicycle',
    visible: true,
    originalFileName: file.name,
    distanceKm: stats.distanceKm,
    ascentM: stats.ascentM,
    descentM: stats.descentM,
    bounds: stats.bounds,
    startedAt: stats.startedAt?.toISOString() || null,
    finishedAt: stats.finishedAt?.toISOString() || null,
    pointCount: parsed.segments.reduce((sum, segment) => sum + segment.length, 0),
    feature: {
      type: 'Feature',
      id,
      properties: {
        id,
        name,
        color,
        routeType: 'bicycle',
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
    throw new Error('GPX файл поврежден');
  }

  const segments = [...doc.querySelectorAll('trkseg')]
    .map((segment) => [...segment.querySelectorAll('trkpt')].map(parseGpxPoint).filter(Boolean))
    .filter((segment) => segment.length > 1);

  if (!segments.length) {
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
    throw new Error('Это не FIT файл');
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

function scheduleRoutesRender() {
  if (state.dataUpdateFrame) {
    cancelAnimationFrame(state.dataUpdateFrame);
  }

  state.dataUpdateFrame = requestAnimationFrame(() => {
    ensureRouteLayer();

    const source = map.getSource(routeSourceId);
    if (!source) {
      return;
    }

    const selectedId = state.selectedId;
    const data = {
      type: 'FeatureCollection',
      features: state.routes
        .filter((route) => route.visible)
        .map((route) => ({
          ...route.feature,
          properties: {
            ...route.feature.properties,
            ...routeRenderProperties(route),
            isSelected: route.id === selectedId,
          },
        })),
    };

    source.setData(data);
  });
}

function renderSidebar() {
  renderRouteSummary();

  const groups = groupRoutesByType(state.routes)
    .map((group) => ({
      ...group,
      routes: state.routes.filter((route) => (route.routeType || 'other') === group.type),
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

  const header = document.createElement('div');
  header.className = 'route-group-header';
  header.innerHTML = `
    <span class="route-group-title">${escapeHtml(group.label)}</span>
    <span class="route-group-meta">${group.routes.length} ${pluralTrack(group.routes.length)} · ${formatDistance(group.distanceKm)}</span>
  `;

  const list = document.createElement('div');
  list.className = 'route-group-list';
  list.replaceChildren(...group.routes.map(renderRouteCard));

  section.append(header, list);
  return section;
}

function renderRouteCard(route) {
  const item = document.createElement('div');
  const isSelected = route.id === state.selectedId;
  item.className = `route-card${isSelected ? ' is-selected' : ''}`;

  const button = document.createElement('button');
  button.className = 'route-select';
  button.type = 'button';
  button.addEventListener('click', () => selectRoute(route.id));
  button.innerHTML = `
    <span class="route-distance">${formatDistance(route.distanceKm)}</span>
    <span class="route-main">
      <strong>${escapeHtml(route.name)}</strong>
      <span>${routeTypeLabel(route.routeType)} · ${formatDate(route.routeDate)} · ${route.pointCount.toLocaleString('ru-RU')} точек</span>
    </span>
  `;

  const visibility = document.createElement('button');
  visibility.className = `route-visibility${route.visible ? ' is-visible' : ''}`;
  visibility.type = 'button';
  visibility.setAttribute('aria-pressed', String(route.visible));
  visibility.setAttribute('aria-label', route.visible ? `Скрыть ${route.name}` : `Показать ${route.name}`);
  visibility.title = route.visible ? 'Скрыть слой' : 'Показать слой';
  visibility.innerHTML = route.visible ? eyeIcon() : eyeOffIcon();
  visibility.addEventListener('click', () => toggleRouteVisibility(route.id, !route.visible));

  const menuButton = document.createElement('button');
  menuButton.className = 'route-menu-trigger';
  menuButton.type = 'button';
  menuButton.title = 'Данные маршрута';
  menuButton.setAttribute('aria-label', `Данные маршрута ${route.name}`);
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
        <span>Нет маршрутов</span>
      </div>
    `;
    return;
  }

  elements.summary.replaceChildren(...groups.map((group) => {
    const row = document.createElement('div');
    row.className = 'summary-row';

    const content = document.createElement('div');
    content.className = 'summary-content';
    content.innerHTML = `
      <span class="summary-type">${escapeHtml(group.label)}</span>
      <span class="summary-distance">${formatDistance(group.distanceKm)}</span>
      <span class="summary-count">${group.count}</span>
    `;

    const menuButton = document.createElement('button');
    menuButton.className = 'summary-menu-trigger';
    menuButton.type = 'button';
    menuButton.title = 'Настройки группы';
    menuButton.setAttribute('aria-label', `Настройки группы ${group.label}`);
    menuButton.setAttribute('aria-expanded', String(state.openMenuGroupType === group.type));
    menuButton.innerHTML = dotsIcon();
    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleGroupMenu(group.type, menuButton);
    });

    row.append(content, menuButton);
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
      distanceKm: 0,
      count: 0,
    });
  });

  routes.forEach((route) => {
    const type = route.routeType || 'other';
    const current = groups.get(type) || {
      type,
      label: groupLabel(type),
      color: groupColor(type, route.color),
      lineWidth: groupLineWidth(type),
      distanceKm: 0,
      count: 0,
    };

    current.distanceKm += Number(route.distanceKm) || 0;
    current.count += 1;
    groups.set(type, current);
  });

  const order = new Map(routeTypes.map((type, index) => [type.value, index]));
  return [...groups.values()].sort((a, b) => {
    const aIndex = order.get(a.type) ?? 999;
    const bIndex = order.get(b.type) ?? 999;
    return aIndex - bIndex || a.label.localeCompare(b.label, 'ru');
  });
}

function selectRoute(id) {
  state.selectedId = id;
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

async function saveRouteDetails(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const route = state.routes.find((item) => item.id === form.dataset.routeId);
  if (!route) {
    return;
  }

  const formData = new FormData(form);
  const patch = {
    name: String(formData.get('name') || '').trim(),
    routeDate: String(formData.get('routeDate') || ''),
    routeType: String(formData.get('routeType') || 'other'),
    distanceKm: Number(formData.get('distanceKm')),
  };

  if (!patch.name || !patch.routeDate || !Number.isFinite(patch.distanceKm)) {
    return;
  }

  try {
    const updated = await persistRoute(route, patch);
    Object.assign(route, normalizeSavedRoute(updated));
    applyGroupStyleToRoute(route);
    scheduleRoutesRender();
    closeFloatingMenu();
    renderSidebar();
  } catch (error) {
    console.error(error);
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
  };

  if (!patch.label || !/^#[0-9a-f]{6}$/i.test(patch.color) || !Number.isFinite(patch.lineWidth)) {
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
  menu.querySelector('form').addEventListener('submit', saveRouteDetails);
  document.body.append(menu);

  state.openMenuRouteId = routeId;
  state.openMenuGroupType = null;
  state.openMenuAnchor = anchor;
  anchor.dataset.menuRouteId = routeId;
  anchor.setAttribute('aria-expanded', 'true');
  positionFloatingMenu();
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
  menu.querySelector('form').addEventListener('submit', saveGroupDetails);
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
    label: 'Новая группа',
    color: colors[Object.keys(state.groupSettings).length % colors.length],
    lineWidth: 1,
    distanceKm: 0,
    count: 0,
  };
  const menu = document.createElement('div');
  menu.className = 'floating-menu group-menu-popover';
  menu.innerHTML = groupMenuTemplate(group);
  menu.querySelector('form').addEventListener('submit', saveGroupDetails);
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
  const gap = 6;
  const viewportGap = 10;
  const left = Math.min(rect.right + gap, window.innerWidth - menuRect.width - viewportGap);
  const top = Math.min(
    Math.max(viewportGap, rect.top),
    window.innerHeight - menuRect.height - viewportGap,
  );

  menu.style.left = `${Math.max(viewportGap, left)}px`;
  menu.style.top = `${top}px`;
}

function routeMenuTemplate(route) {
  const groups = groupRoutesByType(state.routes);

  return `
    <form data-route-id="${route.id}">
      <label>
        <span>Название</span>
        <input name="name" type="text" value="${escapeAttribute(route.name)}" required />
      </label>
      <label>
        <span>Дата</span>
        <input name="routeDate" type="date" value="${escapeAttribute(route.routeDate)}" required />
      </label>
      <label>
        <span>Тип</span>
        <select name="routeType">${groups.map((group) => `<option value="${group.type}"${group.type === route.routeType ? ' selected' : ''}>${escapeHtml(group.label)}</option>`).join('')}</select>
      </label>
      <label>
        <span>Дистанция, км</span>
        <input name="distanceKm" type="number" min="0" step="0.1" value="${roundDistance(route.distanceKm)}" required />
      </label>
      <div class="editor-actions">
        <a href="${route.downloadUrl || '#'}" download="${route.storedFileName || ''}">Скачать</a>
        <button type="submit">Сохранить</button>
      </div>
    </form>
  `;
}

function groupMenuTemplate(group) {
  return `
    <form data-group-type="${group.type}">
      <label>
        <span>Название группы</span>
        <input name="label" type="text" value="${escapeAttribute(group.label)}" required />
      </label>
      <label>
        <span>Цвет линии</span>
        <input name="color" type="color" value="${escapeAttribute(group.color)}" required />
      </label>
      <label>
        <span>Толщина линии</span>
        <input name="lineWidth" type="range" min="0.4" max="3" step="0.1" value="${group.lineWidth}" />
      </label>
      <div class="editor-actions">
        <span>${group.count} ${pluralTrack(group.count)} · ${formatDistance(group.distanceKm)}</span>
        <button type="submit">Применить</button>
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
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

function normalizeSavedRoute(route) {
  const normalized = {
    ...route,
    distanceKm: Number(route.distanceKm) || 0,
    routeDate: route.routeDate || todayInputDate(),
    routeType: route.routeType || 'other',
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
    padding: { top: 56, right: 56, bottom: 56, left: window.innerWidth > 760 ? 420 : 56 },
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
  return `${roundDistance(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`;
}

function pluralTrack(count) {
  const value = Math.abs(count) % 100;
  const last = value % 10;

  if (value > 10 && value < 20) {
    return 'треков';
  }

  if (last === 1) {
    return 'трек';
  }

  if (last > 1 && last < 5) {
    return 'трека';
  }

  return 'треков';
}

function roundDistance(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function trimExtension(name) {
  return name.replace(/\.[^.]+$/, '');
}

function emptyCollection() {
  return {
    type: 'FeatureCollection',
    features: [],
  };
}

function routeTypeLabel(value) {
  return groupLabel(value);
}

function groupLabel(value) {
  return state.groupSettings[value]?.label || routeTypes.find((type) => type.value === value)?.label || 'Другое';
}

function groupColor(value, fallback = '#0f8b8d') {
  return state.groupSettings[value]?.color || fallback;
}

function groupLineWidth(value) {
  const lineWidth = Number(state.groupSettings[value]?.lineWidth);
  return Number.isFinite(lineWidth) ? lineWidth : 1;
}

function createGroupType() {
  let type = `custom_${crypto.randomUUID()}`;

  while (state.groupSettings[type]) {
    type = `custom_${crypto.randomUUID()}`;
  }

  return type;
}

function routeRenderProperties(route) {
  return {
    name: route.name,
    color: groupColor(route.routeType, route.color),
    ...lineWidthProperties(route.routeType),
    routeType: route.routeType,
  };
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

function todayInputDate() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(value) {
  const [year, month, day] = String(value || '').split('-');
  return year && month && day ? `${day}.${month}.${year}` : 'без даты';
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
