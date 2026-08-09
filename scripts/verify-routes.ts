/**
 * Checks that openapi.json documents exactly the routes the server serves — no more, no less.
 *
 * `src/openapi/document.ts` lists paths and operations by hand. Everything else in the
 * contract chain is generated and guarded, but nothing stopped someone adding a route and
 * forgetting to document it, or leaving a path in the spec after deleting the route. This
 * closes that gap by walking the live Express router rather than parsing source, so it sees
 * exactly what is mounted.
 *
 *   npm run api:routes
 */
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';

type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  regexp?: RegExp;
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const app = createApp() as unknown as { _router?: { stack: Layer[] }; router?: { stack: Layer[] } };
const rootStack = app._router?.stack ?? app.router?.stack;
if (!rootStack) {
  console.error('Could not reach the Express router stack — internals may have changed.');
  process.exit(1);
}

/** Recover a mount prefix such as /api/v1/auctions from a router layer's regexp. */
function prefixFromRegexp(re: RegExp | undefined): string {
  if (!re) return '';
  const src = re.source;
  if (src === '^\\/?(?=\\/|$)') return '';
  return src
    .replace('^\\/?', '/')
    .replace('(?=\\/|$)', '')
    .replace(/\\\//g, '/')
    .replace(/\$$/, '')
    .replace(/\/\?$/, '');
}

const live: string[] = [];
(function walk(stack: Layer[], prefix: string) {
  for (const layer of stack) {
    if (layer.route) {
      for (const [m, on] of Object.entries(layer.route.methods)) {
        if (on) live.push(`${m.toUpperCase()} ${prefix + layer.route.path}`);
      }
    } else if (layer.handle?.stack) {
      walk(layer.handle.stack, prefix + prefixFromRegexp(layer.regexp));
    }
  }
})(rootStack, '');

// Express writes :param and carries the /api/v1 base that openapi.json keeps in `servers`.
const normalise = (entry: string) => {
  const [method, ...rest] = entry.split(' ');
  const path =
    rest
      .join(' ')
      .replace(/^\^/, '')
      .replace(/^\/api\/v1/, '')
      .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      .replace(/\/$/, '') || '/';
  return `${method} ${path}`;
};

const served = new Set(live.map(normalise));

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};
const documented = new Set<string>();
for (const [path, operations] of Object.entries(spec.paths)) {
  for (const method of Object.keys(operations)) {
    if (METHODS.includes(method)) documented.add(`${method.toUpperCase()} ${path}`);
  }
}

const undocumented = [...served].filter((r) => !documented.has(r)).sort();
const phantom = [...documented].filter((r) => !served.has(r)).sort();

console.log(`served: ${served.size}   documented: ${documented.size}`);

if (undocumented.length) {
  console.error(`\nServed but missing from openapi.json (${undocumented.length}):`);
  for (const r of undocumented) console.error(`  ${r}`);
  console.error('\nAdd these to src/openapi/document.ts, then run npm run api:contract.');
}
if (phantom.length) {
  console.error(`\nIn openapi.json but not served (${phantom.length}):`);
  for (const r of phantom) console.error(`  ${r}`);
  console.error('\nRemove these from src/openapi/document.ts, then run npm run api:contract.');
}

if (undocumented.length || phantom.length) process.exit(1);
console.log('openapi.json matches the served routes exactly.');
process.exit(0);
