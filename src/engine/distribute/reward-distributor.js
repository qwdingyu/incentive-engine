/**
 * 奖励分配器 — 通用分发入口（领域无关，纯计算，无外部依赖）
 *
 * 遍历 RewardDef 列表驱动分配，引擎不认识任何业务词（直推/极差/佣金/返利
 * 是上层把业务规则翻译成 rewardDefs 配置后的结果）：
 * - DIRECT + target=SOURCE   → 事件来源节点自身（如"本人收益 100%"）
 * - DIRECT + target=PARENT   → 直接上级（如"一级分销佣金 10%"）
 * - DIRECT + target=ANCESTOR → 祖先链第 ancestorLevel 层这一个节点（定点单层发放）
 * - FIXED                    → 固定金额（DIRECT 的按比例版，金额与事件值无关；target 同 DIRECT）
 * - CUSTOM                   → 固定金额常量 + 可选动态取数（amount / amountFrom；target 同 DIRECT）
 * - LEVEL                    → 链式分配（水位差 = 极差/多级团队佣金；配置 levelRates 则为按层固定比例）
 *
 * 具体业务的候选构造由适配层完成，参考 src/adapters/customer-adapter-template.js。
 *
 * @version 2.5.0
 */

const Decimal = require("../../decimal");
const { calculateDirect, calculateFixed, calculateCustom, resolveCustomAmount } = require("./direct-calculator");
const { calculateLevelChain } = require("./chain-calculator");
const { evaluateCondition } = require("../evaluate/condition-evaluator");

/**
 * 把 rewardDef.conditions 归一为一棵可求值的条件树
 *
 * 兼容两种历史格式：纯 COMPARE 数组（包装为 AND）；单个复合条件（AND/OR/NOT）直接用。
 *
 * @private
 * @param {Array<Object>|undefined} conditions
 * @returns {Object|null} 条件树；未配置条件返回 null（= 无条件，发放）
 */
function _buildConditionTree(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return null;
  if (conditions.length === 1 && conditions[0].type) return conditions[0];
  return {
    type: "AND",
    children: conditions.map((c) => (c.type ? c : { type: "COMPARE", ...c })),
  };
}

/**
 * 递归判断条件（子）树里是否存在受益节点侧条件（source: "target"）
 *
 * @private
 * @param {Object} node - 条件节点
 * @returns {boolean}
 */
function _treeHasTargetSource(node) {
  if (!node || typeof node !== "object") return false;
  if (node.source === "target") return true;
  return Array.isArray(node.children) && node.children.some(_treeHasTargetSource);
}

/**
 * 该奖励定义是否含受益节点侧条件（决定走"逐受益人求值"还是"整条奖励一次求值"）
 *
 * @private
 * @param {Object} def - RewardDef { conditions? }
 * @returns {boolean}
 */
function _hasTargetCondition(def) {
  const conditions = def.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  return conditions.some(_treeHasTargetSource);
}

/**
 * 评估奖励定义的条件（rewardDef.conditions），不满足则跳过该奖励
 *
 * 默认数据源 = 事件对象（event 含 attrs），与 condition-evaluator._resolveField 的
 * attrs 回退兼容（如 `{ field: "orderAmount", operator: "GTE", value: 1000 }`
 * 会读取 event.attrs.orderAmount）。语义：
 *   - conditions 为空/未配置 → true（发放）
 *   - conditions 配置但数据源无匹配字段 → 字段解析为 0，条件大概率不满足 → false（跳过）
 *
 * 条件可用 `source` 显式选择数据源：`"event"`（事件侧）/ `"target"`（受益节点侧）。
 * 含 `source: "target"` 的条件必须由调用方传入 `context.target`（受益节点对象），
 * 否则 condition-evaluator 抛错 —— 绝不静默按事件求值（那会把门槛悄悄放行 = 超发）。
 *
 * @private
 * @param {Object} def - RewardDef { conditions? }
 * @param {Object} event - EngineEvent { eventValue, attrs? }（默认数据源）
 * @param {Object} [context] - 命名数据源 { event, target }（含 source 的条件用）
 * @returns {boolean} 是否应发放该奖励
 */
function _meetsRewardCondition(def, event, context) {
  const wrapper = _buildConditionTree(def.conditions);
  if (!wrapper) return true;
  return evaluateCondition(wrapper, event, context);
}

/** target 的合法取值（未知值由类型分派分支抛出更精确的错误） */
const KNOWN_TARGETS = Object.freeze(["SOURCE", "PARENT", "ANCESTOR"]);

/**
 * 解析"这条奖励的受益节点"，供受益节点侧条件（source:"target"）求值
 *
 * 三种 target 的缺失语义**有意不同**：
 * - `SOURCE`：事件一定有来源节点，缺的是**节点对象**（宿主没传 sourceNode）→ 抛错。
 *   这是集成缺失而非运行期数据，静默不发会让"配了条件却永远不发"极难发现。
 * - `PARENT` / `ANCESTOR`：无上级 / 链长不足是**运行期网络结构** → 返回 null（不发、不抛错）。
 *
 * @private
 * @param {Object} def - RewardDef { rewardId, target, ancestorLevel? }
 * @param {Object} params - { sourceNode, directParent, ancestors }
 * @returns {Object|null} 受益节点；运行期不存在返回 null
 */
function _resolveGateNode(def, { sourceNode, directParent, ancestors }) {
  if (def.target === "SOURCE") {
    if (!sourceNode) {
      throw new Error(
        `奖励定义 ${def.rewardId} 的 conditions 含受益节点侧条件（source:"target"），` +
        "但 target=\"SOURCE\" 时引擎手上只有 event.sourceNodeId、没有节点对象可求值：" +
        "请给 distributeByDefs 传入 sourceNode（事件来源节点自身）"
      );
    }
    return sourceNode;
  }
  if (def.target === "PARENT") return directParent || null;
  // ANCESTOR：层号非法/缺失会抛错（与分派分支同一实现，语义一致）
  return _pickAncestor(ancestors, _resolveAncestorLevel(def));
}

/**
 * 解析 target=ANCESTOR 的定点层号（ancestorLevel）
 *
 * fail-closed：缺失或非法一律抛错，绝不兜底为第 1 层 —— "定点发第几层"
 * 配错等于把钱发给错误的人，静默取默认值比报错危险得多。
 *
 * @private
 * @param {Object} def - RewardDef { rewardId, type, target:"ANCESTOR", ancestorLevel }
 * @returns {number} 层号（>=1 整数，1 = 最近的祖先）
 */
function _resolveAncestorLevel(def) {
  const level = def.ancestorLevel;
  if (level === null || level === undefined || level === "") {
    throw new Error(
      `${def.type} 奖励定义 target="ANCESTOR" 必须声明 ancestorLevel（>=1 整数，1 = 最近的祖先）` +
      `（rewardId=${def.rewardId}）`
    );
  }
  const n = Number(level);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `${def.type} 奖励定义非法 ancestorLevel ${JSON.stringify(level)}（rewardId=${def.rewardId}）` +
      "：必须是 >= 1 的整数（1 = 最近的祖先）"
    );
  }
  return n;
}

/**
 * 取祖先链第 level 层节点（1 = 最近的祖先）
 *
 * 链长不足时返回 null → 调用方不产生记录。这是**运行期数据**而非配置错误
 * （链路深浅由事件当时的网络结构决定），因此不抛错，方向上属于少发（fail-safe）。
 *
 * @private
 * @param {Array<Object>} ancestors - 祖先链（近到远）
 * @param {number} level - 层号（>=1）
 * @returns {Object|null} 该层节点；不存在返回 null
 */
function _pickAncestor(ancestors, level) {
  const node = Array.isArray(ancestors) ? ancestors[level - 1] : undefined;
  return node && node.id !== undefined && node.id !== null ? node : null;
}

/**
 * 给 ANCESTOR 定点发放记录补上层级溯源字段（返回新对象，不改入参）
 *
 * @private
 * @param {Object} record - 计算器产出的候选记录
 * @param {number} level - 命中的层号
 * @returns {Object} 新记录，snapshot 增加 target/ancestorLevel/depth
 */
function _tagAncestorRecord(record, level) {
  return {
    ...record,
    snapshot: {
      ...record.snapshot,
      target: "ANCESTOR",
      ancestorLevel: level,
      // depth 与 LEVEL 记录同名同义（层号），便于两套原语统一对账。
      depth: level,
    },
  };
}

/**
 * 按奖励定义列表分发事件奖励（通用纯计算）
 *
 * @param {Object} params
 * @param {Object} params.event - EngineEvent { sourceNodeId, eventValue, eventType, eventId, attrs? }
 * @param {Object|null} [params.sourceNode] - 事件来源节点对象 { id, attrs? }；仅当某条奖励
 *        `target:"SOURCE"` 且其 conditions 含受益节点侧条件（source:"target"）时必需，
 *        缺失则抛错（绝不静默按事件求值 —— 那会把门槛悄悄放行 = 超发）。其他情况可省略。
 * @param {Object|null} params.directParent - 直接上级节点 { id, rankRate? }；DIRECT target=PARENT 用
 * @param {Array<Object>} params.ancestors - 祖先链（近到远）；LEVEL 与 target=ANCESTOR 用，每个元素 { id, rankRate }
 * @param {Array<Object>} params.rewardDefs - 奖励定义列表
 *        DIRECT: { rewardId, type:"DIRECT", target:"SOURCE"|"PARENT"|"ANCESTOR", rate, ancestorLevel?, skipRankZero? }
 *        FIXED:  { rewardId, type:"FIXED", target:"SOURCE"|"PARENT"|"ANCESTOR", fixedAmount, ancestorLevel?, skipRankZero? }
 *        CUSTOM: { rewardId, type:"CUSTOM", target:"SOURCE"|"PARENT"|"ANCESTOR", amount?, amountFrom?, ancestorLevel?, skipRankZero? }
 *        LEVEL:  { rewardId, type:"LEVEL", accumulateInChain, maxDepth?, levelRates? }
 *        通用可选字段 conditions：发放门槛条件树；COMPARE 条件可用 `source` 选择数据源 ——
 *        `"event"`（事件侧，如"订单金额 >= 1000 才发"）/ `"target"`（受益节点侧，如
 *        "只给 V2 以上的上级发"、"上级团队业绩满 5 万才发"）。含受益节点侧条件时按
 *        **受益人**逐个求值：LEVEL 逐层求值（不满足的层不发、不推进水位），
 *        单受益人原语解析受益节点后求值（节点运行期不存在 → 不发）。
 * @returns {Array<Object>} 通用候选记录
 *         { nodeId, rewardId, rewardType, amount, previousRate?, currentRate?, diffRate?, snapshot }
 */
function distributeByDefs({ event, sourceNode = null, directParent = null, ancestors = [], rewardDefs = [] }) {
  const records = [];
  const eventValue = event?.eventValue ?? "0";

  for (const def of rewardDefs) {
    if (!def || !def.type) {
      throw new Error(`奖励定义无效: ${JSON.stringify(def)}（必须包含 type 字段）`);
    }
    // 条件里是否有受益节点侧条件（source:"target"）—— 决定求值时机：
    // 无 → 整条奖励一次求值（事件侧，与 3.4.x 完全同一路径，行为逐位不变）；
    // 有 → 必须知道受益节点才能求值，改为"逐受益人求值"（见下）。
    const targetGated = _hasTargetCondition(def);
    // 奖励发放条件评估：conditions 配置且不满足时跳过该奖励（防静默超发，
    // 曾为"配置了但未评估"的资金安全死角，见 engine 3.4.0 修复）
    if (!targetGated) {
      // 默认数据源仍是事件；同时给出 { event } 命名数据源，使显式写
      // source: "event" 的条件同样可求值（未写 source 的条件路径逐位不变）。
      if (!_meetsRewardCondition(def, event, { event })) {
        continue;
      }
    } else if (def.type !== "LEVEL" && KNOWN_TARGETS.includes(def.target)) {
      // 单受益人原语（DIRECT/FIXED/CUSTOM）：先解析受益节点，再对
      // { event, target: node } 求值整棵条件树（事件侧与节点侧条件混在
      // AND/OR/NOT 里也能一次算对，不做按 source 拆树）。
      // LEVEL 的受益人是链上每一层，逐层过滤交给 calculateLevelChain 的 nodeFilter。
      // 未知 target 不在此处处理：交由下方分派分支抛出更精确的"未知 target"错误。
      const gateNode = _resolveGateNode(def, { sourceNode, directParent, ancestors });
      if (gateNode === null) continue; // 运行期无此节点（无上级/链长不足）→ 不发，不抛错
      if (!_meetsRewardCondition(def, event, { event, target: gateNode })) continue;
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
      } else if (def.target === "ANCESTOR") {
        // DIRECT target=ANCESTOR：定点发给祖先链第 ancestorLevel 层这一个节点（不遍历整链）。
        const level = _resolveAncestorLevel(def);
        const r = calculateDirect({ rewardDef: def, eventValue, targetNode: _pickAncestor(ancestors, level) });
        if (r) records.push(_tagAncestorRecord(r, level));
      } else {
        throw new Error(`DIRECT 奖励定义未知 target: "${def.target}"（支持: SOURCE, PARENT, ANCESTOR）`);
      }
    } else if (def.type === "LEVEL") {
      // LEVEL：链式分配（水位差 = 极差/多级团队佣金；levelRates = 按层固定比例）。
      // 含受益节点侧条件时逐层求值：不满足的层不发放、不推进水位、不改变其余层层号。
      records.push(...calculateLevelChain({
        rewardDef: def,
        eventValue,
        ancestors,
        nodeFilter: targetGated
          ? (node) => _meetsRewardCondition(def, event, { event, target: node })
          : null,
      }));
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
      } else if (def.target === "ANCESTOR") {
        // FIXED target=ANCESTOR：定点发给祖先链第 ancestorLevel 层这一个节点。
        const level = _resolveAncestorLevel(def);
        const r = calculateFixed({ rewardDef: def, targetNode: _pickAncestor(ancestors, level) });
        if (r) records.push(_tagAncestorRecord(r, level));
      } else {
        throw new Error(`FIXED 奖励定义未知 target: "${def.target}"（支持: SOURCE, PARENT, ANCESTOR）`);
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
      } else if (def.target === "ANCESTOR") {
        // CUSTOM target=ANCESTOR：定点发给祖先链第 ancestorLevel 层这一个节点。
        const level = _resolveAncestorLevel(def);
        const r = calculateCustom({ rewardDef: def, event, targetNode: _pickAncestor(ancestors, level) });
        if (r) records.push(_tagAncestorRecord(r, level));
      } else {
        throw new Error(`CUSTOM 奖励定义未知 target: "${def.target}"（支持: SOURCE, PARENT, ANCESTOR）`);
      }
    } else {
      throw new Error(`未知奖励类型: "${def.type}"（支持: DIRECT, LEVEL, FIXED, CUSTOM）`);
    }
  }

  return records;
}

module.exports = { distributeByDefs };
