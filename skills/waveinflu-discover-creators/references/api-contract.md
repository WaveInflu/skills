# Creator discovery API contract

## Contents

- [Endpoint and authentication](#endpoint-and-authentication)
- [Bundled-script boundary](#bundled-script-boundary)
- [Bounded continuation](#bounded-continuation)
- [Request](#request)
- [Output formats](#output-formats)
- [Modes and seed URLs](#modes-and-seed-urls)
- [Filters and retrieval rules](#filters-and-retrieval-rules)
- [Deduplication and ranking](#deduplication-and-ranking)
- [Quota settlement](#quota-settlement)
- [Response](#response)
- [Email field](#email-field)
- [Errors and charging](#errors-and-charging)
- [Bundled-script errors](#bundled-script-errors)

## Endpoint and authentication

```text
POST https://api.wavely.cc/api/v1/similar
X-WaveInflu-Api-Key: $WAVEINFLU_API_KEY
Content-Type: application/json
```

Only `X-WaveInflu-Api-Key` authenticates this route. Generic `X-Api-Key` and bearer headers are not accepted. A valid Key has the `waveInflu_` prefix followed by 40 URL-safe characters.

To issue a Key, sign in to the WaveInflu browser extension, open **API** in its right sidebar, enter a name, and copy the new Key immediately. The full value is shown only once. Run `npx @waveinflu/setup@latest` in a terminal to install or update the Skills and save the Key outside project directories. Never paste it into chat. `WAVEINFLU_API_KEY` is an optional CI/automation override.

The endpoint is synchronous and quota-charging. It does not accept an idempotency key or server-enforced `maxQuotaCost`. Do not retry it automatically. The script sends a random `X-Request-Id` for support correlation and application responses normally echo it. This ID is diagnostic only and does not make a request idempotent.

## Bundled-script boundary

`discover.mjs` is the atomic charging boundary. It rebuilds a clean payload, makes exactly one POST, rejects redirects, limits input and response sizes, and never retries. `discover-bounded.mjs` is the Skill entry point: it validates the full plan first, then starts a fresh atomic process for each allowed continuation.

It is intentionally stricter than the raw API:

| Concern | Raw API | Bundled script |
|---|---|---|
| `platform` | Defaults to `youtube` when omitted. | Must be explicitly `youtube`, `tiktok`, or `instagram`. |
| Numeric input | Some numeric strings are coerced. | `limit` and numeric filters must be JSON integers. |
| Seed protocol | Backend validation accepts HTTP or HTTPS supported URLs. | Requires HTTPS and rejects credentials or custom ports. |
| Fields | Top-level and `filters` objects are strict. | Applies the same allowlist before anything is sent. |
| API key | Authenticates an active issued key. | Also checks the exact issued-key format locally. |
| Runtime | Any conforming HTTP client can call the API. | Requires Node.js 22 or newer. |

`WAVEINFLU_API_BASE_URL` is only a local-test override and is restricted to loopback hosts. Leave it unset in normal use.

## Bounded continuation

The bounded script accepts the normal discovery request plus a required local `maxQuotaCost` integer. This field is never sent to the API. It is enforced before every atomic process.

- Maximum three sequential POSTs for one user instruction.
- The first POST uses the requested `limit`. A later POST is allowed only after a validated successful response and requests at most the remaining unique target.
- Each later request preserves platform, seed, brief, filters, and `globalDeduplicationEnabled` exactly.
- Results are accumulated and deduplicated across calls by `channelId` for YouTube or `userId` for TikTok/Instagram. A higher-scoring duplicate replaces the older copy, and final unique results are globally sorted by descending `similarityScore`.
- Stop on target reached, three calls, local quota cap, zero new unique creators, or any failed/unknown response.
- A timeout, network failure, unreadable body, invalid response, redirect, or HTTP error never triggers another call.

This distinction is fundamental: a continuation starts only after the previous request returned a validated success with settled quota; a retry repeats a request whose quota outcome may be unknown. Retries remain prohibited.

## Request

| Field | Type | Rules |
|---|---|---|
| `platform` | `youtube \| tiktok \| instagram` | Required by the script. |
| `seedProfileUrl` | string | YouTube/TikTok only; maximum 256 characters. |
| `contentDirection` | string | Plain-language campaign brief; maximum 800 characters. |
| `limit` | integer | Default 25; range 1–100. |
| `globalDeduplicationEnabled` | boolean | Default `true`. |
| `filters` | object | Optional strict object; supported keys are listed below. |

`discover-bounded.mjs` also requires `maxQuotaCost`. It must cover the initial reservation, `ceil(limit / platform ratio)`. The recommended default is that initial reservation plus 2 credits, which permits the rounding overhead of splitting a successful target across at most three calls without allowing duplicate-heavy continuation to run freely.

## Output formats

`discover-bounded.mjs` accepts a local `outputFormat` field that is never sent to the API:

- `compact`: intended for normal Agent lists and tables. Returns bounded identity fields, profile URL, score, available audience and engagement metrics, region, language, public email, a 180-character content summary, and up to four values for each available Instagram content category.
- `full`: returns every validated creator field from the API. This remains the script default for direct callers; the Skill explicitly requests `compact` unless the user needs detailed profiles or export data.

Both formats use the same ranking, deduplication, quota accounting, and continuation rules.

For `contentDirection`, preserve the user's campaign intent as prose. Do not add inferred demographic requirements or silently broaden the brief.

## Modes and seed URLs

| Platform | Inputs | Returned `mode` |
|---|---|---|
| YouTube/TikTok | `contentDirection` only | `direction` |
| YouTube/TikTok | `seedProfileUrl` only | `homepage` |
| YouTube/TikTok | seed plus direction | `homepage_direction` |
| Instagram | `contentDirection` only | `direction` |

Instagram rejects `seedProfileUrl` and always requires `contentDirection`.

The bundled script accepts these HTTPS seeds:

- YouTube handle: `https://www.youtube.com/@handle`, optionally ending in `/videos`, `/shorts`, `/streams`, `/about`, or `/featured`.
- YouTube channel ID: `https://www.youtube.com/channel/UC...`, optionally with the same suffixes.
- TikTok profile: `https://www.tiktok.com/@uniqueId`. Content/video URLs are rejected.

The script canonicalizes supported `m.` and non-`www` hosts to `www` before submission.

## Filters and retrieval rules

### Common filters

| Field | Type | Rules |
|---|---|---|
| `regions` | string[] | Valid ISO alpha-2 countries; normalized to uppercase. |
| `languages` | string[] | BCP 47-like codes, each at most 20 characters; normalized to lowercase; at most 50 values. |
| `minFollowers` / `maxFollowers` | non-negative integer | Both obey the platform floor; min cannot exceed max. |

Empty arrays are omitted by the script. Duplicate region, language, and enum values are removed locally.

### Platform filter matrix

| Platform | Follower floor | Engagement filters | Engagement floor | Fixed active window |
|---|---:|---|---:|---:|
| YouTube | 500 | `minVideosAverageViews`, `maxVideosAverageViews` | 2,000 average views | Last 183 days |
| TikTok | 1,000 | `minVideosAverageViews`, `maxVideosAverageViews` | 1,000 average plays | Last 90 days |
| Instagram | 500 | `minAverageLikeCount`, `maxAverageLikeCount` | 50 average likes | Last 365 days |

The active window is fixed by the backend and is not a public request field. Instagram rejects average-view filters. YouTube and TikTok reject Instagram-only engagement and demographic filters.

### Instagram enum filters

- `genders`: `male`, `female`, `unknown`.
- `ethnicities`: `white`, `black`, `asian`, `hispanic_latino`, `middle_eastern`, `indigenous`, `pacific_islander`, `multiracial`, `unknown`.
- `creatorTypes`: `solo_creator`, `couple`, `family`, `group`, `product_only`, `brand_account`, `unknown`.

These are hard filters. Send them only when the user explicitly asks for the corresponding constraint.

## Deduplication and ranking

- With `globalDeduplicationEnabled: true`, the backend excludes up to the 1,000 most recently viewed creators for the same user and platform.
- Returned creators are scheduled to be marked as viewed. Marking is best-effort and may complete after the HTTP response.
- Results are deduplicated by platform user ID, keeping the highest-scoring hit, then sorted by descending score.
- YouTube and TikTok return scores greater than or equal to `0.7`.
- Instagram returns scores strictly greater than `0.85`.
- `total` is the final `data.length` after score filtering, deduplication, and the requested limit.

Setting global deduplication to `false` only disables viewed-history exclusion; it does not disable result-set deduplication.

## Quota settlement

Creator discovery uses the main creator-search quota, not email lookup quota.

| Platform | Valid creators per credit (`r`) | Reserved before retrieval | Charged after success |
|---|---:|---:|---:|
| YouTube | 3 | `ceil(limit / 3)` | `ceil(total / 3)` |
| TikTok | 5 | `ceil(limit / 5)` | `ceil(total / 5)` |
| Instagram | 2 | `ceil(limit / 2)` | `ceil(total / 2)` |

For `total = 0`, charged quota is 0. The normal successful settlement is:

```text
refundQuota = reservedQuota - chargedQuota
```

The account must have enough main quota for the full reservation before retrieval begins. Unused reservation is refunded synchronously; `refundStatus` is `completed` when a refund occurred and `not_required` when none was needed.

State the deterministic initial reservation and local total cap before the call. The raw API still has no server-enforced spend ceiling, so the bounded script clips every continuation to the remaining local budget and stops before another process when no budget remains. Always report the aggregate `quota.chargedQuota` and last server-returned `remainingQuota`.

## Response

Success uses the standard envelope:

```json
{
  "code": 1000,
  "message": "Similar creators completed",
  "data": {
    "requestId": "123e4567-e89b-42d3-a456-426614174000",
    "platform": "tiktok",
    "mode": "direction",
    "contentDirection": "US skincare creators",
    "total": 1,
    "data": [
      {
        "username": "Example Creator",
        "platform": "tiktok",
        "platformHandle": "@example",
        "userId": "7300000000000000000",
        "uniqueId": "example",
        "nickname": "Example Creator",
        "description": "Practical skincare reviews",
        "email": "",
        "profileUrl": "https://www.tiktok.com/@example",
        "avatar": "https://example.invalid/avatar.jpg",
        "similarityScore": 0.91,
        "followerCount": 25000,
        "averagePlayCount": 8000,
        "region": "US",
        "language": "en"
      }
    ],
    "quota": {
      "totalQuota": 100,
      "usedQuota": 11,
      "remainingQuota": 89,
      "reservedQuota": 1,
      "chargedQuota": 1,
      "refundQuota": 0,
      "refundStatus": "not_required"
    }
  }
}
```

### Search result fields

| Field | Type | Meaning |
|---|---|---|
| `requestId` | string | WaveInflu request ID for support and monitoring. |
| `platform` | enum | Platform used for retrieval and response formatting. |
| `mode` | enum | `direction`, `homepage`, or `homepage_direction`. |
| `seedProfileUrl` | string, optional | Returned when a seed was supplied. |
| `sourceUserId` | string, optional | Resolved source channel/user ID for seed modes. |
| `contentDirection` | string, optional | Returned when a brief was supplied. |
| `total` | integer | Number of returned creators; equals `data.length`. |
| `data` | array | Ranked creators. |
| `quota.totalQuota` | number | Main quota allocation after settlement. |
| `quota.usedQuota` | number | Main quota used after settlement. |
| `quota.remainingQuota` | number | Main quota remaining after settlement. |
| `quota.reservedQuota` | number | Amount reserved from `limit`. |
| `quota.chargedQuota` | number | Amount charged from `total`. |
| `quota.refundQuota` | number | Unused reservation returned. |
| `quota.refundStatus` | enum | `not_required` or `completed`. |

### Bounded response

`discover-bounded.mjs` returns the same creator objects in `data.data`, plus:

| Field | Meaning |
|---|---|
| `data.targetCount` | Original requested result count. |
| `data.complete` | Whether unique results reached the target. |
| `data.outputFormat` | `compact` or `full`. |
| `data.continuation.calls` | Per-call request ID, requested limit, returned count, new unique count, and charged quota. |
| `data.continuation.maxCalls` | Fixed at 3. |
| `data.continuation.maxQuotaCost` | Local total spend cap. |
| `data.continuation.stopReason` | `target_reached`, `max_calls_reached`, `quota_cap_reached`, or `no_new_unique_results`. |
| `data.quota.reservedQuota` | Sum of successful call reservations. |
| `data.quota.chargedQuota` | Sum of successful call charges. |
| `data.quota.refundQuota` | Sum of successful call refunds. |
| `data.quota.remainingQuota` | Account balance returned by the last successful call. |

### Fields common to every creator

| Field | Type | Meaning |
|---|---|---|
| `username` | string | Display name or username. |
| `platform` | enum | `youtube`, `tiktok`, or `instagram`. |
| `platformHandle` | string | Platform-formatted handle. |
| `description` | string | Description, signature, or generated creator profile; may be empty. |
| `email` | string | Publicly discoverable contact email; empty when unavailable. |
| `profileUrl` | string | Normalized profile URL. |
| `avatar` | string | Avatar URL; may be empty. |
| `similarityScore` | number | Match score used for ranking. |
| `followerCount` | number, optional | Followers/subscribers when available. |
| `averagePlayCount` | number, optional | Average views/plays when available. |
| `averageLikeCount` | number, optional | Average likes when available. |
| `lastPublishedTime` | number, optional | Unix timestamp in seconds. |
| `region` | string, optional | Normalized creator region when available. |
| `language` | string, optional | Creator language when available. |

### Platform fields

| Platform | Fields |
|---|---|
| YouTube | `channelId` (string), `channelTitle` (string). |
| TikTok | `userId` (string), `uniqueId` (string), `nickname` (optional string). |
| Instagram | `userId` (string); optional `fullName`, `biography`, `followingCount`, `gender`, `ethnicity`, `creatorType`, `faceVisibility`, `contentVerticals`, `contentFormats`, `visualStyles`. |

Instagram `faceVisibility` values are `clear_face`, `partial_face`, `no_face`, `mixed`, or `unknown`. The three content-profile fields are optional string arrays.

## Email field

For YouTube and TikTok, WaveInflu may hydrate `email` from cached creator-email inventory; Instagram uses the email already stored with its creator inventory. This discovery response does not run a separate quota-charging email lookup.

An email can be empty, stale, or associated with publicly visible contact data without proving account ownership. Never call the email-lookup Skill automatically when this field is empty.

## Errors and charging

Error responses normally use `{ "code": number, "message": string, "error": ... }`. Messages can be localized; rely on HTTP status, business code, and safe error details.

| HTTP | Point in flow | Charging semantics | Agent action |
|---|---|---|---|
| 400 | JSON, schema, seed-format, or filter validation | Route-level validation is rejected before reservation. A source-resolution error after reservation triggers an attempted full refund. | Correct only local/schema mistakes; do not change intent or resubmit automatically. |
| 401 | Missing, invalid, or revoked API Key | Auth fails before reservation. | Run Setup with `--reconfigure` outside chat. |
| 403 | Insufficient main quota | Reservation is not consumed. | Report insufficient main quota; do not lower `limit` and retry automatically. |
| 500+ | Retrieval or settlement failure | If quota was reserved, the service attempts a full refund; a client-side timeout still leaves the outcome unknown. | Report the error and request ID when available; do not retry automatically. |

Any service failure after a successful reservation follows the same attempted-full-refund path, regardless of whether its final HTTP status is 400 or 500+. Do not infer refund success from an interrupted client connection.

HTTP 429 is not currently a documented per-key contract for this route. Handle it defensively if an edge or future service returns it: report `Retry-After` when available and do not schedule or perform a retry.

## Bundled-script errors

The script writes structured JSON to stderr, exits non-zero, and always sets `autoRetryAllowed: false`.

- `requestSent: false`: local validation failed before any POST. Correct the payload locally without changing user intent.
- `requestSent: true`: the API returned an HTTP error or an unreadable/invalid response after the POST.
- `requestSent: "unknown"`: the request attempt encountered a timeout, redirect, or network failure; it may have reached the API and charged quota.

Post-attempt errors include the generated or echoed top-level `requestId` for correlation when available. It must never be used as permission to retry.

Only `requestSent: false` is safe to correct without duplicate-charge risk. When a later continuation fails, the bounded error includes successful `partialData`, completed-call count, known charged quota, and the failed call number; it never starts the next call.
