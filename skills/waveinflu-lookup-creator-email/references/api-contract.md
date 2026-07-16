# Creator email lookup API contract

## Request

```text
POST https://api.wavely.cc/api/v1/email-lookup
X-WaveInflu-Api-Key: $WAVEINFLU_API_KEY
Content-Type: application/json
```

This is a synchronous, quota-charging POST with no idempotency key. Never retry it automatically.

The bundled script accepts exactly one `url`, converts supported profile variants to a canonical URL, sends one request, rejects redirects, and limits response size. `WAVEINFLU_API_BASE_URL` is restricted to loopback hosts for local tests and must remain unset in normal use.

The request body accepts exactly one supported creator profile URL:

```json
{
  "url": "https://www.instagram.com/example/"
}
```

Supported platforms are Instagram, TikTok, and YouTube. Handles or display names without a profile URL are not accepted.

## Response

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
    "contacts": [],
    "quota": {
      "cost": 2,
      "remainingQuota": 48
    }
  }
}
```

`email`, `username`, `platformUserId`, and `region` can be `null`. `emails` and `contacts` can be empty. An empty email result is still a successful paid lookup.

## Quota

- TikTok: 1 email credit.
- Instagram: 2 email credits.
- YouTube: 2 email credits.

Use `data.quota.cost` and `data.quota.remainingQuota` as the final server-provided values.

## Errors

| HTTP | Meaning | Agent action |
|---|---|---|
| 400 | Missing or unsupported profile URL | Ask for a supported profile URL. Do not guess an account. |
| 401 | Missing, invalid, or revoked API key | Ask the user to configure or replace the environment variable outside chat. |
| 403 | Insufficient email quota | Report the email quota error; do not confuse it with creator-discovery quota. |
| 429 | Rate limited | Report `Retry-After` if available; do not schedule an automatic retry. |
| 500+ | Lookup pipeline failure | Report the error; do not retry automatically. |

## Bundled script errors

Errors are written as JSON to stderr with a non-zero exit code. `autoRetryAllowed` is always `false`.

- `requestSent: false`: local validation failed before any API submission.
- `requestSent: true`: the server received the request, but returned an HTTP or response error.
- `requestSent: "unknown"`: a timeout, redirect rejection, or network failure occurred after the request attempt began.

Only `requestSent: false` is safe to correct locally without risking a duplicate charge. V1 still permits only one creator profile per invocation.
