import { 
  LayoutDashboard, 
  CalendarDays, 
  Settings, 
  User,
  ClipboardCheck,
  Briefcase,
  BarChart3,
  Grid3X3,
} from "lucide-react-native";

export type TabIconName = "home" | "calendar" | "weekly" | "dashboard" | "work" | "pending" | "admin" | "profile";

interface TabIconProps {
  name: TabIconName;
  color: string;
  size?: number;
}

export function TabIcon({ name, color, size = 24 }: TabIconProps) {
  const icons = {
    home: LayoutDashboard,
    calendar: CalendarDays,
    weekly: Grid3X3,
    dashboard: BarChart3,
    work: Briefcase,
    pending: ClipboardCheck,
    admin: Settings,
    profile: User,
  };

  const Icon = icons[name];
  return <Icon color={color} size={size} />;
}
