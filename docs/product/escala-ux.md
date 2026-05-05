# Escala — especificação de produto e UX

> Status: rascunho consolidado a partir das conversas de 2026-05-05.
> Este documento é o **contrato de produto** — UI mockups, PRs de backend
> e features novas devem referenciá-lo. Contradições aqui devem ser
> resolvidas antes de implementação.

## Sumário

1. [Posicionamento e vocabulário](#1-posicionamento-e-vocabulário)
2. [Hierarquia de papéis (RBAC)](#2-hierarquia-de-papéis-rbac)
3. [Mapa de telas — atual vs futuro](#3-mapa-de-telas--atual-vs-futuro)
4. [Especificação por tela](#4-especificação-por-tela)
5. [Modalidade e forma de produção](#5-modalidade-e-forma-de-produção)
6. [Fluxos de cessão e troca](#6-fluxos-de-cessão-e-troca)
7. [Regras de negócio](#7-regras-de-negócio)
8. [Prioridades de implementação — piloto Unimed](#8-prioridades-de-implementação--piloto-unimed)
9. [Pendências de decisão](#9-pendências-de-decisão)

---

## 1. Posicionamento e vocabulário

O Escala é uma **plataforma de gestão de escala para qualquer serviço
hospitalar**, não um produto exclusivo de anestesia. Cooperativas de
anestesia (caso da Coopanest) e serviços de hospitais individuais
(caso da Unimed Fortaleza) são casos concretos, mas o produto deve
servir cirurgia geral, intensivismo, enfermagem, fisioterapia, técnicos
e qualquer outra categoria com escala de plantão.

### Termos canônicos

| Termo | Significado | Antônimos a evitar |
|-------|-------------|---------------------|
| **Profissional** | Pessoa com login no sistema que pode ser escalada para um plantão. | Anestesista (categoria, não termo do produto) |
| **Especialidade / cargo** | Categoria que o profissional preenche no cadastro. Texto livre. Exemplos: "Médico Anestesiologista", "Médico Cirurgião Geral", "Enfermeiro", "Técnico em Enfermagem". | — |
| **Plantão** | Janela de tempo (ex: 7h-19h) em um setor onde 1 ou mais profissionais estão escalados. | Turno (ambíguo — usar "turno" só pra manhã/tarde/noite) |
| **Setor** | Unidade funcional dentro de um hospital. Estrutura plana (não recursiva). Ex: Centro Cirúrgico, UTI, Sala de Recuperação. | — |
| **Hospital** | Unidade física. Vinculado a uma Instituição. | — |
| **Instituição** | Pessoa jurídica que opera o sistema. Pode ter múltiplos hospitais. | "Empresa", "tenant" (ambíguo) |

A UI **nunca** diz "anestesista" hardcoded. Sempre "profissional" no
texto da interface; a especialidade aparece quando o cadastro do
profissional a preencheu.

---

## 2. Hierarquia de papéis (RBAC)

### Níveis

| Papel (`userRole`) | Nome | Escopo | Pode |
|---------------------|------|--------|------|
| `USER` | Profissional comum | Self | Ver e operar **seus próprios** plantões. Solicitar/aceitar troca/cessão. |
| `GESTOR_MEDICO` | **Gestor local** | Setor(es) e/ou hospital(ais) específicos via `manager_scope` | Tudo de USER + criar plantões, aprovar conflitos, ver Solicitações e Plantões em aberto **dentro do escopo** |
| `GESTOR_PLUS` | **Gestor mestre** | Toda a Instituição | Tudo de GESTOR_MEDICO + configurar default filter do Radar + acesso a relatórios de toda instituição |

### Implementação atual

O schema já suporta os 3 níveis (`professionals.userRole`,
`professional_institutions.roleInInstitution`, `manager_scope`).
Frente 1 (autorização tenant) consolidou isso. Não precisa schema novo.

---

## 3. Mapa de telas — atual vs futuro

### Estrutura atual (a refazer)

```
Início (dashboard genérico)         ← REMOVER
Agenda (calendário mensal)          ← MANTER, expandir com toggle Mês/Semana e Todos/Meus
Semanal (visão semanal isolada)     ← REMOVER (vira toggle dentro de Agenda)
Dashboard                           ← MANTER mas reposicionar
Pendentes                           ← RENOMEAR para Solicitações
Vagas                               ← RENOMEAR para Plantões em aberto
Relatórios                          ← MANTER (escopo separado)
Admin                               ← MANTER (config institucional)
Perfil                              ← MANTER
```

### Estrutura futura (alvo)

```
Agenda (root, default route)        ← Calendário mensal/semanal + toggle Todos/Meus
Radar de Plantões                   ← VISÃO MULTI-HOSPITAIS (NOVO ou expansão)
Solicitações                        ← (renomeado de Pendentes) Trocas e cessões
Plantões em aberto                  ← (renomeado de Vagas) Plantões sem profissional
Relatórios                          ← (sem mudança imediata)
Admin                               ← Configurações da instituição (gestor mestre)
Perfil                              ← Dados pessoais e troca de senha
```

A rota raiz (`/`) abre direto na **Agenda**. Não há mais "Início" como
tela intermediária.

---

## 4. Especificação por tela

### 4.1 Agenda

**Quem acessa:** todos.

**Conteúdo:**

- Calendário grande, default mensal.
- Cada dia mostra **3 marcadores de turno** (manhã / tarde / noite),
  com indicação visual de plantões alocados vs em aberto.
- Click em um dia → painel inferior com a lista de plantões daquele
  dia.

**Toggles no topo da tela:**

| Toggle | Opções | Default |
|--------|--------|---------|
| Visão | Mês / Semana | Mês |
| Escopo | Todos / Meus | Todos para gestor; Meus para USER |

**Filtros (laterais ou em cascata no topo):**

- Setor (default: todos do hospital ativo)
- Hospital (apenas se a instituição tem >1; default: hospital ativo)
- Modalidade (Plantão / Sobreaviso / ambos)

### 4.2 Radar de Plantões

**Quem acessa:** todos. **Filtros disponíveis variam por papel:**

- USER: filtros básicos (período, hospital, modalidade).
- GESTOR_MEDICO: tudo de USER + filtro por profissional dentro do escopo.
- GESTOR_PLUS: todos os filtros + capacidade de configurar o **default
  filter** que se aplica para os outros usuários (ex: ocultar
  hospitais privados do view padrão; o usuário pode remover o filtro
  default mas começa com ele aplicado).

**Conteúdo:**

- Calendário compacto, mensal por padrão. Cada dia exibe **3 marcadores
  de turno** (manhã/tarde/noite) com agregação numérica (ex: "manhã:
  47 plantões em 12 hospitais").
- Click em (dia + turno) → coluna abaixo do calendário lista todos os
  profissionais escalados naquele recorte específico, agrupados por
  hospital → setor.

**Volume:** com Coopanest cheia (~800 profissionais × 30 hospitais ×
3 turnos × 30 dias) o calendário não pode carregar tudo de uma vez. O
endpoint de calendário retorna apenas agregados por dia/turno; o
endpoint de detalhe é chamado sob demanda no click. Cache de 60s.

### 4.3 Solicitações (renomeado de "Pendentes")

**Quem acessa:** todos.

**Conteúdo:** lista das solicitações de **troca** e **cessão** que
envolvem o usuário logado, em qualquer dos lados (solicitante ou
candidato). Filtros de estado (aguardando, aprovada, recusada).

Gestor (médico ou plus) **vê** as solicitações de seu escopo mas
**não precisa aprovar** trocas/cessões — a aprovação é do dono do
plantão original. Veja [§6](#6-fluxos-de-cessão-e-troca).

### 4.4 Plantões em aberto (renomeado de "Vagas")

**Quem acessa:** USER (para se candidatar) e gestores (para gerenciar).

**Conteúdo:** plantões que **foram criados mas não têm nenhum
profissional alocado**. Filtros por hospital, setor, modalidade,
período.

Profissional comum vê os plantões em aberto que pode preencher e se
candidata. Gestor pode alocar diretamente.

### 4.5 Dashboard

**Quem acessa:** gestores (GESTOR_MEDICO ou GESTOR_PLUS).

**Conteúdo:** indicadores agregados:
- Plantões em aberto na próxima semana.
- Solicitações de troca pendentes.
- Profissionais com 3 plantões consecutivos de 12h (alerta — ver §7).
- Métricas operacionais conforme evolução.

USER **não precisa** desta tela — não traz valor. A navegação não
expõe Dashboard para USER.

### 4.6 Admin

**Quem acessa:** GESTOR_PLUS (mestre) apenas.

**Conteúdo:**
- Cadastro/edição de hospitais e setores.
- Configurações da instituição (default filter do Radar, etc.).
- Gestão de usuários e papéis.

### 4.7 Perfil

**Quem acessa:** todos (próprio perfil).

**Conteúdo:** dados pessoais, especialidade/cargo, troca de senha,
preferências de notificação (futuro).

---

## 5. Modalidade e forma de produção

### Estrutura de campos no plantão

Hoje, `shifts.templateName` é texto livre ("Plantão", "Sobreaviso").
**Não suporta filtragem nem cálculo financeiro.** Vamos estruturar:

| Campo (novo) | Tipo | Valores |
|--------------|------|---------|
| `modality` | enum | `PLANTAO`, `SOBREAVISO` |
| `coverage_type` | enum nullable | `URGENCIA_EMERGENCIA`, `ELETIVAS` (apenas para `PLANTAO`) |
| `payment_model` | enum | `FIXO`, `FIXO_PRODUTIVIDADE_TETO`, `FIXO_PRODUTIVIDADE_SEM_TETO`, `PRODUTIVIDADE_PURA` |
| `productivity_cap_brl` | number nullable | Teto da produtividade quando aplicável |

### Cenários reais

**Coopanest (cooperativa de anestesia, 30 hospitais):**

| Plantão | Modalidade | Cobertura | Pagamento |
|---------|------------|-----------|-----------|
| Plantão noturno UTI Hospital A | `PLANTAO` | `URGENCIA_EMERGENCIA` | `FIXO` |
| Plantão diurno cirurgia eletiva Hospital B | `PLANTAO` | `ELETIVAS` | `FIXO_PRODUTIVIDADE_SEM_TETO` |
| Sobreaviso Hospital C | `SOBREAVISO` | — | `FIXO_PRODUTIVIDADE_SEM_TETO` |
| Sobreaviso Hospital D | `SOBREAVISO` | — | `PRODUTIVIDADE_PURA` |

**Unimed Fortaleza (caso piloto, 1 hospital):**

| Plantão | Modalidade | Cobertura | Pagamento |
|---------|------------|-----------|-----------|
| Plantão CC anestesia | `PLANTAO` | `URGENCIA_EMERGENCIA` | `FIXO_PRODUTIVIDADE_SEM_TETO` |
| Sobreaviso anestesia | `SOBREAVISO` | — | `PRODUTIVIDADE_PURA` |
| Plantão Sala de Recuperação | `PLANTAO` | — | `FIXO` |
| Plantão Setor de Imagem | `PLANTAO` | — | `FIXO` |

### Cálculo financeiro real

**Fora do escopo do piloto.** Por enquanto:
- Os campos de modalidade/payment são **estrutura informacional** —
  aparecem na UI ao criar plantão, ficam no banco, são exportáveis.
- O cálculo automático de valor a pagar (somar fixo + produtividade
  com teto, etc.) vira frente própria depois do go-live.

### Múltiplos contratos por profissional (mesmo profissional, modelos
diferentes em hospitais diferentes)

**Fora do escopo do piloto.** O cenário Coopanest exige isso (Dr.
Silva tem contrato fixo na Unimed CC e contrato produtividade na
Coopanest hospital X). Resolveremos depois com tabela
`professional_contracts` ou similar; por enquanto, cada plantão usa o
`payment_model` declarado no plantão para todos os alocados.

---

## 6. Fluxos de cessão e troca

### Definições

| Termo | Significado |
|-------|-------------|
| **Cessão** | Profissional A passa o plantão para B sem receber nada em troca. B aceita, plantão fica de B. |
| **Troca** | Profissional A oferece o plantão X dele em troca do plantão Y de B. Se ambos aceitam, A passa a ter Y e B passa a ter X. |

### Fluxo da cessão

1. Profissional **A** abre seu plantão e clica em "Ceder".
2. A escolhe se a oferta fica visível para todos os profissionais do
   setor ou só para um indivíduo específico.
3. Profissional **B** vê a oferta em sua aba Solicitações e
   **candidata-se**.
4. **A aprova** a candidatura.
5. Cessão se efetiva: o plantão é reatribuído de A para B.
6. Sistema dispara notificação para o gestor (apenas log/auditoria,
   não para aprovação).

### Fluxo da troca

1. Profissional **A** abre seu plantão e clica em "Trocar".
2. A escolhe um plantão alvo (ou define critérios) e indica o que
   quer em troca.
3. Profissional **B** vê a oferta e candidata-se com seu plantão
   compatível.
4. **A aprova** a troca.
5. Troca se efetiva: A fica com o plantão de B, B com o de A.
6. Sistema dispara notificação para o gestor (apenas log/auditoria).

### Aprovação não passa pelo gestor

A aprovação é **inteiramente entre A e B**. Gestor mestre/local
**vê** o histórico (transparência) mas não bloqueia.

**Implicação técnica:** o `swap-router` atual usa
`assertCanManageInstitutionSchedule` na aprovação — esse gate sai. A
aprovação passa a ser **a quem ofertou o plantão original**.

### Validação automática

Toda cessão/troca **verifica as regras de §7** antes de efetivar. Se
a operação violar alguma das regras hard, a cessão/troca é
**rejeitada automaticamente** com mensagem explicativa para A e B.
Gestor pode ser notificado mas não há aprovação manual.

---

## 7. Regras de negócio

### Regras hard (bloqueiam a operação)

| ID | Regra | Aplicação |
|----|-------|-----------|
| H1 | **Um profissional não pode ter 2 plantões simultâneos** (qualquer modalidade). | Validar em: criação de plantão, alocação, aceite de cessão, aceite de troca. |
| H2 | Sobreaviso conta como plantão para H1 — quem está de sobreaviso não pode ter outro plantão simultâneo. | Mesma validação. |
| H3 | Cessão e troca **não podem resultar** em violação de H1/H2. | Validar antes de efetivar. |

### Regras soft (alertam, não bloqueiam)

| ID | Regra | Implementação |
|----|-------|---------------|
| S1 | **3 plantões consecutivos de 12h** (ex: dia 7-19h, noite 19-7h, dia 7-19h = 36h seguidas) → **alertar gestor**, não bloquear. | Validar ao criar/alocar 3º plantão; emitir notificação. |

### Sem regras

| Categoria | Status |
|-----------|--------|
| Limite de plantões por mês por profissional | Sem regra |
| Permissão por especialidade (anestesista só em CC, etc.) | Sem regra (futuro, com modelagem de especialidade estruturada) |
| Tempo mínimo entre plantões | Sem regra (S1 cobre indiretamente) |

---

## 8. Prioridades de implementação — piloto Unimed

Os 40 anestesistas (especialidade "Médico Anestesiologista") da
cooperativa Unimed Fortaleza começam a usar o sistema em breve. Para
isso:

### Antes do go-live (bloqueante)

| # | Frente | Tipo | Justificativa |
|---|--------|------|---------------|
| 1 | Renomes (Pendentes→Solicitações, Vagas→Plantões em aberto) | UX | Linguagem clara antes de instruir 40 pessoas |
| 2 | Início → redirect para Agenda | UX | Navegação simplificada |
| 3 | Mês/Semana toggle na Agenda | UX | Casos de uso reais cobertos |
| 4 | "Meus" toggle na Agenda | UX | Profissional vê só os seus por default |
| 5 | Hard blocker H1/H2 (plantão simultâneo) | Backend + UX | **Segurança operacional** — sem isso, escala pode ficar inválida |
| 6 | Cessão/troca sem aprovação de gestor (H3 valida) | Backend + UX | Workflow real declarado pelo PO |
| 7 | Modalidade estruturada (campos novos, sem cálculo $) | Schema + UX | Dados certos no banco; cálculo financeiro vem depois |
| 8 | Light-theme contrast nas demais telas (edit-shift, login, etc.) | UI | Telas hoje invisíveis em algumas situações |

### Depois do go-live (não-bloqueante)

| # | Frente | Tipo |
|---|--------|------|
| A | Soft alert S1 (3 plantões consecutivos de 12h) | Backend + notificação |
| B | Radar de Plantões com volume Coopanest | Backend + UX (escala) |
| C | Default filter do Radar pelo gestor mestre | Backend + UX |
| D | Cálculo financeiro real (FIXO + produtividade com teto) | Backend grande |
| E | Múltiplos contratos por profissional | Schema + Backend grande |
| F | Estruturar especialidade como enum / tabela | Schema + UX |
| G | App mobile (TestFlight + Play Store) | Build pipeline |

---

## 9. Pendências de decisão

Itens marcados aqui ainda precisam ser definidos antes do
implementador começar.

| ID | Pendência | Status |
|----|-----------|--------|
| D1 | Bundle ID definitivo (`com.unimedfortaleza.escalas` vs `app.escalas` vs outro) | Pendente — discutir |
| D2 | Domínio próprio para staging (ainda em `*.onrender.com`) | Pendente — discutir |
| D3 | Conteúdo da tela Dashboard para gestor (lista de indicadores específicos) | Pendente — após go-live |
| D4 | Email transacional (provedor: SMTP próprio? Resend? SendGrid?) | Pendente — antes do magic-link |
| D5 | Política de retenção de logs e dados (LGPD) | Pendente — antes de produção real |
| D6 | Mockups do Claude Design para telas refeitas (Agenda, Radar, Solicitações) | Pendente — você gera no Claude Design |

---

## Histórico

- **2026-05-05** — versão inicial consolidando conversas dos últimos
  dias sobre redesign de UX, modalidade, fluxos de troca/cessão e
  prioridades do piloto Unimed.
