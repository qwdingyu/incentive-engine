/**
 * 奖励分配器 — 通用分发入口（领域无关，纯计算，无外部依赖）
 *
 * 遍历 RewardDef 列表驱动分配，引擎不认识任何业务词（直推/极差/佣金/返利
 * 是上层把业务规则翻译成 rewardDefs 配置后的结果）：
 * - DIRECT + target=SOURCE  → 事件来源节点自身（如"本人收益 100%"）
 * - DIRECT + target=PARENT  → 直接上级（如"一级分销佣金 10%"）
 * - FIXED                   → 固定金额（DIRECT 的按比例版，金额与事件值无关；target 同 DIRECT）
 * - CUSTOM                  → 固定金额常量 + 可选动态取数（amount / amountFrom；target 同 DIRECT）
 * - LEVEL                  → 链式差额（如"多级团队佣金/极差"）
 *
 * 具体业务的候选构造由适配层完成，参考 src/adapters/customer-adapter-template.js。
 *
 * @version 2.3.0
 */

const Decimal = require("../../decimal");
const { calculateDirect, calculateFixed, calculateCustom, resolveCustomAmount } = require("./direct-calculator");
const { calculateLevelChain } = require("./chain-calculator");
const { evaluateCondition } = require("../evaluate/condition-evaluator");

/**
 * 评估奖励定义的条件（rewardDef.conditions），不满足则跳过该奖励
 *
 * 数据源 = 事件对象（event 含 attrs），与 condition-evaluator._resolveField 的
 * attrs 回退兼容（如 `{ field: "orderAmount", operator: "GTE", value: 1000 }`
 * 会读取 event.attrs.orderAmount）。语义：
 *   - conditions 为空/未配置 → true（发放）
 *   - conditions 配置但数据源无匹配字段 → 字段解析为 0，条件大概率不满足 → false（跳过）
 *
 * @private
 * @param {Object} def - RewardDef { conditions? }
 * @param {Object} event - EngineEvent { eventValue, attrs? }
 * @returns {boolean} 是否应发放该奖励
 */
function _meetsRewardCondition(def, event) {
  const conditions = def.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  // 兼容两种格式：纯 COMPARE 数组包装为 AND；单个复合条件（AND/OR/NOT）直接评估
  const wrapper = conditions.length === 1 && conditions[0].type
    ? conditions[0]
    : { type: "AND", children: conditions.map((c) => (c.type ? c : { type: "COMPARE", ...c })) };
  return evaluateCondition(wrapper, event);
}

/**
 * 按奖励定义列表分发事件奖励（通用纯计算）
 *
 * @param {Object} params
 * @param {Object} params.event - EngineEvent { sourceNodeId, eventValue, eventType, eventId, attrs? }
 * @param {Object|null} params.directParent - 直接上级节点 { id, rankRate? }；DIRECT target=PARENT 用
 * @param {Array<Object>} params.ancestors - 祖先链（近到远）；LEVEL 用，每个元素 { id, rankRate }
 * @param {Array<Object>} params.rewardDefs - 奖励定义列表
 *        DIRECT: { rewardId, type:"DIRECT", target:"SOURCE"|"PARENT", rate, skipRankZero? }
 *        FIXED:  { rewardId, type:"FIXED", target:"SOURCE"|"PARENT", fixedAmount, skipRankZero? }
 *        CUSTOM: { rewardId, type:"CUSTOM", target:"SOURCE"|"PARENT", amount?, amountFrom?, skipRankZero? }
 *        LEVEL:  { rewardId, type:"LEVEL", accumulateInChain }
 * @returns {Array<Object>} 通用候选记录
 *         { nodeId, rewardId, rewardType, amount, previousRate?, currentRate?, diffRate?, snapshot }
 */
function distributeByDefs({ event, directParent = null, ancestors = [], rewardDefs = [] }) {
  const records = [];
  const eventValue = event?.eventValue ?? "0";

  for (const def of rewardDefs) {
    if (!def || !def.type) {
      throw new Error(`奖励定义无效: ${JSON.stringify(def)}（必须包含 type 字段）`);
    }
    // 奖励发放条件评估：conditions 配置且不满足时跳过该奖励（防静默超发，
    // 曾为"配置了但未评估"的资金安全死角，见 engine 3.4.0 修复）
    if (!_meetsRewardCondition(def, event)) {
      continue;
    }
    if (def.type === "DIRECT") {
      if (def.target === "SOURCE") {
        // 事件来源节点自身：金额 = eventValue × rate（如"本人收益 100%"）。
        if (Decimal.gt(def.rate, "0")) {
          const amount = Decimal.pct(eventValue, def.rate);
          if (Decimal.gt(amount, "0")) {
            records.push({
              nodeId: event?.sourceNodeId ?? null,
              rewardId: def.rewardId,
              rewardType: "DIRECT",
              amount,
              snapshot: {
                rewardId: def.rewardId,
                rewardType: "DIRECT",
                target: "SOURCE",
                rate: def.rate,
                sourceNodeId: event?.sourceNodeId ?? null,
              },
            });
          }
        }
      } else if (def.target === "PARENT") {
        // DIRECT target=PARENT：直接上级固定比例。
        const r = calculateDirect({ rewardDef: def, eventValue, targetNode: directParent });
        if (r) records.push(r);
      } else {
        throw new Error(`DIRECT 奖励定义未知 target: "${def.target}"（支持: SOURCE, PARENT）`);
      }
    } else if (def.type === "LEVEL") {
      // LEVEL：链式水位差（极差/多级佣金的通用模式）。
      records.push(...calculateLevelChain({ rewardDef: def, eventValue, ancestors }));
    } else if (def.type === "FIXED") {
      // FIXED：固定金额（DIRECT 的按固定值版，与事件金额无关，如"每单返现固定金额/邀新固定红包"）。
      if (def.target === "SOURCE") {
        // 事件来源节点自身：固定金额。与 DIRECT-SOURCE 一致，不应用 skipRankZero。
        if (Decimal.gt(def.fixedAmount ?? "0", "0")) {
          const amount = String(def.fixedAmount);
          if (Decimal.gt(amount, "0")) {
            records.push({
              nodeId: event?.sourceNodeId ?? null,
              rewardId: def.rewardId,
              rewardType: "FIXED",
              amount,
              snapshot: {
                rewardId: def.rewardId,
                rewardType: "FIXED",
                target: "SOURCE",
                fixedAmount: amount,
                sourceNodeId: event?.sourceNodeId ?? null,
              },
            });
          }
        }
      } else if (def.target === "PARENT") {
        // FIXED target=PARENT：直接上级固定金额。
        const r = calculateFixed({ rewardDef: def, targetNode: directParent });
        if (r) records.push(r);
      } else {
        throw new Error(`FIXED 奖励定义未知 target: "${def.target}"（支持: SOURCE, PARENT）`);
      }
    } else if (def.type === "CUSTOM") {
      // CUSTOM：固定金额常量 + 可选动态取数（如"注册送 100 积分"、"V1 拿 10 元固定红包"）。
      // 金额解析：amountFrom（"eventValue" / "event.attrs.<path>"）优先，失败回退 amount 常量；
      // 两者都不可解析 → 静默跳过（保持"配置中存在但未配金额的 CUSTOM 规则"不抛错兼容）。
      if (def.target === "SOURCE") {
        // 事件来源节点自身：解析金额后发放。与 DIRECT/FIXED-SOURCE 一致，不应用 skipRankZero。
        const resolved = resolveCustomAmount(def, event);
        if (resolved !== null && Decimal.gt(resolved, "0")) {
          records.push({
            nodeId: event?.sourceNodeId ?? null,
            rewardId: def.rewardId,
            rewardType: "CUSTOM",
            amount: resolved,
            snapshot: {
              rewardId: def.rewardId,
              rewardType: "CUSTOM",
              target: "SOURCE",
              amount: resolved,
              amountFrom: def.amountFrom ?? null,
              sourceNodeId: event?.sourceNodeId ?? null,
            },
          });
        }
      } else if (def.target === "PARENT") {
        // CUSTOM target=PARENT：直接上级固定金额/动态金额。
        const r = calculateCustom({ rewardDef: def, event, targetNode: directParent });
        if (r) records.push(r);
      } else {
        throw new Error(`CUSTOM 奖励定义未知 target: "${def.target}"（支持: SOURCE, PARENT）`);
      }
    } else {
      throw new Error(`未知奖励类型: "${def.type}"（支持: DIRECT, LEVEL, FIXED, CUSTOM）`);
    }
  }

  return records;
}

module.exports = { distributeByDefs };
