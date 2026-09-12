# Ledger de migrações manuais e checagem de drift

Itens 3 e 8 do plano de bancos (12/09/2026). Fecham o ponto cego que deixou
`2026-08-24-push-token-provenance.sql` 18 dias sem aplicar e
`audit_trail.action` meses sem sete valores que o código grava, com CI verde.

## Por que a CI não vê drift

A CI monta o banco de teste a partir de `drizzle/schema.ts` (`drizzle-kit
push --force`). Testes passam contra o que o schema DIZ, não contra o que o
banco real TEM. Um banco construído só das migrações manuais não existe: a
base nasceu do Drizzle e a trilha manual é aditiva sobre ela. Logo a única
verificação verdadeira é comparar o schema com o banco real — e isso é
tarefa do operador, com credencial do ambiente.

## Ledger (`manual_migration_ledger`)

`pnpm apply:migration` passa a registrar, depois de cada aplicação bem-
sucedida: nome do arquivo, SHA-256 do conteúdo, primeira e última aplicação,
quantas vezes, nota opcional. A tabela é criada pelo executor (idempotente)
e declarada em `drizzle/schema.ts` para a checagem de drift não a apontar.

- **Está no ledger + hash igual ao arquivo atual** → aplicada como está no
  repositório.
- **Está no ledger + hash diferente** → o arquivo mudou depois de aplicado.
  Investigar antes de confiar.
- **Não está no ledger** → ou nunca foi aplicada, ou foi aplicada antes de o
  ledger existir. Conferir pela assinatura (abaixo) e registrar com
  `pnpm ledger:backfill "<motivo>" <arquivos…>`.

A cerca de prontidão V1 usa instalador dedicado e **não** passa pelo
executor genérico; registrá-la é manual (backfill), com a nota dizendo isso.

### Backfill feito no staging em 12/09/2026

Sonda por assinatura estrutural (CREATE TABLE / ADD COLUMN / ADD INDEX /
ADD CONSTRAINT / CREATE TRIGGER × `INFORMATION_SCHEMA`): das 39 migrações no
repositório, todas aplicadas exceto `2026-08-24-push-token-provenance.sql`
(item 4 do plano). O índice `uniq_prof_inst_user_institution` de
`2026-09-01-operational-events-foundation.sql` existe com o nome do Drizzle
(`professional_institutions_user_id_institution_id_unique`) — mesma
estrutura, nome diferente, não é drift.

## Checagem de drift (`pnpm schema:drift`)

Só leitura nos dois lados. Compara tabelas (engine), colunas (tipo,
nulidade, default, extra, collation binária ou não, expressão gerada),
índices (colunas + unicidade), CHECKs (cláusula), FKs (colunas → alvo) e
triggers (nome). Nomes de índice e de FK **não** contam: Drizzle e migrações
manuais nomeiam diferente, e o MySQL não se importa.

```bash
# 1) referência: banco LOCAL vazio recebendo o schema atual
docker exec escalas-test-mysql mysql -uroot -proot -e "DROP DATABASE IF EXISTS escalas_ref; CREATE DATABASE escalas_ref;"
DATABASE_URL='mysql://root:root@127.0.0.1:3306/escalas_ref' pnpm exec drizzle-kit push --force

# 2) comparar com o banco real (só leitura)
SCHEMA_DRIFT_REFERENCE_URL='mysql://root:root@127.0.0.1:3306/escalas_ref' \
DATABASE_URL='<URL do banco real>' DATABASE_SSL=insecure pnpm schema:drift
```

Sai com 1 se houver diferença fora de `drizzle/schema-drift-allowlist.json`.
A allowlist é curta e cada entrada diz o motivo (triggers da cerca e do
journal de convites: fora do Drizzle por desenho). **Não** acrescentar
entrada para calar drift real — a resposta para drift real é migração.

Quando rodar: depois de aplicar qualquer migração no ambiente e antes de
declarar "banco em dia" numa PR. O núcleo (`scripts/schema-drift-core.ts`)
tem teste puro na CI; a execução contra o banco real é do operador.

## MySQL: versão

Banco real em **8.0.45** (DigitalOcean controla o patch; há atualização
obrigatória marcada para 14/09/2026). A CI roda **8.0.46** porque três provas
de migração (auth-recovery, hash v2 e fence dos convites) exigem
explicitamente a serialização de catálogo comprovada nessa versão — pinar a
CI em 8.0.45 as faz falhar. Regra: o pino da CI e a versão exigida por essas
provas mudam JUNTOS, quando o banco real mudar; depois, rodar
`pnpm schema:drift`, porque a serialização de `CHECK_CLAUSE` pode variar
entre patches.
