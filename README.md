# n8n Robust Relay

Generic stealth relay used by n8n workflows to reach APIs (Groq, etc.) through
whatever server this is deployed on. Speaks one JSON envelope over `POST /proxy`:

```json
{ "secret": "...", "targetUrl": "https://...", "method": "POST", "headers": {}, "params": {}, "data": {} }
```

and responds with `{ success, meta, status, statusText, data, headers }`.
`GET /health` for a liveness check.

## Install (first time, one command)

```bash
git clone https://github.com/Zoro-py/zoro_calendar_proxy.git /opt/n8n-relay && \
cd /opt/n8n-relay && \
read -p "Secret (Enter = auto-generate): " S; [ -z "$S" ] && S=$(openssl rand -hex 32); \
printf "PROXY_SECRET=%s\nPORT=8787\n" "$S" > .env && \
docker compose up -d --build && \
echo "Secret in use:" && cat .env
```

## Update later

```bash
cd /opt/n8n-relay && git pull origin main && docker compose up -d --build
```

`.env` is git-ignored, so pulling never touches your secret. Each deployed
instance keeps its own `PROXY_SECRET` — set a different one per server.
