---
name: ui-design
description: Codifica o protocolo de redesign UI premium do Escalas. Pesquisa → spec → audit → implementação por fases. Cada fase é um deliverable separado; nunca pular fases.
---

# Protocolo `/ui-design` — Redesign UI premium do Escalas

Este skill é o protocolo de trabalho do agente "expert em UI desktop" do
projeto. **Não é um prompt de uma frente única** — é a constituição que
governa qualquer trabalho de UI sério neste app. Quando o usuário pedir
"melhora a UI", "deixa premium", ou similar, este protocolo entra em jogo.

## Contexto fixo

- App de gestão de escalas hospitalares (Escalas / Comunica+).
- Stack: React Native + Expo Router + NativeWind. Roda em iOS, Android e
  desktop web (≥1024 px) — desktop é onde o gestor passa o dia, mobile é
  onde o profissional consulta no plantão.
- Tokens vivem em [lib/theme.ts](../../lib/theme.ts).
- Tela-âncora desktop: sidebar (220 px) + content. Spec produto em
  [docs/product/escala-ux.md](../../docs/product/escala-ux.md).
- Usuários: médicos (anestesistas no piloto Unimed Fortaleza), gestores
  médicos, gestores plus. Não são usuários de software — leigos
  interagindo com sistema crítico em condição de plantão.

## Princípios não-negociáveis

1. **Pesquisa antes de implementação.** Decisão visual sem fundamento é
   risco. Cada escolha (paleta, tipografia, componente) precisa de
   referência citada — heurística UX, padrão de B2B premium, ou
   experiência específica em software de escala/calendário/saúde.
2. **Tokens, nunca valores literais.** Cor, spacing, tipografia, shadow,
   raio: tudo via `theme.colors.*`, `theme.spacing.*`, etc. Se um literal
   aparece num arquivo `app/`, é violação.
3. **Spec antes de PR.** Não abre PR de implementação enquanto a fase de
   spec não tiver sido aprovada pelo usuário.
4. **PRs pequenos por tela.** Phase 4 nunca refatora 5 telas num PR; cada
   tela ou cluster pequeno (≤2 telas relacionadas) vira PR próprio.
5. **Acessibilidade é parte do produto.** Contraste WCAG AA mínimo,
   touch targets ≥44 px (mobile) / ≥32 px (desktop), navegação por
   teclado em desktop.
6. **Densidade de informação ajustada por persona.** Gestor (desktop)
   vê muito; profissional (mobile, plantão) vê o essencial. Não copiar
   o layout entre os dois.

## Fases

A skill executa em uma fase por vez. Cada fase produz um deliverable
revisável; o usuário aprova explicitamente antes de a próxima começar.

### Phase 1 — Research

**Output:** `docs/design/ui-research.md` (markdown ~600-1000 linhas).

**Conteúdo obrigatório:**

- **Princípios UX clássicos aplicáveis** (Nielsen, Fitts, Gestalt,
  F-pattern reading, lei de proximidade, etc.) — citar fonte canônica
  pra cada um, traduzir pra exemplos no contexto Escalas.
- **Análise de 6-8 referências B2B premium** (Linear, Notion, Vercel
  Dashboard, Stripe, Pylon, Plane, Cron, Height ou equivalentes).
  Pra cada: prints (descrever em texto se não acessível), o que é bom,
  o que aplica ao Escalas.
- **Análise de 3-5 referências da categoria** (software de escala /
  agenda médica): QGenda, ShiftAdmin, Doximity Dialer, Connecteam,
  Tigerconnect, Epic OpTime. Mesma estrutura.
- **Tipografia em interfaces densas** — pesquisar IBM Carbon, Material 3
  density, Apple HIG sobre tabelas/listas. Recomendação concreta de
  font-stack + escala (qual tamanho pra quê).
- **Cor em interfaces críticas** — pesquisar paletas de software médico
  / financeiro / aviação. Discussão de contraste, vermelho vs laranja
  pra alerta, neutros sóbrios vs vibrantes.
- **Hierarquia e navegação** — sidebar persistente vs collapsible,
  quando usar tabs vs subnav, breadcrumbs, command palette, search-as-nav.
- **Cascade / second-screens / disclosure** — pesquisar progressive
  disclosure, master-detail, side panels (Linear), drawers, modals.
  Recomendação de quando usar cada um.
- **Feedback e estado** — empty states (Backed by Basecamp's "Show your
  work"), loading skeletons, error boundaries, optimistic updates.
- **Acessibilidade premium** — WCAG AAA targets onde realista, focus
  rings, reduced motion, contrast ratio mínimos.

**Não fazer em Phase 1:**

- Não escrever código.
- Não modificar `lib/theme.ts`.
- Não opinar sobre paleta específica antes de ter as referências.
- Não tocar em `.tsx`.

**Critério de done:** o usuário lê o doc e responde "aprovado" ou pede
revisões específicas. Sem aprovação, Phase 2 não começa.

### Phase 2 — Design system spec

**Output:** `docs/design/ui-system.md` (markdown) + diff em
`lib/theme.ts` (tokens novos + tokens redefinidos).

**Conteúdo do markdown:**

- Paleta completa com hex, nome semântico, e justificativa baseada na
  pesquisa de Phase 1.
- Escala tipográfica (font-family, sizes, weights, line-heights).
- Spacing scale (4 px ou 8 px base — escolher e justificar).
- Border radius scale.
- Shadow scale (3-4 níveis: card, modal, popover).
- Componentes-core spec: Button (4-5 variants × 2 sizes), Input, Select,
  Card, Tag, Modal, Drawer, Toast, EmptyState. Cada um com:
  estado default/hover/focus/disabled, tamanhos, padding interno, uso
  recomendado.
- Estado de erro / loading / empty padronizado.
- Dark mode roadmap (tokens duplicados, mas piloto fica light).

**Critério de done:** usuário lê + tokens compilam (`pnpm typecheck:app`
green). Sem aprovação, Phase 3 não começa.

### Phase 3 — Audit

**Output:** `docs/design/ui-audit.md` — cada tela existente do app
listada com: violação observada, severidade (HIGH/MEDIUM/LOW), proposta
de fix.

**Telas obrigatórias:**

- `app/(tabs)/index.tsx` (redirect para calendar — ignorar)
- `app/(tabs)/calendar.tsx` (Agenda — tela mais crítica)
- `app/(tabs)/weekly.tsx`
- `app/(tabs)/dashboard.tsx`
- `app/(tabs)/pending.tsx` (Solicitações)
- `app/(tabs)/vacancies.tsx` (Plantões em aberto)
- `app/(tabs)/reports.tsx`
- `app/(tabs)/admin.tsx`
- `app/(tabs)/profile.tsx`
- `app/create-shift.tsx`
- `app/edit-shift.tsx`
- `app/shift-details.tsx`
- `app/my-offers.tsx`
- `app/my-applications.tsx`
- `app/login.tsx`
- `app/select-institution.tsx` (se existir)
- `app/(tabs)/_layout.tsx` — sidebar desktop em si
- `components/shift-filters.tsx` e outros componentes de uso
  transversal

Pra cada tela, prints (ou descrição em texto se não acessível) + 3-5
violações concretas referenciando spec de Phase 2.

**Critério de done:** usuário escolhe a ordem de implementação por
tela ou cluster. Sem priorização, Phase 4 não começa.

### Phase 4 — Implementação incremental

**Output:** N PRs pequenos, um por tela (ou cluster ≤2 telas).

**Disciplina:**

- 1 PR = 1 tela ou ≤2 telas relacionadas.
- Cada PR refere o doc de spec (Phase 2) e o item do audit (Phase 3) que
  está fechando.
- Tokens-only: zero literal de cor/spacing/typography no código.
- `pnpm typecheck:app` + `pnpm lint` green em cada PR.
- Reviewer pass obrigatório (use o sub-agente code-reviewer ou peça
  revisão antes de mergear).

## Anti-padrões (recusar se o usuário pedir)

- "Aplica essa cor genérica que vi numa app aleatória" — sem fundamento,
  recusar e pedir contexto.
- "Faz tudo agora num PR só" — recusar, dividir em fases.
- "Pula a pesquisa, sou apressado" — explicar custo: redesign sem
  pesquisa vira retrabalho. Aceitar só se o usuário insistir
  explicitamente.
- "Não use tokens, hardcoda esse valor" — recusar; tokens são
  invariante.

## Como o agente invoca esta skill

Ao receber um pedido de UI sério, o agente:

1. Lê este protocolo completo.
2. Identifica em que Phase estamos (procurar `docs/design/ui-research.md`,
   `docs/design/ui-system.md`, `docs/design/ui-audit.md`).
3. Se Phase 1 não existe → executa Phase 1 e PARA. Não avança.
4. Se Phase 1 aprovada mas Phase 2 não → executa Phase 2 e PARA.
5. E assim por diante.
6. Em qualquer fase, se algo não foi pesquisado nem especificado, é
   problema de fase anterior — voltar e completar antes de implementar.

## Notas

- Este protocolo é versionado. Mudanças no protocolo viram PR próprio
  com rationale.
- O sub-agente que executa Phase 1 deve usar WebSearch + WebFetch
  liberalmente. Não tem desculpa pra "decidi sem pesquisar".
- Em Phase 4, code reviewer obrigatório. Erros visuais são caros porque
  contaminam todas as telas que copiarem o padrão errado.
