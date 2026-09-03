---
name: revisao-4-passos
description: Revisão obrigatória em 4 passos antes de qualquer commit/PR no Escala+. Aplica-se sempre que uma tarefa termina, antes de `git commit`, ou quando o usuário pede revisão. Exige resolver a causa raiz de forma sistêmica (todas as instituições e setores) e complementa a skill revisao-pre-commit (gates typecheck/lint/testes).
---

# Revisão em 4 passos — Escala+

Governança de saída de qualquer mudança. Nada vai para `git commit`/PR sem
passar por aqui. Complementa `.claude/skills/revisao-pre-commit` (gates de
máquina) com uma revisão estruturada de defeitos e melhorias.

## Princípio de raiz (pré-requisito)

Antes das 4 revisões, a correção precisa atacar a **causa raiz**, com solução
aplicada ao **sistema inteiro** — valendo para **todas as instituições e
setores**, nunca um remendo para um único caso (ex.: um usuário, um setor).
Se o relato parece isolado, primeiro confirme se é **erro de classe**.

## Gates automáticos (todos precisam passar)

```bash
pnpm typecheck
pnpm lint            # 0 warnings novos
# testes num banco local dedicado (NUNCA o DATABASE_URL do shell)
TEST_DATABASE_URL="mysql://root:root@127.0.0.1:3306/escalas_test_<k>" pnpm test
```

## As 4 revisões (ordem obrigatória)

Execute **nesta ordem**, registrando o achado de cada passo:

1. **Revisão 1 — procurar erro na tarefa realizada. (obrigatório)**
2. **Revisão 2 — procurar outro erro na tarefa realizada (encontrar o erro é opcional).**
3. **Revisão 3 — procurar 1 melhoria na tarefa realizada (melhoria é obrigatória).**
4. **Revisão 4 — procurar 1 melhoria na tarefa realizada (melhoria é obrigatória).**

Regras:

- Revisão 1 é obrigatória de **executar**; busque de fato o erro no maior
  risco da mudança (ex.: enfraquecer um caminho fail-closed, contrato de
  teste, multi-tenant, leitura vs escrita).
- Revisão 2 é obrigatória de **executar**; **encontrar** o erro é opcional.
- Revisões 3 e 4 **exigem** cada uma **1 melhoria concreta** de fato entregue
  (observabilidade, cobertura de teste, resiliência, clareza) — não bastam
  sugestões vagas.
- Todo erro encontrado nas revisões 1–2 deve ser corrigido (ou justificado
  explicitamente como fora de escopo) antes do commit.

## Veredito

Só commite após um bloco de veredito explícito:

```
REVISÃO 4 PASSOS
raiz: causa raiz + sistêmica (todas instituições/setores) ✅
gates: typecheck ✅ | lint ✅ | testes ✅ (X arquivos / Y testes)
R1 erro: <achado ou "auditado, sem erro funcional — área de maior risco: ...">
R2 erro: <achado ou "sem erro (opcional)">
R3 melhoria: <melhoria entregue>
R4 melhoria: <melhoria entregue>
veredito: APROVADO — pode commitar
```

## Convenções que a revisão sempre confere

- Correção definitiva, não remendo: a causa raiz vale para todo o sistema.
- Servidor: mutações multi-write em `db.transaction`; transições com guarda
  (`WHERE status = ?` + `affectedRows`) e erro `CONFLICT` em português;
  leitura resiliente (uma linha problemática nunca derruba a lista inteira);
  escrita permanece **fail-closed**.
- Datas em UTC no banco; janelas de dia/turno com offset `-03:00`.
- Mudança em `drizzle/schema.ts` → migration manual em
  `drizzle/migrations/manual/AAAA-MM-DD-*.sql`, aditiva e rerodável, aplicada
  no staging **antes** do merge.
- Logs com valor vindo do usuário via `JSON.stringify` (CodeQL log-injection)
  e sem PII (telefone, corpo de mensagem, token).
