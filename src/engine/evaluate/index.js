/**
 * 等级评估模块 — 统一导出
 *
 * v2.2.0 新增 condition-evaluator（条件评估器独立模块）
 */
const { evaluateTier, getHighestQualifiedTier } = require("./rank-evaluator");
const { evaluateCondition } = require("./condition-evaluator");

module.exports = {
  evaluateTier,
  getHighestQualifiedTier,
  evaluateCondition,
};