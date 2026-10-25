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
│   ├── scripts/              ← register-app.sh, app-env.sh
│   ├── deployer/             ← the service app CI deploys through (waynezhu.dev/deploy)
│   ├── actions/deploy/       ← the GitHub Action app repos call it with
│   ├── backup/               ← the nightly backup container
│   ├── monitor/              ← health checks and traffic, reported to healthchecks.io
│   ├── backups/              ← NOT in git; the newest 7 backups
│   ├── logs/caddy/           ← NOT in git; Caddy's access logs, trimmed
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

Projects start from [app-template](https://github.com/waynezhu6/app-template). Two things decide what an app gets: a PR here **registers** it (puts it online and lets it deploy), and the app's own `infra.yml` says what it needs from the server.

**1. Register it.** Either run Actions → **Register app** → Run workflow with the app's repo name (lowercase), or run it locally and open the PR yourself:

```bash
scripts/register-app.sh notes
```

Either way the result is one new file, `apps/notes.caddy`, imported into the `waynezhu.dev` block: `waynezhu.dev/apps/notes/` serves `/srv/notes` (the frontend), and `waynezhu.dev/api/notes/...` goes to `notes-backend:3001` as `/api/...` (the backend container). The workflow needs Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" ticked once.

**2. Merge the PR.** The Deploy workflow validates the Caddy config and reloads Caddy, and the deployer starts accepting the app's deploys. This PR is the one approval step: nothing of an unregistered app runs on the server. Until the app first deploys, `waynezhu.dev/apps/notes/` shows a "Registered, but nothing has been deployed here yet" page, so you can check it on its own.

**3. Push to the app's `main`.** The app repo needs no secrets: its Deploy workflow proves who it is to the deployer with a GitHub OIDC token (see "Deploys" below). The deploy fails with a clear message if the app isn't registered yet.

**The app's `infra.yml`.** A file at the root of the app repo, sent with every deploy. The deployer creates whatever it declares that doesn't exist yet, before starting the backend, and never removes anything:

```yaml
# What this app needs from the server.
postgres: true   # its own database and role, and DATABASE_URL
```

| Setting | Default | What the deployer does |
|---|---|---|
| `postgres` | `false` | Creates a role and database named after the app (dashes become underscores: `my-app` → `my_app`), with a generated password, reachable only by that role, and adds its `DATABASE_URL` to `~/infrastructure/secrets/<name>.env`. |
| `monitor` | `true` | Nothing to create: the monitor checks the app's `/api/health` every minute and reports it to healthchecks.io (see "Monitoring"). `false` leaves the app out. |

Without the file, or with `postgres: false`, nothing is created, but anything that already exists (a database from before, `DATABASE_URL` in the secrets file) is kept and still passed to the backend. Unknown settings or non-boolean values fail the deploy with a message, so a typo can't quietly skip a database. Changing only `infra.yml` redeploys even if the image is the same. app-template ships with `postgres: true`.

This repo is public so app repos, public or private, can use its deploy action. If it ever goes private, GitHub stops public repos from using its actions (their deploy fails with "Unable to resolve action `waynezhu6/infrastructure`"), and private ones need Settings → Actions → General → Access set to "Accessible from repositories owned by the user 'waynezhu6'".

**App secrets** (API keys and the like): add them as Actions secrets on the app's repo (Settings → Secrets and variables → Actions), list each one in the `env` input of the Deploy step in the app's `.github/workflows/deploy.yml` (one `NAME=${{ secrets.NAME }}` line each), and push. Each reaches the backend as the environment variable `NAME`: the deployer writes them into the app's env file on the server, next to `DATABASE_URL`, and never logs them. Changing only a secret and re-running Deploy still redeploys. `NODE_ENV`, `PORT` and `DATABASE_URL` belong to the server and are refused, and values must be single-line without `'`. Don't pass `toJSON(secrets)` instead: GitHub holds runs that hand all secrets to another repo's action until someone approves them.

Lines added by hand to `~/infrastructure/secrets/<name>.env` on the server still work too; a GitHub secret of the same name wins. Provisioning only reads the `DATABASE_URL` line and only ever appends it, so added lines survive deploys.

**Removing a project**: delete `apps/<name>.caddy` by PR. On deploy Caddy stops serving it and the deployer refuses its deploys. The container, database, `secrets/<name>.env` and `sites/<name>` are left in place on purpose; remove them by hand once you're sure (`docker rm -f $(docker ps -aq --filter label=deployer.app=<name>)`, `docker exec -it postgres psql -U postgres -c 'DROP DATABASE <name>'` etc.).

## CI/CD

**This repo**: on merge to `main`, CI copies the repo's files to `~/infrastructure` with rsync, writes `.env`, runs `docker compose up -d` and reloads Caddy. App databases are created by the deployer when each app deploys. Secrets stored in GitHub Actions: `SERVER_HOST`, `SERVER_USER`, `SSH_DEPLOY_KEY`, `POSTGRES_PASSWORD`.

**Each project repo**: on merge to `main`, CI builds one image holding the backend and the built frontend, pushes it to `ghcr.io/<owner>/<app>-backend`, then calls the deployer with the image's digest through `actions/deploy` in this repo. See "Deploys" below. Project repos hold no deploy secrets; their own Actions secrets become the backend's environment.

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

**What a deploy does.** Blue-green, on the one server, so the app keeps answering throughout. First provision what the app's `infra.yml` declares (see above). Then pull the image by digest and copy the frontend out of it (`/app/frontend/dist`). Start a new backend container, `<app>-backend-<deploy id>`, from `deployer/app.compose.yml` next to the one serving (on `caddy-web` and `postgres-db`, environment from `secrets/<app>.env` plus the app repo's Actions secrets), and wait up to 90 s for its `/api/health`. If it's healthy, it takes over the `<app>-backend` name Caddy proxies to (a network alias on `caddy-web`), the new frontend replaces `sites/<app>`, and the old container is stopped: it gets SIGTERM and up to 30 s to finish the requests it has. If the new one never gets healthy, its last 40 log lines are shown, it's removed, and nothing else changes: the old container never stopped serving and the frontend is left as it was, so a bad push doesn't take the app down.

The swap itself: Caddy opens a fresh connection to the backend for each request (`keepalive off` in `apps/<name>.caddy`), and a connection that fails is retried for up to 5 s. GET requests that hit the old container as it shuts down are retried too. A POST or other non-GET can still fail in the few milliseconds when the old backend stops listening, if it was accepted but not yet read.

What this asks of apps:

- **Two versions run at once, briefly.** The new backend runs its migrations on startup while the old one is still serving, so a migration must not break the old code: add columns and tables freely; drop or rename only in a later deploy, once nothing uses them. Anything the app does on a timer runs in both containers for those seconds.
- **Twice the memory during a deploy.** Both backends are up from the new one's start until the old one exits. Leave room for that on the server.
- **Exit on SIGTERM.** app-template's backend stops taking connections, finishes what it has and exits. An app that ignores SIGTERM (Node running as PID 1 does, unless it handles it) keeps serving until it's killed after 30 s, and requests in flight at that moment fail.

Containers from before blue-green deploys were called `<app>-backend`; the first deploy since adopts and replaces it the same way. If a deploy is cut off midway (the deployer restarting, say), the next one removes whatever it left.

**Output.** The request stays open and the deploy's output streams into the Actions log as it happens, ending with `==> deploy <id> succeeded|failed|superseded`, which passes or fails the step. If the connection drops the deploy carries on and the action follows it at `GET /deploy/jobs/<id>`. Every deploy's log is also kept at `~/infrastructure/deploys/logs/<app>/<id>.log`.

**Overlapping calls.** One deploy per app at a time; different apps deploy in parallel. While one runs, only the newest request waits behind it, and an older waiting one is reported as superseded. A call for the image already being deployed joins that deploy, and one for the image already live does nothing.

**Rolling back by hand.** The previous good image stays tagged on the server as `local/<app>-backend:previous`. Re-running an older commit's Deploy workflow redeploys its image, as long as GHCR still has it (the newest five are kept).

Restarting the deployer (any deploy of this repo that changes `deployer/`) waits for running deploys to finish first.

Apps created before the deployer still deploy over SSH with `SERVER_HOST`, `SERVER_USER` and `SSH_DEPLOY_KEY` until their workflow and Dockerfile are updated from app-template; the first deploy through the deployer adopts the running container and replaces it.

## Backups

Every night at 03:00 UTC the `backup` container (`backup/`) dumps every database with `pg_dumpall` (roles and their passwords included) and packs it with `secrets/` into one archive. It encrypts the archive with `BACKUP_PASSPHRASE`, checks that it opens and that the dump is complete, and keeps the newest 7 in `~/infrastructure/backups`. It then copies each one to a Backblaze B2 bucket. The server's B2 key can only write, so even someone who took over the server couldn't delete the offsite copies. A lifecycle rule on the bucket expires them after 14 days.

Without `BACKUP_PASSPHRASE`, backups stay on the server unencrypted and nothing goes offsite. Without the `BACKUP_S3_*` secrets they stay on the server only.

```bash
make backup                                        # back up now
make restore-test                                  # restore the newest into a throwaway Postgres, count rows
make restore-test FILE=backup-20261024T030000Z.tar.gpg
docker logs backup                                 # what the nightly runs said
```

`make restore-test` never touches the live database. Run it after setting things up, and now and then after that: a backup is only proven by restoring it.

**Setting up B2** (once):

1. Create a [Backblaze B2](https://www.backblaze.com/cloud-storage) account. The first 10 GB are free.
2. **Buckets → Create a Bucket**: a unique name such as `waynezhu-backups`, **Private**, encryption on, Object Lock off. Note its **Endpoint**, e.g. `s3.us-west-004.backblazeb2.com`. The region is the part after `s3.`, e.g. `us-west-004`.
3. Open the bucket's **Lifecycle Settings** and choose **Use custom lifecycle rules**: file prefix `backup-`, hide after 14 days, delete 1 day after hiding.
4. **Application Keys → Add a New Application Key**: allow access to that bucket only, **Type of Access: Write Only**. Copy the `keyID` and `applicationKey`; the key is shown only once.
5. Make a passphrase, e.g. `openssl rand -base64 32`. **Save it in your password manager.** GitHub secrets can't be read back, and the backups can't be opened without it.
6. Add this repo's Actions secrets (Settings → Secrets and variables → Actions), then run Deploy:

| Secret | Value |
|---|---|
| `BACKUP_PASSPHRASE` | The passphrase from step 5 (no `'`) |
| `BACKUP_S3_ENDPOINT` | `https://` + the bucket's endpoint |
| `BACKUP_S3_REGION` | e.g. `us-west-004` |
| `BACKUP_S3_BUCKET` | The bucket's name |
| `BACKUP_S3_ACCESS_KEY_ID` | The key's `keyID` |
| `BACKUP_S3_SECRET_ACCESS_KEY` | The key's `applicationKey` |
| `BACKUP_PING_URL` | Optional: a [healthchecks.io](https://healthchecks.io) ping URL. It's pinged when each backup starts and ends (`/fail` on failure), and healthchecks.io alerts you if a night is missed. Not needed once `HC_PING_KEY` is set (see "Monitoring"), which reports backups as the `backup` check. |

7. On the server, run `make backup`, then `make restore-test`. The file should also appear in the bucket in the B2 web UI.

**Restoring for real** (a new server, say): bootstrap and deploy this repo as in "Setting Up a New Server". Download a backup from the B2 web UI, copy it to `~/infrastructure/backups/` and open it:

```bash
cd ~/infrastructure/backups
gpg -d backup-<stamp>.tar.gpg | tar -x        # asks for the passphrase
gunzip -c postgres.sql.gz | docker exec -i postgres psql -U postgres
tar -xzf secrets.tar.gz -C ~/infrastructure   # each app's DATABASE_URL and hand-added lines
```

Then re-run each app's Deploy workflow. The restored roles keep their passwords, so the restored `secrets/` files match them.

## Monitoring

Anything on this server goes down with it, so alerts come from [healthchecks.io](https://healthchecks.io), which runs elsewhere and alerts when the pings it expects stop or report a failure. The free plan has 20 checks.

The `monitor` container (`monitor/`) runs a round every minute and pings one check per thing it watches, under one project ping key (`HC_PING_KEY`). Each check is created on its first ping (`?create=1`), so a new app needs no setup:

| Check | Pinged | Fails when |
|---|---|---|
| `<app>` | Every round, for each app the deployer has deployed, unless its `infra.yml` says `monitor: false` | `http://<app>-backend:3001/api/health` doesn't answer twice in a row, 5 s apart |
| `traffic` | Every round | Any app had more than `TRAFFIC_LIMIT_PER_MINUTE` (300) API requests in the last minute; the failure lists which |
| `monitor` | At the end of every round | Never by itself: it goes late if the monitor, Docker or the whole server stops |
| `backup` | When each nightly backup starts and ends (`backup/`) | The backup fails |

Failures are reported straight away with `/fail`, so they don't depend on grace periods. Lateness only matters for `monitor` and `backup`: if the server dies, `monitor` goes late first and tells you the cause. Without `HC_PING_KEY` the monitor still runs and only logs failures (`docker logs monitor`).

**Access logs.** Caddy logs every request to `~/infrastructure/logs/caddy/access.log` (rolled at 20 MB, 5 kept), trimmed to what counting needs: the time, method, status, duration, client IP and the URI cut to its first two segments (`/api/<app>`, `/apps/<app>`). Paths beyond that (auth's invite links), query strings (txtify's `?key=`) and headers are never written.

```bash
make traffic              # requests per app, last 60 minutes
make traffic MINUTES=5
docker logs monitor       # what the monitor saw fail
```

**Setting up healthchecks.io** (once):

1. Create a [healthchecks.io](https://healthchecks.io) account. The default project is fine.
2. Project **Settings → Ping key → Create**, and add it as this repo's `HC_PING_KEY` Actions secret. Run Deploy; within a minute the checks appear.
3. **Integrations**: add where alerts go, e.g. email plus a phone push app (ntfy, Pushover, Telegram).
4. Open the `monitor` check and set its period to 1 minute and grace to 2 minutes, and give it your loudest integration. Checks made by `?create=1` start with a 1 day period and 1 hour grace, which suits `backup` and the app checks, since their failures arrive as `/fail`.
5. Optionally give the app and `traffic` checks a quieter integration, so a dead server is one loud alert rather than many.

## Common Commands

```bash
# Start / stop
docker compose up -d
docker compose down

# Logs
docker compose logs -f
docker compose logs -f caddy
ls ~/infrastructure/deploys/logs/<app>/     # one file per app deploy
docker ps --filter label=deployer.app=<app> # an app's backend (two during a deploy)

# Reload Caddy after a manual Caddyfile change
docker exec caddy caddy reload --config /etc/caddy/Caddyfile

# Validate Caddyfile
docker run --rm -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile -v $(pwd)/apps:/etc/caddy/apps caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile

# PostgreSQL
docker exec -it postgres psql -U postgres

# Backup now / prove the newest backup restores (see "Backups")
make backup
make restore-test
```
