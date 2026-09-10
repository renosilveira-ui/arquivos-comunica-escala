export type InviteProfessionalIdentityRow = {
  id: number;
  userId: number;
};

export class InviteProfessionalIdentityError extends Error {
  constructor(readonly reason: "MISSING" | "AMBIGUOUS" | "MALFORMED") {
    super("INVITE_PROFESSIONAL_IDENTITY_NOT_UNIQUE");
  }
}

/**
 * Convite concede vínculo/ACL ao profissional canônico da conta. Sem uma
 * constraint 1:1 no schema, somente cardinalidade exatamente um é autoridade;
 * LIMIT 1 ou desempate por id esconderia corrupção de topologia.
 */
export function requireSingleInviteProfessionalId(
  rows: readonly InviteProfessionalIdentityRow[],
  expectedUserId: number,
): number {
  if (rows.length === 0) {
    throw new InviteProfessionalIdentityError("MISSING");
  }
  if (rows.length !== 1) {
    throw new InviteProfessionalIdentityError("AMBIGUOUS");
  }
  const row = rows[0]!;
  if (
    !Number.isSafeInteger(row.id) ||
    row.id <= 0 ||
    row.userId !== expectedUserId
  ) {
    throw new InviteProfessionalIdentityError("MALFORMED");
  }
  return row.id;
}
