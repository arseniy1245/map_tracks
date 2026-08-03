import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const oldDir = path.join(rootDir, 'old routes');
const oldRoutesDir = path.join(oldDir, 'routes');
const oldRoutesFile = path.join(oldDir, 'routes.json');
const dataDir = path.join(rootDir, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const routesDir = path.join(dataDir, 'routes');
const routesIndexFile = path.join(dataDir, 'routes-index.json');
const groupSettingsFile = path.join(dataDir, 'group-settings.json');
const unsortedGroupType = 'unsorted';

await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(routesDir, { recursive: true });

const metadata = JSON.parse(await fs.readFile(oldRoutesFile, 'utf8'));
const availableFiles = new Set(await fs.readdir(oldRoutesDir));
const routes = await readJsonFile(routesIndexFile, []);
const groupSettings = {};
const routeMap = new Map(routes.map((route) => [route.id, route]));
const metadataIds = new Set(metadata.map((route) => route.id));
const existingRoutesByOriginalName = new Map(routes
  .filter((route) => route.originalFileName)
  .map((route) => [route.originalFileName, route]));
const usedUploadNames = new Set(routes.map((route) => route.storedFileName).filter(Boolean));
const skipped = [];
let importedCount = 0;

for (const item of metadata) {
  const hasOldFile = availableFiles.has(item.fileName);
  const fallbackRoute = existingRoutesByOriginalName.get(item.fileName);

  if (!hasOldFile && !fallbackRoute) {
    if (!routeMap.has(item.id)) {
      skipped.push(item.fileName);
    }
    continue;
  }

  const sourcePath = hasOldFile ? path.join(oldRoutesDir, item.fileName) : null;
  const sourceExtension = hasOldFile ? path.extname(item.fileName).toLowerCase() : path.extname(fallbackRoute.storedFileName).toLowerCase();
  const sourceText = hasOldFile
    ? await fs.readFile(sourcePath, 'utf8')
    : await fs.readFile(path.join(uploadDir, fallbackRoute.storedFileName), 'utf8');
  const segments = sourceExtension === '.geojson'
    ? parseGeoJsonSegments(JSON.parse(sourceText))
    : parseGpxSegments(sourceText);

  if (!segments.length) {
    skipped.push(`${item.fileName} (no route points)`);
    continue;
  }

  const stats = calculateStats(segments);
  const routeType = item.bike || unsortedGroupType;
  const routeDate = normalizeDate(item.routeDate);
  const name = String(item.originalName || trimExtension(item.fileName)).trim() || 'route';
  const color = normalizeColor(item.color, '#2f3432');
  const geometryFile = routeGeometryFileName(item.id);
  const existingRoute = routeMap.get(item.id);
  const storedFileName = sourceExtension === '.geojson'
    ? existingRoute?.storedFileName || makeStoredFileName(routeDate, name, 'gpx', usedUploadNames)
    : item.fileName;
  const feature = routeFeature({
    id: item.id,
    name,
    color,
    routeType,
    segments,
  });

  const route = {
    id: item.id,
    name,
    color,
    fileType: 'GPX',
    routeDate,
    routeType,
    visible: true,
    originalFileName: item.fileName,
    distanceKm: stats.distanceKm,
    ascentM: stats.ascentM,
    descentM: stats.descentM,
    bounds: stats.bounds,
    startedAt: stats.startedAt?.toISOString() || null,
    finishedAt: stats.finishedAt?.toISOString() || null,
    pointCount: segments.reduce((sum, segment) => sum + segment.length, 0),
    uploadedAt: item.uploadedAt || new Date().toISOString(),
    storedFileName,
    downloadUrl: `/uploads/${encodeURIComponent(storedFileName)}`,
    geometryFile,
    description: item.description || '',
    bike: item.bike || '',
    rideTime: item.rideTime || '',
    totalTime: item.totalTime || '',
    averageSpeed: item.averageSpeed || '',
    weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : null,
  };

  routeMap.set(route.id, route);
  usedUploadNames.add(storedFileName);
  importedCount += 1;

  if (sourceExtension === '.geojson') {
    await fs.writeFile(path.join(uploadDir, storedFileName), routeToGpx(name, segments), 'utf8');
  } else if (hasOldFile) {
    await fs.copyFile(sourcePath, path.join(uploadDir, storedFileName));
  } else {
    await fs.copyFile(path.join(uploadDir, fallbackRoute.storedFileName), path.join(uploadDir, storedFileName));
  }
  await writeJsonFile(path.join(routesDir, geometryFile), feature);

  if (!groupSettings[routeType]) {
    groupSettings[routeType] = {
      label: routeType === unsortedGroupType ? 'Unsorted' : routeType,
      color,
      lineWidth: normalizeLineWidth(item.weight, 1),
      lineStyle: 'solid',
    };
  }
}

const nextRoutes = [...routeMap.values()]
  .filter((route) => metadataIds.has(route.id))
  .sort((a, b) => routeSortTime(b.routeDate) - routeSortTime(a.routeDate)
  || routeSortTime(b.uploadedAt) - routeSortTime(a.uploadedAt)
  || a.name.localeCompare(b.name, 'ru'));

await writeJsonFile(routesIndexFile, nextRoutes);
await writeJsonFile(groupSettingsFile, groupSettings);
await cleanupDirectory(routesDir, new Set(nextRoutes.map((route) => route.geometryFile)));
await cleanupDirectory(uploadDir, new Set(nextRoutes.map((route) => route.storedFileName)));

console.log(`Imported or updated ${importedCount} routes.`);
console.log(`Routes in project: ${nextRoutes.length}.`);
console.log(`Created ${Object.keys(groupSettings).length} groups.`);
if (skipped.length) {
  console.log(`Skipped ${skipped.length} entries:`);
  skipped.forEach((item) => console.log(`- ${item}`));
}

function parseGpxSegments(gpx) {
  const segments = [];

  for (const segmentXml of matchAll(gpx, /<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/gi)) {
    const points = parsePointTags(segmentXml, 'trkpt');
    if (points.length) {
      segments.push(points);
    }
  }

  for (const routeXml of matchAll(gpx, /<rte\b[^>]*>([\s\S]*?)<\/rte>/gi)) {
    const points = parsePointTags(routeXml, 'rtept');
    if (points.length) {
      segments.push(points);
    }
  }

  if (!segments.length) {
    const points = [
      ...parsePointTags(gpx, 'trkpt'),
      ...parsePointTags(gpx, 'rtept'),
    ];
    if (points.length) {
      segments.push(points);
    }
  }

  return segments;
}

function parseGeoJsonSegments(geojson) {
  const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
  const segments = [];

  features.filter(Boolean).forEach((feature) => {
    const geometry = feature.type === 'Feature' ? feature.geometry : feature;
    const times = feature.properties?.times || [];

    if (geometry?.type === 'LineString') {
      const points = coordinatesToSegment(geometry.coordinates, times);
      if (points.length) {
        segments.push(points);
      }
    }

    if (geometry?.type === 'MultiLineString') {
      let offset = 0;

      geometry.coordinates.forEach((coordinates) => {
        const points = coordinatesToSegment(coordinates, times.slice(offset, offset + coordinates.length));
        offset += coordinates.length;
        if (points.length) {
          segments.push(points);
        }
      });
    }
  });

  return segments;
}

function coordinatesToSegment(coordinates, times = []) {
  return coordinates
    .map((coordinate, index) => {
      const [lon, lat, elevation = null] = coordinate;

      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
        return null;
      }

      return {
        lat: Number(lat),
        lon: Number(lon),
        elevation: numberOrNull(elevation),
        time: dateOrNull(times[index]),
      };
    })
    .filter(Boolean);
}

function parsePointTags(xml, tagName) {
  const regex = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>|<${tagName}\\b([^>]*)\\/>`, 'gi');
  const points = [];

  for (const match of xml.matchAll(regex)) {
    const attributes = match[1] || match[3] || '';
    const body = match[2] || '';
    const lat = Number(attributeValue(attributes, 'lat'));
    const lon = Number(attributeValue(attributes, 'lon'));

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }

    points.push({
      lat,
      lon,
      elevation: numberOrNull(body.match(/<ele\b[^>]*>([^<]+)<\/ele>/i)?.[1]),
      time: dateOrNull(body.match(/<time\b[^>]*>([^<]+)<\/time>/i)?.[1]),
    });
  }

  return points;
}

function attributeValue(attributes, name) {
  return attributes.match(new RegExp(`${name}="([^"]+)"`, 'i'))?.[1]
    || attributes.match(new RegExp(`${name}='([^']+)'`, 'i'))?.[1]
    || '';
}

function routeFeature({ id, name, color, routeType, segments }) {
  const optimizedSegments = segments.map((segment) => simplifyForMap(segment));

  return {
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
      coordinates: optimizedSegments.length === 1
        ? optimizedSegments[0].map(toLngLat)
        : optimizedSegments.map((segment) => segment.map(toLngLat)),
    },
  };
}

function routeToGpx(name, segments) {
  const tracks = segments.map((segment) => {
    const points = segment.map((point) => {
      const elevation = point.elevation === null ? '' : `<ele>${point.elevation}</ele>`;
      const time = point.time ? `<time>${point.time.toISOString()}</time>` : '';
      return `<trkpt lat="${point.lat}" lon="${point.lon}">${elevation}${time}</trkpt>`;
    }).join('');

    return `<trkseg>${points}</trkseg>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="map-routes-viewer"><trk><name>${escapeXml(name)}</name>${tracks}</trk></gpx>\n`;
}

function calculateStats(segments) {
  let distanceKm = 0;
  let ascentM = 0;
  let descentM = 0;
  let bounds = null;
  let startedAt = null;
  let finishedAt = null;
  let previousElevation = null;

  segments.forEach((segment) => {
    segment.forEach((point, index) => {
      if (index > 0) {
        distanceKm += haversine(segment[index - 1], point);
      }

      bounds = extendBounds(bounds, [point.lon, point.lat, point.lon, point.lat]);

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
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date().toISOString().slice(0, 10);
}

function normalizeColor(value, fallback) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function normalizeLineWidth(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(3, Math.max(0.4, numeric)) : fallback;
}

function routeGeometryFileName(id) {
  return `${sanitizeFileSegment(id)}.geojson`;
}

function makeStoredFileName(routeDate, routeName, extension, usedNames) {
  const baseName = buildStoredFileName(routeDate, routeName, extension);
  let candidate = baseName;
  let index = 2;

  while (usedNames.has(candidate)) {
    candidate = `${baseName.replace(/\.[^.]+$/, '')}_${index}.${extension}`;
    index += 1;
  }

  return candidate;
}

function buildStoredFileName(routeDate, routeName, extension) {
  return `${routeDate.replaceAll('-', '_')}_${sanitizeFileSegment(routeName)}.${extension}`;
}

function sanitizeFileSegment(value) {
  return String(value || 'route')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90) || 'route';
}

function trimExtension(name) {
  return name.replace(/\.[^.]+$/, '');
}

function routeSortTime(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

async function writeJsonFile(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function cleanupDirectory(directory, keepNames) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && !keepNames.has(entry.name)) {
      await fs.rm(path.join(directory, entry.name), { force: true });
    }
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function matchAll(text, regex) {
  return [...text.matchAll(regex)].map((match) => match[1]);
}
