# Operações: builds mobile de staging

> Fonte de verdade: [`eas.json`](../../eas.json) e
> [`app.config.ts`](../../app.config.ts). Este documento descreve somente a
> distribuição interna atualmente configurada. Gerar um build ou fazer submit
> continua exigindo autorização operacional explícita.

## Contrato atual dos perfis

| Uso | Perfil/comando | Artefato e distribuição | Situação |
| --- | --- | --- | --- |
| Desenvolvimento local | `pnpm dev` + Expo Go | QR code/Metro | Local apenas |
| Beta staging iOS | `eas build --profile preview --platform ios` | `.ipa` ad hoc pela página interna do EAS; somente aparelhos registrados | Configurado |
| Beta staging Android | `eas build --profile preview --platform android` | APK pela página interna do EAS | Configurado |
| TestFlight | — | Requer perfil iOS com `distribution: "store"` | Não configurado |
| Stores públicas | `production` | Não faz parte deste procedimento | Exige decisão e revisão próprias |

O perfil `preview` usa `distribution: "internal"`, Android APK e
`EXPO_PUBLIC_API_URL=https://escalas-staging.onrender.com`. No iOS ele é uma
distribuição ad hoc: o UDID do aparelho precisa estar no provisioning profile.
Ele **não** é elegível a TestFlight, Transporter nem `eas submit`.

`preview` e `production` compartilham hoje a mesma identidade nativa
(`com.comunicamais.escalas` e scheme `escalas`). Portanto, não se deve tentar
instalar variantes lado a lado nem trocar identificador/scheme para simular um
ambiente. Uma alteração de identidade exige migração e decisão aprovadas.

## Pré-condições para uma build beta controlada

1. `main` está estável, com os checks obrigatórios verdes, e há autorização
   explícita para a build.
2. A conta EAS tem acesso ao projeto já vinculado. Não rodar `eas init`: o
   `projectId` canônico já está em `app.config.ts`.
3. Para iOS, Apple Developer ativo, dispositivo físico com UDID registrado e
   credenciais/provisioning válidos para distribuição interna.
4. Para Android, dispositivo físico apto a instalar APK interno.
5. Para testar push, APNs e FCM V1 precisam estar válidos fora do repositório;
   o teste usa uma conta de staging e não inclui dado clínico em mensagens.
6. A operação confirmou quota/concurrency do plano EAS. Cada build `preview`
   consome uma versão nativa remota porque `autoIncrement` está ativo.

## Procedimento de staging

Executar em worktree limpo, na revisão que foi aprovada:

```bash
pnpm install --frozen-lockfile
pnpm -s typecheck
pnpm lint
pnpm dlx eas-cli@latest whoami
```

### iOS ad hoc

```bash
pnpm dlx eas-cli@latest build --profile preview --platform ios
```

Registrar no relatório o SHA, perfil, URL de staging, ID/link do artefato e o
aparelho registrado usado no teste. Instalar pela página de distribuição
interna do EAS no aparelho que já consta no provisioning profile. Não subir o
`.ipa` para Transporter, App Store Connect ou TestFlight.

### Android APK

```bash
pnpm dlx eas-cli@latest build --profile preview --platform android
```

Registrar os mesmos dados. Instalar o APK pelo link do EAS somente no aparelho
de teste autorizado; a permissão Android para instalar apps dessa origem pode
ser necessária.

## Smoke obrigatório no aparelho físico

Após instalar, registrar resultado para a mesma conta de staging:

1. login, encerramento e retomada do app;
2. troca de instituição e retorno, sem filtros ou dados residuais;
3. abas Trocas, Vagas e Pendências, incluindo carregamento, erro e retry;
4. uma notificação de vaga autorizada, seu deep link e a atualização das
   queries;
5. push em foreground/background e recebimento; e
6. badge de conta conforme o contrato integrado, sem expor instituição,
   mensagem, ID ou dado clínico no artefato de evidência.

Uma falha bloqueia distribuição mais ampla e abre uma correção pequena e
revisável; não é resolvida com novo build improvisado.

## Atualizações posteriores

O projeto não possui configuração canônica de EAS Update (`updates`/
`runtimeVersion`) em `app.config.ts`. Portanto, não usar `eas update --branch
preview` como atalho. Para qualquer alteração a ser testada no binário,
repetir uma build `preview` controlada após os gates.

## TestFlight e publicação futura

TestFlight requer um perfil separado com `distribution: "store"`, credenciais
e fluxo de submissão aprovados. Não deduzir esse perfil a partir de
`production`, nem usar o `ascAppId` já presente em `eas.json` como autorização
para submit. Esse é um trabalho novo, com decisão explícita sobre ambiente,
identidade, público e publicação.

## Identidade nativa

O identificador canônico atual é `com.comunicamais.escalas` para iOS e Android.
Ele não é provisório. Alterá-lo criaria outro aplicativo e exigiria
reinstalação/migração; qualquer mudança precisa de plano aprovado antes de
editar `app.config.ts` ou registros de loja.

## Troubleshooting seguro

- **iOS não instala:** conferir se o UDID está registrado e se o provisioning
  profile foi regenerado para ele; não trocar bundle ID.
- **Push não chega:** registrar plataforma, estado foreground/background e
  timestamp; conferir permissões do aparelho, APNs/FCM e token de staging sem
  compartilhar tokens em tickets ou chat.
- **Artefato aponta para ambiente errado:** parar e conferir o perfil e a URL
  resolvida antes de instalar. Nunca substituir variáveis de produção para
  "testar rapidamente".
