import { useEffect } from "react";
import { takePendingPurchase } from "@/lib/analytics/pending-purchase";
import { subscriptionRevenueUsd } from "@/lib/analytics/subscription-revenue";
import { track } from "@/lib/analytics/track";

export function useTrackSubscription(
  checkout: string | undefined,
  seats: number | undefined,
) {
  useEffect(() => {
    if (checkout !== "success" || seats === undefined) return;
    const purchase = takePendingPurchase();
    if (!purchase) return;
    const revenue = subscriptionRevenueUsd(
      purchase.plan,
      purchase.interval,
      seats,
    );
    const props: Record<string, string | number | boolean> = {
      plan: purchase.plan,
      interval: purchase.interval,
    };
    if (revenue !== undefined) props.revenue_usd = revenue;
    track("Subscribed", { props });
  }, [checkout, seats]);
}
