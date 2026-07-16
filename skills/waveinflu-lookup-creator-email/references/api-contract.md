# Creator email lookup API contract

## Contents

- [Endpoint and authentication](#endpoint-and-authentication)
- [Request](#request)
- [Supported URLs](#supported-urls)
- [Bundled-script boundary](#bundled-script-boundary)
- [Output formats](#output-formats)
- [Response](#response)
- [Public-data and nullable semantics](#public-data-and-nullable-semantics)
- [Quota and charging](#quota-and-charging)
- [Errors](#errors)
- [Request correlation](#request-correlation)
- [Bundled-script errors](#bundled-script-errors)

## Endpoint and authentication

```text
POST https://api.wavely.cc/api/v1/email-lookup
X-WaveInflu-Api-Key: $WAVEINFLU_API_KEY
Content-Type: application/json
```

Only `X-WaveInflu-Api-Key` authenticates this route. Generic `X-Api-Key` and bearer headers are not accepted. A valid issued Key has the `waveInflu_` prefix followed by 40 URL-safe characters.

To issue a Key, sign in to the WaveInflu browser extension, open **API** in its right sidebar, enter a name, and copy the new Key immediately. The full value is shown only once. Run `npx @waveinflu/setup@latest` in a terminal to install or update the Skills and save the Key outside project directories. Never paste it into chat. `WAVEINFLU_API_KEY` is an optional CI/automation override.

This is a synchronous, quota-charging POST. It does not accept an idempotency key or server-enforced `maxQuotaCost`. Do not retry it automatically.

## Request

The raw endpoint and atomic `lookup.mjs` accept exactly one creator profile per invocation:

```json
{
  "url": "https://www.instagram.com/example/"
}
```

The API field is a trimmed, non-empty string up to 2,048 characters. A display name, bare handle, or search query is not valid. The URL may omit its protocol or use HTTP; the atomic script normalizes every accepted identity to a canonical HTTPS profile URL before submission.

The Skill entry point `lookup-batch.mjs` accepts:

```json
{
  "urls": [
    "https://www.instagram.com/example/",
    "https://www.tiktok.com/@example"
  ],
  "maxQuotaCost": 3,
  "outputFormat": "compact"
}
```

`urls` must contain 1–50 profile URLs. `maxQuotaCost` is a required positive integer enforced locally and never sent to the API. `outputFormat` is an optional local `compact | full` field and is also never sent.

## Supported URLs

The backend and bundled script recognize these platform identities and return a canonical `profileLink`:

| Platform | Backend-recognized identity | Canonical form |
|---|---|---|
| Instagram | First non-reserved path segment on `instagram.com`, `www.instagram.com`, or `m.instagram.com`; an optional leading `@` is removed and later path segments may be present. | `https://www.instagram.com/{username}/` |
| TikTok | First path segment beginning with `@` on `tiktok.com`, `www.tiktok.com`, or `m.tiktok.com`; `/@user/video/...` is accepted. | `https://www.tiktok.com/@{uniqueId}` |
| YouTube | `/@handle`, `/channel/{id}`, `/c/{name}`, or `/user/{name}` on `youtube.com`, `www.youtube.com`, or `m.youtube.com`; later path segments may be present. | Matching canonical `www.youtube.com` profile form. |

Input such as `instagram.com/example/reels`, `http://www.tiktok.com/@example/video/123`, or `youtube.com/@example/videos` identifies one account and is normalized to that account's HTTPS profile. A content URL does not turn this into a content lookup; the quota-charging operation still targets one creator profile.

## Bundled-script boundary

The atomic script preserves the backend's safely identifiable URL range while preventing an Agent from charging the wrong identity:

- Require one JSON object with exactly one field, `url`.
- Accept a missing protocol or HTTP input and normalize it to HTTPS; reject credentials and custom ports.
- Resolve Instagram from the first username path segment, including an optional leading `@` and URLs with later segments; require a 1–30 character Instagram username made of letters, digits, dot, or underscore, and reject reserved non-account first segments such as `p`, `reel`, `stories`, or `explore`.
- Resolve TikTok from the first `/@uniqueId` segment, including `/@user/video/...`; reject discovery URLs that do not identify an account and reject unsafe identity delimiters or control characters.
- Resolve YouTube from `/@handle`, `/channel/{id}`, `/c/{name}`, or `/user/{name}`, including later path segments. Unicode identities are preserved; unsafe identity delimiters and control characters are rejected.
- Reject YouTube `/watch` and `youtu.be` URLs because they do not directly encode the creator identity required by this lookup.
- Canonicalize supported bare, `www.`, and `m.` hosts before submission.
- Require Node.js 22 or newer and the exact issued API-key format.
- Rebuild the body, make exactly one POST, reject redirects, limit response size, and never retry.

The batch script adds a bounded orchestration layer:

- Validate and canonicalize every URL before the first POST.
- Deduplicate canonical URLs while preserving first-seen order, so URL variants for the same profile are charged once.
- Calculate the complete planned cost and reject the batch before any POST when it exceeds `maxQuotaCost`.
- Run fixed waves of at most three concurrent atomic processes.
- Wait for the whole current wave to settle before starting another wave.
- Stop before the next wave if any current lookup fails or has an unknown quota outcome. Already-running requests are not aborted because aborting creates additional unknown outcomes.

With concurrency 3, a failed profile can have up to two later profiles already in flight in the same wave. No profile from a later wave is sent.

## Output formats

- `compact`: returns bounded identity fields, canonical profile URL, region, primary email, up to 10 deduplicated emails, up to 5 contact links, total email/contact counts, and per-profile quota cost. Use it for normal Agent output.
- `full`: returns complete validated API data for every profile, including platform user ID and the original quota object. This remains the direct-script default.

The Skill explicitly requests `compact` unless the user asks for complete profile records or export data.

If the script cannot safely identify one creator from the URL, ask the user for that creator's profile URL. Do not bypass the script or guess from a content ID.

`WAVEINFLU_API_BASE_URL` is only a local-test override and is restricted to loopback hosts. Leave it unset in normal use.

## Response

Success uses the standard envelope:

```json
{
  "code": 1000,
  "message": "Email lookup completed",
  "data": {
    "platform": "instagram",
    "username": "example",
    "profileLink": "https://www.instagram.com/example/",
    "platformUserId": "52942805175",
    "region": "US",
    "email": "business@example.com",
    "emails": ["business@example.com"],
    "contacts": [
      {
        "url": "https://example.com/contact",
        "type": "website"
      }
    ],
    "quota": {
      "cost": 2,
      "remainingQuota": 48
    }
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `platform` | `instagram \| tiktok \| youtube` | Platform parsed from the submitted profile. |
| `username` | `string \| null` | Username returned by the lookup provider, when available. |
| `profileLink` | string | Canonical profile URL used for lookup. |
| `platformUserId` | `string \| null` | Platform-specific immutable ID when available. |
| `region` | `string \| null` | Creator region when available. |
| `email` | `string \| null` | Primary discovered public email, or `null`. |
| `emails` | string[] | Trimmed, deduplicated discovered emails; can be empty. |
| `contacts` | object[] | Discovered contact links; can be empty. |
| `contacts[].url` | string | Non-empty external contact URL. |
| `contacts[].type` | string | Provider contact type; missing/blank provider values normalize to `website`. |
| `quota.cost` | number | Email credits charged for this lookup. |
| `quota.remainingQuota` | number | Separate email quota remaining after the charge. |

## Public-data and nullable semantics

- `email: null` means no primary public email was found. It is not a transport failure.
- `emails: []` means the provider returned no usable email list. The array is independently normalized and is not guaranteed to mirror `email` exactly.
- `contacts: []` means no usable public contact links were returned.
- `username`, `platformUserId`, and `region` may also be `null` without making the lookup fail.
- Returned data is publicly discoverable contact data. WaveInflu does not prove address ownership, consent, deliverability, or authorization to contact the person.

Never infer, synthesize, or guess a private/personal address from these fields.

## Quota and charging

Email lookup uses a separate email quota, not creator-discovery main quota.

| Platform | Fixed cost |
|---|---:|
| TikTok | 1 email credit |
| Instagram | 2 email credits |
| YouTube | 2 email credits |

The service parses the URL first, then atomically consumes the fixed platform cost before starting the lookup:

- Missing or unsupported URLs are rejected before charge.
- Insufficient email quota does not consume quota and the provider is not called.
- Any successful response consumes the full fixed cost, including `email: null`, `emails: []`, or `contacts: []`.
- If the lookup pipeline throws after consumption, the service calls the email-quota refund before returning the error. A client timeout or network failure still makes the observed quota outcome unknown.

Always report the server-returned `quota.cost` and `quota.remainingQuota` as final.

For a successful batch, report `data.chargedQuota` as the sum of deduplicated successful lookups and `data.remainingQuota` as the lowest server-returned balance across the concurrent successes. `plannedQuotaCost` is only the preflight bound; it is not an additional charge.

## Errors

Error responses normally use `{ "code": number, "message": string, "error": ... }`. Messages can be localized; use HTTP status, business code, and safe error details.

| HTTP | Meaning | Charging semantics | Agent action |
|---|---|---|---|
| 400 | Missing or unsupported creator URL | Rejected before quota consumption. | Ask for one supported URL that directly identifies the creator; do not guess or auto-resubmit. |
| 401 | Missing, invalid, or revoked API Key | Auth fails before quota consumption. | Run Setup with `--reconfigure` outside chat. |
| 403 | Insufficient email quota | No quota consumed and no lookup started. | Report the separate email-quota shortage. |
| 500+ | Lookup/provider/refund pipeline failure | The service attempts a refund after a post-consumption lookup failure; client-observed outcome may still be unknown. | Report the safe error and do not retry automatically. |

HTTP 429 is not currently a documented per-key contract for this route. Handle it defensively if an edge or future service returns it: report `Retry-After` when available and do not schedule or perform a retry.

## Request correlation

The script sends a random `X-Request-Id` for support correlation and application responses normally echo it. Unlike creator discovery, email success data does not contain a `requestId` body field. On an HTTP/read/validation failure, the script surfaces the echoed or locally generated ID as top-level `requestId`; successful stdout remains the validated JSON body only. This ID is diagnostic only and does not make the request idempotent.

## Bundled-script errors

The script writes structured JSON to stderr, exits non-zero, and always sets `autoRetryAllowed: false`.

- `requestSent: false`: local validation failed before any POST. Ask for or correct the canonical URL without changing the target profile.
- `requestSent: true`: the API returned an HTTP error or an unreadable/invalid response after the POST.
- `requestSent: "unknown"`: the request attempt encountered a timeout, redirect, or network failure; it may have reached the API and charged quota.

Only `requestSent: false` is safe to correct without duplicate-charge risk. On batch failure, `partialResults` contains successful lookups, `knownChargedQuota` excludes unknown outcomes, and `notStartedUrls` lists profiles from later waves that were never sent.

Core rule: prohibit retries whenever charging is unknown; allow new work only after successful settlement and only within explicit item, concurrency, and quota limits.
