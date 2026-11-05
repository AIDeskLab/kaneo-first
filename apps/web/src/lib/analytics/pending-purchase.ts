const KEY = "kaneo:pending-purchase";
const PLANS = new Set<string>(["personal", "team"]);
const INTERVALS = new Set<string>(["monthly", "annual"]);

export type PendingPurchase = {
  plan: "personal" | "team";
  interval: "monthly" | "annual";
};

export function savePendingPurchase(purchase: PendingPurchase) {
  try {
    sessionStorage.setItem(KEY, `${purchase.plan}-${purchase.interval}`);
  } catch {}
}

export function takePendingPurchase(): PendingPurchase | null {
  try {
    const value = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    const [plan, interval] = value?.split("-") ?? [];
    if (!PLANS.has(plan) || !INTERVALS.has(interval)) return null;
    return {
      plan: plan as PendingPurchase["plan"],
      interval: interval as PendingPurchase["interval"],
    };
  } catch {
    return null;
  }
}
