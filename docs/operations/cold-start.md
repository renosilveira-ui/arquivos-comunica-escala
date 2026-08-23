# Cold start: por que o app "demora para carregar" e o que foi feito

Diagnóstico de 23/08/2026, a partir dos logs e métricas do Render
(serviço `escalas-staging`, `srv-d7sh0lbrjlhs73bu9hgg`).

## O que acontecia

| Abertura do app (build 15) | Instância | Lote inicial da Agenda |
|---|---|---|
| 04:22Z | dormindo → "Running 'pnpm start'" 04:21:45, `listening` 04:22:14 | **63 s** |
| 06:50Z | dormindo → "Running" 06:49:38, `listening` 06:50:06 | **47–64 s** (lote enviado 2×) |
| build 14, 02:10Z | reiniciando por deploy | 15 s |

- O serviço está no **plano free** do Render: dorme após 15 min sem
  tráfego e acorda com o primeiro pedido. Acordar = agendar o container
  (~10–30 s) + `pnpm start` (~20 s só para chegar ao `node`, 0,1 CPU) +
  boot do Node (~10 s, com "Reparsing as ES module") + primeira conexão
  TLS ao MySQL da DigitalOcean em NYC.
- Nada disso mudou entre a build 14 e a 15 (nenhum commit em
  `app/_layout.tsx`, `hooks/use-auth.ts`, `lib/tenant-state.ts`,
  `lib/trpc.ts` ou no caminho por requisição do servidor). A diferença de
  percepção foi o **estado da instância** no momento do teste.
- O app agravava: `AuthGuard` mostrava spinner sobre fundo preto até
  `professionals.listMyInstitutions` responder — mesmo com usuário,
  instituição e a agenda da última abertura já conhecidos. E o
  `invalidateQueries()` na hidratação do usuário cancelava e reenviava o
  lote de abertura (duas requisições idênticas, ambas presas no cold
  start).
- Deploy de 03:04Z falhou por "port scan timeout": o health check
  (`pingDb` com 2 s) estourou na primeira conexão TLS e o Render não
  liberou o deploy; o serviço respondeu 503 até o deploy seguinte.

## O que foi corrigido (código)

**App abre do cache, revalida em segundo plano**
- `lib/query-persist.ts` + `lib/query-persist-policy.ts`: cache do
  react-query persistido no AsyncStorage, **por usuário + instituição**,
  só para consultas de leitura de abertura (lista na policy), 24 h de
  validade, apagado no logout. Testes em `tests/query-persist-policy.test.ts`.
- `app/_layout.tsx`: com usuário e instituição em cache o guard não
  bloqueia mais; `listMyInstitutions` roda em segundo plano e só
  derruba a seleção se o servidor disser que a instituição não é mais do
  usuário. Troca de conta zera o cache (`queryClient.clear()`); a
  hidratação inicial não reenvia o lote. O navigator monta uma vez
  (`TenantScope` espera o usuário ser conhecido).
- `components/BootScreen.tsx`: fundo do app, wordmark, spinner e, após
  2,5 s, "Conectando ao servidor… O primeiro acesso pode levar até um
  minuto" — no lugar da tela preta.
- `hooks/use-auth.ts`: usuário restaurado do cache é revalidado em
  segundo plano (`/api/auth/me`); só 401/403 real desloga (sessão
  revogada, B3), falha de rede mantém o cache.
- Telas (Agenda, Perfil, Painel, Solicitações, Vagas, ofertas): erro de
  refetch **com dados em cache** mantém os dados; `QueryErrorState` só
  quando não há nada a mostrar.
- `lib/session-events.ts`: manter dados em cache num erro não pode
  esconder sessão revogada — todo `UNAUTHORIZED` do tRPC (consulta ou
  mutação) dispara a revalidação em `/api/auth/me` (no máximo 1×/10 s);
  401/403 real encerra a sessão local por completo (token, usuário,
  instituição, cache em disco e em memória). `FORBIDDEN` não conta: é
  falta de permissão para uma procedure.

**Servidor sobe mais rápido e não paga TLS no primeiro pedido**
- `server/_core/index.ts`: pool aquecido (`pingDb(8000)`) antes do
  `listen`.
- `server/db.ts`: `pingDb` 5 s (era 2 s); pool com keep-alive, até 4
  conexões ociosas por 10 min (era 60 s → reconectava com TLS a cada
  pausa).
- `package.json` / `render.yaml`: bundle `dist/index.mjs` (sem reparse
  ESM) e `startCommand: node dist/index.mjs` (sem os ~20 s do pnpm).
  Se o serviço não for gerido pelo Blueprint, espelhar o Start Command
  no dashboard.

## O que é decisão de custo (PO)

O spin-down só deixa de existir com plano pago: **Starter, US$ 7/mês**
(`plan: starter` em `render.yaml` ou no dashboard). Com o código acima o
app abre na hora mesmo com a instância dormindo, mas dados novos
(plantão criado há pouco, confirmação pendente) só chegam quando ela
acorda. Para o piloto no São Carlos, recomendação: Starter.

## Como medir

- Cold start real: deixar o serviço 20 min sem tráfego e medir
  `curl -w "%{time_total}" https://escalas-staging.onrender.com/api/health`.
- Boot do processo: nos logs do Render, intervalo entre "Running" e
  `api server listening`; esperar `db pool warm` antes do `listening`.
- No app: abrir com o servidor dormindo — a Agenda deve aparecer com o
  último estado e atualizar sozinha quando o servidor responder.
- Duplicidade: nos request logs, um único lote
  `getMyCapabilities,listMyInstitutions,getNextShift,…` por abertura.
