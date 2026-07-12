# Conectar o celular (sem pagar)

## Ngrok (de fora da rede)

Túnel ativo → no app **Setup**:

- Server URL: `https://c8db-2803-2a00-2002-e856-d989-f9f9-96a9-effe.ngrok-free.app`
- Password: `DC8b4ZnLg8etGUiP`

Reinstala o APK atualizado (pula aviso do ngrok free):

`releases/cursor-remote-mobile-1.0.0.apk`

Subir o túnel de novo (quando cair):

```fish
ngrok http 3000
```

A URL muda a cada sessão no plano free — copia a nova `https://….ngrok-free.app` pro Setup.

## LAN (mesma Wi‑Fi)

- Server URL: `192.168.100.6:3000`
- Password: `DC8b4ZnLg8etGUiP`

## No Mac

```fish
open -a Cursor --args --remote-debugging-port=9223
cd ~/dev/CursorRemote
npm start
ngrok http 3000
```
