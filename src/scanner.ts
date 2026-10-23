import { exec } from 'child_process';
import { promisify } from 'util';
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

  // Test HTTPS first
  if (await tryProtocol(true, 'RetrieveUserQuotaSummary')) {
    return { isHttps: true };
  }
  if (await tryProtocol(true, 'GetUserStatus')) {
    return { isHttps: true };
  }

  // Fallback to HTTP
  if (await tryProtocol(false, 'RetrieveUserQuotaSummary')) {
    return { isHttps: false };
  }
  if (await tryProtocol(false, 'GetUserStatus')) {
    return { isHttps: false };
  }

  return null;
}

interface ProcessCandidate {
  pid: number;
  csrfToken: string;
  ports: number[];
}

/**
 * Scans local system processes to discover running Antigravity Language Server instances.
 */
export async function discoverLanguageServer(): Promise<ServerConnection | null> {
  const platform = os.platform();

  try {
    if (platform === 'win32') {
      return await scanWindows();
    } else {
      return await scanUnix();
    }
  } catch (error) {
    console.warn('[AntigravityQuota] Process discovery error:', error);
    return null;
  }
}

/**
 * Scan processes on macOS / Linux
 */
async function scanUnix(): Promise<ServerConnection | null> {
  try {
    const { stdout } = await execAsync('ps -ww -ax -o pid,command');
    const lines = stdout.split('\n');
    const candidates: ProcessCandidate[] = [];

    for (const line of lines) {
      if (
        line.includes('language_server') &&
        !line.includes('grep') &&
        !line.includes('antigravity-quota')
      ) {
        const pidMatch = line.trim().match(/^(\d+)/);
        if (!pidMatch) continue;
        const pid = parseInt(pidMatch[1], 10);

        // Extract CSRF token
        let csrfToken = '';
        const tokenMatch = line.match(/--csrf_token[=\s]+([^\s]+)/);
        if (tokenMatch) {
          csrfToken = tokenMatch[1];
        }

        // Query listening ports for this PID using lsof
        // NOTE: We do NOT use --extension_server_port because that is the parent IDE's port,
        // not the language server's own listening socket.
        const ports: number[] = [];
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

        if (ports.length > 0) {
          candidates.push({ pid, csrfToken, ports });
        }
      }
    }

    // Probe candidate processes and ports to find an active Connect-RPC server
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
        isHttps: true
      };
    }
  } catch (err) {
    console.debug('[AntigravityQuota] Unix scan failed:', err);
  }

  return null;
}

/**
 * Scan processes on Windows
 */
async function scanWindows(): Promise<ServerConnection | null> {
  try {
    const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*language_server*' } | Select-Object ProcessId, CommandLine | ConvertTo-Json"`;
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

      let csrfToken = '';
      const tokenMatch = commandLine.match(/--csrf_token[=\s]+([^\s]+)/);
      if (tokenMatch) {
        csrfToken = tokenMatch[1];
      }

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

      if (ports.length > 0) {
        candidates.push({ pid, csrfToken, ports });
      }
    }

    // Probe candidate processes and ports
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

    // Best-effort fallback
    if (candidates.length > 0 && candidates[0].ports.length > 0) {
      return {
        pid: candidates[0].pid,
        port: candidates[0].ports[0],
        csrfToken: candidates[0].csrfToken,
        isHttps: true
      };
    }
  } catch (err) {
    console.debug('[AntigravityQuota] Windows scan failed:', err);
  }

  return null;
}


