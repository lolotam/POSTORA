# Edge Runtime Environment Runbook

## The recurring problem (and why it happens)

Variables exist in `.env`, but Supabase Edge Runtime functions still fail with
`"secret not configured"`. This has happened with `RESEND_API_KEY`,
`RESEND_WEBHOOK_SECRET`, and others.

**Root cause:** Docker Compose's `.env` file only performs `${VAR}`
*interpolation* — it substitutes values *into the compose file itself*. It does
**NOT** inject those variables into containers automatically. A variable only
reaches a container if:

1. The service declares `env_file: [.env]` (passes the whole file), **or**
2. The service explicitly maps the variable under `environment:` (e.g.
   `RESEND_API_KEY: ${RESEND_API_KEY}`).

The Supabase `functions` service historically had neither for most variables, so
`Deno.env.get("RESEND_WEBHOOK_SECRET")` returned `undefined`.

**The permanent fix:** the `functions` service now uses `env_file: [./.env]`,
which injects every `.env` variable into the container automatically. Existing
explicit `environment:` overrides (internal `SUPABASE_URL`, `JWT_SECRET`,
`VERIFY_JWT`, etc.) are preserved and take precedence.

---

## Architecture: the single source of truth

```
infra/edge-runtime.required-env.json   <-- manifest (source of truth)
        |
        +-> scripts/check-edge-env-drift.mjs   (CI: code<->manifest<->compose)
        +-> scripts/check-edge-env-local.mjs   (local: manifest<->.env)
        +-> scripts/check-edge-env-server.sh   (server: manifest<->container)
        +-> .env.example                       (template)
```

---

## How to add a new provider secret

Follow **all** steps. Skipping any one will cause the "secret not configured"
regression.

### 1. Add to the manifest

Edit `infra/edge-runtime.required-env.json` and add an entry:

```json
{
  "name": "MY_NEW_PROVIDER_KEY",
  "category": "ai",
  "required": false,
  "runtime": "edge-runtime",
  "aliases": [],
  "description": "Where to get this key."
}
```

- Set `required: true` only if the app cannot boot without it (rare).
- Provider-specific secrets are `required: false` — they are only needed when
  that provider is enabled.

### 2. Add to `.env.example`

Add an empty placeholder in the correct category section:

```env
MY_NEW_PROVIDER_KEY=
```

### 3. Add to the production `.env`

On the server, add the real value:

```
/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code/.env
```

> Security: never `echo`, `cat`, or `git commit` the real value.

### 4. Confirm the compose injects it

If the `functions` service uses `env_file: [./.env]` (the permanent fix), the
variable is injected automatically — nothing else to do.

If it uses explicit `environment:` mappings instead, add:

```yaml
functions:
  environment:
    MY_NEW_PROVIDER_KEY: ${MY_NEW_PROVIDER_KEY}
```

Verify the drift detector passes:

```bash
npm run check:edge-env
```

### 5. Restart ONLY the functions container

```bash
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
docker compose up -d --no-deps functions
```

Never restart the whole stack unless necessary.

### 6. Run the server env checker

```bash
COMPOSE_DIR=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code \
  bash /path/to/scripts/check-edge-env-server.sh
```

Confirm your new variable reports `present`.

### 7. Run endpoint smoke tests

```bash
curl -s -o /dev/null -w '%{http_code}' https://api.postora.cloud/functions/v1/get-public-config
# expect 200
```

---

## CI / pre-deploy gate

`npm run check:edge-env` runs three drift checks:

1. **CODE -> MANIFEST** — any new `Deno.env.get("X")` must be in the manifest.
2. **MANIFEST -> .env.example** — every manifest var has a placeholder.
3. **COMPOSE INJECTION** — the functions service uses `env_file` or explicit
   mappings.

This prevents a developer from introducing a new secret without documenting and
injecting it.

---

## Commands quick reference

| Task | Command |
|------|---------|
| CI env-drift check | `npm run check:edge-env` |
| Local .env check | `npm run check:edge-env:local` |
| Server container check | `bash scripts/check-edge-env-server.sh` |
| Recreate functions only | `docker compose up -d --no-deps functions` |
| Validate compose | `docker compose config --quiet` |

---

## Dokploy persistence warning

If you redeploy the Supabase stack from the Dokploy UI, **verify** the
`env_file:` directive (or your explicit mappings) survive under the `functions`
service. Dokploy may regenerate the compose file from its stored template. If it
does, re-apply the `env_file:` line to the functions service and restart only
that container.
