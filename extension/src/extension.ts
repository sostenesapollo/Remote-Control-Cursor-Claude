import * as vscode from 'vscode';
import { join } from 'path';
import { createOutputChannel, type UnifiedOutputChannel } from './output-channel.js';
import { createStatusBar } from './status-bar.js';
import { ServerManager } from './server-manager.js';
import { LicenseManager } from './license-manager.js';
import { StatusTreeView } from './tree-view.js';
import { SetupPanel } from './setup-panel.js';
import { TELEGRAM_BOT_TOKEN_SECRET_KEY } from './secrets.js';

let serverManager: ServerManager | undefined;

async function ensurePairingReady(): Promise<void> {
  // Pairing is enabled by default on the server side. Nothing to generate
  // here — the setup panel requests a code from the running server.
  // Keep networking accessible for remote pairing (LAN/custom).
  const config = vscode.workspace.getConfiguration('cursorRemote');
  const host = config.get<string>('serverHost', '127.0.0.1');
  if (host === '127.0.0.1') {
    // Default to LAN so phones on the same Wi-Fi can pair without extra setup.
    await config.update('serverHost', '0.0.0.0', vscode.ConfigurationTarget.Global);
  }
}

async function migrateTelegramBotToken(
  context: vscode.ExtensionContext,
  outputChannel: UnifiedOutputChannel
): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorRemote');
  const legacy = config.get<string>('telegram.botToken', '');
  if (!legacy.trim()) return;

  try {
    await context.secrets.store(TELEGRAM_BOT_TOKEN_SECRET_KEY, legacy);
    const stored = await context.secrets.get(TELEGRAM_BOT_TOKEN_SECRET_KEY);
    if (stored === legacy) {
      await config.update('telegram.botToken', undefined, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        'CursorRemote: your Telegram bot token was moved to secure storage.'
      );
    }
  } catch (err) {
    outputChannel.warn(`Telegram bot token migration failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = createOutputChannel();

  const statusBarItem = createStatusBar(context);

  const licenseManager = new LicenseManager(context, () => {
    if (serverManager && serverManager.serverState === 'stopped') {
      serverManager.start();
    }
  });

  await migrateTelegramBotToken(context, outputChannel);

  serverManager = new ServerManager(
    context,
    outputChannel,
    statusBarItem,
    () => licenseManager.getKey()
  );

  serverManager.startDirWatcher();

  const extensionVersion = context.extension.packageJSON?.version ?? 'unknown';
  const treeView = new StatusTreeView(serverManager, licenseManager, extensionVersion);
  const serverLogPath = join(context.extensionPath, 'temp', 'server.log');

  context.subscriptions.push(
    outputChannel,
    vscode.window.registerTreeDataProvider('cursorRemote.status', treeView),
    vscode.commands.registerCommand('cursorRemote.start', () => serverManager!.start()),
    vscode.commands.registerCommand('cursorRemote.stop', () => serverManager!.stop(true)),
    vscode.commands.registerCommand('cursorRemote.restart', () => serverManager!.restart()),
    vscode.commands.registerCommand('cursorRemote.openWebClient', () => serverManager!.openWebClient()),
    vscode.commands.registerCommand('cursorRemote.showLogs', async () => {
      outputChannel.reveal([
        'CursorRemote - no server output captured yet.',
        `Extension version: ${extensionVersion}`,
        `Server state: ${serverManager?.serverState ?? 'unknown'}`,
        `Server log file: ${serverLogPath}`,
        'Logs appear here once the server starts.',
      ]);
      // Cursor's output service silently ignores OutputChannel.show() — the
      // panel never opens or switches channel (public#47). Open the channel's
      // backing log file too; the editor works on every build.
      try {
        const logFile = vscode.Uri.joinPath(context.logUri, 'CursorRemote.log');
        await vscode.workspace.fs.stat(logFile);
        const doc = await vscode.workspace.openTextDocument(logFile);
        const end = doc.lineCount > 0
          ? doc.lineAt(doc.lineCount - 1).range.end
          : new vscode.Position(0, 0);
        await vscode.window.showTextDocument(doc, {
          preview: true,
          selection: new vscode.Range(end, end),
        });
      } catch {
        // No backing file (plain, non-log output channel) — reveal() above
        // already appended a diagnostic header in that case.
      }
    }),
    vscode.commands.registerCommand('cursorRemote.enterLicenseKey', async () => {
      await licenseManager.promptForKey();
      treeView.refresh();
    }),
    vscode.commands.registerCommand('cursorRemote.buyLicense', () => licenseManager.openBuyLink()),
    vscode.commands.registerCommand('cursorRemote.clearLicenseKey', async () => {
      await licenseManager.clearKey();
      treeView.refresh();
    }),
    vscode.commands.registerCommand('cursorRemote.openSetup', () => SetupPanel.createOrShow(context)),
  );

  ensurePairingReady().catch(err => {
    outputChannel.warn(`Pairing setup failed: ${err}`);
  });

  const config = vscode.workspace.getConfiguration('cursorRemote');
  if (config.get<boolean>('autoStart', true)) {
    licenseManager.checkLicense().then(valid => {
      if (valid) {
        serverManager!.start();
      }
    });
  }
}

export async function deactivate(): Promise<void> {
  if (serverManager) {
    await serverManager.stop();
    serverManager.dispose();
  }
}
