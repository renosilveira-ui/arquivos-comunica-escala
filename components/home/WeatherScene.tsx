import { Image, type ImageSourcePropType } from "react-native";

import type { WeatherScene as SceneId } from "@/lib/weather-scene";

/**
 * A cena de clima que ilustra a saudação.
 *
 * ## Por que um mapa literal, e não caminho montado em runtime
 *
 * O `require` de imagem é resolvido em tempo de BUILD pelo Metro — ele precisa
 * ver a string inteira no código para empacotar o arquivo. `require(
 * \`@/assets/weather/${'${cena}'}.png\`)` compila, roda em dev e quebra no binário.
 * Por isso as quatorze entradas estão escritas à mão, e por isso
 * `tests/weather-scene.test.ts` confere que este mapa cobre todas as cenas
 * alcançáveis: uma cena sem entrada aqui vira quadrado vazio no topo do app.
 *
 * ## Por que PNG e não SVG
 *
 * A arte depende de `feTurbulence`, que o `react-native-svg` não implementa.
 * Ver `assets/weather/source/scenes.mjs`.
 */
// O tipo declarado pelo próprio React Native para a prop, em vez de
// `ReturnType<typeof require>`.
//
// Aquele dependia de qual declaração de `require` o TypeScript encontrasse
// primeiro: com a do Node vira `any` e passa; com uma resolução mais
// estrita vira `unknown`, que não entra em `source`, e `typecheck:app`
// reprova. O comportamento do app é o mesmo nos dois casos — o que muda é
// se o erro aparece na sua máquina ou não.
const SOURCES: Record<SceneId, ImageSourcePropType> = {
  limpo: require("@/assets/weather/limpo.png"),
  amanhecer: require("@/assets/weather/amanhecer.png"),
  entardecer: require("@/assets/weather/entardecer.png"),
  nublado: require("@/assets/weather/nublado.png"),
  chuva: require("@/assets/weather/chuva.png"),
  tempestade: require("@/assets/weather/tempestade.png"),
  neblina: require("@/assets/weather/neblina.png"),
  frio: require("@/assets/weather/frio.png"),
  "n-limpo": require("@/assets/weather/n-limpo.png"),
  "n-nublado": require("@/assets/weather/n-nublado.png"),
  "n-chuva": require("@/assets/weather/n-chuva.png"),
  "n-tempestade": require("@/assets/weather/n-tempestade.png"),
  "n-neblina": require("@/assets/weather/n-neblina.png"),
  "n-frio": require("@/assets/weather/n-frio.png"),
};

export function WeatherScene({
  scene,
  size = 44,
}: {
  scene: SceneId;
  size?: number;
}) {
  return (
    <Image
      source={SOURCES[scene]}
      style={{ width: size, height: size }}
      resizeMode="contain"
      // Decorativa: a condição já está escrita ao lado, em texto. Anunciar
      // "imagem de chuva" logo antes de "chuva" só faz o leitor de tela
      // repetir a mesma informação.
      accessibilityElementsHidden
      importantForAccessibility="no"
      // Sem isto o Smart Invert do iOS inverteria a arte e o céu noturno
      // viraria um disco branco.
      accessibilityIgnoresInvertColors
    />
  );
}
