# Rollout do vínculo de sessão `exact-v1`

Este protocolo vincula cada operação protegida ao JWT exato que o cliente
admitiu. Ele é uma barreira contra troca silenciosa entre duas sessões do mesmo
usuário; não substitui autenticação, `sessionVersion`, tenant ou autorização.

## Contrato

- Suporte do servidor: `SESSION_EXACT_BINDING_SUPPORTED` (`0` por padrão).
- Ativação baked no cliente:
  `EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE` (`0` por padrão).
- Preflight público: `GET /api/auth/session-binding-capability`, sempre
  `Cache-Control: no-store`, retorna
  `{ "capability": "exact-v1", "supported": boolean }`.
- Opt-in de emissão: `x-client-session-protocol: exact-v1`.
- Claim assinado imutável: `sessionBindingVersion: 1`.
- Prova web: `x-client-session-instance: v1.<HMAC>`.
- Estado autenticado em `/api/auth/me`:
  `{ capability: "exact-v1", supported, sessionVersion: 1 | null }`.

Com suporte desligado, um pedido `exact-v1` responde
`503 SESSION_BINDING_CAPABILITY_UNAVAILABLE` antes de emitir ou alterar sessão.
Com suporte ligado, login com opt-in emite v1; login sem o header continua
legacy para permitir overlap com o build antigo. Um JWT legacy nunca é
promovido durante `change-password` só por receber header/proof: com opt-in, a
rotação responde `428 SESSION_BINDING_REAUTH_REQUIRED`; sem opt-in, permanece
legacy. Uma rotação autenticada por JWT v1 preserva v1 mesmo se o suporte for
desligado ou o header de opt-in for omitido.

Um JWT web/cookie com `sessionBindingVersion: 1` exige a prova exata em toda
rota protegida. A única exceção é o bootstrap read-only e `no-store` em
`GET /api/auth/me`, que devolve a prova; se o header estiver presente ali, ele
também é validado. Nas demais rotas, ausência produz
`428 SESSION_INSTANCE_REQUIRED` e prova de outro JWT produz
`409 SESSION_INSTANCE_MISMATCH`. No transporte nativo, o próprio Bearer
autenticado já é a instância exata e não exige um segundo header. JWTs sem o
claim continuam legacy; header de prova/protocolo em rota comum não os promove.

## Fase 1 operacional: impacto nativo `raw-only`

O primeiro build que contém este hardening **revogará e deslogará** toda
instalação nativa que ainda tenha somente `session_token`, sem o envelope de
admissão bindado. Esse token entra em `LEGACY_REVOKE_REQUIRED`: nunca é
publicado na UI, é enviado explicitamente ao `/logout` e só é removido do
aparelho depois de um `2xx` com prova tipada `ROTATED` ou `ALREADY_INVALID`.
Rede/5xx mantém a instalação fechada e repete o logout; `/me` 401 não confirma
revogação. Não existe migração silenciosa desse raw para uma sessão admitida.

Antes dessa fase, são requisitos de GO/NO-GO:

- confirmar em 100% das réplicas o `/logout` tipado e idempotente, incluindo
  token stale/ausente, e `428` para cookie exact atual sem proof;
- confirmar que usuários afetados conhecem suas credenciais e que recuperação
  de senha/suporte estarão disponíveis durante toda a janela;
- escolher janela operacional com responsável nominal, canal de incidentes e
  capacidade de suspender imediatamente a distribuição do build;
- comunicar previamente o logout obrigatório, o motivo e o passo a passo de
  novo login; **não publicar** sem essa comunicação operacional;
- acompanhar telemetria agregada, sem token bruto: entradas raw-only,
  `ROTATED`, `ALREADY_INVALID`, retries 5xx/rede, cleanup local pendente,
  duração até novo login e chamados de recuperação de credencial;
- definir limiares de STOP para crescimento de retry/cleanup pendente ou falha
  de login, e registrar horário, versão e responsável pela decisão.

Rollback não readmite token raw nem desfaz revogação já confirmada. Suspender a
publicação impede novas instalações afetadas, mas as que já entraram em
revoke-only devem concluir o logout/cleanup no mesmo protocolo; retornar a um
build antigo pode reabrir comportamento inseguro e não é rollback autorizado.
Se a telemetria atingir STOP, congelar novas distribuições, manter o servidor
compatível e orientar recuperação de credenciais — nunca limpar o marker ou
restaurar o raw por conveniência.

## Fases seguras

1. Fase 0: manter os dois gates em `0`.
2. Publicar o servidor compatível, ainda com suporte `0`, sem ativar cliente.
3. Confirmar que 100% das réplicas executam o mesmo código, compartilham o
   mesmo `COOKIE_SECRET` e respondem preflight `supported:false`.
4. Fase de suporte: mudar somente `SESSION_EXACT_BINDING_SUPPORTED=1` em todas as
   réplicas. Confirmar `supported:true` sem afinidade de sessão. O build antigo
   continua recebendo JWT legacy.
5. Executar a Fase 1 operacional raw-only acima e só então publicar/validar
   separadamente o build que contém o protocolo, ainda com
   `EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE=0`.
6. Fase 2: gerar/aprovar novo build com o gate cliente `1`. Esse cliente exige
   preflight `supported:true` antes de login/mutação e nunca converte 428, 409
   ou 503 em retry com downgrade.

Não ligar suporte em parte do pool: preflight e login podem cair em réplicas
diferentes. O gate é 100% das réplicas, não uma amostra verde.

## STOP antes de declarar proteção final

Os dois estados dão overlap, mas não drenam abas/builds antigos. Enquanto o
servidor aceitar login sem header, uma aba antiga pode emitir JWT legacy e
sobrescrever no navegador um cookie v1. Portanto, esta entrega prova proteção
claim-driven para sessões v1 e migração gradual, mas não autoriza declarar que
todo login web está definitivamente protegido.

Antes de produção final, é necessária uma terceira fase server-side
`required/enforce` que rejeite login sem protocolo depois da janela de migração,
ou evidência operacional equivalente aprovada explicitamente. Não remover este
STOP nem simular enforcement relaxando os erros fail-closed.

## Rollback

Desligar suporte interrompe novos opt-ins, mas não rebaixa JWTs v1 já emitidos:
eles continuam exigindo proof e suas rotações continuam v1. Se o cliente baked
estiver ativo, `supported:false` deve bloquear novos logins/mutações; rollback
completo exige novo build cliente ou revogação/expiração das sessões v1.

Não fazer deploy, promoção de build ou publicação apenas por este documento;
essas ações exigem aprovação operacional separada.
