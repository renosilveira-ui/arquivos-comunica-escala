export const EXPECTED_USER_ID_HEADER = "x-client-expected-user-id";

export type ExpectedUserConstraintErrorCode =
  "MALFORMED_EXPECTED_USER_ID" | "EXPECTED_USER_MISMATCH";

/**
 * A client that sends an expected identity narrows the credential it is
 * willing to use. Absence preserves legacy compatibility; a present header
 * must be one canonical positive safe integer and match the authenticated
 * credential exactly.
 */
export class ExpectedUserConstraintError extends Error {
  constructor(
    readonly code: ExpectedUserConstraintErrorCode,
    readonly status: 400 | 409,
  ) {
    super(
      code === "MALFORMED_EXPECTED_USER_ID"
        ? `${EXPECTED_USER_ID_HEADER} inválido`
        : "A identidade autenticada não corresponde ao usuário esperado",
    );
    this.name = "ExpectedUserConstraintError";
  }
}

export function assertExpectedUserConstraint(
  rawHeader: unknown,
  authenticatedUserId: number,
): void {
  if (rawHeader === undefined) return;

  if (typeof rawHeader !== "string" || !/^[1-9][0-9]*$/.test(rawHeader)) {
    throw new ExpectedUserConstraintError("MALFORMED_EXPECTED_USER_ID", 400);
  }

  const expectedUserId = Number(rawHeader);
  if (
    !Number.isSafeInteger(expectedUserId) ||
    expectedUserId <= 0 ||
    String(expectedUserId) !== rawHeader
  ) {
    throw new ExpectedUserConstraintError("MALFORMED_EXPECTED_USER_ID", 400);
  }

  if (
    !Number.isSafeInteger(authenticatedUserId) ||
    authenticatedUserId <= 0 ||
    expectedUserId !== authenticatedUserId
  ) {
    throw new ExpectedUserConstraintError("EXPECTED_USER_MISMATCH", 409);
  }
}
