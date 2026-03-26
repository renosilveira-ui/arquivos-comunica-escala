# AuthZ v1 — Rollback Runbook

## TL;DR — Instant Rollback (no redeploy)

```bash
# Via Render API
curl -X PATCH \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars" \
  -d '[{"key":"AUTHZ_V1_ENFORCE","value":"0"}]'

# Verify (after ~30s)
curl https://<APP_URL>/api/health
# Expected: {"ok":true,"db":"up","authzMode":"legacy"}
```

---

## When to Rollback

Trigger rollback immediately if any of the following occur after cutover:

| Signal | Threshold |
|--------|-----------|
| `GET /api/health` returns `ok=false` | Immediately |
| `authzMode` is `v1` but P0 flows fail | Immediately |
| Error rate on login/assign/approve endpoints spikes | > baseline + 2% |
| Legitimate users receiving DENY in audit trail | Any occurrence |
| DB connectivity lost | Immediately |
| Unexplained 5xx surge | > 5 in 1 minute |

---

## Full Rollback Procedure

### Step 1 — Confirm the problem

```bash
curl https://<APP_URL>/api/health
```

Expected failure indicators:
- `"ok": false`
- `"db": "down"`
- `"authzMode": "v1"` with concurrent 403 errors for valid users

### Step 2 — Flip AUTHZ_V1_ENFORCE to 0

**Via Render Dashboard (UI):**
1. Render → Web Service → Environment
2. Set `AUTHZ_V1_ENFORCE` = `0`
3. Click **Save Changes** (auto-restarts)

**Via Render API:**
```bash
curl -X PATCH \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars" \
  -d '[{"key":"AUTHZ_V1_ENFORCE","value":"0"}]'
```

> No code change, no new deployment. The running process picks up the new env
> value on restart.

### Step 3 — Wait for restart

```bash
sleep 45
```

### Step 4 — Verify rollback

```bash
curl https://<APP_URL>/api/health
# Expected: {"ok":true,"db":"up","authzMode":"legacy","authzV1Enforce":false}
```

If `authzMode` is still `"v1"`:
- Confirm the env var was saved in Render
- Manually trigger a restart via Render → Manual Deploy → Restart

### Step 5 — Run P0 smoke tests

| Test | Expected |
|------|----------|
| `GET /api/health` | `ok=true, authzMode=legacy` |
| Login (valid user) | Success |
| Vacancy assume | Success |
| Assignment approve (MANAGER) | Success |

### Step 6 — Notify & post-mortem

1. Notify on-call channel: "AuthZ v1 rolled back on [env] at [time]. authzMode=legacy."
2. Page H-1 if rollback was triggered by a P0 incident.
3. File a post-mortem within 24 hours covering:
   - Root cause of the rollback trigger
   - Which audit entries showed unexpected DENY/ALLOW
   - Steps to fix before re-attempting cutover

---

## What rollback does NOT affect

- **Database schema**: no schema changes are rolled back (AuthZ v1 schema changes, if any, are additive and backward-compatible).
- **Audit trail**: existing AUTHZ_V1 audit entries remain; they do not affect runtime behavior.
- **Legacy RBAC code**: the `server/rbac-validations.ts` legacy path is never removed in this window; it continues to function normally under `authzMode=legacy`.

---

## Re-cutover After Rollback

Before attempting cutover again:
1. Identify and fix the root cause (code or config)
2. Re-run the full Go/No-Go checklist (`GO_NO_GO_CHECKLIST.md`)
3. Re-test on staging with `AUTHZ_V1_ENFORCE=1`
4. Get H-1 approval
5. Re-run `authz-rollout.yml` with `cutover=true`
