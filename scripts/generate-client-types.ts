// Generates the frontend's TypeScript types from openapi.json.
//
// This lives in the backend, not the frontend, and that is deliberate.
// openapi-typescript declares `peerDependencies.typescript: ^5.x`. The frontend is on
// TypeScript 6, so installing it there needs an npm `overrides` entry to force npm past a
// constraint the package says it does not support — a workaround, even a tested one. The
// backend is on TypeScript 5.9, which satisfies that range honestly, so the tool lives here
// and neither repo carries an override.
//
// The generated file is committed to the frontend, so nothing about a frontend install,
// build or deploy depends on this script. It is a developer step, run after the contract
// changes.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import openapiTS, { astToString } from 'openapi-typescript';

const here = dirname(fileURLToPath(import.meta.url));
const spec = join(here, '..', 'openapi.json');

// The frontend is expected as a sibling checkout. Override with API_TYPES_OUT if it is not.
const defaultOut = resolve(here, '..', '..', 'frontend', 'src', 'types', 'openapi.d.ts');
const out = process.env.API_TYPES_OUT ? resolve(process.env.API_TYPES_OUT) : defaultOut;

if (!existsSync(spec)) {
  console.error(`openapi.json not found at ${spec} — run "npm run api:contract" first.`);
  process.exit(1);
}

const outDir = dirname(out);
if (!existsSync(outDir)) {
  if (process.env.API_TYPES_OUT) {
    mkdirSync(outDir, { recursive: true });
  } else {
    console.error(
      `Frontend not found at ${outDir}.\n` +
        `Check out bidvault alongside this repo, or set API_TYPES_OUT to the target path.`,
    );
    process.exit(1);
  }
}

// Library API rather than shelling out to the CLI: Node refuses to spawn a .cmd shim on
// Windows without `shell: true`, and enabling that just to run a binary we already have
// installed would be a workaround for a problem we do not need to have.
const ast = await openapiTS(pathToFileURL(spec));

// The CLI writes its own banner; the library API does not. Ours names the command to run,
// which the CLI's generic wording does not.
const header = [
  '/**',
  ' * Generated from the backend contract. Do not edit.',
  ' *',
  ' * Source: backend/src/openapi/schemas.ts -> backend/openapi.json -> this file.',
  ' * Regenerate: in the backend, `npm run api:contract && npm run api:types`.',
  ' */',
  '',
  '',
].join('\n');

writeFileSync(out, header + astToString(ast), 'utf8');

console.log(`client types written to ${out}`);
console.log('Commit the generated file — the frontend build reads it, it does not produce it.');
