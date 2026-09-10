# Contrato de integração — reset administrativo e entrega durável

## Contrato composto esperado

A frente de lifecycle de autenticação em `96772dc` substitui o reset imediato
por solicitação durável. O endpoint valida autoridade, tenant, usuário e canal,
persiste a solicitação e responde HTTP `202`; ele não cria link utilizável nem
altera senha, sessão ou push token nessa etapa.

Esta frente de convite não altera `server/routes/admin.ts`,
`server/mailer.ts` nem o worker de reset. Na composição, ela depende do
contrato superset do mailer: `INVALID_IDEMPOTENCY_KEY` é `REJECTED` definitivo,
nunca `UNKNOWN`, e `providerCorrelationId` só pode atravessar o adapter quando
for opaco e tiver no máximo 128 caracteres. A composição deve conservar a API
exportada `parseProviderCorrelationId`; esta frente a consome e não mantém um
parser concorrente.

## Invariante obrigatória para o integrador

O reset não pode trocar `password_hash`, ligar `must_change_password`,
incrementar `session_version`, revogar sessões/push tokens ou invalidar resets
anteriores durante a solicitação nem durante o egress.

O fluxo composto precisa usar o mesmo protocolo mínimo da emissão de convite:

1. Validar autoridade, tenant, usuário elegível e e-mail antes de enfileirar.
2. Persistir intenção/outbox, material recuperável protegido, fingerprint do
   request completo e idempotency-key estável antes do egress.
3. Retornar HTTP `202` somente como aceite da solicitação local, nunca como
   prova de envio, entrega ou troca de senha.
4. Em `REJECTED`, inclusive `INVALID_IDEMPOTENCY_KEY`, não criar link `ACTIVE`
   e encerrar a tentativa de forma terminal.
5. Em `UNKNOWN`, preservar a mesma intenção para reconciliação/replay
   idempotente e limitado; não gerar silenciosamente nova credencial ou chave.
6. Somente depois de `ACCEPTED` durável, ativar uma única vez o link de resgate.
   Se a ativação local falhar, retomar apenas a ativação; nunca reenviar payload
   divergente sob a mesma chave.
7. Alterar senha, `must_change_password`, `session_version`, sessões e push
   tokens apenas quando o usuário resgatar com sucesso o link `ACTIVE`, sob
   CAS/lock e revalidação do alvo. O aceite do provedor não muda a credencial.
8. Sem e-mail, rejeitar antes de enfileirar. O cliente deve distinguir `202`
   de falha de validação e de indisponibilidade operacional.

## Gate de composição

O integrador deve provar com testes focados: HTTP `202` sem mutação de
credencial; zero link `ACTIVE` em sem e-mail, `REJECTED` e
`INVALID_IDEMPOTENCY_KEY`; replay idêntico e limitado após timeout/crash; link
único após `ACCEPTED`; e mutação única de credencial somente no resgate, ainda
protegida por CAS e revalidação de tenant/autoridade. Também deve manter o
parser de correlação em `<= 128` caracteres. Qualquer quebra desse contrato é
STOP de composição, não motivo para duplicar lógica de auth nesta frente.
