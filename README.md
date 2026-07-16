# WaveInflu Skills

Official Agent Skills for finding similar creators and looking up public creator business emails with the WaveInflu API.

| Skill | Capability | Quota |
|---|---|---|
| `waveinflu-discover-creators` | Find similar YouTube, TikTok, or Instagram creators | Main quota |
| `waveinflu-lookup-creator-email` | Look up one creator's public business email and contact links | Email quota |

Both API operations are quota-charging POST requests. The bundled Node.js scripts make exactly one request, never retry automatically, and return the server-reported remaining quota.

## Requirements

- Node.js 22 or newer.
- A WaveInflu API key created in the WaveInflu extension.
- Codex, Claude Code, Cursor, or another agent compatible with Agent Skills.

No WaveInflu CLI or MCP server is required.

## Install

Install both skills globally for detected agents:

```bash
npx skills add waveinflu/skills --global
```

Install both skills for Codex without prompts:

```bash
npx skills add waveinflu/skills \
  --global \
  --agent codex \
  --skill waveinflu-discover-creators waveinflu-lookup-creator-email \
  --yes
```

For local development, list the skills from a checkout without installing them:

```bash
npx skills add /absolute/path/to/waveinflu-skills --list
```

Restart the agent if it does not detect newly installed skills.

## Configure the API key

Set the key only in the terminal that launches the agent. Do not paste it into an AI conversation, commit it, or save it in a project `.env` file.

macOS or Linux with Bash/Zsh:

```bash
printf 'WaveInflu API Key: '
IFS= read -rs WAVEINFLU_API_KEY
printf '\n'
export WAVEINFLU_API_KEY
```

PowerShell 7:

```powershell
$env:WAVEINFLU_API_KEY = Read-Host "WaveInflu API Key" -MaskInput
```

Launch the agent from the same terminal, for example:

```bash
codex
```

## Use

Explicit creator discovery:

```text
$waveinflu-discover-creators
Find 20 TikTok creators similar to https://www.tiktok.com/@example for a US skincare campaign.
```

Explicit email lookup:

```text
$waveinflu-lookup-creator-email
Find the public business email for https://www.youtube.com/@example.
```

Natural-language requests can also trigger the matching skill automatically. Before a paid call, the agent states the requested count or lookup cost. A timeout or malformed response is treated as an unknown paid outcome and is never retried without a new user request.

## Security and billing behavior

- The API key is read only from `WAVEINFLU_API_KEY` and is never accepted in stdin JSON.
- Production requests are fixed to `https://api.wavely.cc`; redirects are rejected so the key cannot be forwarded to another origin.
- `WAVEINFLU_API_BASE_URL` accepts loopback hosts only and exists solely for local tests. End users should leave it unset.
- Input is rebuilt from strict allowlists before submission. Unknown fields are rejected locally.
- Empty results, HTTP errors, timeouts, and response errors do not trigger retries, pagination, filter broadening, or cross-platform calls.
- If a key may have leaked, revoke it in WaveInflu and issue a replacement. Do not post it in a public issue.

## Update or remove

```bash
npx skills update --global \
  waveinflu-discover-creators \
  waveinflu-lookup-creator-email
```

```bash
npx skills remove --global \
  waveinflu-discover-creators \
  waveinflu-lookup-creator-email
```

## Development

The scripts use only Node.js built-in APIs. Run syntax checks and local mock-server tests with:

```bash
npm run check
```

The test suite never calls the production WaveInflu API or consumes quota.

## License

The Skill content and bundled client scripts are available under the [MIT License](LICENSE). The license does not grant API access or alter WaveInflu authentication, quota, billing, data-use, or service terms.
