# WaveInflu Skills

English · [简体中文](README.zh-CN.md)

Give your Agent two focused WaveInflu capabilities—creator discovery and public contact lookup—without running an MCP server. A one-time Setup command installs the Skills and stores the API Key outside your projects.

| Skill | What it does | Quota pool |
|---|---|---|
| `waveinflu-discover-creators` | Finds and safely continues similar-creator searches on YouTube, TikTok, and Instagram | Main quota |
| `waveinflu-lookup-creator-email` | Looks up public contact emails and links for up to 50 creators | Email quota |

Requires Node.js 22 or newer.

## Quick start

### 1. Create an API Key

1. [Install WaveInflu from the Chrome Web Store](https://chromewebstore.google.com/detail/waveinflu/memenfegdnhmjipjnfndoncinlcpfenf) and sign in.
2. Open **API** in the extension's right sidebar.
3. Enter a name and issue a Key.
4. Copy it immediately—the full Key is shown only once.

### 2. Run Setup

```bash
npx @waveinflu/setup@latest
```

Setup installs or updates every published WaveInflu Skill for Codex, then asks for the Key through a hidden prompt. Restart Codex when it finishes.

Use another supported Agent when needed:

```bash
npx @waveinflu/setup@latest --agent claude-code
```

Run the same Setup command again whenever WaveInflu publishes an update. It refreshes existing WaveInflu Skills, installs newly added ones, and keeps the existing Key. To replace the Key:

```bash
npx @waveinflu/setup@latest --reconfigure
```

The Key is stored in the user configuration directory with user-only permissions. Do not paste it into a chat, pass it as a command argument, commit it, or expose it in client-side code. `WAVEINFLU_API_KEY` remains available as an environment override for CI and automation.

### 3. Ask naturally

```text
$waveinflu-discover-creators
Find 20 TikTok creators similar to https://www.tiktok.com/@example for a US skincare campaign.
```

```text
$waveinflu-lookup-creator-email
Find public contact emails for these creator profiles: https://www.youtube.com/@example and https://www.instagram.com/example/.
```

You can also omit the `$skill-name` prefix and ask in natural language when your Agent can match installed Skills. Discovery accepts a profile, a campaign brief, or both for YouTube and TikTok; Instagram discovery uses a campaign brief. Email lookup accepts 1–50 supported creator URLs.

## Quota behavior

Main quota and email quota are separate balances.

| Operation | Quota rule |
|---|---|
| YouTube discovery | 1 main quota per 3 valid results |
| TikTok discovery | 1 main quota per 5 valid results |
| Instagram discovery | 1 main quota per 2 valid results |
| TikTok email lookup | 1 email quota |
| Instagram or YouTube email lookup | 2 email quota |

Discovery reserves `ceil(requested limit ÷ platform ratio)` before recall, then charges `ceil(valid results ÷ platform ratio)` and refunds the unused reservation. Zero valid results cost zero main quota. An email lookup consumes its platform cost even when no public email is found.

Before calling, the Agent summarizes the scope and expected reservation or lookup cost. After a successful call, it reports the remaining balance returned by the server.

Creator discovery may continue up to three sequential calls when a validated successful response returns fewer unique creators than requested. It preserves every criterion, requests only the remaining target, deduplicates results, and stops at a stated total quota cap. This is continuation after successful settlement, not retrying an uncertain request.

Email lookup validates and deduplicates the full list before charging, then runs fixed waves of at most three concurrent requests. If one request has an unknown outcome, no later wave starts; requests already in that wave are allowed to settle. Neither Skill retries a timeout, malformed response, or other unknown charging outcome, and neither broadens criteria or switches platforms automatically.

## Documentation

- [API overview](https://wavely.cc/docs/api)
- [Email Lookup API](https://wavely.cc/docs/api/email-lookup)
- Similar Creators API: [YouTube](https://wavely.cc/docs/api/similar/youtube) · [TikTok](https://wavely.cc/docs/api/similar/tiktok) · [Instagram](https://wavely.cc/docs/api/similar/instagram)
- [MIT License](LICENSE)

<details>
<summary>Development</summary>

Node.js 22 or newer is required. The bundled scripts use only built-in Node.js APIs.

```bash
npx skills add . --list
npm run check
npm pack --dry-run --workspace @waveinflu/setup
```

The test suite uses a local mock server and never calls the production WaveInflu API.

</details>
