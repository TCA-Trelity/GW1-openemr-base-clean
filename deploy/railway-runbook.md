# Railway deploy runbook — OpenEMR fork (Tier 0)

Click-by-click deployment of this fork to Railway. ~10 minutes of dashboard
work, then a one-time slow first boot (~10–20 min) while the container
fetches and builds the fork source.

**Security notes (public repo):** no secrets in this file or anywhere in the
repo — every credential below is created inside Railway's Variables UI.
Rotate `OE_PASS` away from any OpenEMR default. The only public identifier
produced is the app URL itself, which the submission requires.

---

## 1. Create the project

1. [railway.com](https://railway.com) → **New Project** (empty project).
2. Name it anything (the name is not public).

## 2. MariaDB service

1. **+ New → Docker Image** → `mariadb:11.8`. Name the service `mariadb`.
2. **Variables** tab → add:
   - `MARIADB_ROOT_PASSWORD` → click **Generate** (strong random value).
3. **Settings → Volumes** → **Add volume**, mount path: `/var/lib/mysql`.
4. **Settings → Networking:** ensure it has **no public domain** (private only).
5. Deploy.

## 3. OpenEMR service (prebuilt flex image, clones the fork at runtime)

**Do NOT build the fork's Dockerfile on Railway** — Railway's builder can't
handle the flex Dockerfile from a subdirectory (fails with
`docker/flex does not exist`). Instead run the *published* flex image, whose
entrypoint clones `FLEX_REPOSITORY` at runtime (`docker/flex/openemr.sh` —
the clone block fires when `EASY_DEV_MODE*` is unset). This is how the dev
stack runs it too (`docker/development-easy/docker-compose.yml` uses
`image: openemr/openemr:flex`, not a build).

1. **+ New → Docker Image** → `openemr/openemr:flex`. Rename the service
   `openemr`.
2. **Variables** tab → add exactly these:

   | Variable | Value |
   |---|---|
   | `FLEX_REPOSITORY` | `https://github.com/TCA-Trelity/GW1-openemr-base-clean.git` |
   | `FLEX_REPOSITORY_BRANCH` | `claude/ehr-architecture-defense-gg486o` |
   | `MYSQL_HOST` | `mariadb.railway.internal` |
   | `MYSQL_ROOT_PASS` | `${{mariadb.MARIADB_ROOT_PASSWORD}}` (reference — autocompletes) |
   | `MYSQL_USER` | `openemr` |
   | `MYSQL_PASS` | click **Generate** |
   | `MYSQL_DATABASE` | `openemr` |
   | `OE_USER` | `admin` |
   | `OE_PASS` | **Generate** — this is the login you'll use |

   Leave `EASY_DEV_MODE` / `EASY_DEV_MODE_NEW` **unset** — that selects
   clone-from-fork mode. (Optional, only if composer rate-limits during boot:
   add `GITHUB_COMPOSER_TOKEN` with the upstream token shipped in
   `docker/development-easy/docker-compose.yml`.)
3. **Attach Volume** (canvas right-click → Attach Volume, or Ctrl+K →
   volume), mount path `/var/www/localhost/htdocs/openemr` (persists cloned
   source + built dependencies + `sites/` across restarts; idempotent via
   `sites/docker-completed`).
4. **Settings → Resources:** **≥ 4 GB RAM** if the plan allows — the one-time
   `npm run build` during first boot is memory-hungry.
5. **Settings → Networking → Generate Domain**, target **port `80`**
   (Railway's edge terminates TLS and forwards HTTP to Apache).
6. Deploy.

## 4. First boot (one-time, be patient)

Watch **Deploy Logs**. Sequence: image build (~5 min) → git clone of the
fork → `composer install` → `npm install && npm run build` (the slow part)
→ database auto-configuration → Apache start. When the log settles and
Apache is serving, browse the generated domain:

- Login page loads over HTTPS → sign in with `admin` / the generated `OE_PASS`.

If the build dies mid-`npm` with an out-of-memory kill, raise the service's
memory and redeploy — the volume keeps completed steps, so the retry is
shorter.

## 5. Hand-off

Paste the public URL back into the session. Remaining verification and
patient seeding happen over the public API from there (no further dashboard
work needed tonight). Later pushes to the branch auto-redeploy via the
GitHub integration — that is how Thursday's sidecar joins this project
(as additional Railway services: `sidecar`, `postgres`, `redis`).

## Notes

- **Hosting posture:** Railway is the demo host (synthetic data only, per
  the project brief). The pilot phase moves to BAA-capable infrastructure —
  recorded in `ARCHITECTURE.md`.
- **F6 mitigation** (unauthenticated `background_service` route): the route
  is only meaningfully abusable with knowledge of internal service names; it
  is verified/neutralized in Tier 2 (PRD U2.4). For Tier 0 the exposure is
  accepted and documented in `AUDIT.md`.
