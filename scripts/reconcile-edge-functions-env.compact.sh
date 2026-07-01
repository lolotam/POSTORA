#!/usr/bin/env bash
# Postora edge-functions env_file reconciler (compact host-cron copy).
# Full docs + drift recovery: scripts/reconcile-edge-functions-env.sh in repo.
set -euo pipefail
D=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
F=$D/docker-compose.yml
L=/var/log/postora-edge-reconcile.log
log(){ printf '%s %s\n' "$(date -u +'%FT%TZ')" "$*" | tee -a "$L"; }
if awk '/^  functions:/{a=1;next}a&&/^  [a-z]/{a=0}a&&/env_file:/{f=1}END{exit f?0:1}' "$F"; then
log "env_file present, no change"
else
log "env_file MISSING, restoring"
cp "$F" "$F.bak.$(date +%s)"
python3 -c "p='$F';s=open(p).read();a='    image: supabase/edge-runtime:v1.67.4\n';assert s.count(a)==1 and 'env_file' not in s.split(a,1)[1].split('\n\n',1)[0];open(p,'w').write(s.replace(a,a+'    env_file:\n      - ./.env\n',1))"
docker compose --project-directory "$D" -f "$F" config --quiet
docker compose --project-directory "$D" -f "$F" up -d --no-deps functions
sleep 7
log "restored env_file + recreated functions container"
fi
