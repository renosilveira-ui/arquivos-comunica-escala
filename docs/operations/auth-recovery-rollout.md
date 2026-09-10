# Runbook — recuperação de credenciais

Status: **prospectivo e bloqueado**. Este documento não autoriza migration,
deploy nem alteração de segredo.

## Ordem obrigatória

1. Manter o auto-deploy suspenso ou a revisão sem merge.
2. Configurar no mesmo serviço `AUTH_RECOVERY_ENCRYPTION_CURRENT_KID` e
   `AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET` (mínimo 32 bytes, diferente
   de `COOKIE_SECRET`, máximo 1024 bytes). Não configurar `PREVIOUS_*` na
   primeira ativação. O mesmo intervalo de 32–1024 bytes vale para
   `AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET` durante rotação.
3. Em schema efêmero MySQL 8 criado pelo runner cercado, executar duas vezes
   `2026-09-10-auth-recovery-requests.sql`. O manifest legível embutido deve
   coincidir integralmente com o catálogo de colunas, índices, FKs e CHECKs
   `ENFORCED`; a segunda execução deve produzir zero alteração e continuar
   aceitando o mesmo catálogo. Provar também ausência de trigger, coluna,
   índice, FK ou CHECK extra.
4. Aplicar a migration já provada em staging **antes** de permitir que o SHA
   da aplicação seja implantado. Reexecutar e validar o manifest do catálogo.
5. Só então liberar o deploy. Validar `/api/health`, o início independente do
   `AuthRecoveryCron` e uma recuperação controlada sem registrar PII/token.

Se a migration não puder anteceder o auto-deploy, o release permanece
bloqueado. O endpoint grava no novo outbox e não tem fallback para a tabela
ausente.

## Evidência desta frente

Esta frente não executou MySQL nem migration real, conforme a cerca autorizada.
A prova produzida aqui é somente estática: manifesto explícito, preflight antes
do primeiro DDL persistente, postflight recalculado, teste source e revisão de
rerun. Isso não equivale à prova de catálogo MySQL 8 do passo 3, que permanece
gate objetivo antes de staging/auto-deploy.

## Rotação e retenção AES-GCM

- Criar nova dupla `CURRENT_KID/CURRENT_SECRET`.
- Mover a dupla atual, sem alteração, para `PREVIOUS_KID/PREVIOUS_SECRET`.
- Implantar e manter `PREVIOUS_*` por no mínimo 26 horas depois que o último
  processo capaz de selar com a chave antiga tiver sido encerrado. Esse período
  cobre a janela máxima de 24 horas do payload, leases e margem operacional.
- Antes de remover `PREVIOUS_*`, confirmar que não há linhas não terminais
  seladas com aquele KID. Se houver, manter a chave; não purgar payload ativo.
- Linhas terminais não carregam payload selado. A purga física de histórico,
  se exigida, deve ocorrer somente após 180 dias, com exportação/registro da
  autorização e em frente própria. Não há `DELETE` automático nesta frente.

## Expiração e retenção

- `QUEUED`/`PROCESSING`: payload selado por no máximo 24 horas. Ao ultrapassar
  a janela ou cinco claims, o worker move a linha para `DEAD` e elimina o
  payload antes de tentar qualquer novo egress.
- `ACTIVE`: um único link por conta, válido por 30 minutos a partir de
  `provider_accepted_at`. O endpoint recusa pelo relógio mesmo antes do sweep;
  o worker depois converte o estado expirado para `REVOKED`.
- `USED`, `REVOKED`, `SKIPPED` e `DEAD`: estados terminais sem payload em claro
  ou selado. O histórico mínimo é 180 dias; a purga é aprovação separada.

Recuperação `SELF_SERVICE` é deliberadamente account-wide: a linha durável
`auth_recovery_requests` vincula conta, versão de sessão, e-mail e token por
hash, mas mantém `target_membership_id = NULL`. Assim, uma conta `APPROVED`
ainda sem escala consegue recuperar a credencial sem criar ou eleger
instituição implicitamente. Somente `ADMIN_INITIATED` exige e revalida a PI.

Perda simultânea das chaves atual e anterior torna os payloads pendentes
irrecuperáveis; o worker os encerra fail-closed e nunca tenta outro segredo.

## Rollback

Parar somente o `AuthRecoveryCron`, preservando a tabela e os segredos. Não
remover coluna/tabela e não reativar envio síncrono. Links já `ACTIVE` continuam
válidos até consumo/expiração; mudança de identidade ou credencial os revoga.
