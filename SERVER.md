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

Increase app upload limit:

```sh
MAX_UPLOAD_MB=200 ./start.sh
```

## Nginx Proxy

If the app is behind nginx, allow larger GPX/FIT uploads:

```nginx
server {
  client_max_body_size 100M;

  location / {
    proxy_pass http://127.0.0.1:5173;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

After editing nginx:

```sh
sudo nginx -t
sudo systemctl reload nginx
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

## Upload Troubleshooting

If GPX/FIT files do not upload:

```sh
ls -la data data/routes data/uploads
```

The user running Node must be able to write to `data/routes` and `data/uploads`.

Check server logs while uploading:

```sh
./start.sh
```

Common statuses:

```txt
413 - nginx or MAX_UPLOAD_MB limit is too low
500 - check Node logs and data folder permissions
```
