/**
 * LEVEL 链式差额计算器 — 通用纯计算，无外部依赖
 *
 * 领域无关的"链式水位差"分配：沿祖先链（近到远），每个节点拿
 * (自身 rankRate - 已累计水位) 的差额；rankRate 为百分比整数（15=15%）；
 * diffRate<=0 的节点跳过（同级/降级不发）；accumulateInChain=true 的奖励才推进水位。
 * 这是极差/级差/多级佣金的通用计算模式（对应 RewardDef 的 LEVEL 类型）。
 *
 * 引擎不认识任何业务词；团队极差等业务口径由适配层翻译为 LEVEL 配置，
 * 参考 src/adapters/customer-adapter-template.js。
 *
 * @version 2.1.0
 */

const Decimal = require("../../decimal");

/**
 * 读取节点链式比例（百分比整数）。
 * @private
 */
function _getRankRate(node) {
  if (!node) return "0";
  // 顶层 rankRate 优先，回退到 attrs.rankRate（兼容上层将比例放在 attrs 中的情况）
  return String(node.rankRate ?? node.attrs?.rankRate ?? "0");
}

/**
 * 通用 LEVEL 链式差额计算（纯计算）
 *
 * 示例：eventValue=1000，祖先链 rankRate 为 15/30/60：
 * - 祖先1 拿 1000×15%=150，水位升至 15%；
 * - 祖先2 只得 1000×(30%-15%)=150，水位升至 30%；
 * - 祖先3 只得 1000×(60%-30%)=300，水位升至 60%。
 *
 * @param {Object} params
 * @param {Object} params.rewardDef - RewardDef { rewardId, type:"LEVEL", accumulateInChain }
 * @param {string} params.eventValue - 事件数值（decimal string）
 * @param {Array<Object>} params.ancestors - 祖先链，按近到远排序，每个元素 { id, rankRate }
 * @returns {Array<Object>} 通用候选记录列表
 */
function calculateLevelChain({ rewardDef, eventValue = "0", ancestors = [] }) {
  const records = [];
  // waterLevel 是"已发链式水位"（百分比整数）：每个祖先只能领取自己比例高于水位的差额，
  // 避免每层祖先都按自己的完整比例重复领取。
  let waterLevel = "0";

  for (const ancestor of ancestors) {
    const nodeId = ancestor.id;
    const currentRate = _getRankRate(ancestor);
    // diffRate <= 0 代表当前祖先比例不高于下方已发水位 → 不发（同级/降级）。
    const diffRate = Decimal.sub(currentRate, waterLevel);
    if (Decimal.lte(diffRate, "0")) continue;

    const amount = Decimal.pct(eventValue, diffRate);
    if (Decimal.lte(amount, "0")) continue;

    records.push({
      nodeId,
      rewardId: rewardDef.rewardId,
      rewardType: "LEVEL",
      amount,
      previousRate: waterLevel,
      currentRate,
      diffRate,
      snapshot: {
        rewardId: rewardDef.rewardId,
        rewardType: "LEVEL",
        ancestorNodeId: nodeId,
        previousRate: waterLevel,
        currentRate,
        diffRate,
        accumulateInChain: rewardDef.accumulateInChain === true,
      },
    });

    // 只有标记 accumulateInChain 的奖励才推进水位（OVER 等非累积奖励不推进）。
    if (rewardDef.accumulateInChain === true) {
      waterLevel = currentRate;
    }
  }

  return records;
}

module.exports = { calculateLevelChain };
