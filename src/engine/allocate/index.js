/**
 * 分配器模块 — 统一导出（v2.2.0 新增 compareAmounts）
 *
 * 本模块只保留领域无关的通用分配原语；面向具体业务的封装（单条裁剪、
 * 金额克隆、固定比例拆分等）属于适配层职责，参考 src/adapters/customer-adapter-template.js。
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
