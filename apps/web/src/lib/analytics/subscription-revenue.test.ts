import { describe, expect, it } from "vite-plus/test";
import { subscriptionRevenueUsd } from "./subscription-revenue";

describe("subscriptionRevenueUsd", () => {
  it("does not price a plan after paid catalog removal", () => {
    expect(subscriptionRevenueUsd("personal", "monthly", 3)).toBeUndefined();
    expect(subscriptionRevenueUsd("team", "annual", 3)).toBeUndefined();
  });
});
