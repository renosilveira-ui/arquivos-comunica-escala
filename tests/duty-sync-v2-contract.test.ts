import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DUTY_ASSUMED_SUCCESS_COPY,
  DUTY_CONFIRM_PROMPT_COPY,
  DUTY_CONFIRMED_SUCCESS_COPY,
  DUTY_NOMINATION_PROMPT_COPY,
} from "../lib/duty-sync-copy";

const confirmDuty = readFileSync("app/confirm-duty.tsx", "utf8");
const dutySync = readFileSync("server/sso/duty-sync.ts", "utf8");
const dutySyncStatus = readFileSync("server/sso/duty-sync-status.ts", "utf8");
const confirmationRouter = readFileSync("server/confirmation-router.ts", "utf8");
const renderYaml = readFileSync("render.yaml", "utf8");
const hospitalAlertConfig = readFileSync("lib/hospitalAlertConfig.ts", "utf8");
const contractV2 = readFileSync(
  "docs/CONTRACT_ESCALA_COMUNICA_DUTY_SYNC_V2.md",
  "utf8",
);

describe("contrato duty-sync V2 (estrutural)", () => {
  it("copy de confirmação não promete login nem presença imediata", () => {
    expect(confirmDuty).toContain("DUTY_CONFIRMED_SUCCESS_COPY");
    expect(confirmDuty).toContain("DUTY_ASSUMED_SUCCESS_COPY");
    expect(confirmDuty).toContain("DUTY_CONFIRM_PROMPT_COPY");
    expect(confirmDuty).toContain("DUTY_NOMINATION_PROMPT_COPY");
    expect(confirmDuty).not.toMatch(/login no Comunica\+ será/);
    expect(confirmDuty).not.toMatch(/login automático/);
    expect(confirmDuty).not.toMatch(/já está no Comunica/);
    expect(confirmDuty).not.toMatch(/ativo no Comunica/);
    expect(DUTY_CONFIRMED_SUCCESS_COPY).toContain(
      "No horário do plantão, sua presença será informada automaticamente ao Comunica+",
    );
    expect(DUTY_ASSUMED_SUCCESS_COPY).toContain(
      "No horário do plantão, sua presença será informada automaticamente ao Comunica+",
    );
    expect(DUTY_CONFIRM_PROMPT_COPY).not.toMatch(/login/i);
    expect(DUTY_NOMINATION_PROMPT_COPY).not.toMatch(/login/i);
  });

  it("#310 descreve SENT como outbox_processed, não como presença ativa", () => {
    expect(dutySyncStatus).toContain("escala_outbox");
    expect(dutySyncStatus).toContain("outbox_processed");
    expect(dutySyncStatus).toContain("SENT ≠ presença ativa no Comunica+");
    expect(dutySyncStatus).not.toMatch(/ativo no Comunica/);
  });

  it("Hospital Alert permanece congelado e outbound de avisos continua 0", () => {
    expect(hospitalAlertConfig).toContain("LEGACY_CONTRACT_FROZEN");
    expect(hospitalAlertConfig).toContain(
      "EXPO_PUBLIC_HOSPITAL_ALERT_ENABLED",
    );
    expect(renderYaml).toMatch(
      /key:\s*COMUNICA_PLUS_OUTBOUND_ENABLED[\s\S]*value:\s*"0"/,
    );
    expect(renderYaml).not.toMatch(
      /key:\s*COMUNICA_PLUS_OUTBOUND_ENABLED[\s\S]*value:\s*"1"/,
    );
  });

  it("duty-sync não introduz START/END e não dispara SSO na confirmação", () => {
    expect(dutySync).toContain('export type DutySyncAction = "CONFIRM" | "WITHDRAW"');
    expect(dutySync).not.toMatch(/action:\s*"START"/);
    expect(dutySync).not.toMatch(/action:\s*"END"/);
    expect(confirmationRouter).not.toContain("enqueueAutoSsoPush");
    expect(confirmationRouter).not.toContain("triggerAutoSso");
    expect(contractV2).toContain("Não existem verbos `START` ou `END`");
    expect(contractV2).toContain("CONFIRMED → DECLINED");
  });
});
