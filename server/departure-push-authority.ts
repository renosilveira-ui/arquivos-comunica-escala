import { and, eq } from "drizzle-orm";

import {
  departurePlans,
  professionals,
  shiftAssignmentsV2,
  shiftInstances,
} from "../drizzle/schema";
import type { getDb } from "./db";
import { PersistedPushAuthorityBindingError } from "./push-authority-rejection";

/**
 * Autoridade do aviso de deslocamento.
 *
 * ## Por que ele precisava de uma
 *
 * O envio ao Expo só leva o texto real quando o chamador prova, no instante
 * da submissão e sob lock, que aquele aparelho pertence a quem a notificação
 * nomeia. Sem essa prova, sai a apresentação neutra ("Há uma atualização
 * disponível"), por privacidade de tela bloqueada.
 *
 * O aviso de deslocamento era enfileirado SEM autoridade nenhuma. Resultado:
 * caía sempre no texto neutro. O médico recebia "Há uma atualização
 * disponível. Abra o aplicativo para consultar." uma hora antes do plantão,
 * e o "saia até 12:52" — a única razão de o aviso existir — ficava no banco.
 * Relatado pelo PO em 12/09/2026.
 *
 * ## O que é revalidado no envio
 *
 * Nada vem do produtor. O plano, a alocação e a topologia são relidos do
 * banco: o plano tem de ser daquela pessoa, naquele plantão, por aquela
 * alocação; a alocação tem de continuar ativa e ocupada; e o hospital e o
 * setor do plantão têm de ser os mesmos da autoridade persistida. Uma troca
 * de plantão entre o cálculo e o envio derruba o aviso em vez de contar a
 * agenda de alguém para outra pessoa.
 */

export const DEPARTURE_ALERT_PAYLOAD_TYPE = "departure_alert";

export type DeparturePushAuthority = {
  kind: "DEPARTURE_ALERT";
  planId: number;
  expectedUserId: number;
  professionalId: number;
  assignmentId: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  shiftInstanceId: number;
};

/** O que a apresentação precisa saber, lido do plano sob lock. */
export type CanonicalDeparturePlan = Readonly<{
  departAt: Date;
  estimatedDurationSeconds: number | null;
}>;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AuthorityDb = Pick<Db, "select">;

function invalid(message: string): never {
  throw new PersistedPushAuthorityBindingError(message);
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function parseDeparturePushAuthority(
  value: Readonly<Record<string, unknown>>,
): DeparturePushAuthority | null {
  if (
    value.kind !== "DEPARTURE_ALERT" ||
    !positiveId(value.planId) ||
    !positiveId(value.expectedUserId) ||
    !positiveId(value.professionalId) ||
    !positiveId(value.assignmentId) ||
    !positiveId(value.institutionId) ||
    !positiveId(value.hospitalId) ||
    !positiveId(value.sectorId) ||
    !positiveId(value.shiftInstanceId)
  ) {
    return null;
  }
  return value as DeparturePushAuthority;
}

export function departureAuthorityMatchesPayload(
  authority: DeparturePushAuthority,
  payloadData: Readonly<Record<string, unknown>>,
): boolean {
  return (
    payloadData.type === DEPARTURE_ALERT_PAYLOAD_TYPE &&
    payloadData.shiftInstanceId === authority.shiftInstanceId
  );
}

export function isDeparturePushPayload(
  payloadData: Readonly<Record<string, unknown>>,
): boolean {
  return payloadData.type === DEPARTURE_ALERT_PAYLOAD_TYPE;
}

/**
 * Reconstrói a autoridade do destinatário no envio, sem confiar no produtor,
 * e devolve o que a apresentação precisa.
 *
 * Dois desfechos, e a diferença entre eles importa para o médico:
 *
 * - LANÇA quando não dá para provar que o plantão ainda é desta pessoa. Aí o
 *   aviso não sai, e é isso mesmo: mandar alguém sair de casa para um plantão
 *   que trocou de mãos é pior do que o silêncio.
 * - Devolve `null` quando a pessoa está provada mas o CONTEXTO não dá para
 *   montar (topologia mudou, rota não calculou). O aviso sai com o texto
 *   neutro, como saía antes de existir autoridade aqui. Falha de dado não
 *   pode virar silêncio: quem tem plantão precisa ser avisado de alguma
 *   forma.
 */
export async function requireAuthorizedDepartureRecipient(
  db: AuthorityDb,
  authority: DeparturePushAuthority,
  lockForShare = false,
): Promise<CanonicalDeparturePlan | null> {
  const planQuery = db
    .select({
      planUserId: departurePlans.userId,
      planStatus: departurePlans.status,
      departAt: departurePlans.departAt,
      estimatedDurationSeconds: departurePlans.estimatedDurationSeconds,
      assignmentActive: shiftAssignmentsV2.isActive,
      assignmentStatus: shiftAssignmentsV2.status,
      assignmentProfessionalId: shiftAssignmentsV2.professionalId,
      professionalUserId: professionals.userId,
      shiftHospitalId: shiftInstances.hospitalId,
      shiftSectorId: shiftInstances.sectorId,
    })
    .from(departurePlans)
    .innerJoin(
      shiftAssignmentsV2,
      and(
        eq(shiftAssignmentsV2.id, departurePlans.assignmentId),
        eq(shiftAssignmentsV2.institutionId, departurePlans.institutionId),
        eq(shiftAssignmentsV2.shiftInstanceId, departurePlans.shiftInstanceId),
      ),
    )
    .innerJoin(
      professionals,
      eq(professionals.id, shiftAssignmentsV2.professionalId),
    )
    .innerJoin(
      shiftInstances,
      and(
        eq(shiftInstances.id, departurePlans.shiftInstanceId),
        eq(shiftInstances.institutionId, departurePlans.institutionId),
      ),
    )
    .where(
      and(
        eq(departurePlans.id, authority.planId),
        eq(departurePlans.userId, authority.expectedUserId),
        eq(departurePlans.institutionId, authority.institutionId),
        eq(departurePlans.shiftInstanceId, authority.shiftInstanceId),
        eq(departurePlans.assignmentId, authority.assignmentId),
      ),
    )
    .limit(1);

  const rows = lockForShare ? await planQuery.for("share") : await planQuery;
  const plan = rows[0];
  if (!plan) invalid("Plano de deslocamento ausente ou fora da topologia persistida");

  // A pessoa do plano e a da alocação têm de ser a mesma, e a da autoridade.
  if (
    plan.professionalUserId !== authority.expectedUserId ||
    plan.planUserId !== authority.expectedUserId ||
    plan.assignmentProfessionalId !== authority.professionalId
  ) {
    invalid("Destinatário do aviso não é mais o profissional do plantão");
  }

  // Topologia: hospital e setor do plantão precisam bater com os persistidos.
  // A identidade já foi provada acima, então isto não é perda de titularidade
  // — é um gestor tendo corrigido o setor. O texto contextual não vale mais,
  // o aviso vale.
  if (
    plan.shiftHospitalId !== authority.hospitalId ||
    plan.shiftSectorId !== authority.sectorId
  ) {
    return null;
  }

  // Trocou de mãos entre o cálculo e o envio: não avisa ninguém.
  if (plan.assignmentActive !== true || plan.assignmentStatus !== "OCUPADO") {
    invalid("Alocação não está mais ativa para o aviso de deslocamento");
  }

  // Sem hora de saída não há o que dizer sobre trajeto — a chamada de rota
  // falhou no recálculo e o plano seguiu para o disparo assim. O plantão
  // continua sendo desta pessoa, então o aviso sai neutro.
  if (!plan.departAt) return null;

  const departAt = new Date(plan.departAt);
  if (!Number.isFinite(departAt.getTime())) return null;

  return {
    departAt,
    estimatedDurationSeconds:
      typeof plan.estimatedDurationSeconds === "number"
        ? plan.estimatedDurationSeconds
        : null,
  };
}
