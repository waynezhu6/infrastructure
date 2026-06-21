# Infrastructure

This repo is the infrastructure boilerplate for my personal server (currently using an Oracle free-tier VPS). It runs Caddy as an HTTPS-enforcing reverse proxy, with isolated Docker networks that indvididual project containers can attach to. Global resources are also defined at this layer (currently only Postgres)

## Layout

```
~/
├── infrastructure/       ← this repo
│   ├── docker-compose.yml
│   ├── Caddyfile
│   └── sites/
│       └── myapp/        ← built frontend files, written by each project's CI
│
└── myapp/                ← individual project repo (separate)
    └── docker-compose.yml
```

Note that `sites/` is not actually tracked in this repo; instead it represents local copies of each individual project repo, which should be  populated and updated by each individual project's CI pipeline.

Global secrets (`POSTGRES_PASSWORD` etc.) are stored in GitHub Actions and written to `.env` on the server by this repo's own CI pipeline on every deploy.

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

Merging to `main` triggers CI which will rebuild all services defined in docker-compose.yml (currently only Caddy and Postgres) and restart them to pick up any changes.

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

- Backend: `docker build` → push to `ghcr.io/you/project-backend:latest` → SSH → clone-or-pull → `docker compose up -d`
- Frontend: `npm run build` → `rsync dist/ user@server:~/infrastructure/sites/myapp/`

Both need `SSH_DEPLOY_KEY` as a GitHub Actions secret — generate a key pair, add the public key to `~/.ssh/authorized_keys` on the server.

Pipelines use a clone-or-pull pattern so no manual server bootstrap is needed:

```bash
if [ -d ~/myapp ]; then
  git -C ~/myapp pull
else
  git clone https://github.com/you/myapp.git ~/myapp
fi
```

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
