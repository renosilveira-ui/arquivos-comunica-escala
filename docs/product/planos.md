# Planos — Grátis, Lite, Lite+, Pro e Pro Intelligence

> Status: **rascunho de produto** consolidado das decisões do PO em
> 23/08/2026 (quatro rodadas — a 4ª, de 23/08 à noite, reestruturou os
> planos em Grátis / Lite / Lite+ / Pro / Pro Intelligence e é a que vale;
> o histórico das rodadas anteriores fica no git). Este documento é o contrato dos planos: o que cada pessoa
> vê em cada plano, os limites e como o servidor decide. Contradições
> aqui devem ser resolvidas antes de implementar. Complementa
> [escala-ux.md](./escala-ux.md) (produto) e o sistema de UI.

## Sumário

1. [Quem paga](#1-quem-paga)
2. [Os três planos da instituição](#2-os-três-planos-da-instituição)
3. [Matriz por pessoa: profissional × gestor](#3-matriz-por-pessoa-profissional--gestor)
4. [Plano individual do profissional](#4-plano-individual-do-profissional)
5. [Limites e o que acontece quando estouram](#5-limites-e-o-que-acontece-quando-estouram)
6. [Regras de combinação](#6-regras-de-combinação)
7. [Como o app mostra o que está fora do plano](#7-como-o-app-mostra-o-que-está-fora-do-plano)
8. [Modelo técnico](#8-modelo-técnico)
9. [Plano de implementação por PR](#9-plano-de-implementação-por-pr)
10. [Decisões pendentes](#10-decisões-pendentes)

---

## 1. Quem paga

Duas frentes, independentes:

| Quem | O que compra | Onde compra | Vale para |
|---|---|---|---|
| **Instituição** (hospital, cooperativa, serviço) | O plano do **grupo da escala**: Grátis, Lite, Lite+, Pro ou Pro Intelligence | **Contratado pelo gestor** (GESTOR_PLUS) em nome do grupo, fora das lojas: checkout web com PIX/cartão via gateway (manual no início). Uma assinatura por instituição, não por pessoa | Todos os profissionais e gestores vinculados à instituição |
| **Profissional** (usuário individual) | O **plano individual**: recursos pessoais, independentes da instituição | App Store / Google Play (compra dentro do app) | Só a conta dele, em qualquer instituição |

A **assinatura de grupo é do gestor**: quem administra a escala contrata,
recebe o aviso de limite e de vencimento, e troca de plano. Os
profissionais nunca veem preço de grupo — só o do plano individual.

A instituição compra o que é *da escala* (publicar mês, painel, vagas,
auditoria…). O profissional compra o que é *dele* (ver próximo plantão,
confirmar presença, comando de voz…) quando a instituição não cobre.
Detalhe em §4 e §6.

## 2. Os planos da instituição (4ª rodada)

| | **Grátis** | **Lite** | **Lite+** | **Pro** | **Pro Intelligence** |
|---|---|---|---|---|---|
| Profissionais ativos | até **30** | até **80** | ilimitado | ilimitado | ilimitado |
| Preço **por usuário/mês** | R$ 0 | **R$ 12,90** | **R$ 14,90** | **R$ 24,90** | **R$ 24,90 + 4,90** (Pacote Intelligence) |
| Preço **por gestor/adm/mês** | R$ 0 | **R$ 6,90** | **grátis** | **grátis** | **grátis** |
| Agenda | **anônima**: o dia mostra só *ocupado/vago* — **não mostra quem** está no plantão | com nomes, qualquer dia | idem | idem | idem |
| Push de ofertas de troca | **não** (a oferta existe, mas sem notificação) | ✓ | ✓ | ✓ | ✓ |
| Trocas e cessões entre colegas | ✓ | ✓ | ✓ | ✓ | ✓ |
| Criar/editar/alocar plantão; aprovar auto-cadastro (gestor) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Faixa Próximo plantão · Confirmação de presença · Replicar/publicar/bloquear mês | — | ✓ | ✓ | ✓ | ✓ |
| **Vagas com candidatura aprovada** · **Relatórios** · **Auditoria** · Integração **Google Agenda** (tarefa futura) | — | — | ✓ | ✓ | ✓ |
| **Multi-hospital** · **Painel** · **Solicitações** do gestor · Admin de usuários · Panorama hospital × dia | — | — | — | ✓ | ✓ |
| **Pacote Intelligence**: comando de voz · integração WhatsApp · SSO/Comunica+ | — | — | — | — | ✓ |

### 2.1 Pacote Intelligence (add-on)

**R$ 4,90 por usuário/mês** sobre o Pro (Pro + pacote = "Pro
Intelligence"). Conteúdo: comando de voz, troca de plantão pelo canal do
app no **WhatsApp** e **SSO/Comunica+**. Custo variável por usuário
≈ R$ 0,25–1,40 (§9.1) → margem do pacote 70–95 %.

Aberto (§10): o pacote pode ser contratado sobre Lite/Lite+? E **PDF
executivo** e **importação de escala por padrão** (2ª rodada) não foram
citados na 4ª — proposta: entram no **Pro** (ferramentas de gestor).

## 3. Matriz por pessoa: profissional × gestor

> A matriz abaixo foi escrita na 1ª rodada com três planos; na 4ª ela se
> reparte assim: o bloco "Lite" continua o Lite; do bloco "Intelligent",
> **Vagas + Relatórios + Auditoria** descem para o **Lite+**, **multi-
> hospital + Painel + Solicitações + Admin** ficam no **Pro**, e **voz +
> WhatsApp + SSO/Comunica+** viram o **Pacote Intelligence**. No Grátis,
> além do já listado, a agenda é **anônima** (sem nomes) e não há push de
> ofertas.

O que importa para o produto é **o que cada pessoa vê**. Abaixo, por
plano, o que aparece para o profissional comum (`USER`) e para o gestor
(`GESTOR_MEDICO` / `GESTOR_PLUS`). Tudo o que não está listado fica
**escondido ou marcado como "no plano X"** (§7).

### Grátis

| Profissional comum | Gestor |
|---|---|
| Agenda: lista dia-a-dia, folha de mês, Geral/Minha | Tudo do profissional |
| Detalhe do plantão | Criar, editar e cancelar plantão; alocar e desalocar profissionais |
| Trocas: ofertar (geral ou dirigida), aceitar oferta, aprovar como dono | Aprovar auto-cadastro (fila no Perfil → Gestão) |
| Minhas ofertas / Minhas candidaturas a troca | Trocar papel de usuário fica no **Pro** (admin) |
| Perfil: instituição ativa, alterar senha, notificações de mudança de escala | Barra inferior: Agenda · Trocas · Perfil (sem Vagas) |
| Barra inferior: Agenda · Trocas · Perfil | Perfil → Gestão mostra só "Cadastros pendentes" |
| Sem: faixa Próximo plantão, confirmação de presença, voz, Comunica+ | Sem: replicar/publicar/bloquear, Painel, Solicitações, relatórios, auditoria, admin |

> Lembrete de plantão local (30 min antes, notificação do próprio
> aparelho) **fica** no Grátis: não depende de servidor nem de gestor.

### Lite

Tudo do Grátis, mais:

| Profissional comum | Gestor |
|---|---|
| Faixa **Próximo plantão** (com Confirmar / Comunica+ quando aplicável) | **Replicar** semana/mês, **publicar** e **bloquear** mês — faixa "Agosto · rascunho" + Ações |
| **Confirmação de presença**: push pré-plantão, "Sim confirmo / Não poderei", indicar substituto, aceitar indicação | Recebe o aviso de auto-confirmação e de recusa sem substituto |
| Histórico das próprias confirmações no detalhe do plantão | Editar mês publicado exige motivo (guardas de mês) |

### Lite+ / Pro / Pacote Intelligence (bloco escrito na 1ª rodada como "Intelligent")

Tudo do Lite, mais — repartido na 4ª rodada como indicado em cada linha:

| Profissional comum | Gestor |
|---|---|
| **Vagas**: ver plantões em aberto e **candidatar-se** (aba Vagas na barra) — **Lite+** | **Painel** (próximos 7 dias) — **Pro** |
| **Comando de voz** — **Pacote Intelligence** | **Solicitações**: aprovar/rejeitar candidaturas e cessões — **Pro** |
| **Comunica+** (abrir logado; auto-SSO) — **Pacote Intelligence** | **Relatórios** e **auditoria** — **Lite+** |
| Ver a agenda de **vários hospitais** — **Pro** | **Admin de usuários** — **Pro** |
| **WhatsApp** para troca/cessão — **Pacote Intelligence** | **Multi-hospital** + Panorama hospital × dia — **Pro** |
| Receber o **PDF executivo** da escala publicada (proposta: **Pro**) | Gerar o **PDF executivo** (proposta: **Pro**) |
| | **Importar escala** de planilha/PDF/foto com revisão (proposta: **Pro**) |

### Resumo do que é "do usuário comum" × "do gestor"

- **Sempre do usuário comum, em qualquer plano**: agenda, detalhe,
  trocas/cessões entre colegas, perfil. No Lite ganha o *seu* plantão
  (próximo + confirmação); no Lite+ ganha as vagas; com o Pacote
  Intelligence, voz e Comunica+.
- **Sempre do gestor**: montar a escala (criar/alocar) é básico e está no
  Grátis — sem isso não existe escala. O que o gestor paga é **governança**
  (publicar/bloquear no Lite) e **operação em escala** (painel, fila de
  aprovação, relatórios e vagas no Lite+; admin e multi-hospital no Pro).

## 4. Plano individual do profissional

Um profissional pode estar numa instituição **Grátis** e querer, para si,
o que os planos pagos dão *a ele*. O plano individual (nome de trabalho:
**Escala+ Pro**, a confirmar) libera **só recursos pessoais**:

| Recurso pessoal | Grátis (sem Pro) | Com Pro |
|---|---|---|
| Faixa Próximo plantão | — | ✓ |
| Confirmação de presença | — | ✓ **se** a instituição tiver Lite+ (o fluxo envolve o gestor e o cron da instituição) — senão, só "confirmação pessoal" sem gestor (ver §10) |
| Comando de voz | — | ✓ |
| Comunica+ (abrir logado) | — | ✓ **se** a instituição tiver o Pacote Intelligence |
| Ver várias instituições/hospitais onde está vinculado | ✓ (já existe) | ✓ |
| Exportar as próprias horas do mês (PDF/CSV) | — | ✓ (novo) |

Regra: **recurso pessoal = liberado se `plano da instituição` OU `plano
individual` cobrir**. Recurso de gestor/instituição **nunca** é liberado
pelo plano individual.

Venda: compra dentro do app (App Store / Google Play), assinatura mensal
ou anual. Validação de recibo no servidor; o app só mostra o que o
servidor confirmou.

## 5. Limites e o que acontece quando estouram

| Limite | Grátis | Lite | Lite+ / Pro | Onde é checado |
|---|---|---|---|---|
| Profissionais **ativos** na instituição | 30 | 80 (Lite) | ∞ (Lite+ em diante) | Ao criar vínculo: admin cria usuário, aprova auto-cadastro, `register`. Acima do limite → erro claro: "Limite de 30 profissionais do plano Grátis. Desative alguém ou mude para o Lite." |
| Hospitais | 1 | 1 | ∞ | Ao criar hospital (admin) |
| Mês publicado/bloqueado | — | ✓ | ✓ | `shifts.publish` / `lock` |

- **Contam** só vínculos ativos (`professional_institutions.active = 1`);
  desativar libera vaga.
- **Downgrade** (Lite → Grátis com 45 ativos, ou Pro → Lite com 200): nada é apagado; ninguém é
  desativado automaticamente; **não dá para adicionar** até ficar abaixo
  do limite. Recursos do plano antigo somem na hora (faixa, confirmação)
  — o cron de confirmação ignora instituições sem Lite ou superior.
- **Trial**: Lite por 30 dias ao criar a instituição (decisão §10).

## 6. Regras de combinação

1. O **plano da instituição** vale para todos os vínculos ativos dela.
2. O **plano individual** vale para a conta do profissional em qualquer
   instituição, só para recursos pessoais (§4).
3. Um usuário com várias instituições vê, em cada uma, o plano daquela
   instituição — o app já troca de instituição ativa; o plano acompanha.
4. Gestor **não** tem plano individual de gestão: quem paga a governança é
   a instituição.
5. A instituição do piloto (Hospital São Carlos, id 4) entra como
   **Pro Intelligence** (cortesia) para nada do que já está em uso parar.

## 7. Como o app mostra o que está fora do plano

Princípio: **nunca esconder sem explicar**, e **nunca prometer sem
liberar**. Três tratamentos, escolhidos por peso:

| Situação | Tratamento | Exemplo |
|---|---|---|
| Aba inteira fora do plano | **Some da barra** (como Painel/Solicitações já somem para USER); aparece no Perfil → Gestão/Sua atividade como linha com `Badge` do plano exigido ("Lite+", "Pro") e sem chevron (toque abre a tela de planos) | Vagas no Grátis/Lite (exigem Lite+) |
| Ação dentro de uma tela | Botão fica **visível e desabilitado** com rótulo do plano ("Publicar mês · Lite") | Ações do gestor no Grátis |
| Faixa/recurso pessoal | Uma linha discreta no lugar ("Veja seu próximo plantão no Escala+ Pro") — uma vez por sessão, sem ocupar o lugar do conteúdo | Faixa Próximo plantão no Grátis |
| Limite estourado | Erro de ação com o número e a saída ("Limite de 30… desative alguém ou mude de plano") | Aprovar cadastro acima do limite |

Perfil ganha a linha **Plano** em "Conta e app": "Grátis · 18 de 30
profissionais" (gestor) ou "Escala+ Pro até 23/09" (profissional), que abre
a tela de planos. A tela de planos (nova, `app/plans.tsx`) é a única que
fala de preço; compra individual acontece nela; plano da instituição
mostra "Fale com o gestor" ou o contato comercial.

## 8. Modelo técnico

**Uma fonte de verdade: o servidor.** O app só reflete.

### Schema

```sql
ALTER TABLE institutions
  ADD plan ENUM('FREE','LITE','LITE_PLUS','PRO') NOT NULL DEFAULT 'FREE',
  ADD plan_intelligence TINYINT(1) NOT NULL DEFAULT 0,   -- Pacote Intelligence (add-on)
  ADD plan_valid_until DATETIME NULL,          -- NULL = sem vencimento (manual/cortesia)
  ADD plan_seats INT NULL,                      -- override do limite (contrato especial)
  ADD plan_source ENUM('MANUAL','GATEWAY','TRIAL') NOT NULL DEFAULT 'MANUAL';

ALTER TABLE users
  ADD individual_plan ENUM('NONE','PRO') NOT NULL DEFAULT 'NONE',
  ADD individual_plan_valid_until DATETIME NULL;

CREATE TABLE individual_subscriptions (       -- recibos das lojas
  id, user_id, provider ENUM('APPLE','GOOGLE'), product_id, original_transaction_id UNIQUE,
  status ENUM('ACTIVE','EXPIRED','REFUNDED','GRACE'), expires_at, last_event_at, raw JSON
);
```

Migrações manuais em `drizzle/migrations/manual/` (o deploy não roda
migração — aplicar no staging antes do merge, como no B3).

### Catálogo de recursos (`shared/plans.ts`, usado por servidor e app)

```ts
export type InstitutionPlan = "FREE" | "LITE" | "LITE_PLUS" | "PRO"  // + addon Intelligence por instituição;
export type Feature =
  | "next_shift" | "duty_confirmation" | "roster_publish" | "voice"
  | "vacancies_apply" | "manager_dashboard" | "manager_requests"
  | "reports" | "audit" | "admin_users" | "multi_hospital" | "comunica_sso"
  | "export_my_hours";

export const FEATURES: Record<Feature, { scope: "personal" | "institution"; minPlan: InstitutionPlan; pro?: boolean }> = {
  next_shift:          { scope: "personal",    minPlan: "LITE", pro: true },
  duty_confirmation:   { scope: "personal",    minPlan: "LITE", pro: true },
  voice:               { scope: "personal",    minPlan: "LITE_PLUS" /* ou "PRO"/addon — repartir conforme §2 */, pro: true },
  export_my_hours:     { scope: "personal",    minPlan: "LITE_PLUS" /* ou "PRO"/addon — repartir conforme §2 */, pro: true },
  comunica_sso:        { scope: "institution", minPlan: "LITE_PLUS" /* ou "PRO"/addon — repartir conforme §2 */ },
  roster_publish:      { scope: "institution", minPlan: "LITE" },
  vacancies_apply:     { scope: "institution", minPlan: "LITE_PLUS" /* ou "PRO"/addon — repartir conforme §2 */ },
  manager_dashboard:   { scope: "institution", minPlan: "LITE_PLUS" /* ou "PRO"/addon — repartir conforme §2 */ },
  manager_requests:    { scope: "institution", minPlan: "LITE_PLUS" /* ou "PRO"/addon — repartir conforme §2 */ },
  reports:             { scope: "institution", minPlan: "LITE_PLUS" /* ou "PRO"/addon — repartir conforme §2 */ },
  audit:               { scope: "institution", minPlan: "LITE_PLUS" /* ou "PRO"/addon — repartir conforme §2 */ },
  admin_users:         { scope: "institution", minPlan: "LITE_PLUS" /* ou "PRO"/addon — repartir conforme §2 */ },
  multi_hospital:      { scope: "institution", minPlan: "LITE_PLUS" /* ou "PRO"/addon — repartir conforme §2 */ },
};
export const SEAT_LIMIT: Record<InstitutionPlan, number | null> = { FREE: 30, LITE: 80, LITE_PLUS: null, PRO: null };
export const HOSPITAL_LIMIT: Record<InstitutionPlan, number | null> = { FREE: 1, LITE: 1, LITE_PLUS: 1, PRO: null };
```

`hasFeature(feature, { institutionPlan, individualPlan })`: `personal` →
plano da instituição ≥ `minPlan` **ou** (`pro` e indivíduo PRO);
`institution` → só plano da instituição. Plano vencido conta como FREE /
NONE.

### Servidor

- `server/_core/plans.ts`: `resolveEntitlements(ctx)` (plano da
  instituição ativa + plano do usuário, com validade) → guardado no
  contexto tRPC ao lado de `institutionId`.
- `requireFeature(feature)` — middleware tRPC; nega com
  `TRPCError FORBIDDEN`, `cause: { code: "PLAN_REQUIRED", feature, requiredPlan }`
  (o app lê e mostra a tela de planos, não um toast genérico).
- `assertSeatAvailable(institutionId)` e `assertHospitalAvailable` nos
  pontos de escrita (admin create, approve signup, register, hospitals.create).
- **Cron de confirmação** só dispara para instituições com `duty_confirmation`.
- `professionals.getMyCapabilities` passa a devolver
  `{ plan, individualPlan, features: Feature[], limits: { seats: { used, max } } }`.
- Endpoints de cobrança: `POST /api/billing/institution/webhook` (gateway →
  atualiza `institutions.plan`), `POST /api/billing/individual/verify`
  (recibo da loja → `individual_subscriptions` + `users.individual_plan`),
  webhooks das lojas (App Store Server Notifications v2 / Google RTDN).
- Admin interno (só `role = admin`): definir plano/validade/seats de uma
  instituição à mão (enquanto não houver gateway).

### App

- `usePlan()` (a partir de `getMyCapabilities`): `has(feature)`,
  `plan`, `seats`. `usePermissions().can(...)` continua cuidando de
  **papel**; plano é outra dimensão — as duas se combinam nas telas.
- `components/ui/PlanGate.tsx`: envolve ação/linha e renderiza o
  tratamento da §7 (desabilitado com rótulo, linha discreta, ou nada).
- `app/(tabs)/_layout.tsx`: aba Vagas e abas de gestão também condicionadas
  ao plano. `app/plans.tsx`: tela de planos (matriz + compra individual).
- Compra individual: `react-native-purchases` (RevenueCat) ou `expo-iap`;
  recibo validado no servidor; o app **nunca** libera localmente.

## 9. Plano de implementação por PR

Ordem pensada para o piloto não parar e para cada PR ser verificável:

| PR | Entrega | Risco | Verificação |
|---|---|---|---|
| **1. Catálogo + schema + cortesia** | `shared/plans.ts`, migração (`plan` FREE por padrão; São Carlos = PRO + Intelligence), `resolveEntitlements` no contexto, `getMyCapabilities` com `features` — **sem negar nada ainda** | baixo | Testes do catálogo e do contexto; app continua igual |
| **2. Guardas no servidor** | `requireFeature` nos procedures pagos (Lite/Lite+/Pro/pacote) (publish/lock/replicate, vagas apply, painel, solicitações, relatórios, auditoria, admin, voz, SSO, confirmação); `assertSeatAvailable`/hospital; cron filtrado | médio | Testes por plano (FREE nega, LITE/INTELIGENT libera); suíte completa |
| **3. App reflete o plano** | `usePlan`, `PlanGate`, abas por plano, linha Plano no Perfil, tela de planos (sem compra), erro `PLAN_REQUIRED` tratado | médio | Galeria com os três planos simulados; web staging com instituição de teste em FREE |
| **4. Admin interno de planos** | Tela/admin para definir plano, validade e seats; trial de 30 dias na criação da instituição | baixo | Teste de fluxo |
| **5. Plano individual (lojas)** | IAP, verificação de recibo, webhooks, `individual_plan`; recursos pessoais via "ou" | alto | Sandbox das lojas; build de teste (TestFlight/interno) |
| **6. Cobrança da instituição** | Gateway (PIX/boleto/cartão) + webhook → plano; e-mails de vencimento | alto | Ambiente de sandbox do gateway |

Só o PR 5 exige build nova para ser testado; 1–4 são verificáveis no web
staging e na galeria.

## 8.1 Preços (4ª rodada) e avaliação: a precificação se paga?

Preços por pessoa/mês (tabela da §2). Pontos herdados da 3ª rodada, a
**confirmar** se continuam: grupo contratado junto pelo gestor fora da
loja da Apple **−25 %**; pagamento anual **−10 %** (cumulativo).

### A conta fecha?

Custo (memória `cold-start-e-perf`): fixo da plataforma ≈ **R$ 245–310/mês**
(Render Starter + banco DO + Apple); marginal por usuário ≈ centavos
(Grátis/Lite) a ≈ R$ 0,25–1,40 (com o Pacote Intelligence).

| Cenário | Receita/mês | Custo variável | Leitura |
|---|---|---|---|
| 1 grupo Lite: 30 usuários + 2 gestores | 30×12,90 + 2×6,90 = **R$ 400,80** | ≈ R$ 1,50 | **Um único grupo Lite já paga o basal inteiro** |
| Break-even absoluto | ≈ **20–24 usuários Lite** pagantes na plataforma toda | — | — |
| 1 grupo Pro de 50 | 50×24,90 = **R$ 1.245** | ≈ R$ 5 | margem > 99 % |
| Mesmo grupo com Intelligence | 50×29,80 = **R$ 1.490** | ≈ R$ 15–70 (WhatsApp/voz/importações) | margem do add-on 70–95 % |

Sim: **se paga com folga** a partir do primeiro grupo pagante. O risco não
é custo, é conversão.

### A escada quebra a objeção?

- **"Para que pagar?"** — no Grátis a agenda é anônima: a pergunta nº 1 do
  plantonista ("**quem** está de plantão hoje?") só se responde no Lite.
  A objeção morre no primeiro dia de uso real. R$ 12,90 ≈ um lanche; e o
  decisor (gestor) paga só R$ 6,90 no Lite e **nada** do Lite+ em diante —
  quem aprova a compra não sente o preço. Desenho bom para conversão.
- **Risco do Grátis fraco**: agenda sem nomes e ofertas sem push podem
  matar a adoção orgânica (o grátis existe para semear grupos). Mitigação
  recomendada: **trial de 30 dias do Lite** para todo grupo novo — vê com
  nomes por um mês, o corte para "anônimo" vira o gatilho de assinatura.
- **Degraus**: 12,90 → 14,90 (+R$ 2: vagas/relatórios/auditoria — fácil) →
  24,90 (+R$ 10: multi-hospital/painel/solicitações — o maior salto, mas é
  valor de gestor com gestor grátis) → +4,90 (Intelligence — barato perto
  do WhatsApp/SSO). Coerente; a única emenda sugerida: deixar claro no
  checkout que o gestor deixa de pagar ao subir de plano (âncora de
  upgrade explícita).
- **Atenções**: (a) usuário comum não decide o plano do grupo — a
  comunicação do corte "anônimo" precisa mirar o gestor; (b) cobrança por
  usuário exige régua de assentos limpa (§5) e um relatório mensal simples
  para o gestor conferir a fatura; (c) o nome **"Pro"** colide com o nome
  de trabalho do plano individual ("Escala+ Pro") — renomear o individual.

### O que muda de implementação com a 4ª rodada

Além do catálogo (§8): duas capacidades novas no servidor — **agenda
anônima** no Grátis (o `listAgenda`/`getDay`/panorama mascaram
`professionalNames` e `isMine` continua; a ocupação aparece, o nome não)
e **push de ofertas condicionado ao plano** (notifications-service checa
o plano antes de enviar). O mascaramento é do SERVIDOR, nunca do app.

## 9.1 Funções do Pacote Intelligence e do Pro — escopo e custo basal

Três funções novas pedidas pelo PO na 2ª rodada. Custo **fixo** extra
≈ zero; o que muda é **variável por uso**, e uma condição: todas
precisam do servidor **acordado** (o webhook do WhatsApp tem de responder
em segundos; PDF e importação rodam no servidor) — ou seja, **Render
Starter (US$ 7/mês)** deixa de ser opcional.

| Função | Como | Custo fixo | Custo variável (estimativa) |
|---|---|---|---|
| **Troca por WhatsApp** | Canal oficial do Escala+ na **WhatsApp Cloud API** (Meta, direto, sem intermediário): o profissional manda "quero trocar meu plantão de sexta"; o servidor interpreta (o `voice.interpret` já faz isso com texto), responde com os candidatos e registra a oferta; o colega recebe a proposta no WhatsApp e responde "aceito". Exige número dedicado, verificação do negócio na Meta e aprovação dos templates. | US$ 0 na API direta (um BSP como Twilio/Zenvia cobra ~US$ 0,005/msg a mais) | Mensagens **de serviço** (o usuário iniciou, janela de 24 h) são grátis; **templates** (o app inicia: "T. Guedes propôs troca…") ≈ US$ 0,008–0,035 cada no Brasil. Grupo de 20 com ~40 trocas/mês ≈ 100 templates ≈ **US$ 1–3/mês por grupo** |
| **PDF executivo** | Gerado no servidor com `@react-pdf/renderer` ou `pdfkit` (sem Chromium — cabe na instância pequena); layout com a marca (moldura, numeral tabular); enviado por e-mail/WhatsApp ou aberto no app. Sem armazenar: gera sob demanda. | US$ 0 (se guardar histórico: DO Spaces, US$ 5/mês por 250 GB) | ≈ 0 — segundos de CPU por PDF |
| **Importar escala por padrão** | Planilha/CSV: parser determinístico, grátis. PDF/foto: leitura com modelo de visão (API da Anthropic — Claude Haiku/Sonnet) que devolve JSON estruturado; o gestor **revisa** na tela antes de gravar (nunca grava direto). | US$ 0 | ≈ **US$ 0,01–0,05 por importação** (2 páginas ≈ 3–5 mil tokens de entrada); 1–4 importações/mês por grupo ≈ centavos |

Basal consolidado com as três funções: **≈ US$ 45–55/mês fixo** (Render
Starter + banco + Apple) e **< US$ 5/mês por grupo com o pacote ativo** em
variável. O custo relevante é de **engenharia**: integração e homologação
do WhatsApp (número, verificação, templates, webhook, anti-abuso), layout
do PDF e a tela de revisão da importação (mapear nomes → profissionais,
setores e horários, com confiança por linha).

Ordem sugerida: PDF executivo (menor risco, valor
imediato para o gestor) → importação por planilha → troca por WhatsApp →
importação por PDF/foto.

## 10. Decisões pendentes

1. ~~Grafia~~ — 4ª rodada renomeou os planos: Grátis / Lite / Lite+ / Pro / Pro Intelligence.
2. **Nome do plano individual**: "Escala+ Pro"?
3. **Confirmação de presença no Pro quando a instituição é Grátis**: o fluxo
   real envolve gestor (substituto, auto-confirmação, aviso). Opções:
   (a) Pro só libera a faixa Próximo plantão e a voz; confirmação continua
   exigindo Lite da instituição (**recomendo** — simples e honesto);
   (b) "confirmação pessoal" sem gestor (só registra presença).
4. **Vagas no Grátis/Lite**: a aba some (proposta acima) ou fica visível
   só como lista "plantões em aberto" sem candidatura?
5. **Trial**: Lite por 30 dias em toda instituição nova (recomendado em §8.1)? Pro por 14 dias?
6. ~~Preços~~ — 4ª rodada na §2/§8.1 (por usuário; gestor 6,90 no Lite e
   grátis do Lite+ em diante; Pacote Intelligence 4,90).
7. **Gateway** para a instituição (Stripe Brasil, Pagar.me, Asaas…) e
   meio de pagamento mínimo (PIX).
8. **Lojas**: a compra individual exige IAP; o plano institucional vendido
   fora do app é permitido para serviços vendidos a organizações — validar
   a redação das diretrizes da Apple (3.1.3) antes da submissão.
9. Descontos da 3ª rodada (grupo −25 % fora da loja; anual −10 %)
   continuam na 4ª? (Recomendo manter.)
10. Pacote Intelligence pode ser contratado sobre Lite/Lite+ ou só Pro?
11. PDF executivo e importação de escala por padrão: entram no Pro?
12. Trial de 30 dias do Lite para grupo novo (recomendado em §8.1)?
13. Renomear o plano individual (colide com o plano "Pro" de grupo).
