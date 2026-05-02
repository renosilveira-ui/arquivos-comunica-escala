# Operations: horizontal scaling

> Status: **single-instance only**. The constraints below MUST be resolved
> before deploying with replica count > 1 on Render (or any orchestrator).

## TL;DR

`server/integrations/comunica-plus.ts` keeps three pieces of state in
plain process memory. They are correct under one process and divergent
under any horizontal scaling. **Do not increase the Render service
instance count above 1 without addressing them first.**

## In-process state inventory

| Site | Variable | Purpose | Failure mode at N>1 |
|------|----------|---------|---------------------|
| `server/integrations/comunica-plus.ts:30` | `let sessionCookie: string \| null` | Cached Comunica+ system-user session cookie reused across outbound calls. | Each instance authenticates separately on cold-start. Comunica+ may rate-limit or invalidate the older session, causing 401 cascades. Worst case: each instance ends up with a different session and they invalidate each other in a loop. |
| `server/integrations/comunica-plus.ts:135` | `const userIdCache = new Map<string, string>()` | Caches `email → Comunica+ userId` resolutions to avoid repeated `integrations.resolveUserIdByEmail` calls. | Cache hit rate divides by N. Comunica+ load increases linearly with replica count. No correctness issue, but defeats the cache. |
| `server/integrations/comunica-plus.ts:341` | `let presenceCache: { data, ts } \| null` | 30-second TTL cache of online professionals from Comunica+. | Different instances serve stale presence at different ages. Two browser polls hitting different replicas can show contradictory presence. Visible to clinical users. |

There is no other process-local mutable state of operational significance
in `server/`. The Drizzle/MySQL pool is a connection pool — pool-per-process
is the expected model and not a scaling blocker.

## Failure modes ranked by severity

1. **Presence inconsistency (HIGH)** — clinical users see contradictory
   "who is online" depending on which replica answers. Concrete user
   confusion during plantão handoffs.
2. **Comunica+ session contention (MEDIUM)** — outbound notifications
   fail intermittently with 401 until the affected replica re-auths.
   Recovers automatically but produces error noise and delayed notices.
3. **Wasted Comunica+ load (LOW)** — `userIdCache` misses scale with N.
   Affects Comunica+ infra cost / rate-limit headroom, not correctness.

## What needs to change before scaling

Two acceptable migration paths:

### Option A — Shared cache (Redis)

Replace the three in-process structures with a Redis-backed store
(`ioredis` client + small wrapper). Render has managed Redis as an add-on.

- `sessionCookie` → Redis key `comunica:session` with TTL matching
  Comunica+ session lifetime.
- `userIdCache` → Redis hash `comunica:userid:<email>` with long TTL.
- `presenceCache` → Redis key `comunica:presence` with TTL = 30s.

This is the right long-term answer. Estimated work: ~1 day including
tests and the Redis env-var hardening (`REDIS_URL` must follow the same
fail-fast contract as `DATABASE_URL` from Frente 2.1).

### Option B — Sticky sessions

Configure Render to pin each user session to a specific replica via
session affinity. This sidesteps presence inconsistency for a single
user (their browser always hits the same replica) but does NOT fix the
Comunica+ session contention or `userIdCache` waste.

Acceptable as a stop-gap if Redis is not yet available. Long-term, Option
A is the correct fix.

## Operational rule until then

> **Do not set the Render service `numInstances` above `1`.** The single
> in-flight constraint is documented at each call site with a code
> reference back to this file.

When Frente 3 or later scales horizontally, this doc and the inline
markers in `comunica-plus.ts` must be removed in the same PR that
introduces the shared store.
