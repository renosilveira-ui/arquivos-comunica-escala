# Aviso de "hora de sair" — operação

Avisa o médico quando sair de casa para chegar ao plantão, considerando
trânsito e previsão do tempo.

> **CODE COMPLETE / RUNTIME EXTERNAL UNVERIFIED.** O motor inteiro é
> exercitado contra provedores falsos. Nenhuma chamada real ao Google Routes
> ou ao WeatherKit foi feita nesta entrega.

---

## 1. A assimetria que manda no desenho

Errar para cedo custa minutos de espera. **Errar para tarde custa um plantão
começando sem anestesista.** Toda escolha duvidosa no motor arredonda para
sair antes — é por isso que o fallback padrão (40 min) é maior que a maioria
dos trajetos urbanos, e por isso a ausência do Google nunca vira ausência de
aviso.

## 2. Hierarquia da estimativa

Em `computeDeparture`, nesta ordem e sem reordenação possível:

| Ordem | Fonte                                 | Como aparece para o médico                                |
| ----- | ------------------------------------- | --------------------------------------------------------- |
| 1     | rota fresca do Google                 | "com trânsito agora" ou "tempo típico para o horário"     |
| 2     | último cálculo dentro do TTL (45 min) | "última estimativa disponível"                            |
| 3     | tempo fixo configurado                | "estimativa fixa — não foi possível consultar o trânsito" |

**A origem do número sempre aparece.** Um aviso que esconde ser fallback
convida o médico a confiar em algo que não é trânsito atual — e ele confia.

Só é chamado de trânsito atual o que o Google diferenciou do tempo estático.
Igual significa que ele não aplicou trânsito; dizer que aplicou seria inventar
precisão que o aviso propaga.

## 3. Por que fila persistida, e não `setTimeout`

No plano free do Render o processo dorme após 15 minutos sem tráfego, e com
ele morre qualquer timer. Um `setTimeout` de 8 horas simplesmente não existe
depois disso.

`departure_plans` é a fila. Cada fase é idempotente e separada:

1. **`syncDeparturePlans`** — reconcilia planos com as alocações. Cancela o
   que perdeu origem, cria o que falta. Não chama rede.
2. **`recomputeDuePlans`** — calcula rota e clima dos planos vencidos.
3. **`dispatchDueDepartures`** — envia o push de quem chegou a hora.

Separar permite que uma falha de rede na fase 2 não impeça a fase 3 de enviar
um plano que já tinha horário.

### Recálculo escalonado

24 h, 3 h e 1 h antes da saída. O trânsito do fim da tarde não se parece com o
previsto na véspera; três pontos cobrem a curva sem gastar cota.

## 4. Invalidação — o aviso não pode descrever um mundo que acabou

`shift_signature` e `origin_signature` guardam de que mundo o cálculo saiu. Se
o plantão mudou de horário, setor ou hospital, ou se o usuário trocou origem,
margem ou modo de transporte, a assinatura deixa de bater e o plano volta para
`PENDING`.

Sem isso o médico receberia "saia às 18h07" para um plantão que mudou de
hora — um aviso **pior que nenhum**, porque ele confia.

## 5. Envio: uma vez, ou nenhuma

- `dedup_key` inclui o minuto da saída. Recalculou e mudou o horário? Aviso
  novo, pode sair. Não mudou? Duas execuções produzem a mesma chave e o
  `UNIQUE` deixa só uma passar.
- O status vira `SENT` por CAS **antes** do envio. Perder um aviso é ruim;
  mandar cinco é pior — treina o médico a silenciar o app.
- Passados 10 minutos do horário, o plano é encerrado **sem enviar**. "Saia às
  18h07" entregue às 18h40 não ajuda: o médico confere o relógio e conclui que
  o app está errado.
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
- **Hospital sem coordenada não quebra nada**: cai para o fallback declarado.
  Um hospital novo herda esse comportamento seguro sem configuração.
- O fuso de cada plantão vem do hospital, com a instituição como padrão.

## 8. Limite operacional — precisa de decisão do PO

**No plano free do Render, o processo dorme após 15 minutos sem tráfego e o
`setInterval` do worker some com ele.**

A fila sobrevive: nada se perde, e o próximo acesso que acordar a instância
processa o atraso. Mas um aviso de saída atrasado passa da tolerância de 10
minutos e é descartado — ou seja, **na prática o médico pode não receber**.

Cobertura confiável exige uma das duas, e ambas custam:

| Opção               | Custo                | Efeito                                        |
| ------------------- | -------------------- | --------------------------------------------- |
| Render **Starter**  | US$ 7/mês            | instância sem spin-down; o worker roda sempre |
| Render **Cron Job** | cobrado por execução | chama o tick externamente                     |

`EXTERNAL_INFRA_ACTION_REQUIRED`. Não ativar sem aprovação de custo.

## 9. Variáveis

| Variável                              | Efeito se ausente                                           |
| ------------------------------------- | ----------------------------------------------------------- |
| `GOOGLE_MAPS_API_KEY`                 | sem busca de endereço e sem rota: tudo cai no fallback fixo |
| `WEATHERKIT_*` (4)                    | aviso sai sem a linha de clima                              |
| `EXTERNAL_CREDENTIALS_ENCRYPTION_KEY` | origem não pode ser gravada                                 |

Nenhuma delas impede o aviso de existir. Sem nenhuma configurada, o médico
que ligar a preferência ainda recebe "saia às X" com o tempo fixo dele.

## 10. Antes de usar em ambiente real

1. Aplicar `2026-09-10-external-integrations-foundation.sql`.
2. Aplicar `2026-09-11-departure-alerts.sql`.
3. Preencher `GOOGLE_MAPS_API_KEY` (exige faturamento ativo no Google Cloud —
   Places e Routes são pagos por requisição).
4. Gestor configura a localização de cada hospital.
5. Médico liga o aviso e cadastra a origem.
6. Decidir a questão do §8 antes do piloto depender do aviso.
