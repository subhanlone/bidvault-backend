// Generates the frontend's TypeScript types from openapi.json.
//
// This deliberately uses no third-party generator. openapi-typescript pulls in
// @redocly/openapi-core, which pins a js-yaml with an unpatched CVE and cannot be moved
// without an npm override; @hey-api/openapi-ts carries advisories of its own that only
// `npm audit fix --force` clears. Both would mean shipping a known-vulnerable transitive
// dependency or overriding around it. Neither is acceptable for a codegen step this small.
//
// The whole surface we emit is the JSON Schema that zod-openapi produces from
// src/openapi/schemas.ts: objects, arrays, enums, consts, $refs, anyOf unions and
// additionalProperties records. Validation keywords (min/max/pattern/format) carry no type
// information and are ignored on purpose.
//
// The emitter throws on anything it does not recognise rather than guessing, so a new
// construct fails the build instead of silently producing a wrong type.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

type Schema = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, '..', 'openapi.json');

// The frontend is expected as a sibling checkout; override with API_TYPES_OUT.
const defaultOut = resolve(here, '..', '..', 'frontend', 'src', 'types', 'openapi.d.ts');
const out = process.env.API_TYPES_OUT ? resolve(process.env.API_TYPES_OUT) : defaultOut;

if (!existsSync(specPath)) {
  console.error(`openapi.json not found at ${specPath} — run "npm run api:contract" first.`);
  process.exit(1);
}

const outDir = dirname(out);
if (!existsSync(outDir)) {
  if (process.env.API_TYPES_OUT) mkdirSync(outDir, { recursive: true });
  else {
    console.error(
      `Frontend not found at ${outDir}.\n` +
        `Check out bidvault alongside this repo, or set API_TYPES_OUT to the target path.`,
    );
    process.exit(1);
  }
}

type Operation = {
  responses: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};

type RequestBody = { content?: Record<string, { schema?: Schema }> };

const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};
const schemas = spec.components.schemas;

const refName = (ref: string): string => {
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) throw new Error(`unsupported $ref: ${ref}`);
  const name = ref.slice(prefix.length);
  if (!(name in schemas)) throw new Error(`$ref points at an unknown schema: ${name}`);
  return name;
};

const quote = (v: unknown): string =>
  typeof v === 'string' ? JSON.stringify(v) : v === null ? 'null' : String(v);

/** A TS identifier can be written bare; anything else needs quoting as a property key. */
const propKey = (k: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));

function toType(schema: Schema, indent: string, path: string): string {
  if (typeof schema.$ref === 'string') return refName(schema.$ref);

  if (Array.isArray(schema.anyOf)) {
    const parts = (schema.anyOf as Schema[]).map((s, i) => toType(s, indent, `${path}.anyOf[${i}]`));
    return [...new Set(parts)].join(' | ');
  }
  if (Array.isArray(schema.oneOf)) {
    const parts = (schema.oneOf as Schema[]).map((s, i) => toType(s, indent, `${path}.oneOf[${i}]`));
    return [...new Set(parts)].join(' | ');
  }

  if ('const' in schema) return quote(schema.const);

  if (Array.isArray(schema.enum)) {
    return (schema.enum as unknown[]).map(quote).join(' | ');
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    // e.g. type: ["string","null"]
    return [...new Set(type.map((t) => toType({ ...schema, type: t }, indent, path)))].join(' | ');
  }

  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      if (!schema.items) throw new Error(`array without items at ${path}`);
      const inner = toType(schema.items as Schema, indent, `${path}[]`);
      // Parenthesise unions so `A | B[]` cannot be misread.
      return /[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
    }
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      const required = new Set((schema.required as string[] | undefined) ?? []);
      const addl = schema.additionalProperties;

      if (Object.keys(props).length === 0) {
        // A record: additionalProperties carries the value type.
        if (addl && typeof addl === 'object') {
          return `Record<string, ${toType(addl as Schema, indent, `${path}{}`)}>`;
        }
        if (addl === false) return 'Record<string, never>';
        return 'Record<string, unknown>';
      }

      const inner = indent + '  ';
      const lines: string[] = ['{'];
      for (const [key, value] of Object.entries(props)) {
        const doc = typeof value.description === 'string' ? value.description : undefined;
        if (doc) {
          const wrapped = doc.trim().split('\n');
          lines.push(`${inner}/**`);
          for (const l of wrapped) lines.push(`${inner} * ${l.trim()}`);
          lines.push(`${inner} */`);
        }
        const optional = required.has(key) ? '' : '?';
        lines.push(`${inner}${propKey(key)}${optional}: ${toType(value, inner, `${path}.${key}`)};`);
      }
      lines.push(`${indent}}`);
      return lines.join('\n');
    }
  }

  // An empty schema — or one carrying only validation keywords — constrains nothing.
  // JSON Schema says that means "any value"; zod-openapi emits it for z.unknown().
  // Checked explicitly rather than used as a fallback, so a schema with a type we do not
  // handle still throws instead of silently degrading to `unknown`.
  const TYPE_BEARING = ['type', '$ref', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'properties', 'items', 'additionalProperties'];
  if (!TYPE_BEARING.some((k) => k in schema)) return 'unknown';

  throw new Error(
    `unsupported schema at ${path}: ${JSON.stringify(schema).slice(0, 200)}\n` +
      `Extend scripts/generate-client-types.ts rather than letting this emit a wrong type.`,
  );
}

const header = `/**
 * Generated from the backend contract. Do not edit.
 *
 * Source: backend/src/openapi/schemas.ts -> backend/openapi.json -> this file.
 * Regenerate: in the backend, \`npm run api:contract && npm run api:types\`.
 *
 * Emitted by backend/scripts/generate-client-types.ts, which has no dependencies —
 * see that file for why no third-party generator is used.
 */
`;

const blocks: string[] = [header];

for (const name of Object.keys(schemas).sort()) {
  const schema = schemas[name];
  const doc = typeof schema.description === 'string' ? schema.description : undefined;
  if (doc) blocks.push(`/** ${doc.trim()} */`);
  blocks.push(`export type ${name} = ${toType(schema, '', name)};\n`);
}

// ---- endpoint maps ------------------------------------------------------------------
//
// Response types keyed by OpenAPI path, so the api client can infer what a URL returns
// rather than taking the caller's word for it. What is emitted is the `data` inside the
// envelope, because the client unwraps the envelope before returning.
//
// Every operation in this contract has exactly one 2xx response, always JSON, always
// enveloped. That is asserted rather than assumed: a response breaking the pattern fails
// the build here instead of quietly emitting a wrong type.
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const rows: Record<(typeof METHODS)[number], string[]> = {
  get: [], post: [], put: [], patch: [], delete: [],
};

let operationCount = 0;
for (const path of Object.keys(spec.paths).sort()) {
  const operations = spec.paths[path];
  for (const method of METHODS) {
    const op = operations[method];
    if (!op) continue;

    const where = `${method.toUpperCase()} ${path}`;
    const success = Object.keys(op.responses ?? {}).filter((c) => c.startsWith('2'));
    if (success.length !== 1) {
      throw new Error(
        `${where}: expected exactly one 2xx response, found ${success.length || 'none'}`,
      );
    }

    const body = op.responses[success[0]].content?.['application/json']?.schema;
    if (!body) throw new Error(`${where}: 2xx response has no application/json schema`);

    const data = (body.properties as Record<string, Schema> | undefined)?.data;
    if (!data) throw new Error(`${where}: 2xx response is not enveloped - no \`data\` property`);

    rows[method].push(`  ${JSON.stringify(path)}: ${toType(data, '  ', where)};`);
    operationCount++;
  }
}

for (const method of METHODS) {
  const name = `${method[0].toUpperCase()}${method.slice(1)}Endpoints`;
  blocks.push(
    `/** What each documented ${method.toUpperCase()} returns, unwrapped from the response envelope. */`,
  );
  blocks.push(
    rows[method].length
      ? `export interface ${name} {\n${rows[method].join('\n')}\n}\n`
      : `export interface ${name} {}\n`,
  );
}

// ---- request body maps ----------------------------------------------------------------
//
// The same idea applied to the other direction. Responses have been keyed by path since the
// typed client landed; request bodies were still `unknown`, so the contract described
// fourteen request shapes that nothing on the client side checked against.
//
// Only paths that actually document a JSON body appear here. The seven that do not —
// approve, approve-all, read, read-all, the watchlist add, upload-signature and the Stripe
// webhook — are absent on purpose, and api.ts turns that absence into "this call takes no
// body" rather than "this call takes anything".
const BODY_METHODS = ['post', 'put', 'patch'] as const;
const requestRows: Record<(typeof BODY_METHODS)[number], string[]> = { post: [], put: [], patch: [] };

let requestCount = 0;
for (const path of Object.keys(spec.paths).sort()) {
  for (const method of BODY_METHODS) {
    const op = spec.paths[path][method] as (Operation & { requestBody?: RequestBody }) | undefined;
    if (!op) continue;

    const schema = op.requestBody?.content?.['application/json']?.schema;
    if (!schema) continue;

    requestRows[method].push(
      `  ${JSON.stringify(path)}: ${toType(schema, '  ', `${method.toUpperCase()} ${path} body`)};`,
    );
    requestCount++;
  }
}

for (const method of BODY_METHODS) {
  const name = `${method[0].toUpperCase()}${method.slice(1)}Requests`;
  blocks.push(`/** The body each documented ${method.toUpperCase()} expects. */`);
  blocks.push(
    requestRows[method].length
      ? `export interface ${name} {\n${requestRows[method].join('\n')}\n}\n`
      : `export interface ${name} {}\n`,
  );
}

writeFileSync(out, blocks.join('\n'), 'utf8');

console.log(
  `client types written to ${out} ` +
    `(${Object.keys(schemas).length} schemas, ${operationCount} operations, ` +
    `${requestCount} request bodies, 0 dependencies)`,
);
console.log('Commit the generated file — the frontend build reads it, it does not produce it.');
