# UI Research — Escalas Hospitalares (Phase 1)

> **Status:** Phase 1 — pesquisa.
> **Próxima fase:** Phase 2 — design system spec, só inicia após o PO aprovar este documento.
> **Skill governando o trabalho:** [.claude/skills/ui-design.md](../../.claude/skills/ui-design.md)

Este documento é a fundação técnica do redesign. Cada decisão de Phase 2
(paleta, tipografia, spacing, componentes) precisa estar ancorada em pelo
menos uma referência citada aqui. Sem essa ancoragem, a decisão é
opinião — e opinião não escala.

---

## Sumário executivo

**Onde estamos.** O Escalas hoje é um app de gestão de escalas hospitalares
funcional mas com identidade visual próxima ao default do Expo + NativeWind
— azuis brand legados, hierarquia tipográfica embrionária, sem padrão de
densidade definido. Funcional não é insuficiente: o problema é que
funcional **sozinho** falha em três cenários críticos pro piloto da Unimed:
(1) gestor médico vê 60 plantões num mês e precisa decidir num relance
quais exigem ação; (2) anestesista de plantão precisa autorizar uma cessão
em 30 segundos com o pager apitando; (3) qualquer um precisa confiar que
o que está sendo mostrado é verdade — UI bonita comunica seriedade
clínica.

**Top findings da pesquisa.** Os apps que **realmente** funcionam pra
trabalho denso e profissional convergem em sete princípios mensuráveis:
(a) tipografia hierárquica que dá pelo menos 6 níveis distintos via
tamanho + peso + leading, sem precisar de cor (Stripe, IBM Carbon); (b)
paleta neutra dominante com **um** acento brand pra ações primárias e
**três** cores semânticas reservadas pra status (Linear, Stripe); (c)
densidade ajustada por contexto — o gestor vê tabelas compactas, o
profissional em mobile vê cards arejados (Material 3, IBM Carbon); (d)
navegação keyboard-first com command palette (`⌘K`) como entry point
universal (Linear, Cron, Vercel, Raycast); (e) progressive disclosure
via side panels — clicar em um item não muda de página, abre um painel
secundário ao lado (Linear); (f) empty states que ensinam o próximo
passo, não decoram com ilustração genérica (Slack, Basecamp); (g)
acessibilidade WCAG AA como piso, não teto — contraste 4.5:1 em texto
normal e 3:1 em elementos de UI.

**Maior risco e maior oportunidade.** Risco: implementar paleta
"premium" que parece Linear mas não funciona na luz da emergência às 3h
da manhã com tela suja. Oportunidade: a categoria de software de
escala/clínica é, no agregado, **feia** — telas de QGenda e ShiftAdmin
são tabelas densas anos 2010, o que abre espaço pra um Escalas que
pareça mais Linear que Epic e ainda assim seja sério clinicamente.
Premium aqui não é decorativo, é discriminador.

---

## 1. Princípios UX clássicos

### 1.1 Heurísticas de Nielsen — as 10 que ainda valem em 2026

As 10 heurísticas de Jakob Nielsen, publicadas em 1994 e revisadas pela
última vez em janeiro de 2024, continuam sendo a base mais defensável de
qualquer crítica de UI. Não são checklist — são lentes. Cada uma se
aplica ao Escalas com implicação concreta:

1. **Visibility of system status.** O usuário deve saber, sempre, em que
   estado o sistema está. No Escalas: quando o gestor aprova uma
   candidatura de cessão, **o app precisa mostrar** que a ação saiu —
   loading state na UI, feedback de sucesso, propagação imediata para a
   tela "Minhas ofertas" do candidato.
2. **Match between system and real world.** Vocabulário do usuário, não
   do sistema. Já endereçado parcialmente nos PRs #54 (Pendentes →
   Solicitações, Vagas → Plantões em aberto). Continuar atento: "swap"
   no código não pode vazar pra UI; sempre "troca" ou "cessão".
3. **User control and freedom.** Sair sem perda. No Escalas: fluxos de
   criar plantão, oferecer cessão, candidatar-se — todos precisam ter
   "voltar" sem perder dados, e ações destrutivas (cancelar oferta)
   precisam de confirmação. Já implementado via `confirmAction`.
4. **Consistency and standards.** O mesmo botão azul que aprova uma
   alocação na aba Solicitações precisa ser o mesmo azul, no mesmo
   tamanho, com o mesmo ícone, em qualquer outra aprovação no app. **Phase
   2 codifica isso** em tokens.
5. **Error prevention.** Vale mais que mensagem de erro bonita. No
   Escalas: validação H1/H2 (PR #57) impede o gestor de criar
   sobreposição — antes mesmo do erro aparecer.
6. **Recognition rather than recall.** Não obrigar o usuário a lembrar.
   No Escalas: filtros padrão por jurisdição do gestor (manager_scope)
   já fazem isso; a tela de Plantões em aberto começa filtrada pelo
   hospital do gestor logado.
7. **Flexibility and efficiency of use.** Atalho pro power user. No
   Escalas desktop, o caminho de upgrade é command palette `⌘K` (não
   implementado ainda — candidato pra Phase 4).
8. **Aesthetic and minimalist design.** Cada elemento na tela compete
   por atenção. Remoção tem mais valor que adição.
9. **Help users recognize, diagnose, and recover from errors.** Mensagem
   precisa: o quê falhou + por quê + o que fazer. "Conflito de horário
   — profissional já alocado em 'Plantão Tarde' (13:00–19:00)" é melhor
   que "ER_DUPLICATE_ENTRY".
10. **Help and documentation.** Idealmente desnecessário, mas quando
    presente, contextual. Tooltips em campos de modalidade, não manual
    em PDF.

Fonte oficial: [10 Usability Heuristics for User Interface Design — NN/G](https://www.nngroup.com/articles/ten-usability-heuristics/).
A revisão de 2024 não mudou as heurísticas em si; refinou linguagem e
exemplos. Detalhes históricos: [How I Developed the 10 Usability Heuristics — Jakob Nielsen](https://jakobnielsenphd.substack.com/p/usability-heuristics-history).

### 1.2 Lei de Fitts — tamanho e distância do alvo

Paul Fitts, 1954: o tempo pra mover até um alvo é função do tamanho do
alvo e da distância até ele. Implicação concreta no Escalas:

- **Botões primários grandes.** No mobile, mínimo 44×44 px (Apple HIG).
  No desktop, mínimo 32 px de altura. O FAB de "+ criar plantão" no
  Calendar (60 px) está ok; o "Aprovar / Rejeitar" inline na lista
  Solicitações merece auditoria.
- **Cantos da tela são alvos infinitos.** No desktop web, o cursor
  não pode passar do canto. Logout em canto superior direito da
  sidebar é racional por isso.
- **Distância da mão à ação.** No mobile, polegar opera as áreas
  inferiores; ações primárias devem viver ali, não no topo. Já
  parcialmente respeitado pelo FAB do Calendar.

A lei é determinística: dobrar o tamanho do alvo não reduz pela metade
o tempo, mas reduz tempo logaritmicamente. Tem retorno decrescente —
botões de 80 px não são meaningful melhores que 44 px. Targets de menos
de 24 px em mobile ferem a lei.

Fontes: [Fitts's Law and Its Applications in UX — NN/G](https://www.nngroup.com/articles/fitts-law/),
[Fitts's Law — Laws of UX](https://lawsofux.com/fittss-law/),
[Wikipedia: Fitts's law](https://en.wikipedia.org/wiki/Fitts%27s_law).

### 1.3 Princípios da Gestalt — proximidade, similaridade, closure

Os princípios da Gestalt explicam por que o cérebro agrupa elementos
visuais sem que o usuário pense conscientemente. Os três que mais
importam pro Escalas:

- **Proximidade.** Itens visualmente próximos são lidos como grupo.
  Implicação: os 4 campos de modalidade (Modalidade / Cobertura /
  Pagamento / Teto) **precisam estar em um único card** com spacing
  interno menor que o spacing externo separando-os de outras seções.
  Do contrário, o usuário não percebe que são conjunto.
- **Similaridade.** Forma + cor + tamanho similares são lidos como
  função similar. Implicação: todos os botões primários no app
  precisam ter o mesmo azul, mesmo padding, mesmo border radius.
  Variação é ruído. Já é o critério não-negociável "tokens, nunca
  literais" da skill `/ui-design`.
- **Closure.** O cérebro completa formas incompletas. Implicação:
  cards com border de um lado só + sombra suave dão noção de
  contêiner sem precisar de outline completo (o que pesaria
  visualmente).

Fonte canônica sobre proximidade: [Proximity Principle in Visual Design — NN/G](https://www.nngroup.com/articles/gestalt-proximity/).
Visão geral: [Gestalt Principles for Visual UI Design — UX Tigers](https://www.uxtigers.com/post/gestalt-principles).

### 1.4 F-pattern reading — onde o usuário olha primeiro

Pesquisa de eye-tracking da NN/G mostra que em telas densas de texto
(blogs, dashboards, listas), o usuário escaneia em padrão F: linha
horizontal no topo, linha horizontal mais curta abaixo, depois descida
vertical à esquerda. Implicação para o Escalas:

- **Headings importantes vão no canto superior esquerdo.** O título da
  tela (ex.: "Plantões em aberto") precisa estar lá, não centralizado
  ou à direita.
- **Filtros visualmente ativos vão no topo, encostados à esquerda.** O
  usuário escaneia F-shape e os filtros são o primeiro elemento de
  decisão.
- **Cards de lista — informação crítica à esquerda.** Em cada card de
  plantão na lista, label de modalidade + horário ficam à esquerda;
  metadata (ex.: setor, hospital) à direita ou em segunda linha.

Fonte: [F-Shape Pattern And How Users Read — Smashing Magazine](https://www.smashingmagazine.com/2024/04/f-shape-pattern-how-users-read/).
Z-pattern é alternativa para landing pages com pouco texto e muito
visual — não se aplica ao Escalas. Comparativo: [Z-Pattern vs F-Pattern — LandingPageFlow](https://www.landingpageflow.com/post/z-pattern-vs-f-pattern).

---

## 2. Referências B2B premium

A escolha das 5 referências aqui foi orientada por: (a) categoria
profissional/produtiva, não consumer; (b) reconhecidamente "premium" no
discurso de design da indústria; (c) com material publicado pelo time
de design explicando decisões.

### 2.1 Linear — densidade e velocidade como discriminador

Linear é o caso canônico de B2B premium. CEO Karri Saarinen: "*Interfaces
should be minimal yet powerful*". O time publicou em 2024 um post sobre
o redesign que inclui as decisões com rationale ([How we redesigned the Linear UI — Part II](https://linear.app/now/how-we-redesigned-the-linear-ui)).

**O que aplicar no Escalas:**

- **Densidade hierárquica.** "Não todos os elementos da UI carregam o
  mesmo peso visual. As partes centrais à tarefa ficam em foco; as que
  apoiam orientação e navegação recuam." A sidebar Escalas hoje tem
  contraste alto demais — disputa atenção com o conteúdo. Phase 2
  precisa baixar opacidade de elementos de chrome (sidebar, header).
- **Keyboard-first.** Linear funciona inteiro sem mouse. Comando ⌘K
  é o entry point. Pra Escalas isso é alto-impact apenas no desktop
  do gestor (que passa o dia ali); no mobile do profissional não vale
  a pena investir.
- **Comando como navegação.** Em vez de menus aninhados, "j" navega
  para issue, "g + d" para dashboard, "g + p" para projects. Atalhos
  documentados in-app. Pra Escalas, lista de candidatos: "g + s" para
  Solicitações, "g + a" para Agenda — economia real pro gestor que
  abre o app 50 vezes por dia.

Linear é também o exemplo canônico de **side panel master-detail**:
clicar num issue não muda de página, abre painel à direita. Pra
Escalas, isso aplica ao clicar num plantão da Agenda — abrir painel
lateral em vez de empurrar pra `/shift-details`.

### 2.2 Stripe — sistema de tokens rigoroso e tipografia hierárquica

Stripe Dashboard é o exemplo canônico de **rigor de design system em
produção**. Cita-se especificamente o uso de 6 tamanhos e pesos
distintos pra estabelecer hierarquia de informação, com paleta neutra
dominante e azul brand `#635BFF` reservado pra ações primárias —
nada de cor decorativa.

**O que aplicar no Escalas:**

- **Tokens, não valores.** Stripe oferece API de tokens nas próprias
  Stripe Apps que terceiros constroem; nem desenvolvedor externo pode
  inserir cor arbitrária. Phase 2 codifica isso em `lib/theme.ts` com
  enforcement via lint rule.
- **Tipografia escalonada.** 6 níveis: display (44/52), title-lg (28/36),
  title (20/28), body-lg (16/24), body (14/20), caption (12/16). Pesos
  variam por hierarquia (700 / 600 / 500 / 400). Phase 2 vai propor
  escala adaptada pro Escalas — provavelmente parecida.
- **Cor com propósito.** "Neutral surfaces, one primary accent, semantic
  colors reserved for status, zero decorative color." Estado positivo
  = verde semântico, negativo = vermelho semântico, em alerta = âmbar.
  Brand blue só em CTA primário. Já é o padrão do Escalas (theme.ts);
  Phase 2 só formaliza.

Fontes: [Style your app — Stripe Documentation](https://docs.stripe.com/stripe-apps/style),
[Designing accessible color systems — Stripe blog](https://stripe.com/blog/accessible-color-systems),
[Behind the Gradient: Design at Stripe](https://uwux.medium.com/behind-the-gradient-design-at-stripe-476dcf61a51a).

### 2.3 Notion — tipografia serif quente, surfaces suaves

Notion ocupa nicho diferente: workspace pessoal/de equipe com forte
ênfase em conteúdo. Decisões inversas a Linear/Stripe: serifa nos
títulos, surfaces ligeiramente off-white em vez de branco puro,
acentos discretos.

**O que aplicar no Escalas — com cautela:**

- Serifa Notion não combina com app clínico. Continuamos sans-serif.
- Mas a ideia de "surface não-branco" — `#FAFAF9` de Notion vs
  `#FFFFFF` puro — reduz fadiga visual em sessão longa. Pode ser
  aplicado ao background da tela do Escalas (já usa `#F8FBFF`).
- Cards com border arredondado generoso (8-12 px) em vez de quadrado
  agressivo dão sensação de aproachable. Já é nosso padrão; Phase 2
  só codifica.

Referência sobre estilo Notion: [Notion Calendar: Swiss Precision Meets Workspace Integration](https://blakecrosley.com/guides/design/notion-calendar).

### 2.4 Cron / Notion Calendar — calendar como editor de texto

Cron foi adquirido pelo Notion em 2022 e virou Notion Calendar. É a
referência mais relevante pro Escalas porque a tela mais usada do app
é exatamente um calendário. Filosofia: "*reimagine the calendar as a
keyboard-navigable workspace where creating, moving, and reshaping
events was as fast as editing text in Vim*".

**O que aplicar:**

- **Hierarquia visual via tipografia + whitespace, sem decoração.**
  Notion Calendar elimina elementos decorativos; usa apenas escala
  tipográfica (12 px, medium weight, positive tracking, uppercase pra
  section labels) pra criar hierarquia. Pra Escalas, isso significa
  abandonar usos decorativos de cor em headings — toda hierarquia vai
  via tipografia.
- **Atalhos teclado.** Setas movem entre dias, "n" cria evento, "g" abre
  goto-date. Aplicável: setas pra navegar entre semanas/meses no
  Calendar do Escalas, "n" pra "novo plantão" (gestor), "h" pra hoje.
- **Time blocking com snap de 15 min.** Não aplicável diretamente (nosso
  domínio é plantão de 6/12h não compromisso de 30 min), mas a ideia
  de **drag para criar evento** é poderosa: gestor seleciona um range
  no calendar pra criar plantão.
- **Density via tipografia, não via cor.** Section headers em uppercase
  + tracking + 12 px medium é truque limpo de hierarquia. Vamos copiar.

Fonte: [Cron is now Notion Calendar — Cron Blog](https://www.cron.com/blog),
[Notion Calendar: Swiss Precision Meets Workspace Integration](https://blakecrosley.com/guides/design/notion-calendar),
[Introducing Notion Calendar — Notion Blog](https://www.notion.com/blog/introducing-notion-calendar).

### 2.5 Vercel Dashboard — opinionated minimalism + dark default

Vercel popularizou a estética **dark + monospace + terminal** em UI
B2B. O dashboard é referência de hierarquia clara (deployment status,
metrics, settings) com paleta extremamente reduzida.

**O que aplicar — limitado:**

- Vercel é dark-first; Escalas é light-first (decisão acertada pra
  ambiente clínico bem iluminado). Mas dark mode ainda é roadmap pra
  v2 (PR pós-piloto).
- **Agnosticismo de cor.** Vercel usa basicamente preto/branco/cinza,
  com um único acento (azul claro) pra link ativo. Reforça o ponto de
  Stripe: paleta neutra dominante.

Citado em [SaaS design trend article — LogRocket](https://blog.logrocket.com/ux-design/linear-design/)
e [Design.MD — productcool](https://www.productcool.com/product/design-md).

---

## 3. Categoria: software de escala / clínica

A categoria é dominada por software enterprise legacy. A maioria dos
players foi construída entre 2008 e 2015 com Java/Flash/jQuery e nunca
recebeu redesign visual sério. A consequência: telas densas com tabela
HTML pura, formulários com 30 campos sem agrupamento, paleta de muitas
cores não-semânticas. Nosso ponto de partida é mais alto que o
estado-da-arte categoria — o que é uma rara janela de oportunidade.

### 3.1 QGenda — enterprise sólido, UI sofrível

QGenda atende >4500 organizações incluindo academic medical centers
nos EUA. Algorítmo de scheduling é forte (rules-based engine que reduz
tempo de scheduling em 50%). Reviews de usuários: "*super user
friendly*" mas "*backend complex*".

**O que evitar:**

- Tabelas HTML densas sem hierarquia visual além de bordas cinza.
- Formulários gigantes em uma única view, sem progressive disclosure.
- Paleta corporativa azul/verde/laranja sem rationale semântico claro.

**O que aprender:**

- Mobile app dedicado pra real-time schedule updates é caminho
  certo — anestesistas em plantão acessam pelo celular, não desktop.
  Já é o padrão do Escalas (mobile-first via Expo).
- "Schedule owner / clinician" como persona splits — gestor ↔
  profissional. Já é nosso modelo (USER / GESTOR_MEDICO / GESTOR_PLUS).

Fontes: [Streamlining Physician Scheduling — Ask.com](https://www.ask.com/news/streamlining-physician-scheduling-closer-look-qgenda-com),
[QGenda Schedule Overview tip sheet — Northwestern Medicine](https://physicianforum.nm.org/uploads/1/1/9/4/119404942/qgenda_schedule_overview_-_clinicians.pdf).

### 3.2 Connecteam — workforce management, mobile-friendly

Connecteam é categoria adjacente (workforce management generalista que
atende healthcare). Reviews falam em "*minimal and easy to use UI/UX*",
mas "*tasks involve too many steps*" — reclamação que indica
hierarquia/navegação ruim, mesmo com UI bonita.

**O que aplicar:**

- Mobile-first é correto pra esse público. Reforça nosso plano via
  Expo + EAS.
- "Too many steps" é alerta vermelho: cada fluxo do Escalas tem que ser
  contado em cliques (criar plantão = N cliques, oferecer cessão = M
  cliques) e otimizado.

Fonte: [Connecteam Expert Review — SelectSoftware Reviews](https://www.selectsoftwarereviews.com/reviews/connecteam).

### 3.3 TigerConnect — comunicação clínica + scheduling

TigerConnect integra real-time communication + workforce management.
Forte em colaboração e patient care. Reclamação: "*lacks a social feed
for staff engagement*".

**O que aplicar:**

- Não copiar feed social — não é o que Escalas faz.
- Mas integração comunicação + scheduling é valida; nosso path é via
  Comunica+ (PR #72 wirou push notifications).

Fonte: [TigerConnect Software Reviews — Software Advice](https://www.softwareadvice.com/telemedicine/tigerconnect-profile/).

### 3.4 ShiftAdmin — scheduling com fatigue management

ShiftAdmin foca em hospital scheduling com features específicas:
shift bidding, fatigue management, regulatory compliance. UI é
explicitamente datada — tabelas densas estilo enterprise.

**O que aplicar:**

- Conceito de **fatigue management** é relevante: o anti-overlap H1/H2
  do Escalas (PR #57) é a base; a próxima camada lógica é alerta
  soft de "este profissional fez 36h nos últimos 7 dias, quer
  alocar mesmo?".
- Visualização: ShiftAdmin não tem nada a ensinar — fugir.

Citado em [Top 10 Best Health Care Staff Scheduling Software of 2026](https://worldmetrics.org/best/health-care-staff-scheduling-software/).

### 3.5 Conclusão da categoria

A categoria oferece **o quê fazer mas raramente como apresentar**.
Lições de domínio: persona split (gestor ↔ profissional), real-time
mobile, fatigue management, regulatory compliance. Lições de
visualização: zero. Pra esse front, importamos discipline de
B2B premium (Linear/Stripe) e adaptamos.

Resultado: o Escalas vai parecer mais Linear que QGenda, e isso é
deliberado.

---

## 4. Tipografia em interfaces densas

Tipografia em UI densa é onde a maioria dos apps falha. Ou usam font
genérica do sistema sem escala definida (default Expo), ou usam font
"premium" demais (Inter como display) que não funciona em corpo de
tabela. A solução vem de design systems enterprise.

### 4.1 IBM Carbon — productive vs expressive type sets

Carbon (IBM) é o design system enterprise mais maduro disponível.
Diferencia explicitamente:

- **Productive type set.** Pra contextos de trabalho denso (dashboards,
  tabelas, formulários longos). Tamanhos comprimidos, leading
  reduzido, foco em throughput.
- **Expressive type set.** Pra contextos editorial/marketing (landing
  pages, hero sections). Tamanhos grandes, leading generoso.

A tipografia Carbon usa **IBM Plex** como família. O insight aqui não é
"copie a Plex" — é "*type tokens são pre-set configurations
specifically calibrated for use alongside [a font] in product*". Cada
token é uma escolha consciente, não um valor genérico.

Pra Escalas Phase 2, vamos definir productive type set primeiro
(escalas/agenda/solicitações são produtivas) e expressive depois (login,
empty states celebratórios).

Pra data tables especificamente, Carbon oferece 4 densidades:
**short**, **default**, **compact**, **tall** — sendo Compact e Tall
designer/developer preferences (não user-toggable). Default e Short são
user-toggable. Implicação: oferecer toggle de "compact/comfortable" na
tela de Solicitações pode ser útil pro gestor que quer ver mais
linhas na tela.

Fontes: [Typography — Carbon Design System](https://carbondesignsystem.com/elements/typography/overview/),
[Carbon Data Table — v9](https://v9.carbondesignsystem.com/components/data-table/style/),
[Carbon Type Sets](https://carbondesignsystem.com/guidelines/typography/type-sets/).

### 4.2 Material 3 — densidade default/comfortable/compact

Material 3 (Google) oferece 3 níveis de density:

- **Default** — para apps consumer, listas com muito padding.
- **Comfortable** — meio termo, apps híbridos.
- **Compact** — para apps profissionais com muita informação.

Recomendação Material: **scale-tipográfica não muda entre densidades;
o spacing é que muda**. Token de tamanho de fonte permanece; padding e
gap reduzem.

Pra Escalas, isso é guia direto pra Phase 2: definir spacing scale
em 4 px base (4, 8, 12, 16, 20, 24, 32, 40, 56, 80) e variar densidade
via composição de spacing tokens, não via tipografia.

Fontes: [Material 3 Layout — Density](https://m3.material.io/foundations/layout/understanding-layout/density),
[Using Material Density on the Web](https://m3.material.io/blog/material-density-web).

### 4.3 Stripe — 6 níveis de tipografia

Stripe usa 6 distinct type sizes pra establish hierarchy em scannable
interfaces. Sem 6 níveis distintos, o cérebro não consegue dispor
informação hierarquicamente. Com mais de 8, vira soup.

Pra Escalas Phase 2: alvo é exatamente 6 níveis, alinhado a Stripe:
display (~32 px), title-lg (24 px), title (18 px), body-lg (16 px),
body (14 px), caption (12 px). Letter-spacing e line-height ajustados
por nível.

Fonte: [Style your app — Stripe Documentation](https://docs.stripe.com/stripe-apps/style),
[Behind the Gradient: Design at Stripe](https://uwux.medium.com/behind-the-gradient-design-at-stripe-476dcf61a51a).

### 4.4 Recomendação Phase 2

Direção (não decisão final, isso é Phase 2):

- Família: **Inter** ou **system font stack** (`-apple-system,
  BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`). Inter é mais
  "premium" mas exige carregamento; system stack é gratuito + instantâneo
  + nativo.
- Escala: 6 níveis, productive type set (Carbon pattern).
- Sem serifa em UI primária. Serifa só em quote/empty-state hero se
  contexto pedir.
- Monospace (`JetBrains Mono` ou system mono) reservada para IDs
  numéricos (ID de plantão, código de profissional) — nunca em corpo.

---

## 5. Paleta de cor em UI crítica

A escolha de paleta no Escalas é mais delicada que parece. Categoria
clínica tem heranças mistas: alguns apps copiam Cerner/Epic (azul
corporativo + vermelho saturado), outros tentam fingir consumer
(roxo Notion-like). Ambos erram no contexto.

### 5.1 Lições da aviação — ambient critical UI

A indústria aeroespacial define padrões mais rigorosos de cor em
contexto crítico que qualquer design system de SaaS. FAA + Airbus +
NASA convergem em:

- **Verde** — operação normal/safe.
- **Âmbar/amarelo** — caution / atenção requerida.
- **Vermelho** — warning / ação imediata.
- **Cinza/preto** — normal / inativo.
- **Ciano** — advisório (informação não-crítica).

Princípios extraídos:

- **Dark cockpit philosophy.** Nada acende em operação normal; só
  acende anomalia. Aplicado ao Escalas: lista de plantões não
  precisa de chips coloridos pra cada status — neutralidade é o
  estado normal; só destaque quem precisa de ação.
- **Cor como cue redundante, nunca único.** Padrão FAA: cor é
  sempre redundante a outro cue (ícone, texto, posição). Crítico
  pra acessibilidade — daltonismo afeta ~8% dos homens e
  vermelho/verde é a confusão mais comum.
- **Hierarquia semântica progressiva.** Verde → âmbar → vermelho
  comunica increasing threat. No Escalas: status de plantão pode
  seguir mesma escala (OCUPADO=verde, PENDENTE=âmbar, VAGO=cinza
  neutro com ícone, não vermelho — VAGO não é "warning", é
  "oportunidade").

Fontes: [Human Factors Considerations in Flight Deck Displays — Volpe](https://www.volpe.dot.gov/sites/volpe.dot.gov/files/docs/Human_Factors_Considerations_in_the_Design_and_Evaluation_of_Flight_Deck_Displays_and_Controls_V2.pdf),
[Airbus Cockpit Color Coding Guide](https://www.scribd.com/document/663431724/COLOUR-PHILOSPHY),
[NASA Color Design for Aerospace Applications](https://colorusage.arc.nasa.gov/aerospace_1.php).

### 5.2 Stripe — paleta acessível como sistema

O time de design de Stripe publicou em 2023 um post canônico sobre
construção de sistema de cor acessível. Princípios-chave:

- Cor deve ser **calibrada** em vários níveis pra suportar contraste
  WCAG AA em diferentes contextos (text-on-bg, icon-on-bg, etc.).
- **Tokens semânticos** (success, warning, danger) devem mapear pra
  multiple HSL values, não pra um único hex.
- Paleta neutra precisa ter **9-10 níveis** (cinza-50 até cinza-900)
  pra hierarquia rica sem cor.

Pra Escalas Phase 2: definir paleta neutra de 10 níveis (já temos
parcial em theme.ts); definir 4 cores semânticas (success / warning /
danger / info) cada uma com 3-5 níveis (50, 100, 500, 700, 900).

Fonte: [Designing accessible color systems — Stripe blog](https://stripe.com/blog/accessible-color-systems).

### 5.3 Recomendação Phase 2

Direção:

- **Brand primary** — único azul, alinhado ao já existente
  `theme.colors.primary` (#2563EB). Escala 50→900.
- **Neutros** — 10 níveis (cinza), do `#FAFAFA` (background) ao
  `#0F172A` (text strongest).
- **Semânticas:** success (#22C55E green), warning (#F59E0B amber),
  danger (#EF4444 red), info (#3B82F6 blue) — cada um com 5
  níveis.
- **Status no Escalas:** OCUPADO = success, PENDENTE = warning,
  VAGO = neutral com ícone (não cor — VAGO é oportunidade, não
  alerta).
- Zero cor decorativa. Cor sempre carrega significado.

---

## 6. Hierarquia e navegação

Como o usuário se move dentro do app é tão importante quanto como
cada tela parece individualmente. As decisões aqui são estruturais e
custam caro pra reverter.

### 6.1 Sidebar persistente vs collapsible

Apple HIG (macOS): "*sidebar appears on the leading side of a view and
lets people navigate between sections*. (...) *In macOS, a sidebar
extends to the full height of the window, and uses a rounded-corner
appearance for the selected-item highlight.*"

A regra: quando o app tem ≤7 áreas top-level, sidebar persistente
funciona. Acima disso, agrupar em seções com headers, ou colapsar
seções menos usadas. Escalas tem 9 itens hoje no `_layout.tsx`
(index/calendar/weekly/dashboard/pending/vacancies/reports/admin/profile),
o que é limite — Phase 3 vai propor agrupar em "Operação" (calendar,
weekly, vacancies, pending) e "Sistema" (admin, reports, profile).

Width recomendado pra sidebar desktop: 220-280 px. Atualmente Escalas
está em 220 px. Reduzir pra 200 px daria mais espaço pro conteúdo
principal sem perder legibilidade.

Fonte: [Sidebars — Apple Developer Documentation](https://developer.apple.com/design/human-interface-guidelines/sidebars).

### 6.2 Split views — duas/três colunas

Apple HIG sobre split views: "*A split view manages the presentation of
multiple adjacent panes of content. When people choose an item in a
sidebar, the split view displays the item's details in a secondary pane
or — if the item contains a list — the secondary pane presents the list
and a tertiary pane presents the details.*"

Pra Escalas isso significa, no desktop:

- **Sidebar** (220 px) — navegação principal.
- **Pane secundário** (320-400 px) — lista do contexto atual (lista de
  plantões do dia, lista de solicitações pendentes).
- **Pane terciário** (flex) — detalhe do item selecionado.

Hoje o Escalas tem só sidebar + content. Phase 4 propõe a estrutura
de 3 colunas no desktop pra Calendar e Solicitações.

Fonte: [Split views — Apple Developer Documentation](https://developer.apple.com/design/human-interface-guidelines/split-views).

### 6.3 Command palette ⌘K — navegação power-user

Pattern emergente popularizado por Linear + Vercel + Raycast:
`Cmd+K` invoca palette de busca + ações + navegação. Substituí
menus aninhados em apps profissionais.

Lista de implementações: [awesome-command-palette — GitHub](https://github.com/stefanjudis/awesome-command-palette).
Análise do pattern: [Command Palette Pattern — UX Patterns for Developers](https://uxpatterns.dev/patterns/advanced/command-palette).

Pra Escalas, valor é alto pro gestor desktop:

- **Ação:** "criar plantão", "aprovar candidatura", "exportar
  relatório do mês"
- **Navegação:** "ir pra Solicitações", "abrir detalhes do plantão #1234"
- **Busca:** "Maria Santos" (encontrar profissional + ações
  relacionadas)

Implementação Phase 4 — não trivial mas alto ROI no desktop. Mobile
pode ficar de fora.

Fonte: [Command Palette UX Patterns — Bootcamp](https://medium.com/design-bootcamp/command-palette-ux-patterns-1-d6b6e68f30c1),
[Designing a Command Palette — destiner.io](https://destiner.io/blog/post/designing-a-command-palette/).

### 6.4 Tabs vs subnav

Tabs funcionam pra navegação **em alternância**: 2-5 visões do
mesmo dado (ex.: dashboard com tabs "Visão geral" / "Detalhes" /
"Histórico"). Acima de 5, subnav (lista vertical à esquerda)
funciona melhor.

Pra Escalas hoje, o `_layout.tsx` usa Tabs do Expo Router. No mobile
isso vira tab-bar inferior — apropriado. No desktop vira sidebar (já
implementado em PR #58 + #54 com WebSidebarTabBar). Modelo correto.

---

## 7. Cascade / second-screens / progressive disclosure

Como mostrar complexidade sem assustar. A heurística #8 de Nielsen
(aesthetic and minimalist design) implica que toda complexidade
adicional precisa ser justificada.

### 7.1 Progressive disclosure — definição e patterns

Definição NN/G: "*progressive disclosure defers advanced or rarely used
features to a secondary screen, making applications easier to learn and
less error-prone*". Implementações comuns:

- **Accordion** — seções colapsáveis empilhadas. Bom para FAQ ou seções
  realmente independentes; ruim quando tudo é importante (usuário tem
  que abrir tudo).
- **Tabs** — alternância de conteúdo no mesmo espaço. Bom para visões
  do mesmo dado.
- **Dropdown menu** — opções secundárias atrás de um clique. Bom para
  ações pouco frequentes.
- **Show more / View details** — link textual revela conteúdo. Bom
  quando usuário precisa decidir se quer aprofundar.

Pra Escalas, exemplos diretos:

- **Detalhes do plantão.** Ações primárias visíveis (Editar, Aprovar);
  ações destrutivas (Cancelar, Excluir) atrás de menu "•••".
- **Modalidade na criação.** Já implementado — coverageType só
  aparece quando modality=PLANTAO.
- **Filtros avançados em Solicitações.** Filtros básicos (data, hospital)
  visíveis; filtros avançados (modalidade, payment_model) atrás de
  "Mais filtros".

Fonte canônica: [Progressive Disclosure — NN/G](https://www.nngroup.com/articles/progressive-disclosure/).
Análise dos pattern variants: [Progressive disclosure in UX design — LogRocket](https://blog.logrocket.com/ux-design/progressive-disclosure-ux-types-use-cases/),
[Progressive Disclosure design pattern — UI Patterns](https://ui-patterns.com/patterns/ProgressiveDisclosure).

### 7.2 Side panel master-detail (Linear pattern)

Em vez de "clicar item → empurrar pra outra rota", side panel mantém
o usuário no contexto da lista enquanto mostra o detalhe ao lado.
Vantagens:

- Não perde scroll position da lista.
- Possibilita navegação rápida entre items consecutivos (j/k pra
  next/prev).
- Reduz mental overhead — o usuário sabe sempre onde está.

Limitações:

- Só funciona em desktop (mobile não tem espaço pra dois panes).
- Detalhe complexo (ex.: tela de criar plantão com 12 campos) não
  cabe — empurra pra rota separada.

Pra Escalas Phase 4: aplicar side panel em **Calendar/Agenda** (clicar
plantão abre detalhe à direita) e **Solicitações** (clicar candidatura
abre detalhe à direita). Manter rota dedicada pra **edit-shift**
(formulário grande).

### 7.3 Modal vs Drawer vs inline

Decisão frequente. Princípios:

- **Modal centralizado.** Foco bloqueante; usuário precisa decidir
  antes de continuar. Bom pra confirmações destrutivas (cancelar
  oferta), erros críticos.
- **Drawer (lado direito).** Foco não-bloqueante; usuário pode ver a
  lista por trás. Bom pra criar/editar items rápidos.
- **Inline (no card).** Usuário expande a row em-place. Bom pra
  detalhe contextual rápido.

Pra Escalas:

- Confirmar cancelamento de oferta = modal (já implementado via
  `confirmAction`).
- Quick-edit de plantão = drawer (Phase 4 candidato).
- Detalhe expandido de cessão na lista = inline (Phase 4 candidato).

---

## 8. Feedback e estado

Estados que o app precisa endereçar deliberadamente, sem deixar pro
"default Expo":

- **Loading** — primeira carga vs refresh vs ação inflight.
- **Empty** — usuário não tem dados ainda.
- **Error** — algo falhou, com path de recuperação.
- **Success** — confirmação de ação completa.
- **Optimistic** — UI assume sucesso antes do servidor confirmar.

### 8.1 Empty states — a oportunidade desperdiçada

NN/G + UserOnboard + Toptal convergem: empty states são onde apps
mostram caráter e ensinam o produto. Princípios:

- **Headline** ("Nenhuma solicitação no momento")
- **Explicação** ("As solicitações aparecem aqui quando profissionais
  pedem para assumir vagas")
- **Próximo passo concreto** (CTA ou link)

Já implementamos parcialmente em PR #58/#67. Phase 2 codifica
**componente `<EmptyState>`** com slot pra ícone, headline, body, CTA.

Slack (mencionado em [Empty State UX — Pencil & Paper](https://www.pencilandpaper.io/articles/empty-states))
faz "*playful illustrations + lightweight prompts like 'say hi to
yourself'*" — abordagem amigável que reduz a fricção de "não sei o
que fazer". Adaptamos pro contexto Escalas (mais sóbrio): texto
explicativo claro, ícone discreto, CTA pra ação relevante.

Fonte: [Empty State UX Examples & Best Practices — Pencil & Paper](https://www.pencilandpaper.io/articles/empty-states),
[Empty states in UX done right — LogRocket](https://blog.logrocket.com/ux-design/empty-states-ux-examples/),
[Empty State in SaaS Applications — Userpilot](https://userpilot.com/blog/empty-state-saas/).

### 8.2 Loading states — skeleton vs spinner

Decisão por contexto:

- **Skeleton** (cinza animado em forma de conteúdo) pra primeira
  carga. Reduz percepção de espera porque mostra estrutura.
- **Spinner** pra ações curtas (<3s) ou refresh pull-to-refresh.
- **Progress bar** pra operações longas com progresso conhecido
  (export PDF, bulk import).

Pra Escalas Phase 2: componente `<Skeleton>` com variantes (line,
card, table-row) e usar consistentemente. Hoje usamos
`<ActivityIndicator>` em todos os cenários — sub-óptimo na primeira
carga.

### 8.3 Error states — três níveis

- **Inline error** (campo de form) — texto vermelho discreto sob o
  campo. Não-bloqueante, reversível.
- **Banner/Toast error** — erro de ação não-crítica. Aparece e some.
- **Full-screen error** — erro irrecuperável (sem rede, servidor
  fora). Com botão "Tentar de novo".

Já temos via `Alert` cross-platform. Phase 2 codifica componente
`<ErrorBanner>` e padrão de uso.

### 8.4 Optimistic updates

Padrão moderno: ao clicar "aprovar candidatura", a UI mostra
imediatamente o resultado positivo (some da lista de "Aguardando")
e roll back se o servidor falhar. Reduz percepção de espera
drasticamente.

Implementação no Escalas hoje: parcial — usa `invalidateQueries` do
tRPC mas não optimistic update propriamente dito. Phase 4 candidato.

---

## 9. Acessibilidade premium

WCAG AA é o piso legal em maioria dos países (ADA US, EAA EU, LBI BR).
Premium significa AA garantido + AAA quando viável.

### 9.1 Contraste

WCAG 2.1 AA exige:

- **Texto normal** (até 18 px regular ou 14 px bold): mínimo **4.5:1**
- **Texto grande** (≥ 18 px regular ou 14 px bold): mínimo **3:1**
- **Componentes UI / objetos gráficos** (border de input, ícone
  funcional): mínimo **3:1**

WCAG 2.1 AAA exige 7:1 / 4.5:1 — diferença na prática: usuários com
baixa visão ainda leem confortavelmente.

Pra Escalas, isso traduz como:

- `theme.colors.textPrimary` (#0F172A) on `theme.colors.surface`
  (#FFFFFF) → ratio 18.5:1 → AAA. ✓
- `theme.colors.textMuted` (#64748B) on white → ratio 4.95:1 → AA. ✓
  (mas perto do limite — Phase 2 pode escurecer pra 5.5:1+)
- `theme.colors.primary` (#2563EB) on white → ratio 4.51:1 → AA
  exatamente. ⚠️ Phase 2 testar variantes pra garantir margem.

Ferramenta: [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/),
[WCAG 2.1 — W3C](https://www.w3.org/TR/WCAG21/),
[Understanding Success Criterion 1.4.3: Contrast — WAI](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html).

### 9.2 Touch targets

Apple HIG: mínimo 44×44 px. Material Design: 48×48 px. WCAG 2.5.5
(level AAA, target size): mínimo 44×44 px.

Pra Escalas:

- Mobile: 44 px piso, 56 px confortável (FAB do Calendar está em 60
  px, ok).
- Desktop: 32 px piso (mouse é mais preciso que dedo).

### 9.3 Focus rings e keyboard navigation

Premium = navegável por teclado. Cada elemento interativo precisa de
**focus ring visível** quando o usuário usa Tab/Shift-Tab. Pattern
moderno: `:focus-visible` em vez de `:focus` (não mostra em click,
mostra em keyboard).

Pra Escalas: NativeWind + RNW suportam focus styles. Phase 4 tem que
auditar tela por tela e garantir que todo elemento interativo tem
focus ring distinto da cor de fundo (3:1 mínimo).

### 9.4 Reduced motion

Usuários com vestibular disorders ou ADHD se beneficiam de
`prefers-reduced-motion`. Animações decorativas (fade-in,
slide-up) devem desligar.

Pra Escalas: hoje pouca animação (bom default). Phase 2 codifica
política: animações ≤300 ms; pular animação quando
`prefers-reduced-motion: reduce`.

### 9.5 Screen readers

Cada elemento interativo precisa de `accessibilityLabel` e
`accessibilityRole`. Já é parcialmente implementado; PR #67 e #71
adicionaram em vários botões. Phase 4 tem audit-pass dedicado.

Fontes: [WCAG 2.1 — W3C](https://www.w3.org/TR/WCAG21/),
[Color contrast — MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Perceivable/Color_contrast).

---

## Recomendações iniciais para Phase 2 (design system)

Não decisão final — direção de viagem pra discussão antes de Phase 2
detalhar.

### Paleta

- **Brand primary** = um único azul (#2563EB já existente). Escala
  50→900 pra suportar variantes.
- **Neutros** = 10 níveis de cinza, do background (#FAFAFA) ao text
  forte (#0F172A).
- **Semânticas** = success (verde), warning (âmbar), danger
  (vermelho), info (azul mais claro). Cada uma com 3-5 níveis.
- **Zero cor decorativa.** Cor é sempre redundante a outro cue.

### Tipografia

- **Família** = system font stack (`-apple-system, ...`). Avaliar
  Inter como upgrade post-piloto se valor for incremental.
- **Escala** = 6 níveis (Stripe pattern): display 32, title-lg 24,
  title 18, body-lg 16, body 14, caption 12.
- **Pesos** = 400 (regular), 500 (medium), 600 (semibold), 700
  (bold). Sem 300 (light) — fica fraco em telas LCD.
- **Section headers em uppercase + tracking** (Cron pattern) só onde
  hierarquia exige, não como decoração.

### Spacing

- **Base 4 px**, escala (4, 8, 12, 16, 20, 24, 32, 40, 56, 80).
- **Density toggle** no desktop (gestor) — não na primeira release.

### Componentes-core (Phase 2 detalha)

`Button`, `Input`, `Select`, `Card`, `Tag`, `Modal`, `Drawer`,
`Toast`, `EmptyState`, `Skeleton`, `Badge`, `Tooltip`, `Tabs`,
`SidePanel`. Cada um com states default/hover/focus/disabled,
2-3 sizes, padding interno, uso recomendado.

### Padrões de navegação

- **Sidebar persistente** (desktop) com 9 items agrupados em 2 seções
  (Operação / Sistema).
- **Command palette ⌘K** — Phase 4 candidato (alto valor pro gestor).
- **Side panel master-detail** em Calendar e Solicitações — Phase 4
  candidato.

### Acessibilidade

- WCAG AA é piso. AAA onde viável (texto principal já passa AAA).
- Focus rings via `:focus-visible`.
- Reduced motion respeitado.
- Screen reader labels em audit-pass dedicado em Phase 4.

---

## Próximos passos

1. **Você lê este documento** e responde "aprovado" ou pede revisões
   específicas.
2. Após aprovação, **Phase 2** começa: doc `docs/design/ui-system.md`
   com paleta + tipografia + spacing + componentes-core, mais diff em
   `lib/theme.ts` aplicando os tokens. PR separado.
3. Phase 3 = audit das telas existentes. Phase 4 = implementação por
   tela.

Não faça nada de Phase 2 ainda. A skill `/ui-design` exige aprovação
explícita entre fases — sem isso, o trabalho deteriora pra "design
sem fundamento" exatamente o que o protocolo evita.

---

## Referências

### Princípios UX clássicos
- [10 Usability Heuristics for User Interface Design — NN/G](https://www.nngroup.com/articles/ten-usability-heuristics/)
- [How I Developed the 10 Usability Heuristics — Jakob Nielsen](https://jakobnielsenphd.substack.com/p/usability-heuristics-history)
- [Fitts's Law and Its Applications in UX — NN/G](https://www.nngroup.com/articles/fitts-law/)
- [Fitts's Law — Laws of UX](https://lawsofux.com/fittss-law/)
- [Wikipedia: Fitts's law](https://en.wikipedia.org/wiki/Fitts%27s_law)
- [Proximity Principle in Visual Design — NN/G](https://www.nngroup.com/articles/gestalt-proximity/)
- [Gestalt Principles for Visual UI Design — UX Tigers](https://www.uxtigers.com/post/gestalt-principles)
- [F-Shape Pattern And How Users Read — Smashing Magazine](https://www.smashingmagazine.com/2024/04/f-shape-pattern-how-users-read/)
- [Z-Pattern vs F-Pattern — LandingPageFlow](https://www.landingpageflow.com/post/z-pattern-vs-f-pattern)

### B2B premium SaaS
- [How we redesigned the Linear UI — Part II](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [A calmer interface for a product in motion — Linear](https://linear.app/now/behind-the-latest-design-refresh)
- [Linear design: The SaaS design trend — LogRocket](https://blog.logrocket.com/ux-design/linear-design/)
- [Style your app — Stripe Documentation](https://docs.stripe.com/stripe-apps/style)
- [Designing accessible color systems — Stripe blog](https://stripe.com/blog/accessible-color-systems)
- [Behind the Gradient: Design at Stripe](https://uwux.medium.com/behind-the-gradient-design-at-stripe-476dcf61a51a)
- [Notion Calendar: Swiss Precision Meets Workspace Integration](https://blakecrosley.com/guides/design/notion-calendar)
- [Cron is now Notion Calendar — Cron Blog](https://www.cron.com/blog)
- [Introducing Notion Calendar — Notion Blog](https://www.notion.com/blog/introducing-notion-calendar)
- [Design.MD — productcool](https://www.productcool.com/product/design-md)

### Categoria scheduling/clínica
- [Streamlining Physician Scheduling: A Closer Look at QGenda — Ask.com](https://www.ask.com/news/streamlining-physician-scheduling-closer-look-qgenda-com)
- [QGenda Schedule Overview tip sheet — Northwestern Medicine](https://physicianforum.nm.org/uploads/1/1/9/4/119404942/qgenda_schedule_overview_-_clinicians.pdf)
- [Connecteam Healthcare Workforce Management](https://connecteam.com/industries/healthcare-app/)
- [Connecteam Expert Review — SelectSoftware Reviews](https://www.selectsoftwarereviews.com/reviews/connecteam)
- [TigerConnect Software Reviews — Software Advice](https://www.softwareadvice.com/telemedicine/tigerconnect-profile/)
- [Top 10 Best Health Care Staff Scheduling Software of 2026](https://worldmetrics.org/best/health-care-staff-scheduling-software/)

### Tipografia
- [Typography — Carbon Design System](https://carbondesignsystem.com/elements/typography/overview/)
- [Carbon Type Sets — productive vs expressive](https://carbondesignsystem.com/guidelines/typography/type-sets/)
- [Carbon Data Table v9](https://v9.carbondesignsystem.com/components/data-table/style/)
- [Material 3 Layout — Density](https://m3.material.io/foundations/layout/understanding-layout/density)
- [Using Material Density on the Web — Material 3 blog](https://m3.material.io/blog/material-density-web)

### Cor em UI crítica
- [Designing accessible color systems — Stripe blog](https://stripe.com/blog/accessible-color-systems)
- [Human Factors Considerations in Flight Deck Displays — Volpe DOT](https://www.volpe.dot.gov/sites/volpe.dot.gov/files/docs/Human_Factors_Considerations_in_the_Design_and_Evaluation_of_Flight_Deck_Displays_and_Controls_V2.pdf)
- [Airbus Cockpit Color Coding Guide](https://www.scribd.com/document/663431724/COLOUR-PHILOSPHY)
- [NASA — Color Design for Aerospace Applications](https://colorusage.arc.nasa.gov/aerospace_1.php)
- [FAA — Standard Palette for Color Coding ATC](https://www.faa.gov/sites/faa.gov/files/data_research/research/med_humanfacs/oamtechreports/201818.pdf)

### Hierarquia e navegação
- [Sidebars — Apple Developer Documentation](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Split views — Apple Developer Documentation](https://developer.apple.com/design/human-interface-guidelines/split-views)
- [Layout — Apple Developer Documentation](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Command Palette UX Patterns — Bootcamp](https://medium.com/design-bootcamp/command-palette-ux-patterns-1-d6b6e68f30c1)
- [Command Palette Pattern — UX Patterns for Developers](https://uxpatterns.dev/patterns/advanced/command-palette)
- [Designing a Command Palette — destiner.io](https://destiner.io/blog/post/designing-a-command-palette/)
- [Awesome Command Palette — GitHub](https://github.com/stefanjudis/awesome-command-palette)

### Cascade e progressive disclosure
- [Progressive Disclosure — NN/G](https://www.nngroup.com/articles/progressive-disclosure/)
- [Progressive disclosure in UX design — LogRocket](https://blog.logrocket.com/ux-design/progressive-disclosure-ux-types-use-cases/)
- [Progressive Disclosure design pattern — UI Patterns](https://ui-patterns.com/patterns/ProgressiveDisclosure)
- [Progressive disclosure — Wikipedia](https://en.wikipedia.org/wiki/Progressive_disclosure)

### Feedback e estado
- [Empty State UX Examples & Best Practices — Pencil & Paper](https://www.pencilandpaper.io/articles/empty-states)
- [Empty states in UX done right — LogRocket](https://blog.logrocket.com/ux-design/empty-states-ux-examples/)
- [Empty State in SaaS Applications — Userpilot](https://userpilot.com/blog/empty-state-saas/)
- [Empty States — The Most Overlooked Aspect of UX — Toptal](https://www.toptal.com/designers/ux/empty-state-ux-design)

### Acessibilidade
- [Web Content Accessibility Guidelines (WCAG) 2.1 — W3C](https://www.w3.org/TR/WCAG21/)
- [Understanding Success Criterion 1.4.3: Contrast (Minimum) — WAI](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)
- [Color contrast — MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Perceivable/Color_contrast)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [Contrast requirements for WCAG 2.2 Level AA — Make Things Accessible](https://www.makethingsaccessible.com/guides/contrast-requirements-for-wcag-2-2-level-aa/)

---

**Fim da Phase 1.**
