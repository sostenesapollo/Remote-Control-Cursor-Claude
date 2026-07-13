# CursorRemote — AWS EC2 Deployment

## Instance

- **Region**: `sa-east-1`
- **Type**: `t3.micro` (free-tier eligible)
- **AMI**: Amazon Linux 2023 (AL2023)
- **Public IP**: `18.228.116.226`
- **Instance ID**: `i-021a4d032ab037dcc`
- **VPC**: `vpc-0dee993dc080bcd8c` (default)
- **Subnet**: `subnet-08bbe325a5ee151ed` (sa-east-1a)
- **Security group**: `sg-0c1ecbf5083aa05e2` (cursor-remote)
  - Inbound: 22 (SSH), 80, 443, 3000 (relay) — all `0.0.0.0/0`
- **Key pair**: `cursor-remote` (private key at `~/.ssh/cursor-remote-aws.pem`)
- **AWS profile**: `tailscale-dev` (`~/.aws/credentials`)

## App layout on the host

- App dir: `/opt/cursorremote/app`
  - `dist/` — compiled server + client (rsync'd from dev machine)
  - `package.json` + `node_modules/` — production deps (`npm install --omit=dev`)
  - `data/` — `pair-codes.json`, `sessions.json`, `license.key` (runtime state)
  - `temp/server.log` — log file
  - `selectors.json` — empty (uses defaults)
- Process manager: **PM2** (process name `cursorremote`)
  - Restarts automatically on reboot (systemd unit installed)
- Env: `PORT=3000 SERVER_HOST=0.0.0.0 PAIRING_DISABLED=false DATA_DIR=/opt/cursorremote/app/data`

## Deploy / update flow

```fish
# 1. Build locally
cd ~/dev/CursorRemote
npm run build

# 2. Push new dist + package.json to the instance
rsync -az --delete -e "ssh -i ~/.ssh/cursor-remote-aws.pem -o StrictHostKeyChecking=no" \
  dist/ ec2-user@18.228.116.226:/opt/cursorremote/app/dist/
scp -i ~/.ssh/cursor-remote-aws.pem -o StrictHostKeyChecking=no \
  package.json ec2-user@18.228.116.226:/opt/cursorremote/app/package.json

# 3. SSH in, install deps if package.json changed, restart
ssh -i ~/.ssh/cursor-remote-aws.pem -o StrictHostKeyChecking=no ec2-user@18.228.116.226 \
  'cd /opt/cursorremote/app && npm install --omit=dev --no-audit --no-fund && pm2 restart cursorremote'
```

## Public domain

- **URL**: `https://connect.blocks.pw` (live)
- **Path**: Cloudflare → Coolify (`cursorremote-connect` nginx) → AWS EC2 `18.228.116.226:3000`
- Coolify app uuid: `xrddqbt8el2otdxcbwzh1l9j` (project `blocks.pw`)
- Optional direct TLS on EC2: Caddy on `:80`/`:443` (cert needs DNS-only A to the instance)
- Helper if you want a grey-cloud A record: `fish scripts/dns-connect-blocks.fish` (`CF_API_TOKEN`)

Routes on the relay:

| Path | Purpose |
|---|---|
| `/` | Landing (install + download) |
| `/app` | Web remote client |
| `/download/cursor-remote.vsix` | Extension package |
| `/download/cursor-remote.apk` | Android APK |

## Connecting clients

The relay listens on `http://18.228.116.226:3000`.

- **Web**: open `http://18.228.116.226:3000` in a browser. You'll see the pairing screen. Generate a code from the VS Code extension or via `POST /api/pair/code`, paste it, and you're in.
- **Mobile**: in the app's Setup tab, enter `18.228.116.226:3000` as the server address and the pairing code.
- **VS Code extension**: open `CursorRemote: Setup`, the panel shows the pairing code (calls `/api/pair/code` on the relay).

## Endpoints verified

- `GET /health` → `{"ok":true,"pairingEnabled":true,...}`
- `POST /api/pair/code` → `{"code":"XXX-XXX","expiresInMs":600000}`
- `POST /api/pair` with `{"code":"XXX-XXX"}` → `{"token":"..."}` (one-time; second use → `404 Invalid or expired code`)
- `GET /login` → pairing-code page

## Notes

- The relay has no Cursor IDE to connect to on this host (no CDP at 127.0.0.1:9222). CDP errors in the logs are non-fatal; the relay stays up and accepts clients. A Cursor window must be reachable from the relay for agent state to flow — typically you'd run Cursor locally and point `CDP_URL` at it via a tunnel, or run Cursor on the same host.
- AWS credentials live in `~/.aws/credentials` under the `[tailscale-dev]` profile. Never commit.
