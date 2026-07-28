import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const COLLECTION_ORDER = [
  'airspaces',
  'airports',
  'navaids',
  'reportingPoints'
];

export const COLLECTION_PATHS = {
  airspaces: 'airspaces',
  airports: 'airports',
  navaids: 'navaids',
  reportingPoints: 'reporting-points'
};

export const SOURCE_INFO = Object.freeze({
  name: 'OpenAIP',
  url: 'https://www.openaip.net/',
  license: 'CC BY-NC 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/'
});

export function parseCliArgs(argv) {
  const result = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const equals = arg.indexOf('=');
    if (equals < 0) {
      result[arg.slice(2)] = true;
    } else {
      result[arg.slice(2, equals)] = arg.slice(equals + 1);
    }
  }
  return result;
}

export function parseCsv(value, transform = (item) => item) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => transform(item.trim()))
    .filter(Boolean);
}

export function cleanText(value, maxLength = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : '';
}

export function cleanCountry(value) {
  const country = cleanText(value, 8).toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : 'ZZ';
}

export function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function roundNumber(value, digits = 6) {
  const number = asFiniteNumber(value);
  return number === null ? null : Number(number.toFixed(digits));
}

export function compactObject(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => compactObject(item))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') {
    return value === undefined ? undefined : value;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === '') continue;
    const compacted = compactObject(item);
    if (Array.isArray(compacted) && compacted.length === 0) continue;
    if (
      compacted
      && typeof compacted === 'object'
      && !Array.isArray(compacted)
      && Object.keys(compacted).length === 0
    ) continue;
    result[key] = compacted;
  }
  return result;
}

function normalizeCoordinates(node, bbox) {
  if (!Array.isArray(node) || node.length === 0) return null;
  if (
    node.length >= 2
    && typeof node[0] === 'number'
    && typeof node[1] === 'number'
  ) {
    const lon = roundNumber(node[0]);
    const lat = roundNumber(node[1]);
    if (
      lon === null
      || lat === null
      || lon < -180
      || lon > 180
      || lat < -90
      || lat > 90
    ) return null;
    bbox[0] = Math.min(bbox[0], lon);
    bbox[1] = Math.min(bbox[1], lat);
    bbox[2] = Math.max(bbox[2], lon);
    bbox[3] = Math.max(bbox[3], lat);
    return [lon, lat, ...node.slice(2).map((value) => roundNumber(value)).filter((value) => value !== null)];
  }
  const children = node
    .map((child) => normalizeCoordinates(child, bbox))
    .filter(Boolean);
  return children.length ? children : null;
}

export function normalizeGeometry(geometry) {
  const type = cleanText(geometry?.type, 32);
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const coordinates = normalizeCoordinates(geometry?.coordinates, bbox);
  if (!type || !coordinates || !bbox.every(Number.isFinite)) return null;
  return {
    geometry: { type, coordinates },
    bbox
  };
}

export function mergeBboxes(bboxes) {
  const valid = bboxes.filter((bbox) => Array.isArray(bbox) && bbox.length === 4);
  if (!valid.length) return null;
  return valid.reduce((result, bbox) => [
    Math.min(result[0], bbox[0]),
    Math.min(result[1], bbox[1]),
    Math.max(result[2], bbox[2]),
    Math.max(result[3], bbox[3])
  ], [Infinity, Infinity, -Infinity, -Infinity]).map((value) => roundNumber(value));
}

export function bboxCenter(bbox) {
  return [
    (bbox[0] + bbox[2]) / 2,
    (bbox[1] + bbox[3]) / 2
  ];
}

export function cellIdForBbox(bbox, spanDegrees = 5) {
  const [lon, lat] = bboxCenter(bbox);
  const lonIndex = Math.min(
    Math.ceil(360 / spanDegrees) - 1,
    Math.max(0, Math.floor((lon + 180) / spanDegrees))
  );
  const latIndex = Math.min(
    Math.ceil(180 / spanDegrees) - 1,
    Math.max(0, Math.floor((lat + 90) / spanDegrees))
  );
  return `lat-${String(latIndex).padStart(2, '0')}-lon-${String(lonIndex).padStart(2, '0')}`;
}

export function shouldStartNewPack(currentCount, currentBytes, nextBytes, limitBytes) {
  if (![currentCount, currentBytes, nextBytes, limitBytes].every(Number.isFinite)) {
    throw new TypeError('Packgrößen müssen endliche Zahlen sein');
  }
  if (nextBytes > limitBytes) {
    throw new RangeError(`Einzelner Datensatz überschreitet das Packlimit (${nextBytes} > ${limitBytes})`);
  }
  return currentCount > 0 && currentBytes + nextBytes > limitBytes;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function writeJson(filePath, value) {
  const content = `${JSON.stringify(value)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return {
    bytes: Buffer.byteLength(content),
    sha256: sha256(content)
  };
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryAfterMs(response) {
  const raw = response.headers.get('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
