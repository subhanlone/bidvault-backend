// Renders src/openapi/document.ts to openapi.json at the repo root.
//
// Imports only the contract modules, never a route file, so this runs on a bare checkout
// with no database, no Redis and no environment variables. See src/openapi/requests.ts.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { document } from '../src/openapi/document.js';

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'openapi.json');

writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

const paths = Object.keys(document.paths ?? {});
const operations = paths.reduce(
  (n, p) =>
    n +
    Object.keys((document.paths as Record<string, object>)[p]).filter((k) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(k),
    ).length,
  0,
);
const schemas = Object.keys(document.components?.schemas ?? {}).length;

console.log(`openapi.json written: ${paths.length} paths, ${operations} operations, ${schemas} schemas`);
