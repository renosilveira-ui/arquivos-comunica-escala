# AuthZ v1 — Cutover Runbook

This runbook covers the step-by-step procedure to activate AuthZ v1 enforcement
(`AUTHZ_V1_ENFORCE=1`) on a running environment **without a redeploy**.

Rollback: see `ROLLBACK_RUNBOOK.md`.

---

## Prerequisites

1. The Go/No-Go checklist (`GO_NO_GO_CHECKLIST.md`) is fully ✅
2. You have access to the Render dashboard for the target service
3. You have the GitHub Actions workflow permission to run `authz-rollout.yml`
4. The on-call engineer is notified and available for 30 minutes post-cutover

---

## Option A — Automated Cutover (Preferred)

Use the `authz-rollout.yml` GitHub Actions workflow:

```
Actions → AuthZ v1 Rollout
  environment: staging | production
  cutover: true
  run_migrate: false   # only true if there are new AuthZ migrations
```

The workflow will:
1. Run quality gate (typecheck + tests + AuthZ enforcement tests)
2. Build the server
3. Deploy with `AUTHZ_V1_ENFORCE=0` (safe baseline)
4. Run smoke tests confirming `authzMode=legacy`
5. Set `AUTHZ_V1_ENFORCE=1` via Render API
6. Wait for restart
7. Confirm `authzMode=v1` and `db=up`

---

## Option B — Manual Cutover (Fallback)

### Step 1 — Verify baseline health
```bash
curl https://<APP_URL>/api/health
# Expected: {"ok":true,"db":"up","authzMode":"legacy"}
```

### Step 2 — Set AUTHZ_V1_ENFORCE=1

**Via Render Dashboard:**
1. Open Render → Web Service → Environment
2. Add or update: `AUTHZ_V1_ENFORCE` = `1`
3. Click **Save Changes** → Render will restart the service automatically

**Via Render API:**
```bash
curl -X PATCH \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars" \
  -d '[{"key":"AUTHZ_V1_ENFORCE","value":"1"}]'
```

### Step 3 — Wait for restart (~30–45s)
```bash
sleep 45
```

### Step 4 — Confirm v1 is active
```bash
curl https://<APP_URL>/api/health
# Expected: {"ok":true,"db":"up","authzMode":"v1","authzV1Enforce":true}
```

If `authzMode` is still `"legacy"`, the env var was not applied. Retry Step 2.

### Step 5 — P0 smoke tests
Run the following manually or via the smoke job in `authz-rollout.yml`:

| Test | Expected |
|------|----------|
| `GET /api/health` | `ok=true, authzMode=v1` |
| Login (valid user) | Success (200) |
| Vacancy assume (OPERATOR) | Success |
| Assignment approve (MANAGER) | Success |
| Assignment approve (USER role) | DENY (403) |
| Cross-org resource access | DENY (403) |

### Step 6 — Monitor for 15 minutes
- Watch error rates on P0 endpoints (login, assign, approve)
- Check audit trail for unexpected DENY entries
- No P0 alerts → cutover is complete

---

## Post-Cutover Checklist

- [ ] `/api/health` → `authzMode=v1`
- [ ] P0 smoke tests passing
- [ ] No spike in 5xx errors
- [ ] Audit trail shows ALLOW entries for legitimate actions
- [ ] Notify stakeholders: "AuthZ v1 is live on [environment] at [timestamp]"

---

## Escalation

If any post-cutover check fails:
1. Immediately execute `ROLLBACK_RUNBOOK.md` (flag flip, no redeploy)
2. Page on-call engineer
3. Escalate to H-1 if rollback does not resolve within 5 minutes
