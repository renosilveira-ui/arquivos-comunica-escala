# Sincronização automática com o Google Agenda

Decisão do PO (12/09/2026): o Escala+ é o centro da gestão de tempo do
médico, e isso não pode depender de apertar "Sincronizar agora". Este worker
faz, para cada conta conectada, exatamente o que o botão faz.

## O que roda

`server/cron/google-calendar-sync-dispatcher.ts`, iniciado com os outros
workers em `server/_core/index.ts`. Tick a cada 60 s; cada tick pega até 10
contas "na vez" e, para cada uma, executa `runGoogleFullSync`
(`server/integrations/google/full-sync.ts`):

1. exportar plantões (Escala+ → calendário "Escala+" no Google);
2. ler o calendário "Escala+" (eventos nossos apagados lá são esquecidos aqui);
3. importar compromissos do calendário principal (Google → Escala+).

O botão "Sincronizar agora" chama a mesma função. Dois caminhos que "quase"
fazem o mesmo é como um bug entra sem ninguém ver.

## Quem está "na vez" (`server/integrations/google/sync-policy.ts`)

- Só vínculos `CONNECTED` ou `DEGRADED`. `REAUTH_REQUIRED` e `DISCONNECTED`
  ficam de fora: a resposta para eles é o médico reconectar.
- A cada **15 minutos** por conta, os mais atrasados primeiro (índice
  `idx_user_external_credential_sweep`).
- Conta que falhou espera dobrando: 30 min, 1 h, 2 h… teto de **6 h**,
  contado da última mudança do vínculo (`updated_at`). O contador zera no
  primeiro sucesso.
- O processo lembra, em memória, quando tentou cada conta: uma falha que
  estourou antes de ser registrada (rede, banco) também espera 15 min.
  Perde-se no reinício — custa no máximo uma tentativa extra por conta.

## Paginação e cursor

O Google só entrega o sync token na **última** página, e **não o entrega**
quando a leitura inicial usa `orderBy` (parâmetro incompatível com sync
token). A leitura completa usa só `timeMin`; a importação segue até 4
páginas de 250 por execução (teto de 1000 eventos). Acima do teto não guarda
cursor: a próxima leitura recomeça do zero — correto, só mais caro. Antes
destas duas correções, toda conta ficava com cursor vazio para sempre e relia
a janela inteira a cada ciclo.

**Laço evitado.** Compromisso importado do Google (`source = GOOGLE`) nunca
é exportado de volta para o calendário Escala+. Sem isso o médico via cada
compromisso duas vezes na própria conta.

## O que aparece no log

- `google_sync_tick` — `synced`, `failed`, `skipped`, `importedCreated`,
  `exportedCreated`. Só quando houve trabalho.
- `google_sync_user_failed` — `userId` (numérico) e nome do erro. Nunca
  token, e-mail ou conteúdo de compromisso.
- `google_sync_not_configured` — uma vez por boot, se as variáveis do Google
  não estão presentes (o worker fica ocioso).
- `google_sync_schema_missing` — tabelas ausentes; o worker adormece até o
  próximo boot com a migração aplicada.

## Limites conhecidos

- **Render free**: o processo dorme após 15 min sem tráfego, e com ele o
  `setInterval`. Nada se perde; o próximo acesso acorda a instância e a
  varredura retoma pelos mais atrasados. Cobertura contínua exige instância
  sempre-on (decisão de custo do PO — ver `docs/operations/scaling.md`).
- Fuso para datas civis: o da primeira instituição da pessoa; sem vínculo,
  o padrão do sistema. O botão usa o fuso do aparelho.

## Como forçar / verificar

- Forçar uma conta: no app, Google Agenda → Sincronizar agora.
- Verificar no banco (staging): `user_external_credentials.last_synced_at`
  avança a cada ciclo; `personal_calendar_import_cursors.sync_cursor` deixa de
  ser NULL após a primeira leitura completa.
