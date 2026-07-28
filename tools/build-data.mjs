#!/usr/bin/env node

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import {
  COLLECTION_ORDER,
  COLLECTION_PATHS,
  SOURCE_INFO,
  asFiniteNumber,
  cellIdForBbox,
  cleanCountry,
  cleanText,
  compactObject,
  mergeBboxes,
  normalizeGeometry,
  parseCliArgs,
  parseCsv,
  retryAfterMs,
  roundNumber,
  sha256,
  shouldStartNewPack,
  sleep,
  writeJson
} from './lib.mjs';

const PAGE_SIZE = 250;
const args = parseCliArgs(process.argv.slice(2));
const outputDir = path.resolve(String(args.output || process.env.OUTPUT_DIR || 'dist'));
const sourceBase = String(
  args['source-base']
  || process.env.OPENAIP_SOURCE_BASE
  || 'https://ga-proxy.einherjer.workers.dev/api'
).replace(/\/+$/, '');
const countries = parseCsv(
  args.countries || process.env.COUNTRIES,
  (country) => country.toUpperCase()
);
const requestedCollections = parseCsv(args.collections || process.env.COLLECTIONS);
const collections = requestedCollections.length ? requestedCollections : COLLECTION_ORDER;
const invalidCollections = collections.filter((name) => !COLLECTION_ORDER.includes(name));
if (invalidCollections.length) {
  throw new Error(`Unbekannte Sammlungen: ${invalidCollections.join(', ')}`);
}
const requestDelayMs = Math.max(0, Number(
  args['request-delay-ms']
  || process.env.REQUEST_DELAY_MS
  || 300
));
const cellSpanDegrees = Math.max(1, Math.min(20, Number(
  args['cell-span-degrees']
  || process.env.CELL_SPAN_DEGREES
  || 5
)));
const maxPackBytes = Math.max(1_000_000, Number(
  args['max-pack-bytes']
  || process.env.MAX_PACK_BYTES
  || 6_000_000
));
const generatedAt = new Date().toISOString();
const datasetVersion = cleanText(
  args['dataset-version']
  || process.env.DATASET_VERSION
  || `snapshot-${generatedAt.slice(0, 10)}`,
  80
);
if (!/^[a-z0-9][a-z0-9._-]+$/i.test(datasetVersion)) {
  throw new Error(`Ungültige dataset-version: ${datasetVersion}`);
}

const CONFIG = {
  airspaces: {
    endpoint: 'airspaces',
    fields: [
      '_id', 'name', 'type', 'icaoClass', 'activity', 'onDemand', 'onRequest',
      'byNotam', 'specialAgreement', 'requestCompliance', 'country', 'geometry',
      'upperLimit', 'lowerLimit', 'frequencies', 'updatedAt'
    ],
    normalize: normalizeAirspace
  },
  airports: {
    endpoint: 'airports',
    fields: [
      '_id', 'name', 'icaoCode', 'iataCode', 'altIdentifier', 'type', 'country',
      'geometry', 'elevation', 'frequencies', 'runways', 'ppr', 'private',
      'skydiveActivity', 'winchOnly', 'updatedAt'
    ],
    normalize: normalizeAirport
  },
  navaids: {
    endpoint: 'navaids',
    fields: [
      '_id', 'name', 'identifier', 'type', 'country', 'geometry', 'elevation',
      'frequency', 'channel', 'range', 'magneticDeclination', 'updatedAt'
    ],
    normalize: normalizeNavaid
  },
  reportingPoints: {
    endpoint: 'reporting-points',
    fields: [
      '_id', 'name', 'compulsory', 'country', 'airports', 'geometry',
      'elevation', 'updatedAt'
    ],
    normalize: normalizeReportingPoint
  }
};

function pickValueWithUnit(value) {
  if (!value || typeof value !== 'object') return undefined;
  const numericValue = asFiniteNumber(value.value);
  const textValue = cleanText(value.value, 40);
  if (numericValue === null && !textValue) return undefined;
  return compactObject({
    value: numericValue ?? textValue,
    unit: asFiniteNumber(value.unit) ?? undefined,
    referenceDatum: asFiniteNumber(value.referenceDatum) ?? undefined
  });
}

function pickFrequencies(frequencies) {
  if (!Array.isArray(frequencies)) return undefined;
  const result = frequencies.map((frequency) => compactObject({
    id: cleanText(frequency?._id || frequency?.id, 100) || undefined,
    value: cleanText(frequency?.value, 40) || undefined,
    unit: asFiniteNumber(frequency?.unit) ?? undefined,
    type: asFiniteNumber(frequency?.type) ?? undefined,
    name: cleanText(frequency?.name, 120) || undefined,
    primary: typeof frequency?.primary === 'boolean' ? frequency.primary : undefined,
    publicUse: typeof frequency?.publicUse === 'boolean' ? frequency.publicUse : undefined
  })).filter((frequency) => frequency.value || frequency.name);
  return result.length ? result : undefined;
}

function pickRunways(runways) {
  if (!Array.isArray(runways)) return undefined;
  const result = runways.map((runway) => compactObject({
    id: cleanText(runway?._id || runway?.id, 100) || undefined,
    designator: cleanText(runway?.designator, 20) || undefined,
    trueHeading: roundNumber(runway?.trueHeading, 2) ?? undefined,
    alignedTrueNorth: typeof runway?.alignedTrueNorth === 'boolean'
      ? runway.alignedTrueNorth
      : undefined,
    operations: asFiniteNumber(runway?.operations) ?? undefined,
    mainRunway: typeof runway?.mainRunway === 'boolean' ? runway.mainRunway : undefined,
    turnDirection: asFiniteNumber(runway?.turnDirection) ?? undefined,
    takeOffOnly: typeof runway?.takeOffOnly === 'boolean' ? runway.takeOffOnly : undefined,
    landingOnly: typeof runway?.landingOnly === 'boolean' ? runway.landingOnly : undefined,
    surface: compactObject({
      composition: Array.isArray(runway?.surface?.composition)
        ? runway.surface.composition.map(asFiniteNumber).filter((value) => value !== null)
        : undefined,
      mainComposite: asFiniteNumber(runway?.surface?.mainComposite) ?? undefined,
      condition: asFiniteNumber(runway?.surface?.condition) ?? undefined,
      pcn: cleanText(runway?.surface?.pcn, 80) || undefined
    }),
    dimension: compactObject({
      length: pickValueWithUnit(runway?.dimension?.length),
      width: pickValueWithUnit(runway?.dimension?.width)
    }),
    declaredDistance: compactObject({
      tora: pickValueWithUnit(runway?.declaredDistance?.tora),
      toda: pickValueWithUnit(runway?.declaredDistance?.toda),
      asda: pickValueWithUnit(runway?.declaredDistance?.asda),
      lda: pickValueWithUnit(runway?.declaredDistance?.lda)
    }),
    pilotCtrlLighting: typeof runway?.pilotCtrlLighting === 'boolean'
      ? runway.pilotCtrlLighting
      : undefined,
    visualApproachAids: Array.isArray(runway?.visualApproachAids)
      ? runway.visualApproachAids.map(asFiniteNumber).filter((value) => value !== null)
      : undefined
  })).filter((runway) => runway.designator || runway.dimension?.length);
  return result.length ? result : undefined;
}

function normalizeBase(raw) {
  const normalized = normalizeGeometry(raw?.geometry);
  if (!normalized) return null;
  const id = cleanText(raw?._id || raw?.id, 100);
  if (!id) return null;
  return {
    id,
    name: cleanText(raw?.name, 180) || undefined,
    country: cleanCountry(raw?.country),
    geometry: normalized.geometry,
    bbox: normalized.bbox,
    updatedAt: cleanText(raw?.updatedAt, 50) || undefined
  };
}

function normalizeAirspace(raw) {
  const base = normalizeBase(raw);
  if (!base || !base.name) return null;
  return compactObject({
    ...base,
    type: asFiniteNumber(raw?.type) ?? undefined,
    icaoClass: asFiniteNumber(raw?.icaoClass) ?? undefined,
    activity: asFiniteNumber(raw?.activity) ?? undefined,
    onDemand: typeof raw?.onDemand === 'boolean' ? raw.onDemand : undefined,
    onRequest: typeof raw?.onRequest === 'boolean' ? raw.onRequest : undefined,
    byNotam: typeof raw?.byNotam === 'boolean' ? raw.byNotam : undefined,
    specialAgreement: typeof raw?.specialAgreement === 'boolean'
      ? raw.specialAgreement
      : undefined,
    requestCompliance: typeof raw?.requestCompliance === 'boolean'
      ? raw.requestCompliance
      : undefined,
    upperLimit: pickValueWithUnit(raw?.upperLimit),
    lowerLimit: pickValueWithUnit(raw?.lowerLimit),
    frequencies: pickFrequencies(raw?.frequencies)
  });
}

function normalizeAirport(raw) {
  const base = normalizeBase(raw);
  if (!base || !base.name) return null;
  return compactObject({
    ...base,
    icaoCode: cleanText(raw?.icaoCode, 12).toUpperCase() || undefined,
    iataCode: cleanText(raw?.iataCode, 12).toUpperCase() || undefined,
    altIdentifier: cleanText(raw?.altIdentifier, 30).toUpperCase() || undefined,
    type: asFiniteNumber(raw?.type) ?? undefined,
    elevation: pickValueWithUnit(raw?.elevation),
    frequencies: pickFrequencies(raw?.frequencies),
    runways: pickRunways(raw?.runways),
    ppr: typeof raw?.ppr === 'boolean' ? raw.ppr : undefined,
    private: typeof raw?.private === 'boolean' ? raw.private : undefined,
    skydiveActivity: typeof raw?.skydiveActivity === 'boolean'
      ? raw.skydiveActivity
      : undefined,
    winchOnly: typeof raw?.winchOnly === 'boolean' ? raw.winchOnly : undefined
  });
}

function normalizeNavaid(raw) {
  const base = normalizeBase(raw);
  const identifier = cleanText(raw?.identifier, 30).toUpperCase();
  if (!base || (!base.name && !identifier)) return null;
  return compactObject({
    ...base,
    identifier: identifier || undefined,
    type: asFiniteNumber(raw?.type) ?? undefined,
    elevation: pickValueWithUnit(raw?.elevation),
    frequency: pickValueWithUnit(raw?.frequency),
    channel: cleanText(raw?.channel, 40) || undefined,
    range: pickValueWithUnit(raw?.range),
    magneticDeclination: roundNumber(raw?.magneticDeclination, 3) ?? undefined
  });
}

function normalizeReportingPoint(raw) {
  const base = normalizeBase(raw);
  if (!base || !base.name) return null;
  const airportIds = Array.isArray(raw?.airports)
    ? raw.airports.map((id) => cleanText(id, 100)).filter(Boolean)
    : [];
  return compactObject({
    ...base,
    compulsory: typeof raw?.compulsory === 'boolean' ? raw.compulsory : undefined,
    airports: airportIds.length ? airportIds : undefined,
    elevation: pickValueWithUnit(raw?.elevation)
  });
}

function buildPageUrl(collection, page, country = '') {
  const config = CONFIG[collection];
  const url = new URL(`${sourceBase}/${config.endpoint}`);
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('fields', config.fields.join(','));
  if (country) url.searchParams.set('country', country);
  return url;
}

async function fetchJsonWithRetry(url, context) {
  let lastError = null;
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'GA-Dispatcher-Aviation-Data-Builder/1.0'
        },
        signal: AbortSignal.timeout(60_000)
      });
      // Das await gehört absichtlich in den try-Block: Eine Verbindung kann auch
      // erst beim Lesen/Dekomprimieren des JSON-Bodys abbrechen. Dann muss exakt
      // diese Seite denselben Retry-Pfad wie ein HTTP-503 durchlaufen.
      if (response.ok) return await response.json();
      const retryable = response.status === 408
        || response.status === 425
        || response.status === 429
        || response.status >= 500;
      lastError = new Error(`${context}: HTTP ${response.status}`);
      if (!retryable || attempt === 7) break;
      const waitMs = Math.max(
        retryAfterMs(response),
        Math.min(60_000, 1000 * (2 ** (attempt - 1)))
      );
      console.warn(`${lastError.message}; Retry ${attempt}/7 in ${waitMs} ms`);
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      if (attempt === 7) break;
      const waitMs = Math.min(60_000, 1000 * (2 ** (attempt - 1)));
      console.warn(`${context}: ${error.message}; Retry ${attempt}/7 in ${waitMs} ms`);
      await sleep(waitMs);
    }
  }
  throw lastError || new Error(`${context}: Abruf fehlgeschlagen`);
}

async function fetchScope(collection, country, onPage) {
  const label = `${collection}${country ? `/${country}` : '/global'}`;
  const first = await fetchJsonWithRetry(buildPageUrl(collection, 1, country), `${label} Seite 1`);
  if (!Array.isArray(first?.items)) {
    throw new Error(`${label}: ungültige API-Antwort`);
  }
  const sourceCount = Math.max(0, Number(first.totalCount) || first.items.length);
  const totalPages = Math.max(1, Number(first.totalPages) || Math.ceil(sourceCount / PAGE_SIZE));
  if (totalPages > 10_000) {
    throw new Error(`${label}: unplausible Seitenzahl ${totalPages}`);
  }
  let loadedCount = first.items.length;
  await onPage(first.items);
  console.log(`${label}: Seite 1/${totalPages}, ${loadedCount}/${sourceCount}`);
  for (let page = 2; page <= totalPages; page += 1) {
    await sleep(requestDelayMs);
    const payload = await fetchJsonWithRetry(
      buildPageUrl(collection, page, country),
      `${label} Seite ${page}`
    );
    if (!Array.isArray(payload?.items)) {
      throw new Error(`${label} Seite ${page}: ungültige API-Antwort`);
    }
    loadedCount += payload.items.length;
    await onPage(payload.items);
    console.log(`${label}: Seite ${page}/${totalPages}, ${loadedCount}/${sourceCount}`);
  }
  if (loadedCount !== sourceCount) {
    throw new Error(`${label}: ${loadedCount} von ${sourceCount} Datensätzen geladen`);
  }
  return { sourceCount, rawCount: loadedCount };
}

async function fetchCollection(collection, onPage) {
  if (!countries.length) return fetchScope(collection, '', onPage);
  const aggregate = { sourceCount: 0, rawCount: 0 };
  for (const country of countries) {
    const result = await fetchScope(collection, country, onPage);
    aggregate.sourceCount += result.sourceCount;
    aggregate.rawCount += result.rawCount;
    await sleep(requestDelayMs);
  }
  return aggregate;
}

async function createCollectionStager(collection) {
  const config = CONFIG[collection];
  const stagingDir = path.join(outputDir, '.staging', collection);
  await fs.rm(stagingDir, { recursive: true, force: true });
  const groups = new Map();
  const seenIds = new Set();
  let invalidCount = 0;
  let duplicateCount = 0;
  let validCount = 0;

  async function addPage(rawItems) {
    const pageLines = new Map();
    for (const raw of rawItems) {
      const normalized = config.normalize(raw);
      if (!normalized) {
        invalidCount += 1;
        continue;
      }
      if (seenIds.has(normalized.id)) {
        duplicateCount += 1;
        continue;
      }
      seenIds.add(normalized.id);
      validCount += 1;
      const country = normalized.country;
      const cell = cellIdForBbox(normalized.bbox, cellSpanDegrees);
      const key = `${country}/${cell}`;
      let group = groups.get(key);
      if (!group) {
        const stagePath = path.join(stagingDir, country, `${cell}.ndjson`);
        group = {
          key,
          country,
          cell,
          stagePath,
          count: 0,
          itemBytes: 0
        };
        groups.set(key, group);
      }
      const line = JSON.stringify(normalized);
      group.count += 1;
      group.itemBytes += Buffer.byteLength(line) + 1;
      if (!pageLines.has(key)) pageLines.set(key, []);
      pageLines.get(key).push(line);
    }
    for (const [key, lines] of pageLines) {
      const group = groups.get(key);
      await fs.mkdir(path.dirname(group.stagePath), { recursive: true });
      await fs.appendFile(group.stagePath, `${lines.join('\n')}\n`, 'utf8');
    }
  }

  async function finalize(sourceCount, rawCount, cycleDir) {
    const packEntries = [];
    const collectionPath = COLLECTION_PATHS[collection];
    const targetItemBytes = Math.max(100_000, maxPackBytes - 100_000);

    for (const group of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      const willSplit = group.itemBytes > targetItemBytes;
      let items = [];
      let itemBytes = 0;
      let partIndex = 0;

      async function flushPack() {
        if (!items.length) return;
        const suffix = willSplit ? `-${String(partIndex + 1).padStart(2, '0')}` : '';
        const relativePath = `${collectionPath}/${group.country}/${group.cell}${suffix}.json`;
        const packBbox = mergeBboxes(items.map((item) => item.bbox));
        const pack = {
          schemaVersion: 1,
          datasetVersion,
          generatedAt,
          collection,
          country: group.country,
          bbox: packBbox,
          count: items.length,
          source: SOURCE_INFO,
          items
        };
        const filePath = path.join(cycleDir, relativePath);
        const fileMeta = await writeJson(filePath, pack);
        if (fileMeta.bytes > maxPackBytes) {
          throw new Error(`${relativePath} ist mit ${fileMeta.bytes} Bytes zu groß`);
        }
        packEntries.push({
          id: `${group.country}/${group.cell}${suffix}`,
          url: relativePath,
          country: group.country,
          bbox: packBbox,
          count: items.length,
          bytes: fileMeta.bytes,
          sha256: fileMeta.sha256
        });
        partIndex += 1;
        items = [];
        itemBytes = 0;
      }

      const lines = createInterface({
        input: createReadStream(group.stagePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });
      for await (const line of lines) {
        if (!line) continue;
        const lineBytes = Buffer.byteLength(line) + 1;
        let startNewPack = false;
        try {
          startNewPack = shouldStartNewPack(
            items.length,
            itemBytes,
            lineBytes,
            targetItemBytes
          );
        } catch (error) {
          throw new Error(`${group.key}: ${error.message}`);
        }
        if (startNewPack) {
          await flushPack();
        }
        items.push(JSON.parse(line));
        itemBytes += lineBytes;
      }
      await flushPack();
    }

    await fs.rm(stagingDir, { recursive: true, force: true });
    console.log(
      `${collection}: ${validCount}/${sourceCount} gültig, `
      + `${invalidCount} ungültig, ${duplicateCount} doppelt, ${packEntries.length} Packs`
    );
    assertFetchCounts(sourceCount, rawCount, validCount, invalidCount, duplicateCount, collection);
    return {
      sourceCount,
      count: validCount,
      invalidCount,
      duplicateCount,
      packCount: packEntries.length,
      packs: packEntries
    };
  }

  return { addPage, finalize };
}

function assertFetchCounts(sourceCount, rawCount, validCount, invalidCount, duplicateCount, collection) {
  if (sourceCount !== rawCount) {
    throw new Error(`${collection}: ${rawCount} von ${sourceCount} Quelldatensätzen verarbeitet`);
  }
  if (validCount + invalidCount + duplicateCount !== rawCount) {
    throw new Error(
      `${collection}: Bilanzfehler (${validCount} + ${invalidCount} + ${duplicateCount} != ${rawCount})`
    );
  }
}

/*
 * Die Rohseiten werden sofort normalisiert und als NDJSON je Land/Zelle
 * zwischengelagert. Beim finalen Packen ist dadurch höchstens ein einzelnes
 * Zielpack im Speicher, unabhängig von der Größe des globalen Datenstands.
 */
async function buildCollection(collection, cycleDir) {
  const stager = await createCollectionStager(collection);
  const fetched = await fetchCollection(collection, (items) => stager.addPage(items));
  return stager.finalize(fetched.sourceCount, fetched.rawCount, cycleDir);
}

function buildIndexHtml(manifest) {
  const rows = Object.entries(manifest.collections).map(([name, collection]) => (
    `<tr><td>${name}</td><td>${collection.count.toLocaleString('en-US')}</td>`
    + `<td>${collection.packCount.toLocaleString('en-US')}</td></tr>`
  )).join('');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GA Dispatcher Aviation Data</title>
<style>
body{font:16px/1.45 system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;color:#17212b}
table{border-collapse:collapse;width:100%}th,td{padding:.55rem;border-bottom:1px solid #d8dee4;text-align:left}
code{background:#f3f4f6;padding:.15rem .3rem;border-radius:4px}
</style>
<h1>GA Dispatcher Aviation Data</h1>
<p>Dataset <code>${manifest.datasetVersion}</code>, generated ${manifest.generatedAt}.</p>
<table><thead><tr><th>Collection</th><th>Records</th><th>Packs</th></tr></thead><tbody>${rows}</tbody></table>
<p><a href="latest.json">latest.json</a> · Source: <a href="${SOURCE_INFO.url}">OpenAIP</a>
(${SOURCE_INFO.license})</p>
<p>Not for operational navigation. Use current official aeronautical information.</p>
`;
}

async function main() {
  await fs.rm(outputDir, { recursive: true, force: true });
  const cycleDir = path.join(outputDir, 'cycles', datasetVersion);
  await fs.mkdir(cycleDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    datasetVersion,
    generatedAt,
    cadenceDays: 28,
    scope: countries.length ? { type: 'countries', countries } : { type: 'global' },
    packCellSpanDegrees: cellSpanDegrees,
    source: {
      ...SOURCE_INFO,
      api: sourceBase
    },
    collections: {}
  };

  for (const collection of collections) {
    manifest.collections[collection] = await buildCollection(collection, cycleDir);
  }

  const manifestPath = path.join(cycleDir, 'manifest.json');
  const manifestMeta = await writeJson(manifestPath, manifest);
  const latest = {
    schemaVersion: 1,
    datasetVersion,
    generatedAt,
    scope: manifest.scope,
    manifest: `cycles/${datasetVersion}/manifest.json`,
    manifestBytes: manifestMeta.bytes,
    manifestSha256: manifestMeta.sha256
  };
  await writeJson(path.join(outputDir, 'latest.json'), latest);
  await fs.writeFile(path.join(outputDir, 'index.html'), buildIndexHtml(manifest), 'utf8');
  await fs.writeFile(path.join(outputDir, '.nojekyll'), '', 'utf8');
  await writeJson(path.join(outputDir, 'build-state.json'), {
    schemaVersion: 1,
    lastSuccessfulBuild: generatedAt,
    datasetVersion,
    manifestSha256: manifestMeta.sha256,
    scope: manifest.scope,
    collections: Object.fromEntries(
      Object.entries(manifest.collections).map(([name, value]) => [
        name,
        { sourceCount: value.sourceCount, count: value.count, packCount: value.packCount }
      ])
    )
  });

  const totalRecords = Object.values(manifest.collections)
    .reduce((sum, collection) => sum + collection.count, 0);
  const totalPacks = Object.values(manifest.collections)
    .reduce((sum, collection) => sum + collection.packCount, 0);
  console.log(
    `Fertig: ${datasetVersion}, ${totalRecords} Datensätze in ${totalPacks} Packs, `
    + `Manifest ${manifestMeta.sha256.slice(0, 12)}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
