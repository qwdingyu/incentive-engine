/**
 * 奖励分配器 — 统一导出（v2.2.0 仅保留通用核心，领域无关）
 *
 * 松茸场景适配（buildRewardCandidates/calculateDirectPush/calculateTeamDiff）
 * 已迁至 src/adapters/songrong-reward-adapter.js。
 */
const { calculateDirect, calculateFixed, calculateCustom } = require("./direct-calculator");
const { calculateLevelChain } = require("./chain-calculator");
const { distributeByDefs } = require("./reward-distributor");

module.exports = {
  distributeByDefs,
  calculateDirect,
  calculateFixed,
  calculateCustom,
  calculateLevelChain,
};
