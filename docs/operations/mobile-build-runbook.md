# Runbook — Build mobile + TestFlight para o piloto

> **Quem deve ler:** o operador (médico responsável pelo projeto) que vai
> tocar o lançamento do piloto na Unimed Fortaleza (39 anestesistas).
> **Pré-condição técnica:** este repositório já tem `app.config.ts` e
> `eas.json` configurados (PR #52). Este documento é o passo a passo
> "do zero" para gerar o primeiro build, subir para o **TestFlight**
> (iOS) e para o **Internal Testing** (Android), e convidar os testers.
>
> Este runbook **não substitui** o [`mobile-deploy.md`](./mobile-deploy.md);
> aquele explica os fluxos disponíveis (Expo Go, preview, produção).
> Este aqui é a versão "operação" — comando a comando — para chegar no
> primeiro build instalado em 39 iPhones.

---

## Glossário rápido

Termos que aparecem várias vezes neste documento:

- **EAS (Expo Application Services):** plataforma da Expo que compila o
  app na nuvem deles, sem precisar de Mac com Xcode local.
- **EAS CLI:** programa de linha de comando que dispara os builds.
  Usaremos via `pnpm dlx eas-cli@latest <comando>` — `pnpm dlx` baixa
  o programa só na hora de rodar, então não precisamos instalar nada
  globalmente.
- **TestFlight:** app oficial da Apple para distribuir betas de iOS.
  Funciona com até 100 testadores internos sem revisão da Apple.
- **Internal Testing (Play Store):** equivalente da Google. Permite
  até 100 testadores via link.
- **Bundle Identifier / Package:** identificador único do app no mundo
  Apple/Android. Hoje vale `app.escalas.staging` (provisório).
- **Apple ID:** a conta Apple de cada anestesista. Cada tester precisa
  ter uma — sem isso, não consegue receber convite TestFlight.

---

## Pré-requisitos (contas a abrir antes de começar)

### 1. Apple Developer Program — US$ 99/ano (obrigatório)

O que é: assinatura paga da Apple que permite **publicar apps** (na
loja ou em TestFlight). Sem isso, você consegue rodar o app no seu
próprio iPhone via cabo, mas **não consegue distribuir** para outros.

Onde: <https://developer.apple.com/programs/enroll/>.

Tempo: enrollment leva de algumas horas até 48h (Apple confirma a
identidade). Faça **antes** de qualquer outra coisa.

> Você já tem essa conta. Confirme que está ativa entrando em
> <https://appstoreconnect.apple.com> com seu Apple ID.

### 2. App Store Connect (já incluso na assinatura Apple)

Onde criamos o "registro" do app no ecossistema Apple. É lá que
configuramos o TestFlight, convidamos testers, e — no futuro —
submetemos para a App Store pública. Acesso: mesmo Apple ID da conta
Developer, em <https://appstoreconnect.apple.com>.

### 3. Google Play Console — US$ 25 (uma vez, vitalício) — opcional para o piloto

Apenas necessário se quiser distribuir Android **via Play Store**
(Internal Testing oficial). Para o piloto, há uma alternativa: gerar
**APK** e mandar o link diretamente — sem precisar de conta Google
Play. Os anestesistas instalam o APK manualmente (Android pede uma
confirmação de "fonte desconhecida").

Onde: <https://play.google.com/console/signup>.

> **Recomendação para o piloto:** começar **só com iOS** (TestFlight) e
> Android via APK direto. Adia US$ 25 e a burocracia da Google até
> termos validação.

### 4. Conta Expo — gratuita

Expo é a empresa por trás do EAS. Conta grátis em
<https://expo.dev/signup>.

---

## Fase 0 — Verificação inicial (5 minutos)

Rodar **na pasta do projeto** (onde está este README), em um terminal:

```bash
# 1. Verifica se o pnpm está OK e qual versão.
pnpm --version
# Esperado: 9.x ou superior.

# 2. Garante que as dependências estão instaladas.
pnpm install --prefer-offline --frozen-lockfile

# 3. Verifica que o EAS CLI funciona (baixa pelo dlx, não instala global).
pnpm dlx eas-cli@latest --version
# Esperado: 14.x ou superior. Pode pedir confirmação para baixar — aceitar.
```

Se algum desses falhar, **parar e pedir ajuda técnica** antes de
continuar.

---

## Fase 1 — Setup inicial (uma vez só, ~30-45 minutos)

### Passo 1.1 — Login no Expo

```bash
pnpm dlx eas-cli@latest login
```

O que faz: abre prompt pedindo email e senha do Expo.
Input esperado: email/senha da sua conta Expo (criada em
<https://expo.dev/signup>).

### Passo 1.2 — Inicializar o projeto EAS (se ainda não foi feito)

Verificar se já existe um `extra.eas.projectId` no `app.config.ts`.
Hoje **não existe** — então rodar:

```bash
pnpm dlx eas-cli@latest init
```

O que faz: cria um projeto na sua conta Expo, gera um `projectId` e
sugere adicionar em `app.config.ts`. Quando ele perguntar:

- "Would you like to automatically create an EAS project…?" → **Y**
- "Would you like to link this app to that project?" → **Y**

Resultado: o EAS CLI escreve um bloco `extra: { eas: { projectId: "…" } }`
no `app.config.ts`. **Comitar essa mudança** depois (pequeno commit
separado) — é o "endereço" do projeto no EAS.

### Passo 1.3 — Configurar credenciais Apple (TestFlight)

```bash
pnpm dlx eas-cli@latest credentials -p ios
```

O que faz: wizard interativo que conecta sua conta Apple Developer ao
EAS para que eles possam assinar (sign) o build em seu nome.

Caminho recomendado dentro do wizard:

1. **"Build credentials"** → escolher.
2. **"Production"** profile (ou **"All credentials"**).
3. EAS pede login Apple. Use o Apple ID + senha + código 2FA do iPhone.
   - Se 2FA entrar em loop, ver Troubleshooting abaixo.
4. EAS cria automaticamente:
   - **App ID** (registro do bundle no Apple Developer Portal)
   - **Distribution Certificate** (certificado para assinar builds)
   - **Provisioning Profile** (perfil que diz "este certificado pode
     assinar este App ID")

Tudo fica salvo na nuvem do EAS. Você não precisa mexer com isso de
novo.

### Passo 1.4 — Configurar credenciais Android (opcional, para APK)

```bash
pnpm dlx eas-cli@latest credentials -p android
```

O que faz: wizard parecido, mas mais simples. Não precisa de conta
Google Play.

Caminho:

1. **"Build credentials"** → **"Set up a new keystore"** (ou aceitar
   gerar um automaticamente).
2. EAS gera e guarda um keystore na nuvem deles. **Importante:** uma
   vez que o app é instalado em um celular Android com keystore X,
   atualizações **precisam** ser assinadas com o mesmo keystore. EAS
   já cuida disso automaticamente — só não troque.

### Passo 1.5 — Criar registro do app no App Store Connect (iOS)

> Esse passo é **na web**, não no terminal.

1. Entrar em <https://appstoreconnect.apple.com>.
2. **My Apps** → botão "+" → **New App**.
3. Preencher:
   - **Platform:** iOS
   - **Name:** "Escalas Hospitalares" (ou "Escalas — Beta", o que
     preferir).
   - **Primary Language:** Portuguese (Brazil).
   - **Bundle ID:** selecionar o que aparece na lista
     (`app.escalas.staging` — criado automaticamente pelo EAS no passo
     1.3).
   - **SKU:** algo único interno, ex.: `escalas-piloto-2026`.
4. Salvar. O app aparece em "My Apps" como um card com status
   "Prepare for Submission".

> **Anotar o "Apple ID" do app** (um número de 10 dígitos exibido no
> topo do card "App Information"). Vamos precisar dele se quisermos
> automatizar o submit (`ascAppId` em `eas.json`). Para o piloto, não
> é obrigatório — podemos subir o `.ipa` manualmente.

---

## Fase 2 — Primeiro build (≈ 30 minutos, a maioria esperando)

### Passo 2.1 — Build iOS (preview, para TestFlight)

```bash
pnpm dlx eas-cli@latest build --platform ios --profile preview
```

O que faz: empacota o app, manda o código para os servidores do EAS,
eles compilam, geram um `.ipa` (formato instalável da Apple) e
disponibilizam um link.

Tempo: **15-25 min** na fila + build.

Output esperado: ao fim, terminal mostra:
```
✔ Build finished
🏗 Build artifact: https://expo.dev/artifacts/eas/<id>.ipa
```

### Passo 2.2 — Subir para o TestFlight

**Opção A — manual (recomendado da primeira vez):**

1. Baixar o `.ipa` do link.
2. Abrir o app **Transporter** no Mac (App Store, gratuito).
3. Arrastar o `.ipa` na janela. Clicar **Deliver**.
4. ~10 min depois, o build aparece no App Store Connect →
   **TestFlight** → **iOS Builds** com status "Processing".
5. ~30 min depois, status muda para "Ready to Submit". Pronto para
   convidar testers (Fase 3).

**Opção B — automático via EAS Submit (depois que o `ascAppId` estiver
no `eas.json`):**

```bash
pnpm dlx eas-cli@latest submit -p ios --latest
```

> **Para o piloto, fique na Opção A.** É mais visual e dá controle.

### Passo 2.3 — Build Android APK (opcional, para distribuir por link)

```bash
pnpm dlx eas-cli@latest build --platform android --profile preview
```

O perfil `preview` em `eas.json` já define `buildType: "apk"` —
gera um arquivo `.apk` que pode ser baixado direto pelo celular.

Quando terminar, **copiar o link** que aparece no terminal e mandar
para os anestesistas Android. Eles abrem o link no celular, baixam,
clicam, Android pede confirmação de "fonte desconhecida", aceitar,
app instala.

---

## Fase 3 — Convidar os 39 anestesistas (TestFlight)

### Passo 3.1 — Coletar Apple IDs

Cada anestesista tester precisa fornecer **o e-mail do Apple ID**
(o e-mail que ele usa para entrar na App Store no iPhone). Não pode
ser um e-mail qualquer — tem que ser exatamente o do Apple ID.

> Sugestão: mandar uma planilha simples para coletar. Colunas: nome,
> Apple ID (e-mail), iPhone modelo (opcional, ajuda em troubleshooting).

### Passo 3.2 — Criar grupo de testers internos

1. App Store Connect → seu app → aba **TestFlight**.
2. Esquerda: **Internal Testing** → "+" para criar grupo.
3. Nome: `Piloto Unimed`.
4. Marcar "Enable automatic distribution" — assim novos builds são
   enviados automaticamente para o grupo.

### Passo 3.3 — Adicionar testers ao grupo

Mesma tela do grupo:

1. Clicar **Testers** → "+".
2. Colar lista de e-mails (um por linha).
3. **Send Invite**.

Cada tester recebe um e-mail da Apple com link "View in TestFlight".

### Passo 3.4 — Instruções para o tester

Mandar este texto (copiar e colar no WhatsApp / e-mail):

> Você foi convidado para testar o app **Escalas Hospitalares**.
>
> 1. Instale o app **TestFlight** da App Store
>    (<https://apps.apple.com/app/testflight/id899247664>).
> 2. Abra o e-mail "You're invited to test Escalas Hospitalares" e
>    toque em **View in TestFlight**.
> 3. Toque **Accept**, depois **Install**.
> 4. O app aparece na tela inicial do iPhone como "Escalas".
> 5. Para reportar bugs: tirar print, balançar o iPhone (TestFlight
>    abre janela "Send Beta Feedback") e descrever.

---

## Fase 4 — Atualizações (depois do primeiro build)

### Caso A — Mudança só de código JS / texto / lógica (sem nova lib nativa)

Não precisa de novo build. Use **OTA (Over-the-Air update)**:

```bash
pnpm dlx eas-cli@latest update --branch preview --message "Fix do form de criar escala"
```

Resultado: na próxima vez que cada tester abrir o app, ele baixa o
patch e atualiza sozinho. **Zero ação dos testers.**

### Caso B — Nova versão real (mudou native code, instalou nova lib nativa, mudou ícone, etc.)

Precisa de novo build:

1. Editar `app.config.ts` → atualizar `version: "1.0.1"` (ou
   `1.1.0` se for mudança maior). **Não precisa** mexer no
   `buildNumber` / `versionCode` — o `eas.json` está com
   `appVersionSource: "remote"`, então o EAS incrementa
   automaticamente.
2. Comitar a mudança de versão.
3. Rodar de novo:
   ```bash
   pnpm dlx eas-cli@latest build --platform ios --profile preview
   ```
4. Subir o novo `.ipa` no TestFlight (Transporter, igual Fase 2.2).
5. Como o grupo está com "automatic distribution", os testers
   recebem notificação do TestFlight quando o build estiver pronto
   e instalam com 1 toque.

---

## Troubleshooting — problemas comuns

### "Bundle identifier already in use" durante `eas credentials -p ios`

Significa que **outro app no mundo Apple** já está usando
`app.escalas.staging`. Soluções:

- Trocar para algo mais único: `br.com.escalas.staging` ou
  `app.escalas.<seu-sobrenome>.staging`.
- Editar `iosBundleId` e `androidPackage` em `app.config.ts`,
  comitar, rodar `eas credentials -p ios` de novo.

> Antes da publicação pública (depois do piloto), trocaremos de
> qualquer jeito para algo definitivo (`br.com.unimedfortaleza.escalas`
> ou similar). Ver `mobile-deploy.md` seção "Bundle ID — decisão em
> aberto".

### Loop infinito de 2FA da Apple no `eas credentials`

A Apple às vezes não aceita o código 2FA via terminal. Solução:
gerar uma **senha específica de app** (app-specific password):

1. <https://appleid.apple.com> → Sign-in & Security → **App-Specific
   Passwords** → "+".
2. Label: `EAS CLI`.
3. Gera uma senha tipo `abcd-efgh-ijkl-mnop`.
4. Usar essa senha em vez da senha normal quando o EAS pedir.

### "Build failed: Invalid icon" ou "Icon must not have alpha channel"

Apple exige que `assets/images/icon.png` seja **1024×1024 PNG sem
canal alpha**. Verificar:

```bash
file assets/images/icon.png
# Esperado: PNG image data, 1024 x 1024, 8-bit/color RGB, non-interlaced
# (RGB, NÃO RGBA — RGBA tem canal alpha e Apple rejeita.)
```

Hoje o repositório está OK (RGB, 1024×1024, sem alpha). Se um designer
trocar o ícone no futuro, conferir antes de buildar.

### TestFlight: "This beta has expired"

Builds TestFlight expiram em **90 dias**. Solução: rodar `eas build`
de novo (Fase 2.1) e re-subir. O grupo de testers continua o mesmo,
não precisa reconvidar ninguém.

### Tester não recebe e-mail de convite

- Conferir o e-mail informado: tem que ser exatamente o Apple ID.
- Pedir para o tester checar spam.
- Em App Store Connect → grupo → tester → **Resend Invite**.

### "Could not find Expo project ID"

Faltou rodar o `eas init` (Fase 1.2). Rodar e comitar a mudança no
`app.config.ts`.

---

## O que NÃO está coberto neste runbook

- **Submissão pública na App Store / Play Store.** O piloto fica em
  TestFlight + APK direto. Submissão pública vem depois da validação,
  e exige assets adicionais (screenshots, descrição, política de
  privacidade). Ver `mobile-deploy.md` seção "3. Publicação em stores".
- **Push notifications.** Hoje o app pede a permissão Android
  (`POST_NOTIFICATIONS`) mas não há backend de push configurado.
  Quando precisarmos, será um PR separado (Firebase / APNs tokens).
- **Code signing avançado** (certificados manuais, perfis de
  enterprise distribution, etc.). EAS faz tudo automático — não
  precisamos mexer nesse nível.
- **Bundle ID definitivo.** Hoje vale `app.escalas.staging`.
  Antes de publicar em loja pública, decidir o nome final
  (cooperativa? hospital? entidade nova?). Ver `mobile-deploy.md`.

---

## Referências internas

- [`docs/operations/mobile-deploy.md`](./mobile-deploy.md) — visão
  geral dos fluxos (Expo Go vs preview vs production) e custos.
- [`eas.json`](../../eas.json) — perfis de build e submit.
- [`app.config.ts`](../../app.config.ts) — identidade do app
  (nome, bundle ID, ícone, splash, deep link scheme).
