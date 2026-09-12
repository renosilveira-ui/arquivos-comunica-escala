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

## Collation: uma só, e a checagem enxerga

Até 12/09/2026 o banco real tinha **duas famílias de collation**: 10 tabelas
criadas por migrações manuais em `utf8mb4_unicode_ci`, as outras 49 e o schema
Drizzle em `utf8mb4_0900_ai_ci`. Um `JOIN`, `UNION` ou comparação entre colunas
de texto das duas famílias devolve o erro **1267, "Illegal mix of collations"**.

A checagem de drift não via, e não via **de propósito**: ela normalizava
collation para apenas "binária ou não", justamente para acomodar essa
divergência. O preço foi a divergência ficar invisível para a ferramenta criada
para enxergar divergência.

`2026-09-12-unify-table-collation.sql` converteu as 10 tabelas e
`normalizeCollation` passou a comparar a collation **por inteiro**. Duas
consequências práticas:

- uma tabela nova em collation diferente aparece como drift, não passa batido;
- perder uma collation **binária deliberada** também aparece.

**A armadilha que essa migração teve de desviar**, e que vale para qualquer
conversão futura: `ALTER TABLE ... CONVERT TO CHARACTER SET` **sobrescreve a
collation de coluna**, inclusive as `utf8mb4_bin` que existem por decisão de
segurança — `push_tokens.token`, `departure_plans.dedup_key`,
`auth_recovery_requests.token_hash` e outras. Converter em bloco sem restaurar
essas colunas transforma chave de deduplicação e token em *case-insensitive*,
em silêncio. Ao escrever uma conversão, liste antes as colunas binárias da
tabela (`INFORMATION_SCHEMA.COLUMNS`, `COLLATION_NAME = 'utf8mb4_bin'`),
restaure-as depois e confira no postflight.

## Quando uma migração falha no meio

`pnpm apply:migration` passa a imprimir um aviso explícito antes de propagar o
erro. O ledger **continua registrando só sucesso** — um ledger que registra
tentativa é um ledger que mente. O que o aviso resolve é outra coisa: DDL no
MySQL faz *commit* implícito, então um arquivo de vários passos que falha no
meio deixa os anteriores aplicados e **nada** no ledger.

O caminho de saída é sempre o mesmo: corrigir a causa, rodar o mesmo comando de
novo (toda migração manual daqui é guardada e rerodável, é para este momento que
a regra existe) e conferir com `pnpm schema:drift` antes de mergear.
