import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowRight,
  IconChartCandle,
  IconChartHistogram,
  IconChartLine,
  IconCheck,
  IconChevronRight,
  IconCircleX,
  IconClock,
  IconCoins,
  IconCopy,
  IconDatabase,
  IconEye,
  IconGauge,
  IconHeartbeat,
  IconInfoCircle,
  IconKey,
  IconLock,
  IconMenu2,
  IconMessage2,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconRocket,
  IconSettings,
  IconShieldCheck,
  IconShieldLock,
  IconSparkles,
  IconTrendingUp,
  IconWallet,
  IconX,
  type IconProps as TablerIconProps
} from "@tabler/icons-react";
import type { ComponentType } from "react";

export type IconName =
  | "activity"
  | "alert"
  | "arrow"
  | "candle"
  | "chart"
  | "check"
  | "chevron"
  | "circle-x"
  | "clock"
  | "close"
  | "coins"
  | "copy"
  | "database"
  | "eye"
  | "gauge"
  | "heartbeat"
  | "histogram"
  | "info"
  | "key"
  | "lock"
  | "menu"
  | "message"
  | "pause"
  | "play"
  | "pullback"
  | "refresh"
  | "rocket"
  | "settings"
  | "shield"
  | "shield-lock"
  | "spark"
  | "trend"
  | "wallet"
  | "x";

interface IconProps extends Omit<TablerIconProps, "size"> {
  name: IconName;
  size?: number;
}

const ICONS: Record<IconName, ComponentType<TablerIconProps>> = {
  activity: IconActivityHeartbeat,
  alert: IconAlertTriangle,
  arrow: IconArrowRight,
  candle: IconChartCandle,
  chart: IconChartLine,
  check: IconCheck,
  chevron: IconChevronRight,
  "circle-x": IconCircleX,
  clock: IconClock,
  close: IconX,
  coins: IconCoins,
  copy: IconCopy,
  database: IconDatabase,
  eye: IconEye,
  gauge: IconGauge,
  heartbeat: IconHeartbeat,
  histogram: IconChartHistogram,
  info: IconInfoCircle,
  key: IconKey,
  lock: IconLock,
  menu: IconMenu2,
  message: IconMessage2,
  pause: IconPlayerPause,
  play: IconPlayerPlay,
  pullback: IconArrowBackUp,
  refresh: IconRefresh,
  rocket: IconRocket,
  settings: IconSettings,
  shield: IconShieldCheck,
  "shield-lock": IconShieldLock,
  spark: IconSparkles,
  trend: IconTrendingUp,
  wallet: IconWallet,
  x: IconX
};

export function Icon({ name, size = 18, ...props }: IconProps) {
  const Glyph = ICONS[name];
  return <Glyph aria-hidden="true" size={size} stroke={1.75} {...props} />;
}
