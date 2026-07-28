import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cellIdForBbox,
  mergeBboxes,
  normalizeGeometry,
  retryAfterMs,
  shouldStartNewPack
} from '../tools/lib.mjs';

test('normalizes nested polygon geometry and computes its bbox', () => {
  const result = normalizeGeometry({
    type: 'Polygon',
    coordinates: [[[7.1, 48.1], [8.2, 49.3], [7.1, 48.1]]]
  });
  assert.deepEqual(result.bbox, [7.1, 48.1, 8.2, 49.3]);
  assert.equal(result.geometry.type, 'Polygon');
});

test('rejects coordinates outside the earth bounds', () => {
  assert.equal(normalizeGeometry({ type: 'Point', coordinates: [200, 48] }), null);
});

test('uses a deterministic spatial cell from bbox center', () => {
  assert.equal(cellIdForBbox([7, 47, 9, 49], 5), 'lat-27-lon-37');
});

test('merges bounding boxes', () => {
  assert.deepEqual(
    mergeBboxes([[7, 47, 8, 48], [6, 46, 9, 49]]),
    [6, 46, 9, 49]
  );
});

test('parses numeric Retry-After', () => {
  const response = { headers: new Headers({ 'retry-after': '12' }) };
  assert.equal(retryAfterMs(response), 12_000);
});

test('splits before the next item would exceed the pack limit', () => {
  assert.equal(shouldStartNewPack(2, 800_000, 250_000, 1_000_000), true);
  assert.equal(shouldStartNewPack(0, 0, 900_000, 1_000_000), false);
  assert.throws(
    () => shouldStartNewPack(0, 0, 1_100_000, 1_000_000),
    /überschreitet/
  );
});
