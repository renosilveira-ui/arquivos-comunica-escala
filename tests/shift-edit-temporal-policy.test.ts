import { describe, expect, it } from "vitest";
import {
  assertMaterialShiftEditIsFuture,
  MATERIAL_SHIFT_EDIT_PAST_MESSAGE,
} from "../server/shift-edit-temporal-policy";

const NOW = new Date("2027-05-07T15:00:00.000Z");
const FUTURE = new Date("2027-05-07T16:00:00.000Z");
const LATER = new Date("2027-05-07T17:00:00.000Z");
const PAST = new Date("2027-05-07T14:00:00.000Z");

describe("política temporal de edição material do turno", () => {
  it("permite alterar horário ou modalidade quando o ciclo original e o destino ainda são futuros", () => {
    expect(() =>
      assertMaterialShiftEditIsFuture({
        materialChanged: true,
        originalStartAt: FUTURE,
        effectiveStartAt: LATER,
        now: NOW,
      }),
    ).not.toThrow();
  });

  it.each([
    ["início original no passado", PAST, FUTURE],
    ["início original exatamente agora", NOW, FUTURE],
    ["novo início no passado", FUTURE, PAST],
    ["novo início exatamente agora", FUTURE, NOW],
    ["início original inválido", new Date(Number.NaN), FUTURE],
    ["novo início inválido", FUTURE, new Date(Number.NaN)],
  ])("bloqueia mudança material com %s", (_case, originalStartAt, effectiveStartAt) => {
    expect(() =>
      assertMaterialShiftEditIsFuture({
        materialChanged: true,
        originalStartAt,
        effectiveStartAt,
        now: NOW,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "CONFLICT",
        message: MATERIAL_SHIFT_EDIT_PAST_MESSAGE,
      }),
    );
  });

  it("falha fechado se o relógio de decisão for inválido", () => {
    expect(() =>
      assertMaterialShiftEditIsFuture({
        materialChanged: true,
        originalStartAt: FUTURE,
        effectiveStartAt: LATER,
        now: new Date(Number.NaN),
      }),
    ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it.each([
    ["capacidade", PAST, PAST],
    ["metadados administrativos", NOW, NOW],
  ])("preserva edição não material após o início: %s", (_case, originalStartAt, effectiveStartAt) => {
    expect(() =>
      assertMaterialShiftEditIsFuture({
        materialChanged: false,
        originalStartAt,
        effectiveStartAt,
        now: NOW,
      }),
    ).not.toThrow();
  });
});
