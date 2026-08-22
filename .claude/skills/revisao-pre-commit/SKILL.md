---
name: revisao-pre-commit
description: Revisão obrigatória antes de qualquer commit/PR no Escala+. Roda os gates (typecheck, lint, testes no banco local), confere as convenções do repositório (tokens, fuso -03:00, diálogos cross-platform, copy em português, migrações manuais) e só libera o commit com veredito APROVADO. Use ao terminar uma mudança, antes de `git commit`, ou quando o usuário pedir "revisa antes de commitar".
---

# Revisão pré-commit — Escala+

Este skill é o portão de saída de qualquer mudança. Nada vai para `git commit`
sem passar por aqui. Ele complementa o hook `.githooks/pre-commit` (que roda
typecheck + lint automaticamente) com a revisão que máquina nenhuma faz:
escopo, convenções do produto, risco operacional.

Princípio: **correção definitiva, não remendo.** Se a revisão encontrar a
causa raiz em outro lugar, a mudança certa é lá — e o commit espera.

## 1. Gates automáticos (todos precisam passar)

```bash
pnpm typecheck            # app + servidor
pnpm lint                 # 0 erros; warnings novos = reprovado
```

Testes, sempre num banco local dedicado (NUNCA o DATABASE_URL do shell — o
seed apaga dados; o `.env.local` pode apontar para o staging):

```bash
DATABASE_URL="mysql://root:root@127.0.0.1:3306/escalas_test_<k>" pnpm exec drizzle-kit push --force
TEST_DATABASE_URL="mysql://root:root@127.0.0.1:3306/escalas_test_<k>" pnpm test
```

O container local é `escalas-test-mysql` (mysql:8.0, root/root). Se não
estiver de pé: `docker start escalas-test-mysql`.

Toda mudança de comportamento no servidor vem com teste novo ou ajustado
(`tests/*.test.ts`, estilo dos existentes: fixtures próprias, `createCaller`,
limpeza no `afterAll`). Tela nova ou fluxo novo no app sem teste de servidor
precisa de verificação visual relatada no PR.

## 2. Checklist de convenções (ler o diff inteiro: `git diff --staged`)

**Escopo e integridade**
- [ ] O diff contém só o que o pedido cobre. Arquivo "arrumado de passagem" → commit separado.
- [ ] Nada parcial sem aviso explícito no PR. Nada de `TODO` escondendo trabalho que deveria estar aqui.
- [ ] Nenhum `.env*`, chave, senha, token ou dump de dados no diff.

**Servidor**
- [ ] Datas: instantes em UTC no banco; janelas de dia/turno sempre com offset explícito `-03:00` (convenção `buildShiftTimestamps`). Nunca `new Date("YYYY-MM-DDT00:00:00")` sem offset.
- [ ] Mutações com mais de um write → `db.transaction`; transições de estado com guarda (`WHERE status = ?` + `affectedRows`) e erro `CONFLICT` em português.
- [ ] `insertId` do próprio INSERT — nunca `SELECT LAST_INSERT_ID()` em outra chamada.
- [ ] Mudança em `drizzle/schema.ts` → arquivo em `drizzle/migrations/manual/YYYY-MM-DD-*.sql` **e** aviso destacado no PR: "aplicar no staging ANTES do merge" (o deploy não roda migração; o incidente de 22/08 derrubou o login por isso).
- [ ] Nenhum `db.execute<any>` novo; usar o query builder ou `rowsFromExecute<Row>`.
- [ ] Erros para o usuário em português, específicos ("Esta oferta já foi respondida por outra pessoa."), nunca genéricos.
- [ ] Endpoint novo: autorização via `server/_core/policy.ts` (`getTenantActorFromContext`, `assertCanManageInstitutionSchedule`, `assertManagerScopeAccess`) e tenant (`ctx.institutionId`) em todo `WHERE`.
- [ ] Logs com valor vindo do usuário → `JSON.stringify` (CodeQL `js/log-injection`).

**App (React Native + web)**
- [ ] Zero literal de cor/spacing/fonte em `app/` e `components/` — só `theme.*` (`lib/theme.ts`).
- [ ] API web-only (`window`, `localStorage`, `document`, `navigator`) só atrás de `Platform.OS === "web"`.
- [ ] Feedback de ação via `hooks/use-action-feedback.ts` (toast); confirmação irreversível via `confirmDestructive`; nunca `Alert.alert` / `window.alert` direto.
- [ ] Status de plantão via `lib/shift-status.ts` / `ShiftStatusBadge` — nunca enum cru na tela.
- [ ] Tela com query: `isError` → `QueryErrorState` com retry; nunca empty state em erro.
- [ ] Alvo de toque ≥ 44pt (`AppButton` md), texto de dado ≥ 12px, contraste ≥ 4,5:1 (texto em tom `[700]`/`[600]` sobre tint `*Soft`).
- [ ] Copy em português, sentence case ("Confirmar presença"), sem jargão de sistema.
- [ ] Rota nova em `app/(tabs)/` → entrada em `_layout.tsx` com `href` condicional por papel e ícone próprio em `TabIcon`.

**Segurança**
- [ ] Origem/Host/input do usuário nunca ecoado em header sem allow-list (`security.ts`).
- [ ] Sem dependência nova sem justificativa no PR; pacotes `expo-*` presos ao SDK.

## 3. Veredito

Responder com um bloco curto:

```
REVISÃO PRÉ-COMMIT
gates: typecheck ✅ | lint ✅ (0 erros, N warnings pré-existentes) | testes ✅ (X arquivos, Y testes)
escopo: ok | convenções: ok | migração: n/a | risco: baixo
veredito: APROVADO — pode commitar
```

Se qualquer item falhar: `veredito: REPROVADO` + lista do que falta, e **não**
commitar. Problema pequeno e claro (import, guarda, token, mensagem) →
corrigir e rodar os gates de novo. Problema estrutural → parar e expor ao
usuário antes de remendar.

## 4. Mensagem de commit

Convencional, em português, com o **porquê**:

```
tipo(escopo): o que muda em uma linha

Contexto do problema (1–3 frases), decisão tomada e o que foi
deliberadamente deixado de fora.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

Tipos: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `revert`.
