#!/usr/bin/env bash
# Railway deploy entrypoint wrapper. (rev 2: context-size fix rollout)
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

cd /var/www/localhost/htdocs
exec ./openemr.sh
