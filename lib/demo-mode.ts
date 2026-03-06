import AsyncStorage from "@react-native-async-storage/async-storage";

const DEMO_MODE_KEY = "@hospital_shifts:demo_mode";
const SELECTED_SERVICE_KEY = "@hospital_shifts:selected_service";

export type ShiftType = "manha" | "tarde" | "noite";

export const SHIFT_TIMES = {
  manha: { start: 7, end: 13, label: "Manhã", hours: "7h - 13h" },
  tarde: { start: 13, end: 19, label: "Tarde", hours: "13h - 19h" },
  noite: { start: 19, end: 7, label: "Noite", hours: "19h - 7h" },
} as const;

export const DEMO_SERVICES = [
  { id: 1, name: "Anestesia", icon: "syringe" },
  { id: 2, name: "Cirurgia", icon: "scalpel" },
  { id: 3, name: "Emergência", icon: "heart-pulse" },
  { id: 4, name: "Clínica Médica", icon: "stethoscope" },
  { id: 5, name: "Pediatria", icon: "baby" },
  { id: 6, name: "Ortopedia", icon: "bone" },
  { id: 7, name: "Cardiologia", icon: "heart" },
  { id: 8, name: "Gestão", icon: "briefcase" },
] as const;

export const DEMO_SECTORS = [
  { id: 1, name: "Centro Cirúrgico" },
  { id: 2, name: "UTI" },
  { id: 3, name: "Pronto Socorro" },
  { id: 4, name: "Pediatria" },
] as const;

const DEMO_PROFESSIONALS = [
  { id: 1, name: "Dr. João Silva", serviceId: 1 },
  { id: 2, name: "Dra. Maria Santos", serviceId: 1 },
  { id: 3, name: "Dr. Pedro Costa", serviceId: 3 },
  { id: 4, name: "Dra. Ana Lima", serviceId: 5 },
] as const;

export const DEMO_USER = {
  id: 30001,
  openId: "demo-30001",
  name: "Dr. João Silva",
  email: "joao.silva@demo.local",
  loginMethod: "demo",
  lastSignedIn: new Date(),
};

function createShiftTime(date: Date, shiftType: ShiftType): { start: Date; end: Date } {
  const start = new Date(date);
  const end = new Date(date);

  const slot = SHIFT_TIMES[shiftType];
  start.setHours(slot.start, 0, 0, 0);
  end.setHours(slot.end, 0, 0, 0);

  if (shiftType === "noite") {
    end.setDate(end.getDate() + 1);
  }

  return { start, end };
}

function generateDemoShifts() {
  const shifts: Array<{
    shift: {
      id: number;
      sectorId: number;
      startTime: Date;
      endTime: Date;
      status: "confirmada" | "pendente" | "cancelada";
      notes: string;
      createdBy: number;
      createdAt: Date;
      updatedAt: Date;
    };
    sector: { id: number; name: string };
    shiftType: ShiftType;
    serviceId: number;
    assignments: Array<{ professionalId: number; professionalName: string; confirmed: boolean }>;
  }> = [];

  let shiftId = 1;
  const now = new Date();
  const currentHour = now.getHours();
  const currentShiftType: ShiftType =
    currentHour >= 7 && currentHour < 13 ? "manha" : currentHour >= 13 && currentHour < 19 ? "tarde" : "noite";

  const activeWindow = createShiftTime(now, currentShiftType);
  shifts.push({
    shift: {
      id: shiftId++,
      sectorId: 1,
      startTime: activeWindow.start,
      endTime: activeWindow.end,
      status: "confirmada",
      notes: `Plantão ${SHIFT_TIMES[currentShiftType].label} - ${SHIFT_TIMES[currentShiftType].hours}`,
      createdBy: 999,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    sector: DEMO_SECTORS[0],
    shiftType: currentShiftType,
    serviceId: 1,
    assignments: [
      { professionalId: 1, professionalName: "Dr. João Silva", confirmed: true },
      { professionalId: 2, professionalName: "Dra. Maria Santos", confirmed: true },
    ],
  });

  for (let dayOffset = 0; dayOffset < 30; dayOffset += 1) {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);

    const turns: ShiftType[] = ["manha", "tarde", "noite"];

    turns.forEach((shiftType, shiftIndex) => {
      const sector = DEMO_SECTORS[(dayOffset + shiftIndex) % DEMO_SECTORS.length];
      const professional = DEMO_PROFESSIONALS[(dayOffset + shiftIndex) % DEMO_PROFESSIONALS.length];
      const backup = DEMO_PROFESSIONALS[(dayOffset + shiftIndex + 1) % DEMO_PROFESSIONALS.length];
      const window = createShiftTime(date, shiftType);
      const statuses = ["confirmada", "pendente", "cancelada"] as const;
      const status = dayOffset < 2 ? "pendente" : statuses[(dayOffset + shiftIndex) % statuses.length];

      shifts.push({
        shift: {
          id: shiftId++,
          sectorId: sector.id,
          startTime: window.start,
          endTime: window.end,
          status,
          notes: `Plantão ${SHIFT_TIMES[shiftType].label} - ${SHIFT_TIMES[shiftType].hours}`,
          createdBy: 999,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        sector,
        shiftType,
        serviceId: professional.serviceId,
        assignments: [
          { professionalId: professional.id, professionalName: professional.name, confirmed: status === "confirmada" },
          { professionalId: backup.id, professionalName: backup.name, confirmed: status === "confirmada" },
        ],
      });
    });
  }

  return shifts;
}

export const DEMO_SHIFTS = generateDemoShifts();

export async function isDemoMode(): Promise<boolean> {
  const value = await AsyncStorage.getItem(DEMO_MODE_KEY);
  return value === "true";
}

export async function enableDemoMode(): Promise<void> {
  await AsyncStorage.setItem(DEMO_MODE_KEY, "true");
}

export async function disableDemoMode(): Promise<void> {
  await AsyncStorage.setItem(DEMO_MODE_KEY, "false");
}

export async function getSelectedService(): Promise<number | null> {
  const value = await AsyncStorage.getItem(SELECTED_SERVICE_KEY);
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function setSelectedService(serviceId: number): Promise<void> {
  await AsyncStorage.setItem(SELECTED_SERVICE_KEY, serviceId.toString());
}

export async function clearSelectedService(): Promise<void> {
  await AsyncStorage.removeItem(SELECTED_SERVICE_KEY);
}
