import { describe, expect, it } from "vitest";
import {
  parseStoredTenantFilterId,
  sanitizeTenantFilterSelection,
  tenantFilterStorageKey,
} from "../lib/tenant-filter-storage";

describe("preferências de filtro por tenant", () => {
  const hospitalsA = [{ id: 101 }];
  const sectorsA = [{ id: 1001, hospitalId: 101 }];
  const hospitalsB = [{ id: 202 }];
  const sectorsB = [{ id: 2002, hospitalId: 202 }];

  it("nunca reutiliza a chave de hospital ou setor de outra instituição", () => {
    expect(tenantFilterStorageKey(1, "hospital")).toBe(
      "escala.shift-filters.v1.i1.hospital",
    );
    expect(tenantFilterStorageKey(2, "hospital")).toBe(
      "escala.shift-filters.v1.i2.hospital",
    );
    expect(tenantFilterStorageKey(1, "sector")).toBe(
      "escala.shift-filters.v1.i1.sector",
    );
    expect(tenantFilterStorageKey(null, "hospital")).toBeNull();
  });

  it("rejeita coerções ambíguas do localStorage", () => {
    expect(parseStoredTenantFilterId("101")).toBe(101);
    expect(parseStoredTenantFilterId("0")).toBeNull();
    expect(parseStoredTenantFilterId(" 101")).toBeNull();
    expect(parseStoredTenantFilterId("101e0")).toBeNull();
    expect(parseStoredTenantFilterId(101)).toBeNull();
  });

  it("A → B reduz hospital e setor antigos para filtros neutros", () => {
    expect(
      sanitizeTenantFilterSelection({
        hospitalId: 101,
        sectorId: 1001,
        hospitals: hospitalsB,
        sectors: sectorsB,
      }),
    ).toEqual({ hospitalId: null, sectorId: null });
  });

  it("preserva apenas a seleção pertencente ao tenant atual", () => {
    expect(
      sanitizeTenantFilterSelection({
        hospitalId: 202,
        sectorId: 1001,
        hospitals: hospitalsB,
        sectors: sectorsB,
      }),
    ).toEqual({ hospitalId: 202, sectorId: null });
    expect(
      sanitizeTenantFilterSelection({
        hospitalId: 202,
        sectorId: 2002,
        hospitals: hospitalsB,
        sectors: sectorsB,
      }),
    ).toEqual({ hospitalId: 202, sectorId: 2002 });
    expect(
      sanitizeTenantFilterSelection({
        hospitalId: 101,
        sectorId: 1001,
        hospitals: hospitalsA,
        sectors: sectorsA,
      }),
    ).toEqual({ hospitalId: 101, sectorId: 1001 });
  });
});
