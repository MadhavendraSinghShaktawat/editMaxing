import { BookOpen, Bolt, CircleAlert, Lightbulb, Music, Clapperboard, Coffee, Film, Heart, Moon, PenTool, Scissors, Settings, Sparkles, Star, Sun, Type } from "lucide-react";
import { ComponentType } from "react";

const MAP: Record<string, ComponentType<{ size?: number; color?: string; strokeWidth?: number; fill?: string }>> = {
  heart: Heart,
  bolt: Bolt,
  star: Star,
  film: Clapperboard,
  movie: Film,
  pen: PenTool,
  text: Type,
  book: BookOpen,
  gear: Settings,
  alert: CircleAlert,
  scissors: Scissors,
  coffee: Coffee,
  sun: Sun,
  moon: Moon,
  sparkles: Sparkles,
  think: Lightbulb,
  note: Music,
};

export function Icon({ name, size = 18, color = "currentColor", fill = "none" }: { name: string; size?: number; color?: string; fill?: string }) {
  const C = MAP[name] ?? Sparkles;
  return <C size={size} color={color} fill={fill} strokeWidth={2.3} />;
}
