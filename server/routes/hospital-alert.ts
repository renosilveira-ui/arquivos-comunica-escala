import axios, { isAxiosError, type AxiosError } from "axios";
import { Router, type Request, type Response } from "express";
import { sdk } from "../_core/sdk";

export const hospitalAlertRouter = Router();

const TIMEOUT_MS = 8_000;

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
): Promise<boolean> {
  try {
    await sdk.authenticateRequest(req);
    return true;
  } catch {
    res.status(401).json({ error: "Não autenticado" });
    return false;
  }
}

function integrationUnavailable(res: Response): void {
  res.status(503).json({ error: "Integração Hospital Alert indisponível" });
}

hospitalAlertRouter.post(
  "/sync-user",
  async (req: Request, res: Response): Promise<void> => {
    if (!(await requireAuthenticatedUser(req, res))) return;
    const config = resolveHospitalAlertConfig();
    if (!config) {
      integrationUnavailable(res);
      return;
    }
    try {
      const response = await axios.post(
        `${config.baseUrl}/api/trpc/auth.syncUser`,
        req.body,
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
    if (!(await requireAuthenticatedUser(req, res))) return;
    const config = resolveHospitalAlertConfig();
    if (!config) {
      integrationUnavailable(res);
      return;
    }
    try {
      const response = await axios.post(
        `${config.baseUrl}/api/trpc/shifts.start`,
        req.body,
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
    if (!(await requireAuthenticatedUser(req, res))) return;
    const config = resolveHospitalAlertConfig();
    if (!config) {
      integrationUnavailable(res);
      return;
    }
    try {
      const response = await axios.post(
        `${config.baseUrl}/api/trpc/shifts.end`,
        req.body,
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
    if (!(await requireAuthenticatedUser(req, res))) return;
    const config = resolveHospitalAlertConfig();
    if (!config) {
      integrationUnavailable(res);
      return;
    }
    const externalUserId = String(req.query.externalUserId ?? "").trim();
    const organizationId = String(
      req.query.organizationId ?? config.organizationId,
    ).trim();
    if (!externalUserId) {
      res.status(400).json({ error: "externalUserId é obrigatório" });
      return;
    }
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
