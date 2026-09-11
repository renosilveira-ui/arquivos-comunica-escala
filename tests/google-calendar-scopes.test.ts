import { describe, expect, it } from "vitest";

import {
  CALENDAR_CREATION_SCOPES,
  GOOGLE_CALENDAR_SCOPES,
  canCreateDedicatedCalendar,
} from "../server/integrations/providers/calendar-provider";

/**
 * Em 11/09/2026 o vínculo com o Google "deu certo" e a tela disse "Tudo já
 * estava em dia" — para um calendário que nunca existiu. Os escopos pedidos
 * não permitiam `calendars.insert`, a criação falhava com 403, e a exportação
 * devolvia sucesso com zeros. Estes testes prendem a parte pura da lição.
 */
describe("escopos do Google Agenda", () => {
  it("o app pede um escopo que autoriza criar o calendário dedicado", () => {
    expect(
      GOOGLE_CALENDAR_SCOPES.some((scope) =>
        CALENDAR_CREATION_SCOPES.includes(scope),
      ),
    ).toBe(true);
  });

  it("continua pedindo o que reencontra e escreve no calendário", () => {
    expect(GOOGLE_CALENDAR_SCOPES).toContain(
      "https://www.googleapis.com/auth/calendar.calendarlist",
    );
    expect(GOOGLE_CALENDAR_SCOPES).toContain(
      "https://www.googleapis.com/auth/calendar.events",
    );
  });

  /**
   * Menor privilégio: o escopo cheio `calendar` dá acesso a TODOS os
   * calendários do usuário. `calendar.app.created` só ao que o app criou.
   */
  it("não pede o escopo cheio do calendário", () => {
    expect(GOOGLE_CALENDAR_SCOPES).not.toContain(
      "https://www.googleapis.com/auth/calendar",
    );
  });

  it("reconhece o vínculo antigo como incapaz de criar o calendário", () => {
    const antigo =
      "https://www.googleapis.com/auth/calendar.calendarlist https://www.googleapis.com/auth/calendar.events";
    expect(canCreateDedicatedCalendar(antigo)).toBe(false);
    expect(canCreateDedicatedCalendar(null)).toBe(false);
    expect(canCreateDedicatedCalendar("")).toBe(false);
    expect(canCreateDedicatedCalendar([])).toBe(false);
  });

  it("aceita qualquer um dos escopos de criação, em string ou lista", () => {
    for (const scope of CALENDAR_CREATION_SCOPES) {
      expect(canCreateDedicatedCalendar(scope), scope).toBe(true);
      expect(
        canCreateDedicatedCalendar(
          `https://www.googleapis.com/auth/calendar.events ${scope}`,
        ),
        scope,
      ).toBe(true);
      expect(canCreateDedicatedCalendar([scope]), scope).toBe(true);
    }
    expect(canCreateDedicatedCalendar(GOOGLE_CALENDAR_SCOPES)).toBe(true);
  });
});
