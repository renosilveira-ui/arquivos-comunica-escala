import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guarda: tela de formulário ou de conteúdo longo precisa rolar.
 *
 * ## Por que este teste existe
 *
 * `ScreenContainer` só vira página rolável com `scrollPage`; `ScreenGradient`
 * só com `scrollable`. Sem nenhum dos dois, os dois componentes devolvem uma
 * `View` comum — o conteúdo que passa da altura da tela simplesmente não é
 * alcançável, sem erro, sem aviso e sem nada na tela que denuncie.
 *
 * O defeito é invisível para quem desenvolve (simulador grande, fonte
 * padrão) e total para quem usa (iPhone menor, fonte do sistema aumentada,
 * teclado aberto). Foi relatado em "Novo compromisso" e, na mesma leva, já
 * tinha voltado numa tela recém-criada. Bug que reaparece sozinho é bug que
 * precisa de guarda, não de mais uma correção.
 *
 * ## O que exatamente é exigido
 *
 * Só o RENDER PRINCIPAL — o último `<ScreenGradient` do arquivo. Os ramos de
 * carregamento (esqueleto) e de erro (`QueryErrorState`) têm altura fixa e
 * pequena; exigir rolagem deles seria ruído.
 *
 * Vale qualquer uma das formas de rolar que o projeto usa: `ScreenGradient
 * scrollable`, `ScreenContainer scrollPage`, ou uma `ScrollView`/`FlatList`
 * própria (é o que `app/change-password.tsx` faz).
 */

const REPO_ROOT = join(__dirname, "..");

/**
 * Telas cujo conteúdo cresce: formulário, lista, ou texto explicativo que
 * acompanha uma decisão. Ao criar uma tela assim, acrescente-a aqui.
 */
const SCREENS_THAT_MUST_SCROLL = [
  "app/personal-event.tsx",
  "app/personal-calendar.tsx",
  "app/google-calendar.tsx",
  "app/departure-alerts.tsx",
  "app/confirmation-policy.tsx",
  "app/change-password.tsx",
  "app/whatsapp-contact.tsx",
  "app/join-schedule.tsx",
  "app/schedule-invites.tsx",
];

function mainRenderIsScrollable(source: string): boolean {
  // Rolagem própria vale para o arquivo inteiro (padrão do change-password).
  if (/<ScrollView[\s>]/.test(source) || /<FlatList[\s>]/.test(source)) {
    return true;
  }
  if (/scrollPage/.test(source)) return true;

  // Caso contrário, o último <ScreenGradient do arquivo — o render principal,
  // que vem depois dos ramos de carregamento e de erro — precisa de
  // `scrollable`. A prop pode estar na mesma linha ou nas seguintes, quando
  // o elemento é multilinha.
  const last = source.lastIndexOf("<ScreenGradient");
  if (last === -1) return false;
  const openTagEnd = source.indexOf(">", last);
  const openTag = source.slice(last, openTagEnd === -1 ? undefined : openTagEnd);
  return /\bscrollable\b/.test(openTag);
}

describe("telas que precisam rolar", () => {
  for (const relativePath of SCREENS_THAT_MUST_SCROLL) {
    it(`${relativePath} rola no render principal`, () => {
      const source = readFileSync(join(REPO_ROOT, relativePath), "utf8");
      expect(
        mainRenderIsScrollable(source),
        `${relativePath}: o render principal não rola. Use <ScreenGradient scrollable>, ` +
          "<ScreenContainer scrollPage> ou uma ScrollView própria. Sem isso, em tela " +
          "menor ou com fonte aumentada o final do conteúdo fica inalcançável.",
      ).toBe(true);
    });
  }

  it("a guarda pega uma tela sem rolagem", () => {
    const semRolagem = `
      export default function Tela() {
        if (isLoading) return (<ScreenGradient scrollable><Skeleton /></ScreenGradient>);
        return (<ScreenGradient><ScreenContainer><View /></ScreenContainer></ScreenGradient>);
      }`;
    expect(mainRenderIsScrollable(semRolagem)).toBe(false);
  });

  it("a guarda aceita o elemento multilinha com a prop na linha de baixo", () => {
    const multilinha = `
      return (
        <ScreenGradient
          scrollable
          refreshControl={<RefreshControl />}
        >
          <ScreenContainer><View /></ScreenContainer>
        </ScreenGradient>
      );`;
    expect(mainRenderIsScrollable(multilinha)).toBe(true);
  });
});
