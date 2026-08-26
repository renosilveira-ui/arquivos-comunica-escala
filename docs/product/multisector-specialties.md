# Escalas multissetoriais e especialidades médicas

## Contrato funcional

O sistema trata três eixos diferentes:

1. **Qualificação** — especialidade CFM ou perfil operacional.
2. **Escala** — instituição + hospital + setor + política de admissão.
3. **Modalidade** — plantão ou sobreaviso.

O nome digitado não concede autoridade. Especialidades usam o código estável
do catálogo CFM 2.380/2024. `CLINICA_MEDICA` é clínico geral. O único
generalista aceito no Hospital São Carlos é `RESIDENTE_ANESTESIOLOGIA`.
`MEDICO_GENERALISTA` permanece no catálogo para outros clientes; não entra
nas escalas do piloto.

## Direcionamento do usuário

O acesso a uma escala **não** passa por autorização manual de cada médico.
O modelo é o de convite de workspace (Slack / WhatsApp Business):

1. O coordenador **abre a escala** pedida (setor + política de admissão).
2. Cadastra o **gestor daquela escala** uma vez (Admin / papel + escopo).
3. O gestor gera um **convite** (código `XXXX-XXXX`, 14 dias, até 40 usos).
4. O médico se cadastra e cola o convite — ou, já logado, cola em
   `Entrar em outra escala`.
5. O servidor libera só aquele setor, depois de revalidar a especialidade.

Um médico que planta no TRR e na Emergência recebe **dois convites**, em
momentos diferentes. Cada resgate soma uma escala. A Agenda:

- **Zero** escalas → informa que falta convite.
- **Uma** escala → seleção automática.
- **Várias** → seletor `Todos os meus setores` + cada escala. A última
  escolha válida é lembrada por usuário + instituição.

Visão simultânea das duas escalas fica para depois. O urgente é entrar na
escala certa.

O convite aponta para instituição + hospital + setor — não para uma
especialidade. Quem não é aceito na política do setor é recusado
(fail-closed). Sem convite, a API de cadastro ainda cria conta PENDING
(legado). O administrador continua podendo cadastrar o gestor à mão.

Exemplo no mesmo hospital:

- São Carlos — Sala de Recuperação — Anestesiologia
- São Carlos — Traumatologia — Ortopedia e traumatologia
- São Carlos — Emergência (todas as especialidades CFM)

Um anestesista com convite da Sala de Recuperação e outro da Emergência
vê duas escalas. Um ortopedista só com convite de Traumatologia abre
direto nela.

## São Carlos — configuração inicial

| Setor | Quem pode atuar |
|---|---|
| Sala de Recuperação | Clínica médica, residente em anestesiologia, Medicina de emergência, Anestesiologia, Medicina intensiva |
| TRR | A mesma lista da Sala de Recuperação |
| Emergência | Todas as especialidades CFM |
| UTI | Qualquer especialidade CFM; generalista e residente ficam de fora |
| Traumatologia | Ortopedia e traumatologia |

O script não inventa horários. Um template hospitalar ou setorial ativo deve
existir antes do piloto.

Ordem operacional:

1. Fazer backup e interromper writers durante a DDL manual.
2. Aplicar
   `drizzle/migrations/manual/2026-08-25-schedule-contexts-medical-specialties.sql`.
3. Aplicar
   `drizzle/migrations/manual/2026-08-26-schedule-invites.sql`.
4. Rodar o provisionamento em dry-run.
5. Aplicar com `HSC_PROVISION_CONFIRM=SAO_CARLOS_MULTISETOR` e `--apply`.
6. No Admin, cadastrar o **gestor** na Sala de Recuperação (e Traumatologia,
   se for o grupo de ortopedia). Não cadastrar médico por médico.
7. O gestor gera o convite em Perfil → Convites da escala e envia aos
   testadores.
8. Confirmar template de horário aplicável.
9. Rodar `pnpm provision:sao-carlos -- --check-ready`.
10. Rodar `pnpm check:schedule-readiness` e exigir contadores em zero.
11. Publicar o backend e só então gerar o binário móvel.

Nenhum script escreve por padrão. O importador CSV antigo permanece bloqueado
nesta versão.

## Limite deliberado da primeira build

O cadastro rápido usa uma qualificação principal por profissional. Múltiplas
especialidades da mesma pessoa exigirão `professional_qualifications` depois.

Publicação e bloqueio mensal ainda são hospital + mês.
