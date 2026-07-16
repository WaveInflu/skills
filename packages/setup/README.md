# @waveinflu/setup

Install or update both WaveInflu Skills and configure the API Key used by their bundled scripts.

```bash
npx @waveinflu/setup@latest
```

The command targets Codex by default. Use `--agent <name>` for another Agent, `--reconfigure` to replace the saved Key, or `--status` to check local configuration without calling the WaveInflu API.

The Key is entered through a hidden prompt and stored outside projects with user-only file permissions. Never pass a Key as a command-line argument or paste it into a chat.
