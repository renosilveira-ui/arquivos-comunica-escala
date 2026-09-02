# UI Design System — Escalas Hospitalares (Phase 2)

> **Status:** Phase 2 — design system spec.
> **Pré-requisito:** [Phase 1 research](./ui-research.md) (PR #76) aprovado.
> **Próxima fase:** Phase 3 — audit das telas existentes vs este spec.
> **Skill governando o trabalho:** [.claude/skills/ui-design.md](../../.claude/skills/ui-design.md)

Este documento é o **contrato visual** do app. Cada token aqui tem
contraparte em [lib/theme.ts](../../lib/theme.ts). Cada decisão tem
referência citada na pesquisa de Phase 1. A regra é: **se um valor
literal aparece num arquivo `app/`, é violação deste spec** (vai virar
finding de Phase 3).

---

## Sumário

- [1. Paleta](#1-paleta)
- [2. Tipografia](#2-tipografia)
- [3. Spacing](#3-spacing)
- [4. Border radius](#4-border-radius)
- [5. Shadows](#5-shadows)
- [6. Componentes-core](#6-componentes-core)
- [7. Estados padronizados](#7-estados-padronizados)
- [8. Dark mode roadmap](#8-dark-mode-roadmap)
- [Apêndice A — Migração de tokens legados](#apêndice-a--migração-de-tokens-legados)

---

## 1. Paleta

Princípios extraídos de Phase 1 §2.2 (Stripe), §5.1 (aviation) e §5.2
(Stripe accessible colors):

- **Paleta neutra dominante.** Cinza é a cor padrão da UI; cor brand e
  semântica são exceções.
- **Um único brand primary.** Reservado para ações primárias e
  selected-states.
- **4 semânticas com 5 níveis cada.** Status (success / warning /
  danger / info), redundantes a outro cue (ícone, texto, posição) por
  WCAG 1.4.1.
- **Zero cor decorativa.** Cor sempre carrega significado.

### 1.1 Neutros — escala de cinza (10 níveis)

A escala forma a base visual. Texto, surfaces, borders — tudo
ancorado aqui.

| Token | Hex | Uso |
|---|---|---|
| `neutral.0` | `#FFFFFF` | Surface canvas (cards). |
| `neutral.50` | `#F8FAFC` | Background da tela. Cinza-on-white quase imperceptível, evita fadiga LCD. |
| `neutral.100` | `#F1F5F9` | Surface alternativo (chip não-selecionado, panel). |
| `neutral.200` | `#E2E8F0` | Border default. Limite de contraste 1.32:1 — só funciona como divisor visual, não como container. |
| `neutral.300` | `#CBD5E1` | Border hover, divider mais forte. |
| `neutral.400` | `#94A3B8` | Texto desabilitado, ícone decorativo. |
| `neutral.500` | `#64748B` | Texto muted (caption, helper). Contraste 4.95:1 on white — passa AA. |
| `neutral.600` | `#475569` | Texto secundário (body). Contraste 7.5:1 — AAA. |
| `neutral.700` | `#334155` | Texto forte (subtítulo). Contraste 11.5:1 — AAA. |
| `neutral.800` | `#1E293B` | Texto display. |
| `neutral.900` | `#0F172A` | Texto primário (headings, body forte). Contraste 18.5:1 — AAA. |

**Por que 10 níveis e não 6.** Stripe Phase 1 §5.2 — "*paleta neutra
precisa ter 9-10 níveis pra hierarquia rica sem cor*". Menos que isso,
ou hierarchy fica anêmica ou cada level acaba carregando trabalho de
mais.

### 1.2 Brand primary — azul Escalas

Único acento brand. Reservado para CTAs primários, selected-states,
links em corpo de texto.

| Token | Hex | Uso |
|---|---|---|
| `primary.50` | `#EFF6FF` | Background ultra-tênue (mention/highlight). |
| `primary.100` | `#DBEAFE` | Border primary, background tinted (chip "Aguardando aprovação"). |
| `primary.200` | `#BFDBFE` | Hover sobre primary.100. |
| `primary.500` | `#3B82F6` | Estado interativo (hover do CTA, link). |
| `primary.600` | `#2563EB` | **Default brand.** CTA primário, selected-state. Contraste 4.51:1 on white — AA. |
| `primary.700` | `#1D4ED8` | Pressed/active CTA. Contraste 6.4:1 — AAA. |
| `primary.900` | `#1E3A8A` | Reserva (cabeçalhos sobre primary.50). |

**Justificativa do hex.** `#2563EB` (Tailwind blue-600) é o brand já
estabelecido; manter por continuidade. Família escalonada extraída do
gerador da Tailwind ajustado para WCAG.

### 1.3 Semânticas — status

Cada uma com 5 níveis (50/100/500/700/900). Princípios de
[Phase 1 §5.1](./ui-research.md#51-lições-da-aviação--ambient-critical-ui):
verde safe / âmbar caution / vermelho warning. Sempre redundantes a
outro cue.

#### Success — operação positiva concluída

| Token | Hex | Uso |
|---|---|---|
| `success.50` | `#F0FDF4` | Background tinted (toast positivo). |
| `success.100` | `#DCFCE7` | Border de tag, background de chip "OCUPADO". |
| `success.500` | `#22C55E` | Ícone success. **Default.** |
| `success.700` | `#15803D` | Texto "Confirmada", contraste 4.7:1 — AA. |
| `success.900` | `#14532D` | Reserva (não usar em texto pequeno). |

#### Warning — atenção requerida, ação possível

| Token | Hex | Uso |
|---|---|---|
| `warning.50` | `#FFFBEB` | Background tinted. |
| `warning.100` | `#FEF3C7` | Border, background de chip "PENDENTE". |
| `warning.500` | `#F59E0B` | Ícone warning. **Default.** |
| `warning.700` | `#B45309` | Texto "Aguardando", contraste 4.85:1 — AA. |
| `warning.900` | `#78350F` | Reserva. |

#### Danger — ação irreversível, erro crítico

| Token | Hex | Uso |
|---|---|---|
| `danger.50` | `#FEF2F2` | Background tinted (error banner). |
| `danger.100` | `#FEE2E2` | Border, background de chip de exceção. |
| `danger.500` | `#EF4444` | Ícone danger, border de input com erro. |
| `danger.600` | `#DC2626` | **Default texto.** Contraste 4.6:1 — AA. |
| `danger.900` | `#7F1D1D` | Reserva. |

> **Decisão:** "VAGO" **não** é danger. É oportunidade. Render como
> neutral.100 com ícone discreto, não como vermelho. Phase 1 §5.1
> sustenta — vermelho deve ser reservado para warning de ação imediata
> (cancelamento, exclusão), não para "slot disponível". Mudança em
> relação ao mapeamento legado do Escalas (`statusVago: "#EF4444"`).

#### Info — informacional

| Token | Hex | Uso |
|---|---|---|
| `info.50` | `#EFF6FF` | (alias de primary.50 no piloto; pode divergir post-piloto) |
| `info.500` | `#3B82F6` | Ícone info. |
| `info.700` | `#1D4ED8` | Texto info. |

### 1.4 Mapeamento por papel semântico

Estes são os tokens que o código usa. Os hex acima são fonte de verdade,
mas o app referencia os papéis:

```ts
// Surfaces
background    → neutral.50
surface       → neutral.0   (card canvas)
surfaceAlt    → neutral.100 (chip não-selecionado, panel secundário)

// Borders
border        → neutral.200 (default)
borderStrong  → neutral.300 (hover, divider de seção)

// Text
textPrimary   → neutral.900
textSecondary → neutral.600
textMuted     → neutral.500
textDisabled  → neutral.400

// Brand
primary       → primary.600
primaryHover  → primary.500
primaryActive → primary.700
primarySoft   → primary.100 (background tinted)

// Status
success       → success.500
warning       → warning.500
danger        → danger.500
info          → info.500

// Status backgrounds (chip backgrounds)
successSoft   → success.100
warningSoft   → warning.100
dangerSoft    → danger.100
infoSoft      → primary.100  (mesmo do primarySoft no piloto)
```

---

### 1.5 Fundo papel, cards delimitados e tinta de marca (23/08)

Proposta de design (Claude Design, 23/08) aplicada aos tokens — o Perfil foi
a primeira tela na nova linguagem:

- `colors.background` = `neutral.150` (#E4EAF1, "papel de mesa"). O fundo
  antigo (#F8FAFC) diferia 1,2 % do card branco; nenhuma borda de 1px
  sustentava o contorno — a correção desce o fundo em vez de subir o card.
- `surface.card` com borda `neutral.300`; `surface.raised` ganha borda
  (Android achata sombra; print não mostra).
- `palette.brand` (#01304A, navy do ícone/wordmark) → `colors.brand`,
  `colors.brandSoft`, `colors.gridLine`; `sidebarBg` passa a ser a marca.
- `text.eyebrow.letterSpacing` 1.6 (tracking do wordmark E S C A L A +).
- `fontFamily.mono` obrigatório em TODO numeral de dado (hora, duração,
  contagem, horas do mês).
- `colors.statusVagoListing` / `statusVagoActionable` (o que
  `lib/shift-status.ts` já decide por contexto).
- `colors.glass.*`, `TintedGlassCard` e `GlassCard` ficam **deprecados**:
  blur é iOS-only. Saem quando Admin, Solicitações, Criar/Editar plantão,
  Confirmação, Indicar substituto e Oferecer troca migrarem para `Surface`.

## 2. Tipografia

Princípios extraídos de [Phase 1 §4](./ui-research.md#4-tipografia-em-interfaces-densas):

- **6 níveis hierárquicos** (Stripe pattern). Menos é anêmico; mais
  vira soup.
- **System font stack** — gratuito, instantâneo, nativo em cada SO.
  Inter como upgrade post-piloto se valor for incremental (ROI baixo).
- **Productive type set** (Carbon pattern). Tamanhos comprimidos pra
  trabalho denso. Expressive type set fica para login/empty states
  celebratórios depois.

### 2.1 Font stack

```ts
fontFamily.sans = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
fontFamily.mono = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
```

`mono` reservado para IDs numéricos (ID de plantão, código), nunca em
corpo.

### 2.2 Escala (6 níveis)

| Token | Size | Line height | Tracking | Uso |
|---|---|---|---|---|
| `text.display` | 32 px | 40 px (1.25) | -0.5 px | Hero de tela login, empty-state celebratório. |
| `text.titleLg` | 24 px | 32 px (1.33) | -0.25 px | Heading H1 de tela ("Plantões em aberto"). |
| `text.title` | 18 px | 26 px (1.44) | 0 | Heading H2 de seção dentro de tela. |
| `text.bodyLg` | 16 px | 24 px (1.5) | 0 | Body padrão. Inputs, parágrafos longos. |
| `text.body` | 14 px | 20 px (1.43) | 0 | Body compacto (cards, listas). **Default em UI densa.** |
| `text.caption` | 12 px | 16 px (1.33) | 0.1 px | Helper, hint, label, timestamp. |

### 2.3 Pesos

| Token | Weight | Uso |
|---|---|---|
| `weight.regular` | 400 | Body padrão. |
| `weight.medium` | 500 | Ênfase suave (label, status sub-label). |
| `weight.semibold` | 600 | Headings, CTAs. |
| `weight.bold` | 700 | Reserva para impacto (display, alerta). |

**Sem `weight.light` (300).** Em telas LCD comuns (LG/Samsung/genérico
de hospital) `font-weight: 300` fica fraco e ilegível em texto pequeno.
Phase 1 §4.1.

### 2.4 Section labels — Cron pattern

Para headings de seção com hierarquia explicita (label > heading >
content), usar uppercase + tracking:

```
fontSize: 12 px
fontWeight: 600 (medium-semibold)
textTransform: uppercase
letterSpacing: 0.5 px
color: textMuted
```

Exemplo: "PLANTÕES DE TERÇA, 14 DE MAIO" sobre um heading H2 (text.title)
"Centro Cirúrgico". Cron usa esse padrão; copiamos.

---

## 3. Spacing

Princípios extraídos de [Phase 1 §4.2](./ui-research.md#42-material-3--densidade-defaultcomfortablecompact):

- **Base 4 px** (Material/Tailwind/IBM convention).
- **Escala não-linear** com saltos maiores nos extremos. Spacing é o
  carrier principal de density — tipografia fica fixa, padding muda.
- **Density via composição de tokens, não via tipografia.**

### 3.1 Escala

| Token | Valor (px) | Uso |
|---|---|---|
| `space.0` | 0 | — |
| `space.1` | 4 | Gap mínimo (entre ícone e texto). |
| `space.2` | 8 | Padding interno de chip. |
| `space.3` | 12 | Padding interno de input/button compacto. |
| `space.4` | 16 | **Padding default de card** (era cardPadding). |
| `space.5` | 20 | Padding interno de modal. |
| `space.6` | 24 | **Padding default de tela** (era screenPadding). Gap entre cards. |
| `space.8` | 32 | Margin entre seções de uma tela. |
| `space.10` | 40 | Spacing generoso (entre grupos top-level). |
| `space.14` | 56 | Margin de elementos hero. |
| `space.20` | 80 | Spacing máximo (split de seções no desktop wide). |

### 3.2 Density por contexto

| Contexto | Tela padding | Card padding | Gap entre cards |
|---|---|---|---|
| Mobile (<768) | space.4 (16) | space.4 (16) | space.3 (12) |
| Tablet (768-1023) | space.5 (20) | space.4 (16) | space.4 (16) |
| Desktop (≥1024) | space.6 (24) | space.5 (20) | space.4 (16) |

Aplicar via responsive utility (NativeWind tem isso) ou `useWindowDimensions`.

---

## 4. Border radius

Princípios:

- **Radius generoso** (8-12 px) em containers — sensação aproachable
  (Notion pattern).
- **Pill (999)** para chips e tags (forma reforça que é status, não
  conteúdo).
- **Sharp (0)** para divisores e inputs especiais — ênfase em forma.

### 4.1 Escala

| Token | Valor (px) | Uso |
|---|---|---|
| `radius.none` | 0 | Divisor, input full-width sem visual. |
| `radius.sm` | 4 | Inputs compactos, ícone container pequeno. |
| `radius.md` | 8 | Inputs default, buttons. |
| `radius.lg` | 12 | **Cards default.** Modais. |
| `radius.xl` | 16 | Cards de hero (login, empty state). |
| `radius.2xl` | 24 | Modais bottom sheet (mobile). |
| `radius.full` | 999 | Chips, tags, avatar circular. |

---

## 5. Shadows

Princípios:

- **3 níveis.** Mais que isso é redundância — o cérebro não distingue
  shadow `lg` de `xl` em uso real.
- **Shadows discretas.** Sombras saturadas (preto puro com alta opacity)
  parecem dated; usar cinza com alpha baixo.
- **Light mode only no piloto.** Dark mode requer sombras pretas
  saturadas porque cinza escuro não destaca de cinza-mais-escuro.

### 5.1 Escala (light mode)

| Token | Valor | Uso |
|---|---|---|
| `shadow.sm` | `0 1px 2px rgba(15, 23, 42, 0.04)` | Card default em superficie clara. Sutil. |
| `shadow.md` | `0 4px 12px rgba(15, 23, 42, 0.08)` | Card hover, dropdown, popover. |
| `shadow.lg` | `0 12px 28px rgba(15, 23, 42, 0.12)` | Modal centralizado, drawer. |

Para React Native, traduzimos para `shadowOffset/Opacity/Radius` +
`elevation` (Android). Tokens encapsulam.

---

## 6. Componentes-core

14 componentes que cobrem 95% das telas. Cada um tem contrato —
estados, sizes, padding, padrões de uso.

### 6.1 Button

Variantes (6):

- **`brand`** — bg navy da marca, text white. Ação dominante nas superfícies
  operacionais mobile alinhadas à personalidade Escala+; no máximo uma por
  bloco decisório.
- **`primary`** — bg primary, text white. Para ação principal de fluxo.
  Único por tela (regra de UX clássico — Phase 1 §1.1 heurística #8).
- **`secondary`** — bg neutral.0, border neutral.200, text textPrimary.
  Para ações alternativas.
- **`danger`** — bg danger.500, text white. Para ações destrutivas
  (cancelar oferta, deletar plantão).
- **`ghost`** — bg transparent, text textPrimary, hover bg neutral.100.
  Para ações secundárias compactas.
- **`link`** — bg transparent, text primary, sem border. Para "Ver
  mais", navegação textual.

Sizes (3):

| Size | Height | Padding-X | Font | Uso |
|---|---|---|---|---|
| `sm` | 32 px | space.3 (12) | text.body (14) / weight.medium | Inline em listas, tabela. |
| `md` | 40 px | space.4 (16) | text.body (14) / weight.semibold | **Default.** Form CTAs. |
| `lg` | 48 px | space.5 (20) | text.bodyLg (16) / weight.semibold | Hero CTA, mobile-prominent. |

Estados:

- `default` → cor base
- `hover` → primary.500 (em primary), ou bg neutral.50 (em ghost)
- `active` → primary.700 (em primary), depressed
- `focus` → outline 2 px primary.600 com offset 2 px
- `disabled` → opacity 0.4, cursor not-allowed
- `loading` → spinner branco interno, label oculto

Border radius: `radius.md` (8 px).

### 6.2 Input (TextInput, TextArea)

Estados:

- `default` → bg neutral.0, border neutral.200, text textPrimary,
  placeholder textMuted
- `focus` → border primary.600, ring 2 px primary.100, no shadow change
- `error` → border danger.500, helper text danger.600
- `disabled` → bg neutral.100, text textMuted

Sizes:

| Size | Height | Padding | Font |
|---|---|---|---|
| `md` | 40 px | space.3 (12) | text.body (14) |
| `lg` | 48 px | space.4 (16) | text.bodyLg (16) |

Border radius: `radius.md` (8 px).

Helper text: text.caption (12 px), color textMuted (default) ou
danger.600 (error).

### 6.3 Select

Visualmente idêntico ao Input. Diferença: chevron icon à direita
(neutral.500), abre dropdown ou native picker.

Dropdown panel: bg neutral.0, shadow.md, radius.lg, max-height 320 px,
scroll. Items 36 px altura, padding-x space.3.

### 6.4 Card

Estados:

- `default` → bg surface (neutral.0), border neutral.200, radius.lg,
  shadow.sm, padding space.5 (desktop) / space.4 (mobile).
- `hover` → border neutral.300, shadow.md (apenas em cards
  interativos — clickable cards).
- `selected` → border primary.600, bg primary.50.

#### 6.4.1 Glass surface (variante)

Card translúcido com BlurView (iOS) usado em superfícies stack-on
gradient — sidebar e hospital-dashboard. Em Android cai para fallback
opaco com a mesma paleta (sem blur).

| Variant | Background | Border | Token |
|---|---|---|---|
| `light` | rgba(255, 255, 255, 0.92) | primary.100 | `theme.colors.glass.lightBg` / `glass.lightBorder` |
| `dark`  | rgba(255, 255, 255, 0.08) | rgba(255, 255, 255, 0.12) | `theme.colors.glass.darkBg` / `glass.darkBorder` |

Outras propriedades:
- radius `2xl` (24)
- padding `space.5` (20)
- BlurView `intensity={22}` em iOS

### 6.5 Tag / Badge

Pill chip para metadata curta (status, modalidade, role).

Sizes:

| Size | Height | Padding-X | Font |
|---|---|---|---|
| `sm` | 20 px | space.2 (8) | text.caption (12) / weight.semibold |
| `md` | 24 px | space.3 (12) | text.caption (12) / weight.semibold |

Variantes (4 cores semânticas + neutro):

- `neutral` → bg surfaceAlt, text textPrimary
- `primary` → bg primarySoft, text primary
- `success` → bg successSoft, text success.700
- `warning` → bg warningSoft, text warning.700
- `danger` → bg dangerSoft, text danger.600

Border radius: `radius.full` (999).

### 6.6 Modal (centralizado)

Estrutura:

- Overlay full-screen: `rgba(15, 23, 42, 0.5)` (neutral.900 com 50%
  alpha).
- Container: bg surface, radius.lg, shadow.lg, max-width 480 px (desktop)
  ou full-width (mobile com bottom-sheet).
- Padding: space.5 (20) interno.
- Header: text.title + close button (ghost sm, ícone X).
- Footer: 2 botões (secondary à esquerda, primary à direita), gap space.3.

Animação (default 200 ms, respeitar `prefers-reduced-motion`):
- Overlay fade-in
- Container scale 0.95 → 1 + fade

### 6.7 Drawer (lateral / bottom)

Variantes:

- `right` — desktop, 400-480 px de largura, full-height.
- `bottom` — mobile, full-width, max-height 75% da viewport.

Estrutura:

- Overlay igual ao modal.
- Container: bg surface, sem radius nas bordas que tocam a tela
  (radius.lg só nas que ficam livres).
- Header sticky no topo, content scrollable, footer sticky no fundo.

### 6.8 Toast

Posicionamento:

- Desktop: bottom-right, 16 px do canto.
- Mobile: top, 16 px abaixo do safe area.

Tipos (3):

- `success` → bg success.50, border success.500, ícone check success.500
- `info` → bg primary.50, border primary.600, ícone info primary.600
- `error` → bg danger.50, border danger.500, ícone alert danger.500

Auto-dismiss: 4 s default; sticky para erros (até user fechar).

Padding: space.4. Radius.md. Shadow.md.

### 6.9 EmptyState

Estrutura padronizada (extraída de [Phase 1 §8.1](./ui-research.md#81-empty-states--a-oportunidade-desperdiçada)):

```
[Ícone 64 px, neutral.400]

Headline (text.title, textPrimary, semibold)

Descrição (text.body, textMuted, center, max 60 chars)

[CTA opcional — primary md]
```

Vertical center na disponível, max-width 480 px.

### 6.10 Skeleton

Para loading de primeira carga. Retângulo com gradiente animado:
`linear-gradient(90deg, neutral.100 0%, neutral.200 50%, neutral.100 100%)`.

Variantes:

- `line` — height 16 px (igual a body), width variável
- `card` — height 80 px (typical card)
- `circle` — para avatars, 40 px / 56 px / 80 px

Animação: shimmer 1.5 s loop. Respeitar reduced-motion.

### 6.11 Tooltip

Disparado por hover (desktop) ou long-press (mobile).

Estrutura: bg neutral.900, text neutral.0, padding space.2, radius.sm,
text.caption, shadow.md, max-width 240 px.

Posição: 8 px de offset do trigger.

### 6.12 Tabs

Para alternância de visões 2-5.

Estrutura:

- Lista horizontal de triggers, gap space.4.
- Trigger ativo: text textPrimary, border-bottom 2 px primary.600.
- Trigger inativo: text textMuted, sem border. Hover → text textPrimary.
- Padding-y trigger: space.3.

Acima de 5 itens, mover pra Sidebar (vertical).

### 6.13 SidePanel (Linear pattern)

Painel à direita que substitui rota dedicada para detalhe de item.

Estrutura:

- Width: 480 px (desktop only — mobile usa rota normal).
- Background surface, border-left neutral.200, full-height.
- Header sticky com título (text.title) e close button (ghost sm).
- Content scrollable, padding space.5.
- Animação slide-in 200 ms da direita.

Desktop only. Em mobile (<1024 px), o usuário é redirecionado para
rota dedicada.

### 6.14 SidebarNav

Navegação principal vertical (desktop). Atualmente em
`app/(tabs)/_layout.tsx → WebSidebarTabBar`.

Spec:

- Width: 220 px.
- Background: neutral.900 (escuro intencional, contrasta com canvas
  light) — manter padrão atual.
- Item: padding space.3, radius.md, gap space.2.
- Item ativo: bg primary.600, text white, border-left 3 px white
  (active stripe — já implementado em PR #58).
- Item inativo: text neutral.300 (claro pra ler em fundo escuro),
  hover bg `rgba(255,255,255,0.06)`.
- Section labels (uppercase tracking 0.5): para agrupar items —
  Phase 4 propõe "OPERAÇÃO" e "SISTEMA".

---

### 6.15 Surface — níveis de camada (Onda UI)

`components/ui/Surface.tsx` é a única forma de criar profundidade. Três
níveis (`theme.surface`) e seis tons:

| Nível | Quando | Estilo |
|---|---|---|
| `card` | conteúdo agrupado (lista, formulário) | surface + borda 1px + sombra sm, raio lg |
| `raised` | o que precisa se destacar do card (hero, resumo) | sem borda, sombra md, raio xl |
| `floating` | sheets, menus, toasts | sombra lg, raio xl |

Tons: `default`, `primary`, `success`, `warning`, `danger`, `muted` — fundo
`*Soft` + borda `[100]/[200]`; texto dentro do tom via `tonedText(tone)`
(`strong` = `[900]`, `soft` = `[700]`/`[600]`), sempre ≥ 4,5:1.
Nunca montar card "na mão" com `borderRadius` + `borderWidth` soltos.

### 6.16 SectionHeader

`components/ui/SectionHeader.tsx`: eyebrow (caixa alta, `text.eyebrow`) +
título (`title` ou `titleLg` com `size="page"`) + subtítulo + ação à
direita. Toda seção de tela começa com ele — mesmo ritmo em todas as telas.

### 6.17 Skeleton

`components/ui/Skeleton.tsx` (`Skeleton`, `SkeletonCard`, `SkeletonList`):
carregamento com a forma do conteúdo, pulso leve (estático com "reduzir
movimento"). Substitui o spinner central de tela inteira; em navegação
entre períodos combinar com `placeholderData: keepPreviousData`.

### 6.18 NextShiftCard

`components/agenda/NextShiftCard.tsx`: a pergunta nº 1 do plantonista no
topo da Agenda. Puro (props + `now` injetável). Estados: futuro
("Começa em 3 h", "Amanhã às 07:00", "sexta, 28/08 às 19:00"); em
andamento ("termina às 19:00", tom success); sem plantão (tom muted).

Variantes: **`compact` (padrão, é a da Agenda)** — faixa de ~56pt com
quando · horário · setor e UMA ação à direita (Comunica+ durante o
plantão, Confirmar quando há pedido pendente, senão a seta de detalhe;
trocar plantão fica no detalhe). `full` — card grande com Confirmar/Trocar
empilhados. O PO pediu o compacto em 2026-08-22: o card grande roubava a
visão panorâmica da escala.

### 6.19 Galeria de UI

`app/ui-preview.tsx` (só em `__DEV__`, rota pública no AuthGuard) renderiza
os componentes de base com dados de exemplo — verificação visual sem login
em `http://localhost:8081/ui-preview`.

### 6.20 ListRow

`components/ui/ListRow.tsx`: a linha de lista tocável — ícone em tile,
título, subtítulo e um terminador (chevron, `value` curto, `toggle` ou
`trailing` livre). Não desenha superfície própria: vive dentro de
`<Surface padded={false}>` e desenha só o divisor de topo (`divided`).
Tons `default | brand | warning | success | danger`. Altura mínima 56 (a
lista é operada com uma mão). O `value` tem três tons (`valueTone`):
`muted` (padrão, informação — "2 abertas"), `action` (primary — o valor É a
ação, "Alterar") e `count` (pílula âmbar preenchida, mono — fila que exige
ação; só renderizar quando > 0, um "0" é ruído, e o `accessibilityLabel`
deve dizer a contagem: "Abrir Solicitações, 7 aguardando aprovação"). Substitui os blocos "TouchableOpacity + View +
2 Text + Abrir" do Perfil; serve Solicitações, Vagas e Admin.

O Perfil (23/08) é a referência de uso: quatro grupos — Gestão (com a
contagem de Solicitações vinda de `shiftAssignments.listPending`), Sua
atividade, Notificações, Conta e app — mais a zona de risco.

### 6.21 Folha de calendário (CalendarSheet) e o traje do plantão

Proposta "Escala+ Personalidade" (23/08). O ícone do app É um calendário
de parede — moldura navy de cantos arredondados, dois furos de pendurar,
malha de planta baixa por dentro — e a Agenda passa a falar esse idioma
em vez de 42 cartõezinhos genéricos:

- `components/agenda/CalendarSheet.tsx`: `CalendarFrame` (moldura navy de
  2 px + `HangingHoles`), `CalendarLegend` (faixa navy com a legenda dos
  traços, DENTRO da moldura — nada a cobre), `DayNumeral` (o numeral do
  dia no círculo: `todayOnDark` anel branco sobre navy, `today` anel navy,
  `default` anel cinza, `mine` navy em negrito, `plain`, `muted` fora do
  mês) e `DayRule` (régua do dia na lista: hoje navy sólido). Hoje é
  CIRCULADO, não pintado. `numeral` é o estilo tabular (`fontFamily.mono`
  + `tabular-nums`) de toda hora, contagem e dia — e `fontFamily.mono` é
  `Platform.select` (Menlo / monospace / pilha CSS): no nativo uma pilha
  CSS caía na fonte do sistema.
- `lib/shift-visual.ts`: o traje — barra de 4 px à esquerda + fundo tinted
  + cores de nome/hora por estado (`vago` neutro, `vagoAcao` danger,
  `pendente` âmbar, `ocupado` branco com barra verde, `meu` navy da
  marca, `confirmada`, `cancelada`). A semântica continua em
  `lib/shift-status.ts`; `shiftVisualFor(status, { isMine, context })`
  junta os dois. A força vem da barra e do tinted, não de chip pintado:
  OCUPADO, que é a maioria, não grita.
- `components/agenda/ShiftRowCard.tsx`: um plantão na lista/detalhe
  (58 pt, nome + chip texto+ícone + horário tabular).
- Tokens novos: `colors.paperWeekend` / `paperSelected` (papel com véu de
  navy), `onDark.ring`, `onDark.textSoft`, `palette.{success,warning,danger}[200]`.

Onde aparece:

- **Lista** (`MobileDayList`): `DayRule` + eyebrow do hospital·setor +
  `ShiftRowCard` (contexto `actionable`); dia vazio é linha fina de 36 pt.
- **Folha de mês** (`MonthAgenda` — Panorama no celular, Calendário no
  desktop): `CalendarFrame` com legenda e iniciais dos dias em navy,
  réguas `gridLine`, hoje circulado, selecionado = `paperSelected`, fim de
  semana = `paperWeekend`, um traço por plantão até 3 e "+n" (presença E
  quantidade; o dia selecionado não apaga mais o próprio status).
- **Panorama hospital × dia** (`PanoramicAgenda`, desktop): cabeçalho navy
  com `DayNumeral`, hospital escrito uma vez, chips com barra de 4 px e
  hora tabular, resumo do período na moldura.
- **Cabeçalho da Agenda** (um só para as três vistas): título + ‹ mês › +
  "Hoje" (o único botão preenchido, navy) + microfone inline; instituição
  + Geral/Minha (ativo navy); trocador de vista de largura cheia (ativo
  branco/navy); e, só para gestor, `ManagerActionsMenu variant="strip"`
  com "Agosto · rascunho" lido antes do toque.
- **Faixa "Próximo plantão"** (`NextShiftCard` compact): duas linhas —
  eyebrow + quando (com a única ação ao lado) e o detalhe "turno horário
  · setor" em linha própria que pode quebrar. Navy sólido quando é o
  próximo (a única coisa preenchida da tela); verde tinted em andamento.

## 7. Estados padronizados

Todo componente que carrega dados precisa endereçar 5 estados:

### 7.1 Loading

- Primeira carga → `Skeleton` (estrutura visível, contrato com layout).
- Refresh / inflight → `Spinner` inline ou `<ActivityIndicator>`.
- Operação longa com progresso conhecido → `ProgressBar` (não no
  piloto; deixar para futuro).

### 7.2 Empty

Componente `<EmptyState>` (§6.9). Sempre com 3 partes: ícone +
headline + body. CTA opcional.

### 7.3 Error

Três níveis:

- **Inline** (campo de form) → texto vermelho discreto sob input,
  text.caption, color danger.600.
- **Banner** (page-level) → componente `<ErrorBanner>` no topo da
  tela, bg danger.50, border danger.500, ícone alert.
- **Full-screen** (servidor fora) → `<EmptyState>` variant `error` com
  CTA "Tentar de novo".

### 7.4 Success

- **Toast** (4s, bottom-right desktop / top mobile) → ação pontual
  bem-sucedida (cessão aprovada, plantão criado).
- **Inline checkmark** → field validado em tempo real (não usar no
  piloto).

### 7.5 Optimistic

Padrão moderno (Phase 1 §8.4). UI reflete sucesso imediatamente; roll
back se servidor falhar. Aplicar em ações de baixo risco (toggle,
aprovar candidatura). **Não no piloto** — deixar pra Phase 4 ou
post-piloto.

---

## 7.6 Feedback de ação (toast) — Onda 1

Toda resposta de mutation passa por `hooks/use-action-feedback.ts`:

| Situação | Chamada | Apresentação |
|---|---|---|
| Sucesso | `feedback.success(msg)` | toast verde, 3 s, háptico no nativo |
| Erro | `feedback.error(msg, { retry? })` | toast vermelho, 5 s, botão "Tentar novamente" |
| Informação | `feedback.info(msg)` | toast neutro |
| Ação irreversível | `await feedback.confirmDestructive(título, msg, rótulo)` | diálogo modal (web e nativo) **antes** da ação |

Regras: nunca `Alert.alert` / `window.alert` direto nas telas (no web é
no-op ou modal bloqueante); feedback registrado **uma** vez (na chamada
`mutate`, não no hook E na chamada); o toast mora em
`components/ui/Toast.tsx` e é montado uma vez em `app/_layout.tsx`.

## 7.7 Status de plantão — semântica única

`lib/shift-status.ts` + `components/ui/ShiftStatusBadge.tsx` (texto + ícone;
cor é reforço, nunca o único canal).

| Status | Rótulo | Tom | Onde |
|---|---|---|---|
| VAGO | Vago | **danger** onde o usuário pode agir (vagas, panorama, detalhe) · neutral em listagem geral (dashboard) | `context="actionable"` / `"listing"` |
| PENDENTE | Pendente | warning | — |
| OCUPADO | Ocupado | success | — |
| cancelada | Cancelada | neutral | — |

Texto do chip em tom `[700]` (warning/success) ou `[600]` (danger) sobre o
tint `*Soft` — o tom `[500]` sobre o tint não passa de ~2:1 em 12px.
Nunca renderizar o enum cru (`OCUPADO`, `PENDENTE`).

## 7.8 Alvos de toque

Mínimo **44pt** para qualquer controle tocável: `AppButton` md = 44 (default),
sm = 36 + `hitSlop` 8; navegação de período da Agenda 44×44; chips de filtro e
de data ≥ 40 + hitSlop. Piso de **12px** para texto de dado (nome, horário);
11px só em eyebrow/legenda.

## 7.9 Barra inferior = plantonista

No celular a barra inferior tem sempre o mesmo conjunto, para qualquer papel:
**Agenda · Trocas · Vagas · Perfil**. Painel, Solicitações e Admin são
ferramentas de gestão: aparecem na sidebar do desktop e, no celular, em
**Perfil → Gestão** (as rotas continuam navegáveis por link/push; só não
ocupam a barra). Motivo: seis abas num iPhone truncavam rótulos e expunham
telas de gestor na interface do plantonista. Decisão do PO em 2026-08-22.

## 8. Dark mode roadmap

**Não no piloto.** Light-first é decisão acertada para ambiente
clínico bem iluminado.

Quando vier (post-piloto):

- Tokens duplicados em `theme.colors.dark.*` espelhando estrutura.
- Inversão neutra — `neutral.0` (branco) → `neutral.900` (preto).
- Brand permanece (primary.600 lê bem em dark).
- Semânticas ajustadas — `success/warning/danger.500` em dark mode são
  os de light, mas `success.50` (bg) vira `rgba(verde, 0.1)`.
- Sombras pretas saturadas (light usa cinza com alpha; dark precisa
  preto puro com alpha baixo).

Implementação: hook `useColorScheme()` do RN + provider de tema. Não
inicia no piloto.

## 9. Marca — ícone, favicon e logo

Peças oficiais (PO, 2026-08-18) em `assets/brand/source/`; os arquivos de
`assets/images/` são **gerados** por `scripts/brand/generate-icons.py`
(Pillow + numpy) — nunca editar a saída à mão, regenerar.

| Peça | Uso | Arquivo gerado |
|------|-----|----------------|
| Calendário navy contornado com E+, fundo branco | **Ícone do app** (iOS light, Android adaptativo: foreground + fundo branco + monochrome) | `icon.png`, `android-icon-*.png`, `icon-tinted.png` |
| Tile navy com grade e E+ branco | **Favicon** (web) e variante *dark* do ícone no iOS 18+ (só se o usuário escolher ícones escuros) | `favicon.png`, `icon-dark.png` |
| Wordmark ESCALA+ sobre grade de calendário | **Logo** no login e no splash — fundo transparente (tinta navy + alpha), para não formar caixa branca sobre o gradiente | `logo.png` |

Regras:

- Ícone iOS é 1024² **opaco** (App Store rejeita alpha); a máscara de cantos é
  do sistema — nada de squircle desenhado dentro do squircle.
- Android: o glifo fica dentro da zona segura (≤ 66 % do canvas) porque o
  launcher pode recortar em círculo, squircle ou gota.
- A logo antiga (plus de vidro em gradiente teal) foi aposentada em
  2026-08-22; não reintroduzir.

---

## Apêndice A — Migração de tokens legados

Tokens existentes em `lib/theme.ts` antes deste PR:

| Legacy token | Mapeia para | Status |
|---|---|---|
| `colors.background` (#F8FBFF) | `neutral.50` (#F8FAFC) | **Mudança visual mínima** — `#F8FBFF` é azul-tinted, `#F8FAFC` é mais neutro. Phase 4 audita screens. |
| `colors.surface` | `neutral.0` | Idêntico. |
| `colors.surfaceAlt` | `neutral.100` | Idêntico. |
| `colors.border` (#DBEAFE = primary.100) | `neutral.200` (#E2E8F0) | **Mudança** — antigo `border` era azul-tinted; novo é cinza neutro. Mais sóbrio. |
| `colors.textPrimary` | `neutral.900` | Idêntico. |
| `colors.textSecondary` | `neutral.600` | Idêntico. |
| `colors.textMuted` | `neutral.500` | Idêntico. |
| `colors.primary` | `primary.600` | Idêntico. |
| `colors.accent` | `primary.600` | **Decidido remover** — duplicação. Phase 4 substitui usos. |
| `colors.screenBg` | `neutral.50` | Alias legado, manter durante migração. |
| `colors.cardBg` | `neutral.0` | Alias legado, manter. |
| `colors.cardBorder` | `neutral.200` | Alias legado, manter. |
| `colors.inputBg` | `neutral.0` | Alias legado, manter. |
| `colors.success` | `success.500` | Idêntico. |
| `colors.warning` | `warning.500` | Idêntico. |
| `colors.danger` | `danger.500` | Idêntico. |
| `colors.statusVago` | (removido) | **Decidido**: VAGO não é danger. Render como neutral com ícone. Phase 4 elimina usos diretos. |
| `colors.statusPendente` | `warning.500` | OK. |
| `colors.statusOcupado` | `success.500` | OK. |

### Estratégia de migração

1. **Phase 2 (este PR)** — adiciona tokens novos em `lib/theme.ts`.
   **Não remove** tokens legados. Backward-compat total.
2. **Phase 3** — audit das telas; cada `theme.colors.legacyXxx` vira
   finding com proposta de novo token.
3. **Phase 4** — implementação por tela; conforme cada tela é tocada,
   migra para tokens novos. Quando todas migrarem, Phase 4-final
   remove legacy aliases em PR de cleanup.

Nunca remover legacy aliases sem ter migrado todos os usos. Quebra
silenciosa de UI é o pior outcome possível.

---

## Decisões abertas

Coisas que **não** foram decididas neste spec — vão para Phase 3/4:

1. **Inter vs system font.** System é zero-cost, instantâneo. Inter
   tem glyphs de tabular numbers (⊕)/disambiguada para UI densa. Pra
   piloto, system. Avaliar pós-piloto.
2. **Density toggle no desktop.** Material 3 oferece. Stripe não usa.
   Decidir post-piloto baseado em feedback dos gestores.
3. **Animação fina** — qual easing curve, qual duração default. Phase
   4 padroniza ao implementar.
4. **Iconografia** — Lucide está em uso; manter. Stroke-width 1.5 ou
   2? Resolver em Phase 4.

---

## Próximos passos

1. **Você lê este documento** e responde "aprovado" ou pede revisões
   específicas.
2. Após aprovação, **Phase 3** começa: audit de cada tela existente vs
   este spec. Output: `docs/design/ui-audit.md` com violações
   priorizadas. PR separado.
3. Phase 4 = implementação por tela. 1 PR por tela, tokens-only,
   reviewer pass obrigatório.

Não comece Phase 4 enquanto Phase 3 não tiver sido aprovada. A skill
`/ui-design` exige isso — sem aprovação, o trabalho deteriora.

---

**Fim da Phase 2.**
