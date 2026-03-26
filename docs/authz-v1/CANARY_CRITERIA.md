# AuthZ v1 — Canary Criteria

Defines the objective pass/fail criteria used during the AuthZ v1 rollout.
These criteria are evaluated by the smoke jobs in `authz-rollout.yml` and
manually by the release engineer during the cutover window.

---

## Canary Model

We use a **boolean global flag** model (not a percentage or allowlist):

```
AUTHZ_V1_ENFORCE=0  → legacy RBAC (entire system)
AUTHZ_V1_ENFORCE=1  → AuthZ v1 enforcement (entire system)
```

This model was chosen because:
- Rollback is instant (no redeploy, no per-user state to clean up)
- The new `authorize()` layer is already wrapping all sensitive actions
- The system is multi-tenant but single-binary — per-org canary would add complexity without proportional safety gain

Upgrade path: once v1 is stable on production for 30 days, the fallback branch and the flag are candidates for P2 cleanup.

---

## Automated Pass Criteria (CI / smoke job)

All of the following must pass before the cutover step runs:

### Health
| Check | Pass Condition |
|-------|---------------|
| `GET /api/health` → `.ok` | `true` |
| `GET /api/health` → `.db` | `"up"` |
| `GET /api/health` → `.authzMode` | `"legacy"` (pre-cutover) / `"v1"` (post-cutover) |

### P0 Endpoint Availability (smoke)
| Endpoint | Acceptable HTTP Codes | Fail Condition |
|----------|----------------------|----------------|
| `POST /api/auth/login` | 200, 400, 401, 422 | 500, 502, 503 |
| `GET /api/trpc/shiftInstances.listVacancies` | 200, 400, 401 | 500, 502, 503 |

### AuthZ v1 Unit Tests (`AUTHZ_V1_ENFORCE=1`)
| Test file | Must pass |
|-----------|-----------|
| `tests/authz-enforce.test.ts` | All tests |

---

## Manual Pass Criteria (release engineer)

Evaluated during the 15-minute post-cutover monitoring window:

### Error Rate
| Signal | Pass | Rollback Trigger |
|--------|------|-----------------|
| 5xx rate on P0 endpoints | ≤ baseline + 1% | > baseline + 2% |
| Total request error rate | No spike vs. 24h rolling | Any sustained spike |

### Audit Trail
| Signal | Pass | Rollback Trigger |
|--------|------|-----------------|
| Legitimate OPERATOR actions | ALLOW in audit | Any DENY for known-good actor |
| Cross-org access attempt | DENY in audit | ALLOW for known-bad actor |
| Service account integration | ALLOW with SERVICE_INTEGRATION bundle | DENY for valid service account |

### P0 Flow Verification (manual)
| Flow | Expected |
|------|----------|
| Login (HUMAN_INTERNAL) | Success |
| Vacancy assume (OPERATOR bundle) | ALLOW |
| Assignment approve (MANAGER bundle) | ALLOW |
| Assignment approve (OPERATOR bundle, no MANAGER) | DENY |
| Assignment approve from wrong org | DENY |

---

## Monitoring Signals

During the canary window, watch the following:

1. **Application logs** (`console.error` entries containing `[AUTHZ_V1]`)
2. **Audit trail** in DB: `SELECT * FROM audit_trail WHERE description LIKE '[AUTHZ_V1]%' ORDER BY created_at DESC LIMIT 50`
3. **`/api/health`** polled every 60 seconds by Render health check
4. **Render service metrics**: requests/min, error rate, response time P99

---

## Rollback Trigger Summary

Trigger rollback (`ROLLBACK_RUNBOOK.md`) if **any** of:
- Health endpoint returns `ok=false`
- Any P0 endpoint returns 5xx post-cutover
- Legitimate user receives unexpected DENY
- Error rate > baseline + 2%
- On-call decision (any P0 incident during window)
