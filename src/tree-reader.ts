import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateMap } from './flow.js';
import type { FlowMap } from './types.js';

/** An existing but invalid/incompatible cache is an error, never a silent recrawl. */
export async function readOrDiscoverTree(targetUrl: string, discover: () => Promise<FlowMap>, file = 'logs/tree_demo.json') {
  let contents: string;
  try { contents = await readFile(file, 'utf8'); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const map = validateMap(await discover(), targetUrl);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(map, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { map, source: 'crawler' as const, file };
  }
  return { map: validateMap(JSON.parse(contents), targetUrl), source: 'cache' as const, file };
}
