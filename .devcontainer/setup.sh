#!/usr/bin/env bash
# One-time setup inside GitHub Codespaces / any Debian-based dev container:
# PostgreSQL 16 (+contrib for btree_gist, pg_trgm, earthdistance…) and npm dependencies.
set -euo pipefail
if [ ! -x /usr/lib/postgresql/16/bin/postgres ]; then
  sudo apt-get update -y
  sudo apt-get install -y postgresql-common
  sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  sudo apt-get install -y postgresql-16 postgresql-contrib-16
  # the app runs its own cluster under ultra-link/var; stop the distro's default one
  sudo service postgresql stop || true
fi
cd ultra-link
npm install
echo "setup done — the app starts on port 8080 (npm start)"
