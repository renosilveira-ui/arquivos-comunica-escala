import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  brToIso,
  isoToBr,
  isValidTimeHHMM,
  maskBrDate,
  maskTimeHHMM,
} from "../lib/form-masks-br";

describe("form-masks-br", () => {
  it("converte nos dois sentidos", () => {
    expect(isoToBr("2026-09-12")).toBe("12/09/2026");
    expect(brToIso("12/09/2026")).toBe("2026-09-12");
  });

  it("a ida e volta preserva a data", () => {
    for (const iso of ["2026-01-01", "2026-02-28", "2026-12-31", "2024-02-29"]) {
      expect(brToIso(isoToBr(iso)), iso).toBe(iso);
    }
  });

  it("recusa data que não existe em vez de adivinhar", () => {
    // 31/02 viraria 03/03 num parse permissivo. Num compromisso de consultório,
    // remarcar sozinho para outro dia é pior do que não aceitar.
    expect(brToIso("31/02/2026")).toBe("");
    expect(brToIso("30/02/2026")).toBe("");
    expect(brToIso("31/04/2026")).toBe("");
    expect(brToIso("29/02/2026")).toBe(""); // 2026 não é bissexto
    expect(brToIso("29/02/2024")).toBe("2024-02-29"); // 2024 é
  });

  it("recusa entrada incompleta ou mal formada", () => {
    for (const value of ["", "12", "12/09", "12/09/26", "2026-09-12", "ab/cd/efgh"]) {
      expect(brToIso(value), value).toBe("");
    }
    expect(isoToBr("")).toBe("");
    expect(isoToBr("12/09/2026")).toBe("");
  });

  it("a máscara aceita o meio da digitação", () => {
    // Um campo que recusa estado incompleto é um campo que não deixa digitar.
    expect(maskBrDate("1")).toBe("1");
    expect(maskBrDate("12")).toBe("12");
    expect(maskBrDate("120")).toBe("12/0");
    expect(maskBrDate("1209")).toBe("12/09");
    expect(maskBrDate("120920")).toBe("12/09/20");
    expect(maskBrDate("12092026")).toBe("12/09/2026");
  });

  it("a máscara ignora o que não é dígito e não passa de oito", () => {
    expect(maskBrDate("12/09/2026")).toBe("12/09/2026");
    expect(maskBrDate("12a09b2026")).toBe("12/09/2026");
    expect(maskBrDate("120920261234")).toBe("12/09/2026");
  });
});

describe("hora HH:MM", () => {
  it("a máscara aceita o meio da digitação", () => {
    expect(maskTimeHHMM("0")).toBe("0");
    expect(maskTimeHHMM("08")).toBe("08");
    expect(maskTimeHHMM("083")).toBe("08:3");
    expect(maskTimeHHMM("0830")).toBe("08:30");
    expect(maskTimeHHMM("08:30")).toBe("08:30");
    expect(maskTimeHHMM("08h30m99")).toBe("08:30");
  });

  it("recusa hora que não existe no relógio", () => {
    expect(isValidTimeHHMM("25:00")).toBe(false);
    expect(isValidTimeHHMM("24:00")).toBe(false);
    expect(isValidTimeHHMM("08:70")).toBe(false);
    expect(isValidTimeHHMM("8:00")).toBe(false);
    expect(isValidTimeHHMM("08:3")).toBe(false);
    expect(isValidTimeHHMM("")).toBe(false);
  });

  it("aceita as bordas do dia", () => {
    for (const time of ["00:00", "08:30", "13:00", "19:00", "23:59"]) {
      expect(isValidTimeHHMM(time), time).toBe(true);
    }
  });

  it("o que a tela aceita, o servidor aceita", () => {
    // Amarra os dois padrões. Se o domínio apertar a regra do horário civil,
    // este teste cai antes de alguém descobrir pelo erro 400 no aparelho.
    const domain = readFileSync("server/personal-calendar-domain.ts", "utf8");
    const declared = /const TIME_KEY_PATTERN = \/(.+?)\/;/.exec(domain);
    expect(declared, "TIME_KEY_PATTERN não encontrado").not.toBeNull();
    const server = new RegExp(declared![1]);

    for (let hour = 0; hour < 24; hour += 1) {
      for (const minute of [0, 7, 30, 59]) {
        const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        expect(isValidTimeHHMM(time), time).toBe(true);
        expect(server.test(time), `servidor recusaria ${time}`).toBe(true);
      }
    }
  });

  it("o que a máscara completa, a validação aceita", () => {
    // As duas funções precisam concordar: máscara que produz algo que a
    // validação recusa é campo que nunca deixa salvar.
    expect(isValidTimeHHMM(maskTimeHHMM("0830"))).toBe(true);
    expect(isValidTimeHHMM(maskTimeHHMM("2359"))).toBe(true);
    // E o que o relógio não tem continua recusado mesmo completo.
    expect(isValidTimeHHMM(maskTimeHHMM("2500"))).toBe(false);
  });
});

describe("a ponte com a tela de compromisso", () => {
  const screen = readFileSync("app/personal-event.tsx", "utf8");

  it("o campo re-sincroniza quando o valor chega de fora", () => {
    // Editar um compromisso salvo hidrata o estado DEPOIS da montagem: a
    // query resolve e `startDate` muda de defaultDay para a data do item.
    // Sem este efeito, o campo continuaria mostrando a data de hoje enquanto
    // o estado já guardava outra — a tela mentiria sobre o que vai salvar.
    const component = screen.slice(
      screen.indexOf("function DateFieldBR"),
      screen.indexOf("function Chip"),
    );
    expect(component).toContain("useEffect");
    expect(component).toMatch(/setText\(isoToBr\(value\)\)/);
    expect(component).toMatch(/\}, \[value\]\)/);
  });

  it("a hidratação alimenta o mesmo estado que o campo recebe", () => {
    // startLocalDate vem do servidor como date key (AAAA-MM-DD, validado por
    // dateKeySchema). É exatamente o que isoToBr aceita.
    expect(screen).toContain("setStartDate(String(item.startLocalDate");
    expect(screen).toMatch(/value=\{startDate\}/);
    expect(screen).toMatch(/onChange=\{setStartDate\}/);
  });

  it("data incompleta zera o estado em vez de manter a anterior", () => {
    // Antes desta guarda o campo mostrava "12/09/202" e o Salvar gravava a
    // data de ANTES, calado. O texto cru ia para o servidor e ele recusava —
    // a camada de parse trocou falha barulhenta por silenciosa.
    const component = screen.slice(
      screen.indexOf("function DateFieldBR"),
      screen.indexOf("function Chip"),
    );
    expect(component).toMatch(/onChange\(brToIso\(masked\)\)/);
    expect(component).not.toContain("if (iso)");

    // E o submit precisa barrar o vazio, com mensagem.
    expect(screen).toContain("Informe a data de início no formato DD/MM/AAAA.");
    expect(screen).toContain("Informe a data de término no formato DD/MM/AAAA.");
  });

  it("a hora tem o mesmo contrato da data", () => {
    // O campo de hora era texto livre: "8:0" ia ao servidor para ser recusado
    // lá, depois do toque em Salvar. Agora falha antes, na tela.
    const component = screen.slice(
      screen.indexOf("function TimeFieldBR"),
      screen.indexOf("function Chip"),
    );
    expect(component).toMatch(/onChange\(isValidTimeHHMM\(masked\) \? masked : ""\)/);
    expect(component).toMatch(/\}, \[value\]\)/);
    expect(screen).toContain("Informe a hora de início no formato HH:MM.");
    expect(screen).toContain("Informe a hora de término no formato HH:MM.");
    // E o campo antigo de texto livre não pode voltar.
    expect(screen).not.toMatch(/onChangeText=\{setStartTime\}/);
    expect(screen).not.toMatch(/onChangeText=\{setEndTime\}/);
  });

  it("isoToBr aceita o formato que o servidor manda", () => {
    // Se o domínio trocar o formato do date key, esta asserção cai junto.
    for (const dateKey of ["2026-01-01", "2026-09-12", "2026-12-31"]) {
      expect(isoToBr(dateKey), dateKey).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    }
  });
});
