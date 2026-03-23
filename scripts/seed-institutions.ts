/**
 * Script para popular instituições e hospitais padrão
 * Necessário antes de popular setores
 */

import { getDb } from "./db";
import { institutions, hospitals } from "../drizzle/schema";
import { eq } from "drizzle-orm";

async function seed() {
  console.log("🌱 Populando instituições e hospitais...");
  
  const db = await getDb();
  if (!db) {
    console.error("❌ Banco de dados não disponível");
    throw new Error("Database not available");
  }
  
  try {
    const tenants = [
      {
        name: "Hospital das Clínicas",
        cnpj: "11111111000191",
        legalName: "Hospital das Clínicas S.A.",
        tradeName: "HC",
        hospitalName: "Hospital das Clínicas - Unidade Central",
        hospitalAddress: "Av. Dr. Enéas Carvalho de Aguiar, 255 - São Paulo, SP",
      },
      {
        name: "Santa Casa",
        cnpj: "22222222000191",
        legalName: "Santa Casa de Misericórdia S.A.",
        tradeName: "Santa Casa",
        hospitalName: "Santa Casa - Unidade Principal",
        hospitalAddress: "Rua da Glória, 111 - São Paulo, SP",
      },
    ] as const;

    const created: Array<{ institutionId: number; hospitalId: number; institutionName: string }> = [];

    for (const tenant of tenants) {
      await db
        .insert(institutions)
        .values({
          name: tenant.name,
          cnpj: tenant.cnpj,
          legalName: tenant.legalName,
          tradeName: tenant.tradeName,
          isActive: true,
        })
        .onDuplicateKeyUpdate({
          set: {
            name: tenant.name,
            legalName: tenant.legalName,
            tradeName: tenant.tradeName,
            isActive: true,
          },
        });

      const [institution] = await db
        .select()
        .from(institutions)
        .where(eq(institutions.cnpj, tenant.cnpj))
        .limit(1);

      if (!institution) {
        throw new Error(`Falha ao localizar instituição após upsert: ${tenant.name}`);
      }

      await db
        .insert(hospitals)
        .values({
          institutionId: institution.id,
          name: tenant.hospitalName,
          address: tenant.hospitalAddress,
        })
        .onDuplicateKeyUpdate({
          set: {
            name: tenant.hospitalName,
            address: tenant.hospitalAddress,
          },
        });

      const [hospital] = await db
        .select()
        .from(hospitals)
        .where(eq(hospitals.institutionId, institution.id))
        .limit(1);

      if (!hospital) {
        throw new Error(`Falha ao localizar hospital da instituição: ${tenant.name}`);
      }

      created.push({
        institutionId: institution.id,
        hospitalId: hospital.id,
        institutionName: tenant.name,
      });
    }

    created.forEach((item) => {
      console.log(
        `✅ Tenant pronto: ${item.institutionName} (institutionId=${item.institutionId}, hospitalId=${item.hospitalId})`,
      );
    });

    return created;
    
  } catch (error) {
    console.error("❌ Erro ao popular instituições:", error);
    throw error;
  }
}

seed()
  .then((result) => {
    console.log("\n✅ Seed de instituições concluído!");
    if (result?.length) {
      result.forEach((item) => {
        console.log(
          `Institution ID: ${item.institutionId} | Hospital ID: ${item.hospitalId} | ${item.institutionName}`,
        );
      });
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Erro no seed:", error);
    process.exit(1);
  });
