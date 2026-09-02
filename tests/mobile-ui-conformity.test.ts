import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const trocas = readFileSync("app/(tabs)/trocas.tsx", "utf8");
const vagas = readFileSync("app/(tabs)/vacancies.tsx", "utf8");
const perfil = readFileSync("app/(tabs)/profile.tsx", "utf8");
const available = readFileSync(
  "components/swaps/AvailableSwapsList.tsx",
  "utf8",
);
const buttonNative = readFileSync("components/ui/AppButton.native.tsx", "utf8");
const buttonWeb = readFileSync("components/ui/AppButton.web.tsx", "utf8");

describe("conformidade visual mobile corporativa", () => {
  it("consolida as três filas de Trocas e só monta as secundárias após visita", () => {
    expect(trocas).toContain('label: "Disponíveis"');
    expect(trocas).toContain('label: "Ofertas"');
    expect(trocas).toContain('label: "Candidaturas"');
    expect(trocas).toContain("visited.offers");
    expect(trocas).toContain("visited.applications");
    expect(trocas).toContain("onExploreAvailable");
  });

  it("reserva navy para ações e mantém os tipos de troca neutros", () => {
    expect(available).toContain("backgroundColor: isPrimary ? theme.colors.brand");
    expect(available).toContain("backgroundColor: theme.colors.surfaceAlt");
    expect(buttonNative).toContain('case "brand"');
    expect(buttonWeb).toContain('case "brand"');
  });

  it("preserva os estados de Vagas e explica bloqueios sem revelar topologia", () => {
    expect(vagas).toContain('<SkeletonList count={3} />');
    expect(vagas).toContain('variant="brand"');
    expect(vagas).toContain('vacancies.length === 1 ? "plantão" : "plantões"');
    expect(vagas).toContain("Seu vínculo atual não permite solicitar esta vaga.");
    expect(vagas).toContain("vacanciesContentState === \"ERROR\"");
    expect(vagas).toContain("vacanciesContentState === \"UNRESOLVED\"");
  });

  it("remove rotas duplicadas de troca do Perfil e separa sair de excluir", () => {
    expect(perfil).not.toContain('title="Minhas ofertas"');
    expect(perfil).not.toContain('title="Suas candidaturas"');
    expect(perfil).toContain('title="Movimentações de plantão"');
    expect(perfil).toContain('title={isLoggingOut ? "Saindo…" : "Sair da conta"}');
    expect(perfil).toContain('title="Excluir minha conta"');
    expect(perfil).toContain('tone="danger"');
  });
});
