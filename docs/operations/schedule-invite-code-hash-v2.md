# Rollout do hash HMAC dos convites

## Objetivo

Impedir que uma cópia da tabela `schedule_invites` permita testar offline todo
o espaço curto dos códigos. O banco passa a guardar HMAC-SHA-256 versionado;
o pepper fica somente no secret store do runtime.

## Ordem obrigatória — sem writers mistos

Colocar todas as instâncias do writer antigo fora de rotação antes do passo 1.
Não reintroduzir nenhuma delas depois do primeiro DDL. A ordem abaixo é um
gate: não antecipar env ou runtime e não executar passos em paralelo.

1. **Fence/outbox/journal:** aplicar
   `2026-09-10-schedule-invite-issuance-fences.sql` no banco alvo. Confirmar os
   manifests exatos de `schedule_invite_issuance_fences` e
   `schedule_invite_issuance_journal`.
2. **Hash V2:** aplicar
   `2026-09-10-schedule-invite-code-hash-v2.sql`. Confirmar que linhas
   preexistentes ficaram explicitamente `SHA256_V1` e que o default final da
   coluna é `HMAC_SHA256_V2`. Um INSERT novo que omita a versão deve nascer V2.
3. **Reruns/manifests:** rerodar, nesta ordem, a migration da fence e a do hash.
   Ambas devem preservar todas as linhas e repetir os mesmos manifests. A
   fence recria somente os dois guards append-only, ainda com writers fora de
   rotação; tabelas/colunas não sofrem DDL adicional. Qualquer mismatch é STOP;
   não corrigir automaticamente.
4. **Env:** gerar um segredo aleatório exclusivo com pelo menos 32 bytes e só
   então cadastrar `SCHEDULE_INVITE_CODE_PEPPER` em todas as instâncias. Não
   copiar `COOKIE_SECRET`, JWT, credenciais Twilio ou Resend. Durante rotação,
   manter a chave anterior conforme a seção abaixo.
5. **Runtime:** implantar coordenadamente o runtime HMAC/outbox somente depois
   dos quatro gates anteriores. Não operar writer antigo e novo ao mesmo tempo.
   Verificar uma emissão V2, o journal por geração, o resgate e a ausência de
   código, hash e e-mail em log/auditoria.

O pipeline local/CI de composição deve executar `pnpm
test:schedule-invite-migrations` contra MySQL 8 loopback efêmero, com as duas
URLs `.../mysql` e `SCHEDULE_INVITE_MIGRATION_TEST_MARKER` explícitos. Ausência
de env, serviço ou marker é falha, não skip. Nesta branch os filhos são únicos e
não executam `DROP DATABASE`; o runner/fence aprovados em `d75f6e7` e `4ad93fc`
devem ser reconciliados quando as frentes forem compostas.

Sem o pepper, apenas emissão, consulta por código, resgate e recusa de convite
falham fechado. Inicialização, login e demais módulos continuam disponíveis.

## Compatibilidade V1

O leitor reconhece `SHA256_V1` explicitamente para convites criados antes do
rollout. Eles continuam sujeitos ao próprio `expires_at`; como o writer antigo
é retirado antes do passo 1, a janela fecha naturalmente em no máximo 24 horas. V1
nunca é usado para novas emissões pelo runtime novo.

## Rotação

1. Mover o valor atual para `SCHEDULE_INVITE_CODE_PREVIOUS_PEPPER`.
2. Definir um novo `SCHEDULE_INVITE_CODE_PEPPER` exclusivo.
3. Implantar todas as instâncias de forma coordenada.
4. Manter o anterior por no mínimo 24 horas; depois removê-lo.

Não fazer duas rotações em menos de 24 horas: o leitor mantém apenas uma chave
anterior, suficiente para o TTL máximo vigente.

O `code_pepper_key_id` da outbox é opaco e seleciona a chave corrente ou a
anterior sem persistir o pepper. Remover a chave anterior antes de expirar a
última tentativa ligada a ela bloqueia fail-closed tanto o replay quanto a
ativação; nunca gere outra mensagem como se a tentativa incerta tivesse sido
rejeitada.

## Resposta perdida, crash e reconciliação

- `ACCEPTED` significa aceite/enfileiramento HTTP, não entrega final.
- `REJECTED` só é gravado para uma rejeição definitiva antes/na chamada.
- Timeout, 5xx, 408, 425, 429, erro de rede ou crash pós-envio são `UNKNOWN`.
  Eles preservam a geração, nonce, idempotency-key e fingerprint HMAC canônico
  do request completo do provedor. O pepper nunca é persistido.
- Após vencer a lease, `PREPARING`/`UNKNOWN` reenviam exatamente a mesma
  mensagem com a mesma chave opaca. Antes do replay, o runtime reconstrói
  `from`, `to`, assunto, texto/HTML e exige igualdade com o fingerprint
  persistido. Mudança em nome, `APP_PUBLIC_URL`, `MAIL_FROM`, destinatário ou
  template falha fechado antes da rede; nunca reaproveita a chave antiga com
  conteúdo novo.
- `PROVIDER_ACCEPTED` e `PROVIDER_ACCEPTED_ACTIVATION_FAILED` retomam apenas a
  ativação local. Não reenviam e-mail.
- O journal é append-only no runtime e no banco: triggers `BEFORE UPDATE` e
  `BEFORE DELETE` rejeitam alteração/remoção. O manifesto prova nomes, timing,
  evento e `ACTION_STATEMENT` dos dois guards.

## Limites

- HMAC protege ataque offline após vazamento do banco; não substitui rate limit
  e vínculo nominal contra tentativas online.
- Perda do pepper antes do fim do TTL invalida convites V2 ainda ativos.
- A entrega final do e-mail depende do callback do provedor e não é inferida de
  HTTP 2xx.
