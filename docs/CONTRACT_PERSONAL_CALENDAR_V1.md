# Contrato V1 — Agenda pessoal

Status desta frente: **fundação persistente, motor temporal, API account-wide e
interface mobile ativos no código**. O servidor oferece CRUD privado, consulta
por janela e prévia de conflitos; a tela Agenda permite criar, editar e excluir
itens. Ainda não há worker de lembretes, integração externa, deploy ou migration
em ambiente real nesta entrega.

## Limites do domínio

- A Agenda pessoal pertence à conta (`users.id`) e acompanha o usuário entre
  todas as suas instituições.
- Não existe `institution_id`, `professional_id`, `hospital_id`, `sector_id`
  ou `schedule_context_id` no domínio pessoal.
- Papel, `manager_scope`, `professional_access`, especialidade e entitlement
  institucional nunca autorizam leitura de compromisso privado.
- `CROSS_SCHEDULE_ROSTER_VIEW` governa somente a leitura institucional de
  escalas. Não amplia nem restringe a Agenda pessoal.
- O cliente nunca envia um `ownerUserId` confiável. Os writers o derivam de
  `ctx.user.id` por `sessionProcedure`.

## Entidades

### `personal_calendar_items`

Registro privado com três formatos mutuamente exclusivos:

- `APPOINTMENT`: intervalo com início e fim; pode bloquear horário.
- `REMINDER`: data ou instante pontual; nunca bloqueia horário.
- `BIRTHDAY`: dia/mês, ano opcional, dia inteiro; nunca bloqueia horário.

Disponibilidade é obrigatória na persistência: os writers gravam
`BUSY` ou `FREE` para compromisso e sempre `FREE` para lembrete/aniversário. O
banco não possui um default ambíguo capaz de transformar silenciosamente um
tipo no outro.

`client_mutation_id` é único por conta e torna o create idempotente. Título,
local e anotações são dados pessoais e não podem ir para logs operacionais,
push de gestor ou cache persistente do React Query.

Uma repetição do mesmo `client_mutation_id` deve devolver o resultado da
primeira operação, inclusive quando o item estiver soft-deleted; nunca deve
criar um segundo item silenciosamente. Hard-delete individual não faz parte do
contrato. A remoção física existe somente na purga integral da conta.

Localização já admite um par opcional `provider + external_id` e coordenadas.
Esses campos são apenas dados do compromisso; não concedem autoridade e não
ativam Google Maps nesta frente.

### `personal_calendar_recurrences`

Regra 1:1 opcional para compromisso ou lembrete. O contrato aceita somente
frequências `DAILY`, `WEEKLY`, `MONTHLY` e `YEARLY`, intervalo de 1 a 100 e
término `NEVER`, `UNTIL` ou `COUNT`. Na frequência semanal, uma máscara de
sete bits representa domingo a sábado.

RRULE arbitrária nunca será aceita do cliente. Datas mensais inexistentes
podem ser ignoradas (`SKIP`) ou ajustadas para o último dia do mês
(`CLAMP_LAST_DAY`). Aniversário é recorrência anual implícita e não precisa de
linha nesta tabela.

### `personal_calendar_alert_rules`

Um item pode ter vários avisos, expressos por minutos antes da ocorrência. O
intervalo aceito é de zero a 525.600 minutos e cobre os atalhos do produto (uma
semana, três dias, um dia, quatro horas, uma hora e trinta minutos) e valores
customizados. A regra não é uma entrega: outbox, tentativa e recibo serão
estruturas separadas. O owner é preservado por FK composta.

Avisos da Agenda pessoal serão lembretes simples. Clima, trânsito e tempo de
deslocamento pertencem exclusivamente ao aviso institucional pré-plantão e não
podem ser acionados por compromisso, lembrete ou aniversário.

### `personal_calendar_occurrences`

Projeção UTC materializada para consulta, conflito e alertas. Cada ocorrência
é ligada simultaneamente ao item e ao mesmo owner por FK composta. A chave da
ocorrência é binária/case-sensitive, única dentro da série, e o intervalo é
sempre semiaberto `[starts_at_utc, ends_at_utc)`.

A API V1 expande janelas de forma determinística em memória e reserva essa
tabela para o futuro worker de lembretes. Update e soft-delete removem qualquer
projeção materializada anterior, evitando que um worker futuro consuma uma
ocorrência obsoleta ou apagada.

### `personal_calendar_occurrence_exceptions`

Uma ocorrência de série pode ser cancelada ou substituída. Uma substituição
aponta para outro item do mesmo owner; não copia conteúdo privado para JSON.

## Regras temporais

- O item guarda data/hora civil e fuso IANA.
- Somente o motor do servidor converte a ocorrência para UTC.
- Entradas pontuais em horário inexistente ou ambíguo são recusadas. Para uma
  repetição futura que atravesse mudança de fuso, a política compatível escolhe
  o primeiro instante em uma sobreposição e avança pelo tamanho do salto em um
  horário inexistente; a ocorrência registra que sofreu ajuste. Se esse salto
  inverter o fim civil de um compromisso, o motor preserva a duração positiva
  da ocorrência original.
- A semana recorrente começa na segunda-feira. A máscara mantém o contrato de
  bits `domingo..sábado`, e `COUNT` conta ocorrências, não semanas.
- A data original ancora repetições mensais e anuais. `SKIP` não conta uma data
  inexistente; `CLAMP_LAST_DAY` usa o último dia daquele mês.
- Aniversário em 29 de fevereiro aparece em 28 de fevereiro nos anos comuns.
- Cada consulta cobre no máximo 366 dias e nunca expande uma regra sem limite
  temporal fornecido pelo chamador.
- Um compromisso colide quando `a.start < b.end AND b.start < a.end`.
- Lembretes, aniversários e compromissos com disponibilidade `FREE` não
  colidem.
- Conflito é aviso com ciência, não bloqueio de salvamento.
- Conflitos com plantões consultam apenas alocações próprias, por todas as
  identidades profissionais ligadas a `ctx.user.id`, com topologia exata.
  Nunca usam acesso amplo à escala como substituto de ownership.

## Contrato da API V1

- `getItem` e `listWindow` leem um snapshot MySQL `REPEATABLE READ`, somente
  leitura, sempre limitado ao owner derivado da sessão.
- `checkConflicts` é uma mutation deliberadamente sem escrita: o método POST
  impede datas e horários pessoais em query strings e access logs. Sua entrada
  aceita apenas os campos temporais do compromisso, sem título, local ou notas.
- `createItem` é idempotente por `owner + clientMutationId`.
- `updateItem` e `deleteItem` exigem versão otimista. Todas as escritas relêem
  `sessionVersion` sob lock antes de alterar dados.
- A consulta privada nunca é persistida no cache em disco do React Query e não
  devolve notas na listagem; notas permanecem disponíveis somente no detalhe.
- Janelas, fontes, ocorrências e comparações possuem limites explícitos. Excesso
  falha por inteiro, sem resposta parcial.
- Exceções de recorrência ainda não implementadas falham fechado em vez de
  serem silenciosamente ignoradas.
- A exclusão da conta purga o agregado pessoal na mesma transação; troca ou
  reset de senha preservam a Agenda.

## Gates de ativação

1. Concluído: motor de recorrência limitado, determinístico e testado em fuso
   IANA.
2. Concluído: CRUD somente por `sessionProcedure`, com owner derivado da sessão,
   idempotência de create e versão otimista em update/delete.
3. Concluído: purga explícita no fluxo atual de soft-delete da conta; writers
   não podem executar hard-delete de um item isolado.
4. Concluído: bloqueio de persistência em disco no `query-persist-policy`.
5. Concluído: leitor canônico de plantões próprios e testes entre instituições.
6. Pendente: outbox pessoal sem `institution_id`, worker durável, retry, lease, dedupe e
   revalidação da conta antes de qualquer push.
7. Concluído: UI privada e resiliente; falha da escala, da Agenda pessoal ou
   dos feriados tem estado próprio e não se apresenta como agenda vazia.
8. Pendente: integrações externas de Google Calendar e Google Maps,
   condicionadas a consentimento e credenciais próprias.

## Integrações futuras

- Google Calendar: adaptador separado com OAuth por usuário, binding externo,
  cursor incremental e idempotência. Nenhuma credencial pertence ao item.
- Google Maps: Place ID e coordenadas podem preencher os campos já previstos;
  o texto do local continua sendo a apresentação canônica para o usuário.
- Feriados são dados auxiliares de leitura. Falha dessa consulta nunca impede
  consultar ou editar a Agenda pessoal.
- Clima, trânsito e deslocamento ficam fora deste domínio. Eles poderão compor
  exclusivamente o aviso institucional pré-plantão, nunca itens pessoais.

O núcleo da Agenda pessoal é basal. Esta fundação não altera a classificação
comercial da sincronização Google documentada para uma etapa futura.
