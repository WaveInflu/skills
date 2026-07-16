# @waveinflu/setup

Install or update every published WaveInflu Skill and configure the API Key used by their bundled scripts.

```bash
npx @waveinflu/setup@latest
```

The command targets Codex by default. Run it again to update existing Skills and install any newly published WaveInflu Skills while preserving the saved Key. Use `--agent <name>` for another Agent, `--reconfigure` to replace the Key, or `--status` to check local configuration without calling the WaveInflu API.

The Key is entered through a hidden prompt and stored outside projects with user-only file permissions. Never pass a Key as a command-line argument or paste it into a chat.
