# Infrastructure

This repo is the infrastructure boilerplate for my personal server (currently using an Oracle free-tier VPS). It runs Caddy as an HTTPS-enforcing reverse proxy, with isolated Docker networks that indvididual project containers can attach to. Global resources are also defined at this layer (currently only Postgres)

## Layout

```
~/
├── infrastructure/           ← this repo, copied over by its Deploy workflow
│   ├── docker-compose.yml    ← Caddy, Postgres and the deployer
│   ├── Caddyfile             ← global options; imports apps/*.caddy
│   ├── apps/
│   │   └── myapp.caddy       ← one site block per registered app
│   ├── scripts/              ← register-app.sh, provision-dbs.sh, app-env.sh
│   ├── deployer/             ← the service app CI deploys through (waynezhu.dev/deploy)
│   ├── actions/deploy/       ← the GitHub Action app repos call it with
│   ├── deploys/              ← NOT in git; deploy logs and each app's current image
│   ├── secrets/              ← NOT in git; generated per-app DATABASE_URLs
│   └── sites/
│       └── myapp/            ← NOT in git; built frontend, published by the deployer
│
└── myapp/                    ← only for apps still on the old SSH deploy
```

Global secrets (`POSTGRES_PASSWORD`) are stored in GitHub Actions and written to `.env` on the server on every deploy. Per-app database passwords are generated on the server and never leave it.

## Setting Up a New Server

Caddy and Postgres run in containers, so the host only needs Docker, git and a deploy user. `bootstrap.sh` handles all of that and is safe to re-run. Do these steps in order; projects can only deploy after this repo has deployed once, because it creates the shared Docker networks.

**1. Provision the machine.** Any Ubuntu or Debian VM with a public IP. On Oracle Cloud free tier:

- Create an instance with a Canonical Ubuntu image (Ampere/arm64 works).
- In the instance's VCN, open the subnet's security list and add ingress rules from `0.0.0.0/0` for TCP 80, TCP 443 and UDP 443. The host firewall is handled by the script; this cloud-level firewall is not.

**2. Point DNS at it.** Everything is served from one domain, `waynezhu.dev`: each app's frontend at `/apps/<name>/` and its backend at `/api/<name>/`. At the DNS provider for `waynezhu.dev`, create an `A` record for `@` (the bare domain) pointing at the server's public IP (plus an `AAAA` record if the server has IPv6). New apps need no DNS change. If the provider is Cloudflare, set the record to "DNS only" (grey cloud) so Caddy can get the certificate itself. Check it with `dig +short waynezhu.dev`, which should print the server's IP.

Caddy gets the Let's Encrypt certificate for `waynezhu.dev` on its own. `.dev` domains only load over HTTPS, so the Caddyfile always has a `waynezhu.dev` block; with no app at a path it serves a small "Nothing here" page.

All apps share one origin, so they share cookies and browser storage. App backends set cookies with path `/api/<name>` so they only go to their own API; app-template handles the path prefixes.

**3. Make a deploy key** on your own machine. This repo's CI uses it to SSH in (app repos don't; they go through the deployer):

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

Project repos need none of these: they deploy through the deployer, which this repo's deploy starts.

**6. Deploy.** Actions → Deploy → Run workflow (or push to `main`). Then on the server:

```bash
cd ~/infrastructure && make health
```

## Adding a New Project

Projects start from [app-template](https://github.com/waynezhu6/app-template). Registering one is a PR to this repo:

**1. Register it.** Either run Actions → **Register app** → Run workflow with the app's repo name (lowercase), or run it locally and open the PR yourself:

```bash
scripts/register-app.sh notes
```

Either way the result is one new file, `apps/notes.caddy`, imported into the `waynezhu.dev` block: `waynezhu.dev/apps/notes/` serves `/srv/notes` (the frontend), and `waynezhu.dev/api/notes/...` goes to `notes-backend:3001` as `/api/...` (the backend container). The workflow needs Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" ticked once.

**2. Merge the PR.** The Deploy workflow validates the Caddy config, reloads Caddy, and runs `scripts/provision-dbs.sh`, which creates a `notes` role and database with a generated password and stores its `DATABASE_URL` in `~/infrastructure/secrets/notes.env`. (Dashes in names become underscores in Postgres: `my-app` → `my_app`.)

**3. Push to the app's `main`.** The app repo needs no secrets: its Deploy workflow proves who it is to the deployer with a GitHub OIDC token (see "Deploys" below). The deploy fails with a clear message if the app isn't registered yet.

While this repo is private, other repos can only use its deploy action once: Settings → Actions → General → Access → "Accessible from repositories owned by the user 'waynezhu6'". Once the repo is public this isn't needed.

**App secrets** (API keys and the like): append `NAME=value` lines to `~/infrastructure/secrets/<name>.env` on the server, after the `DATABASE_URL` line, then re-run the app's Deploy workflow. Each deploy passes that whole file to the container as its environment, so they reach it without living in any repo or GitHub secret. Provisioning only ever reads the `DATABASE_URL` line and never rewrites an existing file, so added lines survive deploys.

**Removing a project**: delete `apps/<name>.caddy` by PR. On deploy Caddy stops serving it and the deployer refuses its deploys. The container, database, `secrets/<name>.env` and `sites/<name>` are left in place on purpose; remove them by hand once you're sure (`docker rm -f <name>-backend`, `docker exec -it postgres psql -U postgres -c 'DROP DATABASE <name>'` etc.).

## CI/CD

**This repo**: on merge to `main`, CI copies the repo's files to `~/infrastructure` with rsync, writes `.env`, runs `docker compose up -d`, creates any missing app databases and reloads Caddy. Secrets stored in GitHub Actions: `SERVER_HOST`, `SERVER_USER`, `SSH_DEPLOY_KEY`, `POSTGRES_PASSWORD`.

**Each project repo**: on merge to `main`, CI builds one image holding the backend and the built frontend, pushes it to `ghcr.io/<owner>/<app>-backend`, then calls the deployer with the image's digest through `actions/deploy` in this repo. See "Deploys" below. Project repos hold no deploy secrets.

The server never runs `git clone` or `git pull`; CI pushes files to it. So the server holds no GitHub credentials beyond the read-only GHCR login. A few things follow from that:

- Don't edit files under `~/infrastructure` on the server; the next deploy overwrites them. Make changes by PR.
- The rsync doesn't delete anything, so `.env`, `sites/` and anything else you keep there survive deploys. A file removed from this repo stays on the server until you delete it by hand.
- `apps/` is the exception: it's mirrored exactly (`--delete`), so removing an app's file unregisters it.
- Files are written in place (`--inplace`), so Caddy's single-file mount of the Caddyfile sees the new version on `caddy reload`.

To pull a repo by hand on the server (for debugging, say), use SSH agent forwarding rather than storing a token there: add `ForwardAgent yes` for the server in your laptop's `~/.ssh/config`, and use `git@github.com:` remotes.

## Deploys

App repos deploy by calling `POST waynezhu.dev/deploy` with their image digest (the `actions/deploy` action does this). The deployer (`deployer/`) runs as a container next to Caddy and drives the host's Docker.

**Who may deploy.** The call carries a GitHub Actions OIDC token: a short-lived token GitHub signs to say which repo, branch and run it came from. The deployer checks its signature against GitHub's published keys and that it was issued for `https://waynezhu.dev/deploy`, then only accepts it if:

- the repo belongs to `waynezhu6` (checked by account id, so a renamed account can't be impersonated),
- it ran on `main`, and
- the app is registered (`apps/<name>.caddy`).

The app is always the calling repo's own name, and the image is always `ghcr.io/waynezhu6/<app>-backend` at the given digest, so a repo can only deploy its own app's image and the endpoint never runs anything else. Each token can start one deploy. Nothing is stored in any repo; the server keeps its existing GHCR login to pull.

**What a deploy does.** Pull the image by digest; copy the frontend out of it (`/app/frontend/dist`); start the backend from `deployer/app.compose.yml` (container `<app>-backend` on `caddy-web` and `postgres-db`, environment from `secrets/<app>.env`); wait up to 90 s for `/api/health`. If it's healthy, the new frontend replaces `sites/<app>` and the deploy succeeds. If not, the last 40 log lines are shown, the previous image is started again and the frontend is left as it was, so a bad push doesn't take the app down.

**Output.** The request stays open and the deploy's output streams into the Actions log as it happens, ending with `==> deploy <id> succeeded|failed|superseded`, which passes or fails the step. If the connection drops the deploy carries on and the action follows it at `GET /deploy/jobs/<id>`. Every deploy's log is also kept at `~/infrastructure/deploys/logs/<app>/<id>.log`.

**Overlapping calls.** One deploy per app at a time; different apps deploy in parallel. While one runs, only the newest request waits behind it, and an older waiting one is reported as superseded. A call for the image already being deployed joins that deploy, and one for the image already live does nothing.

**Rolling back by hand.** The previous good image stays tagged on the server as `local/<app>-backend:previous`. Re-running an older commit's Deploy workflow redeploys its image, as long as GHCR still has it (the newest five are kept).

Restarting the deployer (any deploy of this repo that changes `deployer/`) waits for running deploys to finish first.

Apps created before the deployer still deploy over SSH with `SERVER_HOST`, `SERVER_USER` and `SSH_DEPLOY_KEY` until their workflow and Dockerfile are updated from app-template; the first deploy through the deployer adopts the running container as its rollback target.

## Common Commands

```bash
# Start / stop
docker compose up -d
docker compose down

# Logs
docker compose logs -f
docker compose logs -f caddy
ls ~/infrastructure/deploys/logs/<app>/     # one file per app deploy

# Reload Caddy after a manual Caddyfile change
docker exec caddy caddy reload --config /etc/caddy/Caddyfile

# Validate Caddyfile
docker run --rm -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile -v $(pwd)/apps:/etc/caddy/apps caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile

# PostgreSQL
docker exec -it postgres psql -U postgres

# Backup
docker exec postgres pg_dumpall -U postgres > backup-$(date +%Y%m%d).sql
```
