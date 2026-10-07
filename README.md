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

## Setting Up a New Server

Caddy and Postgres run in containers, so the host only needs Docker, git and a deploy user. `bootstrap.sh` handles all of that and is safe to re-run. Do these steps in order; projects can only deploy after this repo has deployed once, because it creates the shared Docker networks.

**1. Provision the machine.** Any Ubuntu or Debian VM with a public IP. On Oracle Cloud free tier:

- Create an instance with a Canonical Ubuntu image (Ampere/arm64 works).
- In the instance's VCN, open the subnet's security list and add ingress rules from `0.0.0.0/0` for TCP 80, TCP 443 and UDP 443. The host firewall is handled by the script; this cloud-level firewall is not.

**2. Point DNS at it.** Create an `A` record for each site domain in the Caddyfile (e.g. `todo.example.com`) pointing at the server's public IP. Caddy can't get HTTPS certificates until these resolve.

**3. Make a deploy key** on your own machine. This one key pair is what every repo's CI uses to SSH in:

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C "github-deploy"
```

**4. Run the bootstrap script** on the server, logged in as the default user (`ubuntu` on Oracle). The repo is private, so copy the script over rather than fetching it:

```bash
scp bootstrap.sh ubuntu@<server-ip>:
ssh ubuntu@<server-ip> 'sudo bash bootstrap.sh --user ubuntu --pubkey "'"$(cat deploy_key.pub)"'"'
```

It installs Docker Engine with the compose plugin, adds the user to the `docker` group, authorizes the deploy key, opens 80/443 in the host firewall (Oracle's Ubuntu images block them with iptables by default) and creates `~/infrastructure/sites/` owned by the deploy user. It does not clone this repo; the Deploy workflow does that.

**5. Add GitHub Actions secrets** to this repo (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `SERVER_HOST` | Server's public IP |
| `SERVER_USER` | The `--user` from step 4 |
| `SSH_DEPLOY_KEY` | Contents of `deploy_key` (the private half) |
| `POSTGRES_PASSWORD` | A new strong password. Postgres only reads this the first time its volume is created, so changing it later has no effect. |

Project repos need the same `SERVER_HOST`, `SERVER_USER` and `SSH_DEPLOY_KEY`.

**6. Deploy.** Actions → Deploy → Run workflow (or push to `main`). Then on the server:

```bash
cd ~/infrastructure && make health
```

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
