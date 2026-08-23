# Planos — Grátis, Lite e Inteligent

> Status: **rascunho de produto** consolidado das decisões do PO em
> 23/08/2026. Este documento é o contrato dos planos: o que cada pessoa
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
| **Instituição** (hospital, cooperativa, serviço) | O plano do **grupo da escala**: Grátis, Lite ou Inteligent | Contrato direto (fora das lojas): PIX/boleto/cartão via gateway, ou manual no início | Todos os profissionais e gestores vinculados à instituição |
| **Profissional** (usuário individual) | O **plano individual**: recursos pessoais, independentes da instituição | App Store / Google Play (compra dentro do app) | Só a conta dele, em qualquer instituição |

A instituição compra o que é *da escala* (publicar mês, painel, vagas,
auditoria…). O profissional compra o que é *dele* (ver próximo plantão,
confirmar presença, comando de voz…) quando a instituição não cobre.
Detalhe em §4 e §6.

## 2. Os três planos da instituição

| | **Grátis** | **Lite** | **Inteligent** |
|---|---|---|---|
| Profissionais ativos | até **30** | até **60** | **ilimitado** |
| Hospitais por instituição | 1 | 1 | **multi-hospital** |
| Agenda (lista, folha de mês, Geral/Minha) | ✓ | ✓ | ✓ |
| Perfil, instituição ativa, senha | ✓ | ✓ | ✓ |
| Trocas e cessões entre colegas (dono aprova) | ✓ | ✓ | ✓ |
| Criar/editar/alocar plantão (gestor) | ✓ | ✓ | ✓ |
| Aprovar auto-cadastro (gestor) | ✓ | ✓ | ✓ |
| Faixa **Próximo plantão** | — | ✓ | ✓ |
| **Confirmação de presença** pré-plantão (push 11h/17h/22h, substituto, rechecagem) | — | ✓ | ✓ |
| **Replicar / publicar / bloquear** mês (faixa "Agosto · rascunho") | — | ✓ | ✓ |
| **Painel** do gestor (próximos 7 dias) | — | — | ✓ |
| **Solicitações** do gestor (fila de aprovação) | — | — | ✓ |
| **Vagas com candidatura** aprovada | — | — | ✓ |
| **Relatórios** e **auditoria** (movimentações) | — | — | ✓ |
| **Comando de voz** | — | — | ✓ |
| **SSO / Comunica+** (abrir logado, auto-SSO na confirmação) | — | — | ✓ |
| **Admin de usuários** (papéis, senha temporária, desativar) | — | — | ✓ |
| Panorama hospital × dia (desktop) | — | — | ✓ |

Nomes dos planos como o PO escreveu: **Grátis**, **Lite**, **Inteligent**
(grafia a confirmar — ver §10).

## 3. Matriz por pessoa: profissional × gestor

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
| Minhas ofertas / Minhas candidaturas a troca | Trocar papel só entre USER e gestor local? **Não** — papéis ficam no Inteligent (admin) |
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

### Inteligent

Tudo do Lite, mais:

| Profissional comum | Gestor |
|---|---|
| **Vagas**: ver plantões em aberto e **candidatar-se** (aba Vagas na barra) | **Painel** (próximos 7 dias: vagos, pendentes, ocupados) |
| **Comando de voz** (microfone no cabeçalho da Agenda) | **Solicitações**: aprovar/rejeitar candidaturas a vaga e cessões que exigem gestor |
| **Comunica+**: abrir logado a partir da Agenda; auto-SSO após confirmar presença | **Relatórios** e **Movimentações de plantão** (auditoria) |
| Ver a agenda de **vários hospitais** da instituição | **Admin de usuários**: criar, trocar papel, senha temporária, desativar |
| | **Multi-hospital**: cadastrar hospitais e setores além do primeiro; Panorama hospital × dia |

### Resumo do que é "do usuário comum" × "do gestor"

- **Sempre do usuário comum, em qualquer plano**: agenda, detalhe,
  trocas/cessões entre colegas, perfil. No Lite ganha o *seu* plantão
  (próximo + confirmação); no Inteligent ganha autonomia (vagas, voz,
  Comunica+).
- **Sempre do gestor**: montar a escala (criar/alocar) é básico e está no
  Grátis — sem isso não existe escala. O que o gestor paga é **governança**
  (publicar/bloquear no Lite) e **operação em escala** (painel, fila de
  aprovação, relatórios, admin, multi-hospital no Inteligent).

## 4. Plano individual do profissional

Um profissional pode estar numa instituição **Grátis** e querer, para si,
o que o Lite/Inteligent dão *a ele*. O plano individual (nome de trabalho:
**Escala+ Pro**, a confirmar) libera **só recursos pessoais**:

| Recurso pessoal | Grátis (sem Pro) | Com Pro |
|---|---|---|
| Faixa Próximo plantão | — | ✓ |
| Confirmação de presença | — | ✓ **se** a instituição tiver Lite+ (o fluxo envolve o gestor e o cron da instituição) — senão, só "confirmação pessoal" sem gestor (ver §10) |
| Comando de voz | — | ✓ |
| Comunica+ (abrir logado) | — | ✓ **se** a instituição tiver SSO configurado (Inteligent) |
| Ver várias instituições/hospitais onde está vinculado | ✓ (já existe) | ✓ |
| Exportar as próprias horas do mês (PDF/CSV) | — | ✓ (novo) |

Regra: **recurso pessoal = liberado se `plano da instituição` OU `plano
individual` cobrir**. Recurso de gestor/instituição **nunca** é liberado
pelo plano individual.

Venda: compra dentro do app (App Store / Google Play), assinatura mensal
ou anual. Validação de recibo no servidor; o app só mostra o que o
servidor confirmou.

## 5. Limites e o que acontece quando estouram

| Limite | Grátis | Lite | Inteligent | Onde é checado |
|---|---|---|---|---|
| Profissionais **ativos** na instituição | 30 | 60 | ∞ | Ao criar vínculo: admin cria usuário, aprova auto-cadastro, `register`. Acima do limite → erro claro: "Limite de 30 profissionais do plano Grátis. Desative alguém ou mude para o Lite." |
| Hospitais | 1 | 1 | ∞ | Ao criar hospital (admin) |
| Mês publicado/bloqueado | — | ✓ | ✓ | `shifts.publish` / `lock` |

- **Contam** só vínculos ativos (`professional_institutions.active = 1`);
  desativar libera vaga.
- **Downgrade** (Lite → Grátis com 45 ativos): nada é apagado; ninguém é
  desativado automaticamente; **não dá para adicionar** até ficar abaixo
  do limite. Recursos do plano antigo somem na hora (faixa, confirmação)
  — o cron de confirmação ignora instituições sem Lite+.
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
   **Inteligent** (cortesia) para nada do que já está em uso parar.

## 7. Como o app mostra o que está fora do plano

Princípio: **nunca esconder sem explicar**, e **nunca prometer sem
liberar**. Três tratamentos, escolhidos por peso:

| Situação | Tratamento | Exemplo |
|---|---|---|
| Aba inteira fora do plano | **Some da barra** (como Painel/Solicitações já somem para USER); aparece no Perfil → Gestão/Sua atividade como linha com `Badge "Inteligent"` e sem chevron (toque abre a tela de planos) | Vagas no Grátis/Lite |
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
  ADD plan ENUM('FREE','LITE','INTELIGENT') NOT NULL DEFAULT 'FREE',
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
export type InstitutionPlan = "FREE" | "LITE" | "INTELIGENT";
export type Feature =
  | "next_shift" | "duty_confirmation" | "roster_publish" | "voice"
  | "vacancies_apply" | "manager_dashboard" | "manager_requests"
  | "reports" | "audit" | "admin_users" | "multi_hospital" | "comunica_sso"
  | "export_my_hours";

export const FEATURES: Record<Feature, { scope: "personal" | "institution"; minPlan: InstitutionPlan; pro?: boolean }> = {
  next_shift:          { scope: "personal",    minPlan: "LITE", pro: true },
  duty_confirmation:   { scope: "personal",    minPlan: "LITE", pro: true },
  voice:               { scope: "personal",    minPlan: "INTELIGENT", pro: true },
  export_my_hours:     { scope: "personal",    minPlan: "INTELIGENT", pro: true },
  comunica_sso:        { scope: "institution", minPlan: "INTELIGENT" },
  roster_publish:      { scope: "institution", minPlan: "LITE" },
  vacancies_apply:     { scope: "institution", minPlan: "INTELIGENT" },
  manager_dashboard:   { scope: "institution", minPlan: "INTELIGENT" },
  manager_requests:    { scope: "institution", minPlan: "INTELIGENT" },
  reports:             { scope: "institution", minPlan: "INTELIGENT" },
  audit:               { scope: "institution", minPlan: "INTELIGENT" },
  admin_users:         { scope: "institution", minPlan: "INTELIGENT" },
  multi_hospital:      { scope: "institution", minPlan: "INTELIGENT" },
};
export const SEAT_LIMIT: Record<InstitutionPlan, number | null> = { FREE: 30, LITE: 60, INTELIGENT: null };
export const HOSPITAL_LIMIT: Record<InstitutionPlan, number | null> = { FREE: 1, LITE: 1, INTELIGENT: null };
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
| **1. Catálogo + schema + cortesia** | `shared/plans.ts`, migração (`plan` FREE por padrão; São Carlos = INTELIGENT), `resolveEntitlements` no contexto, `getMyCapabilities` com `features` — **sem negar nada ainda** | baixo | Testes do catálogo e do contexto; app continua igual |
| **2. Guardas no servidor** | `requireFeature` nos procedures Inteligent e Lite (publish/lock/replicate, vagas apply, painel, solicitações, relatórios, auditoria, admin, voz, SSO, confirmação); `assertSeatAvailable`/hospital; cron filtrado | médio | Testes por plano (FREE nega, LITE/INTELIGENT libera); suíte completa |
| **3. App reflete o plano** | `usePlan`, `PlanGate`, abas por plano, linha Plano no Perfil, tela de planos (sem compra), erro `PLAN_REQUIRED` tratado | médio | Galeria com os três planos simulados; web staging com instituição de teste em FREE |
| **4. Admin interno de planos** | Tela/admin para definir plano, validade e seats; trial de 30 dias na criação da instituição | baixo | Teste de fluxo |
| **5. Plano individual (lojas)** | IAP, verificação de recibo, webhooks, `individual_plan`; recursos pessoais via "ou" | alto | Sandbox das lojas; build de teste (TestFlight/interno) |
| **6. Cobrança da instituição** | Gateway (PIX/boleto/cartão) + webhook → plano; e-mails de vencimento | alto | Ambiente de sandbox do gateway |

Só o PR 5 exige build nova para ser testado; 1–4 são verificáveis no web
staging e na galeria.

## 10. Decisões pendentes

1. **Grafia do plano**: "Inteligent" (como escrito), "Inteligente" ou
   "Intelligent"? Recomendo **Inteligente** (português, como o resto da UI).
2. **Nome do plano individual**: "Escala+ Pro"?
3. **Confirmação de presença no Pro quando a instituição é Grátis**: o fluxo
   real envolve gestor (substituto, auto-confirmação, aviso). Opções:
   (a) Pro só libera a faixa Próximo plantão e a voz; confirmação continua
   exigindo Lite da instituição (**recomendo** — simples e honesto);
   (b) "confirmação pessoal" sem gestor (só registra presença).
4. **Vagas no Grátis/Lite**: a aba some (proposta acima) ou fica visível
   só como lista "plantões em aberto" sem candidatura?
5. **Trial**: Lite por 30 dias em toda instituição nova? Inteligent por
   14 dias?
6. **Preços** e periodicidade (mensal/anual) — fora deste documento.
7. **Gateway** para a instituição (Stripe Brasil, Pagar.me, Asaas…) e
   meio de pagamento mínimo (PIX).
8. **Lojas**: a compra individual exige IAP; o plano institucional vendido
   fora do app é permitido para serviços vendidos a organizações — validar
   a redação das diretrizes da Apple (3.1.3) antes da submissão.
