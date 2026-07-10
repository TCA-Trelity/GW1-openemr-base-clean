#!/usr/bin/env bash
# Railway deploy entrypoint wrapper. (rev 3: boot-time source refresh)
#
# Railway's private network (mariadb.railway.internal) can take several seconds
# to become resolvable when a container starts. OpenEMR's setup tries the DB
# almost immediately and, on failure, the container exits — so it crash-loops
# and never gets far enough for the network to come up. This wrapper waits for
# the DB host to resolve AND accept a TCP connection before handing off to the
# real flex entrypoint, turning a crash-loop into a brief, patient wait.
set -u

HOST="${MYSQL_HOST:-mariadb.railway.internal}"
PORT="${MYSQL_PORT:-3306}"
MAX_TRIES=90   # 90 * 2s = up to 180s

echo "wait-and-start: waiting for database ${HOST}:${PORT} (up to $((MAX_TRIES * 2))s)..."
for i in $(seq 1 "${MAX_TRIES}"); do
    if getent hosts "${HOST}" >/dev/null 2>&1; then
        if (echo > "/dev/tcp/${HOST}/${PORT}") 2>/dev/null; then
            echo "wait-and-start: ${HOST}:${PORT} reachable after ~$((i * 2))s — starting OpenEMR"
            break
        fi
        [ "${i}" -eq 1 ] && echo "wait-and-start: ${HOST} resolves but port ${PORT} not open yet..."
    else
        [ "${i}" -eq 1 ] && echo "wait-and-start: ${HOST} does not resolve yet (private network warming up)..."
    fi
    if [ "${i}" -eq "${MAX_TRIES}" ]; then
        echo "wait-and-start: gave up after $((MAX_TRIES * 2))s; starting OpenEMR anyway so logs surface the real error"
    fi
    sleep 2
done

# Data-loss backstop: before handing off to the flex entrypoint, make sure a
# boot with a missing or empty sites/ volume can't trigger the installer's
# destructive reinstall (which DROPs every table). See restore-sqlconf.php for
# the full rationale. Fail-open — any error here is ignored so it can never
# block boot.
php /restore-sqlconf.php || true

# Code-freshness guarantee: the flex entrypoint's EASY_DEV_MODE_NEW rsync uses
# --ignore-existing (docker/flex/openemr.sh:686), so any file that persists
# under htdocs across deploys is NEVER updated — code freezes at first-boot
# vintage while images rebuild uselessly (live find: an EHR-side fix that
# would not ship). Sync the baked fork source over the app dir on every boot,
# excluding sites/ (patient data + sqlconf live on the volume) and the
# setup-built artifacts (vendor/, node_modules/) that the repo does not carry.
# Fail-open like the backstop above — a failed refresh must not block boot.
if [ -d /var/www/localhost/htdocs/openemr ]; then
    echo "wait-and-start: refreshing app source from the baked image (fix for --ignore-existing staleness)"
    rsync --recursive --links \
        --exclude sites --exclude .git --exclude vendor --exclude node_modules \
        /openemr/ /var/www/localhost/htdocs/openemr/ || true
fi

cd /var/www/localhost/htdocs
exec ./openemr.sh
