# Dados do ator na auditoria de movimentações

`audit.listShiftMovements` identifica o ator por `userId`, `role` e `name`.
O nome preservado no evento (`audit_trail.actor_name`) tem precedência sobre
o nome atual do usuário. Sem ambos, a API retorna `name: null` e a interface
apresenta “Usuário desconhecido”; nome vazio também usa essa apresentação neutra.

E-mail não integra esse contrato, seja o leitor USER, GESTOR_MEDICO,
GESTOR_PLUS ou administrador. A consulta não seleciona `users.email` e o JSON
não contém `actor.email`. A tela consome o retorno tRPC tipado e ignora esse
campo mesmo em um payload legado. Não há necessidade operacional de endereço
de contato para identificar quem fez uma movimentação de plantão.

Permissões permanecem inalteradas: USER vê eventos em que é ator, origem ou
destino; GESTOR_MEDICO fica restrito ao `manager_scope`; Gestor+ e administrador
leem a instituição selecionada. Filtros, nomes dos profissionais, localização,
ações, metadados, ordenação e paginação não foram alterados.

## Validação e limites

No código anterior, seis casos de privacidade falharam porque a resposta
incluía a chave `email`, enquanto quatro controles funcionais passaram.
Com a correção, dez testes do endpoint e seis regressões de tenant/jurisdição
passaram em MySQL 8.0.45 local descartável. Nove testes puros cobrem apresentação
neutra, nomes, payload legado e vínculo entre consulta, contrato e interface.
Typechecks app/server, lint e diff-check passaram. Não houve build.

Esta frente minimiza o campo de contato selecionado pelo endpoint. Não altera
o histórico persistido, não sanitiza nomes/descrições/metadados arbitrários nem
afirma remover dados já recebidos por versões antigas do aplicativo.
Sem migration, mudança cadastral, publicação ou operação em banco externo.
