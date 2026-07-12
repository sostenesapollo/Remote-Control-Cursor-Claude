import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { TELEGRAM_BOT_TOKEN_SECRET_KEY } from './secrets.js';

interface TelegramAuth {
  token: string;
  registeredUsers: { id: number; username?: string; firstName?: string; registeredAt?: string }[];
}

function loadTelegramAuth(context: vscode.ExtensionContext): TelegramAuth | null {
  const dataDir = context.globalStorageUri.fsPath;
  const authPath = join(dataDir, 'telegram-auth.json');
  try {
    if (existsSync(authPath)) {
      return JSON.parse(readFileSync(authPath, 'utf-8'));
    }
  } catch { /* not available */ }
  return null;
}

export class SetupPanel {
  public static currentPanel: SetupPanel | undefined;
  private static readonly viewType = 'cursorRemote.setup';
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private _disposed = false;
  private _pairCode = '';
  private _pairCodeExpiry = 0;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  public static createOrShow(context: vscode.ExtensionContext): void {
    if (SetupPanel.currentPanel) {
      SetupPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      void SetupPanel.currentPanel.updateWebview();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SetupPanel.viewType,
      'CursorRemote Setup',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    SetupPanel.currentPanel = new SetupPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;

    void this.refreshPairCode();
    void this.updateWebview();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  private get serverHealthUrl(): string {
    const config = vscode.workspace.getConfiguration('cursorRemote');
    const port = String(config.get<number>('serverPort', 3000));
    const host = config.get<string>('serverHost', '127.0.0.1');
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    return `http://${displayHost}:${port}`;
  }

  private async refreshPairCode(): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorRemote');
    const port = String(config.get<number>('serverPort', 3000));
    const host = config.get<string>('serverHost', '127.0.0.1');
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const url = `http://${displayHost}:${port}/api/pair/code`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json() as { code?: string; expiresInMs?: number };
        if (data.code) {
          this._pairCode = data.code;
          this._pairCodeExpiry = Date.now() + (data.expiresInMs ?? 600000);
          await this.updateWebview();
          this.startPolling();
          return;
        }
      }
    } catch {
      // Server not running yet
    }
    // Retry shortly
    if (!this._disposed) {
      setTimeout(() => this.refreshPairCode(), 3000);
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this._pollTimer = setInterval(() => {
      if (Date.now() > this._pairCodeExpiry) {
        this._pairCode = '';
        void this.refreshPairCode();
      }
    }, 5000);
  }

  private stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorRemote');
    switch (msg.type) {
      case 'regenerateCode': {
        this._pairCode = '';
        await this.refreshPairCode();
        break;
      }
      case 'copyCode': {
        if (this._pairCode) {
          await vscode.env.clipboard.writeText(this._pairCode);
          vscode.window.showInformationMessage('Pairing code copied.');
        }
        break;
      }
      case 'openWebClient': {
        vscode.commands.executeCommand('cursorRemote.openWebClient');
        break;
      }
      case 'restartServer': {
        vscode.commands.executeCommand('cursorRemote.restart');
        setTimeout(() => this.refreshPairCode(), 2000);
        break;
      }
      case 'saveNetworking': {
        const mode = msg.mode as string;
        if (mode === 'localhost') {
          await config.update('serverHost', '127.0.0.1', vscode.ConfigurationTarget.Global);
        } else if (mode === 'custom') {
          const addr = (msg.address as string || '').trim();
          if (addr) await config.update('serverHost', addr, vscode.ConfigurationTarget.Global);
        } else {
          await config.update('serverHost', '0.0.0.0', vscode.ConfigurationTarget.Global);
        }
        await this.updateWebview();
        break;
      }
      case 'saveTelegramToken': {
        const token = (msg.token as string).trim();
        if (token) {
          await this.context.secrets.store(TELEGRAM_BOT_TOKEN_SECRET_KEY, token);
          await config.update('telegram.enabled', true, vscode.ConfigurationTarget.Global);
          await this.updateWebview();
        }
        break;
      }
      case 'setTelegramImpl': {
        const impl = msg.impl as string;
        if (impl === 'grammy' || impl === 'raw') {
          await config.update('telegram.impl', impl, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(
            `Telegram transport set to "${impl}". Restart the server for changes to take effect.`
          );
          await this.updateWebview();
        }
        break;
      }
      case 'openExternal': {
        const url = msg.url as string;
        vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case 'refresh': {
        await this.refreshPairCode();
        await this.updateWebview();
        break;
      }
    }
  }

  private async updateWebview(): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorRemote');
    const telegramAuth = loadTelegramAuth(this.context);
    const telegramBotToken = await this.context.secrets.get(TELEGRAM_BOT_TOKEN_SECRET_KEY);
    const codeExpirySec = Math.max(0, Math.round((this._pairCodeExpiry - Date.now()) / 1000));
    const state = {
      pairCode: this._pairCode,
      pairCodeExpirySec: codeExpirySec,
      serverHost: config.get<string>('serverHost', '127.0.0.1'),
      serverPort: config.get<number>('serverPort', 3000),
      webappPassword: config.get<string>('webappPassword', ''),
      telegramEnabled: config.get<boolean>('telegram.enabled', false),
      telegramBotToken: telegramBotToken ?? '',
      telegramImpl: config.get<string>('telegram.impl', 'grammy'),
      telegramRegisterToken: telegramAuth?.token ?? '',
      telegramRegisteredUsers: telegramAuth?.registeredUsers ?? [],
    };
    this.panel.webview.html = getWebviewContent(state);
  }

  private dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stopPolling();
    SetupPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

interface PanelState {
  pairCode: string;
  pairCodeExpirySec: number;
  serverHost: string;
  serverPort: number;
  webappPassword: string;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramImpl: string;
  telegramRegisterToken: string;
  telegramRegisteredUsers: { id: number; username?: string; firstName?: string; registeredAt?: string }[];
}

function getWebviewContent(state: PanelState): string {
  const networkMode = state.serverHost === '127.0.0.1' ? 'localhost'
    : state.serverHost === '0.0.0.0' ? 'lan' : 'custom';
  const customAddress = networkMode === 'custom' ? state.serverHost : '';
  const hasBotToken = !!state.telegramBotToken;
  const maskedToken = hasBotToken
    ? state.telegramBotToken.slice(0, 6) + '...' + state.telegramBotToken.slice(-4)
    : '';
  const codeExpiryText = state.pairCodeExpirySec > 0
    ? `Expires in ${Math.floor(state.pairCodeExpirySec / 60)}m ${state.pairCodeExpirySec % 60}s`
    : '';

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CursorRemote Setup</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, var(--vscode-widget-border, #444));
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground);
      --btn-secondary-fg: var(--vscode-button-secondaryForeground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, var(--border));
      --success: var(--vscode-testing-iconPassed, #22c55e);
      --warn: var(--vscode-editorWarning-foreground, #fbbf24);
      --link: var(--vscode-textLink-foreground);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--bg);
      color: var(--fg);
      padding: 20px 28px 40px;
      line-height: 1.5;
      max-width: 720px;
      margin: 0 auto;
    }
    h1 { font-size: 1.6em; font-weight: 600; margin-bottom: 4px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 24px; }

    /* Pairing card */
    .pair-card {
      background: color-mix(in srgb, var(--btn-bg) 8%, var(--bg));
      border: 1px solid color-mix(in srgb, var(--btn-bg) 25%, var(--border));
      border-radius: 10px;
      padding: 24px;
      margin-bottom: 20px;
      text-align: center;
    }
    .pair-card h2 { font-size: 1.2em; margin-bottom: 8px; }
    .pair-card p { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
    .pair-code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 2em;
      font-weight: 700;
      letter-spacing: 0.15em;
      padding: 16px 20px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 8px;
      display: inline-block;
      margin-bottom: 12px;
      color: var(--fg);
    }
    .pair-code.empty { color: var(--vscode-descriptionForeground); opacity: 0.5; }
    .pair-expiry { font-size: 0.85em; color: var(--warn); margin-bottom: 12px; }
    .pair-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }

    button {
      font-family: inherit;
      font-size: inherit;
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      color: var(--btn-fg);
      background: var(--btn-bg);
      transition: background 0.15s;
    }
    button:hover { background: var(--btn-hover); }
    button.secondary {
      background: var(--btn-secondary-bg);
      color: var(--btn-secondary-fg);
    }
    button.secondary:hover { opacity: 0.85; }

    /* Section */
    .section { margin-bottom: 24px; }
    .section h3 {
      font-size: 1.05em;
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border);
    }

    /* Steps */
    .steps { display: flex; flex-direction: column; gap: 12px; margin: 12px 0; }
    .step { display: flex; align-items: flex-start; gap: 10px; }
    .step-num {
      width: 24px; height: 24px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 600; font-size: 0.9em;
      background: var(--btn-bg); color: var(--btn-fg);
      flex-shrink: 0;
    }
    .step-num.done { background: var(--success); }
    .step-text { padding-top: 2px; }
    .step-text strong { display: block; margin-bottom: 2px; }
    .step-text span { color: var(--vscode-descriptionForeground); font-size: 0.92em; }

    /* Radio */
    .radio-group { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
    .radio-option {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
    }
    .radio-option:hover { border-color: var(--btn-bg); }
    .radio-option.selected {
      border-color: var(--btn-bg);
      background: color-mix(in srgb, var(--btn-bg) 10%, transparent);
    }
    .radio-option input { margin-top: 3px; accent-color: var(--btn-bg); }
    .radio-label strong { display: block; margin-bottom: 2px; }
    .radio-label span { color: var(--vscode-descriptionForeground); font-size: 0.92em; }

    input[type="text"] {
      width: 100%;
      padding: 6px 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: inherit;
      border: 1px solid var(--input-border);
      border-radius: 4px;
      background: var(--input-bg);
      color: var(--input-fg);
      outline: none;
    }
    input:focus { border-color: var(--btn-bg); }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.85em;
      font-weight: 500;
      margin-left: 8px;
    }
    .badge.done { background: color-mix(in srgb, var(--success) 20%, transparent); color: var(--success); }
    .badge.pending { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }

    .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .info-text { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
    .mt { margin-top: 12px; }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Collapsible */
    details { margin-top: 8px; }
    details summary {
      cursor: pointer;
      padding: 8px 0;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
    }
    details[open] summary { color: var(--fg); }
  </style>
</head>
<body>
  <h1>CursorRemote Setup</h1>
  <p class="subtitle">Pair your phone or any browser to control Cursor remotely.</p>

  <div class="pair-card">
    <h2>Pairing Code</h2>
    <p>Open CursorRemote on your phone (or any browser) and enter this code. It expires in 10 minutes and works once.</p>
    <div class="pair-code ${state.pairCode ? '' : 'empty'}" id="pair-code">${state.pairCode ? escapeHtml(state.pairCode) : 'Generating...'}</div>
    ${state.pairCode ? `<div class="pair-expiry">${codeExpiryText}</div>` : ''}
    <div class="pair-actions">
      ${state.pairCode ? '<button id="copyCode">Copy code</button>' : ''}
      <button class="secondary" id="regenerateCode">Regenerate</button>
    </div>
  </div>

  <div class="section">
    <h3>How to connect</h3>
    <div class="steps">
      <div class="step">
        <div class="step-num ${state.pairCode ? 'done' : ''}">1</div>
        <div class="step-text">
          <strong>Start the server</strong>
          <span>The server runs automatically on extension load. If it's not running, click below.</span>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text">
          <strong>Open CursorRemote on your phone</strong>
          <span>Install the app or open the web client in any browser.</span>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text">
          <strong>Enter the pairing code above</strong>
          <span>The code is single-use. Generate a new one anytime to pair more devices.</span>
        </div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-text">
          <strong>Done — Claude is included</strong>
          <span>The mobile app already has a Claude tab. Use <code>claude remote-control</code> on your Mac to start a Claude Code session, then open it from the app.</span>
        </div>
      </div>
    </div>
    <div class="actions">
      <button id="restartServer">Restart server</button>
      <button class="secondary" id="openWebClient">Open web client</button>
    </div>
  </div>

  <details>
    <summary>Networking (advanced)</summary>
    <div class="section">
      <div class="radio-group">
        <label class="radio-option ${networkMode === 'localhost' ? 'selected' : ''}">
          <input type="radio" name="netMode" value="localhost" ${networkMode === 'localhost' ? 'checked' : ''} />
          <div class="radio-label">
            <strong>Localhost only</strong>
            <span>127.0.0.1 — no remote access. Use this if you only pair via the same machine.</span>
          </div>
        </label>
        <label class="radio-option ${networkMode === 'lan' ? 'selected' : ''}">
          <input type="radio" name="netMode" value="lan" ${networkMode === 'lan' ? 'checked' : ''} />
          <div class="radio-label">
            <strong>LAN access</strong>
            <span>0.0.0.0 — accessible from your local network. Required for pairing from another device on the same Wi-Fi.</span>
          </div>
        </label>
        <label class="radio-option ${networkMode === 'custom' ? 'selected' : ''}">
          <input type="radio" name="netMode" value="custom" ${networkMode === 'custom' ? 'checked' : ''} />
          <div class="radio-label">
            <strong>Tailscale / custom</strong>
            <span>Bind to a specific IP for Tailscale or a cloud relay.</span>
            <div style="margin-top: 8px; ${networkMode === 'custom' ? '' : 'display:none;'}">
              <input type="text" id="customAddress" placeholder="100.64.0.1" value="${escapeHtml(customAddress)}" style="width: 200px;" />
            </div>
          </div>
        </label>
      </div>
      <div class="actions">
        <button id="saveNetworking">Save networking</button>
      </div>
    </div>
  </details>

  <details>
    <summary>Telegram (optional)</summary>
    <div class="section">
      <div class="step">
        <div class="step-num ${hasBotToken ? 'done' : ''}">1</div>
        <div class="step-text">
          <strong>Create a Telegram Bot ${hasBotToken ? '<span class="badge done">Done</span>' : '<span class="badge pending">Pending</span>'}</strong>
          <span>Open <a href="#" onclick="sendMsg({type:'openExternal',url:'https://t.me/BotFather'})">@BotFather</a> and create a bot with <code>/newbot</code>.</span>
        </div>
      </div>
      ${hasBotToken
        ? `<p class="info-text mt">Token: <code>${escapeHtml(maskedToken)}</code></p>`
        : `<div class="mt">
            <input type="text" id="botTokenInput" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
            <div class="actions"><button id="saveToken">Save token</button></div>
          </div>`
      }
      <div class="step mt">
        <div class="step-num">2</div>
        <div class="step-text">
          <strong>Create a supergroup with Topics</strong>
          <span>Add the bot as admin with "Manage topics" permission.</span>
        </div>
      </div>
      <div class="step">
        <div class="step-num ${state.telegramRegisteredUsers.length > 0 ? 'done' : ''}">3</div>
        <div class="step-text">
          <strong>Register ${state.telegramRegisteredUsers.length > 0 ? '<span class="badge done">Done</span>' : '<span class="badge pending">Pending</span>'}</strong>
          ${state.telegramRegisterToken
            ? `<div class="mt"><code>/register ${escapeHtml(state.telegramRegisterToken)}</code></div>`
            : '<span class="info-text">Start the server to generate a registration token.</span>'}
        </div>
      </div>

      <div class="section mt">
        <h3>Transport engine</h3>
        <div class="radio-group">
          <label class="radio-option ${state.telegramImpl === 'grammy' ? 'selected' : ''}">
            <input type="radio" name="tgImpl" value="grammy" ${state.telegramImpl === 'grammy' ? 'checked' : ''} />
            <div class="radio-label">
              <strong>Grammy (default)</strong>
              <span>Full-featured bot framework.</span>
            </div>
          </label>
          <label class="radio-option ${state.telegramImpl === 'raw' ? 'selected' : ''}">
            <input type="radio" name="tgImpl" value="raw" ${state.telegramImpl === 'raw' ? 'checked' : ''} />
            <div class="radio-label">
              <strong>Raw (fallback)</strong>
              <span>Native fetch. Try if the bot hangs on startup.</span>
            </div>
          </label>
        </div>
        <div class="actions"><button id="saveTgImpl">Save</button></div>
      </div>
    </div>
  </details>

  <script>
    const vscode = acquireVsCodeApi();
    function sendMsg(msg) { vscode.postMessage(msg); }

    // Radio selection
    document.querySelectorAll('input[name="netMode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        document.querySelectorAll('input[name="netMode"]').forEach(r => {
          r.closest('.radio-option').classList.remove('selected');
        });
        radio.closest('.radio-option').classList.add('selected');
        const customRow = document.querySelector('input#customAddress')?.parentElement;
        if (customRow) customRow.style.display = radio.value === 'custom' ? '' : 'none';
      });
    });
    document.querySelectorAll('input[name="tgImpl"]').forEach(radio => {
      radio.addEventListener('change', () => {
        document.querySelectorAll('input[name="tgImpl"]').forEach(r => {
          r.closest('.radio-option').classList.remove('selected');
        });
        radio.closest('.radio-option').classList.add('selected');
      });
    });

    document.getElementById('copyCode')?.addEventListener('click', () => sendMsg({ type: 'copyCode' }));
    document.getElementById('regenerateCode')?.addEventListener('click', () => sendMsg({ type: 'regenerateCode' }));
    document.getElementById('restartServer')?.addEventListener('click', () => sendMsg({ type: 'restartServer' }));
    document.getElementById('openWebClient')?.addEventListener('click', () => sendMsg({ type: 'openWebClient' }));
    document.getElementById('saveNetworking')?.addEventListener('click', () => {
      const mode = document.querySelector('input[name="netMode"]:checked')?.value;
      const msg = { type: 'saveNetworking', mode };
      if (mode === 'custom') msg.address = document.getElementById('customAddress')?.value || '';
      sendMsg(msg);
      setTimeout(() => sendMsg({ type: 'restartServer' }), 500);
    });
    document.getElementById('saveToken')?.addEventListener('click', () => {
      const token = document.getElementById('botTokenInput')?.value;
      if (token) sendMsg({ type: 'saveTelegramToken', token });
    });
    document.getElementById('saveTgImpl')?.addEventListener('click', () => {
      const impl = document.querySelector('input[name="tgImpl"]:checked')?.value;
      if (impl) { sendMsg({ type: 'setTelegramImpl', impl }); setTimeout(() => sendMsg({ type: 'restartServer' }), 500); }
    });

    // Auto-refresh code expiry every 5s
    setInterval(() => sendMsg({ type: 'refresh' }), 5000);
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
