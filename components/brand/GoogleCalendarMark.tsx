import Svg, { Path, Rect, Text as SvgText } from "react-native-svg";

/**
 * Marca do Google Agenda, para a linha que oferece o vínculo.
 *
 * ## Por que um desenho e não um PNG
 *
 * A linha aparece em tamanhos diferentes (Perfil hoje, possivelmente uma
 * tela de integrações depois) e em tema claro e escuro. Vetor não borra e
 * não precisa de três densidades de bitmap no bundle.
 *
 * ## Por que a marca, e não um ícone genérico de calendário
 *
 * A linha pede uma decisão de confiança: o médico vai autorizar um terceiro
 * a ler e escrever na agenda dele. Um ícone genérico não diz QUAL terceiro.
 * A marca do produto é o que torna a escolha informada — é o mesmo motivo
 * pelo qual o Google exige a própria marca nos botões de "Entrar com Google".
 *
 * Uso nominativo: identifica o serviço ao qual o Escala+ se conecta. Não
 * sugere endosso do Google, não aparece em material de divulgação e não é
 * misturado à identidade do Escala+.
 */

const GOOGLE_BLUE = "#4285F4";
const GOOGLE_RED = "#EA4335";
const GOOGLE_YELLOW = "#FBBC04";
const GOOGLE_GREEN = "#34A853";

export function GoogleCalendarMark({ size = 24 }: { size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      // A marca é decorativa: quem lê a linha já ouve "Google Agenda" no
      // título. Anunciar o logotipo de novo seria repetição no leitor de tela.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* Folha branca. Fica embaixo da moldura para o miolo não vazar cor. */}
      <Rect x={4} y={4} width={16} height={16} rx={2} fill="#FFFFFF" />

      {/* Moldura em quatro quartos, na ordem do logotipo: azul no canto
          superior esquerdo, vermelho no superior direito, amarelo no
          inferior direito, verde no inferior esquerdo. */}
      <Path d="M2 12V5a3 3 0 0 1 3-3h7v4H6v6H2z" fill={GOOGLE_BLUE} />
      <Path d="M12 2h7a3 3 0 0 1 3 3v7h-4V6h-6V2z" fill={GOOGLE_RED} />
      <Path d="M22 12v7a3 3 0 0 1-3 3h-7v-4h6v-6h4z" fill={GOOGLE_YELLOW} />
      <Path d="M12 22H5a3 3 0 0 1-3-3v-7h4v6h6v4z" fill={GOOGLE_GREEN} />

      {/* O 31 do logotipo. Em tamanho pequeno vira uma mancha azul no centro,
          que é exatamente como a marca é reconhecida na barra de um app. */}
      <SvgText
        x={12}
        y={15.5}
        fontSize={9}
        fontWeight="700"
        fill={GOOGLE_BLUE}
        textAnchor="middle"
      >
        31
      </SvgText>
    </Svg>
  );
}
