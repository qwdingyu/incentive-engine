/**
 * 流水线编排器 — 通用纯编排，无外部依赖
 *
 * v2.2.0 新增 OVER handler：总预算兜底保护，参见 budget-controller.js applyBudgetGuard。
 *
 * v2.1.0 泛化：executePipeline 按 stages 配置顺序执行，共享 context（如封顶水位）。
 * 内置 handler（引擎领域无关）：
 * - RANK：按 rankDefs 评估节点等级，把最优等级的 rankRate 写入节点（grade→rankRate）
 * - DISTRIBUTE：按 rewardDefs 分发（distributeByDefs）
 * - CAP：按 capDefs 封顶裁剪（applyCaps），水位写回 context.capState
 * - SPLIT：按 targets 拆分（splitByTargets）
 * - OVER：总预算兜底保护（applyBudgetGuard），写回 context.overBudgetWarnings
 * - REVERSE：冲正（reverseRecords）—— 已发放收益按比例反向追回，产出负金额记录
 * - CAMPAIGN：活动期加成（applyCampaign）—— 限时活动系数放大金额，汇总写回 context.campaignSummary
 *
 * v2.5.0 新增 CAMPAIGN handler：加成**必须排在 CAP/OVER 之前**（加成后的金额才受封顶约束，
 * 排在之后等于让活动金额绕过日限额），且一条流水线最多一个 CAMPAIGN（多个系数会相乘，
 * 静默数倍超发）。这两条顺序/数量约束由本模块当场抛错保证。
 *
 * v2.4.0 新增 REVERSE handler：冲正与发放在同一次流水线内互斥（正负记录混批会污染
 * 封顶水位并让对账口径不清），因此 REVERSE 与 DISTRIBUTE 不得共存于一条流水线。
 *
 * v2.3.0 新增 RANK handler：把等级评估纳入标准流水线。此前节点 rankRate 需
 * 宿主在调用前预计算；RANK 阶段就地评估 config.nodes 并写入 node.rankRate，
 * 随后的 DISTRIBUTE 即可消费（节点为对象引用，原地写立即可见）。
 *
 * 任意客户通过 stages 配置组合自己的流水线（阶段 + 顺序 + 共享 context）。
 * 本模块不包含任何具体业务：引擎记录 → 业务落账记录的映射由适配层的 buildRecord 完成
 * （见 src/services/generic-settlement.service.js），纯计算示例见 src/adapters/customer-adapter-template.js。
 *
 * @version 2.5.0
 */

const { distributeByDefs } = require("../distribute");
const { getHighestQualifiedTier } = require("../evaluate");
const { applyCaps, applyBudgetGuard, splitByTargets, applyCampaign } = require("../allocate");
const { reverseRecords } = require("../reverse");

/**
 * 执行多阶段流水线（通用纯编排）
 *
 * 阶段间数据传递：每个 stage 接收 prev（上一阶段输出），输出作为下一阶段输入；
 * 最终输出在 results.final。
 *
 * @param {Object} params
 * @param {Array<Object>} params.stages - 阶段定义
 *        { id?, handler: "DISTRIBUTE"|"RANK"|"CAMPAIGN"|"CAP"|"OVER"|"SPLIT"|"REVERSE", config }
 *        - DISTRIBUTE config: { event, sourceNode?, directParent?, ancestors?, rewardDefs, merge? }
 *          sourceNode 仅当某条 target:"SOURCE" 的奖励带受益节点侧条件（conditions 里
 *          source:"target"）时必需 —— 引擎需要节点对象才能求值，缺失时抛错。
 *          merge 仅第 2 个及以后的 DISTRIBUTE 需要，且必填："append"（累加到前序记录）
 *          | "replace"（丢弃前序记录）。缺省抛错，不静默覆盖。
 *        - RANK config:       { nodes, rankDefs, overwrite? }（就地写回 node.rankRate/rankId，本阶段输出 []；
 *          必须排在 DISTRIBUTE 之前，否则抛错）
 *        - CAMPAIGN config:   { campaignDefs, occurredAt }（活动期加成；必须在 DISTRIBUTE 之后、
 *          CAP/OVER 之前；occurredAt 为事件发生时刻，由宿主提供，引擎不取当前时间）
 *        - CAP config:        { capDefs }
 *        - OVER config:       { totalBudget, eventValue, onExceed? }
 *        - SPLIT config:      { totalAmount, targets }（必须是最后一个阶段）
 *        - REVERSE config:    { originalRecords, ratio | (reversalValue + originalEventValue),
 *          reversedMap?, onExceed?, reasonCode? }（冲正，产出负金额记录；与 DISTRIBUTE
 *          在同一条流水线内互斥，且一条流水线最多一个 REVERSE；后面不得接 CAP/OVER）
 * @param {Object} [params.context] - 共享状态（如 { capState: { platformPaid, memberPaid } }）
 * @returns {Object} { results: {阶段id: 输出}, final: 最后阶段输出, context }
 */
function executePipeline({ stages = [], context = {} }) {
  const results = {};
  let current = null;
  // 本次流水线已执行的 DISTRIBUTE 阶段数：第 2 个及以后必须显式声明合并语义，
  // 否则会静默覆盖前序收益记录（资金安全，见下方 merge 处理）。
  let distributeStageCount = 0;
  // 本次流水线已执行的 REVERSE 阶段数：冲正与发放互斥，且冲正最多一个（无合并语义）。
  let reverseStageCount = 0;
  // 本次流水线已执行的 CAMPAIGN 阶段数：多个加成阶段会让系数相乘（数倍超发），最多一个。
  let campaignStageCount = 0;
  // 已执行的裁剪类阶段（CAP/OVER）数：CAMPAIGN 必须排在它们之前，否则加成绕过封顶。
  let clampStageCount = 0;
  // 共享封顶水位：跨阶段/跨调用保持（同一批次内后续记录不会超发）。
  if (!context.capState) {
    context.capState = { platformPaid: "0", memberPaid: new Map() };
  }

  for (const stage of stages) {
    const { id = stage.handler, handler, config = {} } = stage;

    if (handler === "DISTRIBUTE") {
      // 冲正与发放互斥：同一次流水线里既追回又发放，会把正负记录混进同一批产出 ——
      // 落账口径不清，且负记录一旦流入 CAP 会反向推进封顶水位导致后续超发。
      if (reverseStageCount > 0) {
        throw new Error(
          `DISTRIBUTE 阶段 "${id}" 之前已执行过 REVERSE 冲正阶段：` +
          "冲正与发放不能出现在同一条流水线（正负记录混批会污染封顶水位与对账口径）。" +
          "请把冲正与发放拆成两次 executePipeline 调用。"
        );
      }
      distributeStageCount += 1;
      const produced = distributeByDefs({
        event: config.event,
        // sourceNode：事件来源节点对象，仅当某条 target:"SOURCE" 的奖励带受益节点侧
        // 条件（source:"target"）时必需。此处透传，缺省 null 与 3.4.x 行为一致。
        sourceNode: config.sourceNode ?? null,
        directParent: config.directParent ?? null,
        ancestors: config.ancestors ?? [],
        rewardDefs: config.rewardDefs ?? [],
      });
      if (distributeStageCount === 1) {
        current = produced;
      } else {
        // 多个 DISTRIBUTE 阶段的合并语义必须显式声明（fail-closed）：
        // 缺省静默覆盖会让前序阶段产出的收益记录凭空消失，且无任何告警 ——
        // 那是「配了两组奖励却只发一组」的隐性少发，对账时极难定位。
        const merge = config.merge;
        if (merge !== "append" && merge !== "replace") {
          throw new Error(
            `DISTRIBUTE 阶段 "${id}" 是本流水线第 ${distributeStageCount} 个 DISTRIBUTE，` +
            "必须显式声明 config.merge：\"append\"（累加到前序记录，多组奖励并存）" +
            "或 \"replace\"（丢弃前序记录，仅保留本阶段产出）。" +
            "不再提供缺省行为，因为静默覆盖会让前序收益记录无声消失。"
          );
        }
        const prev = Array.isArray(current) ? current : [];
        current = merge === "append" ? [...prev, ...produced] : produced;
      }
    } else if (handler === "RANK") {
      // RANK 必须排在任何产出记录的阶段之前：它的作用是为随后的 DISTRIBUTE 准备
      // node.rankRate，且本阶段输出为空数组。若前序已有记录，继续执行会把那些记录
      // 静默丢弃（零发放），因此直接抛错而不是静默清空（fail-closed）。
      if (Array.isArray(current) && current.length > 0) {
        throw new Error(
          `RANK 阶段 "${id}" 之前已有 ${current.length} 条收益记录（RANK 必须排在 DISTRIBUTE 之前）：` +
          "RANK 的输出为空数组，继续执行会把前序记录静默丢弃导致零发放。请把 RANK 移到 DISTRIBUTE 之前。"
        );
      }
      // RANK：等级评估阶段 —— 对 config.nodes 就地求最高等级，并把该等级的
      // rankRate 写入 node.rankRate（供随后 DISTRIBUTE 消费，节点为对象引用）。
      // 默认不覆盖宿主已预计算的 rankRate（config.overwrite=true 才覆盖）；
      // 未命中任何等级 → rankRate="0"（即最低等级，由 skipRankZero 等语义消费）。
      // 本阶段不产生分发记录，结果置空数组，避免被误当作已分发数据。
      const nodes = config.nodes || [];
      const overwrite = config.overwrite === true;
      // 等级列表按 levelIndex 升序，getHighestQualifiedTier 依赖顺序保留最高等级。
      const rankDefs = (config.rankDefs || []).slice().sort(
        (a, b) => (a.levelIndex ?? 0) - (b.levelIndex ?? 0)
      );
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        // 已有 rankRate 且不覆盖 → 跳过（宿主显式预计算优先）。
        if (!overwrite && node.rankRate !== undefined && node.rankRate !== null) continue;
        const tier = getHighestQualifiedTier(node, rankDefs);
        node.rankRate = String(tier?.rankRate ?? "0");
        if (tier?.rankId) node.rankId = tier.rankId;
      }
      current = [];
    } else if (handler === "REVERSE") {
      // 冲正阶段：把宿主传入的原始发放记录按比例反向追回，产出负金额记录。
      // 三条 fail-closed 约束：
      // 1) 不能与 DISTRIBUTE 共存（正负混批）；2) 前序已有记录时抛错（同上，兼容手工塞入的记录）；
      // 3) 一条流水线最多一个 REVERSE（多个冲正没有 merge 语义，静默覆盖会漏追回）。
      if (distributeStageCount > 0) {
        throw new Error(
          `REVERSE 阶段 "${id}" 之前已执行过 DISTRIBUTE 分发阶段：` +
          "冲正与发放不能出现在同一条流水线（正负记录混批会污染封顶水位与对账口径）。" +
          "请把冲正与发放拆成两次 executePipeline 调用。"
        );
      }
      if (Array.isArray(current) && current.length > 0) {
        throw new Error(
          `REVERSE 阶段 "${id}" 之前已有 ${current.length} 条记录：冲正阶段只接受空前序，` +
          "否则前序记录会被本阶段产出静默覆盖。"
        );
      }
      if (reverseStageCount > 0) {
        throw new Error(
          `REVERSE 阶段 "${id}" 是本流水线第 ${reverseStageCount + 1} 个 REVERSE：` +
          "一条流水线最多一个冲正阶段（多个冲正没有合并语义，后者会静默覆盖前者导致漏追回）。"
        );
      }
      reverseStageCount += 1;
      const reversed = reverseRecords({
        originalRecords: config.originalRecords,
        ratio: config.ratio,
        reversalValue: config.reversalValue,
        originalEventValue: config.originalEventValue,
        reversedMap: config.reversedMap ?? null,
        onExceed: config.onExceed || "CLAMP",
        reasonCode: config.reasonCode ?? null,
      });
      // 冲正汇总写入共享 context，供调用方对账（records 走 current 供后续阶段/最终输出）。
      context.reversalSummary = reversed.summary;
      current = reversed.records;
    } else if (handler === "CAMPAIGN") {
      // 活动期加成阶段：把限时活动系数乘到已产出的收益记录上。三条 fail-closed 约束：
      // 1) 前序必须已有产出阶段（current === null 表示 CAMPAIGN 排在 DISTRIBUTE 之前，
      //    此时无记录可加成，加成会静默失效 → 配置错误，当场抛错）；
      // 2) 必须排在 CAP/OVER 之前 —— 排在之后，加成出来的金额不再受封顶与总预算约束，
      //    「日限额 100」会被 2 倍活动直接放大到 200（最危险的一类顺序错误）；
      // 3) 一条流水线最多一个 CAMPAIGN（两个阶段的系数会相乘，2×2 = 4 倍静默超发）。
      if (current === null) {
        throw new Error(
          `CAMPAIGN 阶段 "${id}" 之前无输入数据（DISTRIBUTE 必须在 CAMPAIGN 之前）：` +
          "加成作用于已产出的收益记录，排在分发之前会静默失效（活动配了却不加成）。"
        );
      }
      if (clampStageCount > 0) {
        throw new Error(
          `CAMPAIGN 阶段 "${id}" 排在 CAP/OVER 之后：加成必须在封顶/预算裁剪之**前**执行，` +
          "否则加成后的金额不再受封顶约束（「日限额 100」会被 2 倍活动放大成 200）。" +
          "请把 CAMPAIGN 移到 DISTRIBUTE 之后、CAP/OVER 之前。"
        );
      }
      if (campaignStageCount > 0) {
        throw new Error(
          `CAMPAIGN 阶段 "${id}" 是本流水线第 ${campaignStageCount + 1} 个 CAMPAIGN：` +
          "一条流水线最多一个活动加成阶段（多个阶段的系数会相乘，2×2 = 4 倍静默超发）。" +
          "多个活动请写在同一个阶段的 campaignDefs 里（引擎会拦截同时命中的重叠活动）。"
        );
      }
      campaignStageCount += 1;
      const boosted = applyCampaign(current, config.campaignDefs ?? [], {
        occurredAt: config.occurredAt,
      });
      // 加成汇总写入共享 context，供调用方对账/日志（哪些活动命中、加成前后总额）。
      context.campaignSummary = boosted.summary;
      current = boosted.records;
    } else if (handler === "CAP") {
      if (current === null) {
        throw new Error("CAP 阶段前无输入数据（DISTRIBUTE 必须在 CAP 之前）");
      }
      clampStageCount += 1;
      current = applyCaps(current, config.capDefs ?? [], context.capState);
    } else if (handler === "OVER") {
      if (current === null) {
        throw new Error("OVER 阶段前无输入数据（DISTRIBUTE 必须在 OVER 之前）");
      }
      clampStageCount += 1;
      // 总预算兜底保护：在 DISTRIBUTE 之后、CAP 之前插入，防止配错比例导致超发。
      current = applyBudgetGuard(current, {
        totalBudget: config.totalBudget,
        eventValue: config.eventValue,
        onExceed: config.onExceed || "CAP",
      }, context);
    } else if (handler === "SPLIT") {
      if (config.totalAmount === undefined || config.totalAmount === null) {
        throw new Error("SPLIT 阶段缺少 totalAmount（独立阶段，需显式传入待拆分金额）");
      }
      // SPLIT 输出 { splits, snapshot } 非记录数组，与后续阶段（CAP）不兼容，
      // 因此 SPLIT 必须是最后一个阶段。若后续还有阶段，提前报错而非静默崩溃。
      const stageIndex = stage.id || stage.handler || "?";
      const remainingStages = stages.slice(stages.indexOf(stage) + 1).filter((s) => s);
      if (remainingStages.length > 0) {
        throw new Error(
          `SPLIT 阶段 "${stageIndex}" 后还有 ${remainingStages.length} 个阶段（${remainingStages.map((s) => s.handler || s.id).join(", ")}），` +
          "SPLIT 必须是最后一个阶段，否则后续阶段会因输入格式不兼容而崩溃"
        );
      }
      current = splitByTargets(config.totalAmount, config.targets);
    } else {
      throw new Error(
        `未知流水线阶段 handler: "${handler}"（支持: DISTRIBUTE, RANK, CAMPAIGN, CAP, OVER, SPLIT, REVERSE）`
      );
    }

    results[id] = current;
  }

  return { results, final: current, context };
}

module.exports = { executePipeline };
