/**
 * DIRECT 奖励计算器 — 通用纯计算，无外部依赖
 *
 * 领域无关：DIRECT 奖励 = eventValue × rate（rate 为百分比整数，5=5%），
 * 支持 target=PARENT（直接上级）/ SOURCE（事件来源节点自身，由 distributeByDefs 处理），
 * skipRankZero=true 时目标节点为最低等级（rankRate<=0）则不发放。
 *
 * 引擎不认识任何业务词（直推/佣金/返利是上层把业务规则翻译成 RewardDef 配置后的结果）。
 * 松茸场景的直推适配见 src/adapters/songrong-reward-adapter.js。
 *
 * @version 2.1.0
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

module.exports = { calculateDirect };
