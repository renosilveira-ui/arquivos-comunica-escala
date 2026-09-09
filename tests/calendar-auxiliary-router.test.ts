import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";

import { appRouter } from "../server/routers";

function caller(userId: number | null) {
  return appRouter.createCaller({
    user:
      userId === null
        ? null
        : {
            id: userId,
            role: "doctor",
            name: "Pessoa teste",
            email: "pessoa@test.local",
            sessionVersion: 1,
          },
    institutionId: null,
    allowedInstitutionIds: [],
  } as any);
}

describe("calendarAuxiliary.listHolidays", () => {
  it("é basal para qualquer conta autenticada, mesmo sem tenant", async () => {
    const result = await caller(91).calendarAuxiliary.listHolidays({
      year: 2026,
      countryCode: "BR",
      stateCode: "CE",
    });

    expect(result).toMatchObject({
      year: 2026,
      countryCode: "BR",
      stateCode: "CE",
    });
    expect(result.holidays).toContainEqual(
      expect.objectContaining({
        date: "2026-03-25",
        name: "Data Magna do Ceará",
      }),
    );
  });

  it("não aceita tenant, estado ou país injetado fora do contrato", async () => {
    await expect(
      caller(91).calendarAuxiliary.listHolidays({
        year: 2026,
        countryCode: "BR",
        stateCode: "CE",
        institutionId: 999,
      } as any),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      caller(91).calendarAuxiliary.listHolidays({
        year: 2026,
        countryCode: "US",
        stateCode: "CA",
      } as any),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("não fica público para clientes sem sessão", async () => {
    await expect(
      caller(null).calendarAuxiliary.listHolidays({
        year: 2026,
        countryCode: "BR",
        stateCode: "CE",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
