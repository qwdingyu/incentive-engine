/**
 * 分配器模块 — 统一导出（v2.2.0 新增 compareAmounts）
 *
 * 松茸场景适配（applyCap/cloneWithAdjustedAmount/splitByPercentage）
 * 已迁至 src/adapters/songrong-reward-adapter.js。
 */
const { applyCaps, applyBudgetGuard } = require("./budget-controller");
const { splitByTargets } = require("./percentage-split-allocator");
const { compareAmounts } = require("./compare-allocator");

module.exports = {
  applyCaps,
  applyBudgetGuard,
  splitByTargets,
  compareAmounts,
};
