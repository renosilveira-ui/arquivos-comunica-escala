/**
 * Máscaras dos campos digitados do formulário, na convenção brasileira:
 * data em DD/MM/AAAA e hora em 24 h.
 *
 * O campo mostra `DD/MM/AAAA` porque é assim que se escreve data no Brasil —
 * `AAAA-MM-DD` num formulário de consultório faz a pessoa parar para pensar,
 * e quem digita "12/09" num campo que espera "2026-09" erra calado.
 *
 * O ESTADO continua ISO de propósito. O formulário compara datas como texto
 * (`endDate > startDate`), o que só é correto porque ISO ordena
 * lexicograficamente. Guardar `DD/MM/AAAA` quebraria essa comparação sem
 * levantar erro: "01/12/2026" é menor que "02/01/2026" como string.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const BR = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** "2026-09-12" → "12/09/2026". Entrada inválida devolve string vazia. */
export function isoToBr(iso: string): string {
  const match = ISO.exec((iso ?? "").trim());
  if (!match) return "";
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/**
 * "12/09/2026" → "2026-09-12". Devolve "" enquanto a data não estiver
 * completa ou for impossível — 31/02 não vira 03/03, porque adivinhar o que a
 * pessoa quis dizer numa data de compromisso é pior do que não aceitar.
 */
export function brToIso(br: string): string {
  const match = BR.exec((br ?? "").trim());
  if (!match) return "";
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return "";
  // Meio-dia evita que fuso empurre o dia; a volta confirma que a data existe.
  const roundTrip =
    `${parsed.getFullYear()}-` +
    `${String(parsed.getMonth() + 1).padStart(2, "0")}-` +
    `${String(parsed.getDate()).padStart(2, "0")}`;
  return roundTrip === iso ? iso : "";
}

/**
 * Máscara progressiva: a pessoa digita só números e as barras aparecem.
 *
 * Precisa aceitar estado incompleto — "12/0" existe enquanto ela digita, e um
 * campo que recusa o meio da digitação é um campo que não deixa digitar.
 */
export function maskBrDate(input: string): string {
  const digits = (input ?? "").replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/**
 * Hora em HH:MM, relógio de 24 h.
 *
 * Diferente da data, não há conversão: o servidor já fala HH:MM
 * (`TIME_KEY_PATTERN`). O que faltava era máscara e validação — o campo era
 * texto livre, e "8:0" chegava ao servidor para ser recusado lá.
 */
export function maskTimeHHMM(input: string): string {
  const digits = (input ?? "").replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

/** Hora completa e possível. 25:00 e 08:70 não existem e não passam. */
export function isValidTimeHHMM(text: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test((text ?? "").trim());
}
