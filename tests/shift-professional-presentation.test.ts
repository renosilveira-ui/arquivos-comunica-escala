import { describe, expect, it } from "vitest";

import { shiftProfessionalNameLines } from "../lib/shift-professional-presentation";

describe("apresentação da equipe de um plantão", () => {
  it("preserva todos os profissionais em linhas independentes", () => {
    expect(
      shiftProfessionalNameLines(
        {
          professionalNames: [
            "Germana Medeiros Mendes",
            "Viviany Gurgel de Aquino",
          ],
          isMine: false,
        },
        "Sem profissional",
      ),
    ).toEqual(["Germana Medeiros Mendes", "Viviany Gurgel de Aquino"]);
  });

  it("mantém a indicação Você no plantão individual próprio", () => {
    expect(
      shiftProfessionalNameLines(
        { professionalNames: ["Nome da pessoa"], isMine: true },
        "Sem profissional",
      ),
    ).toEqual(["Você"]);
  });

  it("usa a apresentação vazia definida pela superfície", () => {
    expect(
      shiftProfessionalNameLines(
        { professionalNames: [], isMine: false },
        "Sem profissional",
      ),
    ).toEqual(["Sem profissional"]);
  });
});
