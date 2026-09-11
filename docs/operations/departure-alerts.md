# Aviso de "hora de sair" — operação

Avisa o médico uma hora antes de cada plantão, com a estimativa de trânsito
daquele momento e a previsão do tempo.

> **CODE COMPLETE / RUNTIME EXTERNAL UNVERIFIED.** O motor inteiro é
> exercitado contra provedores falsos. Nenhuma chamada real ao Google Routes
> ou ao WeatherKit foi feita nesta entrega — o comportamento sem provedor,
> esse sim, está coberto por teste.

---

## 1. O que o médico recebe

Uma notificação por plantão, **sempre uma hora antes**, com o que houver:

> **Horário do plantão se aproxima**
> UTI · São Carlos, às 19:00. Noite com chuva. Trânsito com tempo estimado de
> 25 min — saia até 18:35.

Sem Google configurado, ou com o Google fora do ar, o aviso sai igual — e
admite o que não sabe:

> **Horário do plantão se aproxima**
> UTI · São Carlos, às 19:00. Estimativas de trânsito não disponíveis.

## 2. As três regras que mandam no desenho

**1. O horário do aviso é fixo.** Uma hora antes, sempre. Não depende do
trânsito, não depende de o Google responder, não depende de configuração. Um
aviso que só existe quando tudo dá certo é um aviso em que não se pode
confiar — e confiança é o que faz o médico deixar a notificação ligada.

**2. O sistema não pergunta nada.** Nem folga de chegada, nem tempo de
trajeto. O objetivo é sempre estar no hospital quando o plantão começa, e o
trajeto quem calcula é o Google. A única preferência é ligado ou desligado (o
modo de transporte fica em carro e não é perguntado).

**3. Sem trânsito, o sistema NÃO inventa tempo de trajeto.** Uma versão
anterior chutava 40 minutos e chamava aquilo de estimativa. No aparelho do
médico um número inventado tem a mesma aparência de um calculado: ele não
distingue, confia, e sai tarde num dia de chuva. O banco reforça a regra —
`chk_departure_plan_estimate` recusa plano com horário de saída sem duração,
e vice-versa.

`RouteEstimateQuality` tem dois valores, `LIVE_TRAFFIC` e `TYPICAL`, e só o
primeiro é trânsito atual. Igual ao tempo estático significa que o Google não
aplicou trânsito; dizer que aplicou seria inventar precisão que o aviso
propaga. A mensagem por isso diz "tempo estimado", nunca "trânsito agora" — a
qualidade fica registrada na coluna `estimate_quality`, para diagnóstico, sem
virar promessa na tela do médico.

## 3. Por que fila persistida, e não `setTimeout`

No plano free do Render o processo dorme após 15 minutos sem tráfego, e com
ele morre qualquer timer. Um `setTimeout` de 8 horas simplesmente não existe
depois disso.

`departure_plans` é a fila. Cada fase é idempotente e separada:

1. **`syncDeparturePlans`** — reconcilia planos com as alocações. Cancela o
   que perdeu origem, cria o que falta, ressuscita o que foi religado. Não
   chama rede.
2. **`recomputeDuePlans`** — calcula rota e clima dos planos vencidos.
3. **`dispatchDueDepartures`** — envia o push de quem chegou a hora.

Separar permite que uma falha de rede na fase 2 não impeça a fase 3 de enviar
um plano que já tinha estimativa.

### A reconciliação é do worker, não só da tela

`reconcileEnabledUsers` roda a cada **5 minutos**, varrendo quem tem o aviso
ligado com cursor por `user_id` (lotes de 100, dando a volta ao fim da lista).

Sem isso o aviso só existiria para plantões que já estavam na escala quando o
médico ligou a preferência. A escala muda toda semana: o gestor alocaria, o
médico não receberia nada, e ninguém descobriria por quê. É a única fase que
varre usuários — por isso a cadência é folgada, e por isso ela não chama rede.

### Uma consulta de rota por plantão

O cálculo roda **10 minutos antes do aviso** — ou seja, 70 minutos antes do
plantão — e `next_recompute_at` vira `NULL` logo depois. A pergunta é "quanto
leva agora", e ela só tem resposta útil agora: calcular na véspera gastaria
cota para descrever um trânsito que o médico não vai pegar.

`NULL` em `next_recompute_at` significa **já calculado, nada a fazer** — nunca
"calcule agora". Places e Routes cobram por requisição; tratar `NULL` como
vencido faria cada tick reconsultar o Google para todo plano já resolvido.

## 4. Invalidação — o aviso não pode descrever um mundo que acabou

`shift_signature` e `origin_signature` guardam de que mundo o cálculo saiu. Se
o plantão mudou de horário, setor ou hospital, ou se o usuário trocou a origem
ou o modo de transporte, a assinatura deixa de bater e o plano volta para
`PENDING` com chave de deduplicação nova.

Sem isso o médico receberia um aviso descrevendo um plantão que mudou de
hora — **pior que nenhum**, porque ele confia.

A reconciliação também olha planos em estado terminal, e a distinção importa
nos dois sentidos (`needsReset`):

| Estado anterior | Mundo igual                      | Mundo mudou |
| --------------- | -------------------------------- | ----------- |
| `PENDING` / `SCHEDULED` | já está na fila, nada a fazer | volta para `PENDING` |
| `SENT`          | não reenvia — reenviar treina o médico a silenciar | novo aviso |
| `CANCELLED`     | ressuscita se o aviso ainda está no futuro (foi o usuário desligando e religando) | novo aviso |

## 5. Envio: uma vez, ou nenhuma

- `dedup_key` inclui o minuto do aviso. Plantão remarcado? Aviso novo, pode
  sair. Não mudou? Duas execuções produzem a mesma chave e o `UNIQUE` deixa
  só uma passar.
- O status vira `SENT` por CAS **antes** do envio. Perder um aviso é ruim;
  mandar cinco é pior — treina o médico a silenciar o app.
- Passados **30 minutos** do horário, o plano é encerrado **sem enviar**. A
  tolerância é generosa porque o aviso sai uma hora antes: meia hora de
  atraso ainda deixa meia hora útil. Depois disso ele atrapalha — o médico
  confere o relógio e conclui que o app está errado.
- Uma entrega que falha não derruba o lote: os outros médicos do mesmo tick
  têm plantão hoje também. O plano continua `SENT` de propósito — o outbox de
  push tem retry próprio, e reverter aqui abriria a porta para o mesmo aviso
  sair duas vezes.
- O envio usa `enqueueTrackedPushNotification`, o outbox durável que já
  existe — herda idempotência, retry, receipts e limpeza de token inválido. Um
  caminho paralelo de push seria uma segunda chance de errar tudo isso.

## 6. Privacidade

O endereço residencial é o dado mais sensível que este sistema toca.

- **Opt-in explícito.** Sem `enabled = 1`, nenhum plano é criado.
- **Consentimento datado** (`consent_granted_at`, `consent_version`), exigido
  na persistência.
- **Selado em repouso** com escopo `TRAVEL_ORIGIN` e AAD ligada ao dono: um
  envelope copiado para outra conta não abre.
- **Nenhuma coluna em claro** de coordenada, endereço ou Place ID.
- **Nunca em lista**: a tela mostra o rótulo ("Casa"), nunca o endereço.
- **Apagável** pelo usuário, de verdade — `DELETE`, não flag.
- Coordenada **arredondada** (~110 m) antes de ir ao WeatherKit.
- Apagada junto com a conta (`ON DELETE CASCADE`).
- Nenhum log registra coordenada ou endereço.

## 7. Multi-instituição

A funcionalidade vale para qualquer instituição, hospital e setor — inclusive
criados depois. Há teste com duas instituições montadas em runtime, uma com
hospital localizado e outra sem.

- **Origem e preferências**: da conta, account-wide. O médico sai de casa uma
  vez; o destino pode ser qualquer hospital dos vínculos dele.
- **Destino hospitalar**: do tenant. `assertCanCreateHospital` governa, e o
  `WHERE` carrega `institution_id` — gestor de A não configura hospital de B.
- **Hospital sem coordenada não quebra nada**: o aviso sai no horário, sem a
  linha de trânsito. Um hospital novo herda esse comportamento seguro sem
  configuração.
- O fuso de cada plantão vem do hospital, com a instituição como padrão.

## 8. Limite operacional — precisa de decisão do PO

**No plano free do Render, o processo dorme após 15 minutos sem tráfego e o
`setInterval` do worker some com ele.**

A fila sobrevive: nada se perde, e o próximo acesso que acordar a instância
processa o atraso. Mas um aviso atrasado além de 30 minutos é descartado — ou
seja, **na prática o médico pode não receber**.

Cobertura confiável exige uma das duas, e ambas custam:

| Opção               | Custo                | Efeito                                        |
| ------------------- | -------------------- | --------------------------------------------- |
| Render **Starter**  | US$ 7/mês            | instância sem spin-down; o worker roda sempre |
| Render **Cron Job** | cobrado por execução | chama o tick externamente                     |

`EXTERNAL_INFRA_ACTION_REQUIRED`. Não ativar sem aprovação de custo.

## 9. Variáveis

| Variável                              | Efeito se ausente                                           |
| ------------------------------------- | ----------------------------------------------------------- |
| `GOOGLE_MAPS_API_KEY`                 | sem busca de endereço e sem rota: o aviso sai sem estimativa |
| `WEATHERKIT_*` (4)                    | aviso sai sem a linha de clima                              |
| `EXTERNAL_CREDENTIALS_ENCRYPTION_KEY` | origem não pode ser gravada                                 |

Nenhuma delas impede o aviso de existir. Sem nenhuma configurada, o médico que
ligar a preferência ainda recebe, uma hora antes de cada plantão, "Horário do
plantão se aproxima… Estimativas de trânsito não disponíveis."

## 10. Antes de usar em ambiente real

1. Aplicar `2026-09-10-external-integrations-foundation.sql`.
2. Aplicar `2026-09-11-departure-alerts.sql`.
3. Preencher `GOOGLE_MAPS_API_KEY` (exige faturamento ativo no Google Cloud —
   Places e Routes são pagos por requisição).
4. Gestor configura a localização de cada hospital.
5. Médico liga o aviso e cadastra a origem (opcional: sem ela o aviso sai
   sem estimativa).
6. Decidir a questão do §8 antes do piloto depender do aviso.


## Origem automática — o médico não digita endereço

Decisão do PO em 11/09/2026: o app pede a permissão de localização **"Sempre"**
e passa a informar de onde o médico sai, inclusive com o app fechado — que é
quando o aviso precisa. O endereço digitado continua existindo, mas só
aparece como plano B, quando a localização não está completa.

| Estado da permissão | O que a tela diz | Trânsito no aviso |
|---|---|---|
| nunca perguntado | "Deixe o Escala+ calcular sua saída" + botão | não |
| só "durante o uso" | "Falta liberar com o app fechado" + abrir ajustes | não |
| recusado | "Localização desligada" — o aviso continua, sem trânsito | não |
| "sempre" | "Localização ligada" | **sim** |

O que o sistema guarda: **um** ponto por conta, sob `AUTOMATIC_ORIGIN_LABEL`,
selado com AAD ligada ao dono. A chave única `(user_id, label)` faz cada
envio **substituir** o anterior — a garantia de "sem histórico" é do banco,
não de uma rotina de limpeza. Ponto que mal saiu do lugar (< 300 m) não
escreve; incerteza acima de 2 km é recusada. Desligar apaga a linha.

Custos declarados da permissão "Sempre": revisão mais rigorosa da Apple
(justificativa escrita nos textos de permissão), o aviso periódico do iOS
sobre uso em segundo plano, e bateria — mitigada com precisão `Balanced` e
`distanceInterval` de 300 m. Foram apresentados ao PO, que escolheu "Sempre".

Textos de permissão (iOS/Android) e orientação da tela são escritos para
leigo e cobertos por teste que falha se aparecer "GPS", "coordenada",
"servidor" ou "segundo plano".
