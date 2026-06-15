# Infrastructure

Shared Docker infrastructure for a personal Oracle VPS. Runs Caddy (reverse proxy + HTTPS) and PostgreSQL, with isolated Docker networks that project containers attach to.

## Layout

```
~/
├── infrastructure/       ← this repo
│   ├── docker-compose.yml
│   ├── Caddyfile
│   └── sites/
│       └── myapp/        ← built frontend files, written by each project's CI
│
└── myapp/                ← project repo (separate)
    └── docker-compose.yml
```

`sites/` is not tracked in this repo — it lives only on the server and is populated by each project's CI pipeline.

## Initial Server Setup

```bash
git clone <this repo> ~/infrastructure
cd ~/infrastructure

# Create the env file with a secure postgres password
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32)" > .env

# Update Caddyfile with your real domain, then:
docker compose up -d
```

Secrets (`POSTGRES_PASSWORD` etc.) are stored in GitHub Actions and written to `.env` on the server by this repo's own CI pipeline on every deploy.

## Adding a New Project

**1. Caddyfile** — open a PR adding a site block:

```caddy
myapp.yourdomain.com {
    root * /srv/myapp

    handle /api/* {
        reverse_proxy myapp-backend:3002
    }

    handle {
        encode gzip zstd
        try_files {path} {path}/ /index.html
        file_server
    }
}
```

Merging to `main` triggers this repo's CI, which reloads Caddy on the server automatically.

**2. Database** — create the DB and user directly on the server (database lifecycle is owned by each project):

```bash
docker exec -it postgres psql -U postgres
```

```sql
CREATE DATABASE myapp_db;
CREATE USER myapp_user WITH PASSWORD 'secure_password';
GRANT ALL PRIVILEGES ON DATABASE myapp_db TO myapp_user;
\c myapp_db
GRANT ALL ON SCHEMA public TO myapp_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO myapp_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO myapp_user;
```

**3. Project docker-compose.yml** — attach to infrastructure networks:

```yaml
services:
  myapp-backend:
    image: ghcr.io/you/myapp-backend:latest
    container_name: myapp-backend
    restart: unless-stopped
    environment:
      - DATABASE_URL=postgresql://myapp_user:secure_password@postgres:5432/myapp_db
      - NODE_ENV=production
      - PORT=3002
    networks:
      - caddy-web
      - postgres-db

networks:
  caddy-web:
    external: true
  postgres-db:
    external: true
```

## CI/CD

**This repo** — on merge to `main`, the pipeline writes `.env` and reloads Caddy. Secrets stored in GitHub Actions: `SERVER_HOST`, `SERVER_USER`, `SSH_DEPLOY_KEY`, `POSTGRES_PASSWORD`.

**Each project repo** — on merge to `main`:

- Backend: `docker build` → push to `ghcr.io/you/project-backend:latest` → SSH → `docker compose pull && docker compose up -d`
- Frontend: `npm run build` → `rsync dist/ user@server:~/infrastructure/sites/myapp/`

Both need `SSH_DEPLOY_KEY` as a GitHub Actions secret — generate a key pair, add the public key to `~/.ssh/authorized_keys` on the server.

## Common Commands

```bash
# Start / stop
docker compose up -d
docker compose down

# Logs
docker compose logs -f
docker compose logs -f caddy

# Reload Caddy after a manual Caddyfile change
docker exec caddy caddy reload --config /etc/caddy/Caddyfile

# Validate Caddyfile
docker run --rm -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile

# PostgreSQL
docker exec -it postgres psql -U postgres

# Backup
docker exec postgres pg_dumpall -U postgres > backup-$(date +%Y%m%d).sql
```

## DNS

Point A records to the VPS IP. Caddy handles HTTPS automatically via Let's Encrypt.

```
A  myapp.yourdomain.com  →  VPS_IP
```
