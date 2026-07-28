#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  COLLECTION_ORDER,
  COLLECTION_PATHS,
  readJson
} from './lib.mjs';

const outputDir = path.resolve(process.argv[2] || 'dist');
const MAX_PACK_BYTES = 7_000_000;
const MAX_SITE_BYTES = 950_000_000;
const GLOBAL_MINIMUMS = {
  airspaces: 20_000,
  airports: 30_000,
  navaids: 3_000,
  reportingPoints: 3_000
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function validBbox(bbox) {
  return Array.isArray(bbox)
    && bbox.length === 4
    && bbox.every(Number.isFinite)
    && bbox[0] >= -180
    && bbox[2] <= 180
    && bbox[1] >= -90
    && bbox[3] <= 90
    && bbox[0] <= bbox[2]
    && bbox[1] <= bbox[3];
}

function bboxContains(outer, inner) {
  const epsilon = 0.000001;
  return inner[0] >= outer[0] - epsilon
    && inner[1] >= outer[1] - epsilon
    && inner[2] <= outer[2] + epsilon
    && inner[3] <= outer[3] + epsilon;
}

async function main() {
  const latestPath = path.join(outputDir, 'latest.json');
  const latestRaw = await fs.readFile(latestPath, 'utf8');
  const latest = JSON.parse(latestRaw);
  assert(latest.schemaVersion === 1, 'latest.json: unbekannte schemaVersion');
  assert(
    /^cycles\/[^/]+\/manifest\.json$/.test(latest.manifest),
    'latest.json: ungültiger Manifestpfad'
  );

  const manifestPath = path.join(outputDir, latest.manifest);
  const manifestRaw = await fs.readFile(manifestPath, 'utf8');
  assert(
    sha256(manifestRaw) === latest.manifestSha256,
    'latest.json: Manifest-Prüfsumme stimmt nicht'
  );
  const manifest = JSON.parse(manifestRaw);
  assert(manifest.schemaVersion === 1, 'Manifest: unbekannte schemaVersion');
  assert(manifest.datasetVersion === latest.datasetVersion, 'Dataset-Version stimmt nicht überein');
  assert(manifest.source?.name === 'OpenAIP', 'OpenAIP-Attribution fehlt');
  assert(manifest.source?.license === 'CC BY-NC 4.0', 'Datenlizenz fehlt');

  let totalSiteBytes = Buffer.byteLength(latestRaw) + Buffer.byteLength(manifestRaw);
  const summaries = {};
  for (const collectionName of COLLECTION_ORDER) {
    const collection = manifest.collections?.[collectionName];
    if (!collection) continue;
    assert(collection.sourceCount >= collection.count, `${collectionName}: count > sourceCount`);
    assert(collection.count > 0, `${collectionName}: keine gültigen Datensätze`);
    assert(collection.packCount === collection.packs.length, `${collectionName}: falsche packCount`);
    if (manifest.scope?.type === 'global') {
      assert(
        collection.count >= GLOBAL_MINIMUMS[collectionName],
        `${collectionName}: globaler Mindestbestand unterschritten (${collection.count})`
      );
    }

    const seenIds = new Set();
    let itemCount = 0;
    let byteCount = 0;
    for (const packEntry of collection.packs) {
      const expectedPrefix = `${COLLECTION_PATHS[collectionName]}/`;
      assert(packEntry.url.startsWith(expectedPrefix), `${collectionName}: falscher Packpfad`);
      assert(validBbox(packEntry.bbox), `${packEntry.url}: ungültige Manifest-BBox`);
      const packPath = path.join(path.dirname(manifestPath), packEntry.url);
      const packRaw = await fs.readFile(packPath, 'utf8');
      const actualBytes = Buffer.byteLength(packRaw);
      assert(actualBytes === packEntry.bytes, `${packEntry.url}: Bytezahl stimmt nicht`);
      assert(actualBytes <= MAX_PACK_BYTES, `${packEntry.url}: Pack größer als 7 MB`);
      assert(sha256(packRaw) === packEntry.sha256, `${packEntry.url}: Prüfsumme stimmt nicht`);
      const pack = JSON.parse(packRaw);
      assert(pack.datasetVersion === manifest.datasetVersion, `${packEntry.url}: falsche Version`);
      assert(pack.collection === collectionName, `${packEntry.url}: falsche Sammlung`);
      assert(pack.country === packEntry.country, `${packEntry.url}: falsches Land`);
      assert(pack.count === packEntry.count, `${packEntry.url}: falsche Anzahl`);
      assert(Array.isArray(pack.items) && pack.items.length === pack.count, `${packEntry.url}: items`);
      assert(validBbox(pack.bbox), `${packEntry.url}: ungültige Pack-BBox`);
      for (const item of pack.items) {
        assert(item.id && typeof item.id === 'string', `${packEntry.url}: ID fehlt`);
        assert(!seenIds.has(item.id), `${collectionName}: doppelte ID ${item.id}`);
        seenIds.add(item.id);
        assert(validBbox(item.bbox), `${packEntry.url}: ungültige Objekt-BBox`);
        assert(bboxContains(pack.bbox, item.bbox), `${packEntry.url}: Objekt außerhalb der Pack-BBox`);
        assert(item.geometry?.type && item.geometry?.coordinates, `${packEntry.url}: Geometrie fehlt`);
      }
      itemCount += pack.items.length;
      byteCount += actualBytes;
    }
    assert(itemCount === collection.count, `${collectionName}: Packs enthalten ${itemCount}/${collection.count}`);
    totalSiteBytes += byteCount;
    summaries[collectionName] = {
      count: itemCount,
      packs: collection.packCount,
      bytes: byteCount
    };
  }

  assert(Object.keys(summaries).length > 0, 'Manifest enthält keine Sammlungen');
  assert(totalSiteBytes <= MAX_SITE_BYTES, `Pages-Datenstand größer als 950 MB (${totalSiteBytes})`);
  await readJson(path.join(outputDir, 'build-state.json'));

  console.log(JSON.stringify({
    valid: true,
    datasetVersion: manifest.datasetVersion,
    scope: manifest.scope,
    totalSiteBytes,
    collections: summaries
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
