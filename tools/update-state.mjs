#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseCliArgs, readJson } from './lib.mjs';

const args = parseCliArgs(process.argv.slice(2));
const source = path.resolve(String(args.source || 'build-state.json'));
const target = path.resolve(String(args.target || 'state/latest-build.json'));
const state = await readJson(source);
if (!state.lastSuccessfulBuild || !state.datasetVersion || !state.manifestSha256) {
  throw new Error('Build-State ist unvollständig');
}
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
console.log(`Status aktualisiert: ${target}`);
