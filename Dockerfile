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
