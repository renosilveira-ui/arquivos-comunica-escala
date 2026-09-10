# WhatsApp — titularidade global da conta

## Contrato e limite de autorização

Os cinco endpoints `profile.getWhatsAppContact`, `setWhatsAppContact`,
`deactivateWhatsAppContact`, `startWhatsAppVerification` e
`checkWhatsAppVerification` pertencem ao titular autenticado da conta, não a uma
instituição. Uma conta APPROVED, não excluída e com sessão vigente pode usá-los
com zero, um ou vários vínculos, inclusive após revogação do tenant selecionado.
`sessionProcedure` continua exigindo autenticação, identidade esperada e vínculo
da instância da sessão. O domínio revalida APPROVED/deletedAt/sessionVersion no
banco. Não há userId ou tenant de autoridade no input do cliente.

Isso não concede associação institucional, ingresso em escala, papel de gestor,
ocupação ou troca de plantão. As rotas institucionais continuam sob
`protectedProcedure` e suas políticas. A resolução inbound de identidade mantém
as exigências de contato ativo/verificado e usuário aprovado/não excluído.

## Persistência e atomicidade

Os readers account-wide também exigem `sessionVersion` e usam a linha do titular
bloqueada durante a leitura. O resultado pós-consumo revalida a sessão antes de
responder sucesso. Isso não desfaz um consumo que foi válido antes de uma
revogação posterior; impede responder sucesso com aquela sessão já revogada.

`account_audit_events` é separado de `audit_trail`: nenhuma instituição é
inventada para uma operação global. O writer aceita exclusivamente IDs,
ação/outcome enumerados e o indicador de invalidação de verificação. Não aceita
telefone, hash de telefone, OTP, token, SID ou payload livre. Sem FK para users,
os eventos persistem após exclusão da conta. A primitive pode futuramente servir
a senha/exclusão; **esta frente não altera `routes/auth.ts`**.

Contato, desafio e evento de auditoria são gravados na mesma transação, com lock
da linha `users` do titular. Falha do writer reverte a mutação. O lock serializa
set/deactivate/start/check e conflita com alterações de sessão/exclusão dessa
linha. A unicidade E.164 ativa permanece no banco, inclusive entre titulares
concorrentes.

`whatsapp_verification_challenges` guarda um desafio corrente por titular, com
UUID novo em cada start, sessão, ID de contato, recibo de auditoria e validade
máxima local de dez minutos. O SID Verify é privado nessa tabela, nunca no audit
ou na resposta ao cliente; não se persiste OTP.

| Transição                    | Condição                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| novo UUID → STARTING         | Persistência + audit REQUESTED antes da rede                                               |
| STARTING → READY             | Mesmo UUID, sessão, contato ativo, número e validade; resposta Twilio correlacionada       |
| STARTING → FAILED            | Falha do provider ou conclusão fora da validade                                            |
| STARTING/READY → INVALIDATED | Mudança de número, reativação ou desativação                                               |
| READY → CONSUMED             | Check approved correlacionado; CAS com exatamente uma linha + verifiedAt + audit SUCCEEDED |
| READY → FAILED               | Rejeição terminal/expiração                                                                |

Não há transação aberta durante a chamada Twilio. Um start atrasado não recria
UUID invalidado/substituído: A→B→A e respostas fora de ordem falham fechadas.
O check usa `VerificationSid` iniciado, além de validar SID/to/channel na
resposta do SDK; approved sem essa correlação não é autoridade.

O enum da Verification Check é fechado: `approved`, `pending`, `canceled`,
`deleted`, `failed`, `expired`, `max_attempts_reached` (também descrito no SDK
Twilio instalado em `service/verificationCheck.d.ts`). `pending` rejeita o código
sem terminar o desafio. Os demais status legítimos não aprovados encerram o
desafio: `expired` → EXPIRED; limite → TOO_MANY_ATTEMPTS;
`canceled/deleted/failed` → VERIFICATION_ENDED. Esses resultados registram
REJECTED. Configuração, transporte e resposta desconhecida/malformada registram
FAILED, nunca erro atribuído ao código digitado. Status desconhecido não vira
INVALID_CODE; permanece falha técnica e não autoriza consumo.

Queda do processo ou falha da auditoria após a rede pode deixar STARTING. Esse
estado nunca autoriza check; expirado, é convertido para FAILED no próximo
acesso account-wide do titular, ou substituído por novo start. O acesso com nova
sessão também limpa o SID do desafio vinculado à sessão anterior. A expiração
lógica independe de job de limpeza. Não existe retry automático de envio nem
fallback SMS.

### Retenção física: limite e manutenção

A validade lógica de dez minutos não é uma garantia de remoção física em dez
minutos. Sem novo acesso ou manutenção, um SID pode permanecer na tabela, embora
não possa ser usado para verificar. Hard-delete remove o desafio por CASCADE;
**soft-delete não é CASCADE**: desativa o contato e torna o titular inelegível,
mas não executa sozinho uma limpeza física dessa tabela. `routes/auth.ts` não
foi alterado nesta frente.

Em janela de manutenção autorizada, no banco explicitamente confirmado, o
operador pode executar este lote de até 100 linhas e repetir até affectedRows=0.
Não altera contato, verifiedAt ou audit; preserva desafio vigente de conta
elegível. Não foi criado job/endpoint de manutenção. Nenhum SLA de retenção
física pode ser anunciado antes de haver operação periódica autorizada.

```sql
-- WHATSAPP_RETENTION_MAINTENANCE
UPDATE whatsapp_verification_challenges AS c
SET provider_verification_sid = NULL,
    state = CASE WHEN expires_at <= CURRENT_TIMESTAMP() THEN 'FAILED' ELSE 'INVALIDATED' END
WHERE c.provider_verification_sid IS NOT NULL
  AND (
    c.expires_at <= CURRENT_TIMESTAMP()
    OR EXISTS (
      SELECT 1 FROM users u WHERE u.id = c.user_id
        AND (u.deleted_at IS NOT NULL OR u.approval_status <> 'APPROVED'
          OR u.session_version <> c.session_version)
    )
    OR NOT EXISTS (
      SELECT 1 FROM user_contact_channels ch
      WHERE ch.id = c.contact_id AND ch.user_id = c.user_id
        AND ch.channel = 'WHATSAPP' AND ch.active = 1
    )
  )
ORDER BY c.user_id
LIMIT 100;
```

Uma transação local não desfaz um envio/consumo já ocorrido na Twilio. Se a
auditoria falhar depois disso, o banco não marca verifiedAt e o cliente recebe
erro; pode ser necessário iniciar outro código. O evento REQUESTED anterior
permanece para rastrear a tentativa, sem afirmar que o provider foi concluído.

## Implantação futura, não executada nesta frente

1. Confirmar o banco/ambiente autorizado e backup operacional.
2. Aplicar `2026-09-09-whatsapp-account-ownership.sql` antes do código, após a
   migration original `2026-08-31-user-contact-channels.sql`.
3. Rerodar e validar o postflight. O manifesto canônico integral compara hash e
   cardinalidade de 36 registros: tabelas, todas as colunas (ordem/tipo/default/
   EXTRA/ON UPDATE/charset/collation/geração), todos os índices e constraints/FKs,
   e ausência de triggers. Recusa inclusive campos extras de phone/OTP/payload,
   índices extras e propriedades divergentes. A declaração fixa MySQL 8,
   InnoDB, ROW_FORMAT=DYNAMIC e utf8mb4_0900_ai_ci. Tabela previamente criada por
   outra revisão/default do servidor pode exigir compatibilização explícita
   autorizada; CREATE IF NOT EXISTS nunca disfarça essa divergência. DDL MySQL
   não é transacional, portanto investigar falha sem apagar dados.
4. Publicar somente após revisão e autorização próprias da integração.

É aditiva: contatos já verificados são preservados. OTPs pendentes de versões
anteriores não possuem desafio correlacionado e exigem novo start. Durante
rollout misto, instâncias antigas não implementam esse contrato; drenar tráfego
de mutações WhatsApp das versões antigas antes de declarar o gate fechado.

**Bloqueador operacional para promoção:** entrada das cinco rotas em manutenção
ou roteamento exclusivo para a revisão aprovada; zero instâncias antigas aptas
a receber mutações; zero requisições antigas de start/check/set/deactivate em
voo; postflight integral aprovado no banco autorizado. Só então reabrir o
tráfego. Esta condição exige evidência operacional e não é garantida pelo código
novo nem pelos testes locais. Não executar rollout misto como se fosse seguro.

## Evidência local e limites

O gate descartável está excluído do `vitest.config.ts` padrão e é executado
explicitamente pela CI via `vitest.whatsapp-account.config.ts`. As regressões
anteriores permanecem na suíte padrão; não existe runner MySQL paralelo com
credenciais ou ciclo de vida próprios.

```sh
pnpm exec vitest run --config vitest.whatsapp-account.config.ts
pnpm exec vitest run --config vitest.pure.config.ts tests/whatsapp-verification-provider.test.ts tests/whatsapp-verification-source.test.ts tests/whatsapp-verification-rate-limit.test.ts tests/whatsapp-contact-source.test.ts tests/user-contact-channels-migration.test.ts
pnpm typecheck
pnpm lint
git diff --check
```

A config MySQL exige `NODE_ENV=test`, opt-in destrutivo, URL do alvo pai local,
nome esperado e marcador descartável. Ela valida os cinco valores pela cerca
compartilhada, deriva um schema filho exclusivo e só permite criar/remover esse
filho mediante recibo de ownership. Contato, desafio e auditoria usam suas
migrations reais. A matriz cobre ownership, sessionVersion, falha de auditoria,
unicidade e interleavings de start/check.

Mocks provam o contrato local, não elegibilidade/templates da conta Twilio,
entrega real de OTP, configuração staging ou experiência E2E em dispositivo.
Rate limits existentes por usuário/IP continuam em memória do processo;
coordenação entre réplicas não foi ampliada nesta frente.
