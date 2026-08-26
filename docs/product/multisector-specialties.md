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

- O administrador escolhe as escalas autorizadas ao criar, aprovar ou editar
  o profissional.
- O servidor revalida a qualificação do médico contra a política do setor.
- **Zero** escalas → a Agenda informa que falta configuração.
- **Uma** escala → seleção automática (caso típico do piloto da Sala de
  Recuperação).
- **Várias** → seletor `Todos os meus setores` + cada escala. A última
  escolha válida é lembrada por usuário + instituição.
- `Minha` agrega os plantões próprios entre setores; `Geral` respeita o
  filtro.
- Um push que identifica um turno abre os detalhes daquele turno, depois de
  revalidar tenant e acesso.

Exemplo no mesmo hospital:

- São Carlos — Sala de Recuperação — Anestesiologia
- São Carlos — Traumatologia — Ortopedia e traumatologia
- São Carlos — Emergência (todas as especialidades CFM)

Um anestesista autorizado na Sala de Recuperação e na Emergência vê duas
escalas. Um ortopedista autorizado só em Traumatologia abre direto nela.

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
3. Rodar o provisionamento em dry-run.
4. Aplicar com `HSC_PROVISION_CONFIRM=SAO_CARLOS_MULTISETOR` e `--apply`.
5. No Admin, atribuir **somente** Sala de Recuperação (e Traumatologia, se
   for o grupo de ortopedia) aos médicos testadores.
6. Confirmar template de horário aplicável.
7. Rodar `pnpm provision:sao-carlos -- --check-ready`.
8. Rodar `pnpm check:schedule-readiness` e exigir contadores em zero.
9. Publicar o backend e só então gerar o binário móvel.

Nenhum script escreve por padrão. O importador CSV antigo permanece bloqueado
nesta versão.

## Limite deliberado da primeira build

O cadastro rápido usa uma qualificação principal por profissional. Múltiplas
especialidades da mesma pessoa exigirão `professional_qualifications` depois.

Publicação e bloqueio mensal ainda são hospital + mês.
