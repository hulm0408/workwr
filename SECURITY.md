# Security

This file is the checklist for the two open security issues in this repo:
the leaked Telegram bot token and the public Firebase Realtime Database.
Do the token revocation first; it is the only real fix for a leaked token.

## 0. Quick checklist

- [ ] Revoke the leaked `BOT_TOKEN` in @BotFather.
- [ ] Update every consumer of that token in the same window: GitHub Actions,
      Render (both blueprints), local `.env`, any other host.
- [ ] Restart all instances and verify `/diag` / no `401` / no `409`.
- [ ] Install gitleaks and run `npm run hooks:install`.
- [ ] Run `npm run scan:secrets` once locally; CI runs it on every push/PR.
- [ ] Confirm the Firebase project is yours, then deploy `database.rules.json`.
- [ ] Set `FIREBASE_DB_AUTH` before locking rules, or the bot loses access.
- [ ] Run `npm run verify:firebase-rules` (expect `401` unauthenticated).
- [ ] Review the 402 third-party Firebase URLs in `firebase-seed-urls.js`.

## 1. Leaked BOT_TOKEN (do this first)

A live-looking Telegram bot token was committed in `ec6f5e5` inside `.env`.
It was removed from tracking later, but it is still present in git history.

At HEAD the file is **not** tracked and `.gitignore` already covers it:

```sh
git ls-files .env          # empty
git log --all -- .env      # ec6f5e5, 504fefa, 70320b8
```

The historical `.env` had only `BOT_TOKEN` non-empty; `OWNER_IDS` and
`FIREBASE_DB_AUTH` were empty. Removing a file from the working tree does
**not** revoke the token, and a history rewrite is not a substitute for
revocation (forks, caches, and old clones may still contain it).

### Revoke and rotate

1. Telegram: **@BotFather -> /mybots -> your bot -> API Token -> Revoke
   current token**.
2. Update every consumer in the same maintenance window:
   - **GitHub Actions** (repo Settings -> Secrets and variables -> Actions):
     `BOT_TOKEN`, `BOT_TOKEN_3`, `BOT_TOKEN_4`. They are used by
     `.github/workflows/bot-live.yml`.
   - **Render**: `swiggy-fresh-bot` (from `render.yaml`) and
     `swiggy-fresh-bot-2` (from `render.second.yaml`). `BOT_TOKEN` is
     `sync: false`, so the real value lives in the Render dashboard.
   - **Local development**: `.env` on every machine.
   - **Any other host**: VPS, Railway, another Render account, etc.
3. Restart/deploy all instances. Verify:
   - `/diag` works and the bot is the expected `@username`.
   - No `401` (old/wrong token) and no `409 Conflict` (two copies still
     polling with the same token).
   - The revoked token no longer works.
4. Review recent bot activity for unauthorized use.

`BOT_TOKEN_3` and `BOT_TOKEN_4` belong to different bots. Only revoke them
if they were exposed too; the leaked `.env` contained only `BOT_TOKEN`.

## 2. Secret scanning (gitleaks)

Gitleaks 8.30.1's default ruleset does **not** detect Telegram Bot API
tokens (verified against a fake token), so `.gitleaks.toml` extends the
defaults with a `telegram-bot-token` rule.

### Local pre-commit hook

```sh
# once per clone
winget install Gitleaks.Gitleaks      # Windows
# brew install gitleaks               # macOS
# or download a release binary        # Linux

npm run hooks:install                 # sets core.hooksPath=.githooks
```

`.githooks/pre-commit` runs:

```sh
gitleaks git --pre-commit --staged --redact
```

It fails closed: if gitleaks is not installed, the commit is blocked with
install instructions. Hook bypass (`git commit --no-verify`) should be
treated as an incident.

### Full-history scan

```sh
npm run scan:secrets
```

CI runs the same full-history scan in `.github/workflows/gitleaks.yml` on
every push, pull request, and manual dispatch. The workflow checks out with
`fetch-depth: 0`, installs a pinned gitleaks binary, and scans `--all`.

`.gitleaksignore` contains one baseline fingerprint for the known historical
`.env` leak. It is a fingerprint, not the secret. It keeps CI green until
the history is purged; new leaks still fail. Remove the entry after the
purge described in section 4.

Never commit `.env`, `data/`, `*.session`, scan reports, or tokens.
`.dockerignore` already excludes `.env` from image layers.

## 3. Firebase Realtime Database

### Type and project

**This is Realtime Database (RTDB), not Firestore.** The host
`vuvhbjbi-default-rtdb.firebaseio.com` and the REST `.json` endpoints in
`firebase-numbers.js` are RTDB.

- Project ID: `vuvhbjbi`
- Default instance: `vuvhbjbi-default-rtdb`
- URL: `https://vuvhbjbi-default-rtdb.firebaseio.com/`

Confirm the project/instance in the Firebase console before deploying
anything; the URL is the source of truth for what the bot reads.

### Consumers of the default URL

- `fresh-bot.js` - sets `process.env.FIREBASE_DB_URL` default at startup.
- `firebase-sources.js` - `DEFAULT_URL`; `ensureSeeded()` creates the
  `Default (vuvhbjbi)` source.
- `firebase-numbers.js` - REST GET on `clients` / `messages` (and legacy
  `numbers` / `sms` / `otp`); PATCH on `numbers/<key>` in legacy mode only.
  The `clients` pool is not patched.
- `autopilot-engine.js` - source selection, health, and rotation through
  `firebase-sources.js`.
- `scratch/firebase-inspect.mjs` - read-only structure dump.
- `render.yaml`, `render.second.yaml`, `.github/workflows/bot-live.yml`,
  `.env.example` - default URL.

### Rules and deploy path

This repo ships:

- `firebase.json` - points the Firebase CLI at `database.rules.json`.
- `database.rules.json` - deny all reads and writes.

Deploy only if you own the Firebase project:

```sh
npm install -g firebase-tools
firebase login
firebase use vuvhbjbi
firebase deploy --only database
```

**Before deploying:** the bot's plain REST calls will be blocked. Set
`FIREBASE_DB_AUTH` to the RTDB legacy database secret (Firebase console ->
Project settings -> Service accounts -> Database secrets) in Render and
GitHub Actions, or migrate the bot to OAuth/service-account credentials.
The legacy secret has admin access and bypasses rules; keep it in secrets
only. It is deprecated, so plan the migration.

**Also:** any SMS forwarder/device that writes `clients` / `messages`
without auth will stop working. Confirm the writer's auth before locking
the rules. If `vuvhbjbi` is a third-party/open database that you do not
control, **do not deploy these rules**; remove the default and stop using
that database.

### Unauthenticated verification

```sh
FIREBASE_DB_URL=https://vuvhbjbi-default-rtdb.firebaseio.com \
  npm run verify:firebase-rules
```

The script sends a GET to a random, non-existent path (it never reads or
writes real data). Exit code `0` means unauthenticated access is denied;
`1` means the database is open or misconfigured. If `FIREBASE_DB_AUTH` is
set, it also verifies authenticated access returns `200`.

Manual check:

```sh
curl -i "https://vuvhbjbi-default-rtdb.firebaseio.com/__security_probe__.json"
```

- Locked: `401` / `403` (Permission denied).
- Open: `200` with `null` for a non-existent path.
- Deactivated: `423` (see below).

At the time of this audit (2026-11-08) the default instance returned:

```json
{ "error": "The Firebase database 'vuvhbjbi-default-rtdb' has been deactivated." }
```

A deactivated database does not serve data, so the public-read exposure is
not live, but the bot's default source is dead. If you own it, export/delete
it or restore it and then lock the rules; otherwise remove the default source
from the bot. Do not try to deploy rules to a deactivated instance.

### Third-party Firebase URLs (important)

`firebase-seed-urls.js` contains **402** third-party RTDB hostnames (the
owner's "ROLEX VIP" list). They are not owned or controlled by this repo,
so these rules cannot be deployed to them. Depending on unknown third-party
databases is a data-protection and supply-chain risk:

- Review the list and remove every source you do not own.
- Do not deploy `database.rules.json` to projects you do not control.
- Do not assume those databases are authorized to process the data the bot
  sends or reads.

## 4. History purge (optional, destructive)

Revoke the token **first**. Then, if you still want the old bytes gone:

```sh
# git-filter-repo
git filter-repo --path .env --invert-paths

# or BFG
bfg --delete-files .env
git reflog expire --expire=now --all
git gc --prune=now --aggressive

git push --force-with-lease
```

This rewrites every commit and breaks existing clones/forks. Coordinate with
collaborators. Caches and forks may retain old objects, which is why
revocation is the real fix. After the purge, delete the baseline entry in
`.gitleaksignore`.

## 5. Reporting

Do not open a public issue containing a secret value. Revoke/rotate it, then
report privately to the repository owner.
