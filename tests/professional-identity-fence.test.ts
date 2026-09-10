import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectUniqueTenantProfessional } from "../server/aux-routers";

const professional = (id: number) =>
  ({
    id,
    userId: 41,
    name: `Profissional ${id}`,
    role: "Médico",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    professionCode: null,
    customProfessionName: null,
    userRole: "USER",
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
  }) as any;

describe("professionals.getByUserId: identidade institucional fail-closed", () => {
  it("preserva ausência como null", () => {
    expect(selectUniqueTenantProfessional([])).toBeNull();
  });

  it("devolve a única identidade vinculada", () => {
    expect(
      selectUniqueTenantProfessional([{ professional: professional(17) }]),
    ).toMatchObject({ id: 17, userId: 41 });
  });

  it("recusa cardinalidade ambígua em vez de escolher a primeira linha", () => {
    expect(() =>
      selectUniqueTenantProfessional([
        { professional: professional(17) },
        { professional: professional(18) },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFLICT",
        message: "Vínculo profissional institucional ambíguo",
      }),
    );
  });

  it("recusa identidade self diferente da identidade canônica do contexto", () => {
    expect(() =>
      selectUniqueTenantProfessional(
        [{ professional: professional(17) }],
        18,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFLICT",
        message: "Identidade profissional diverge do tenant autenticado",
      }),
    );
  });

  it("amarra a consulta a professionalId, userId, tenant ativo e sem LIMIT 1", () => {
    const source = readFileSync("server/aux-routers.ts", "utf8");
    const route = source.slice(
      source.indexOf("getByUserId:"),
      source.indexOf("listMyInstitutions:"),
    );

    expect(route).toContain(".from(professionalInstitutions)");
    expect(route).toContain(
      "eq(professionalInstitutions.professionalId, professionals.id)",
    );
    expect(route).toContain(
      "eq(professionalInstitutions.userId, professionals.userId)",
    );
    expect(route).toContain(
      "eq(professionalInstitutions.userId, input.userId)",
    );
    expect(route).toContain(
      "eq(professionalInstitutions.institutionId, ctx.institutionId)",
    );
    expect(route).toContain("eq(professionalInstitutions.active, true)");
    expect(route).toContain(
      "ctx.tenantProfessionalId ?? actor.professionalId",
    );
    expect(route).toContain("const capabilities = actorCapabilities(actor)");
    expect(route).toContain(
      "capabilities.canCreateShift || capabilities.canApproveAssignments",
    );
    expect(route).not.toContain(".limit(1)");
  });
});
