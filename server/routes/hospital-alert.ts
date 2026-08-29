import axios, { isAxiosError, type AxiosError } from "axios";
import { Router, type Request, type Response } from "express";
import type { User } from "../../drizzle/schema";
import { sdk } from "../_core/sdk";

export const hospitalAlertRouter = Router();

const TIMEOUT_MS = 8_000;
const EXTERNAL_USER_PREFIX = "shiftsapp:";

/** Identidade upstream derivada do usuário autenticado no Escala+ (não do cliente). */
export function ownedExternalUserId(userId: number): string {
  return `${EXTERNAL_USER_PREFIX}${userId}`;
}

export function withServerIntegrationIdentity(
  body: Record<string, unknown>,
  userId: number,
  organizationId: string,
): Record<string, unknown> {
  return {
    ...body,
    externalUserId: ownedExternalUserId(userId),
    organizationId,
  };
}

type HospitalAlertConfig = {
  baseUrl: string;
  apiKey: string;
  organizationId: string;
};

function resolveHospitalAlertConfig(): HospitalAlertConfig | null {
  const baseUrl = (process.env.HOSPITAL_ALERT_URL ?? "").trim().replace(/\/$/, "");
  const apiKey = (process.env.HOSPITAL_ALERT_API_KEY ?? "").trim();
  const organizationId = (process.env.HOSPITAL_ALERT_ORG_ID ?? "hsc").trim();
  if (!baseUrl || !apiKey || !organizationId) return null;
  return { baseUrl, apiKey, organizationId };
}

function integrationHeaders(config: HospitalAlertConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "X-Organization-Id": config.organizationId,
    "Content-Type": "application/json",
  };
}

function mapProxyError(error: unknown): { status: number; error: string } {
  if (isAxiosError(error)) {
    const axiosError = error as AxiosError<{ message?: string }>;
    const status = axiosError.response?.status ?? 502;
    const message =
      axiosError.response?.data?.message ??
      axiosError.message ??
      "Falha ao contatar Hospital Alert";
    return { status, error: message };
  }
  return { status: 502, error: "Falha ao contatar Hospital Alert" };
}

async function requireAuthenticatedUser(
  req: Request,
  res: Response,
): Promise<User | null> {
  try {
    return await sdk.authenticateRequest(req);
  } catch {
    res.status(401).json({ error: "Não autenticado" });
    return null;
  }
}

function integrationUnavailable(res: Response): void {
  res.status(503).json({ error: "Integração Hospital Alert indisponível" });
}

hospitalAlertRouter.post(
  "/sync-user",
  async (req: Request, res: Response): Promise<void> => {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;
    const config = resolveHospitalAlertConfig();
    if (!config) {
      integrationUnavailable(res);
      return;
    }
    const upstreamBody = withServerIntegrationIdentity(
      (req.body ?? {}) as Record<string, unknown>,
      user.id,
      config.organizationId,
    );
    try {
      const response = await axios.post(
        `${config.baseUrl}/api/trpc/auth.syncUser`,
        upstreamBody,
        {
          headers: integrationHeaders(config),
          timeout: TIMEOUT_MS,
        },
      );
      res.json({ ok: true, data: response.data });
    } catch (error) {
      const mapped = mapProxyError(error);
      res.status(mapped.status).json({ ok: false, error: mapped.error });
    }
  },
);

hospitalAlertRouter.post(
  "/shifts/start",
  async (req: Request, res: Response): Promise<void> => {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;
    const config = resolveHospitalAlertConfig();
    if (!config) {
      integrationUnavailable(res);
      return;
    }
    const upstreamBody = withServerIntegrationIdentity(
      (req.body ?? {}) as Record<string, unknown>,
      user.id,
      config.organizationId,
    );
    try {
      const response = await axios.post(
        `${config.baseUrl}/api/trpc/shifts.start`,
        upstreamBody,
        {
          headers: integrationHeaders(config),
          timeout: TIMEOUT_MS,
        },
      );
      res.json({ ok: true, data: response.data });
    } catch (error) {
      const mapped = mapProxyError(error);
      res.status(mapped.status).json({ ok: false, error: mapped.error });
    }
  },
);

hospitalAlertRouter.post(
  "/shifts/end",
  async (req: Request, res: Response): Promise<void> => {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;
    const config = resolveHospitalAlertConfig();
    if (!config) {
      integrationUnavailable(res);
      return;
    }
    const upstreamBody = withServerIntegrationIdentity(
      (req.body ?? {}) as Record<string, unknown>,
      user.id,
      config.organizationId,
    );
    try {
      const response = await axios.post(
        `${config.baseUrl}/api/trpc/shifts.end`,
        upstreamBody,
        {
          headers: integrationHeaders(config),
          timeout: TIMEOUT_MS,
        },
      );
      res.json({ ok: true, data: response.data });
    } catch (error) {
      const mapped = mapProxyError(error);
      res.status(mapped.status).json({ ok: false, error: mapped.error });
    }
  },
);

hospitalAlertRouter.get(
  "/status",
  async (req: Request, res: Response): Promise<void> => {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;
    const config = resolveHospitalAlertConfig();
    if (!config) {
      integrationUnavailable(res);
      return;
    }
    const externalUserId = ownedExternalUserId(user.id);
    const organizationId = config.organizationId;
    try {
      const response = await axios.get(
        `${config.baseUrl}/api/trpc/integration.getStatus`,
        {
          params: { externalUserId, organizationId },
          headers: integrationHeaders(config),
          timeout: TIMEOUT_MS,
        },
      );
      res.json({ ok: true, data: response.data });
    } catch (error) {
      const mapped = mapProxyError(error);
      res.status(mapped.status).json({ ok: false, error: mapped.error });
    }
  },
);
