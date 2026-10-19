import {
  CalendarDays,
  Inbox,
  Layers,
  MoreHorizontal,
  SlidersHorizontal,
  Sun,
  type LucideIcon,
} from "lucide-react";

export type AreaKey = "hoy" | "entrada" | "proyectos" | "calendario" | "control";

export interface Area {
  key: AreaKey;
  href: string;
  icon: LucideIcon;
}

/** Five desktop areas, in the order of demo/desktop.html. */
export const AREAS: Area[] = [
  { key: "hoy", href: "/hoy", icon: Sun },
  { key: "entrada", href: "/entrada", icon: Inbox },
  { key: "proyectos", href: "/proyectos", icon: Layers },
  { key: "calendario", href: "/calendario", icon: CalendarDays },
  { key: "control", href: "/control", icon: SlidersHorizontal },
];

export type MobileTabKey = "hoy" | "entrada" | "agenda" | "compromisos" | "mas";

/** Five mobile tabs, in the order of demo/mobile.html. */
export const MOBILE_TABS: { key: MobileTabKey; href: string; icon: LucideIcon }[] = [
  { key: "hoy", href: "/hoy", icon: Sun },
  { key: "entrada", href: "/entrada", icon: Inbox },
  { key: "agenda", href: "/calendario", icon: CalendarDays },
  { key: "compromisos", href: "/proyectos?tab=compromisos", icon: Layers },
  { key: "mas", href: "/mas", icon: MoreHorizontal },
];
