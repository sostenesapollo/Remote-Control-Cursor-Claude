# Conectar o celular (sem pagar)

## No app Android → Setup

- Server URL: `192.168.100.6:3000`
- Password: `DC8b4ZnLg8etGUiP`

Depois: Save & connect → aba Cursor.

## No Mac (obrigatório uma vez)

O Cursor precisa subir com CDP na porta **9223** (a 9222 está ocupada pelo Chrome).

1. Fecha o Cursor de verdade: **Cmd+Q**
2. No Terminal (fish):

```fish
open -a Cursor --args --remote-debugging-port=9223
```

3. Confirma:

```fish
curl http://127.0.0.1:9223/json
```

Deve voltar JSON. O relay já está rodando em `0.0.0.0:3000` sem license paga.

## Relay

```fish
cd ~/dev/CursorRemote
npm start
```

Senha também está em `.env` → `WEBAPP_PASSWORD`.
