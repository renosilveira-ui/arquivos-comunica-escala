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

Variantes (5):

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
