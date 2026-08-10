# n8n Robust Relay

Generic stealth relay used by n8n workflows to reach APIs (Groq, etc.) through
whatever server this is deployed on. Speaks one JSON envelope over `POST /proxy`:

```json
{ "secret": "...", "targetUrl": "https://...", "method": "POST", "headers": {}, "params": {}, "data": {} }
```

and responds with `{ success, meta, status, statusText, data, headers }`.
`GET /health` for a liveness check.

## Install or update — same one command every time

```bash
[ -d /opt/n8n-relay ] || git clone https://github.com/Zoro-py/zoro_calendar_proxy.git /opt/n8n-relay; \
cd /opt/n8n-relay && git pull origin main && chmod +x deploy.sh && ./deploy.sh
```

- First run: clones the repo, asks for a secret (Enter = auto-generate a random one), builds, starts.
- Every later run: pulls the latest code and rebuilds — `.env` already exists so it won't ask again.

Each server keeps its own `PROXY_SECRET` in its own `.env` (git-ignored, never touched by `git pull`).
