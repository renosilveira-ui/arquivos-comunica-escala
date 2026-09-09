import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("contrato multiplataforma do editor da Agenda pessoal", () => {
  const source = readFileSync(
    "components/agenda/PersonalAgendaEditor.tsx",
    "utf8",
  );

  it("não consulta um item real ao abrir o modo criação", () => {
    expect(source).toContain("skipToken");
    expect(source).not.toContain("target?.itemId ?? 1");
    expect(source).toContain("selectPersonalAgendaEditorRecord");
  });

  it("não promove a versão nova da consulta para campos antigos", () => {
    expect(source).toContain("personalAgendaExpectedVersion");
    expect(source).not.toContain("expectedVersion: loaded.version");
  });

  it("inicia um compromisso com fim no mesmo dia do horário inicial", () => {
    expect(source).toContain(
      "const [endDate, setEndDate] = useState(target.dateKey)",
    );
  });

  it("reconcilia o cache confirmado e mantém a operação até o fim", () => {
    expect(source).toContain("selectPersonalAgendaMutationRecord");
    expect(source).toContain("awaitPersonalAgendaEditorStep");
    expect(source).toContain("reconcilePersonalAgendaEditorCache");
    expect(source).toContain("isEditorAuthorityCurrent");
    expect(source).toContain("getItem.setData");
    expect(source).toContain("operationController.run");
    expect(source).toContain("settlePersonalAgendaRefreshes");
  });

  it("usa confirmação própria acessível, funcional na web e no mobile", () => {
    expect(source).not.toContain("Alert.alert");
    expect(source.match(/<Modal\b/g)).toHaveLength(1);
    expect(source).toContain("accessibilityViewIsModal");
    expect(source).toContain('accessibilityLabel="Cancelar exclusão"');
    expect(source).toContain('accessibilityLabel="Confirmar exclusão"');
    expect(source).toContain("void performDelete()");
  });
});
