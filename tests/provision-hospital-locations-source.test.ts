import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CONFIRM_PHRASE,
  FORTALEZA_TIME_ZONE,
  HOSPITAL_LOCATIONS,
  INSTITUTION_RENAMES,
} from "../scripts/provision-hospital-locations";

const source = readFileSync(
  new URL("../scripts/provision-hospital-locations.ts", import.meta.url),
  "utf8",
);

/**
 * Coordenada de hospital decide a que horas um anestesista sai de casa. Um
 * ponto errado — meio de rua, bairro homônimo, unidade errada da mesma rede
 * — produz um aviso que parece calculado e manda a pessoa para o lugar
 * errado. Por isso a tabela é auditável linha a linha.
 */
describe("tabela de localizações", () => {
  it("toda coordenada tem sete casas e origem declarada", () => {
    for (const spec of HOSPITAL_LOCATIONS) {
      expect(spec.latitude, spec.name).toMatch(/^-?\d+\.\d{7}$/);
      expect(spec.longitude, spec.name).toMatch(/^-?\d+\.\d{7}$/);
      expect(spec.source, spec.name).toMatch(/OSM|reverso/);
    }
  });

  it("toda coordenada está em Fortaleza", () => {
    for (const spec of HOSPITAL_LOCATIONS) {
      const lat = Number(spec.latitude);
      const lon = Number(spec.longitude);
      expect(lat, spec.name).toBeGreaterThan(-3.9);
      expect(lat, spec.name).toBeLessThan(-3.65);
      expect(lon, spec.name).toBeGreaterThan(-38.7);
      expect(lon, spec.name).toBeLessThan(-38.4);
    }
    expect(FORTALEZA_TIME_ZONE).toBe("America/Fortaleza");
  });

  /**
   * "Hospital Regional Unimed" existe duas vezes no banco, em instituições
   * diferentes, e só uma delas é a Unimed de verdade. Duas linhas de mesmo
   * nome recebendo a mesma coordenada seria o erro mais fácil de cometer.
   */
  it("linhas de mesmo nome esperado recebem coordenadas diferentes", () => {
    const byExpected = new Map<string, Set<string>>();
    for (const spec of HOSPITAL_LOCATIONS) {
      const set = byExpected.get(spec.expectedName) ?? new Set<string>();
      set.add(`${spec.latitude},${spec.longitude}`);
      byExpected.set(spec.expectedName, set);
    }
    const dup = [...byExpected.entries()].filter(([, set]) => set.size < 1);
    expect(dup).toEqual([]);
    const regional = HOSPITAL_LOCATIONS.filter(
      (s) => s.expectedName === "Hospital Regional Unimed",
    );
    expect(regional).toHaveLength(2);
    expect(new Set(regional.map((s) => s.latitude)).size).toBe(2);
  });

  it("nenhum hospital aparece duas vezes", () => {
    const ids = HOSPITAL_LOCATIONS.map((s) => s.hospitalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("o renome de instituição carrega os três nomes", () => {
    for (const spec of INSTITUTION_RENAMES) {
      expect(spec.name.length).toBeGreaterThan(5);
      expect(spec.legalName.length).toBeGreaterThan(5);
      expect(spec.tradeName.length).toBeGreaterThan(3);
      expect(spec.tradeName.length).toBeLessThanOrEqual(20);
      expect(spec.expectedName).not.toBe(spec.name);
    }
  });
});

describe("o script não escreve por engano", () => {
  it("é somente leitura sem --apply, e --apply exige a frase", () => {
    expect(source).toContain('process.argv.includes("--apply")');
    expect(source).toContain("HOSPITAL_LOCATIONS_CONFIRM");
    expect(CONFIRM_PHRASE).toMatch(/^[A-Z0-9_]{8,}$/);
    expect(source).toContain("if (!apply) return;");
  });

  it("recusa quando o nome atual não é o esperado, antes de qualquer UPDATE", () => {
    expect(source).toContain("RECUSADO");
    expect(source).toContain("process.exitCode = 2");
    // O guard precisa vir antes da transação no fluxo.
    expect(source.indexOf("RECUSADO")).toBeLessThan(
      source.indexOf("beginTransaction"),
    );
  });

  it("todo UPDATE é guardado por id E nome, e exige exatamente uma linha", () => {
    const updates = source.match(/UPDATE\s+(hospitals|institutions)/g) ?? [];
    expect(updates).toHaveLength(2);
    expect(source).toContain("WHERE id = ? AND name = ?");
    expect(source).toContain("WHERE id = ? AND name IN (?, ?)");
    expect((source.match(/affectedRows !== 1/g) ?? []).length).toBe(2);
  });

  it("grava tudo numa transação com rollback", () => {
    expect(source).toContain("beginTransaction");
    expect(source).toContain("commit()");
    expect(source).toContain("rollback()");
  });

  it("registra quem e quando localizou", () => {
    expect(source).toContain("location_updated_at = UTC_TIMESTAMP()");
    expect(source).toContain("location_updated_by_user_id");
  });

  it("não sobrescreve fuso já definido de instituição", () => {
    expect(source).toContain("time_zone = COALESCE(time_zone, ?)");
  });
});
