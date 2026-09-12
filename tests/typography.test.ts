import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  INTER_FAMILIES,
  interFamilyFor,
} from "../lib/typography";

/**
 * A tipografia do produto: o mapa de pesos e a guarda que impede o vazamento.
 *
 * O risco que estes testes trancam não é estético. No React Native
 * `fontFamily` é UMA fonte instalada: o aparelho não engorda a regular para
 * fazer negrito. Um peso sem arquivo carregado volta para a fonte do
 * sistema — e a tela passa a ter duas tipografias sem erro nenhum.
 */

describe("peso vira família", () => {
  it("cada peso usado pelo app tem arquivo próprio", () => {
    expect(interFamilyFor(400)).toBe("Inter_400Regular");
    expect(interFamilyFor(500)).toBe("Inter_500Medium");
    expect(interFamilyFor(600)).toBe("Inter_600SemiBold");
    expect(interFamilyFor(700)).toBe("Inter_700Bold");
    expect(interFamilyFor(800)).toBe("Inter_800ExtraBold");
  });

  it("aceita o peso como texto, que é como as telas escrevem", () => {
    expect(interFamilyFor("600")).toBe("Inter_600SemiBold");
    expect(interFamilyFor("700")).toBe("Inter_700Bold");
  });

  it("as palavras da web valem o que valem na web", () => {
    expect(interFamilyFor("bold")).toBe("Inter_700Bold");
    expect(interFamilyFor("normal")).toBe("Inter_400Regular");
  });

  it("sem peso declarado, texto corrido", () => {
    expect(interFamilyFor(undefined)).toBe("Inter_400Regular");
    expect(interFamilyFor(null)).toBe("Inter_400Regular");
  });

  /**
   * Peso sem arquivo cai no vizinho, NUNCA em nada. Devolver indefinido aqui
   * seria devolver a tela para a fonte do sistema.
   */
  it("peso sem arquivo cai no vizinho mais próximo, nunca fora da família", () => {
    expect(interFamilyFor(300)).toBe("Inter_400Regular");
    expect(interFamilyFor(900)).toBe("Inter_800ExtraBold");
    expect(interFamilyFor(650)).toBe("Inter_700Bold");
    expect(interFamilyFor("lixo")).toBe("Inter_400Regular");

    const conhecidas = new Set<string>(Object.values(INTER_FAMILIES));
    for (const peso of [100, 250, 333, 450, 550, 750, 1000]) {
      expect(conhecidas.has(interFamilyFor(peso)), String(peso)).toBe(true);
    }
  });
});

describe("guarda: ninguém importa Text direto do react-native", () => {
  const RAIZ = join(__dirname, "..");
  const PERMITIDO = "components/ui/Text.tsx";

  /**
   * Lê a árvore com o próprio Node, de propósito.
   *
   * A primeira versão desta guarda chamava `git grep -E` com `\\s` e `\\b` no
   * padrão. O ERE do git não conhece nenhum dos dois: a busca nunca casava,
   * o teste passava sempre e a guarda não guardava nada. Foi pego plantando
   * uma violação de propósito. Aqui o motor é o do JavaScript, o mesmo em
   * qualquer máquina e na CI.
   */
  function arquivosDoApp(dir: string, saida: string[] = []): string[] {
    for (const entrada of readdirSync(join(RAIZ, dir), {
      withFileTypes: true,
    })) {
      const relativo = `${dir}/${entrada.name}`;
      if (entrada.isDirectory()) {
        if (entrada.name === "node_modules" || entrada.name.startsWith("."))
          continue;
        arquivosDoApp(relativo, saida);
      } else if (/\.tsx?$/.test(entrada.name)) {
        saida.push(relativo);
      }
    }
    return saida;
  }

  const IMPORT_DIRETO =
    /import\s*\{([^}]*)\}\s*from\s*["']react-native["']/g;

  function importaTextDoReactNative(fonte: string): boolean {
    for (const achado of fonte.matchAll(IMPORT_DIRETO)) {
      const nomes = achado[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      if (nomes.some((n) => n === "Text" || n === "TextInput")) return true;
    }
    return false;
  }

  /**
   * O `<Text>` do react-native não tem a fonte do produto. Um import direto
   * numa tela nova devolve aquele trecho à fonte do sistema, sem erro, sem
   * aviso e sem nada na tela que denuncie — a mesma classe de defeito que
   * esta troca veio resolver.
   */
  it("app/, components/ e hooks/ importam Text e TextInput de components/ui/Text", () => {
    const infratores = ["app", "components", "hooks"]
      .flatMap((raiz) => arquivosDoApp(raiz))
      .filter((caminho) => caminho !== PERMITIDO)
      .filter((caminho) =>
        importaTextDoReactNative(readFileSync(join(RAIZ, caminho), "utf8")),
      );

    expect(
      infratores,
      "Importe { Text } de '@/components/ui/Text'. O Text do react-native " +
        "não carrega a fonte do produto e deixa o trecho na fonte do sistema.",
    ).toEqual([]);
  });

  it("a própria guarda reconhece uma violação", () => {
    expect(
      importaTextDoReactNative('import { Text } from "react-native";'),
    ).toBe(true);
    expect(
      importaTextDoReactNative('import { View, TextInput } from "react-native";'),
    ).toBe(true);
    // Não pode confundir nome parecido com o nome exato.
    expect(
      importaTextDoReactNative('import { TextProps, View } from "react-native";'),
    ).toBe(false);
    expect(
      importaTextDoReactNative('import { Text } from "@/components/ui/Text";'),
    ).toBe(false);
  });

  it("o componente de texto do produto aplica a família pelo peso", () => {
    const fonte = readFileSync(join(RAIZ, "components/ui/Text.tsx"), "utf8");
    expect(fonte).toMatch(/interFamilyFor/);
    // Estilo explícito da tela tem de continuar ganhando (numeral tabular).
    expect(fonte).toMatch(/flat\.fontFamily/);
  });
});
