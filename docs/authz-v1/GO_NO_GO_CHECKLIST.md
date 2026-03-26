# AuthZ v1 — Go/No-Go Checklist

Use this checklist before every deployment that touches the `AUTHZ_V1_ENFORCE` flag or the `server/authz/enforce.ts` layer.

---

## Pre-Deploy Gate (must be ✅ before deploy)

### Code Quality
- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm lint` passes with zero errors
- [ ] `pnpm test` passes (all suites green)
- [ ] `pnpm test:authz` passes with `AUTHZ_V1_ENFORCE=1` (runs `tests/authz-enforce.test.ts`, no DB required)
- [ ] `pnpm build` succeeds

### AuthZ v1 Logic
- [ ] `authorize()` in `server/authz/enforce.ts` is the **only** authorization gate for new actions
- [ ] No new `if role` checks outside `server/authz/enforce.ts`
- [ ] `functional_profile` is not used for any authorization decision
- [ ] `directory_entry_id` is not used for any authorization decision
- [ ] `stationId` from client is not used as sole authorization signal
- [ ] PIN only signs critical actions — it does not elevate privilege
- [ ] Service accounts use `principalType: "SERVICE_ACCOUNT"` and `bundle: "SERVICE_INTEGRATION"` — not a human role
- [ ] Every critical mutation has a corresponding audit entry (ALLOW or DENY + reason)

### Flag State
- [ ] Staging is running with `AUTHZ_V1_ENFORCE=1` and all smoke tests pass
- [ ] Rollback procedure tested on staging (flip to `AUTHZ_V1_ENFORCE=0` without redeploy)
- [ ] `/api/health` returns `"authzMode": "v1"` on staging
- [ ] `/api/health` returns `"db": "up"` on staging

### Canary (see CANARY_CRITERIA.md)
- [ ] P0 smoke tests pass (login, assignment approve/reject, vacancy assume)
- [ ] Error rate on P0 endpoints ≤ baseline + 1%
- [ ] No DENY decisions for legitimate actions in audit trail
- [ ] No unexpected ALLOW decisions for blocked actors in audit trail

---

## Go/No-Go Decision

| Condition | Status | Owner |
|-----------|--------|-------|
| All checklist items above ✅ | — | Release Engineer |
| No P0 incidents in last 24h | — | On-call |
| Rollback procedure tested | — | Release Engineer |
| Stakeholder approval (H-1) | — | H-1 |

**Go** = all rows are ✅ and no blocking risks.  
**No-Go** = any row is ❌ or a blocking risk is open.

---

## Post-Deploy Verification (P0 flows)

- [ ] `GET /api/health` → `{"ok":true,"authzMode":"v1","db":"up"}`
- [ ] Login flow (human user) works end-to-end
- [ ] Vacancy assume by OPERATOR succeeds
- [ ] Assignment approve by MANAGER succeeds
- [ ] Assignment approve by USER is denied (403)
- [ ] Cross-org resource access is denied
- [ ] Audit trail contains ALLOW/DENY entries for the above

---

## Open Risks (at time of authoring)

| Risk | Severity | Mitigation |
|------|----------|------------|
| Legacy RBAC tests require DB seed | Medium | Ensure `seed-test-data.ts` runs in CI before RBAC tests |
| `AUTHZ_DECISION` audit entries use `SHIFT_INSTANCE` as `entityType` (placeholder) | Low | Extend `AuditEntry.entityType` enum with `AUTHZ_EVENT` in next window |
| Rollback is flag-only — no DB schema rollback needed for this window | Low | Physical legacy removal deferred to P2 |
