# Infrastructure

This repo is the infrastructure boilerplate for my personal server (currently using an Oracle free-tier VPS). It runs Caddy as an HTTPS-enforcing reverse proxy, with isolated Docker networks that indvididual project containers can attach to. Global resources are also defined at this layer (currently only Postgres)

## Layout

```
~/
├── infrastructure/           ← this repo, copied over by its Deploy workflow
│   ├── docker-compose.yml    ← Caddy + Postgres
│   ├── Caddyfile             ← global options; imports apps/*.caddy
│   ├── apps/
│   │   └── myapp.caddy       ← one site block per registered app
│   ├── scripts/              ← register-app.sh, provision-dbs.sh, app-env.sh
│   ├── secrets/              ← NOT in git; generated per-app DATABASE_URLs
│   └── sites/
│       └── myapp/            ← NOT in git; built frontend, written by the app's CI
│
└── myapp/                    ← the app's docker-compose.yml and .env, written by its CI
```

Global secrets (`POSTGRES_PASSWORD`) are stored in GitHub Actions and written to `.env` on the server on every deploy. Per-app database passwords are generated on the server and never leave it.

## Setting Up a New Server

Caddy and Postgres run in containers, so the host only needs Docker, git and a deploy user. `bootstrap.sh` handles all of that and is safe to re-run. Do these steps in order; projects can only deploy after this repo has deployed once, because it creates the shared Docker networks.

**1. Provision the machine.** Any Ubuntu or Debian VM with a public IP. On Oracle Cloud free tier:

- Create an instance with a Canonical Ubuntu image (Ampere/arm64 works).
- In the instance's VCN, open the subnet's security list and add ingress rules from `0.0.0.0/0` for TCP 80, TCP 443 and UDP 443. The host firewall is handled by the script; this cloud-level firewall is not.

**2. Point DNS at it.** Create an `A` record for each app's domain (e.g. `notes.example.com`) pointing at the server's public IP. Caddy can't get HTTPS certificates until these resolve.

**3. Make a deploy key** on your own machine. This one key pair is what every repo's CI uses to SSH in:

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C "github-deploy"
```

**4. Run the bootstrap script** on the server, logged in as the default user (`ubuntu` on Oracle). The repo is private, so copy the script over rather than fetching it:

```bash
scp bootstrap.sh ubuntu@<server-ip>:
ssh ubuntu@<server-ip> 'sudo bash bootstrap.sh --user ubuntu --pubkey "'"$(cat deploy_key.pub)"'"'
```

It installs Docker Engine with the compose plugin, adds the user to the `docker` group, authorizes the deploy key, opens 80/443 in the host firewall (Oracle's Ubuntu images block them with iptables by default) and creates `~/infrastructure/sites/` owned by the deploy user. It does not need this repo on the server: the Deploy workflow copies the files over, so the server never needs GitHub credentials.

To let the server pull private app images from GHCR, also pass `--ghcr-user` and pipe in a token. Create a classic personal access token with only the `read:packages` scope (GitHub → Settings → Developer settings → Personal access tokens) and save it to a file, e.g. `ghcr_token`. The script reads it from stdin so it never appears on a command line, and logs the deploy user in to `ghcr.io` once. App repos then need no registry credentials of their own.

```bash
cat ghcr_token | ssh ubuntu@<server-ip> 'sudo bash bootstrap.sh --user ubuntu --ghcr-user <github-username> --pubkey "'"$(cat deploy_key.pub)"'"'
```

Re-run with a new token the same way if it expires or is revoked.

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

Projects start from [app-template](https://github.com/waynezhu6/app-template). Registering one is a PR to this repo:

**1. Register it.** Either run Actions → **Register app** → Run workflow with the app's repo name (lowercase) and domain, or run it locally and open the PR yourself:

```bash
scripts/register-app.sh notes notes.example.com
```

Either way the result is one new file, `apps/notes.caddy`, routing the domain to `/srv/notes` (the frontend) and `notes-backend:3001` (the backend container). The workflow needs Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" ticked once.

**2. Merge the PR.** The Deploy workflow validates the Caddy config, reloads Caddy, and runs `scripts/provision-dbs.sh`, which creates a `notes` role and database with a generated password and stores its `DATABASE_URL` in `~/infrastructure/secrets/notes.env`. (Dashes in names become underscores in Postgres: `my-app` → `my_app`.)

**3. Point DNS** for the domain at the server.

**4. Set the app repo's secrets**: `SERVER_HOST`, `SERVER_USER`, `SSH_DEPLOY_KEY`. No database secret: the app's deploy reads it from the server with `scripts/app-env.sh <name>`, and fails with a clear message if the app isn't registered yet.

Then push to the app's `main`.

**Removing a project**: delete `apps/<name>.caddy` by PR. On deploy Caddy stops serving it. The database, `secrets/<name>.env`, `sites/<name>` and `~/<name>` are left in place on purpose; remove them by hand once you're sure (`docker exec -it postgres psql -U postgres -c 'DROP DATABASE <name>'` etc.).

## CI/CD

**This repo**: on merge to `main`, CI copies the repo's files to `~/infrastructure` with rsync, writes `.env`, runs `docker compose up -d`, creates any missing app databases and reloads Caddy. Secrets stored in GitHub Actions: `SERVER_HOST`, `SERVER_USER`, `SSH_DEPLOY_KEY`, `POSTGRES_PASSWORD`.

**Each project repo**: on merge to `main`:

- Backend: `docker build` → push to `ghcr.io/<owner>/<app>-backend:latest` → copy `docker-compose.yml` and `.env` to `~/<app>`, append `scripts/app-env.sh <app>` → `docker compose pull && up -d`
- Frontend: `npm run build` → `rsync dist/ user@server:~/infrastructure/sites/<app>/`

Both need `SSH_DEPLOY_KEY` as a GitHub Actions secret. Its public half goes in the deploy user's `~/.ssh/authorized_keys` (bootstrap's `--pubkey` does this).

The server never runs `git clone` or `git pull`; CI pushes files to it. So the server holds no GitHub credentials beyond the read-only GHCR login. A few things follow from that:

- Don't edit files under `~/infrastructure` on the server; the next deploy overwrites them. Make changes by PR.
- The rsync doesn't delete anything, so `.env`, `sites/` and anything else you keep there survive deploys. A file removed from this repo stays on the server until you delete it by hand.
- `apps/` is the exception: it's mirrored exactly (`--delete`), so removing an app's file unregisters it.
- Files are written in place (`--inplace`), so Caddy's single-file mount of the Caddyfile sees the new version on `caddy reload`.

To pull a repo by hand on the server (for debugging, say), use SSH agent forwarding rather than storing a token there: add `ForwardAgent yes` for the server in your laptop's `~/.ssh/config`, and use `git@github.com:` remotes.

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
docker run --rm -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile -v $(pwd)/apps:/etc/caddy/apps caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile

# PostgreSQL
docker exec -it postgres psql -U postgres

# Backup
docker exec postgres pg_dumpall -U postgres > backup-$(date +%Y%m%d).sql
```
