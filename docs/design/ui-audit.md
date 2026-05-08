# UI Audit — Escalas Hospitalares (Phase 3)

> **Status:** Phase 3 — audit das telas existentes vs spec.
> **Pré-requisitos:** [Phase 1 research](./ui-research.md) (PR #76) ✓
> aprovado, [Phase 2 design system](./ui-system.md) (PR #79) ✓ aprovado.
> **Próxima fase:** Phase 4 — implementação por tela. **Não inicia sem
> aprovação explícita deste documento.**

Este audit lista cada tela existente vs o spec de Phase 2, ranqueia
violações por severidade (HIGH/MED/LOW) e propõe ordem de
implementação para Phase 4.

---

## Sumário executivo

**Surface de violação atual** (medido em commit `adf82eb`):

| Métrica | Valor |
|---|---|
| Telas em `app/` (excluindo redirect index) | 22 |
| Componentes em `components/ui/` com violação | 10 |
| Hex literals fora de `lib/theme.ts` | **372** ocorrências em 22 arquivos |
| `rgba()` literals | **79** ocorrências |
| Referências ao brand legado `#4DA3FF` | **15** em 6 arquivos |
| Tailwind `text-white` / `bg-white` em telas | residual (2 arquivos) |

**Conclusão.** O app não viola o spec por design — viola por
acumulação. Cada PR anterior fez o melhor com o que tinha; o spec
agora é a referência canônica. 372 hex literals soa muito mas a
maioria são repetições do mesmo punhado (`#0F172A`, `#475569`,
`#FFFFFF`, `#4DA3FF`) — substituição mecânica via search-and-replace
na maior parte das telas.

**Top findings por categoria:**

1. **Hierarquia tipográfica embrionária.** Quase nenhuma tela define
   token (`text-display`, `text-titleLg`, etc.) — usa sizes literais
   em estilo inline. Phase 4 introduz componentes `<Heading>` /
   `<Text>` ou Tailwind tokens equivalentes.
2. **Spacing inconsistente.** `p-4`, `p-5`, `p-6`, `mb-3`, `mb-6` —
   misturados sem regra. Phase 4 audita tela por tela.
3. **Brand legado (`#4DA3FF`)** ainda em uso em 15 lugares — é a cor
   anterior do Escalas, antes do `#2563EB`. Substituição direta.
4. **VAGO renderizado como danger** na maioria das telas (vermelho).
   Per spec Phase 2, deveria ser neutro com ícone — Phase 4 corrige.
5. **Cards usando border azul-tinted** (`#DBEAFE` que era
   `theme.colors.border` legado) em vez de cinza neutro
   (`#E2E8F0`). Mudança estética perceptível mas sutil.
6. **Padding de card varia** entre 16/20/24 px. Phase 4 padroniza
   por contexto (ver Phase 2 §3.2 density table).

---

## Critério de severidade

| Severidade | Critério | Ação |
|---|---|---|
| **HIGH** | Quebra spec dura ou afeta acessibilidade. Ex.: contraste WCAG AA falhando, brand legado `#4DA3FF` em CTA principal, status crítico com cor inconsistente. | Phase 4 prioriza. |
| **MEDIUM** | Violação técnica do spec sem impacto perceptível imediato. Ex.: `p-4` em vez de `space.4`, hex literal em vez de token. | Phase 4 endereça em batch. |
| **LOW** | Cosmético, refinamento. Ex.: gap entre seções em 24 vs 32, peso da fonte 500 vs 600 em label. | Phase 4 captura se está tocando o arquivo; senão, deixa. |

---

## Findings transversais (afetam múltiplas telas)

### T1 — `#4DA3FF` (brand legado) ainda em uso (HIGH)

Substituir todos os 15 usos por `theme.colors.primary` (novo: `#2563EB`).

Arquivos: `app/_layout.tsx`, `app/create-shift.tsx`, `app/edit-shift.tsx`,
`app/(tabs)/vacancies.tsx`, `app/(tabs)/weekly.tsx`, `app/(tabs)/pending.tsx`.

Substituição mecânica (pattern bem definido, sem condicionais
contextuais).

### T2 — `border: "#DBEAFE"` (azul-tinted) → `theme.colors.border` (cinza neutro) (MEDIUM)

`#DBEAFE` foi `theme.colors.border` legado, mas Phase 2 redefine
`theme.colors.border = #E2E8F0` (neutral.200). Resultado: borders mais
sóbrios, paleta mais coesa.

Arquivos com uso direto: `app/(tabs)/vacancies.tsx:221`,
`app/(tabs)/pending.tsx`, e onde `theme.colors.cardBorder` (alias
legado) é referenciado.

### T3 — `statusVago: "#EF4444"` (vermelho) → neutral + ícone (HIGH)

Per spec §1.3, "VAGO" não é danger. Vermelho deve ser reservado para
warning de ação imediata. VAGO é oportunidade — render como
`theme.colors.surfaceAlt` com ícone de "+" em `theme.colors.primary`.

Arquivos: `app/(tabs)/vacancies.tsx`, `app/(tabs)/calendar.tsx`,
`app/shift-details.tsx`, qualquer tela que renderize status colorido.

### T4 — Hierarquia tipográfica em valores literais (MEDIUM)

Ocorrência em quase todas as telas:

```tsx
<Text style={{ fontSize: 24, fontWeight: "700" }}>...
<Text style={{ fontSize: 14, color: "#475569" }}>...
```

Em vez de:

```tsx
<Text style={{ ...theme.text.titleLg, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>...
```

Phase 4 propõe componentes `<Heading level="titleLg">` ou utility
helpers para reduzir verbosity.

### T5 — Padding/margin inline em valores arbitrários (MEDIUM)

Ocorrências de `paddingTop: 60`, `paddingBottom: 100`, `marginBottom: 24`
fora da escala. Phase 4 audita cada um — alguns são legítimos
(safe-area), outros podem virar `space.X`.

### T6 — Tailwind classes com valores literais (`text-[#XXXXXX]`) (LOW)

Ocorrências raras mas existem. Substituir pelos tokens equivalentes
quando a tela é refatorada.

### T7 — Componentes `components/ui/*` com hex literals (HIGH)

| Componente | Violações | Impacto |
|---|---|---|
| `Badge.tsx` | 16 | Componente compartilhado — propaga inconsistência. Refatorar primeiro. |
| `MonthCalendar.tsx` | 10 | Idem. |
| `TintedGlassCard.tsx` | 7 | Idem. |
| `AppButton.web.tsx` | 4 | Idem. |
| `GlassCard.tsx` | 3 | Idem. |
| `AppButton.native.tsx` | 3 | Idem. |
| `TopBar.tsx`, `ScreenGradient.tsx` | 2 cada | Menos crítico. |
| `SecondaryButton.tsx`, `PrimaryButton.tsx` | 1 cada | Trivial. |

**Prioridade alta** porque qualquer tela que use Badge/TintedGlassCard
herda o estilo deles. Refatorar componentes ANTES das telas elimina
muitas violações de cascata.

---

## Audit por tela

Telas listadas em ordem de **tráfego × visibilidade** — quem o
usuário vê todo dia primeiro.

### S1 — `app/(tabs)/calendar.tsx` (Agenda)

- **Tráfego:** alto — landing default após login.
- **Violações:** 17 hex literals.
- **Severidade global:** MEDIUM.

Findings concretos:

- L166: `<ChevronLeft color="#FFFFFF" />` em sidebar — OK
  (intencional na sidebar dark).
- L167: `borderColor: "#E2E8F0"` — já é `neutral.200`. Substituir
  pelo token. **MEDIUM.**
- L184: `borderColor: selected ? "#60A5FA" : "#E2E8F0"` — `#60A5FA`
  não está no spec; usar `theme.colors.primary` ou `primary.200`.
  **MEDIUM.**
- L233/244: Card border `#E2E8F0` — substituir por token.
- L250+: Cores de status do badge de slot — `rgba(34,197,94,0.95)`,
  `rgba(245,158,11,0.9)` — substituir por `success.500` /
  `warning.500` (com possível alpha tinted via tokens
  `successSoft` / `warningSoft`). **LOW.**
- L309-314: status border com cores inline — VAGO em vermelho
  (T3). **HIGH.**
- L327: `color: "#334155"` — `neutral.700`, substituir.

**Phase 4 task:** refatorar tela inteira pra tokens, aplicar T3
(VAGO neutro), unificar borders.

### S2 — `app/(tabs)/vacancies.tsx` (Plantões em aberto)

- **Tráfego:** alto — abre por filtros + lista.
- **Violações:** 31.
- **Severidade global:** MEDIUM.

Findings concretos:

- L177, L279: `<ActivityIndicator color="#4DA3FF" />` — T1 brand
  legado. **HIGH.**
- L188-202: Empty/auth states com cores literais
  (`#94A3B8`, `#0F172A`, `#475569`) — substituir por tokens
  `textMuted`/`textPrimary`/`textSecondary`. **MEDIUM.**
- L221: `borderColor: "#DBEAFE"` — T2. **MEDIUM.**
- L294: `borderColor: "#E2E8F0"` — substituir.
- Modality badge já usa tokens (PR #69) — OK.

**Phase 4 task:** refatorar tela.

### S3 — `app/(tabs)/pending.tsx` (Solicitações)

- **Tráfego:** alto pra gestor.
- **Violações:** 77 (a maior do app).
- **Severidade global:** MEDIUM.

Findings:

- L293, L328: `#4DA3FF` em ActivityIndicator. **HIGH.**
- L294, L306, L318, L329: `rgba(255,255,255,0.6)` em texto sobre
  background light — **vestígio do tema dark anterior**, deveria
  ser `theme.colors.textMuted`. Lê pessimamente em fundo claro.
  **HIGH (afeta legibilidade).**
- L305, L317: `color: "#FFFFFF"` em texto sobre background light —
  invisível. **HIGH (afeta legibilidade).**
- L359: `backgroundColor: "#2563EB"` — token disponível
  (`primary`). Trocar.
- Mais ~70 ocorrências similares. Tela tem volume alto e mistura
  patterns dark/light antigos.

**Phase 4 task:** refatorar tela com cuidado — `pending.tsx` foi
modificado em ~5 PRs e acumulou drift. Auditoria interna cuidadosa
antes do PR.

### S4 — `app/(tabs)/profile.tsx` (Perfil)

- **Tráfego:** médio — acessada quando precisa.
- **Violações:** 64.
- **Severidade global:** MEDIUM.

Findings:

- Muitos `#0F172A`, `#475569`, `#64748B` — substitução mecânica por
  tokens.
- L450/461/472 etc.: cores específicas (`#166534`, `#1E3A8A`) em
  cards de teste de notificação — semânticas custom para botões
  que disparam push de teste. **LOW** — manter por enquanto, ou
  unificar via `successSoft`/`primarySoft` se a UI sentir.

**Phase 4 task:** refatorar tela. Modo demo/teste pode ficar com
cores específicas (escopo experimental).

### S5 — `app/(tabs)/_layout.tsx` (Sidebar desktop)

- **Tráfego:** sempre presente em desktop.
- **Violações:** 12.
- **Severidade global:** HIGH (afeta toda a navegação).

Findings:

- L40: `backgroundColor: "#0B1F3A"` — sidebar dark. **OK
  intencional**, mas valor não está em token. Adicionar
  `theme.palette.neutral.900` (mais escuro) ou criar
  `theme.colors.sidebarBg` específico. **MEDIUM.**
- L42: `borderRightColor: "rgba(255,255,255,0.08)"` — divider em
  dark surface. Tokenizar como `theme.colors.dividerOnDark`.
- L92, L233 etc: `theme.colors.accent` ainda em uso — substituir
  por `theme.colors.primary`.
- Active stripe e user info já implementados (PR #58) — OK.

**Phase 4 task:** sidebar é alta prioridade — toda screen depende
dela. Refatorar primeiro entre `(tabs)/`.

### S6 — `app/login.tsx`

- **Tráfego:** uma vez por sessão.
- **Violações:** 16.
- **Severidade global:** MEDIUM.

Findings:

- L80: `<Activity color={theme.colors.primary} />` — OK pós PR #56.
- L106/109: card com bg navy `rgba(15, 23, 42, 0.85)` — surface
  intencional dark sobre light gradient. **Manter** mas tokenizar.
- Inputs internos do card dark com cores próprias — OK no contexto.

**Phase 4 task:** refatorar mas manter o card dark (decisão de
design intencional).

### S7 — `app/edit-shift.tsx` e `app/create-shift.tsx`

- **Tráfego:** médio — gestor cria/edita.
- **Violações:** 26 + 19.
- **Severidade global:** MEDIUM.

Findings:

- 6 referências `#4DA3FF` (T1 brand legado) entre os dois — **HIGH.**
- Modality form (PR #63) já usa tokens — boa parte OK.
- iOS modal interno (date picker) usa cores próprias (overlay dark
  intencional). Manter.

**Phase 4 task:** refatorar os dois juntos (formulários simétricos).

### S8 — `app/shift-details.tsx`

- **Tráfego:** médio — clicar num plantão.
- **Violações:** 8 (já bastante refatorado em PR #56 + #65).
- **Severidade global:** LOW.

Findings:

- Restos de literais em CTAs. Refatorar quando tocar.

**Phase 4 task:** baixa prioridade. Bem perto do spec.

### S9 — `app/my-offers.tsx` e `app/my-applications.tsx`

- **Tráfego:** médio.
- **Violações:** 4 + 2 (já criadas com tokens em PRs #67/#71).
- **Severidade global:** LOW.

Findings:

- `rgba(37,99,235,0.08)` para highlighted card bg — substituir por
  `theme.colors.primarySoft` (já existe).

**Phase 4 task:** trivial cleanup.

### S10 — `app/audit-log.tsx`

- **Violações:** 4 (recém-criada em PR #78 com tokens).
- **Severidade global:** LOW.

Findings idem — `rgba(37,99,235,0.10)` substituível por
`primarySoft`.

### S11 — `app/(tabs)/weekly.tsx`

- **Tráfego:** médio.
- **Violações:** 7.
- **Severidade:** MEDIUM.

Tela ainda no padrão antigo (sem PR de modernização recente).
Ainda usa `#4DA3FF`. Pegou pouca atenção no piloto — refatorar em
batch com calendar.

### S12 — `app/(tabs)/dashboard.tsx`, `app/(tabs)/reports.tsx`, `app/(tabs)/admin.tsx`

- **Tráfego:** baixo.
- **Violações:** dashboard pequeno, reports 22, admin 22.
- **Severidade:** LOW (não bloqueiam piloto).

Phase 4 endereça depois das telas de tráfego alto.

### S13 — `app/select-institution.tsx`, `app/service-selection.tsx`

- **Tráfego:** raro (uma vez por sessão).
- **Violações:** 13 + 4.
- **Severidade:** LOW.

### S14 — `app/request-swap.tsx`, `app/approve-swaps.tsx`

- **Tráfego:** médio.
- **Violações:** 36 + 53. **Volumosos.**
- **Severidade:** MEDIUM.

Telas de fluxo de cessão. `request-swap` foi confirmado como
"already light-themed" em PR #56 — verificar se as 36 violações
são literais sobre tokens ou caos genuíno.

---

## Componentes (audit)

Refatorar **antes** das telas — propaga consistência por cascata.

### C1 — `components/ui/Badge.tsx` (HIGH, 16 violações)

Componente compartilhado. Refatorar pra usar `theme.colors` +
`theme.text` + `theme.radius.full`. Variantes: neutral, primary,
success, warning, danger (espelhar Phase 2 §6.5).

### C2 — `components/ui/TintedGlassCard.tsx` (HIGH, 7 violações)

Card já usado em ~10 telas. Refatorar pra `Card` spec (Phase 2
§6.4) com 3 estados.

### C3 — `components/ui/MonthCalendar.tsx` (HIGH, 10 violações)

Calendar grid no Calendar/Agenda. Refatorar com tokens.

### C4 — `components/ui/AppButton.{web,native}.tsx` (HIGH, 4+3 violações)

Botão multi-platform. Refatorar pra spec Phase 2 §6.1 (5 variants
× 3 sizes).

### C5 — `components/ui/GlassCard.tsx`, `TopBar.tsx`, `ScreenGradient.tsx`, `Secondary/PrimaryButton.tsx` (LOW, ≤3 cada)

Cleanup batch — refatorar em PR único.

---

## Recomendação de ordem para Phase 4

**Princípio:** componentes antes de telas (cascata), depois telas
de tráfego alto, depois baixo.

| Ordem | Escopo | PRs estimados | Justificativa |
|---|---|---|---|
| **1** | T1 + T3 cleanup global (`#4DA3FF` → `primary`, statusVago → neutral) | 1 PR | Mecânico, alto valor visual, baixo risco. |
| **2** | Componentes-core: Badge, TintedGlassCard, AppButton | 3 PRs (1 por componente) | Refatorar pra spec Phase 2; propaga benefício pra todas as telas que usam. |
| **3** | Sidebar `_layout.tsx` | 1 PR | Sempre presente em desktop; tokenizar `sidebarBg`, `dividerOnDark`. |
| **4** | Calendar + Weekly | 1 PR | Telas-irmãs do mesmo domínio; tráfego alto. |
| **5** | Vacancies + Pending | 2 PRs | Tráfego alto, volume alto. Pending especialmente delicada (drift acumulado). |
| **6** | Create-shift + Edit-shift | 1 PR | Formulários simétricos. |
| **7** | Profile | 1 PR | Volume médio, baixo tráfego. |
| **8** | Telas de fluxo (request-swap, approve-swaps) | 2 PRs | Telas de cessão; volume alto cada. |
| **9** | My-offers + My-applications + Audit-log + Shift-details | 1 PR | Cleanup trivial; já bastante alinhadas. |
| **10** | Login + Service-selection + Select-institution | 1 PR | Tráfego raro, baixa prioridade. |
| **11** | Dashboard + Reports + Admin | 2 PRs | Não bloqueiam piloto. |
| **12** | Components-core menores (GlassCard, TopBar, etc.) + cleanup-final dos legacy aliases em `theme.ts` | 1 PR | Quando todas as telas tiverem migrado, removemos `accent`, `screenBg`, `cardBg`, `cardBorder`, `inputBg`, `statusVago` legados. |

**Total estimado:** ~16 PRs em Phase 4. Ordem flexível dentro de
cada bloco; ordem entre blocos é importante (componentes antes de
telas).

---

## Definição de "done" para Phase 4

Cada PR de Phase 4 só fecha quando:

1. Zero hex literals fora de `lib/theme.ts` no arquivo refatorado.
2. Zero `rgba()` inline (exceto onde for justificado — overlay de
   modal, sidebar dark).
3. `pnpm typecheck:app` green.
4. `pnpm lint` zero errors.
5. Reviewer pass — visualmente comparar com mockup HTML
   (`docs/design/ui-system-preview.html`) ou com o Figma equivalente
   se vier.
6. Zero regressão funcional (interaction-level smoke test no
   browser/simulador).

**Ao final de Phase 4 (todos os ~16 PRs mergeados):** Phase
4-final remove os aliases legados em `lib/theme.ts` (accent,
screenBg, cardBg, cardBorder, inputBg, statusVago/Pendente/Ocupado
legacy). Esse PR final tem que typecheckar globalmente porque
qualquer arquivo restante usando alias legado quebra.

---

## Status Phase 4 — CONCLUÍDA

**Inventário completo (PRs mergeadas):**

| PR | Escopo |
|---|---|
| #81 | T1 — replace `#4DA3FF` → `primary` |
| #83 | Phase 4.2 — Badge |
| #86 | Phase 4.3 — TintedGlassCard (C2) |
| #87 | Phase 4.4 — AppButton (C4) |
| #88 | Phase 4.5 — Sidebar (S5) |
| #89 | Phase 4.6 — Calendar + Weekly (S1 + S11) |
| #90 | Phase 4.7 — Vacancies (S2) |
| #91 | Phase 4.8 — Pending (S3, a maior dívida — 77 violações) |
| #92 | Phase 4.9 — Profile (S4) |
| #93 | Phase 4.10 — Reports + Admin (S12) |
| #94 | Phase 4.11 — Cleanup batch (C5: GlassCard, TopBar, ScreenGradient, Buttons) |
| #95 | Phase 4-final — Legacy alias cleanup em `theme.ts` |
| #97 | Phase 4.12 — MonthCalendar + create/edit-shift (C3 + S7) |
| #98 | Phase 4.13 — Swap flows (S14: request-swap + approve-swaps) |
| #99 | Phase 4.14 — Login + onboarding (S6 + S13) |
| #100 | Phase 4.15 — Final screens (S8 + S9 + remanescentes) |

**Validação final:** `grep -rnE 'rgba\(|#[0-9A-Fa-f]{3,8}' app/ components/` → **0 literais**.

Todo design system unificado. Para mudar identidade visual hoje basta
editar `lib/theme.ts` — todas as ~30 telas e ~15 componentes propagam
automaticamente.

---

## Decisões abertas (continuação de Phase 2)

Coisas que aparecem aqui mas Phase 2 deixou em aberto — vão para
discussão durante Phase 4:

1. **Animações** — easing curve, duração default. Definir antes de
   refatorar Modal/Drawer.
2. **Stroke-width Lucide** (1.5 vs 2). Definir antes de refatorar
   Sidebar (cheio de ícones).
3. **Density toggle desktop** — Phase 2 deixou pra pós-piloto;
   Phase 4 não introduz.
4. **Sidebar dark vs light** — preview HTML usa dark; spec Phase 2
   também. Confirmação do PO antes de refatorar `_layout.tsx`.

---

## Próximos passos

1. **Você lê este documento** e responde "aprovado" ou pede revisões
   de prioridade ou escopo.
2. Após aprovação, **Phase 4** começa pelos itens (1) e (2) da
   recomendação — cleanup global de brand legado e refator dos
   componentes-core.
3. Cada PR de Phase 4 vem com reviewer pass obrigatório.

**Não inicio Phase 4 sem sua aprovação.** Skill `/ui-design` exige.

---

**Fim da Phase 3.**
