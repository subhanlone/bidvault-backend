/**
 * Checks that openapi.json documents exactly the routes the server serves — no more, no less.
 *
 * `src/openapi/document.ts` lists paths and operations by hand. Everything else in the
 * contract chain is generated and guarded, but nothing stopped someone adding a route and
 * forgetting to document it, or leaving a path in the spec after deleting the route.
 *
 * Built from `app.ts`'s explicit `routeMounts` list plus each router's own flat `.stack`,
 * rather than walking the live Express router's internals to recover a mount prefix. That
 * used to work by parsing `layer.regexp.source` back into a literal string; Express 5's
 * path-to-regexp v8 rewrite replaced `.regexp` with an opaque compiled matcher function that
 * has no string form to parse at all. Every module router here is flat (no further nested
 * `router.use()`), so each layer's own `route.path` is still a literal string in Express 5 —
 * only the *mount* prefix stopped being recoverable, and that was always known statically in
 * app.ts anyway.
 *
 *   npm run api:routes
 */
import { readFileSync } from 'node:fs';
import { routeMounts } from '../src/app.js';

type Layer = { route?: { path: string; methods: Record<string, boolean> } };

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// The two routes declared directly on the app rather than through a module router — see
// app.ts. There are only two; listing them is simpler and more robust than walking `app`'s
// own router internals for exactly the same reason the mounted ones no longer can be.
const DIRECT_ROUTES = ['GET /api/v1/health', 'GET /api/v1/stats'];

const live: string[] = [...DIRECT_ROUTES];
for (const [prefix, router] of routeMounts) {
  const stack = (router as unknown as { stack: Layer[] }).stack;
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const [m, on] of Object.entries(layer.route.methods)) {
      if (on) live.push(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
    }
  }
}

// Express writes :param and carries the /api/v1 base that openapi.json keeps in `servers`.
const normalise = (entry: string) => {
  const [method, path] = entry.split(' ');
  const normalised =
    path
      .replace(/^\/api\/v1/, '')
      .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      .replace(/\/$/, '') || '/';
  return `${method} ${normalised}`;
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
