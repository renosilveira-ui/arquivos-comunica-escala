# Runbook — beta interna mobile em staging

> Este é o procedimento operacional para uma build física controlada do
> Escala+. O perfil canônico atual é `preview`, com distribuição interna e API
> de staging. Ele não produz TestFlight. Não executar uma build, submit ou
> deploy sem autorização explícita e sem `main` verde.

## O que este perfil entrega

| Plataforma | Comando | Resultado |
| --- | --- | --- |
| iOS | `pnpm dlx eas-cli@latest build --platform ios --profile preview` | `.ipa` ad hoc instalável somente em aparelhos com UDID registrado |
| Android | `pnpm dlx eas-cli@latest build --platform android --profile preview` | APK interno instalável pelo link do EAS |

Ambos apontam para `https://escalas-staging.onrender.com`. TestFlight,
Transporter, `eas submit` e Play Store não fazem parte deste runbook. Eles
requerem uma futura configuração de distribuição de loja aprovada; não usar o
perfil `production` por inferência.

## Pré-condições

Antes de iniciar, confirmar:

1. SHA de `main` fixado, PRs da frente integradas e todos os gates verdes.
2. Operador autenticado na conta EAS que possui o `projectId` já configurado.
3. iOS: Apple Developer ativo e UDID do aparelho físico registrado no
   provisioning profile interno. Android: aparelho físico disponível para APK.
4. Push: permissões do aparelho, APNs e FCM V1 disponíveis para staging.
5. Conta e dados de teste não clínicos definidos para o smoke.
6. Quota/concurrency do plano EAS confirmadas; `autoIncrement: true` consome
   uma versão nativa remota a cada build `preview` disparada.

Não rodar `eas init`: o projeto EAS já está vinculado no repositório. Não
trocar bundle ID, package ou scheme durante uma beta.

## Fase 0 — validação local

No worktree da revisão aprovada:

```bash
pnpm install --frozen-lockfile
pnpm -s typecheck
pnpm lint
pnpm dlx eas-cli@latest whoami
pnpm exec expo config --type public
```

Parar se qualquer comando falhar ou se a configuração pública não mostrar a
identidade `com.comunicamais.escalas`, o plugin `expo-notifications` e o
projeto EAS esperado.

## Fase 1 — build iOS ad hoc

1. Confirmar no portal/credenciais EAS que o UDID do iPhone de teste já foi
   incluído no provisioning profile de distribuição interna.
2. Disparar somente após a autorização operacional:

   ```bash
   pnpm dlx eas-cli@latest build --platform ios --profile preview
   ```

3. Ao terminar, registrar SHA, horário, perfil, URL de staging, EAS build ID e
   link do artefato.
4. Abrir o link de distribuição interna no iPhone registrado e instalar o
   `.ipa` conforme a página do EAS.

Não baixar o `.ipa` para enviar ao Transporter, não criar grupo de TestFlight
e não usar `eas submit`. Se o iPhone não estiver registrado, parar e ajustar
o provisioning profile antes de gerar outra build.

## Fase 2 — build Android APK

1. Disparar somente após a autorização operacional:

   ```bash
   pnpm dlx eas-cli@latest build --platform android --profile preview
   ```

2. Registrar SHA, horário, perfil, URL de staging, EAS build ID e link do
   artefato.
3. Abrir o link no aparelho de teste, instalar o APK e conceder a permissão de
   instalação dessa origem se o Android solicitar.

## Fase 3 — smoke físico de aceite

Executar no aparelho instalado e registrar aprovado/reprovado para cada item:

1. login e retorno do segundo plano sem perda de sessão;
2. troca A → B → A de instituição, sem hospital/setor/filtro de A em B;
3. carregamento de Trocas, Vagas e Pendências; erro e retry quando aplicável;
4. vaga autorizada: contagem, lista e deep link apontam para o mesmo estado;
5. push em foreground e background, receipt e roteamento; e
6. badge definido para a conta, sem evidência com mensagem, IDs, instituição
   ou qualquer dado clínico.

Uma falha é bloqueadora para ampliação da beta. Registrar a evidência técnica
sem tokens, credenciais ou dados clínicos e abrir uma PR pequena para a causa
raiz.

## Fase 4 — mudanças após a build

Não usar `eas update --branch preview`: o projeto ainda não tem configuração
canônica de EAS Update. Para uma alteração que precise ir ao aparelho, repetir
os gates e gerar uma nova build `preview` autorizada.

## Fora de escopo deste runbook

- TestFlight, App Store, Play Store e qualquer `eas submit`;
- criação ou troca de perfis EAS, bundle ID/package/scheme;
- deploy de backend, troca de URL de API ou variáveis de produção; e
- configuração de APNs/FCM, que é uma ação externa com autorização própria.

## Referências

- [`mobile-deploy.md`](./mobile-deploy.md): contrato de perfis e limites.
- [`eas.json`](../../eas.json): perfis canônicos.
- [`app.config.ts`](../../app.config.ts): identidade e plugins nativos.
