# Antigravity Quota Status Bar

Keep an eye on your Antigravity AI quota without leaving your editor. This extension shows your model quota pools in the status bar of VS Code and Antigravity IDE, with a detailed tooltip on hover.

Models that share a quota are grouped into one pool, so you see one entry per pool instead of one for every reasoning tier (Low, Medium, High).

| Pool | Models |
| --- | --- |
| **Gemini** | Gemini Flash and Pro, all reasoning tiers |
| **Claude & GPT** | Anthropic and OpenAI models |
| **Argon** | Gemini 4 Argon. Hidden automatically if your editor doesn't offer it |

## Features

- **Pool-level view**: one percentage per quota pool, with no duplicates.
- **Daily and weekly windows**: show the 5-hour rolling quota, the weekly quota, or both.
- **Reset countdown**: optionally show time until reset (`1h 45m`, `3d 4h`).
- **Rich tooltip**: hover for a table with status dots, usage bars and reset times.
- **Quick menu**: click the status bar item to toggle pools and display options without opening settings.
- **Zero configuration**: finds the running Antigravity Language Server automatically.

## Requirements

Antigravity IDE (or the Antigravity extension) must be running, because quota data comes from its local language server.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `antigravityQuota.showDaily` | `true` | Show the daily (5-hour) quota |
| `antigravityQuota.showWeekly` | `true` | Show the weekly quota |
| `antigravityQuota.showResetTimer` | `false` | Show reset countdown on the status bar |
| `antigravityQuota.showGemini` | `true` | Show the Gemini pool |
| `antigravityQuota.showGpt` | `true` | Show the Claude & GPT pool |
| `antigravityQuota.showArgon` | `true` | Show the Argon pool, when available |
| `antigravityQuota.refreshInterval` | `60` | Refresh interval in seconds (minimum 15) |

## Feedback

Found a bug or have an idea? Open an issue on [GitHub](https://github.com/ringo196/antigravity-quota-bar/issues).

## License

[MIT](LICENSE) © ringo196
