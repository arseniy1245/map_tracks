# Server Launch

## First Start

```sh
chmod +x start.sh
./start.sh
```

The script installs dependencies, builds the app, creates required `data` folders, and starts the production server.

Default address:

```txt
http://SERVER_IP:5173
```

## Options

Use another port:

```sh
PORT=3000 ./start.sh
```

Run behind nginx on localhost only:

```sh
HOST=127.0.0.1 PORT=5173 ./start.sh
```

Skip install/build on later restarts:

```sh
INSTALL=0 BUILD=0 ./start.sh
```

## Telegram Backups

On first start, `data/telegram-backup.json` is created from `data/telegram-backup.example.json`.
Fill `botToken` and `chatId` on the server, or use environment variables:

```sh
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx ./start.sh
```

## Git

Do not commit local runtime files:

```txt
data/telegram-backup.json
data/routes/
data/uploads/
data/routes-index.json
data/group-settings.json
```
