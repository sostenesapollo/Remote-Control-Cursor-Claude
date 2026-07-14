# CursorRemote Mobile (Android)

Shell app with two agent tabs:

| Tab | What it does |
|-----|----------------|
| **Cursor** | Logs into your CursorRemote relay (`/api/login`) and loads the web client |
| **Claude** | Opens [claude.ai/code](https://claude.ai/code) so you can join a **Claude Code Remote Control** session on your Mac |
| **Setup** | Server URL, password, Claude URL |

## Why Claude is a WebView (not CDP)

CursorRemote talks to Cursor via Chrome DevTools Protocol. Claude Code does **not** expose that. Anthropic already ships Remote Control: the session stays on your Mac; the phone joins through Anthropic’s bridge.

On the Mac:

```fish
claude remote-control
```

Then in the app → **Claude** tab → sign in with the same Anthropic account and pick the session (or paste the session URL in Setup).

You can also use the official Claude Android app for that side; this APK keeps Cursor + Claude in one place.

## Build APK

```fish
set -x ANDROID_HOME /opt/homebrew/share/android-commandlinetools
set -x ANDROID_SDK_ROOT $ANDROID_HOME
cd mobile
flutter pub get
flutter build apk --debug
```

Output:

`mobile/build/app/outputs/flutter-apk/app-debug.apk`

Install (USB debugging):

```fish
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

Or copy the APK to the phone and open it (allow install from unknown sources).

## Setup on the phone

1. CursorRemote running on the Mac (extension or `npm start`)
2. Networking: **LAN** or **Tailscale** (not localhost-only)
3. In the app **Setup**: `TAILSCALE_IP:3000` + web password
4. Save → **Cursor** tab
5. Mac: `claude remote-control` → **Claude** tab

## Claude Code ↔ Telegram (same group as Cursor)

The relay can forward Claude Code sessions into the **same** Telegram forum:

1. Relay running with Telegram `/sync` already done
2. Hooks auto-installed in `~/.claude/settings.json` (or `npx tsx scripts/install-claude-hooks.ts`)
3. Run Claude Code normally in a project terminal

You'll get topics like `Claude — <folder>` with:

- Notifications (idle / needs input)
- Permission Allow/Deny buttons (when Claude asks)
- Colored circle icons (same palette as Cursor topics)
- **Send prompts from Telegram** — type in the Claude topic; the relay runs
  `claude -p --resume <session>` and posts the reply back (Claude Desktop
  must be logged in on the Mac so auth can be reused)

## Security

Same rules as the web client: prefer Tailscale, keep a strong password, never expose CDP port `9222`.
