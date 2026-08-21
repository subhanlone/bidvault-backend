# Contract decisions

Why the API contract is built the way it is, and what was rejected.

Recorded so these are not re-argued from scratch. Each one names the evidence it rests on;
if that evidence changes, the decision should be revisited rather than defended. Companion
to [COMPATIBILITY.md](./COMPATIBILITY.md), which covers what counts as a breaking change.

---

## 1. Code-first, not design-first — TypeSpec declined

**Decision.** The Zod schemas the server validates with are the source of truth.
`openapi.json` is generated from them; the frontend's types are generated from that.

**Rejected.** [TypeSpec](https://typespec.io/) as the source, emitting OpenAPI, with Zod
demoted to request parsing.

**Why.** Generating the spec from the schemas the server actually enforces makes
server-versus-spec drift *structurally impossible* — not caught, impossible. TypeSpec inverts
that: `main.tsp` becomes truth and the server's agreement with it has to be re-established by
enforcement. That is a real property to give up.

The OpenAPI Initiative does say design-first matters, and it does. But its two
recommendations are separable. On **authoring** it advises against hand-writing a large
description and recommends "editors, domain-specific languages, or code annotations" — Zod
with `.meta()` is exactly that, so we already comply. The remaining half is **sequence**: a
contract agreed before code exists. With one consumer and one developer, what that sequence
actually buys is a moment where someone decides the contract may change — and that is
reconstructed by COMPATIBILITY.md, the oasdiff gate, and the `info.version` bump.

**Revisit when** a second consumer appears, or someone outside this project depends on the
contract. Then the decision point needs to move earlier than implementation, and the
structural guarantee is worth trading. The migration criterion is known: TypeSpec is done
when it emits an `openapi.json` the existing diff gate accepts unchanged.

## 2. Our own type emitter, not a third-party generator

**Decision.** `scripts/generate-client-types.ts` — 275 lines, zero dependencies —
reads `openapi.json` and emits the frontend's `openapi.d.ts`.

**Rejected**, each tested rather than assumed, on 2026-08-09 and re-tested against
TypeScript 6:

| Candidate | Verdict |
|---|---|
| `openapi-typescript` | pulls `@redocly/openapi-core`, which pins `js-yaml@4.3.0` exactly — unpatched CVE, unreachable without an npm override |
| `@hey-api/openapi-ts` | correct peer range, but 4 high advisories of its own and 51 packages |
| `orval` | genuinely clean — 0 advisories, output typechecks on TS 6 — but 130 packages, and it would rewrite `services/api.ts` and every call site |
| `kubb`, `swagger-typescript-api` | also clean; same size objection |

**Why.** The surface we need is small and completely known: it is whatever `zod-openapi`
produces from our schemas. The emitter throws on any construct it does not recognise rather
than guessing, which is how the `additionalProperties: {}` case was found. Correctness was
established, not asserted — all 54 schemas were proven structurally identical in both
directions to `openapi-typescript`'s previous output.

**Revisit when** TanStack Query lands. Kubb generates hooks and MSW mocks alongside types,
and at that point three things come from one place instead of one. That is a real argument
that does not apply today.

## 3. Our own response validator, not express-openapi-validator

**Decision.** `src/middleware/response-contract.ts` validates every response against the
schema published for it.

**Rejected.** [`express-openapi-validator`](https://github.com/cdimascio/express-openapi-validator)
with `validateResponses: true`. It fits on paper — Express 4.21, OAS 3.1 supported since
v5.4.0, 0 advisories.

**Why.** 110 packages, and they would sit in the *production* tree: the backend ships 180
packages today, so this is a 61% increase in what runs in the request path, to check
something already in memory. (Contrast the test harness, which added roughly 90 — all
devDependencies, none of which ship.) It would also validate the *JSON Schema translation*
of our schemas, one step further from the truth. Our middleware reads
`documentInput`, the document as authored, so it checks the very Zod objects `openapi.json`
is generated from. The published contract and the enforced rule cannot describe different
things because they are the same objects.

## 4. Contract violations are recorded, never thrown

**Decision.** A response that does not match its schema is logged and recorded; the response
is served as the handler wrote it. Tests drain the record after each request and fail on
anything in it.

**Rejected.** Throwing — which is what the first version did.

**Why.** Two reasons, one principled and one discovered the hard way. A contract violation is
a defect in the contract or the handler, not in the request; failing the response turns a
documentation problem into an outage for whoever happened to be calling. And it does not even
report: the throw reaches `errorHandler`, whose own `res.json` re-enters the check, throws
again, and Express gives up with an empty 500 that names nothing.

## 5. oasdiff's default severities, unmodified

**Decision.** No severity-levels file, no ignore list. See COMPATIBILITY.md for the
per-classification reasoning and the two worked examples.

**Why.** All ten classifications this API produces were read out of `oasdiff checks
changelog` and are right in every case. Where oasdiff departs from Azure's guidelines — it
treats adding a response property as informational, Azure calls it breaking — oasdiff is
correct for an API with one generated consumer that does not validate responses at runtime.

Pinned to `tufin/oasdiff:v1.29.1`, not `:latest`, so an upstream reclassification cannot
change what this build permits without a commit here.

## 6. Schemathesis declined

**Decision.** Contract conformance is checked by the test suite (every route, seeded data)
and by `api:verify` (live server, real data).

**Rejected.** [Schemathesis](https://schemathesis.io/), which generates thousands of requests
from the spec and is strictly stronger at finding conformance bugs.

**Why.** It is a fuzzer that issues writes. There is no staging environment, and development
and production share one Redis instance — a fact that has already destroyed a production job
once. Pointing a fuzzer at production would be reckless, and pointing it anywhere else
requires infrastructure that does not exist yet.

**Revisit when** there is a staging environment with its own Redis.

## 7. `api:verify` is read-only and not in CI

**Decision.** It checks all 18 read routes against a running server; the only writes are a
login and the logout that revokes it. It is run by hand, typically around a deploy.

**Why not mutating.** Pointing the mutating routes at production would create real listings,
bids and payments. Their response shapes are the test suite's job.

**Why not in CI.** CI has no deployment to point it at, and running it against a
locally-booted server would re-check what the suite already checks with the same middleware
against the same schemas. Its unique value is *real data* — a column that went null years
ago, a row from before a field existed. Fixtures cannot fail that way.

## 8. Accepted advisories are self-expiring

**Decision.** `scripts/audit-gate.mjs` fails on any advisory not recorded in
`audit-allowlist.json`, and equally on a recorded entry that no longer matches an advisory.

**Why the second half.** An exception with no expiry is just a note nobody reads again. When
upstream ships the fix, the build breaks and says to delete the entry. The one current entry,
`deepmerge-ts` / CVE-2026-40345, carries its own reachability analysis and the upstream PR.

## 9. Cross-repo checkout is an anonymous clone

**Decision.** Both CI workflows bring the sibling repo in with
`git clone --depth 1 --branch master https://github.com/...`.

**Rejected.** `actions/checkout` with `repository:`. Its own README says the job's
`GITHUB_TOKEN` is scoped to the current repository and a PAT is needed for another one. Both
repos are public, so an unauthenticated clone sidesteps the question entirely and keeps both
workflows free of secrets.
