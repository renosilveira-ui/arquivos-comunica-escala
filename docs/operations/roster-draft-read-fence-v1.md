# Visibilidade mensal dos leitores de escala

Os leitores `calendar.getDay/getMonthGrid`, `shifts.get`, `shifts.listByPeriod`
e `shifts.listAgenda` exigem duas condições independentes: acesso canônico ao
contexto/plantão e permissão de leitura do estado mensal.

| Autoridade no contexto | DRAFT ou mês ausente | PUBLISHED / LOCKED |
| --- | --- | --- |
| `canManage: true` | Pode ler | Pode ler |
| Sem `canManage` | Não pode ler | Pode ler, sujeito ao acesso canônico |

O papel global ou institucional de gestor, sozinho, não substitui `canManage`:
um gestor médico fora do seu `manager_scope` segue a regra do USER. O entitlement
de leitura entre escalas amplia contextos legíveis, mas não publica rascunhos.

Uma alocação própria não libera DRAFT. A exceção já existente para um plantão
próprio sem ACL/contexto legível continua somente em meses publicados/trancados;
quando ela é a única autorização, o resultado não contém assignments ou nomes
de colegas. Havendo acesso ao contexto, prevalece essa autoridade, inclusive
para um gestor que também esteja alocado.

`shifts.get` e os leitores de calendário recusam rascunhos com `FORBIDDEN`.
As listas omitem esses turnos, inclusive `scope: minha`, sem expor contadores
ou nomes dos rascunhos. Tenant/contexto inválido mantém as recusas existentes.

O estado vem de `monthly_rosters`, por instituição, hospital e mês civil BRT do
início do plantão. Ausência/estado desconhecido não comprova publicação. A
consulta mensal é deduplicada em lote: uma query por reader, independentemente
da quantidade de hospitais, meses ou turnos; período vazio não consulta estados.

Não há migration nem mudança no fluxo de publicar/trancar o mês. A mudança é
de autorização de leitura e afeta dados existentes imediatamente quando o código
for integrado e implantado pelo fluxo autorizado.
