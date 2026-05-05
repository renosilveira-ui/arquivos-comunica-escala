# Operations: mobile builds (iOS + Android)

> Status: configurada infraestrutura básica (`app.config.ts`, `eas.json`).
> Builds reais para TestFlight/Play Store ainda exigem ações da operação
> (login no EAS, conta Apple, conta Google). Este doc é o roteiro.

## TL;DR — fluxos disponíveis

| Caso | Comando | Distribuição | Custo |
|------|---------|--------------|-------|
| Dev local no iPhone/Android pessoal | `pnpm start` + Expo Go | QR code, instantâneo | Grátis |
| Tester interno (até 100 iPhones) | `eas build --profile preview --platform ios` + `eas submit` | TestFlight | Apple Developer ($99/ano) |
| Tester interno Android (APK direto) | `eas build --profile preview --platform android` | Link de download | Grátis |
| Publicação App Store / Play Store | `eas build --profile production` + `eas submit` | Stores públicas | Apple ($99/ano) + Google ($25 uma vez) |

## 1. Caminho mais simples — Expo Go (sem build, sem conta paga)

Para o piloto da Unimed (40 anestesistas testando no celular pessoal),
**Expo Go é o caminho mais rápido.** Sem build, sem TestFlight, sem APK.

### Como funciona

1. Cada usuário instala o app **Expo Go** (App Store / Play Store, grátis).
2. Você roda `pnpm dev:metro` localmente OU usa um tunnel público.
3. Compartilha o QR code que aparece no terminal.
4. Usuário aponta a câmera, abre, app carrega.

### Limitações do Expo Go

- Conexão depende do Metro estar rodando (na sua máquina ou em um
  servidor).
- Sem ícone/splash custom.
- Sem deep links próprios.
- Algumas libs nativas avançadas não funcionam (não é nosso caso hoje).

### Para o piloto Unimed

**Suficiente.** Testamos por algumas semanas via Expo Go, validamos UX,
ajustamos. Quando estabilizar, migramos para builds nativos
(TestFlight + Play Store).

## 2. Builds internos via EAS — TestFlight + APK

Quando o app estabilizar e queremos um instalador independente
(continuar funcionando se o Metro local cair), partimos para build
real.

### Pré-requisitos

- Conta Expo (grátis em <https://expo.dev/signup>).
- `eas-cli` instalado: `npm install -g eas-cli`.
- Login: `eas login`.
- Para iOS: Apple Developer Program ($99/ano) já enrolado.
- Para Android: APK pode ser gerado **sem** conta Google Play; só
  precisa de conta Google (grátis) para upload no Play Store interno.

### Primeiro build de preview

```bash
# 1. Linka este repositório a um projeto EAS (uma única vez):
eas init

# 2. Build iOS para TestFlight:
eas build --profile preview --platform ios

# 3. Build Android APK:
eas build --profile preview --platform android
```

EAS gera um link de download em ~10-20 min. APK Android: instalar direto
no aparelho. iOS: subir para TestFlight via `eas submit -p ios --latest`
ou pelo App Store Connect web.

### Distribuição para os 40 testers

- **iOS (TestFlight):** convidar cada email no App Store Connect →
  TestFlight → Internal Testing. Eles instalam o **TestFlight** app
  e veem o Escalas listado.
- **Android (APK):** subir o APK em Drive/S3, mandar link. Tester
  instala (Android pede confirmação de "fonte desconhecida").

### Update sem re-build (OTA)

Após o primeiro build, atualizações de JS/CSS podem ser feitas sem
rebuild via `eas update`:

```bash
eas update --branch preview --message "Fix do form de criar escala"
```

Apps já instalados pegam a atualização na próxima abertura.

## 3. Publicação em stores (futuro)

### iOS — App Store

1. **Bundle ID definitivo** já decidido (não pode mais ser mudado depois).
2. **App Store Connect** → criar app com esse bundle ID.
3. **Asset bundle:** ícone 1024×1024, screenshots de 4 tamanhos
   (iPhone normal, iPhone Pro Max, iPad), descrição, política de
   privacidade.
4. **Build:** `eas build --profile production --platform ios`.
5. **Submit:** `eas submit -p ios --latest` (preenche `ascAppId` em
   `eas.json` antes).
6. Apple revisa em ~1-3 dias. Pode rejeitar pedindo ajustes.

### Android — Play Store

1. **Google Play Console** ($25 uma vez, conta nova).
2. **Bundle ID definitivo.**
3. **Asset bundle:** ícone 512×512, screenshots, descrições,
   política de privacidade.
4. **Build:** `eas build --profile production --platform android`.
5. **Submit:** `eas submit -p android --latest` (configurar Service
   Account JSON antes).
6. Google revisa em ~1-3 dias.

## Bundle ID — decisão em aberto

O valor atual em `app.config.ts` (`app.escalas.staging`) é
**provisório**. **Antes da primeira publicação em store**:

1. Decidir qual entidade é "dona" do app:
   - Cooperativa (Coopanest) → algo tipo `br.com.coopanest.escalas`.
   - Hospital (Unimed Fortaleza) → `br.com.unimedfortaleza.escalas`.
   - Empresa nova/produto SaaS → `app.escalas` ou similar.

2. Trocar em `app.config.ts`:
   - `iosBundleId`
   - `androidPackage`
   - `scheme` (deep link prefix — opcional manter `escalas`)

3. Trocar em `eas.json`:
   - `submit.production.ios.ascAppId` quando o app estiver criado no
     App Store Connect.

4. **Rebuild** (`eas build --profile production`).

**Atenção:** uma vez publicado em store com bundle ID X, mudar para Y
significa **abandonar o app antigo e publicar um novo**. Usuários teriam
que reinstalar. Por isso, decidir antes de publicar.

## Troubleshooting

### "Bundle ID já está em uso por outro projeto Apple"

Outro app Apple no mundo tem esse bundle ID. Trocar para algo único.

### "Submit failed: Invalid binary"

Geralmente falta de ícone/screenshot/info no App Store Connect. Conferir
todos os assets e metadados antes do submit.

### Expo Go: app trava na splash

Verificar se `pnpm dev:metro` está rodando E se o celular está na mesma
rede Wi-Fi do laptop. Para usar fora da mesma rede, usar tunnel:

```bash
npx expo start --tunnel
```
