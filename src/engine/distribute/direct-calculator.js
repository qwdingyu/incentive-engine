/**
 * DIRECT / FIXED 奖励计算器 — 通用纯计算，无外部依赖
 *
 * 领域无关：
 * - DIRECT 奖励 = eventValue × rate（rate 为百分比整数，5=5%）
 * - FIXED  奖励 = 固定金额 fixedAmount（与事件金额无关，如"每单返现固定金额 / 邀新固定红包"）
 *
 * 均支持 target=PARENT（直接上级）/ SOURCE（事件来源节点自身，由 distributeByDefs 处理），
 * skipRankZero=true 时目标节点为最低等级（rankRate<=0）则不发放。
 *
 * 引擎不认识任何业务词（直推/佣金/返利是上层把业务规则翻译成 RewardDef 配置后的结果）。
 * 松茸场景的直推适配见 src/adapters/songrong-reward-adapter.js。
 *
 * @version 2.2.0
 */

const Decimal = require("../../decimal");

/**
 * 判断节点是否为最低等级（rankRate 为空或 <= 0）
 * @private
 * @param {Object|null} node - { rankRate? }
 * @returns {boolean}
 */
function _isRankZero(node) {
  if (!node) return true;
  return Decimal.lte(String(node.rankRate ?? "0"), "0");
}

/**
 * 通用 DIRECT 奖励计算（纯计算）
 *
 * @param {Object} params
 * @param {Object} params.rewardDef - RewardDef { rewardId, type:"DIRECT", rate, skipRankZero }
 * @param {string} params.eventValue - 事件数值（decimal string，金额/积分）
 * @param {Object|null} params.targetNode - 奖励目标节点 { id, rankRate? }；PARENT 型必须传
 * @returns {Object|null} 通用候选记录 { nodeId, rewardId, rewardType, amount, snapshot }；无资格或金额<=0 返回 null
 */
function calculateDirect({ rewardDef, eventValue = "0", targetNode = null }) {
  // 无目标节点或比例<=0 → 不发。
  if (!targetNode) return null;
  if (!Decimal.gt(rewardDef.rate, "0")) return null;

  // skipRankZero：最低等级节点不参与 DIRECT 发放（默认 true；直推等场景由配置关闭）。
  if (rewardDef.skipRankZero !== false && _isRankZero(targetNode)) return null;

  // 奖励金额 = 事件数值 × 比例。
  const amount = Decimal.pct(eventValue, rewardDef.rate);
  if (Decimal.lte(amount, "0")) return null;

  return {
    nodeId: targetNode.id,
    rewardId: rewardDef.rewardId,
    rewardType: "DIRECT",
    amount,
    snapshot: {
      rewardId: rewardDef.rewardId,
      rewardType: "DIRECT",
      rate: rewardDef.rate,
      targetNodeId: targetNode.id,
      targetRankRate: targetNode.rankRate ?? "0",
      skipRankZero: rewardDef.skipRankZero === false ? false : true,
    },
  };
}

/**
 * 通用 FIXED 固定金额奖励计算（纯计算）
 *
 * 与 DIRECT（按比例）相对：FIXED 发放固定金额，与事件金额无关，
 * 适用于"每单返现固定金额 / 邀新固定红包"等业务。
 *
 * @param {Object} params
 * @param {Object} params.rewardDef - RewardDef { rewardId, type:"FIXED", fixedAmount, skipRankZero }
 * @param {Object|null} params.targetNode - 奖励目标节点 { id, rankRate? }；PARENT 型必须传
 * @returns {Object|null} 通用候选记录 { nodeId, rewardId, rewardType, amount, snapshot }；无资格或金额<=0 返回 null
 */
function calculateFixed({ rewardDef, targetNode = null }) {
  // 无目标节点或固定金额<=0 → 不发。
  if (!targetNode) return null;
  if (!Decimal.gt(rewardDef.fixedAmount ?? "0", "0")) return null;

  // skipRankZero：最低等级节点不参与 FIXED 发放（默认 true）。
  if (rewardDef.skipRankZero !== false && _isRankZero(targetNode)) return null;

  // 奖励金额 = 固定金额本身（不依赖事件金额）。
  const amount = String(rewardDef.fixedAmount);
  if (Decimal.lte(amount, "0")) return null;

  return {
    nodeId: targetNode.id,
    rewardId: rewardDef.rewardId,
    rewardType: "FIXED",
    amount,
    snapshot: {
      rewardId: rewardDef.rewardId,
      rewardType: "FIXED",
      fixedAmount: amount,
      targetNodeId: targetNode.id,
      targetRankRate: targetNode.rankRate ?? "0",
      skipRankZero: rewardDef.skipRankZero === false ? false : true,
    },
  };
}

module.exports = { calculateDirect, calculateFixed };
