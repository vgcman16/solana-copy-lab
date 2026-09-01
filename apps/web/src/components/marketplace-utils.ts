import type {
  MarketplaceAssetClass,
  MarketplacePilot,
  MarketplacePilotCategory,
  MarketplaceRisk
} from "./marketplace-types";

export const MARKETPLACE_CATEGORY_LABELS: Record<MarketplacePilotCategory, string> = {
  WALLET_COPY: "Wallet copy",
  AUTONOMOUS_AI: "Autonomous",
  STOCK_MOMENTUM: "Stock momentum",
  THEMATIC: "Thematic",
  HEDGE_FUND_13F: "13F tracker",
  POLITICIAN_DISCLOSURE: "Disclosure tracker"
};

export const MARKETPLACE_ASSET_LABELS: Record<MarketplaceAssetClass, string> = {
  CRYPTO: "Crypto",
  US_STOCKS: "US stocks",
  MULTI_ASSET: "Multi-asset"
};

export const MARKETPLACE_RISK_LABELS: Record<MarketplaceRisk, string> = {
  CONSERVATIVE: "Conservative",
  MODERATE: "Moderate",
  HIGH: "High risk",
  EXTREME: "Extreme risk"
};

export interface MarketplaceFilters {
  query: string;
  category: MarketplacePilotCategory | "ALL";
  assetClass: MarketplaceAssetClass | "ALL";
  risk: MarketplaceRisk | "ALL";
}

export function filterMarketplacePilots(
  pilots: readonly MarketplacePilot[],
  filters: MarketplaceFilters
): MarketplacePilot[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return pilots.filter((pilot) => {
    if (filters.category !== "ALL" && pilot.category !== filters.category) return false;
    if (filters.assetClass !== "ALL" && pilot.assetClass !== filters.assetClass) return false;
    if (filters.risk !== "ALL" && pilot.risk !== filters.risk) return false;
    if (!query) return true;
    const searchable = [
      pilot.name,
      pilot.summary,
      pilot.description,
      pilot.curator.name,
      MARKETPLACE_CATEGORY_LABELS[pilot.category],
      MARKETPLACE_ASSET_LABELS[pilot.assetClass],
      ...pilot.tags
    ].join(" ").toLocaleLowerCase();
    return searchable.includes(query);
  });
}

export function validateMarketplaceAllocation(
  pilot: MarketplacePilot,
  value: number,
  buyingPowerUsd?: number
): string | undefined {
  if (!Number.isFinite(value)) return "Enter a valid dollar amount.";
  if (value < pilot.allocation.minimumUsd) {
    return `Minimum PAPER allocation is $${pilot.allocation.minimumUsd.toFixed(2)}.`;
  }
  if (value > pilot.allocation.maximumUsd) {
    return `Maximum PAPER allocation is $${pilot.allocation.maximumUsd.toFixed(2)}.`;
  }
  if (buyingPowerUsd !== undefined && value > buyingPowerUsd) {
    return `Allocation exceeds the $${buyingPowerUsd.toFixed(2)} available PAPER buying power.`;
  }
  return undefined;
}

export function calculateMarketplacePercentAllocation(
  percent: number,
  referenceNavUsd: number,
  maximumPercent = 100
): { allocationUsd?: number; error?: string } {
  const boundedMaximum = Number.isFinite(maximumPercent)
    ? Math.min(100, Math.max(0, maximumPercent))
    : 100;
  if (!Number.isFinite(percent) || percent <= 0 || percent > boundedMaximum) {
    return { error: `Allocation percentage must be greater than 0% and no more than ${boundedMaximum.toFixed(2)}%.` };
  }
  if (!Number.isFinite(referenceNavUsd) || referenceNavUsd <= 0 || referenceNavUsd > 100_000_000) {
    return { error: "Reference NAV must be a positive PAPER value no greater than $100,000,000." };
  }
  const allocationUsd = referenceNavUsd * percent / 100;
  return Number.isFinite(allocationUsd)
    ? { allocationUsd }
    : { error: "The percentage allocation could not be calculated." };
}

export function pilotCanAcceptPaperEnrollment(pilot: MarketplacePilot): boolean {
  return pilot.availability.paper && pilot.stage !== "RESEARCH_ONLY" && pilot.stage !== "PAUSED";
}

export function marketplacePricingEvidenceCopy(pricingComplete: boolean): string {
  return pricingComplete
    ? "Performance includes executable modeled costs."
    : "This snapshot lacks complete executable-pricing evidence. The pilot's current PAPER qualification separately determines enrollment availability.";
}

export function marketplaceSignedPercent(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function marketplaceMoney(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

export function marketplaceRelativeTime(value?: string): string {
  if (!value) return "Not yet";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
