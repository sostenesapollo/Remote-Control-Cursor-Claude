# CursorRemote — instalação (você e amigos)

Site: [https://connect.blocks.pw](https://connect.blocks.pw) (landing + download).

Cada pessoa controla o **próprio** Cursor no Mac/PC dela, pelo celular dela.
Não usa o server de outra pessoa.

## 1. Instalar a extensão

Baixe em [connect.blocks.pw](https://connect.blocks.pw) (**Baixar extensão .vsix**)  
ou use o arquivo: `releases/cursor-remote-VERSION.vsix`

No Cursor:

1. `Cmd+Shift+P` → **Extensions: Install from VSIX...**
2. Escolha o `.vsix`
3. Recarregue a janela se pedir

```fish
cursor --install-extension ~/Downloads/cursor-remote-0.1.53.vsix
```

## 2. Abrir o Cursor com CDP

Feche o Cursor por completo (`Cmd+Q`) e abra de novo assim:

```fish
open -a Cursor --args --remote-debugging-port=9222
```

Confira: no browser, `http://localhost:9222/json` deve mostrar JSON.

## 3. Server sobe sozinho

A extensão inicia o relay. Sidebar **CursorRemote** → status Running.

Se não subir: **CursorRemote: Start Server**.

## 4. Pairing no celular

1. No Cursor: `Cmd+Shift+P` → **CursorRemote: Open Setup Panel**
2. Copie o **pairing code** (ex.: `ABC-DEF`)
3. No celular (mesma Wi‑Fi): abra `http://IP-DO-MAC:3000/app`
4. Cole o código → **Connect**

Fora da Wi‑Fi: Tailscale (recomendado) ou `ngrok http 3000` na máquina dela.

## 5. APK Android (opcional)

Também em [connect.blocks.pw](https://connect.blocks.pw) ou `releases/cursor-remote-mobile-1.0.0.apk`.

## Pra você (dev neste repo)

Se estiver rodando `npm start` no terminal, **pare** antes de usar a extensão — os dois brigam pela porta 3000.
