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
 * 松茸场景的候选构造见 src/adapters/songrong-reward-adapter.js。
 *
 * @version 2.3.0
 */

const Decimal = require("../../decimal");
const { calculateDirect, calculateFixed, calculateCustom, resolveCustomAmount } = require("./direct-calculator");
const { calculateLevelChain } = require("./chain-calculator");

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
