# Antigravity Quota Status Bar

A lightweight, clean Visual Studio Code / Antigravity IDE extension that displays your AI model quota pools on the status bar.

Instead of cluttering the status bar with duplicate rows for reasoning tiers (Low, Medium, High) that share the same quota pool, this extension groups quotas into their actual distinct pools:
- **Gemini**: Standard Gemini models (Flash, Pro tiers Low/Med/High).
- **GPT**: OpenAI and Anthropic models (GPT-4o, Claude 3.7 Sonnet, etc.).
- **Argon**: Dedicated pool for Gemini 4 Argon (automatically hidden if not supported/available in your editor).

---

## Features

- **Pool-Level Aggregation**: Removes duplicate percentages for reasoning levels that share the same quota pool.
- **Independent Daily & Weekly Toggles**: Toggle Daily (5-hour rolling) and Weekly quotas independently via settings or the click menu.
- **Reset Countdown Timer**: Optionally show relative countdown timers (`1h 45m` or `3d 4h`) directly on the status bar.
- **Dynamic Pool Availability**: Pools like Argon only appear in the menu and status bar if they exist in your current editor environment.
- **One-Click QuickPick Menu**: Click the status bar to toggle pools and windows instantly without digging into `settings.json`.
- **Zero Configuration**: Automatically scans local processes for the Antigravity Language Server, dynamic loopback port, and CSRF token.

---

## Configuration Settings

Add or modify these in your VS Code `settings.json`:

```json
{
  "antigravityQuota.showDaily": true,
  "antigravityQuota.showWeekly": true,
  "antigravityQuota.showResetTimer": false,
  "antigravityQuota.showGemini": true,
  "antigravityQuota.showGpt": true,
  "antigravityQuota.showArgon": true,
  "antigravityQuota.refreshInterval": 60
}
```

---

## Using for Yourself (Local Installation)

### Method 1: Package and Install `.vsix` (Recommended)

1. Open a terminal in this directory:
   ```bash
   cd extensions/antigravity-quota-bar
   ```

2. Install dependencies and compile:
   ```bash
   npm install
   npm run compile
   ```

3. Package into a `.vsix` file:
   ```bash
   npx @vscode/vsce package
   ```
   *This generates a file named `antigravity-quota-bar-0.1.0.vsix`.*

4. Install the `.vsix`:
   - **Via CLI**:
     ```bash
     code --install-extension antigravity-quota-bar-0.1.0.vsix
     ```
     *(If using Antigravity IDE, use `antigravity --install-extension antigravity-quota-bar-0.1.0.vsix` or replace `code` with your binary).*
   - **Via UI**:
     - Open VS Code / Antigravity IDE.
     - Go to the Extensions panel (`Cmd+Shift+X` or `Ctrl+Shift+X`).
     - Click the `...` menu (Views and More Actions) at the top right of the Extensions panel.
     - Select **Install from VSIX...** and choose `antigravity-quota-bar-0.1.0.vsix`.

---

### Method 2: Direct Symlink (Instant Development Mode)

You can link the compiled extension folder directly into your extensions directory:

- **VS Code**:
  ```bash
  ln -s "$(pwd)" ~/.vscode/extensions/antigravity-quota-bar
  ```
- **Antigravity IDE**:
  ```bash
  ln -s "$(pwd)" ~/.antigravity/extensions/antigravity-quota-bar
  ```
Restart your editor, and the extension will load automatically.

---

## Publishing to Marketplaces

### 1. VS Code Marketplace (Microsoft)

1. **Create Publisher**:
   - Visit [Visual Studio Marketplace Management](https://marketplace.visualstudio.com/manage) and sign in with a Microsoft account.
   - Click **Create publisher** and note your Publisher ID (e.g. `my-name`).
   - Update `"publisher": "my-name"` in `package.json`.

2. **Generate Personal Access Token (PAT)**:
   - Go to [Azure DevOps](https://dev.azure.com).
   - Click User Settings (top right) -> **Personal access tokens**.
   - Create a token with Organization: **All accessible organizations** and Scope: **Marketplace (Manage)**.

3. **Publish via CLI**:
   ```bash
   npx @vscode/vsce login <your-publisher-name>
   npx @vscode/vsce publish
   ```
   *Or drag-and-drop your `.vsix` file directly in the web management portal.*

### 2. Open VSX Registry (Open-source registry used by VSCodium / forks)

Many community tools and custom editors use Open VSX instead of Microsoft's proprietary marketplace:

1. Create an account on [Open VSX](https://open-vsx.org/).
2. Create a namespace / publisher matching your name.
3. Generate an Access Token under your Profile settings.
4. Publish using `ovsx`:
   ```bash
   npx ovsx publish antigravity-quota-bar-0.1.0.vsix -p <your-ovsx-token>
   ```

