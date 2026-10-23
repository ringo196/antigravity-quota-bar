import * as https from 'https';
import * as http from 'http';
import { PoolQuota, QuotaBucket, QuotaSummary, ServerConnection } from './types';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

/**
 * Fetch quotas from the local Antigravity Language Server.
 */
export async function fetchQuotaSummary(conn: ServerConnection): Promise<QuotaSummary | null> {
  // Strategy 1: Try RetrieveUserQuotaSummary (Preferred unified endpoint)
  try {
    const summary = await requestRetrieveUserQuotaSummary(conn);
    if (summary && summary.pools.length > 0) {
      return summary;
    }
  } catch (err) {
    // Fall back to GetUserStatus
  }

  // Strategy 2: Fall back to GetUserStatus
  try {
    const userStatus = await requestGetUserStatus(conn);
    if (userStatus && userStatus.pools.length > 0) {
      return userStatus;
    }
  } catch (err) {
    console.debug('[AntigravityQuota] GetUserStatus fallback failed:', err);
  }

  return null;
}

/**
 * Perform POST request using either HTTPS or HTTP with Connect-RPC headers.
 */
async function postConnectRpc<T>(
  conn: ServerConnection,
  endpoint: string,
  body: Record<string, any> = {}
): Promise<T> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    'Content-Length': Buffer.byteLength(payload).toString()
  };

  if (conn.csrfToken) {
    headers['X-Codeium-Csrf-Token'] = conn.csrfToken;
  }

  const makeRequest = (isHttps: boolean) =>
    new Promise<T>((resolve, reject) => {
      const client = isHttps ? https : http;
      const options: https.RequestOptions = {
        hostname: '127.0.0.1',
        port: conn.port,
        path: `/exa.language_server_pb.LanguageServerService/${endpoint}`,
        method: 'POST',
        headers,
        timeout: 4000,
        agent: isHttps ? httpsAgent : undefined
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data) as T);
            } catch (e) {
              reject(new Error(`Failed to parse JSON response: ${e}`));
            }
          } else {
            reject(new Error(`Server responded with HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      req.write(payload);
      req.end();
    });

  // Try configured protocol first, fallback to the other if connection fails
  try {
    return await makeRequest(conn.isHttps);
  } catch (err) {
    return await makeRequest(!conn.isHttps);
  }
}

/**
 * Calls RetrieveUserQuotaSummary
 */
async function requestRetrieveUserQuotaSummary(conn: ServerConnection): Promise<QuotaSummary> {
  const raw = await postConnectRpc<{ groups?: any[] }>(conn, 'RetrieveUserQuotaSummary', {});
  const groups = raw.groups || [];

  const poolsMap: Map<string, PoolQuota> = new Map([
    ['gemini', { id: 'gemini', label: 'Gemini', shortLabel: 'Gem', isAvailable: false }],
    ['gpt', { id: 'gpt', label: 'GPT / Claude', shortLabel: 'GPT', isAvailable: false }],
    ['argon', { id: 'argon', label: 'Argon', shortLabel: 'Argon', isAvailable: false }]
  ]);

  for (const group of groups) {
    const id = (group.id || '').toLowerCase();
    const label = (group.label || '').toLowerCase();

    let targetPoolId: string | null = null;
    if (id.includes('argon') || label.includes('argon')) {
      targetPoolId = 'argon';
    } else if (id.includes('gemini') || label.includes('gemini')) {
      targetPoolId = 'gemini';
    } else if (
      id.includes('claude') ||
      id.includes('gpt') ||
      label.includes('claude') ||
      label.includes('gpt')
    ) {
      targetPoolId = 'gpt';
    }

    if (!targetPoolId) continue;

    const pool = poolsMap.get(targetPoolId);
    if (!pool) continue;

    pool.isAvailable = true;

    const buckets = group.buckets || [];
    for (const b of buckets) {
      const windowStr = (b.window || '').toUpperCase();
      const fraction = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1.0;
      const resetTime = b.resetTime ? new Date(b.resetTime) : undefined;

      const bucket: QuotaBucket = {
        window: windowStr.includes('WEEK') ? 'weekly' : 'daily',
        remainingFraction: fraction,
        resetTime,
        rawWindow: b.window,
        description: b.description
      };

      if (bucket.window === 'weekly') {
        pool.weekly = bucket;
      } else {
        pool.daily = bucket;
      }
    }
  }

  return {
    pools: Array.from(poolsMap.values()),
    updatedAt: new Date(),
    source: 'RetrieveUserQuotaSummary'
  };
}

/**
 * Fallback: Calls GetUserStatus
 */
async function requestGetUserStatus(conn: ServerConnection): Promise<QuotaSummary> {
  const raw = await postConnectRpc<any>(conn, 'GetUserStatus', {});
  const configs =
    raw.userStatus?.cascadeModelConfigData?.clientModelConfigs ||
    raw.cascadeModelConfigData?.clientModelConfigs ||
    [];

  const poolsMap: Map<string, PoolQuota> = new Map([
    ['gemini', { id: 'gemini', label: 'Gemini', shortLabel: 'Gem', isAvailable: false }],
    ['gpt', { id: 'gpt', label: 'GPT / Claude', shortLabel: 'GPT', isAvailable: false }],
    ['argon', { id: 'argon', label: 'Argon', shortLabel: 'Argon', isAvailable: false }]
  ]);

  for (const config of configs) {
    const label = (config.label || '').toLowerCase();
    const quotaInfo = config.quotaInfo;
    if (!quotaInfo) continue;

    let targetPoolId: string | null = null;
    if (label.includes('argon')) {
      targetPoolId = 'argon';
    } else if (label.includes('gemini')) {
      targetPoolId = 'gemini';
    } else if (label.includes('gpt') || label.includes('claude') || label.includes('sonnet')) {
      targetPoolId = 'gpt';
    }

    if (!targetPoolId) continue;

    const pool = poolsMap.get(targetPoolId);
    if (!pool) continue;

    pool.isAvailable = true;

    const fraction =
      typeof quotaInfo.remainingFraction === 'number' ? quotaInfo.remainingFraction : 1.0;
    const resetTime = quotaInfo.resetTime ? new Date(quotaInfo.resetTime) : undefined;

    // In GetUserStatus, Argon is typically weekly; Gemini and GPT reflect current rolling window
    const isWeekly = targetPoolId === 'argon';
    const bucket: QuotaBucket = {
      window: isWeekly ? 'weekly' : 'daily',
      remainingFraction: fraction,
      resetTime
    };

    if (isWeekly) {
      if (!pool.weekly || pool.weekly.remainingFraction > fraction) {
        pool.weekly = bucket;
      }
    } else {
      // Deduplicate: Low/Med/High have identical quota, take the current value
      if (!pool.daily || pool.daily.remainingFraction > fraction) {
        pool.daily = bucket;
      }
    }
  }

  return {
    pools: Array.from(poolsMap.values()),
    updatedAt: new Date(),
    source: 'GetUserStatus'
  };
}

