import { appRouter } from "../server/routers";
import { getDb } from "../server/db";
import { sectors, shifts, users } from "../drizzle/schema";
import { eq } from "drizzle-orm";

describe("Shifts API", () => {
  let testUserId: number;
  let testSectorId: number;
