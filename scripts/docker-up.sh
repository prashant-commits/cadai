#!/bin/sh
# Build and start the Docker stack (compose.yaml). Creates the geo token on first run.
set -eu
cd "$(dirname "$0")/.."
if [ ! -s .docker/geo-token ]; then
  mkdir -p .docker
  # 0644: the web container reads it as the unprivileged node user. geo is not published to the host.
  (umask 022 && openssl rand -hex 32 > .docker/geo-token)
fi
exec docker compose up -d --build "$@"
