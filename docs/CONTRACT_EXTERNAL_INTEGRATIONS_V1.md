# Contrato V1 — Integrações externas (fundação)

**Status:** NORMATIVO para a fundação; as integrações em si ainda **não existem**.
**Escopo desta entrega (PR 1):** contratos de provedor, criptografia em repouso,
estrutura de dados, fuso por instituição e correção bloqueadora da API da
Agenda pessoal.
**Fora de escopo:** UI, OAuth real, chamada a Google ou Apple, aviso de saída,
deploy e aplicação de migration em ambiente real.

> **CODE COMPLETE / RUNTIME EXTERNAL UNVERIFIED.**
> Nenhuma credencial Google ou Apple foi usada. Nenhuma chamada externa foi
> feita. Nada aqui pode ser apresentado como integração funcionando.

---

## 1. Duas dimensões que não se confundem

| Dimensão                 | Pergunta                   | Escopo       | Onde mora                                              |
| ------------------------ | -------------------------- | ------------ | ------------------------------------------------------ |
| Configuração do provedor | o servidor tem credencial? | global       | env + `server/integrations/providers/configuration.ts` |
| Vínculo da conta         | este usuário autorizou?    | account-wide | `user_external_credentials`                            |

Provedor configurado **não** implica conta vinculada. Conta vinculada **não**
implica provedor disponível agora. Misturar as duas produziria telas que
mentem: "conecte sua agenda" para quem já conectou, ou "conectado" num
ambiente sem credencial nenhuma.

### Estados do vínculo

| Estado            | Significado                           | Servidor tenta de novo? | Usuário precisa agir? |
| ----------------- | ------------------------------------- | ----------------------- | --------------------- |
| `CONNECTED`       | credencial válida, última operação ok | sim                     | não                   |
| `DEGRADED`        | falha transitória (rede, 5xx, cota)   | sim                     | não                   |
| `REAUTH_REQUIRED` | credencial rejeitada ou revogada      | não                     | sim                   |
| `DISCONNECTED`    | sem vínculo                           | não                     | sim                   |

Invariante que nenhuma implementação pode afrouxar: **falha retryável nunca
desconecta nem exige reautenticação**. Transformar instabilidade do Google em
trabalho manual do médico seria terceirizar para ele um incidente que não é
dele. Transição em `nextExternalLinkState` (`lib/integration-providers.ts`),
função pura e testada — writers das próximas PRs não decidem isso sozinhos.

---

## 2. Criptografia em repouso

`server/external-credentials-crypto.ts`. AES-256-GCM, key ring
`current`/`previous`, chave derivada por contexto. Segue o desenho já revisado
de `server/auth-recovery.ts`, com duas diferenças deliberadas:

1. **Contexto próprio.** A chave derivada aqui não abre nada selado pela
   recuperação de credenciais. Comprometer um domínio não entrega o outro, e
   o boot recusa reuso de `COOKIE_SECRET` ou das chaves de `AUTH_RECOVERY`.
2. **AAD ligada ao dono.** O envelope autentica `userId` + `scope`. Um
   ciphertext copiado da linha de um usuário para a de outro **falha na
   abertura** em vez de entregar o token alheio. Sem isso, quem conseguisse
   escrever na tabela herdaria o Google de qualquer conta.

   `scope` é o domínio do dado, não necessariamente um provedor: a origem de
   deslocamento usa `TRAVEL_ORIGIN`, porque ela não pertence ao Google
   Calendar nem ao Places. Sem escopo próprio, o writer teria de eleger um
   provedor arbitrário para selá-la e o leitor teria de adivinhar a mesma
   escolha — erro que só apareceria uma PR depois, longe da causa.

O **access token não tem coluna**. É de curta duração e é derivado do refresh
quando preciso; persistir só ampliaria a janela de vazamento.

### Variáveis

| Variável                                       | Obrigatória     | Observação    |
| ---------------------------------------------- | --------------- | ------------- |
| `EXTERNAL_CREDENTIALS_ENCRYPTION_KEY`          | quando há OAuth | mín. 32 bytes |
| `EXTERNAL_CREDENTIALS_ENCRYPTION_KID`          | não             | default `v1`  |
| `EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KEY` | só na rotação   |               |
| `EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KID` | só na rotação   |               |

### Rotação

1. Mover a chave atual para `PREVIOUS_KEY`/`PREVIOUS_KID`.
2. Gerar nova `KEY`/`KID`. Durante a transição os dois envelopes abrem.
3. Varrer `user_external_credentials` e `user_travel_origins` com
   `rotateExternalCredential` (idempotente: envelope já atual não é reescrito).
4. Só remover `PREVIOUS_*` quando `encryption_kid` não apontar mais para ela.

Remover `PREVIOUS_*` antes do passo 4 deixa envelopes ilegíveis: o vínculo cai
para `REAUTH_REQUIRED` e cada médico precisa reconectar à mão.

---

## 3. Estrutura de dados

Migração: `drizzle/migrations/manual/2026-09-10-external-integrations-foundation.sql`.
Aditiva, idempotente, fail-closed em estado parcial. **Não aplicada em nenhum
ambiente real.**

### `user_external_credentials`

Account-wide. Sem `institution_id`, `professional_id` ou `hospital_id`:
nenhum papel institucional autoriza ler esta linha, a autoridade é o
`users.id` da sessão. `UNIQUE (user_id, provider)`.
`ON DELETE CASCADE` — excluir a conta apaga a credencial.

Invariantes garantidas pelo banco, não pelo writer:

- `chk_user_external_credential_kid` — segredo selado exige `encryption_kid`.
  Envelope sem chave declarada é envelope que ninguém abre nem rotaciona.
- `chk_user_external_credential_state` — vínculo não-`DISCONNECTED` exige
  token selado. Um "conectado" que não renova nada é mentira de estado.

### `user_travel_origins`

Origem de deslocamento do usuário. É o dado mais sensível que este sistema
chega a guardar, então: opcional, com consentimento explícito e datado
(`consent_granted_at`, `consent_version`), selado em repouso, **sem cópia em
claro de coordenada, endereço ou Place ID**, e apagado junto com a conta.

`default_slot` é coluna gerada + `UNIQUE (user_id, default_slot)`: uma única
origem padrão por conta, garantida pelo banco.

**Nenhuma tela de escala exige origem configurada.** Agenda e plantão
funcionam sem isto — é a diferença entre um recurso opcional e um pedágio.

### `hospitals` — destino canônico

`time_zone`, `google_place_id`, `latitude`, `longitude`,
`location_updated_at`, `location_updated_by_user_id`.

Dado institucional, tenant-scoped: quem configura é o gestor do próprio
tenant. Precisão cheia em lat/long é deliberada (endereço institucional, não
residencial). `ON DELETE SET NULL` no autor — a saída de um gestor não pode
apagar a localização do hospital nem travar a exclusão da conta dele.

---

## 4. Fuso por instituição

`institutions.time_zone`, `NOT NULL DEFAULT 'America/Sao_Paulo'`.
`hospitals.time_zone` opcional sobrepõe. Resolução em
`server/institution-time-zone.ts`: hospital → instituição → padrão.

Só identificador IANA de região é aceito. Offset fixo (`-03:00`, `Etc/GMT+3`)
é recusado de propósito: não carrega regra de horário de verão, e uma
instituição gravada assim volta a errar a hora no dia em que o fuso dela mudar.

**Esta PR não reescreve o domínio temporal.** `server/local-time.ts` continua
valendo com offset fixo. O que autoriza a migração gradual é o teste de
compatibilidade em `tests/institution-time-zone.test.ts`: enquanto toda
instituição estiver em `America/Sao_Paulo`, os dois caminhos produzem o
**mesmo instante**. Migrar chamadores um a um, com teste, é o plano — mudar
tudo de uma vez não é.

O resolvedor **nunca lança**. Valor corrompido cai para o nível seguinte: um
fuso inválido não pode derrubar a leitura de uma escala inteira.

---

## 5. Correção bloqueadora da Agenda pessoal

**Defeito.** `PersonalCalendarValidationError` só era capturado no
`superRefine` de entrada. `personalCalendarOccurrenceWindowSchema` validava
apenas o _formato_ das datas — `fromDate > toDate` e janela acima de 366 dias
eram checados dentro de `generatePersonalCalendarOccurrences`, fora de
qualquer `catch`. O erro atravessava o tRPC como `INTERNAL_SERVER_ERROR`.

Pior: a falha dependia de dados. `checkConflicts` sempre expande um rascunho,
então dava **500 sempre**. `listWindow` só expande se a conta tiver algum
compromisso — janela inválida em agenda vazia respondia 200.

**Correção, em duas camadas.**

1. A invariante saiu da expansão para `validatePersonalCalendarWindow` e é
   aplicada na borda de entrada. Janela inválida vira erro de validação, com
   `path: ["toDate"]`, antes de tocar o banco.
2. `mappingValidationErrors` no router traduz qualquer
   `PersonalCalendarValidationError` que ainda escape da expansão em runtime
   (fuso inexistente numa transição de horário de verão, série que gera
   ocorrências demais) para `BAD_REQUEST`. O mapa é exaustivo por tipo: um
   código novo no domínio quebra o typecheck em vez de escorregar para 500.

**Armadilha encontrada durante a própria correção.** Aplicar o `superRefine`
ao schema que o domínio usa internamente mudou o tipo de erro de
`generatePersonalCalendarOccurrences` para `ZodError` — que o mapeamento do
router não reconhece, e que voltaria a virar 500 por outra porta. Por isso
existem dois schemas: `...ShapeSchema` (forma, uso interno, preserva o erro do
domínio) e `personalCalendarOccurrenceWindowSchema` (borda, com a regra).

---

## 6. Contratos de provedor

Interfaces sem implementação, em `server/integrations/providers/`. Existem
antes do código para fixar semântica e permitir que as PRs seguintes testem
contra fake, sem rede e sem CI dependente de terceiro.

Toda chamada externa devolve `ProviderCallResult`, **nunca lança**. Clima
indisponível não pode impedir ler a agenda; rota indisponível não pode
cancelar plantão. Quem chama é obrigado a olhar o `ok` e escolher o fallback.

A classificação de falha (`ProviderFailureReason`) é grosseira de propósito:
sem corpo de resposta, URL, coordenada, endereço ou identificador. É o que
pode ir para log e para o cliente.

### Google Calendar — autoridade

| Objeto              | Direção              | Regra                                                  |
| ------------------- | -------------------- | ------------------------------------------------------ |
| Compromisso pessoal | bidirecional         | o usuário é dono dos dois lados                        |
| Plantão atribuído   | exportação read-only | editar no Google **nunca** altera a escala             |
| Evento externo      | leitura              | vira bloco ocupado no conflito, **nunca** vira plantão |

`410` / sync token inválido é estado **esperado**: a resposta é resync
completo, não desconectar o usuário.

### Google Places / Routes

Chave server-side. O app nunca fala com o Google — pede ao nosso servidor,
que decide, limita e registra. Nenhum método aceita URL: não existe caminho em
que dado do usuário escolha o destino da requisição (SSRF).

`RouteEstimateQuality` separa `LIVE_TRAFFIC`, `TYPICAL` e `FALLBACK`. Só a
primeira pode ser apresentada como trânsito atual. Fallback precisa aparecer
como fallback — número inventado com cara de dado do Google é pior que não ter
número.

### WeatherKit

Ornamento operacional, nunca autoridade. Chave privada ES256 no servidor.
Coordenada arredondada antes de sair (`coarsenGeoPoint`, ~110 m): não é
preciso saber onde alguém mora para dizer se vai chover. Atribuição Apple vem
do provedor, exigida pela licença. Estado explícito de indisponibilidade —
melhor "clima indisponível" que número inventado.

---

## 7. Configuração: três estados, não dois

| Estado           | Significado                 | Bloqueia boot em produção? |
| ---------------- | --------------------------- | -------------------------- |
| `NOT_CONFIGURED` | nenhuma variável preenchida | não                        |
| `CONFIGURED`     | tudo preenchido e válido    | não                        |
| `MISCONFIGURED`  | parcial ou inválido         | **sim**                    |

Integrações são **opcionais**: um deploy sem Google ou WeatherKit sobe normal.
O que derruba o boot é configuração pela metade — esses estados não falham na
inicialização, falham no meio do fluxo do médico, e aí já tem gente esperando.

OAuth configurado sem chave de criptografia é `MISCONFIGURED`: não existe onde
guardar o refresh token com segurança.

Nenhum relatório devolve valor de credencial — só **nomes** de variáveis. É
seguro para log, resposta tRPC e tela de diagnóstico.

---

## 8. O que esta PR deliberadamente NÃO faz

- Não aplica a migration em staging ou produção.
- Não ativa nenhum provedor: sem credencial, tudo fica `NOT_CONFIGURED`.
- Não cria rota, tela, job ou worker.
- Não altera nenhum cálculo de escala existente.
- Não cabla a prova MySQL da migration na CI — isso exige `ci.yml`,
  `vitest.migration.config.ts` e `package.json`, os três arquivos em disputa
  com a frente paralela (PRs #462 e #463 mexem exatamente neles neste
  momento). A migration foi provada localmente contra MySQL efêmero:
  idempotência em dois passes, invariantes recusadas pelo banco, **as três
  guardas fail-closed exercitadas** (base ausente, estado parcial, contrato
  divergente) e **paridade formal com `drizzle-kit push`** — 13 constraints e
  30 colunas idênticas nos dois caminhos. **Wiring de CI é follow-up
  declarado**, a fazer depois que #462/#463 mergearem.

## 9. Antes de aplicar em ambiente real

1. Aplicar a migration no staging **antes** do merge (o deploy não roda
   migração — incidente de 22/08).
2. Conferir que toda instituição ficou com `time_zone` preenchido.
3. Só então preencher credencial de provedor, uma integração por vez.
