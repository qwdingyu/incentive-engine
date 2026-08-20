/**
 * DIRECT / FIXED / CUSTOM 奖励计算器 — 通用纯计算，无外部依赖
 *
 * 领域无关：
 * - DIRECT 奖励 = eventValue × rate（rate 为百分比整数，5=5%）
 * - FIXED  奖励 = 固定金额 fixedAmount（与事件金额无关，如"每单返现固定金额 / 邀新固定红包"）
 * - CUSTOM 奖励 = 固定金额常量 amount，或按 amountFrom 从事件动态取数
 *
 * 均支持 target=PARENT（直接上级）/ SOURCE（事件来源节点自身，由 distributeByDefs 处理），
 * skipRankZero=true 时目标节点为最低等级（rankRate<=0）则不发放。
 *
 * 引擎不认识任何业务词（直推/佣金/返利是上层把业务规则翻译成 RewardDef 配置后的结果）。
 * 业务侧的直推规则由适配层翻译为 RewardDef，参考 src/adapters/customer-adapter-template.js。
 *
 * @version 2.3.0
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
 * 从事件按点分路径取扩展属性值（如 "a.b.c" → attrs.a.b.c）
 * @private
 * @param {Object} attrs - 事件扩展属性对象
 * @param {string} path - 点分路径
 * @returns {*} 值；路径不存在返回 undefined
 */
function _getByPath(attrs, path) {
  if (!attrs || typeof attrs !== "object" || !path) return undefined;
  let cur = attrs;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * 解析 CUSTOM 奖励金额：amountFrom 优先（动态取数），失败回退 amount 常量
 *
 * 供 direct-calculator（calculateCustom）与 reward-distributor（CUSTOM-SOURCE 内联分支）
 * 共用，避免两处各自实现（铁律：重复逻辑必须抽象为共享函数）。
 *
 * @param {Object} rewardDef - { amount?, amountFrom? }
 * @param {Object} event - { eventValue, attrs? }
 * @returns {string|null} 金额 decimal string；无法解析返回 null
 */
function resolveCustomAmount(rewardDef, event) {
  const from = rewardDef.amountFrom;
  if (from) {
    if (from === "eventValue") {
      const v = event?.eventValue ?? "0";
      if (v !== "" && v !== null && v !== undefined) return String(v);
    } else if (from.startsWith("event.attrs.")) {
      const path = from.slice("event.attrs.".length);
      const v = _getByPath(event?.attrs, path);
      if (v !== "" && v !== null && v !== undefined) {
        return typeof v === "number" ? String(v) : v;
      }
    }
    // 未知路径或取不到值 → 回退固定金额（无金额则 null，由调用方决定是否发放）
  }
  const amount = rewardDef.amount;
  if (amount === "" || amount === null || amount === undefined) return null;
  return String(amount);
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

/**
 * 通用 CUSTOM 奖励计算（固定金额常量 + 可选动态取数，纯计算）
 *
 * 覆盖"注册送固定积分 / V等级拿固定红包"等固定金额营销场景：
 * - amount：固定金额常量（如 "100" = 100 积分）
 * - amountFrom：可选动态取数路径，优先于 amount
 *   - "eventValue"：直接用事件值作为金额
 *   - "event.attrs.<path>"：按点分路径从事件扩展属性取数（如 "event.attrs.level"）
 *   - 取数失败（路径不存在 / 值为空）→ 回退 amount 常量
 * - 两者都不可解析 → 返回 null（调用方视为不发放，保持"未配置 CUSTOM 静默跳过"兼容）
 *
 * target/skipRankZero 语义与 FIXED 完全一致。
 *
 * @param {Object} params
 * @param {Object} params.rewardDef - RewardDef { rewardId, type:"CUSTOM", amount?, amountFrom?, skipRankZero }
 * @param {Object|null} params.event - 引擎事件 { eventValue, attrs? }（动态取数数据源）
 * @param {Object|null} params.targetNode - 奖励目标节点 { id, rankRate? }；PARENT 型必须传
 * @returns {Object|null} 通用候选记录 { nodeId, rewardId, rewardType, amount, snapshot }；无资格或金额<=0 返回 null
 */
function calculateCustom({ rewardDef, event = null, targetNode = null }) {
  // 无目标节点 → 不发。
  if (!targetNode) return null;

  // 解析金额：amountFrom 动态取数优先，失败回退 amount 常量；都无 → 不发。
  const resolved = resolveCustomAmount(rewardDef, event);
  if (resolved === null) return null;
  if (!Decimal.gt(resolved, "0")) return null;

  // skipRankZero：最低等级节点不参与 CUSTOM 发放（默认 true）。
  if (rewardDef.skipRankZero !== false && _isRankZero(targetNode)) return null;

  return {
    nodeId: targetNode.id,
    rewardId: rewardDef.rewardId,
    rewardType: "CUSTOM",
    amount: resolved,
    snapshot: {
      rewardId: rewardDef.rewardId,
      rewardType: "CUSTOM",
      amount: resolved,
      amountFrom: rewardDef.amountFrom ?? null,
      targetNodeId: targetNode.id,
      targetRankRate: targetNode.rankRate ?? "0",
      skipRankZero: rewardDef.skipRankZero === false ? false : true,
    },
  };
}

module.exports = { calculateDirect, calculateFixed, calculateCustom, resolveCustomAmount };
