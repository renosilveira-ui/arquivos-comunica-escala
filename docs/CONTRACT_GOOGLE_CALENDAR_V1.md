# Contrato V1 — Google Agenda

**Status:** IMPLEMENTADO no código; **não verificado contra o Google real**.
**Escopo:** OAuth 2 + PKCE, vínculo por conta, exportação para calendário
dedicado, leitura incremental com tratamento de sync token expirado.

> **CODE COMPLETE / RUNTIME EXTERNAL UNVERIFIED.** Todo o motor é exercitado
> contra um provedor falso em memória (`tests/helpers/fake-calendar-provider.ts`).
> Nenhuma chamada real ao Google foi feita nesta entrega. A verificação contra
> o serviço real depende das credenciais no ambiente.

---

## 1. Autoridade — o que cada lado manda

| Objeto | Direção | Regra |
|---|---|---|
| Plantão (`DUTY_ASSIGNMENT`) | exportação read-only | editar ou apagar no Google **não altera a escala**; o ciclo seguinte recria |
| Compromisso pessoal (`PERSONAL_ITEM`) | exportação nesta frente | o usuário é dono dos dois lados; importação de volta é o incremento seguinte |
| Evento do próprio usuário | leitura | nunca vira plantão nem compromisso nosso |

"Read-only" tem consequência observável: se o médico apagar no Google o evento
de um plantão, ele **volta**. É isso que significa a escala ser a verdade
operacional e o Google ser vitrine dela. A tela diz isso ao usuário em
português, não só o contrato.

## 2. Marcador de origem — o que impede o laço

Todo evento que criamos carrega `extendedProperties.private.escalaSource =
"escala-plus:v1"`.

Sem esse marcador, um evento que exportamos voltaria na leitura seguinte como
se fosse do usuário, seria importado, reexportado, e assim indefinidamente. O
marcador é a única coisa que separa "meu eco" de "evento dele".

Na leitura, só eventos **com** o marcador e **cancelados** produzem ação nossa.
Evento alheio cancelado é assunto do usuário; reagir a ele seria invadir a
agenda dele.

## 3. OAuth — onde está a fronteira

O callback (`GET /api/integrations/google/callback`) é **público**: quem chega
vem do navegador, depois do Google, e pode não ter sessão nossa. A autoridade
não vem do cookie — vem do `state`:

- guardado como **SHA-256**, nunca em claro;
- **uso único**, garantido por `UPDATE` condicional (`consumed_at IS NULL`);
  dois callbacks com o mesmo state disputam a linha, e só um vê
  `affectedRows = 1`;
- **TTL de 10 minutos**;
- carrega o `code_verifier` do PKCE **selado** — sem ele, quem lesse a tabela
  completaria a troca de código no lugar do usuário.

O state é consumido **antes de qualquer outra decisão**, inclusive antes de
tratar `error=access_denied`. Um state que chegou ao callback foi gasto, dê no
que der — é o que impede repetir o callback para tentar de novo.

**Destino de retorno é rótulo, nunca URL.** O cliente escolhe `WEB` ou
`MOBILE`; a URL sai de `APP_PUBLIC_URL` ou do esquema do app. Aceitar URL aqui
transformaria o callback em redirecionador aberto. Quando não há base pública
confiável, a resposta é uma página de texto — não um redirecionamento para
lugar nenhum.

### Por que `prompt=consent` e `access_type=offline`

Sem os dois, o Google deixa de reemitir o refresh token em reautorizações, e o
vínculo nasce condenado: expira em uma hora e exige reconexão manual. A troca
de código **recusa** um grant sem refresh token, em vez de gravar um vínculo
que vai morrer em silêncio.

## 4. SSRF — a defesa não é sanitização

Todo endpoint é **constante de módulo**. Não existe caminho em que um valor do
cliente, do banco ou de env escolha host ou caminho. Identificadores entram
apenas por `encodeURIComponent` no path ou por query string. Há teste que lê o
fonte e falha se algum `fetch` passar a montar URL a partir de variável livre.

Toda chamada tem `AbortController` com timeout e teto de bytes na resposta.

## 5. Estado do vínculo

`CONNECTED` → `DEGRADED` → `REAUTH_REQUIRED` → `DISCONNECTED`, com a transição
em `nextExternalLinkState` (função pura, testada). Nenhum chamador decide
sozinho o que "falhou" significa.

Invariante: **falha retryável nunca desconecta nem exige reautenticação**.
`410 Gone` (sync token expirado) é estado *esperado* — zera o cursor e o ciclo
seguinte faz leitura completa. Transformar instabilidade do Google em trabalho
manual do médico seria terceirizar para ele um incidente que não é dele.

Toda transição usa CAS sobre `version`: duas abas, ou o worker e a tela ao
mesmo tempo, não sobrescrevem a decisão uma da outra.

## 6. Idempotência da exportação

`content_fingerprint` compara o que seria enviado com o que já foi. Rodar duas
vezes seguidas produz o mesmo estado e **zero escritas** na segunda — é o que
permite chamar o ciclo de um botão, de um cron e de um webhook sem coordenação,
e o que protege a cota do usuário.

Tombstones: o que sai da origem sai do Google. Sem isso, um plantão cancelado
ficaria no calendário do médico para sempre.

Um evento recriado após tombstone conta como **criado**, não atualizado — o
resumo que o operador lê não pode mentir sobre o que aconteceu.

### A armadilha do `UNIQUE` com `NULL`

`uniq_external_calendar_source` inclui `occurrence_slot`, uma coluna gerada
(`COALESCE(occurrence_key, '')`), e **não** `occurrence_key` direto. O MySQL
trata cada `NULL` como distinto em índice único, e plantão tem
`occurrence_key` nulo: com a coluna original, dois ciclos concorrentes
criariam **dois eventos** no Google para o mesmo plantão. Isso foi encontrado
rodando a migração contra MySQL de verdade, não lendo o SQL.

## 7. Privacidade

O calendário do Google é superfície fora do nosso controle.

- Título do plantão: `Modalidade · Setor · Hospital`. Nada de paciente, nada
  de conteúdo clínico. Há teste que lê o fonte e falha se isso mudar.
- `notes` do compromisso pessoal **não** é exportado.
- Refresh token selado em repouso, com AAD ligada a `userId` + escopo.
- Access token **não tem coluna**: é derivado a cada uso.
- Nenhum log registra code, state, access token ou refresh token.
- Desvincular **revoga no Google** antes de apagar o envelope — sem isso, o
  Escala+ continuaria listado como app autorizado na conta do médico.
- Excluir a conta apaga vínculo, estado OAuth e espelho (`ON DELETE CASCADE`).

## 8. Multi-instituição

A exportação é **account-wide**: a agenda do Google do médico não tem abas por
hospital, então plantões de todas as instituições dele entram no mesmo
calendário. O `WHERE` continua preso ao `user_id` — há teste com duas
instituições criadas em runtime e um plantão de terceiro que **não** pode
aparecer.

O fuso de cada evento vem do hospital, com a instituição como padrão
(`server/institution-time-zone.ts`). Uma instituição em `America/Manaus`
exporta no fuso dela, não no de São Paulo.

## 9. O que esta PR NÃO faz

- Não importa eventos do Google para a Agenda pessoal (bidirecional completa).
- Não usa eventos externos como bloco ocupado na detecção de conflito.
- Não lê o e-mail da conta vinculada (`userinfo`): o rótulo fica `null`, que é
  mais honesto do que exibir errado.
- Não tem worker periódico: a sincronização é a pedido, pelo botão. O ciclo
  automático entra junto com o motor de aviso de saída.
- Não foi verificada contra o Google real.

## 10. Variáveis

| Variável | Obrigatória |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | sim, para habilitar |
| `GOOGLE_OAUTH_CLIENT_SECRET` | sim |
| `GOOGLE_OAUTH_REDIRECT_URI` | sim; https em produção |
| `EXTERNAL_CREDENTIALS_ENCRYPTION_KEY` | sim (guarda o refresh token) |

Sem elas o provedor fica `NOT_CONFIGURED`, a tela diz "ainda não disponível" e
nenhuma linha é escrita. Preencher **pela metade** derruba o boot — ver
`docs/CONTRACT_EXTERNAL_INTEGRATIONS_V1.md` §7.

## 11. Antes de usar em ambiente real

1. Aplicar `drizzle/migrations/manual/2026-09-10-external-integrations-foundation.sql`.
2. Aplicar `drizzle/migrations/manual/2026-09-11-google-calendar-link.sql`.
3. No Google Cloud: habilitar Calendar API, criar Client ID do tipo
   *Aplicativo da Web* e registrar o redirect exato configurado na variável.
4. Preencher as quatro variáveis e reiniciar.
5. Conectar com uma conta de teste e conferir que o calendário "Escala+"
   aparece com os plantões do mês.


## Escopos — e a lição de 11/09/2026

| Escopo | Para quê |
|---|---|
| `calendar.events` | ler e escrever eventos no calendário dedicado |
| `calendar.calendarlist` | reencontrar o "Escala+" já existente na conta |
| `calendar.app.created` | **criar** o "Escala+" (`calendars.insert`) — e gerenciar só o que o app criou |

A versão anterior pedia só os dois primeiros. `calendars.insert` exige
`calendar`, `calendar.app.created` ou `calendar.calendars`; a criação falhava
com 403, `ensureCalendar` devolvia `null`, a exportação devolvia **sucesso
com zeros** e a tela dizia "Tudo já estava em dia" — para um calendário que
nunca existiu. Nada ficava registrado no vínculo.

Três travas, independentes:

1. `canCreateDedicatedCalendar(grantedScopes)` decide pelos escopos
   **concedidos**, persistidos no vínculo. Faltando, a exportação falha com
   `AUTH_REJECTED` → `REAUTH_REQUIRED`, e a tela oferece **Reconectar**
   (`missingCalendarScope`). Vínculos autorizados pela versão antiga caem
   aqui — sem migração de dados: o próprio estado do vínculo conduz.
2. Falha em obter o calendário é **falha da sincronização**
   (`CalendarUnavailableError` → `ProviderCallResult` `!ok`), registrada por
   `recordGoogleOutcome`. Nunca mais "sucesso com zeros".
3. O resumo carrega `considered` (candidatos na janela). Zero candidatos é
   "nada para exportar ainda", não "em dia".

Importação Google → Escala+ continua fora desta frente; a tela agora diz isso.

## 12. Importação — Google → Escala+ (12/09/2026)

O PO decidiu que o Escala+ é o centro da gestão de tempo do médico: os
compromissos do Google precisam aparecer aqui, não só os plantões lá.

**O que entra.** Só o calendário principal (`primary`) da conta vinculada.
Título, início, fim, dia inteiro e disponibilidade (ocupado/livre). Nunca
notas, participantes, anexos nem localização — privacidade por omissão.

**O que não entra.** Eventos com o marcador de origem do Escala+ (§2): são
os nossos plantões voltando pelo espelho. Sem essa exclusão haveria laço.

**Autoridade.** Compromisso importado é **somente leitura no app**. O
serviço recusa editar ou apagar (`PRECONDITION_FAILED`, mensagem em
português apontando para o Google) e o editor mostra o aviso e desabilita
salvar/apagar. A verdade é o Google; o app acompanha na próxima
sincronização. Cancelou lá → some aqui. Mudou lá (etag) → atualiza aqui.

**Idempotência.** Duas chaves únicas no banco
(`personal_calendar_external_links`): um evento origina no máximo um
compromisso por conta, e um compromisso tem no máximo uma origem. A
inserção do compromisso usa `client_mutation_id = google:<calendário>:<evento>`
(determinístico, ≤ 64 caracteres). Um cursor expirado (410) força leitura
completa sem duplicar nada.

**Cursor.** `personal_calendar_import_cursors` guarda o sync token por
conta e calendário. NULL = leitura completa da janela (§ SYNC_PAST_DAYS).
Lote máximo de 200 eventos por execução.

**Quando roda.** Junto com a exportação: no `syncNow` da tela Google Agenda
e no reconcile periódico. O resultado do `syncNow` traz
`importedCreated / importedUpdated / importedRemoved / importOk`.

**Onde aparece.** Aba Agenda → vista **Compromissos**: feriados, plantões
da pessoa, compromissos criados aqui e os importados (com a etiqueta "Do
seu Google Agenda · edite lá"), por dia, no mês navegado.

Migração: `drizzle/migrations/manual/2026-09-12-personal-calendar-google-import.sql`
(aditiva, InnoDB, não toca nas tabelas da fundação da agenda).

