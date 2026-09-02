import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  institutions,
  notifications,
  professionalInstitutions,
  professionals,
  users,
} from "../drizzle/schema";
import {
  ACCOUNT_WIDE_BADGE_NOTIFICATION_TYPES,
  ACCOUNT_WIDE_BADGE_VERSION,
} from "../lib/account-wide-native-badge";
import { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

type AccountBadgeSubject = Readonly<{
  userId: number;
  sessionVersion: number;
}>;

const accountBadgeVersion = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.accountWideBadgeVersion'))`;
const payloadRecipientUserId = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.payloadData.recipientUserId'))`;
const payloadType = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.payloadData.type'))`;
const accountBadgeVersionType = sql<string>`JSON_TYPE(JSON_EXTRACT(${notifications.providerReceipt}, '$.accountWideBadgeVersion'))`;
const payloadRecipientUserIdType = sql<string>`JSON_TYPE(JSON_EXTRACT(${notifications.providerReceipt}, '$.payloadData.recipientUserId'))`;
const payloadTypeType = sql<string>`JSON_TYPE(JSON_EXTRACT(${notifications.providerReceipt}, '$.payloadData.type'))`;
const trackingPhase = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase'))`;
const trackingPhaseType = sql<string>`JSON_TYPE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase'))`;

/**
 * Uma row de outbox só entra no badge se tiver sido criada pelo writer atual
 * (marker), estiver amarrada ao mesmo destinatário e representar um tipo de
 * push que o aplicativo de fato entende. Isso exclui rows de integração e
 * rows históricas que nunca tiveram semântica de leitura.
 */
function accountBadgeNotificationPredicate() {
  return and(
    sql`${accountBadgeVersionType} = 'INTEGER'`,
    sql`${accountBadgeVersion} = ${String(ACCOUNT_WIDE_BADGE_VERSION)}`,
    sql`${payloadRecipientUserIdType} = 'INTEGER'`,
    sql`${payloadRecipientUserId} = CAST(${notifications.userId} AS CHAR)`,
    sql`${payloadTypeType} = 'STRING'`,
    inArray(payloadType, ACCOUNT_WIDE_BADGE_NOTIFICATION_TYPES),
  );
}

/**
 * Acesso conta-instituição é revalidado na mesma consulta. O badge é da conta
 * inteira, mas nunca preserva uma notificação de instituição que o usuário já
 * não pode mais acessar.
 */
function activeAccountMembershipPredicate(subject: AccountBadgeSubject) {
  return and(
    eq(professionalInstitutions.userId, subject.userId),
    eq(professionalInstitutions.active, true),
    eq(professionals.userId, professionalInstitutions.userId),
    eq(users.id, professionalInstitutions.userId),
    eq(users.sessionVersion, subject.sessionVersion),
    eq(users.approvalStatus, "APPROVED"),
    isNull(users.deletedAt),
    eq(institutions.isActive, true),
  );
}

/**
 * A semântica única do badge é "alerta ainda não reconhecido pela conta".
 * Um ticket somente entra após o Expo aceitá-lo; QUEUED e SUBMITTING nunca
 * entram. O mesmo predicado é usado no ícone em background, na leitura e no
 * acknowledgement local, portanto uma row não pode reaparecer após o receipt
 * apenas porque o app foi aberto entre as duas etapas do transporte.
 */
function providerAcceptedBadgeNotification(): SQL {
  return or(
    eq(notifications.status, "SENT"),
    and(
      eq(notifications.status, "PENDING"),
      eq(trackingPhaseType, "STRING"),
      inArray(trackingPhase, ["TICKET_ACCEPTED", "RECEIPT_CHECKING"]),
    ),
  )!;
}

async function countAccountBadgeNotifications(
  db: Pick<Db, "select">,
  subject: AccountBadgeSubject,
  deliveryPredicate: SQL,
): Promise<number> {
  const [result] = await db
    .select({ count: sql<unknown>`COUNT(DISTINCT ${notifications.id})` })
    .from(notifications)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.userId, notifications.userId),
        eq(professionalInstitutions.institutionId, notifications.institutionId),
      ),
    )
    .innerJoin(
      professionals,
      eq(professionals.id, professionalInstitutions.professionalId),
    )
    .innerJoin(users, eq(users.id, professionalInstitutions.userId))
    .innerJoin(institutions, eq(institutions.id, notifications.institutionId))
    .where(
      and(
        eq(notifications.userId, subject.userId),
        eq(notifications.read, false),
        accountBadgeNotificationPredicate(),
        activeAccountMembershipPredicate(subject),
        deliveryPredicate,
      ),
    );

  return parseAccountWideNotificationBadgeCount(result?.count);
}

export function parseAccountWideNotificationBadgeCount(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new Error("Contagem de notificações inválida");
  }
  // mysql2 pode devolver agregados como string; aceite só a representação
  // decimal canônica. `Number(null)`/`Number(\"\")` nunca pode zerar badge.
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("Contagem de notificações inválida");
}

/**
 * Fonte canônica do badge do ícone. Não usa o tenant do request: a única
 * fronteira é a conta autenticada, com cada associação institucional ativa
 * revalidada pelo join acima.
 */
export async function countUnreadAccountBadgeNotifications(
  db: Pick<Db, "select">,
  subject: AccountBadgeSubject,
): Promise<number> {
  return countAccountBadgeNotifications(
    db,
    subject,
    providerAcceptedBadgeNotification(),
  );
}

/**
 * Não há inbox individual nesta versão. Ao abrir ou retomar o app com a
 * sessão VERIFIED, o próprio usuário reconhece todos os alertas account-wide
 * que já foram aceitos pelo provedor e continuam visíveis pelos seus vínculos
 * ativos. O predicado é idêntico ao da contagem, inclusive durante a janela
 * entre ticket aceito e receipt final.
 *
 * A seleção e o update ocorrem na mesma transação, com lock nas rows da
 * notificação e dos vínculos usados pelo selector. Assim, uma revogação que
 * já venceu o lock exclui a row; uma revogação concorrente espera este
 * acknowledgement terminar e a próxima contagem a remove. Nunca há ID ou
 * payload aceito do aparelho, nem leitura/write de outra conta.
 */
export async function acknowledgeUnreadAccountBadgeNotifications(
  db: Db,
  subject: AccountBadgeSubject,
): Promise<number> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .innerJoin(
        professionalInstitutions,
        and(
          eq(professionalInstitutions.userId, notifications.userId),
          eq(professionalInstitutions.institutionId, notifications.institutionId),
        ),
      )
      .innerJoin(
        professionals,
        eq(professionals.id, professionalInstitutions.professionalId),
      )
      .innerJoin(users, eq(users.id, professionalInstitutions.userId))
      .innerJoin(institutions, eq(institutions.id, notifications.institutionId))
      .where(
        and(
          eq(notifications.userId, subject.userId),
          eq(notifications.read, false),
          accountBadgeNotificationPredicate(),
          activeAccountMembershipPredicate(subject),
          providerAcceptedBadgeNotification(),
        ),
      )
      .for("update");

    const notificationIds = candidates.map((candidate) => candidate.id);
    if (notificationIds.length === 0) return 0;

    const [updated] = await tx
      .update(notifications)
      .set({ read: true })
      .where(
        and(
          eq(notifications.userId, subject.userId),
          eq(notifications.read, false),
          inArray(notifications.id, notificationIds),
        ),
      );
    return Number(updated.affectedRows ?? 0);
  });
}
