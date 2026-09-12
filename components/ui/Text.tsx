import { useMemo } from "react";
import {
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputProps as RNTextInputProps,
  type TextProps as RNTextProps,
  type TextStyle,
} from "react-native";

import { interFamilyFor } from "@/lib/typography";

/**
 * O `<Text>` do produto. Toda tela importa daqui, nunca de "react-native".
 *
 * ## Por que envolver, em vez de repetir a fonte em 900 lugares
 *
 * Não existe fonte padrão global no React Native: cada `<Text>` herda a do
 * sistema, a menos que alguém diga o contrário. Espalhar `fontFamily` pelas
 * ~900 ocorrências do app seria um diff enorme, impossível de revisar e que
 * quebraria no primeiro `<Text>` novo que alguém escrevesse esquecendo dela.
 *
 * Aqui o esquecimento é impossível: quem importa `Text` já recebe a fonte.
 * Um teste de guarda impede a volta do import direto do react-native.
 *
 * ## Por que o peso decide a família
 *
 * `fontFamily` no nativo é UMA fonte. O aparelho não engorda a regular para
 * fazer negrito — no Android ele devolve a regular e o título fica igual ao
 * corpo. Então lemos o `fontWeight` que a folha de estilo pediu e
 * escolhemos o arquivo certo. As telas seguem escrevendo `fontWeight: "700"`
 * como sempre; nada muda para quem usa.
 *
 * Estilo explícito ganha: quem passar `fontFamily` na mão (o numeral tabular
 * de `theme.fontFamily.mono`, por exemplo) continua mandando.
 */

/**
 * Achata o estilo para ler o peso final.
 *
 * Escrito à mão, sem `StyleSheet.flatten`, de propósito. Vários testes de
 * tela trocam o "react-native" por um mock enxuto, e um import de
 * `StyleSheet` quebra esses testes no carregamento do módulo — em frentes
 * que nada têm a ver com tipografia. No React Native atual,
 * `StyleSheet.create` devolve os próprios objetos, então achatar array e
 * objeto cobre tudo o que as telas usam.
 */
function flattenStyle(style: unknown): TextStyle {
  if (!style) return {};
  if (Array.isArray(style)) {
    return style.reduce<TextStyle>(
      (acc, item) => Object.assign(acc, flattenStyle(item)),
      {},
    );
  }
  return typeof style === "object" ? (style as TextStyle) : {};
}

function withInter(style: RNTextProps["style"]): TextStyle[] {
  const flat = flattenStyle(style);
  if (flat.fontFamily) return [flat];
  return [{ fontFamily: interFamilyFor(flat.fontWeight) }, flat];
}

/**
 * Sem `forwardRef`: no React 19 o `ref` é uma prop comum de componente de
 * função. Evitá-lo também mantém este módulo fora do caminho dos testes que
 * substituem o "react" por um mock enxuto — um import de `forwardRef`
 * quebraria esses testes no carregamento, em frentes sem relação com fonte.
 */
export type TextProps = RNTextProps & {
  ref?: React.Ref<RNText>;
};

export function Text({ style, ...rest }: TextProps) {
  const styles = useMemo(() => withInter(style), [style]);
  return <RNText style={styles} {...rest} />;
}

export type TextInputProps = RNTextInputProps & {
  ref?: React.Ref<RNTextInput>;
};

export function TextInput({ style, ...rest }: TextInputProps) {
  const styles = useMemo(
    () => withInter(style as RNTextProps["style"]),
    [style],
  );
  return <RNTextInput style={styles} {...rest} />;
}
