/**
 * LEVEL 链式计算器 — 通用纯计算，无外部依赖
 *
 * 两种互斥的链式分配口径（由 RewardDef 是否配置 levelRates 决定）：
 *
 * 1. **水位差**（缺省，`levelRates` 未配置）：沿祖先链（近到远），每个节点拿
 *    (自身 rankRate - 已累计水位) 的差额；rankRate 为百分比整数（15=15%）；
 *    diffRate<=0 的节点跳过（同级/降级不发）；accumulateInChain=true 的奖励才推进水位。
 *    这是极差/级差的通用计算模式。
 * 2. **按层固定比例**（配置了 `levelRates`）：第 n 层祖先拿 eventValue × levelRates[n-1]，
 *    各层相互独立、不看 rankRate、不推进水位。这是"一级 10%、二级 5%、三级 3%"
 *    这类多级固定比例分销的通用计算模式。
 *
 * 引擎不认识任何业务词；团队极差等业务口径由适配层翻译为 LEVEL 配置，
 * 参考 src/adapters/customer-adapter-template.js。
 *
 * @version 2.3.0
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
 * 解析并校验 maxDepth（链式发放层数上限）。
 *
 * 未配置（null/undefined）→ 返回 Infinity（不限层数，与 3.4.x 行为一致）。
 * 配置了非法值（0、负数、小数、非数字）→ 抛错：链式深度直接决定发放总额，
 * 静默忽略一个写错的 maxDepth 等于让"深度风控"完全失效（fail-closed）。
 *
 * @private
 */
function _resolveMaxDepth(maxDepth) {
  if (maxDepth === null || maxDepth === undefined) return Infinity;
  const n = Number(maxDepth);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `calculateLevelChain：非法 maxDepth ${JSON.stringify(maxDepth)}（必须是 >= 1 的整数，或省略表示不限层数）`
    );
  }
  return n;
}

/**
 * 解析并校验 levelRates（按层固定比例表）。
 *
 * 未配置（null/undefined）→ 返回 null（走水位差口径，与 3.4.x 行为一致）。
 * 配置了非数组、空数组、含非法元素（负数/非数字/空串）、或全为 0 → 抛错：
 * 「配了按层比例表却发不出钱」是静默零发放，与配错深度上限同属静默失败（fail-closed）。
 * 与 accumulateInChain=true 同时出现 → 抛错：水位差与按层固定比例是两套互斥口径，
 * 静默择一会直接改变发放总额。
 *
 * @private
 * @returns {Array<string>|null} 归一为 decimal string 的比例表；null 表示未配置
 */
function _resolveLevelRates(rewardDef) {
  const levelRates = rewardDef?.levelRates;
  if (levelRates === null || levelRates === undefined) return null;

  if (!Array.isArray(levelRates) || levelRates.length === 0) {
    throw new Error(
      `calculateLevelChain：非法 levelRates ${JSON.stringify(levelRates)}（必须是非空数组，或省略表示按 rankRate 水位差分配）`
    );
  }
  if (rewardDef.accumulateInChain === true) {
    throw new Error(
      "calculateLevelChain：levelRates 与 accumulateInChain=true 互斥 —— " +
      "levelRates 是「每层各拿自己的固定比例」，水位差是「每层拿高于下方水位的差额」，" +
      "两者发放总额不同，不能同时声明。按层固定比例请去掉 accumulateInChain。"
    );
  }

  const normalized = levelRates.map((rate, i) => {
    const n = Number(rate);
    if (rate === null || rate === undefined || rate === "" || !Number.isFinite(n) || n < 0) {
      throw new Error(
        `calculateLevelChain：levelRates[${i}] 非法（${JSON.stringify(rate)}）—— 每层比例必须是 >= 0 的数值（百分比整数，10 = 10%）`
      );
    }
    return String(rate);
  });

  if (!normalized.some((rate) => Decimal.gt(rate, "0"))) {
    throw new Error(
      `calculateLevelChain：levelRates ${JSON.stringify(levelRates)} 全部为 0，任何一层都发不出金额 —— ` +
      "这通常是配置漏填。若确实不想发放，请移除该奖励定义而不是把比例全置 0。"
    );
  }

  return normalized;
}

/**
 * 按层固定比例分配（levelRates 口径，纯计算）。
 *
 * 第 n 层祖先（1 = 最近的祖先）拿 eventValue × levelRates[n-1]，各层独立、不看 rankRate、
 * 不推进水位。比例为 0 的层不发放但**仍占一层**（层号由链位置决定，不因跳过而前移）。
 * 有效层数 = min(levelRates.length, maxDepth)。
 *
 * @private
 */
function _calculateByLevelRates({ rewardDef, eventValue, ancestors, levelRates, maxDepth, nodeFilter }) {
  const records = [];
  // levelRates 本身就是一个隐式深度上限；与显式 maxDepth 同时存在时取更严的一方。
  const depthLimit = Math.min(levelRates.length, maxDepth);
  const chain = ancestors.slice(0, depthLimit);

  for (let i = 0; i < chain.length; i++) {
    const nodeId = chain[i].id;
    // 受益节点侧条件不满足 → 该层不发放；层号由链位置决定，不因跳过而前移。
    if (nodeFilter && !nodeFilter(chain[i], i + 1)) continue;
    const rate = levelRates[i];
    if (Decimal.lte(rate, "0")) continue;

    const amount = Decimal.pct(eventValue, rate);
    if (Decimal.lte(amount, "0")) continue;

    records.push({
      nodeId,
      rewardId: rewardDef.rewardId,
      rewardType: "LEVEL",
      amount,
      // 按层固定比例下不存在水位，本层的有效发放比例即 rate；
      // 保持 amount = eventValue × diffRate 的对账不变量与水位差口径一致。
      previousRate: "0",
      currentRate: rate,
      diffRate: rate,
      snapshot: {
        rewardId: rewardDef.rewardId,
        rewardType: "LEVEL",
        // mode 区分两套链式口径，供落库与对账辨识（水位差记录无此字段）。
        mode: "LEVEL_RATES",
        ancestorNodeId: nodeId,
        previousRate: "0",
        currentRate: rate,
        diffRate: rate,
        rate,
        depth: i + 1,
        accumulateInChain: false,
      },
    });
  }

  return records;
}

/**
 * 通用 LEVEL 链式计算（纯计算）
 *
 * 水位差口径示例：eventValue=1000，祖先链 rankRate 为 15/30/60：
 * - 祖先1 拿 1000×15%=150，水位升至 15%；
 * - 祖先2 只得 1000×(30%-15%)=150，水位升至 30%；
 * - 祖先3 只得 1000×(60%-30%)=300，水位升至 60%。
 *
 * 按层固定比例口径示例：eventValue=1000，levelRates=["10","5","3"]：
 * - 祖先1 拿 100、祖先2 拿 50、祖先3 拿 30，第 4 层及以后不发（比例表已用尽）。
 *
 * @param {Object} params
 * @param {Object} params.rewardDef - RewardDef { rewardId, type:"LEVEL", accumulateInChain, maxDepth?, levelRates? }
 *        maxDepth：链式发放层数上限（>=1 的整数），按**祖先链位置**计数（第 1 层 = 最近的祖先），
 *        与该层是否实际发放无关 —— 被 diffRate<=0 跳过的层同样占一层。省略 = 不限层数。
 *        非法值抛错，不静默忽略。
 *        levelRates：按层固定比例表（百分比整数数组，索引 0 = 最近的祖先）。配置后改走
 *        「每层各拿自己的固定比例」口径，不读 rankRate、不推进水位；与 accumulateInChain=true
 *        互斥（抛错）。有效层数 = min(levelRates.length, maxDepth)。
 * @param {string} params.eventValue - 事件数值（decimal string）
 * @param {Array<Object>} params.ancestors - 祖先链，按近到远排序，每个元素 { id, rankRate }
 * @param {Function} [params.nodeFilter] - 可选的逐层节点过滤器 `(node, depth) => boolean`，
 *        返回 false 的层不发放。用于「受益节点侧条件」（rewardDef.conditions 里
 *        source:"target" 的条件，由 reward-distributor 注入）。被过滤掉的层**不推进水位**、
 *        也不改变其余层的层号 —— 与 diffRate<=0 跳过完全同一口径。省略 = 全部层参与。
 * @returns {Array<Object>} 通用候选记录列表
 */
function calculateLevelChain({ rewardDef, eventValue = "0", ancestors = [], nodeFilter = null }) {
  const records = [];
  // waterLevel 是"已发链式水位"（百分比整数）：每个祖先只能领取自己比例高于水位的差额，
  // 避免每层祖先都按自己的完整比例重复领取。
  let waterLevel = "0";
  const maxDepth = _resolveMaxDepth(rewardDef?.maxDepth);
  const levelRates = _resolveLevelRates(rewardDef);
  if (levelRates) {
    return _calculateByLevelRates({ rewardDef, eventValue, ancestors, levelRates, maxDepth, nodeFilter });
  }
  // 按链位置截断：超过 maxDepth 层的祖先完全不参与计算（也不推进水位）。
  const chain = maxDepth === Infinity ? ancestors : ancestors.slice(0, maxDepth);

  for (let i = 0; i < chain.length; i++) {
    const ancestor = chain[i];
    const nodeId = ancestor.id;
    // 受益节点侧条件不满足 → 该层不发放，且不推进水位（与 diffRate<=0 同一口径）：
    // 若此处推进水位，被条件挡掉的层会把水位抬高、连带削减上方层的差额（少发），
    // 那是"条件影响了别人的钱"，不是该条件的语义。
    if (nodeFilter && !nodeFilter(ancestor, i + 1)) continue;
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
        // depth 为该记录在祖先链上的层号（1 = 最近的祖先），便于对账与深度风控回溯。
        depth: i + 1,
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
