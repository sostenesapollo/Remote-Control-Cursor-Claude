import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, execFileSync } from 'child_process';

export interface ClaudeSessionMeta {
  sessionId: string;
  cwd: string;
  name?: string;
  pid?: number;
}

/** Prefer newest Claude Desktop / Claude Code binary on this Mac. */
export function resolveClaudeBinary(): string | null {
  const fromEnv = process.env.CLAUDE_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates: string[] = [];
  const root = join(homedir(), 'Library/Application Support/Claude/claude-code');
  if (existsSync(root)) {
    const versions = readdirSync(root)
      .filter((d) => /^\d+\.\d+\.\d+/.test(d))
      .sort()
      .reverse();
    for (const v of versions) {
      const bin = join(root, v, 'claude.app/Contents/MacOS/claude');
      if (existsSync(bin)) candidates.push(bin);
    }
  }
  for (const p of [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(homedir(), '.local/bin/claude'),
  ]) {
    if (existsSync(p)) candidates.push(p);
  }
  return candidates[0] ?? null;
}

/**
 * Claude Desktop puts CLAUDE_CODE_OAUTH_TOKEN on its child process env.
 * Headless `claude -p` from the LaunchAgent often has no CLI login —
 * borrow the live Desktop token when available (never log the value).
 */
export function resolveClaudeOauthToken(): string | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.startsWith('sk-ant-')) {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  try {
    const pids = execFileSync('ps', ['-ax', '-o', 'pid='], { encoding: 'utf-8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const pid of pids) {
      let envLine = '';
      try {
        envLine = execFileSync('ps', ['eww', '-p', pid], {
          encoding: 'utf-8',
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch {
        continue;
      }
      if (!envLine.includes('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-')) continue;
      const m = /CLAUDE_CODE_OAUTH_TOKEN=(sk-ant-oat01-[A-Za-z0-9_\-]+)/.exec(envLine);
      if (m) return m[1];
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Read live/recent session metadata from ~/.claude/sessions/*.json */
export function lookupSessionFromDisk(sessionId: string): ClaudeSessionMeta | null {
  const dir = join(homedir(), '.claude/sessions');
  if (!existsSync(dir)) return null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as {
          sessionId?: string;
          cwd?: string;
          pid?: number;
          name?: string;
        };
        if (raw.sessionId === sessionId && raw.cwd) {
          return {
            sessionId,
            cwd: raw.cwd,
            pid: raw.pid,
            name: raw.name,
          };
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return null;
}

export interface PromptRunResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Send a prompt as a Claude Code print turn in the project cwd.
 *
 * Uses `-c` (continue latest in directory) instead of `--resume <id>` so we
 * don't steal/kill an interactive Claude Desktop session on the same id.
 * Auth: borrow CLAUDE_CODE_OAUTH_TOKEN from a live Desktop process when the
 * LaunchAgent CLI has no login (never logged).
 */
export function runClaudePrintPrompt(opts: {
  sessionId: string;
  cwd: string;
  prompt: string;
  binary?: string;
  timeoutMs?: number;
}): Promise<PromptRunResult> {
  const binary = opts.binary ?? resolveClaudeBinary();
  if (!binary) {
    return Promise.resolve({
      ok: false,
      text: '',
      error: 'Claude binary not found. Set CLAUDE_BIN or install Claude Code / Desktop.',
    });
  }

  const timeoutMs = opts.timeoutMs ?? 600_000;
  // Prefer continue-in-cwd. Explicit --resume fights Claude Desktop when the
  // same session is open interactively (Desktop ends; Telegram often never
  // gets the reply because the relay restarts or the child hangs).
  const args = [
    '-p',
    '-c',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'text',
    opts.prompt,
  ];

  const env = { ...process.env };
  const oauth = resolveClaudeOauthToken();
  if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
  console.log(
    `[claude-prompt] spawn -c cwd=${opts.cwd} oauth=${oauth ? 'yes' : 'no'} session=${opts.sessionId.slice(0, 8)}`
  );

  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* */ }
      resolve({
        ok: false,
        text: stdout.trim(),
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, text: '', error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      console.log(`[claude-prompt] exit=${code} outLen=${text.length} errLen=${stderr.length}`);
      if (code === 0 && text) {
        resolve({ ok: true, text });
        return;
      }
      const errLine = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ');
      const loginHint = /not logged in|please run \/login/i.test(`${text}\n${errLine}`)
        ? ' Abre o Claude Desktop (logado) no Mac e tenta de novo.'
        : '';
      resolve({
        ok: false,
        text,
        error: (errLine || text || `claude exited with code ${code ?? '?'}`) + loginHint,
      });
    });
  });
}
