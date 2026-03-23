interface ComunicaPlusConfig {
  baseUrl: string;
  systemEmail: string;
  systemPassword: string;
  systemPin: string;
}

function getConfig(): ComunicaPlusConfig {
  return {
    baseUrl:
      process.env.COMUNICA_PLUS_URL ||
      "https://comunicamais-staging.onrender.com",
    systemEmail:
      process.env.COMUNICA_PLUS_SYSTEM_EMAIL ||
      "system.escalas@hospital.com",
    systemPassword: process.env.COMUNICA_PLUS_SYSTEM_PASSWORD || "",
    systemPin: process.env.COMUNICA_PLUS_SYSTEM_PIN || "9999",
  };
}

let sessionCookie: string | null = null;
const userIdByEmailCache = new Map<string, string>();

function extractSessionCookie(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error("Comunica+ login sem set-cookie");
  const match = setCookieHeader.match(/session=[^;]+/);
  if (!match) throw new Error("Cookie de sessão não encontrado em set-cookie");
  return match[0];
}

function parseBatchResult<T>(data: any): T {
  const item = data?.[0];
  if (!item) throw new Error("Resposta batch vazia do Comunica+");
  if (item.error) {
    const msg =
      item.error?.json?.message ||
      item.error?.message ||
      "Erro desconhecido no Comunica+";
    throw new Error(msg);
  }
  return (item?.result?.data?.json ?? item?.result?.data) as T;
}

export function clearSession() {
  sessionCookie = null;
}

export async function ensureSession(): Promise<string> {
  if (sessionCookie) return sessionCookie;

  const config = getConfig();
  const res = await fetch(`${config.baseUrl}/api/trpc/auth.login?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      "0": {
        email: config.systemEmail,
        password: config.systemPassword,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Comunica+ auth.login falhou (${res.status}): ${text}`);
  }

  sessionCookie = extractSessionCookie(res.headers.get("set-cookie"));
  return sessionCookie;
}

async function trpcCall<T>(
  procedure: string,
  input: Record<string, unknown>,
  retried = false,
): Promise<T> {
  const cookie = await ensureSession();
  const config = getConfig();
  const res = await fetch(`${config.baseUrl}/api/trpc/${procedure}?batch=1`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ "0": input }),
  });

  if (res.status === 401 && !retried) {
    clearSession();
    return trpcCall<T>(procedure, input, true);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Comunica+ ${procedure} falhou (${res.status}): ${text}`);
  }

  const data = await res.json();
  return parseBatchResult<T>(data);
}

export async function resolveUserIdByEmail(
  email: string,
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const cached = userIdByEmailCache.get(normalized);
  if (cached) return cached;

  try {
    const response = await trpcCall<{ userId: string | null }>(
      "integrations.resolveUserIdByEmail",
      { email: normalized },
    );
    const userId = response?.userId ?? null;
    if (userId) userIdByEmailCache.set(normalized, userId);
    return userId;
  } catch (err) {
    console.warn(`[Comunica+] resolveUserIdByEmail falhou para ${email}:`, err);
    return null;
  }
}

export async function sendStructuredNotice(input: {
  targetUserId: string;
  templateCode:
    | "ROSTER_PUBLISHED"
    | "SHIFT_VACANCY_OPENED"
    | "SHIFT_SWAP_APPROVED";
  details: string;
}): Promise<void> {
  const config = getConfig();
  await trpcCall("notices.createStructuredNotice", {
    pin: config.systemPin,
    templateCode: input.templateCode,
    targetType: "USER",
    targetUserId: input.targetUserId,
    details: input.details,
  });
}

export async function notifyRosterPublished(params: {
  hospitalId: number;
  yearMonth: string;
  version: number;
  professionalEmails: string[];
}): Promise<void> {
  const dedup = `escalas:roster:${params.yearMonth}:hospital:${params.hospitalId}:v${params.version}`;
  const details = `dedup=${dedup};yearMonth=${params.yearMonth};v=${params.version}`;

  for (const email of params.professionalEmails) {
    const targetUserId = await resolveUserIdByEmail(email);
    if (!targetUserId) {
      console.warn(`[Comunica+] skip ROSTER_PUBLISHED sem userId para ${email}`);
      continue;
    }
    try {
      await sendStructuredNotice({
        targetUserId,
        templateCode: "ROSTER_PUBLISHED",
        details,
      });
    } catch (err) {
      console.error("[Comunica+] erro ao enviar ROSTER_PUBLISHED:", err);
    }
  }
}

export async function notifyVacancyOpened(params: {
  shiftInstanceId: number;
  startAt: string;
  endAt: string;
  templateName: string;
  professionalEmails: string[];
}): Promise<void> {
  const dedup = `escalas:vacancy:${params.shiftInstanceId}`;
  const details = `dedup=${dedup};shift=${params.templateName};start=${params.startAt};end=${params.endAt}`;

  for (const email of params.professionalEmails) {
    const targetUserId = await resolveUserIdByEmail(email);
    if (!targetUserId) {
      console.warn(
        `[Comunica+] skip SHIFT_VACANCY_OPENED sem userId para ${email}`,
      );
      continue;
    }
    try {
      await sendStructuredNotice({
        targetUserId,
        templateCode: "SHIFT_VACANCY_OPENED",
        details,
      });
    } catch (err) {
      console.error("[Comunica+] erro ao enviar SHIFT_VACANCY_OPENED:", err);
    }
  }
}

export async function notifySwapApproved(params: {
  swapId: number;
  fromEmail: string;
  toEmail: string;
}): Promise<void> {
  const dedup = `escalas:swap:${params.swapId}`;
  const details = `dedup=${dedup};swapId=${params.swapId}`;

  for (const email of [params.fromEmail, params.toEmail]) {
    const targetUserId = await resolveUserIdByEmail(email);
    if (!targetUserId) {
      console.warn(`[Comunica+] skip SHIFT_SWAP_APPROVED sem userId para ${email}`);
      continue;
    }
    try {
      await sendStructuredNotice({
        targetUserId,
        templateCode: "SHIFT_SWAP_APPROVED",
        details,
      });
    } catch (err) {
      console.error("[Comunica+] erro ao enviar SHIFT_SWAP_APPROVED:", err);
    }
  }
}

interface OnlineProfessional {
  userId: string;
  email: string;
  name: string;
  dutyType: string;
}

let presenceCache: { data: OnlineProfessional[]; ts: number } | null = null;
const PRESENCE_TTL_MS = 30_000;

export async function getOnlineProfessionals(): Promise<OnlineProfessional[]> {
  if (presenceCache && Date.now() - presenceCache.ts < PRESENCE_TTL_MS) {
    return presenceCache.data;
  }

  try {
    const data = await trpcCall<OnlineProfessional[]>("auth.listDutyPresence", {});
    const safe = Array.isArray(data) ? data : [];
    presenceCache = { data: safe, ts: Date.now() };
    return safe;
  } catch (err) {
    console.error("[Comunica+] getOnlineProfessionals falhou:", err);
    return presenceCache?.data || [];
  }
}

