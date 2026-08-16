/**
 * 共享电商规则配置 — 01 与 04 共用，避免两处维护同一套奖励规则
 *
 * 说明：
 * - OVER 的 totalBudget（预算百分比）与 SPLIT 的 targets 属规则声明，
 *   但 eventValue / totalAmount 依赖运行时事件，由场景在组装流水线时注入。
 */
const ECOMMERCE_RULES = {
  rewardDefs: [
    { rewardId: "self_cashback", type: "DIRECT", target: "SOURCE", rate: "100" },
    { rewardId: "tier1_commission", type: "DIRECT", target: "PARENT", rate: "5" },
    { rewardId: "tier2_commission", type: "LEVEL", accumulateInChain: true },
  ],
  capDefs: [{ capId: "PLATFORM_DAILY", scope: "PLATFORM_DAILY", limit: "2000" }],
};

module.exports = { ECOMMERCE_RULES };
