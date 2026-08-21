# API compatibility

What counts as a breaking change to this API, and what to do when you need to make one.

This exists because none of the automated gates could be configured without it. A tool can
tell you the contract changed; only a policy can say whether that change was allowed.

## What makes this API unusual

Three things, and they push in different directions.

**There is exactly one consumer, and it is generated.** `frontend/src/types/openapi.d.ts` is
emitted from `openapi.json`, which is emitted from the Zod schemas the server validates with.
No third party holds a copy of this contract. That makes some changes that would be breaking
for a public API harmless here — a client that cannot have hand-written assumptions cannot
have them violated.

**The two halves deploy separately, and not atomically.** The backend redeploys on a push to
`bidvault-backend`, the frontend on a push to `bidvault`. Between those two pushes the
deployed pair is mismatched. This is the hazard that actually bites, and it is why the
deploy-order section below matters more than the breaking/non-breaking distinction.

**Neither repo has branch protection.** A red CI run does not block a deploy — Railway and
Vercel build on push regardless. Every gate described here is advisory in the strict sense.
They tell you that you broke something; they do not stop you shipping it.

## The definition

**oasdiff's default severities are the definition, unmodified.** There is no severity-levels
file and no ignore list.

That was a decision, not laziness. The defaults were checked against the cases this API
actually produces, and they are right in every one:

| Change | oasdiff | Correct here? |
|---|---|---|
| response: optional property added | info | yes — the generated type gains `foo?:`, nothing breaks |
| response: required property added | info | yes — the client ignores what it does not read |
| response: required property removed | **error** | yes — the client reads it and gets `undefined` |
| response: optional property removed | warning | yes — depends whether anything read it |
| response: property became optional | **error** | yes, and see the worked example below |
| response: property became required | info | yes — a stronger promise |
| response: property became nullable | **error** | yes — the type said it never was |
| request: body became required | **error** | yes — existing callers send none |
| request: body became optional | info | yes — a weaker demand |
| request: required property added | **error** | yes — existing callers omit it |

Note the departure from Azure's REST guidelines, which call *any* response property addition
breaking on the grounds that a client may validate strictly or hash the whole body. That is
sound advice for an API with unknown consumers. This API has one consumer, it is generated
from this contract, and it does not validate responses at runtime. So the addition cases stay
informational.

If a future change makes one of these classifications wrong, change it in a severity-levels
file with a comment saying why — do not silence the check.

## Deploy order is the thing to get right

Breaking-vs-not is about clients that never update. Both of ours update; they just do not
update *simultaneously*. So the practical question is which half can go first.

**Additions: backend first.** A new field, a new route, a wider accepted value. If the
frontend ships first it references something the API does not serve yet.

**Removals: frontend first.** Stop reading the field, ship that, then remove it server-side.
Backend first means a deployed frontend reading a field that has stopped arriving.

That is expand/contract, and it means a rename is two deployments in each direction, never
one: add the new field, move the frontend to it, remove the old one.

**A breaking change with no expand/contract path needs both pushed together and a moment of
mismatch accepted.** Push the backend first, push the frontend immediately after, and know
that requests in that window may fail. For this project, at this stage, that is usually fine —
but it should be a decision, not a surprise.

## Making a breaking change on purpose

The oasdiff gate fails the build on any `error`-level change. To make one anyway, **bump
`info.version` in `src/openapi/document.ts`.**

The gate treats an unbumped version as "you did not mean to do this" and a bumped one as "you
did". That is the whole mechanism: it does not judge whether the change is wise, only whether
someone decided.

`info.version` was `1.0.0` from the contract's first publication on 2026-08-09 until
2026-08-21. Use semver against the *contract*, not the product:

- **patch** — nothing in the wire contract changed (docs, descriptions, summaries)
- **minor** — additive, or the document catching up with what the server already did
- **major** — the server's behaviour changed in a way that can break a caller

An oasdiff error means you must bump *something*. Which level is a judgment the tool cannot
make for you, because it compares two documents and cannot know whether the server's
behaviour actually moved. Tightening a rule the handler already enforced makes the document
more accurate without changing a single response — that is a minor bump, not a major one. Do
not let that reasoning become a habit, though: "the server already did this" is also exactly
what a real break sounds like from the inside. Write down which one it was.

## Worked example: `codeExpiresAt`

On 2026-08-20 `OtpIssued.codeExpiresAt` went from required to optional. oasdiff calls that
`response-property-became-optional`, an error, on both `POST /auth/forgot-password` and
`POST /auth/resend-verification`.

It was breaking by the general rule and harmless in fact. Both routes have a neutral early
exit that answers without an expiry — deliberately, since a timestamp would confirm the
account exists — so the contract had been describing a response the server never sent. And
the one consumer already treated the field as optional: `AuthContext` typed it `?` and
`config/otp.ts` documents the fallback.

The right handling was not to reclassify the check. It was to make the change knowingly, with
the reason recorded next to the schema. The check did its job by asking.

## Worked example: `transactionId` minLength

The first change the gate ever examined was its own predecessor commit, and it failed it.

Moving `POST /payments/create-intent`'s request schema out of `document.ts` and into
`requests.ts` changed `z.string()` to `z.string().min(1)`, so `transactionId` went from
minLength 0 to 1. oasdiff calls that `request-property-min-length-increased`, an error: the
set of accepted requests got smaller.

It is right that it asked, and the honest answer is that no caller could notice. The old
handler opened with `if (!transactionId) return 400`, so an empty string was already refused
— by hand, below the schema, which was the defect being fixed. The document moved to match
the server; the server did not move.

So: `1.0.0` -> `1.1.0`, minor, with the reason recorded beside the version. Not major,
because nothing a caller can observe changed.

The pattern to notice is that the gate turned a change that looked like tidying into a
question worth answering. That is the whole job.

## Where each rule is enforced

| Gate | Catches | Where |
|---|---|---|
| `npm run api:contract` + diff | `openapi.json` stale against the schemas | backend CI |
| `npm run api:routes` | a route served but undocumented, or documented but not served | backend CI |
| `response-contract` middleware | a response that does not match its published schema | every test request |
| frontend type sync | the committed client types are not what this contract produces | both repos' CI |
| oasdiff + version bump | a breaking change nobody acknowledged | backend CI |
| `npm run api:verify` | the running API disagrees with the contract | manual, against production |

The first four say *the contract and the code disagree*. Only the fifth can say *you changed
the contract and may not have meant to* — which is the guarantee design-first gets from having
a human agree the contract up front, reconstructed here at the point where it matters.
