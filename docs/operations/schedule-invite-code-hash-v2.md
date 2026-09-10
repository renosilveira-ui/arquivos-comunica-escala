# Rollout do hash HMAC dos convites

## Objetivo

Impedir que uma cópia da tabela `schedule_invites` permita testar offline todo
o espaço curto dos códigos. O banco passa a guardar HMAC-SHA-256 versionado;
o pepper fica somente no secret store do runtime.

## Ordem obrigatória

1. Aplicar `2026-09-10-schedule-invite-code-hash-v2.sql` no banco alvo.
2. Confirmar `code_hash_version=SHA256_V1` nas linhas preexistentes e rerodar a
   migration para provar idempotência.
3. Gerar um segredo aleatório exclusivo com pelo menos 32 bytes e cadastrar
   como `SCHEDULE_INVITE_CODE_PEPPER` em todas as instâncias. Não copiar
   `COOKIE_SECRET`, JWT, credenciais Twilio ou Resend.
4. Só então implantar o runtime HMAC. Não operar writer antigo e novo ao mesmo
   tempo.
5. Verificar uma emissão V2 e o resgate. O valor em claro não pode aparecer em
   banco, log ou auditoria.

Sem o pepper, apenas emissão, consulta por código, resgate e recusa de convite
falham fechado. Inicialização, login e demais módulos continuam disponíveis.

## Compatibilidade V1

O leitor reconhece `SHA256_V1` explicitamente para convites criados antes do
rollout. Eles continuam sujeitos ao próprio `expires_at`; como o writer antigo
é retirado no passo 4, a janela fecha naturalmente em no máximo 24 horas. V1
nunca é usado para novas emissões pelo runtime novo.

## Rotação

1. Mover o valor atual para `SCHEDULE_INVITE_CODE_PREVIOUS_PEPPER`.
2. Definir um novo `SCHEDULE_INVITE_CODE_PEPPER` exclusivo.
3. Implantar todas as instâncias de forma coordenada.
4. Manter o anterior por no mínimo 24 horas; depois removê-lo.

Não fazer duas rotações em menos de 24 horas: o leitor mantém apenas uma chave
anterior, suficiente para o TTL máximo vigente.

## Limites

- HMAC protege ataque offline após vazamento do banco; não substitui rate limit
  e vínculo nominal contra tentativas online.
- Perda do pepper antes do fim do TTL invalida convites V2 ainda ativos.
- A entrega final do e-mail depende do callback do provedor e não é inferida de
  HTTP 2xx.
