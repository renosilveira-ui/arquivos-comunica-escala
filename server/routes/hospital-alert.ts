import { Router, type Request, type Response } from "express";

/**
 * Superfície LEGADA do Hospital Alert — CONGELADA (fail-closed).
 *
 * O contrato tRPC do Hospital Alert não existe no Comunica+ atual (ADR-001;
 * substituído por duty-sync V1). O cliente já bloqueia toda saída
 * (`isLegacyHospitalAlertOutboundBlocked() === true` → 410 LEGACY_CONTRACT_FROZEN).
 *
 * Antes, estes endpoints faziam PROXY autenticado para o upstream usando a API
 * key privilegiada do servidor, exigindo apenas autenticação — sem validar
 * tenant, hospital, setor ou papel. Se as credenciais fossem reativadas
 * (HOSPITAL_ALERT_URL/API_KEY/ORG_ID), qualquer usuário autenticado acionaria
 * operações privilegiadas com o segredo do servidor e um corpo controlado pelo
 * cliente. Para fechar essa brecha latente na raiz, a superfície responde 410
 * para qualquer chamador — sem contatar o upstream e sem usar segredo algum,
 * independentemente da configuração/credenciais presentes no ambiente.
 *
 * As rotas permanecem montadas (410, não 404) para manter o contrato legado
 * explícito e alinhado ao cliente. Uma eventual revitalização deverá
 * reimplementar com autorização canônica (tenant + papel + escopo
 * hospital/setor via server/_core/policy) e identidade derivada do servidor.
 */
export const hospitalAlertRouter = Router();

/** HTTP 410 — contrato legado congelado (espelha lib/hospitalAlertConfig.ts). */
const LEGACY_CONTRACT_FROZEN_STATUS = 410;
const LEGACY_CONTRACT_FROZEN_CODE = "LEGACY_CONTRACT_FROZEN";

function respondLegacyContractFrozen(req: Request, res: Response): void {
  // Observabilidade: registrar chamadas à superfície legada ajuda a detectar
  // clientes antigos ainda apontando para o Hospital Alert. Sem PII — só
  // método e rota; nenhum corpo, usuário ou segredo é logado.
  console.warn(
    "[hospital-alert] chamada a superfície legada congelada",
    JSON.stringify({ method: req.method, path: req.path }),
  );
  res
    .status(LEGACY_CONTRACT_FROZEN_STATUS)
    .json({ ok: false, error: LEGACY_CONTRACT_FROZEN_CODE });
}

hospitalAlertRouter.post("/sync-user", respondLegacyContractFrozen);
hospitalAlertRouter.post("/shifts/start", respondLegacyContractFrozen);
hospitalAlertRouter.post("/shifts/end", respondLegacyContractFrozen);
hospitalAlertRouter.get("/status", respondLegacyContractFrozen);
