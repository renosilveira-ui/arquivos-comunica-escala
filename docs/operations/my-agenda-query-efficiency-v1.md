# Consulta da Minha agenda

`shifts.listAgenda` aplica a existência de alocação ativa própria no SQL somente
quando `scope = minha`. A subquery `EXISTS` correlaciona profissional canônico,
turno, instituição, hospital e setor. Todos os valores externos continuam
parametrizados pelo Drizzle; não há consulta adicional por turno.

O predicado fica no `ON` do `LEFT JOIN shift_instances`, não no `WHERE`. Assim,
um vínculo válido sem plantões próprios ainda produz a linha sentinela do ator;
um vínculo revogado antes da consulta final produz zero linhas e `FORBIDDEN`.
Uma agenda vazia não se confunde com perda de acesso institucional.

Os joins das alocações permanecem completos nos turnos selecionados: colegas e
`activeCount` não se restringem ao profissional que consulta. `EXISTS` não
multiplica essas linhas quando o mesmo profissional tem duas alocações ativas.
O filtro final por `isMine`, as autorizações de contexto/tenant, a exceção própria
restrita e a cerca mensal DRAFT/PUBLISHED/LOCKED permanecem inalterados. O escopo
`geral` não recebe o novo predicado.

## Evidência local

`tests/my-agenda-query-efficiency.test.ts` observa o SQL e as linhas reais sem
substituir os resultados do banco. O cenário contém 184 turnos no tenant A, com
180 inteiramente alheios, dois próprios, um com alocação própria inativa e outro
com alocação própria de topologia contaminada. A mesma conta está em um tenant B
independente. Duas alocações próprias no mesmo turno exercitam cardinalidade.

No MySQL 8.0.45 local descartável, em 09/09/2026:

| Consulta | Linhas retornadas pela consulta principal | Turnos apresentados |
| --- | ---: | ---: |
| Geral | 553 | 184 |
| Minha | 7 | 2 |
| Minha sem alocações próprias | 1 (sentinela) | 0 |
| Minha com vínculo revogado entre preflight e consulta | 0 | FORBIDDEN |

O conteúdo de Minha é comparado integralmente com Geral filtrado por `isMine`.
Os dois turnos próprios preservam contagens 4 e 3 e nomes dos colegas.
`EXPLAIN FORMAT=JSON` da consulta real escolheu `access_type: ref` e
`key: idx_shift_assignments_prof_active` para `agenda_own_assignments`.
Esse índice já existe no schema. A seleção do plano depende das estatísticas;
o teste registra a escolha real sem exigir um plano fixo em outras instalações.

Gates da frente: 70 testes em sete suítes MySQL, 62 testes em oito suítes puras,
typecheck server, lint e diff-check. A validação não mede latência de produção nem
garante um fator de aceleração: comprova redução das linhas transferidas para
a aplicação nesse cenário e preservação do contrato. Sem migration ou build.
