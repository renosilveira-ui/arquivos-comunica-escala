# Operations: horizontal scaling

> O outbound Escala → Comunica+ permanece desabilitado na Beta. Não altere
> `COMUNICA_PLUS_OUTBOUND_ENABLED=0` para `1` sem o gate descrito abaixo.

## Estado atual do outbound Comunica+

`ROSTER_PUBLISHED` e `SHIFT_SWAP_APPROVED` são persistidos na tabela
`notifications`, na mesma transação da mudança de escala e da auditoria. O
worker usa namespace versionado, `dedupKey`, lease de 120 segundos e CAS por
`phase + revision`. Isso permite que múltiplas instâncias disputem o trabalho
sem enviar a mesma intenção local simultaneamente e recupera leases expirados
após crash.

As únicas estruturas process-local do conector são otimizações limitadas:

- sessão externa com TTL de 15 minutos;
- cache `organização + email → UUID` com TTL positivo de 5 segundos, negativo
  de 15 segundos, limite de 2.000 entradas e colapso de resoluções concorrentes.

Cada réplica pode autenticar e preencher esses caches separadamente. Isso reduz
o hit rate do cache, mas não concede autoridade: imediatamente antes da rede o
worker revalida tenant, instituição ativa, vínculo, usuário, e-mail, ACL,
hospital/setor, assignment e versão do roster/swap no MySQL.

Não existe mais `presenceCache` neste conector. Presença online não participa
da decisão de escala nem do outbound.

## Por que o flag permanece em 0

O contrato atual de `notices.createStructuredNotice` não aceita uma chave de
idempotência do Escala. Portanto, um timeout ou crash depois de o Comunica+
criar a notice, mas antes de o Escala persistir `SENT`, pode fazer o retry criar
uma segunda notice. Lease/CAS fecha concorrência local; não prova exatamente
uma vez no sistema externo.

Enquanto esse contrato não existir, o worker sem opt-in:

- não lê credenciais e não inicia rede;
- mantém a intenção em `PENDING/QUEUED` com backoff limitado a 30 minutos;
- nunca transforma indisponibilidade ou flag desligado em falha terminal.

## Gate para habilitar

Só definir `COMUNICA_PLUS_OUTBOUND_ENABLED=1` depois de todos os itens:

1. Comunica+ aceitar e garantir unicidade de uma chave idempotente por notice.
2. Escala enviar o `dedupKey` persistido e validar o recibo correspondente.
3. Testes de crash/timeout provarem ausência de duplicação após aceite remoto.
4. Mapeamento instituição → organização e credencial por organização serem
   validados operacionalmente.
5. Revisão de segurança e aprovação operacional explícitas concluídas.

O flag não autoriza deploy nem aumento de réplicas. Antes de alterar
`numInstances`, faça uma revisão horizontal do serviço inteiro; esta página
descreve somente o conector Comunica+.
