#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';
import { parseCliArgs } from './lib.mjs';

const args = parseCliArgs(process.argv.slice(2));
const statePath = String(args.state || 'state/latest-build.json');
const maxAgeDays = Math.max(1, Number(args['max-age-days'] || 27));
const force = String(args.force || '').toLowerCase() === 'true';
let state = {};
try {
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
} catch {
  state = {};
}
const lastBuildMs = Date.parse(state.lastSuccessfulBuild || '');
const ageMs = Number.isFinite(lastBuildMs) ? Date.now() - lastBuildMs : Infinity;
const shouldBuild = force || ageMs >= maxAgeDays * 24 * 60 * 60 * 1000;
const reason = force
  ? 'forced'
  : (Number.isFinite(lastBuildMs) ? `age-${Math.floor(ageMs / 86_400_000)}-days` : 'no-previous-build');

console.log(`should_build=${shouldBuild}`);
console.log(`reason=${reason}`);
