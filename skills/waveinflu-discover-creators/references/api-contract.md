# Creator discovery API contract

## Request

```text
POST https://api.wavely.cc/api/v1/similar
X-WaveInflu-Api-Key: $WAVEINFLU_API_KEY
Content-Type: application/json
```

This is a synchronous, quota-charging POST with no idempotency key. Never retry it automatically.

The bundled script accepts only the fields documented below, rebuilds a clean payload, sends one request, rejects redirects, and limits response size. `WAVEINFLU_API_BASE_URL` is restricted to loopback hosts for local tests and must remain unset in normal use.

| Field | Type | Rules |
|---|---|---|
| `platform` | string | Required: `youtube`, `tiktok`, or `instagram`. |
| `seedProfileUrl` | string | Optional for YouTube/TikTok; unsupported for Instagram. |
| `contentDirection` | string | Maximum 800 characters; required without a seed and always required for Instagram. |
| `limit` | integer | Default 25; range 1–100. |
| `globalDeduplicationEnabled` | boolean | Default `true`; excludes up to 1,000 recently viewed creators. |
| `filters` | object | Optional platform-specific filters below. |

### Common filters

- `regions`: ISO alpha-2 country codes such as `US`, `GB`, or `JP`.
- `languages`: BCP 47-like language codes such as `en` or `ja`; maximum 50.
- `minFollowers`, `maxFollowers`: both must meet the platform minimum and min cannot exceed max.

### YouTube filters

- Minimum followers: 500.
- `minVideosAverageViews`, `maxVideosAverageViews`: minimum 2,000.

### TikTok filters

- Minimum followers: 1,000.
- `minVideosAverageViews`, `maxVideosAverageViews`: minimum 1,000.

### Instagram filters

- Minimum followers: 500.
- `minAverageLikeCount`, `maxAverageLikeCount`: minimum 50.
- `genders`: `male`, `female`, `unknown`.
- `ethnicities`: `white`, `black`, `asian`, `hispanic_latino`, `middle_eastern`, `indigenous`, `pacific_islander`, `multiracial`, `unknown`.
- `creatorTypes`: `solo_creator`, `couple`, `family`, `group`, `product_only`, `brand_account`, `unknown`.
- Do not send the YouTube/TikTok average-view filters.

## Response

Successful responses use this envelope:

```json
{
  "code": 1000,
  "message": "Similar creators completed",
  "data": {
    "requestId": "req_abc123",
    "platform": "tiktok",
    "mode": "direction",
    "total": 1,
    "data": [],
    "quota": {
      "totalQuota": 100,
      "usedQuota": 1,
      "remainingQuota": 99,
      "reservedQuota": 4,
      "chargedQuota": 1,
      "refundQuota": 3,
      "refundStatus": "completed"
    }
  }
}
```

Creators share `username`, `platform`, `platformHandle`, `description`, `email`, `profileUrl`, `avatar`, `similarityScore`, and optional follower/engagement/region/language fields. Platform identity fields are `channelId` for YouTube and `userId` plus `uniqueId` for TikTok/Instagram.

## Quota

Quota is reserved from `limit`, charged from valid results, and the unused reservation is refunded synchronously:

- YouTube: 1 credit per 3 valid creators.
- TikTok: 1 credit per 5 valid creators.
- Instagram: 1 credit per 2 valid creators.

Always report the server-provided final quota values; do not estimate them locally.

## Errors

| HTTP | Meaning | Agent action |
|---|---|---|
| 400 | Invalid payload or filter | Explain the invalid field. Do not resubmit without user-approved material changes. |
| 401 | Missing, invalid, or revoked API key | Ask the user to configure or replace the environment variable outside chat. |
| 403 | Insufficient main quota | Report the quota error; do not reduce `limit` and retry automatically. |
| 429 | Rate limited | Report `Retry-After` if available; do not schedule an automatic retry. |
| 500+ | Server/provider failure | Preserve `requestId` if present and report it; do not retry automatically. |

## Bundled script errors

Errors are written as JSON to stderr with a non-zero exit code. `autoRetryAllowed` is always `false`.

- `requestSent: false`: local validation failed before any API submission.
- `requestSent: true`: the server received the request, but returned an HTTP or response error.
- `requestSent: "unknown"`: a timeout, redirect rejection, or network failure occurred after the request attempt began.

Only `requestSent: false` is safe to correct locally without risking a duplicate charge. It is not permission to change the user's intended filters or count.
