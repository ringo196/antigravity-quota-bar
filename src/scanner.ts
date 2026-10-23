import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import { ServerConnection } from './types';

const execAsync = promisify(exec);

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

        // Check if extension server port is explicitly passed
        const extPortMatch = line.match(/--extension_server_port[=\s]+(\d+)/);
        let ports: number[] = [];
        if (extPortMatch) {
          ports.push(parseInt(extPortMatch[1], 10));
        }

        // Also query listening ports for this PID using lsof
        try {
          const { stdout: lsofOut } = await execAsync(`lsof -nP -p ${pid} -a -iTCP -sTCP:LISTEN 2>/dev/null || true`);
          const portMatches = lsofOut.matchAll(/(?:127\.0\.0\.1|\*|localhost):(\d+)/g);
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
          // Return primary port candidate; prefers HTTPS on primary Connect port, fallback to HTTP
          return {
            pid,
            port: ports[0],
            csrfToken,
            isHttps: true
          };
        }
      }
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

    for (const proc of processes) {
      const commandLine = proc.CommandLine || '';
      const pid = proc.ProcessId;

      if (!commandLine || !pid) continue;

      let csrfToken = '';
      const tokenMatch = commandLine.match(/--csrf_token[=\s]+([^\s]+)/);
      if (tokenMatch) {
        csrfToken = tokenMatch[1];
      }

      const extPortMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
      let ports: number[] = [];
      if (extPortMatch) {
        ports.push(parseInt(extPortMatch[1], 10));
      }

      // Query netstat for listening ports for this PID
      try {
        const { stdout: netstatOut } = await execAsync(`netstat -ano | findstr ${pid}`);
        const portMatches = netstatOut.matchAll(/127\.0\.0\.1:(\d+)\s+.*LISTENING/gi);
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
        return {
          pid,
          port: ports[0],
          csrfToken,
          isHttps: true
        };
      }
    }
  } catch (err) {
    console.debug('[AntigravityQuota] Windows scan failed:', err);
  }

  return null;
}

