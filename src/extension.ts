import * as vscode from 'vscode';
import { discoverLanguageServer } from './scanner';
import { fetchQuotaSummary } from './api';
import { PoolQuota, QuotaSummary, ServerConnection } from './types';

let statusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;
let cachedConnection: ServerConnection | null = null;
let lastSummary: QuotaSummary | null = null;

export function activate(context: vscode.ExtensionContext) {
  // Create status bar item on the right
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravityQuota.showMenu';
  context.subscriptions.push(statusBarItem);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityQuota.refresh', async () => {
      vscode.window.showInformationMessage('Refreshing Antigravity Quota...');
      await updateQuota(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityQuota.showMenu', async () => {
      await showQuickMenu();
    })
  );

  // Watch configuration updates
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityQuota')) {
        renderStatusBar();
        restartPolling();
      }
    })
  );

  // Initial fetch and start polling
  updateQuota(false);
  restartPolling();
}

export function deactivate() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

/**
 * Restarts background polling interval.
 */
function restartPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  const config = vscode.workspace.getConfiguration('antigravityQuota');
  const intervalSec = Math.max(15, config.get<number>('refreshInterval', 60));

  pollTimer = setInterval(() => {
    updateQuota(false);
  }, intervalSec * 1000);
}

/**
 * Updates quota data and renders status bar.
 */
async function updateQuota(forceRediscover: boolean) {
  try {
    if (!cachedConnection || forceRediscover) {
      cachedConnection = await discoverLanguageServer();
    }

    if (!cachedConnection) {
      statusBarItem.text = '$(sparkle) AGQ: Offline';
      statusBarItem.tooltip = 'Could not detect local Antigravity Language Server. Ensure Antigravity IDE or the extension is active.';
      statusBarItem.show();
      return;
    }

    let summary = await fetchQuotaSummary(cachedConnection);

    // If fetch failed, try rediscovering once
    if (!summary && !forceRediscover) {
      cachedConnection = await discoverLanguageServer();
      if (cachedConnection) {
        summary = await fetchQuotaSummary(cachedConnection);
      }
    }

    lastSummary = summary;
    renderStatusBar();
  } catch (err) {
    console.error('[AntigravityQuota] Update failed:', err);
    statusBarItem.text = '$(warning) AGQ: Error';
    statusBarItem.tooltip = `Error fetching quota: ${err}`;
    statusBarItem.show();
  }
}

/**
 * Formats a Date into a human-readable relative remaining time (e.g., "1h 45m" or "3d 4h").
 */
function formatTimeRemaining(resetTime?: Date): string {
  if (!resetTime) return '';
  const now = new Date();
  const diffMs = resetTime.getTime() - now.getTime();
  if (diffMs <= 0) return 'resets soon';

  const totalMin = Math.floor(diffMs / (1000 * 60));
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const minutes = totalMin % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Renders the status bar item based on current settings and quota data.
 */
function renderStatusBar() {
  if (!lastSummary) {
    statusBarItem.text = '$(sparkle) AGQ: No Data';
    statusBarItem.tooltip = 'Connected to Antigravity Language Server, but no quota data was returned. Click to refresh.';
    statusBarItem.show();
    return;
  }

  const config = vscode.workspace.getConfiguration('antigravityQuota');
  const showDaily = config.get<boolean>('showDaily', true);
  const showWeekly = config.get<boolean>('showWeekly', true);
  const showResetTimer = config.get<boolean>('showResetTimer', false);

  const showGemini = config.get<boolean>('showGemini', true);
  const showGpt = config.get<boolean>('showGpt', true);
  const showArgon = config.get<boolean>('showArgon', true);

  const poolFilterMap: Record<string, boolean> = {
    gemini: showGemini,
    gpt: showGpt,
    argon: showArgon
  };

  const parts: string[] = [];
  const tooltipLines: string[] = [
    '### Antigravity AI Quotas',
    '',
    `*Updated: ${lastSummary.updatedAt.toLocaleTimeString()}*`,
    '',
    '| Pool | Window | Quota | Resets in |',
    '| :--- | :--- | :--- | :--- |'
  ];

  for (const pool of lastSummary.pools) {
    // Build tooltip rows regardless of status bar visibility
    if (pool.daily) {
      const pct = Math.round(pool.daily.remainingFraction * 100);
      const reset = formatTimeRemaining(pool.daily.resetTime);
      tooltipLines.push(`| **${pool.label}** | Daily (5h) | ${pct}% | ${reset || 'N/A'} |`);
    }
    if (pool.weekly) {
      const pct = Math.round(pool.weekly.remainingFraction * 100);
      const reset = formatTimeRemaining(pool.weekly.resetTime);
      tooltipLines.push(`| **${pool.label}** | Weekly | ${pct}% | ${reset || 'N/A'} |`);
    }
    if (!pool.daily && !pool.weekly) {
      tooltipLines.push(`| **${pool.label}** | - | N/A | - |`);
    }

    // Check if user enabled this pool for status bar display
    const isPoolEnabled = poolFilterMap[pool.id] ?? true;
    if (!isPoolEnabled) continue;

    const poolTokens: string[] = [];

    // Daily
    if (showDaily && pool.daily) {
      const pct = Math.round(pool.daily.remainingFraction * 100);
      const timerStr = showResetTimer && pool.daily.resetTime ? ` (${formatTimeRemaining(pool.daily.resetTime)})` : '';
      poolTokens.push(showWeekly && pool.weekly ? `${pct}%d${timerStr}` : `${pct}%${timerStr}`);
    }

    // Weekly
    if (showWeekly && pool.weekly) {
      const pct = Math.round(pool.weekly.remainingFraction * 100);
      const timerStr = showResetTimer && pool.weekly.resetTime ? ` (${formatTimeRemaining(pool.weekly.resetTime)})` : '';
      poolTokens.push(showDaily && pool.daily ? `${pct}%w${timerStr}` : `${pct}%${timerStr}`);
    }

    // Fallback: If pool only has weekly (e.g. Argon) and user selected daily only, show its available quota with tag
    if (poolTokens.length === 0) {
      if (pool.weekly && !pool.daily) {
        const pct = Math.round(pool.weekly.remainingFraction * 100);
        const timerStr = showResetTimer && pool.weekly.resetTime ? ` (${formatTimeRemaining(pool.weekly.resetTime)})` : '';
        poolTokens.push(`${pct}%w${timerStr}`);
      } else if (pool.daily && !pool.weekly) {
        const pct = Math.round(pool.daily.remainingFraction * 100);
        const timerStr = showResetTimer && pool.daily.resetTime ? ` (${formatTimeRemaining(pool.daily.resetTime)})` : '';
        poolTokens.push(`${pct}%d${timerStr}`);
      } else {
        // Pool is enabled by user, but not active or no quota data returned
        poolTokens.push('N/A');
      }
    }

    parts.push(`${pool.shortLabel}: ${poolTokens.join(' ')}`);
  }

  if (parts.length === 0) {
    statusBarItem.text = '$(sparkle) AGQ: None Selected';
  } else {
    statusBarItem.text = `$(sparkle) ${parts.join(' | ')}`;
  }

  tooltipLines.push('');
  tooltipLines.push('*(Click status bar item to toggle pools, windows, or refresh)*');

  const md = new vscode.MarkdownString(tooltipLines.join('\n'));
  md.isTrusted = true;
  statusBarItem.tooltip = md;
  statusBarItem.show();
}

/**
 * Interactive QuickPick menu when clicking the status bar item.
 */
async function showQuickMenu() {
  const config = vscode.workspace.getConfiguration('antigravityQuota');
  const showDaily = config.get<boolean>('showDaily', true);
  const showWeekly = config.get<boolean>('showWeekly', true);
  const showResetTimer = config.get<boolean>('showResetTimer', false);

  const showGemini = config.get<boolean>('showGemini', true);
  const showGpt = config.get<boolean>('showGpt', true);
  const showArgon = config.get<boolean>('showArgon', true);

  const argonPool = lastSummary?.pools.find((p) => p.id === 'argon');
  const argonAvailable = argonPool?.isAvailable ?? false;

  interface ActionItem extends vscode.QuickPickItem {
    actionType: 'toggle' | 'refresh' | 'settings' | 'info';
    key?: string;
    currentValue?: boolean;
  }

  const items: ActionItem[] = [
    {
      label: 'DISPLAYED POOLS',
      kind: vscode.QuickPickItemKind.Separator,
      actionType: 'info'
    },
    {
      label: `${showGemini ? '$(check) ' : '$(circle-slash) '}Gemini Pool`,
      description: 'Flash and Pro reasoning tiers (Low, Med, High share this pool)',
      actionType: 'toggle',
      key: 'showGemini',
      currentValue: showGemini
    },
    {
      label: `${showGpt ? '$(check) ' : '$(circle-slash) '}Claude/GPT Pool`,
      description: 'OpenAI and Anthropic partner models',
      actionType: 'toggle',
      key: 'showGpt',
      currentValue: showGpt
    },
    {
      label: `${showArgon ? '$(check) ' : '$(circle-slash) '}Argon Pool`,
      description: argonAvailable
        ? 'Gemini 4 Argon weekly allocation'
        : 'Gemini 4 Argon (N/A in current plan)',
      actionType: 'toggle',
      key: 'showArgon',
      currentValue: showArgon
    }
  ];

  items.push(
    {
      label: 'DISPLAY WINDOWS',
      kind: vscode.QuickPickItemKind.Separator,
      actionType: 'info'
    },
    {
      label: `${showDaily ? '$(check) ' : '$(circle-slash) '}Show Daily Quota (5-Hour Window)`,
      description: 'Rolling sprint quota',
      actionType: 'toggle',
      key: 'showDaily',
      currentValue: showDaily
    },
    {
      label: `${showWeekly ? '$(check) ' : '$(circle-slash) '}Show Weekly Quota`,
      description: '7-day rolling ceiling',
      actionType: 'toggle',
      key: 'showWeekly',
      currentValue: showWeekly
    },
    {
      label: `${showResetTimer ? '$(check) ' : '$(circle-slash) '}Show Reset Timer`,
      description: 'Display countdown time next to percentages',
      actionType: 'toggle',
      key: 'showResetTimer',
      currentValue: showResetTimer
    },
    {
      label: 'ACTIONS',
      kind: vscode.QuickPickItemKind.Separator,
      actionType: 'info'
    },
    {
      label: '$(sync) Refresh Now',
      description: 'Re-query local Antigravity Language Server',
      actionType: 'refresh'
    },
    {
      label: '$(gear) Open Settings',
      description: 'Configure polling interval and preferences',
      actionType: 'settings'
    }
  );

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Antigravity Quota Options'
  });

  if (!selected) return;

  if (selected.actionType === 'toggle' && selected.key) {
    await config.update(selected.key, !selected.currentValue, vscode.ConfigurationTarget.Global);
    renderStatusBar();
  } else if (selected.actionType === 'refresh') {
    await updateQuota(true);
  } else if (selected.actionType === 'settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityQuota');
  }
}

