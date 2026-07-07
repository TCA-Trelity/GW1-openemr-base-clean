# Railway deploy image.
#
# The published openemr/openemr:flex image clones its source at runtime, but
# its script assumes the repo is named "openemr" — a differently-named fork
# crash-loops (clone lands in the wrong directory). So instead of runtime
# clone, we bake this fork's source into the image at /openemr and boot with
# EASY_DEV_MODE_NEW=yes, which rsyncs /openemr into place — exactly what the
# OpenEMR dev-easy stack does (docker/development-easy/docker-compose.yml uses
# this same image with source provided locally).
FROM openemr/openemr:flex
COPY . /openemr
COPY deploy/wait-and-start.sh /wait-and-start.sh
# EASY_DEV_MODE_NEW boot rsyncs /couchdb/data (a dev-stack volume) into
# /couchdb/original for devtools snapshots; without the mount the rsync fails
# and set -e kills the container (docker/flex/openemr.sh:1065). Pre-create it.
RUN chmod +x /wait-and-start.sh && mkdir -p /couchdb/data
WORKDIR /var/www/localhost/htdocs
CMD ["/wait-and-start.sh"]
