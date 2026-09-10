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

Queda do processo ou falha da auditoria após a rede pode deixar STARTING. Esse
estado nunca autoriza check; expirado, é convertido para FAILED na próxima
consulta de check, ou substituído por novo start. A expiração lógica independe
de job de limpeza. Não existe retry automático de envio nem fallback SMS.

Uma transação local não desfaz um envio/consumo já ocorrido na Twilio. Se a
auditoria falhar depois disso, o banco não marca verifiedAt e o cliente recebe
erro; pode ser necessário iniciar outro código. O evento REQUESTED anterior
permanece para rastrear a tentativa, sem afirmar que o provider foi concluído.

## Implantação futura, não executada nesta frente

1. Confirmar o banco/ambiente autorizado e backup operacional.
2. Aplicar `2026-09-09-whatsapp-account-ownership.sql` antes do código, após a
   migration original `2026-08-31-user-contact-channels.sql`.
3. Rerodar e validar o postflight. Ele falha em tabelas/índices incompatíveis;
   DDL MySQL não é transacional, portanto investigar falha sem apagar dados.
4. Publicar somente após revisão e autorização próprias da integração.

É aditiva: contatos já verificados são preservados. OTPs pendentes de versões
anteriores não possuem desafio correlacionado e exigem novo start. Durante
rollout misto, instâncias antigas não implementam esse contrato; drenar tráfego
de mutações WhatsApp das versões antigas antes de declarar o gate fechado.

## Evidência local e limites

O gate descartável está excluído do `vitest.config.ts` padrão. Na integração
coordenada com a frente do runner destrutivo, adicionar ao CI a execução explícita
de `vitest.whatsapp-account.config.ts`. Esta frente não modifica workflow nem
executa CI/build. As regressões legadas permanecem no teste padrão; a config
legada aqui permite verificá-las também sem seed global ou banco compartilhado.

```sh
pnpm exec vitest run --config vitest.whatsapp-account.config.ts
pnpm exec vitest run --config vitest.whatsapp-account-legacy.config.ts
pnpm exec vitest run --config vitest.pure.config.ts tests/whatsapp-verification-provider.test.ts tests/whatsapp-verification-source.test.ts tests/whatsapp-verification-rate-limit.test.ts tests/whatsapp-contact-source.test.ts tests/user-contact-channels-migration.test.ts
pnpm typecheck
pnpm lint
git diff --check
```

As duas configs MySQL criam nomes exclusivos em `127.0.0.1` (MySQL 8, root/root
do ambiente descartável de desenvolvimento), não leem DATABASE_URL e removem
apenas o banco que a própria execução criou. A suíte legada usa scaffolding das
cinco tabelas auxiliares, não certifica o schema institucional inteiro; contato,
desafio e auditoria usam suas migrations reais. A matriz cobre ownership,
sessionVersion, falha de auditoria, unicidade e interleavings de start/check.

Mocks provam o contrato local, não elegibilidade/templates da conta Twilio,
entrega real de OTP, configuração staging ou experiência E2E em dispositivo.
Rate limits existentes por usuário/IP continuam em memória do processo;
coordenação entre réplicas não foi ampliada nesta frente.
