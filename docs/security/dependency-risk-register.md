# Registro de risco de dependências

Este documento descreve as exceções temporárias aceitas pelos gates
**pnpm security:lockfile** (OSV, gate síncrono de PR) e
**pnpm security:audit** (npm audit, main/schedule). A fonte executável e
canônica é
[security/dependency-exceptions.json](../../security/dependency-exceptions.json).

O gate de PR consulta a OSV sobre o lockfile inteiro e falha de forma segura quando:

- surge um advisory moderado, alto ou crítico não aprovado;
- a versão, severidade ou pacote diverge do registro;
- o patch ou o teste de regressão desaparece;
- o hash SHA-256 do patch ou do teste muda;
- o teste não está no runner puro ou sua execução compensatória falha;
- o prazo de revisão vence;
- uma exceção fica obsoleta e não é removida;
- a consulta ao registro não pode ser validada.

## Exceções vigentes

| Dependência                | Advisory            | Alcance no Escala                                                                                                                                                                                          | Controle compensatório                                                                   | Revisar até |
| -------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------- |
| image-size 1.2.1           | GHSA-5p2g-fcmc-qvqq | Parser transitivo do Metro, usado no empacotamento. Não há upload pelo usuário; um ativo malicioso versionado ou introduzido por dependência ainda poderia alcançar o parser no CI, Render ou Metro local. | Patch fail-closed no parser compartilhado de caixas e regressão isolada para JXL/HEIF.   | 01/12/2026  |
| image-size 1.2.1           | GHSA-w3rx-r6r6-pgpr | Parser transitivo do Metro, usado no empacotamento. Não há upload pelo usuário; um ICNS malicioso versionado ou disfarçado com extensão aceita ainda alcançaria essa fronteira.                            | Rejeição de entradas ICNS sem progresso e regressão em subprocesso.                      | 01/12/2026  |
| decode-uri-component 0.2.2 | GHSA-vcc3-ghjq-m6fr | Dependência transitiva de query-string. A entrada atual do Expo Router usa URLSearchParams; a cadeia vulnerável permanece como superfície latente do React Navigation.                                     | Backport CommonJS da correção oficial e regressão de compatibilidade/DoS em subprocesso. | 01/12/2026  |

Os dois advisories de image-size não possuem versão corrigida publicada. O
commit upstream conhecido para JXL/HEIF ainda não foi lançado e não corrige
ICNS. O patch local cobre a versão resolvida pelo Metro até existir uma versão
publicada e compatível. Para decode-uri-component, o upgrade isolado para a
versão corrigida quebraria o contrato CommonJS da cadeia atual; por isso a
correção oficial foi retroportada.

Os alerts podem continuar visíveis no Dependabot, pois o scanner enxerga a
versão publicada, não o conteúdo do patch local. Isso não autoriza ocultar ou
encerrar o alerta sem apontar este registro, o patch, os testes e a revisão
vigente.

## Dependências removidas do risco

- @expo/ngrok 4.1.3 → uuid foi fixada em 11.1.1.
- xcode 3.0.1 → uuid foi fixada em 11.1.1.
- @expo/ngrok 4.1.3 → yaml foi fixada em 1.10.3.

Os overrides são específicos por pacote-pai para não rebaixar a linha yaml 2.x
usada por outras ferramentas. Não há exceção para uuid ou yaml: se qualquer
advisory moderado ou superior reaparecer, o CI bloqueia.

## Renovação ou remoção

Uma exceção só pode ser renovada após repetir:

1. instalação com lockfile congelado;
2. os testes de regressão indicados no registro;
3. **pnpm security:lockfile** e, no main/schedule, **pnpm security:audit**;
4. lint, typecheck, testes e builds locais;
5. revisão da versão corrigida upstream e da cadeia Expo/Metro.

Se a dependência corrigida for compatível, a ação preferida é remover o patch e
a exceção. Alterar apenas a data de revisão não constitui reavaliação.
