import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { ServerConnection } from './types';

const execAsync = promisify(exec);

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

/**
 * Fast probe to verify if a candidate port and protocol responds to Connect-RPC quota requests.
 */
async function probeServer(
  port: number,
  csrfToken: string
): Promise<{ isHttps: boolean } | null> {
  const tryProtocol = (isHttps: boolean, endpoint: string) =>
    new Promise<boolean>((resolve) => {
      const client = isHttps ? https : http;
      const payload = '{}';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'Content-Length': '2'
      };
      if (csrfToken) {
        headers['X-Codeium-Csrf-Token'] = csrfToken;
      }

      const req = client.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/exa.language_server_pb.LanguageServerService/${endpoint}`,
          method: 'POST',
          headers,
          timeout: 1200,
          agent: isHttps ? httpsAgent : undefined
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.write(payload);
      req.end();
    });

  // Test HTTP first (preferred by agy hub)
  if (await tryProtocol(false, 'RetrieveUserQuotaSummary')) {
    return { isHttps: false };
  }
  // Test HTTPS (preferred by language_server)
  if (await tryProtocol(true, 'RetrieveUserQuotaSummary')) {
    return { isHttps: true };
  }

  // Fallback endpoint checks
  if (await tryProtocol(false, 'GetUserStatus')) {
    return { isHttps: false };
  }
  if (await tryProtocol(true, 'GetUserStatus')) {
    return { isHttps: true };
  }

  return null;
}

interface ProcessCandidate {
  pid: number;
  csrfToken: string;
  ports: number[];
  priority: number;
}

interface HubDiscoveryFile {
  pid?: number;
  httpPort?: number;
  httpsPort?: number;
  csrfToken?: string;
}

/**
 * Resolves the daemon discovery directory for an agy/language_server process.
 */
function resolveDaemonDir(commandLine: string): string {
  const dirMatch = commandLine.match(/--app_data_dir[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const appDataDir = dirMatch ? dirMatch[1] || dirMatch[2] || dirMatch[3] : 'antigravity';
  if (path.isAbsolute(appDataDir)) {
    return path.join(appDataDir, 'daemon');
  }
  return path.join(os.homedir(), '.gemini', appDataDir, 'daemon');
}

/**
 * Reads a daemon hub discovery JSON file and merges its token/ports if it belongs to this PID.
 */
function tryApplyHubFile(
  filePath: string,
  pid: number,
  ports: number[],
  currentToken: string
): string {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as HubDiscoveryFile;
    if (!data || typeof data !== 'object') {
      return currentToken;
    }
    if (typeof data.pid === 'number' && data.pid !== pid) {
      return currentToken;
    }

    for (const candidatePort of [data.httpPort, data.httpsPort]) {
      if (typeof candidatePort === 'number' && candidatePort > 0 && !ports.includes(candidatePort)) {
        ports.push(candidatePort);
      }
    }

    if (!currentToken && typeof data.csrfToken === 'string') {
      return data.csrfToken;
    }
  } catch {
    // Ignore missing or unreadable hub metadata files
  }
  return currentToken;
}

/**
 * Extracts CSRF token and ports from process args, falling back to agy's daemon hub_<port>.json files.
 */
function resolveHubMetadata(
  commandLine: string,
  pid: number,
  initialPorts: number[]
): { csrfToken: string; ports: number[] } {
  const ports = [...initialPorts];
  let csrfToken = '';

  const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-zA-Z0-9-]+)/);
  if (tokenMatch) {
    csrfToken = tokenMatch[1];
  }

  let hubPort: number | undefined;
  const hubPortMatch = commandLine.match(/--(?:hub-)?port[=\s]+(\d+)/);
  if (hubPortMatch) {
    hubPort = parseInt(hubPortMatch[1], 10);
    if (!ports.includes(hubPort)) {
      ports.unshift(hubPort);
    }
  }

  if (!csrfToken) {
    const daemonDir = resolveDaemonDir(commandLine);
    if (hubPort !== undefined) {
      csrfToken = tryApplyHubFile(
        path.join(daemonDir, `hub_${hubPort}.json`),
        pid,
        ports,
        csrfToken
      );
    }

    if (!csrfToken) {
      try {
        for (const entry of fs.readdirSync(daemonDir)) {
          if (!entry.startsWith('hub_') || !entry.endsWith('.json')) continue;
          csrfToken = tryApplyHubFile(path.join(daemonDir, entry), pid, ports, csrfToken);
          if (csrfToken) break;
        }
      } catch {
        // Ignore missing daemon directory
      }
    }
  }

  return { csrfToken, ports };
}

/**
 * Builds a prioritized process candidate from its command line and listening ports.
 */
function buildCandidate(
  pid: number,
  commandLine: string,
  listeningPorts: number[],
  workspacePaths: string[]
): ProcessCandidate | null {
  const { csrfToken, ports } = resolveHubMetadata(commandLine, pid, listeningPorts);
  if (ports.length === 0) {
    return null;
  }

  const isAgy = commandLine.includes('agy') || commandLine.includes('--hub');
  const hasMatchingWorkspace = workspacePaths.some((ws) => ws && commandLine.includes(ws));

  let priority = 10;
  if (isAgy && hasMatchingWorkspace) {
    priority = 100;
  } else if (isAgy) {
    priority = 80;
  } else if (hasMatchingWorkspace) {
    priority = 50;
  }

  return { pid, csrfToken, ports, priority };
}

/**
 * Probes prioritized candidates and returns the first active Connect-RPC connection.
 */
async function selectBestConnection(
  candidates: ProcessCandidate[]
): Promise<ServerConnection | null> {
  // Sort so active workspace agy hub processes with tokens are evaluated first
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return Number(Boolean(b.csrfToken)) - Number(Boolean(a.csrfToken));
  });

  for (const candidate of candidates) {
    for (const port of candidate.ports) {
      const probeResult = await probeServer(port, candidate.csrfToken);
      if (probeResult) {
        return {
          pid: candidate.pid,
          port,
          csrfToken: candidate.csrfToken,
          isHttps: probeResult.isHttps
        };
      }
    }
  }

  // Best-effort fallback if probing didn't succeed but candidate ports exist
  if (candidates.length > 0 && candidates[0].ports.length > 0) {
    return {
      pid: candidates[0].pid,
      port: candidates[0].ports[0],
      csrfToken: candidates[0].csrfToken,
      isHttps: false
    };
  }

  return null;
}

/**
 * Scans local system processes to discover running Antigravity Language Server instances.
 */
export async function discoverLanguageServer(
  workspacePaths: string[] = []
): Promise<ServerConnection | null> {
  const platform = os.platform();
  const paths = workspacePaths.length > 0 ? workspacePaths : [process.cwd()];

  try {
    if (platform === 'win32') {
      return await scanWindows(paths);
    } else {
      return await scanUnix(paths);
    }
  } catch (error) {
    console.warn('[AntigravityQuota] Process discovery error:', error);
    return null;
  }
}

/**
 * Scan processes on macOS / Linux
 */
async function scanUnix(workspacePaths: string[]): Promise<ServerConnection | null> {
  try {
    const { stdout } = await execAsync('ps -ww -ax -o pid,command');
    const lines = stdout.split('\n');
    const candidates: ProcessCandidate[] = [];

    for (const line of lines) {
      if (
        (line.includes('language_server') || line.includes('agy') || line.includes('antigravity')) &&
        !line.includes('grep') &&
        !line.includes('/dist/extension.js') &&
        !line.includes('node ') &&
        !line.includes('--type=')
      ) {
        const pidMatch = line.trim().match(/^(\d+)/);
        if (!pidMatch) continue;
        const pid = parseInt(pidMatch[1], 10);

        const ports: number[] = [];

        // Query listening ports for this PID using lsof
        try {
          const { stdout: lsofOut } = await execAsync(
            `lsof -nP -p ${pid} -a -iTCP -sTCP:LISTEN 2>/dev/null || true`
          );
          const portMatches = lsofOut.matchAll(/(?:127\.0\.0\.1|\*|localhost|\[::1\]):(\d+)/g);
          for (const match of portMatches) {
            const p = parseInt(match[1], 10);
            if (!ports.includes(p)) {
              ports.push(p);
            }
          }
        } catch {
          // Ignore lsof failure
        }

        const candidate = buildCandidate(pid, line, ports, workspacePaths);
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    return await selectBestConnection(candidates);
  } catch (err) {
    console.debug('[AntigravityQuota] Unix scan failed:', err);
  }

  return null;
}

/**
 * Scan processes on Windows
 */
async function scanWindows(workspacePaths: string[]): Promise<ServerConnection | null> {
  try {
    const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*language_server*' -or $_.CommandLine -like '*agy*' -or $_.CommandLine -like '*antigravity*' } | Select-Object ProcessId, CommandLine | ConvertTo-Json"`;
    const { stdout } = await execAsync(cmd);
    if (!stdout.trim()) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }

    const processes = Array.isArray(parsed) ? parsed : [parsed];
    const candidates: ProcessCandidate[] = [];

    for (const proc of processes) {
      const commandLine = proc.CommandLine || '';
      const pid = proc.ProcessId;

      if (!commandLine || !pid) continue;

      const ports: number[] = [];

      try {
        const { stdout: netstatOut } = await execAsync(`netstat -ano | findstr ${pid}`);
        const portMatches = netstatOut.matchAll(/(?:127\.0\.0\.1|\[::1\]):(\d+)\s+.*LISTENING/gi);
        for (const match of portMatches) {
          const p = parseInt(match[1], 10);
          if (!ports.includes(p)) {
            ports.push(p);
          }
        }
      } catch {
        // Ignore netstat failure
      }

      const candidate = buildCandidate(pid, commandLine, ports, workspacePaths);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    return await selectBestConnection(candidates);
  } catch (err) {
    console.debug('[AntigravityQuota] Windows scan failed:', err);
  }

  return null;
}


