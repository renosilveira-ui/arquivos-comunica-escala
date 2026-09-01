import { describe, expect, it } from "vitest";
import {
  READINESS_FENCE_V1_PROOF_DATABASE_PREFIX,
  isReadinessFenceV1ProofDatabaseName,
  safeReadinessFenceV1ProofErrorCode,
  validateReadinessFenceV1ProofEnvironment,
} from "../scripts/prove-readiness-fence-v1-migration";

const validEnvironment = {
  NODE_ENV: "test",
  READINESS_FENCE_V1_PROOF_ALLOW_DESTRUCTIVE: "1",
  READINESS_FENCE_V1_PROOF_SERVER_URL:
    "mysql://runner%40local:p%3Ass@localhost:3306/",
};
const randomId = "12345678-1234-4abc-8def-1234567890ab";

describe("prova MySQL isolada da readiness fence V1", () => {
  it("gera sempre schema efêmero aleatório sob prefixo exclusivo", () => {
    const proof = validateReadinessFenceV1ProofEnvironment(
      validEnvironment,
      randomId,
    );

    expect(proof.databaseName).toBe(
      `${READINESS_FENCE_V1_PROOF_DATABASE_PREFIX}1234567812344abc8def1234567890ab`,
    );
    expect(isReadinessFenceV1ProofDatabaseName(proof.databaseName)).toBe(true);
    expect(proof.databaseUrl).toBe(
      "mysql://runner%40local:p%3Ass@127.0.0.1:3306/escalas_rdf_v1_proof_1234567812344abc8def1234567890ab",
    );
  });

  it("não aceita nome fora do prefixo de prova", () => {
    expect(isReadinessFenceV1ProofDatabaseName("escalas_test")).toBe(false);
    expect(
      isReadinessFenceV1ProofDatabaseName(
        `${READINESS_FENCE_V1_PROOF_DATABASE_PREFIX}not-random`,
      ),
    ).toBe(false);
  });

  it.each([
    [{ ...validEnvironment, NODE_ENV: "development" }],
    [{ ...validEnvironment, READINESS_FENCE_V1_PROOF_ALLOW_DESTRUCTIVE: "0" }],
    [
      {
        ...validEnvironment,
        READINESS_FENCE_V1_PROOF_SERVER_URL:
          "mysql://root:root@db.example.test:3306/",
      },
    ],
    [
      {
        ...validEnvironment,
        READINESS_FENCE_V1_PROOF_SERVER_URL:
          "mysql://root:root@127.0.0.1:3306/escalas_test",
      },
    ],
    [
      {
        ...validEnvironment,
        READINESS_FENCE_V1_PROOF_SERVER_URL:
          "mysql://root:root@127.0.0.1:3306/?ssl-mode=REQUIRED",
      },
    ],
  ])("falha fechada antes de conectar quando o alvo é inseguro", (env) => {
    expect(() =>
      validateReadinessFenceV1ProofEnvironment(env, randomId),
    ).toThrow();
  });

  it("não aceita identificador aleatório não canônico", () => {
    expect(() =>
      validateReadinessFenceV1ProofEnvironment(
        validEnvironment,
        "escalas_test",
      ),
    ).toThrow("READINESS_FENCE_V1_PROOF_RANDOM_ID_INVALID");
  });

  it("não devolve URL, usuário ou credencial de uma falha de prova", () => {
    expect(
      safeReadinessFenceV1ProofErrorCode(
        new Error("connect mysql://installer:secret@db.example.test/escala"),
      ),
    ).toBe("READINESS_FENCE_V1_PROOF_FAILED");
    expect(
      safeReadinessFenceV1ProofErrorCode(
        new Error("READINESS_FENCE_V1_PROOF_RANDOM_ID_INVALID"),
      ),
    ).toBe("READINESS_FENCE_V1_PROOF_RANDOM_ID_INVALID");
  });
});
