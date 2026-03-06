    // Assumir vaga (USER solicita alocação PENDENTE)
    assumeVacancy: protectedProcedure
      .input(z.object({
        shiftInstanceId: z.number(),
        assignmentType: z.enum(["ON_DUTY", "BACKUP", "ON_CALL"]).default("ON_DUTY"),
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        // Buscar profissional do usuário autenticado (ou testUserId)
        const userId = ctx.user?.id;
        if (!userId) {
          throw new Error("Autenticação necessária");
        }

        const [professional] = await db
          .select()
          .from(professionals)
          .where(eq(professionals.userId, userId));

        if (!professional) {
          throw new Error("Profissional não encontrado");
        }

        // Buscar dados do turno
        const [shift] = await db
          .select()
          .from(shiftInstances)
          .where(eq(shiftInstances.id, input.shiftInstanceId));

        if (!shift) {
          throw new Error("Turno não encontrado");
        }

        // Validar que turno está VAGO
        if (shift.status !== "VAGO") {
          throw new Error(`Turno não está disponível (status: ${shift.status})`);
        }

        // Executar validações de conflito
        const validation = await validateAssignment(
          professional.id,
          input.shiftInstanceId,
          shift.hospitalId,
          shift.sectorId
        );

        if (!validation.valid) {
          // Retornar erro com código específico
          throw new Error(validation.error || "Validation failed");
        }

        // Criar alocação PENDENTE
        const [result] = await db.insert(shiftAssignmentsV2).values({
          shiftInstanceId: input.shiftInstanceId,
          institutionId: shift.institutionId,
          hospitalId: shift.hospitalId,
          sectorId: shift.sectorId,
          professionalId: professional.id,
          assignmentType: input.assignmentType,
          isActive: true, // Alocação ativa, mas turno fica PENDENTE
          createdBy: userId,
        });

        // Atualizar status do turno para PENDENTE
        await db
          .update(shiftInstances)
          .set({ status: "PENDENTE" })
          .where(eq(shiftInstances.id, input.shiftInstanceId));

        // Registrar auditoria
        await auditLog({
          event: "VACANCY_REQUESTED",
          shiftInstanceId: input.shiftInstanceId,
          professionalId: professional.id,
          metadata: {
            assignmentType: input.assignmentType,
            userId,
          },
        });

        return {
          ok: true,
          assignmentId: result.insertId,
          status: "PENDENTE",
        };