# Alvo destrutivo da suíte padrão V1

O seed da suíte padrão remove fixtures antes de recriá-las. Por isso, um nome
como `escalas_test` não é autorização suficiente.

## Contrato

A suíte só abre o banco quando todos estes valores são explícitos:

- `NODE_ENV=test`;
- `TEST_DATABASE_ALLOW_DESTRUCTIVE=1`;
- `TEST_DATABASE_URL` apontando para MySQL em loopback;
- `TEST_DATABASE_EXPECTED_NAME` idêntico ao banco da URL e com nome de teste;
- `TEST_DATABASE_DISPOSABLE_MARKER` com 32 a 128 caracteres.

Além disso, o banco conectado precisa conter o marcador derivado exatamente
desse nome e desse valor. `DATABASE_URL` nunca substitui `TEST_DATABASE_URL`.

## Primeira preparação local

1. Crie um schema MySQL local novo e exclusivo para a execução.
2. Aplique `drizzle/schema.ts` enquanto todas as tabelas ainda estão vazias.
3. Execute o preparador com as cinco variáveis acima:

```sh
NODE_ENV=test TEST_DATABASE_ALLOW_DESTRUCTIVE=1 TEST_DATABASE_EXPECTED_NAME=escalas_test_destructive_fence_20260910 TEST_DATABASE_DISPOSABLE_MARKER='marcador-local-exclusivo-20260910-0001' TEST_DATABASE_URL='mysql://root:root@127.0.0.1:3306/escalas_test_destructive_fence_20260910' pnpm test:prepare-database
```

O preparador recusa a primeira marca se o schema não existir ou se qualquer
tabela já contiver uma linha. Depois de marcado, ele é idempotente somente com
o mesmo nome e marcador.

4. Aplique as migrations manuais exigidas pela suíte.
5. Rode o teste repetindo exatamente o mesmo alvo e marcador:

```sh
NODE_ENV=test TEST_DATABASE_ALLOW_DESTRUCTIVE=1 TEST_DATABASE_EXPECTED_NAME=escalas_test_destructive_fence_20260910 TEST_DATABASE_DISPOSABLE_MARKER='marcador-local-exclusivo-20260910-0001' TEST_DATABASE_URL='mysql://root:root@127.0.0.1:3306/escalas_test_destructive_fence_20260910' pnpm test
```

Se for necessário sincronizar o schema novamente, crie outro banco vazio e
outro marcador. Não marque nem reutilize bancos compartilhados, staging ou
produção.

Na CI, `escalas_test` continua permitido porque nasce dentro do serviço MySQL
efêmero de cada job. O próprio workflow cria a marca depois do schema vazio e
repete a autorização explicitamente apenas no step da suíte.
