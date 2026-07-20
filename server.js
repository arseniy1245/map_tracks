import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 5173);

const dataDir = path.join(__dirname, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const routesFile = path.join(dataDir, 'routes.json');
const groupSettingsFile = path.join(dataDir, 'group-settings.json');
const distDir = path.join(__dirname, 'dist');
const maxUploadBytes = 100 * 1024 * 1024;

await ensureStorage();

const vite = isProduction
  ? null
  : await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith('/uploads/')) {
      await serveUpload(request, response, url);
      return;
    }

    if (vite) {
      vite.middlewares(request, response, (error) => {
        if (error) {
          sendError(response, 500, error.message);
        }
      });
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    sendError(response, error.status || 500, error.message || 'Server error');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Route map server: http://127.0.0.1:${port}/`);
});

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/routes') {
    sendJson(response, await readRoutes());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/group-settings') {
    sendJson(response, await readGroupSettings());
    return;
  }

  const groupSettingsMatch = url.pathname.match(/^\/api\/group-settings\/([^/]+)$/);
  if (groupSettingsMatch && request.method === 'PATCH') {
    const updatedSettings = await updateGroupSettings(decodeURIComponent(groupSettingsMatch[1]), request);
    sendJson(response, updatedSettings);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/routes') {
    const savedRoute = await createRoute(request);
    sendJson(response, savedRoute, 201);
    return;
  }

  if (request.method === 'DELETE' && url.pathname === '/api/routes') {
    await clearRoutes();
    sendJson(response, { ok: true });
    return;
  }

  const routeMatch = url.pathname.match(/^\/api\/routes\/([^/]+)$/);
  if (routeMatch && request.method === 'PATCH') {
    const updatedRoute = await updateRoute(decodeURIComponent(routeMatch[1]), request);
    sendJson(response, updatedRoute);
    return;
  }

  if (routeMatch && request.method === 'DELETE') {
    await deleteRoute(decodeURIComponent(routeMatch[1]));
    sendJson(response, { ok: true });
    return;
  }

  sendError(response, 404, 'API endpoint not found');
}

async function createRoute(request) {
  const { fields, files } = await parseMultipart(request);
  const route = JSON.parse(fields.route || '{}');
  const file = files.file;

  if (!file) {
    throw new Error('Route file is required');
  }

  const extension = getExtension(file.filename || route.originalFileName || route.fileType);
  const normalized = normalizeRoute({
    ...route,
    id: route.id || randomUUID(),
    originalFileName: file.filename || route.originalFileName || `route.${extension}`,
    uploadedAt: new Date().toISOString(),
  });

  normalized.storedFileName = await makeStoredFileName(normalized.routeDate, normalized.name, extension);
  normalized.downloadUrl = `/uploads/${encodeURIComponent(normalized.storedFileName)}`;

  await fs.writeFile(path.join(uploadDir, normalized.storedFileName), file.content);

  const routes = await readRoutes();
  routes.push(normalized);
  await writeRoutes(routes);
  return normalized;
}

async function updateRoute(id, request) {
  const patch = await readJsonBody(request);
  const routes = await readRoutes();
  const route = routes.find((item) => item.id === id);

  if (!route) {
    throw new HttpError(404, 'Route not found');
  }

  const previousFileName = route.storedFileName;

  if (typeof patch.name === 'string' && patch.name.trim()) {
    route.name = patch.name.trim();
  }

  if (typeof patch.routeDate === 'string' && patch.routeDate) {
    route.routeDate = normalizeDate(patch.routeDate);
  }

  if (typeof patch.routeType === 'string' && patch.routeType) {
    route.routeType = patch.routeType;
  }

  if (Number.isFinite(Number(patch.distanceKm))) {
    route.distanceKm = Math.max(0, Number(patch.distanceKm));
  }

  if (typeof patch.visible === 'boolean') {
    route.visible = patch.visible;
  }

  if (route.feature?.properties) {
    route.feature.properties.name = route.name;
    route.feature.properties.routeType = route.routeType;
  }

  const extension = getExtension(previousFileName || route.originalFileName || route.fileType);
  const desiredName = buildStoredFileName(route.routeDate, route.name, extension);
  if (previousFileName && previousFileName !== desiredName) {
    route.storedFileName = await makeStoredFileName(route.routeDate, route.name, extension, previousFileName);
    route.downloadUrl = `/uploads/${encodeURIComponent(route.storedFileName)}`;
    await renameUpload(previousFileName, route.storedFileName);
  }

  await writeRoutes(routes);
  return route;
}

async function deleteRoute(id) {
  const routes = await readRoutes();
  const route = routes.find((item) => item.id === id);
  const nextRoutes = routes.filter((item) => item.id !== id);

  if (route?.storedFileName) {
    await removeUpload(route.storedFileName);
  }

  await writeRoutes(nextRoutes);
}

async function clearRoutes() {
  const routes = await readRoutes();
  await Promise.all(routes.map((route) => removeUpload(route.storedFileName)));
  await writeRoutes([]);
}

async function updateGroupSettings(type, request) {
  const patch = await readJsonBody(request);
  const settings = await readGroupSettings();
  const current = settings[type] || {};

  settings[type] = {
    ...current,
    label: normalizeOptionalString(patch.label, current.label || type),
    color: normalizeColor(patch.color, current.color),
    lineWidth: normalizeLineWidth(patch.lineWidth, current.lineWidth),
  };

  await writeGroupSettings(settings);
  return settings[type];
}

function normalizeRoute(route) {
  const name = String(route.name || 'route').trim() || 'route';
  const routeDate = normalizeDate(route.routeDate || route.date);
  const routeType = String(route.routeType || 'bicycle');

  return {
    ...route,
    name,
    routeDate,
    routeType,
    distanceKm: Number.isFinite(Number(route.distanceKm)) ? Number(route.distanceKm) : 0,
    visible: route.visible !== false,
  };
}

async function parseMultipart(request) {
  const contentType = request.headers['content-type'] || '';
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
    || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];

  if (!boundary) {
    throw new HttpError(400, 'Multipart boundary is missing');
  }

  const body = await readBody(request, maxUploadBytes);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};
  let position = body.indexOf(delimiter);

  while (position !== -1) {
    position += delimiter.length;

    if (body[position] === 45 && body[position + 1] === 45) {
      break;
    }

    if (body[position] === 13 && body[position + 1] === 10) {
      position += 2;
    }

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), position);
    if (headerEnd === -1) {
      break;
    }

    const headerText = body.slice(position, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const nextBoundary = body.indexOf(delimiter, contentStart);
    if (nextBoundary === -1) {
      break;
    }

    const contentEnd = body[nextBoundary - 2] === 13 && body[nextBoundary - 1] === 10
      ? nextBoundary - 2
      : nextBoundary;
    const content = body.slice(contentStart, contentEnd);
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/)?.[1];
    const mimeType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/octet-stream';

    if (name && filename !== undefined) {
      files[name] = { filename: path.basename(filename), content, mimeType };
    } else if (name) {
      fields[name] = content.toString('utf8');
    }

    position = nextBoundary;
  }

  return { fields, files };
}

async function readJsonBody(request) {
  const body = await readBody(request, 1024 * 1024);
  return body.length ? JSON.parse(body.toString('utf8')) : {};
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readRoutes() {
  try {
    return JSON.parse(await fs.readFile(routesFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeRoutes(routes) {
  await ensureStorage();
  await fs.writeFile(routesFile, `${JSON.stringify(routes, null, 2)}\n`, 'utf8');
}

async function readGroupSettings() {
  try {
    return JSON.parse(await fs.readFile(groupSettingsFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeGroupSettings(settings) {
  await ensureStorage();
  await fs.writeFile(groupSettingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

async function ensureStorage() {
  await fs.mkdir(uploadDir, { recursive: true });
  try {
    await fs.access(routesFile);
  } catch {
    await fs.writeFile(routesFile, '[]\n', 'utf8');
  }
  try {
    await fs.access(groupSettingsFile);
  } catch {
    await fs.writeFile(groupSettingsFile, '{}\n', 'utf8');
  }
}

function normalizeOptionalString(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function normalizeColor(value, fallback = '#0f8b8d') {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function normalizeLineWidth(value, fallback = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(3, Math.max(0.4, numeric)) : fallback;
}

async function makeStoredFileName(routeDate, routeName, extension, currentName = null) {
  const baseName = buildStoredFileName(routeDate, routeName, extension);
  let candidate = baseName;
  let index = 2;

  while (candidate !== currentName && await fileExists(path.join(uploadDir, candidate))) {
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

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }
  return new Date().toISOString().slice(0, 10);
}

function getExtension(value) {
  const extension = String(value || 'gpx').toLowerCase().match(/([a-z0-9]+)$/)?.[1] || 'gpx';
  return extension === 'fit' ? 'fit' : 'gpx';
}

async function renameUpload(from, to) {
  if (from === to) {
    return;
  }
  try {
    await fs.rename(path.join(uploadDir, from), path.join(uploadDir, to));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function removeUpload(fileName) {
  if (!fileName) {
    return;
  }

  await fs.rm(path.join(uploadDir, path.basename(fileName)), { force: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function serveUpload(request, response, url) {
  if (request.method !== 'GET') {
    sendError(response, 405, 'Method not allowed');
    return;
  }

  const fileName = path.basename(decodeURIComponent(url.pathname.replace('/uploads/', '')));
  const filePath = path.join(uploadDir, fileName);

  if (!await fileExists(filePath)) {
    sendError(response, 404, 'File not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': fileName.endsWith('.fit') ? 'application/octet-stream' : 'application/gpx+xml; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  createReadStream(filePath).pipe(response);
}

async function serveStatic(response, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(distDir, safePath));

  if (!filePath.startsWith(distDir)) {
    sendError(response, 403, 'Forbidden');
    return;
  }

  if (await fileExists(filePath)) {
    response.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
    createReadStream(filePath).pipe(response);
    return;
  }

  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  createReadStream(path.join(distDir, 'index.html')).pipe(response);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: message }));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
