# Capacidade por turno — V1

## Regra do produto

Um turno é um intervalo real de uma escala. Médicos adicionais são alocações no mesmo turno, não novos turnos com nomes diferentes. Manhã, tarde e noite continuam sendo modelos de horário; cada escala define sua própria necessidade por dia da semana.

- Capacidade configurável entre 1 e 1000 profissionais por turno. O teto é técnico, não uma recomendação clínica.
- A regra pertence ao `scheduleContextId`, nunca ao nome do hospital, setor ou especialidade.
- Novos turnos: capacidade explícita na criação > regra semanal do intervalo > padrão 1.
- Cópias: regra semanal do destino > capacidade registrada na origem. Para origem histórica sem capacidade, o fallback é o maior entre 1 e o número de alocações ativas da origem.
- Alterar a regra semanal afeta **somente turnos gerados depois**. Alterar um turno existente exige edição explícita e as guardas mensais atuais.
- Vagas restantes = capacidade − alocações ativas, no mínimo zero. Solicitações pendentes ativas reservam lugar. Rejeição ou remoção libera esse lugar.
- Alocações de profissionais indisponíveis para exibição também contam. Ocultar um cadastro não abre uma vaga.
- `status` mantém sua função anterior de estado das alocações. Um turno `OCUPADO` pode ter vagas restantes; consumidores devem usar `remainingCapacity`.

Exemplo configurável da anestesia, **não codificado como exceção do São Carlos**:

| Dia           | Manhã | Tarde | Noite |
| ------------- | ----: | ----: | ----: |
| Segunda       |     3 |     2 |     2 |
| Terça a sexta |     2 |     2 |     2 |
| Sábado        |     2 |     1 |     1 |
| Domingo       |     1 |     1 |     1 |

A abertura de calendário continua obedecendo aos modelos e dias aplicáveis existentes. Configurar capacidade não cria um novo modelo de horário nem ativa um dia que o calendário não gera.

## Como configurar

1. Selecionar a instituição e a escala corretas.
2. Abrir **Criar plantão** e escolher a escala.
3. Em **Profissionais necessários**, acessar **Configurar capacidade por dia da semana**.
4. Selecionar um horário, preencher os sete dias e salvar. Repetir para os demais horários.
5. Abrir/copiar o novo mês. Conferir o indicador de preenchimento, por exemplo `2/3 preenchidos`.

O campo numérico na criação permite uma exceção para aquele turno. A edição de turno não pode reduzir a capacidade abaixo das alocações ativas. A configuração semanal exige o gestor e escopo institucional já utilizados pelo sistema, revalidados na transação.

## Superfícies revisadas

| Superfície                             | Invariante / validação                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Criar e abrir mês                      | Uma linha por contexto + intervalo; capacidade registrada na criação                            |
| Replicar intervalo/calendário          | Capacidade copiada ou resolvida pela regra; origem duplicada rejeitada                          |
| Alocação direta/repetida               | Guarda central sob lock; preenchimento parcial permitido; profissional já alocado não se repete |
| Solicitação pública                    | Última vaga tem um único vencedor concorrente; pendência reserva lugar                          |
| Aprovação, substituição e troca        | Reutilizam a guarda central; identidade/qualificação/overlap continuam obrigatórios             |
| Agenda, calendário diário e contadores | Todos os profissionais do mesmo tipo são exibidos; vagas contadas por lugares restantes         |
| Divulgação de vaga                     | Turno parcialmente preenchido elegível; lotado não gera aviso                                   |
| Readiness/publicação                   | Capacidade integra a impressão digital; insuficiência gera aviso operacional                    |
| Helper de importação                   | Reutiliza intervalo independentemente do rótulo; índice único serializa concorrência            |
| Provisionamento de Sala de Recuperação | Mesma identidade por intervalo e leitura da regra semanal                                       |

O helper de importação não concede autorização nem ignora as guardas de mês: seu chamador precisa executar o fluxo canônico de alocação. Scripts antigos de seed (`scripts/seed-vacancies.ts`, `server/scripts/seed-shifts.ts`) são dados sintéticos de desenvolvimento, não interfaces homologadas de importação ou provisionamento institucional. SQL manual continua fora da garantia de autorização da API e não deve ser usado para importar escalas reais.

## Histórico e compatibilidade

`required_capacity = NULL` identifica registros anteriores à migração. Eles não são consolidados, recalculados ou preenchidos automaticamente. Um incremento só é aceito quando o turno legado está `VAGO`, tem `activeCount = 0` e a projeção é exatamente 1. Registros históricos com mais de uma alocação ativa podem ser preservados ou reduzidos, mas nunca ampliados. Turnos com capacidade explícita continuam sujeitos estritamente ao valor registrado em `required_capacity`.

A API permanece compatível enquanto toda capacidade nova continuar em 1, mas o cliente móvel anterior a esta frente não representa corretamente um turno parcialmente preenchido (`OCUPADO` com `remainingCapacity > 0`). Portanto, não configurar capacidade maior que 1 antes de disponibilizar e homologar o cliente compatível.

O índice único usa uma coluna gerada nula nos registros históricos e o contexto nos registros novos. Assim, duplicidades antigas não impedem instalar a proteção prospectiva. A API não aceita `NULL` como capacidade nova. Cópias recusam origens duplicadas e intervalos legados de mesmo início com durações divergentes: o gestor pode abrir o mês pelos modelos ou revisar a origem explicitamente. Não há deduplicação silenciosa nem remoção de médicos.

## Ativação operacional — exige autorização separada

Esta entrega prepara código e migração. Não aplica mudanças no banco real, não publica aplicação e não altera agosto ou outras escalas existentes.

1. Confirmar serviço, banco-alvo e backup recuperável; inventariar schema e eventual DDL concorrente.
2. Coordenar uma janela sem escritas de escala. O servidor antigo não entende capacidade; não deixar a versão antiga escrevendo após mudar os defaults do banco.
3. No banco explicitamente autorizado, aplicar `drizzle/migrations/manual/2026-09-09-schedule-shift-capacity.sql` pelo runner de migrations manuais. Reaplicar para provar idempotência e conferir `SHOW CREATE TABLE` de ambas as tabelas.
4. Publicar API e cliente compatíveis; só então liberar escritas. Não executar build/deploy como parte desta revisão sem aprovação.
5. Configurar as regras das escalas que serão geradas. O padrão 1 é deliberado; não inferir demanda clínica pelos cadastros.
6. Fazer teste operacional autorizado: criar turno com capacidade 2, preencher uma vaga, solicitar a última, rejeitar e conferir liberação. Verificar isolamento entre duas instituições.

Rollback não deve apagar colunas/tabelas nem dados novos. Voltar ao servidor antigo com escritas habilitadas reabre o risco de ultrapassar capacidades; interromper escritas e decidir um rollback coordenado.

## Evidência automatizada

- Testes de integração próprios cobrem dois tenants, regra semanal, preenchimento parcial, corrida pela última vaga, redução inválida, criação duplicada, cópia com rollback, repetição e importação concorrente.
- A prova de migração usa um schema temporário exclusivamente local: compara linhas e timestamps históricos antes/depois, reaplica DDL e verifica defaults, checks e índice único.
- Os fixtures legados que intencionalmente duplicam intervalos foram marcados com capacidade nula. As verificações de autorização, conflito e rastreabilidade foram mantidas.
- Sem teste visual em navegador/aparelho nem prova de implantação real nesta entrega.

Comandos locais (sempre selecionar um banco de teste descartável, nunca staging):

```sh
NODE_ENV=test TEST_DATABASE_ALLOW_DESTRUCTIVE=1 TEST_DATABASE_EXPECTED_NAME=escalas_capacity_v1_test TEST_DATABASE_DISPOSABLE_MARKER='capacity-v1-local-disposable-marker-0001' TEST_DATABASE_URL='mysql://root:root@127.0.0.1:3306/escalas_capacity_v1_test' pnpm test:prepare-database
NODE_ENV=test TEST_DATABASE_ALLOW_DESTRUCTIVE=1 TEST_DATABASE_EXPECTED_NAME=escalas_capacity_v1_test TEST_DATABASE_DISPOSABLE_MARKER='capacity-v1-local-disposable-marker-0001' TEST_DATABASE_URL='mysql://root:root@127.0.0.1:3306/escalas_capacity_v1_test' pnpm exec vitest run
CAPACITY_MIGRATION_TEST_URL='mysql://root:root@127.0.0.1:3306/' pnpm exec vitest run --config vitest.capacity-migration.config.ts
pnpm exec vitest run --config vitest.pure.config.ts
pnpm typecheck
pnpm lint
git diff --check
```

A recomposição foi feita sobre `main` em `2921a426c2511cf029d06b795b47268a2f411f16`, preservando as cercas de push/badge das #437/#439 e o entitlement da #442. A migração possui preflight e postflight fail-closed para tipos, defaults, coluna gerada, índices, chaves estrangeiras e checks; instalações parciais ou objetos homônimos incompatíveis são recusados antes de qualquer DDL desta frente.

A suíte canônica com MySQL passou integralmente (302 arquivos / 3162 testes / 7 ignorados). A suíte `vitest.pure.config.ts` ainda tem 2 falhas em `whatsapp-ready-for-nl-fail-closed.test.ts`; elas foram reproduzidas sem esta frente em worktree detached do mesmo `main` 2921a426 e não podem ser mascaradas numa PR de capacidade.
