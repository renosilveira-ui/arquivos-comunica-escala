type StartShiftInput = {
  userId: number;
  sectorId: number;
  shiftId: number;
  startTime: Date;
  endTime: Date;
};

type SyncUserInput = {
  id: number;
  openId: string;
  name: string;
  email: string;
  role: string;
};

export async function startShiftInHospitalAlert(_input: StartShiftInput) {
  return {
    success: true,
    message: "ok",
    sessionToken: "test-session-token",
  };
}

export async function endShiftInHospitalAlert(_userId: number, _shiftId: number) {
  return {
    success: true,
    message: "ok",
  };
}

export async function checkHospitalAlertStatus() {
  return {
    online: true,
  };
}

export async function syncUserWithHospitalAlert(_user: SyncUserInput) {
  return {
    success: true,
    message: "ok",
  };
}

export async function getIntegrationStatus(externalUserId: string, organizationId: string) {
  const nowIso = new Date().toISOString();
  return {
    ok: true,
    organizationId,
    user: {
      exists: true,
      userId: 123,
      externalUserId,
      name: "Test User",
      email: "test@hospital.com",
      role: "nurse",
    },
    connection: {
      connected: true,
      lastSyncStatus: "success",
      lastSyncAt: nowIso,
      lastError: null,
    },
    shift: {
      active: true,
      shiftId: 1,
      startedAt: nowIso,
      service: { id: 1, name: "Anestesia" },
      sector: { id: 1, name: "UTI" },
      coverageType: "PLANTAO",
      staffingStatus: "OK",
      sourceApp: "escalas-app",
    },
    serverTime: nowIso,
    version: "0.0.0-test",
  };
}

export async function forceSyncWithHospitalAlert(_userId: number, _externalUserId: string) {
  const nowIso = new Date().toISOString();
  return {
    success: true,
    message: "ok",
    lastSyncAt: nowIso,
  };
}
