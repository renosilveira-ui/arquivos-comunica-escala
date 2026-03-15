// server/integrations/comunica-plus.ts

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ComunicaPlusConfig {
  baseUrl: string;
  systemEmail: string;
  systemPassword: string;
  systemPin: string;
}

function getConfig(): ComunicaPlusConfig {
  return {
    baseUrl: process.env.COMUNICA_PLUS_URL || "http://localhost:3001",
    systemEmail:
      process.env.COMUNICA_PLUS_SYSTEM_EMAIL ||
      "system.escalas@hospital.com",
    systemPassword:
      process.env.COMUNICA_PLUS_SYSTEM_PASSWORD || "system123",
    systemPin: process.env.COMUNICA_PLUS_SYSTEM_PIN || "9999",
  };
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

let sessionCookie: string | null = null;

function extractSessionCookie(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error("No set-cookie from Comunica+");
  const m = setCookieHeader.match(/session=[^;]+/);
  if (!m) throw new Error("No session cookie token found");
  return m[0];
}

async function ensureSession(): Promise<string> {
  if (sessionCookie) return sessionCookie;
  const config = getConfig();
  const res = await fetch(
    `${config.baseUrl}/api/trpc/auth.login?batch=1`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        "0": { email: config.systemEmail, password: config.systemPassword },
      }),
    },
  );
  if (!res.ok) throw new Error(`Comunica+ auth failed: ${res.status}`);
  sessionCookie = extractSessionCookie(res.headers.get("set-cookie"));
  return sessionCookie;
}

function clearSession() {
  sessionCookie = null;
}

// ---------------------------------------------------------------------------
// tRPC caller helper
// ---------------------------------------------------------------------------

async function trpcCall<T = unknown>(
  procedure: string,
  input: Record<string, unknown>,
  retried = false,
): Promise<T> {
  const cookie = await ensureSession();
  const config = getConfig();
  const res = await fetch(
    `${config.baseUrl}/api/trpc/${procedure}?batch=1`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ "0": input }),
    },
  );

  if (res.status === 401 && !retried) {
    clearSession();
    return trpcCall<T>(procedure, input, true);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Comunica+ ${procedure} failed: ${res.status} ${txt}`);
  }

  const data = await res.json();
  // tRPC batch response: [{"result":{"data":...}}]
  return data?.[0]?.result?.data as T;
}

async function trpcQuery<T = unknown>(
  procedure: string,
  input: Record<string, unknown>,
  retried = false,
): Promise<T> {
  const cookie = await ensureSession();
  const config = getConfig();
  const encodedInput = encodeURIComponent(
    JSON.stringify({ "0": input }),
  );
  const res = await fetch(
    `${config.baseUrl}/api/trpc/${procedure}?batch=1&input=${encodedInput}`,
    {
      method: "GET",
      headers: { Cookie: cookie },
    },
  );

  if (res.status === 401 && !retried) {
    clearSession();
    return trpcQuery<T>(procedure, input, true);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Comunica+ ${procedure} query failed: ${res.status} ${txt}`);
  }

  const data = await res.json();
  return data?.[0]?.result?.data as T;
}

// ---------------------------------------------------------------------------
// Resolve userId by email (Comunica+ usa UUID, Escalas usa int)
// ---------------------------------------------------------------------------

const userIdCache = new Map<string, string>();

async function resolveUserIdByEmail(
  email: string,
): Promise<string | null> {
  const cached = userIdCache.get(email);
  if (cached) return cached;

  try {
    const result = await trpcQuery<{ userId: string }>(
      "integrations.resolveUserIdByEmail",
      { email },
    );
    if (result?.userId) {
      userIdCache.set(email, result.userId);
      return result.userId;
    }
  } catch (err) {
    console.warn(
      `[Comunica+] Could not resolve userId for ${email}:`,
      err,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sector UUID mapping (v1: via env vars)
// ---------------------------------------------------------------------------

function getSectorUUID(sectorName: string): string | null {
  const key = `COMUNICA_PLUS_SECTOR_UUID_${sectorName.toUpperCase().replace(/\s+/g, "_")}`;
  return process.env[key] || null;
}

// ---------------------------------------------------------------------------
// Send notice via Comunica+
// ---------------------------------------------------------------------------

async function sendNoticeToUser(
  targetUserId: string,
  templateCode: string,
  details: string,
): Promise<boolean> {
  try {
    const config = getConfig();
    await trpcCall("notices.createStructuredNotice", {
      pin: config.systemPin,
      templateCode,
      targetType: "USER",
      targetUserId,
      details,
    });
    return true;
  } catch (err) {
    console.error("[Comunica+] sendNoticeToUser failed:", err);
    return false;
  }
}

async function sendNoticeToSector(
  targetSectorId: string,
  templateCode: string,
  details: string,
): Promise<boolean> {
  try {
    const config = getConfig();
    await trpcCall("notices.createStructuredNotice", {
      pin: config.systemPin,
      templateCode,
      targetType: "SECTOR",
      targetSectorId,
      details,
    });
    return true;
  } catch (err) {
    console.error("[Comunica+] sendNoticeToSector failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event envelope (for logging/audit, not sent to Comunica+)
// ---------------------------------------------------------------------------

interface IntegrationEvent {
  schema_version: 1;
  event_id: string;
  event_type:
    | "ROSTER_PUBLISHED"
    | "SHIFT_VACANCY_OPENED"
    | "SHIFT_SWAP_APPROVED";
  occurred_at: string;
  dedup_key: string;
  payload: Record<string, unknown>;
}

function createEvent(
  type: IntegrationEvent["event_type"],
  dedupKey: string,
  payload: Record<string, unknown>,
): IntegrationEvent {
  return {
    schema_version: 1,
    event_id: crypto.randomUUID(),
    event_type: type,
    occurred_at: new Date().toISOString(),
    dedup_key: dedupKey,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function notifyRosterPublished(params: {
  hospitalId: number;
  yearMonth: string;
  version: number;
  publishedByUserId: number;
  professionalEmails: string[];
}): Promise<void> {
  const dedupKey = `escalas:roster:${params.yearMonth}:hospital:${params.hospitalId}:v${params.version}`;
  const event = createEvent("ROSTER_PUBLISHED", dedupKey, {
    yearMonth: params.yearMonth,
    version: params.version,
    publishedBy: params.publishedByUserId,
  });
  console.log("[Comunica+] ROSTER_PUBLISHED:", event.dedup_key);

  for (const email of params.professionalEmails) {
    const userId = await resolveUserIdByEmail(email);
    if (!userId) {
      console.warn(`[Comunica+] Skip notice: no userId for ${email}`);
      continue;
    }
    await sendNoticeToUser(
      userId,
      "ROSTER_PUBLISHED",
      `dedup=${dedupKey};yearMonth=${params.yearMonth};v=${params.version}`,
    );
  }
}

export async function notifyVacancyOpened(params: {
  shiftInstanceId: number;
  startAt: string;
  endAt: string;
  templateName: string;
  sectorName: string | null;
}): Promise<void> {
  const dedupKey = `escalas:vacancy:${params.shiftInstanceId}`;
  const event = createEvent("SHIFT_VACANCY_OPENED", dedupKey, {
    shiftInstanceId: params.shiftInstanceId,
    startAt: params.startAt,
    endAt: params.endAt,
    templateName: params.templateName,
  });
  console.log("[Comunica+] SHIFT_VACANCY_OPENED:", event.dedup_key);

  if (params.sectorName) {
    const sectorUUID = getSectorUUID(params.sectorName);
    if (sectorUUID) {
      await sendNoticeToSector(
        sectorUUID,
        "SHIFT_VACANCY",
        `dedup=${dedupKey};shift=${params.templateName};start=${params.startAt}`,
      );
    }
  }
}

export async function notifySwapApproved(params: {
  swapId: number;
  fromEmail: string;
  toEmail: string;
}): Promise<void> {
  const dedupKey = `escalas:swap:${params.swapId}`;
  const event = createEvent("SHIFT_SWAP_APPROVED", dedupKey, {
    swapId: params.swapId,
  });
  console.log("[Comunica+] SHIFT_SWAP_APPROVED:", event.dedup_key);

  for (const email of [params.fromEmail, params.toEmail]) {
    const userId = await resolveUserIdByEmail(email);
    if (!userId) continue;
    await sendNoticeToUser(
      userId,
      "SHIFT_SWAP_APPROVED",
      `dedup=${dedupKey};swap=${params.swapId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Presence (consumir do Comunica+)
// ---------------------------------------------------------------------------

interface OnlineProfessional {
  userId: string;
  email: string;
  name: string;
  dutyType: string;
}

let presenceCache: { data: OnlineProfessional[]; ts: number } | null =
  null;
const PRESENCE_TTL = 30_000; // 30 seconds

export async function getOnlineProfessionals(): Promise<
  OnlineProfessional[]
> {
  if (presenceCache && Date.now() - presenceCache.ts < PRESENCE_TTL) {
    return presenceCache.data;
  }
  try {
    const result = await trpcCall<OnlineProfessional[]>(
      "auth.listDutyPresence",
      {},
    );
    presenceCache = { data: result || [], ts: Date.now() };
    return presenceCache.data;
  } catch (err) {
    console.error("[Comunica+] getOnlineProfessionals failed:", err);
    return presenceCache?.data || [];
  }
}
