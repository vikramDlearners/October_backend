import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const file = `${config.dataDir}/watches.json`;

// Read-modify-write calls run one at a time so the scheduler and the API never overwrite each other.
let queue = Promise.resolve();

export async function readWatches() {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeWatches(watches) {
  await mkdir(config.dataDir, { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(watches, null, 2));
  await rename(tmp, file);
}

// fn may change the array in place; its return value is passed through.
export function mutate(fn) {
  const run = queue.then(async () => {
    const watches = await readWatches();
    const result = await fn(watches);
    await writeWatches(watches);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}
