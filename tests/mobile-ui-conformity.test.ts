import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const trocas = readFileSync("app/(tabs)/trocas.tsx", "utf8");
const vagas = readFileSync("app/(tabs)/vacancies.tsx", "utf8");
const perfil = readFileSync("app/(tabs)/profile.tsx", "utf8");
const applications = readFileSync("app/my-applications.tsx", "utf8");
const available = readFileSync(
  "components/swaps/AvailableSwapsList.tsx",
  "utf8",
);
const buttonNative = readFileSync("components/ui/AppButton.native.tsx", "utf8");
const buttonWeb = readFileSync("components/ui/AppButton.web.tsx", "utf8");

describe("conformidade visual mobile corporativa", () => {
  it("consolida as três filas de Trocas e só monta as secundárias após visita", () => {
    expect(trocas).toMatch(/label:\s*["']Disponíveis["']/);
    expect(trocas).toMatch(/label:\s*["']Ofertas["']/);
    expect(trocas).toMatch(/label:\s*["']Candidaturas["']/);
    expect(trocas).toMatch(/visited\.offers/);
    expect(trocas).toMatch(/visited\.applications/);
    expect(trocas).toMatch(/onExploreAvailable/);
    expect(trocas).toMatch(/isDesktop\s*\?\s*\(/);
  });

  it("reserva navy para ações e mantém os tipos de troca neutros", () => {
    expect(available).toMatch(/backgroundColor:\s*isPrimary\s*\?\s*theme\.colors\.brand/);
    expect(available).toMatch(/backgroundColor:\s*theme\.colors\.surfaceAlt/);
    expect(available).toMatch(/swaps\.filter\(listedSwapIsActionable\)\.length/);
    expect(available).toMatch(/onCountChange\?\.\(actionableSwapCount\)/);
    expect(buttonNative).toMatch(/case\s+["']brand["']/);
    expect(buttonWeb).toMatch(/case\s+["']brand["']/);
  });

  it("preserva os estados de Vagas e explica bloqueios sem revelar topologia", () => {
    expect(vagas).toMatch(/<SkeletonList\s+count=\{3\}\s*\/>/);
    expect(vagas).toMatch(/variant=["']brand["']/);
    expect(vagas).toMatch(/vacancies\.length\s*===\s*1\s*\?\s*["']plantão["']\s*:\s*["']plantões["']/);
    expect(vagas).toMatch(/Seu vínculo atual não permite solicitar esta vaga\./);
    expect(vagas).toMatch(/vacanciesContentState\s*===\s*["']ERROR["']/);
    expect(vagas).toMatch(/vacanciesContentState\s*===\s*["']UNRESOLVED["']/);
    expect(vagas).toMatch(/assumeVacancyId\s*===\s*vacancy\.id/);
  });

  it("separa candidaturas ativas do histórico", () => {
    expect(applications).toMatch(/const activeApplications\s*=\s*applications\.filter/);
    expect(applications).toMatch(/status\s*===\s*["']PENDING["']/);
    expect(applications).toMatch(/status\s*===\s*["']ACCEPTED["']/);
    expect(applications).toMatch(/Candidaturas em andamento/);
    expect(applications).toMatch(/activeApplications\.map/);
    expect(applications).toMatch(/highlighted/);
  });

  it("remove rotas duplicadas de troca do Perfil e separa sair de excluir", () => {
    expect(perfil).not.toMatch(/title=["']Minhas ofertas["']/);
    expect(perfil).not.toMatch(/title=["']Suas candidaturas["']/);
    expect(perfil).toMatch(/title=["']Movimentações de plantão["']/);
    expect(perfil).toMatch(/title=\{isLoggingOut\s*\?\s*["']Saindo…["']\s*:\s*["']Sair da conta["']\}/);
    expect(perfil).toMatch(/title=["']Excluir minha conta["']/);
    expect(perfil).toMatch(/tone=["']danger["']/);
  });
});
