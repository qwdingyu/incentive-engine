/**
 * 奖励分配器 — 统一导出（v2.2.0 仅保留通用核心，领域无关）
 *
 * 本模块只保留领域无关的通用分配原语；面向具体业务的封装（直推、团队极差、
 * 候选构造等命名）属于适配层职责，参考 src/adapters/customer-adapter-template.js。
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
