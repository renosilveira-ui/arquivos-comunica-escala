# Contrato de integração — reset administrativo e entrega durável

## Estado observado nesta frente

Na base de retrabalho `cd332cfd1aa2d0aa71e7216736ee2cc5ec8b876b`,
`server/routes/admin.ts` ainda grava a nova credencial, incrementa
`session_version`, revoga push tokens e invalida resets dentro da transação;
somente depois tenta enviar a senha temporária. O resultado tipado de
`mailer.sendMail` não governa a resposta e o endpoint retorna `{ ok: true }`
inclusive quando não há e-mail, quando o provider rejeita ou quando o resultado
é `UNKNOWN`.

Esta frente não altera `server/routes/admin.ts`, `server/mailer.ts` nem auth,
porque esses arquivos pertencem à frente concorrente de lifecycle. O estado
acima é uma dependência de composição, não uma autorização para duplicar a
implementação aqui.

## Invariante obrigatória para o integrador

O reset não pode trocar `password_hash`, ligar `must_change_password`,
incrementar `session_version`, revogar sessões/push tokens ou invalidar resets
anteriores antes de existir entrega durável da credencial temporária.

O fluxo composto precisa usar o mesmo protocolo mínimo da emissão de convite:

1. Validar autoridade, tenant, usuário elegível e e-mail antes de gerar efeito.
2. Persistir intenção/outbox, material recuperável protegido, fingerprint do
   request completo e idempotency-key estável antes do egress.
3. Em `REJECTED`, não alterar a credencial e retornar falha explícita.
4. Em `UNKNOWN`, preservar a intenção para reconciliação/replay idempotente e
   não confirmar sucesso ao administrador.
5. Somente depois de `ACCEPTED` durável, aplicar a troca de credencial e a
   revogação de sessões em CAS/lock com revalidação integral da autoridade e do
   snapshot do alvo.
6. Se a ativação local falhar após `ACCEPTED`, registrar estado recuperável e
   retomar apenas a ativação; nunca reenviar com payload divergente sob a mesma
   chave.
7. Sem e-mail, rejeitar antes de gerar/revogar credencial. Nunca retornar
   `{ ok: true }` para ausência de canal, `REJECTED` ou `UNKNOWN`.

## Gate de composição

O integrador deve provar com testes focados: zero mutação de credencial/sessão
em sem e-mail e `REJECTED`; resposta não-success em `UNKNOWN`; replay idêntico
após timeout/crash; e mutação única após `ACCEPTED`, ainda protegida por CAS e
revalidação de tenant/autoridade. Até esses casos passarem, o reset
administrativo permanece bloqueador de segurança para release.
