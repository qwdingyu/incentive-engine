/**
 * 激励规则集配置 — joi 校验规则定义（引擎契约）
 *
 * 职责：校验 config_json 的引擎通用原语结构（rewardDefs/rankDefs/capDefs/allocators/pipelineDef），
 * 防止上层写入非法配置导致引擎计算异常。
 *
 * ⚠️ 本模块是工厂函数，需要调用方传入 joi 实例：
 *   const Joi = require("joi");
 *   const { createRuleSetValidation } = require("@usethink/incentive-engine").Validation;
 *   const schemas = createRuleSetValidation(Joi);
 *   const { ruleSetConfigSchema } = schemas;
 * 这样可以避免 joi 跨包版本不一致导致的 "Cannot mix different versions" 错误。
 *
 * @version 4.2.0
 */

const { CAP_SCOPES } = require("../engine/allocate/budget-controller");
const { CAMPAIGN_MULTIPLIER_MAX } = require("../engine/allocate/campaign-multiplier");
const { parseInstant } = require("../utils/instant-window");

/**
 * 创建一组规则集校验 schema
 * @param {Object} Joi - joi 实例（由调用方传入，确保全局唯一）
 * @returns {Object} { ruleSetConfigSchema, engineEventPreviewSchema, ... }
 */
function createRuleSetValidation(Joi) {
  if (!Joi || !Joi.object) {
    throw new Error("createRuleSetValidation 需要有效的 joi 实例作为参数");
  }

  /**
   * 自定义校验的统一失败出口（所有 .custom() 都用它报错）。
   *
   * 为什么不直接 `fail(helpers, msg)`：Joi 把消息字符串当**模板**解析，
   * 消息里一旦出现 `{`（JSON.stringify 出来的对象、示例代码片段如 handler: "CAMPAIGN"），
   * 就会退化成 "Invalid template variable ... Formula missing expected operator" ——
   * 把「配置哪里写错了」的可执行提示替换成一句看不懂的模板语法错误。
   * 用局部变量传值可让任意字符原样出现在 error.message 里。
   *
   * 也不用 `helpers.error("any.custom", { message })`：那样 message 只落在
   * `error.details[0].context.message`，顶层 `error.message` 会是
   * `"xxx" failed custom validation because `（因为空），宿主打日志时信息全丢。
   */
  const fail = (helpers, message) => helpers.message({ custom: "{{#msg}}" }, { msg: message });

  // ==================== 基础校验器 ====================

  const pctRateSchema = Joi.alternatives().try(
    Joi.number().min(0).max(1000).allow(null),
    Joi.string().custom((value, helpers) => {
      const num = Number(value);
      if (isNaN(num) || num < 0 || num > 1000) {
        return helpers.error("number.minMax", { min: 0, max: 1000, value });
      }
      return value;
    }).allow(null, "")
  );

  const nonNegativeSchema = Joi.alternatives().try(
    Joi.number().min(0),
    Joi.string().custom((value, helpers) => {
      const num = Number(value);
      if (isNaN(num) || num < 0) {
        return helpers.error("number.min", { min: 0, value });
      }
      return value;
    }).allow("")
  );

  // levelRates 的单个元素：与 pctRateSchema 同区间，但**不允许 null/空串** ——
  // 比例表里的空洞会让「第 n 层」错位，必须显式写 0 表示该层不发。
  const levelRateItemSchema = Joi.alternatives().try(
    Joi.number().min(0).max(1000),
    Joi.string().custom((value, helpers) => {
      const num = Number(value);
      if (value === "" || isNaN(num) || num < 0 || num > 1000) {
        return helpers.error("number.minMax", { min: 0, max: 1000, value });
      }
      return value;
    })
  );

  // ==================== 条件树校验（conditions） ====================

  /**
   * 构造一棵递归的条件树 schema（COMPARE 原子条件 + AND/OR/NOT 复合条件）
   *
   * 两个刻意的实现选择：
   * 1. 用 `alternatives().conditional(".type")` 而不是 `alternatives().try(...)` ——
   *    try 在两个分支都不匹配时只报 `"does not match any of the allowed types"`，
   *    会把 `source` 拼成 `sources`、operator 写错这类**资金相关**的配置笔误藏起来；
   *    conditional 按 type 精确分派，错误能定位到 `conditions[0].source` 这样的具体字段。
   * 2. 递归用 `Joi.link("#id")` + `.id(id)`（joi 17 的官方递归方案），使
   *    `{ type:"AND", children:[{ type:"OR", children:[...] }] }` 任意深度都被校验，
   *    而不是像旧的 `Joi.array().items(Joi.object())` 那样完全不校验。
   *
   * @private
   * @param {Array<string>} allowedSources - 该场景允许的 COMPARE 数据源
   * @param {string} id - joi link 用的 schema id（同一份配置里必须唯一）
   */
  function buildConditionTreeSchema(allowedSources, id) {
    const compareSchema = Joi.object({
      // type 可省略（历史扁平写法 { field, operator, value } 由引擎补 COMPARE）
      type: Joi.string().valid("COMPARE").optional(),
      field: Joi.string().max(64).required(),
      operator: Joi.string().valid("GTE", "GT", "LTE", "LT", "EQ", "NE").required(),
      value: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
      subKey: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null).optional(),
      source: Joi.string().valid(...allowedSources).optional(),
    });
    const compositeSchema = Joi.object({
      type: Joi.string().valid("AND", "OR", "NOT").required(),
      // min(1)：空 children 的语义在 condition-evaluator 里是 AND→true / OR→false /
      // NOT→true，写空几乎一定是配置漏填，放行等于静默改变门槛方向。
      children: Joi.array().items(Joi.link(`#${id}`)).min(1).required(),
    });
    return Joi.alternatives()
      .conditional(".type", {
        is: Joi.string().valid("AND", "OR", "NOT").required(),
        then: compositeSchema,
        otherwise: compareSchema,
      })
      .id(id);
  }

  // rewardDefs.conditions：事件侧（订单金额等）与受益节点侧（上级等级/业绩等）都可用。
  const rewardConditionTreeSchema = buildConditionTreeSchema(["event", "target"], "rewardCondTree");
  // rankDefs.conditions：等级评估没有事件上下文，只允许 source:"target"。
  // 写 source:"event" 会在 rank-evaluator → condition-evaluator 抛错，必须在校验期拦下，
  // 以维持「校验期通过 ⇒ 计算期不抛错」这条不变量。
  const rankConditionTreeSchema = buildConditionTreeSchema(["target"], "rankCondTree");

  // ==================== 子结构定义 ====================

  const rewardDefSchema = Joi.object({
    rewardId: Joi.string().max(64).required(),
    type: Joi.string().valid("DIRECT", "LEVEL", "FIXED", "CUSTOM").required(),
    rate: pctRateSchema,
    fixedAmount: nonNegativeSchema,
    amount: nonNegativeSchema,
    amountFrom: Joi.string().max(128).optional(),
    // target 的合法取值。注意：type=LEVEL 不允许 ANCESTOR 的约束**不能**写成
    // .when("type", { is:"LEVEL", then: Joi.valid("SOURCE","PARENT") }) ——
    // Joi 的 valid 列表在 concat 时取并集（且 valids 命中即短路，invalid 也拦不住），
    // ANCESTOR 会被并回来。该约束由 validateLevelTarget 交叉校验实现。
    target: Joi.string().valid("SOURCE", "PARENT", "ANCESTOR").optional(),
    // ancestorLevel：target=ANCESTOR 的定点层号（>=1 整数，1 = 最近的祖先）。
    // 仅在 target=ANCESTOR 时有意义 —— 挂在 SOURCE/PARENT 上不会生效，
    // 会让配置方误以为发的是某一层（fail-closed，见 maxDepth/levelRates 同类约束）。
    ancestorLevel: Joi.number().integer().min(1).allow(null).optional()
      .when("target", {
        not: "ANCESTOR",
        then: Joi.valid(null).messages({
          "any.only": "ancestorLevel 仅适用于 target=ANCESTOR 的奖励定义（其它 target 不按层寻址，配置 ancestorLevel 不会生效）",
        }),
      }),
    skipRankZero: Joi.boolean().optional(),
    accumulateInChain: Joi.boolean().optional(),
    // maxDepth：LEVEL 链式发放层数上限（>=1 整数）。仅对 LEVEL 有意义 ——
    // 挂在其它类型上会让配置方误以为深度受限，故显式禁止（fail-closed）。
    maxDepth: Joi.number().integer().min(1).allow(null).optional()
      .when("type", {
        not: "LEVEL",
        then: Joi.valid(null).messages({
          "any.only": "maxDepth 仅适用于 type=LEVEL 的奖励定义（其它类型不沿祖先链发放，配置 maxDepth 不会生效）",
        }),
      }),
    allocatorId: Joi.string().max(64).allow(null).optional(),
    // conditions：发放门槛条件树（3.4.x 之前完全不校验，导致 source 拼错、
    // operator 写错这类资金相关笔误直到运行期才暴露；4.0.0 起按条件树严格校验）。
    conditions: Joi.array().items(rewardConditionTreeSchema).optional(),
    metadata: Joi.object().optional(),
    // levelRates：LEVEL 按层固定比例表（索引 0 = 最近的祖先）。仅对 LEVEL 有意义 ——
    // 挂在其它类型上不会生效，等于让配置方误以为已配置多级比例（fail-closed）。
    levelRates: Joi.array().items(levelRateItemSchema).min(1).allow(null).optional()
      .when("type", {
        not: "LEVEL",
        then: Joi.valid(null).messages({
          "any.only": "levelRates 仅适用于 type=LEVEL 的奖励定义（其它类型不沿祖先链发放，配置 levelRates 不会生效）",
        }),
      }),
  }).custom(validateRewardAmount, "FIXED/CUSTOM 金额交叉校验")
    .custom(validateLevelRates, "LEVEL levelRates 交叉校验")
    .custom(validateAncestorTarget, "ANCESTOR 定点层号交叉校验")
    .custom(validateLevelTarget, "LEVEL 不支持 ANCESTOR 交叉校验");

  // 扁平 COMPARE 条件 schema（公开导出，供宿主单独校验单条条件用）。
  // 注意：rankDefs.conditions 已改用递归条件树 rankConditionTreeSchema（严格超集），
  // 本 schema 保留是为了不破坏已在使用它的宿主代码。
  const conditionSchema = Joi.object({
    field: Joi.string().max(64).required(),
    operator: Joi.string().valid("GTE", "GT", "LTE", "LT", "EQ", "NE").required(),
    value: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
    subKey: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null).optional(),
    // 等级评估的数据源就是被评估节点本身，因此只允许 target（与 rankConditionTreeSchema 一致）
    source: Joi.string().valid("target").optional(),
  });

  // 等级晋升条件校验（P0-2 资金安全，fail-closed）：
  // levelIndex > 0 的等级若既无 conditions、也无 metadata/遗留 min_* 晋升门槛，
  // 且有关联分成比例（rankRate > 0），配置在【校验期】即报错 —— 这种「无门槛 +
  // 会发钱」的等级会让所有节点直接命中、顶格分成比例（超发）。
  // 但若 rankRate 为 0 或未定义（无分成比例），等级命中本身不直接发钱，
  // 非单调等级设计（如 V3 无条件但 levelIndex 更高）是合法业务模式，允许通过。
  // 判定逻辑与 rank-evaluator.evaluateTier 的 hasAnyLegacyGate + rankRate 判定严格一致，
  // 保证「校验期通过 ⇒ 求值期存在实际门槛或不分钱」。
  function validateRankConditions(value, helpers) {
    if (value.levelIndex > 0) {
      const hasConditions = Array.isArray(value.conditions) && value.conditions.length > 0;
      const metadata = value.metadata || {};
      const minDirectCount = metadata.minDirectCount ?? value.min_direct_count ?? 0;
      const minTeamPerformance = metadata.minTeamPerformance ?? value.min_team_performance ?? "0";
      const minHigherTierCount = metadata.minHigherTierCount ?? value.min_higher_tier_count ?? 0;
      const hasAnyLegacyGate =
        minDirectCount > 0 ||
        minTeamPerformance > 0 ||
        minHigherTierCount > 0;
      if (!hasConditions && !hasAnyLegacyGate) {
        // 无门槛等级：仅当有关联分成比例（rankRate > 0）时校验期报错，
        // 否则只是等级提升（不发钱），非单调设计是合法业务模式。
        const rankRate = metadata.rankRate ?? value.rankRate ?? value.rank_rate ?? "0";
        if (Number(rankRate) > 0) {
          return fail(helpers, 
            `等级 ${value.rankId} (levelIndex=${value.levelIndex}) 无晋升门槛但 rankRate>0，会全员顶格分成` +
            "（P0-2 资金安全：请补充 conditions 或 metadata.min* 门槛，或将 rankRate 置 0）"
          );
        }
      }
    }
    return value;
  }

  const rankDefSchema = Joi.object({
    rankId: Joi.string().max(64).required(),
    levelIndex: Joi.number().integer().min(0).required(),
    // 等级关联的分成比例（百分比整数）：RANK 阶段命中该等级时写入节点 rankRate。
    rankRate: pctRateSchema,
    conditions: Joi.array().items(rankConditionTreeSchema).optional(),
    metadata: Joi.object().optional(),
  }).custom(validateRankConditions, "等级晋升条件校验（P0-2 fail-closed）");

  // 封顶 scope 枚举直接引用引擎侧的 CAP_SCOPES（8 个：PLATFORM/PER_USER × DAILY/WEEKLY/MONTHLY/TOTAL），
  // 避免校验层与计算层各自硬编码枚举而漂移（漂移方向：校验放行了引擎不认的 scope → 计算期抛错；
  // 或校验拦下引擎已支持的 scope → 配不上新周期）。
  const capDefSchema = Joi.object({
    capId: Joi.string().max(64).required(),
    scope: Joi.string().valid(...CAP_SCOPES).required(),
    limit: nonNegativeSchema.required(),
    onExceed: Joi.string().valid("REJECT", "ALERT_ONLY").default("REJECT").optional(),
  });

  // ==================== 时间窗口（生效期 / 活动期）====================

  // 绝对时刻校验直接复用 Utils.parseInstant（与运行期同源）：只接受 Date 实例或
  // **带偏移量**的 ISO-8601 字符串。不带偏移的 "2026-11-11T00:00:00" 会按进程本地
  // 时区解析、纯日期 "2026-11-11" 会按 UTC 解析 —— 同一份配置在不同环境下实际生效
  // 时刻相差数小时，对活动加成来说就是提前/延后开始翻倍（资金事故），因此配置期即拒绝。
  // 注意：**不能**用 Joi.date()/Joi.alternatives().try(Joi.date(), ...) —— joi 的 date 类型会把
  // "2026-11-11T00:00:00" 这类无偏移字符串**先强制转换成 Date** 再交给 custom，
  // 于是最该拦下的歧义写法反而校验通过（实测如此）。这里用 Joi.any() 拿到原始值，
  // 类型判定完全交给 parseInstant（与运行期同一函数）。
  const instantSchema = Joi.any()
    .custom((value, helpers) => {
      try {
        parseInstant("时刻", value);
      } catch (e) {
        return fail(helpers, e.message);
      }
      return value;
    }, "绝对时刻校验（须带时区偏移）");

  /** 时间窗口交叉校验：endAt 必须晚于 startAt（空窗口/反向窗口永不命中 → 整段规则静默失效）。 */
  function validateWindowOrder(label) {
    return (value, helpers) => {
      try {
        const start = parseInstant(`${label}.startAt`, value.startAt);
        const end = parseInstant(`${label}.endAt`, value.endAt);
        if (end <= start) {
          return fail(helpers, `${label} 的 endAt 必须晚于 startAt（当前 startAt=${value.startAt}, endAt=${value.endAt}）：` +
              "空窗口或反向窗口永不命中，会让整段规则静默失效");
        }
      } catch (e) {
        return fail(helpers, e.message);
      }
      return value;
    };
  }

  // 规则集生效期：窗口外的事件一律不发放（少发方向）。startAt/endAt 都必填 ——
  // 只写开始不写结束等于「永久生效」，那正是「双十一规则跑到十二月还在按翻倍发」的成因。
  const effectiveSchema = Joi.object({
    startAt: instantSchema.required(),
    endAt: instantSchema.required(),
  }).custom(validateWindowOrder("effective（规则集生效期）"), "生效期窗口校验");

  // 活动定义：限时加成系数。multiplier 是**倍数**（2 = 翻倍），不是百分比 ——
  // 上限 CAMPAIGN_MULTIPLIER_MAX 与引擎侧同源，防「把 100% 写成 100」放大 100 倍。
  const campaignDefSchema = Joi.object({
    campaignId: Joi.string().max(64).required(),
    startAt: instantSchema.required(),
    endAt: instantSchema.required(),
    multiplier: Joi.alternatives()
      .try(Joi.number(), Joi.string())
      .custom((value, helpers) => {
        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0 || num > CAMPAIGN_MULTIPLIER_MAX) {
          return fail(helpers, `multiplier 必须是 0 < multiplier <= ${CAMPAIGN_MULTIPLIER_MAX} 的倍数（收到 ${JSON.stringify(value)}）：` +
              "2 表示翻倍、1.5 表示 1.5 倍、不加成写 1。它不是百分比，写 100 会把发放额放大 100 倍。");
        }
        return value;
      }, "活动系数校验")
      .required(),
    // rewardIds：限定本活动加成哪些奖励项；省略 = 全部。空数组语义与省略相反（谁都不加成），拒绝。
    rewardIds: Joi.array().items(Joi.string().max(64)).min(1).optional(),
    metadata: Joi.object().optional(),
  }).custom(validateWindowOrder("campaignDef（活动期）"), "活动期窗口校验");

    // 分配器 targets 比例总和校验（P0-3 资金安全）：
  // PERCENTAGE_SPLIT 的 targets ratio 之和必须精确等于 100，否则拆分时
  // 「最后一项补差」会吞掉全部剩余（如 A:30,B:20 → B 实得 70%），直接资金错分。
  // 与 percentage-split-allocator.splitByTargets 的运行时校验一致，配置期即拦截。
  function validateAllocatorRatioSum(value, helpers) {
    if (value.type === "PERCENTAGE_SPLIT" && Array.isArray(value.targets)) {
      const sum = value.targets.reduce((s, t) => s + Number(t.ratio), 0);
      if (sum !== 100) {
        return fail(helpers, `分配器 ${value.allocatorId} 的 targets ratio 之和必须为 100，当前=${sum}`);
      }
    }
    return value;
  }

  const allocatorSchema = Joi.object({
    allocatorId: Joi.string().max(64).required(),
    type: Joi.string().valid("PERCENTAGE_SPLIT").required(),
    targets: Joi.array().items(Joi.object({
      target: Joi.string().max(64).required(),
      ratio: nonNegativeSchema.required(),
    })).min(1).required(),
  }).custom(validateAllocatorRatioSum, "分配器 targets 比例总和校验（P0-3）");

  const pipelineStageConfigSchema = Joi.object({
    totalBudget: Joi.alternatives()
      .try(Joi.number().min(1).max(1000), Joi.string().custom((value, helpers) => {
        const num = Number(value);
        if (isNaN(num) || num < 1 || num > 1000) {
          return helpers.error("number.minMax", { min: 1, max: 1000, value });
        }
        return value;
      }).allow(""))
      .optional(),
    onExceed: Joi.string().valid("CAP", "WARN", "REJECT").optional(),
  }).unknown(true);

  const pipelineStageSchema = Joi.object({
    id: Joi.string().max(64).optional(),
    // 注意：REVERSE（冲正）**故意不在白名单内** —— 冲正需要运行期的原始收益记录
    // （宿主查库还原），无法由静态规则集声明；若允许声明，装配出的 REVERSE 阶段
    // 必然缺 originalRecords 而在计算期抛错。冲正走 Services 的 reverse() 入口或
    // 直接调用 Reverse.reverseRecords / Orchestrate 的 REVERSE 阶段（运行期传入数据）。
    handler: Joi.string().valid("DISTRIBUTE", "CAMPAIGN", "CAP", "OVER", "SPLIT", "RANK").required().messages({
      "any.only":
        "流水线阶段 handler 必须是 DISTRIBUTE / RANK / CAMPAIGN / CAP / OVER / SPLIT 之一。" +
        "REVERSE（冲正）不能在规则集里声明：它需要运行期的原始收益记录，" +
        "请改用 Services.GenericSettlementService#reverse 或运行期调用 Reverse.reverseRecords。",
    }),
    config: pipelineStageConfigSchema.optional(),
  });

  const pipelineDefSchema = Joi.object({
    stages: Joi.array().items(pipelineStageSchema).min(1).required(),
  });

  // ==================== 唯一性/交叉校验器 ====================

  /**
   * FIXED / CUSTOM 类型交叉校验：
   * - FIXED：必须提供大于 0 的 fixedAmount（防止只写 rate 不写 fixedAmount，导致引擎静默不发奖）。
   * - CUSTOM：必须提供大于 0 的 amount 或有效的 amountFrom（动态取数路径）至少其一；
   *   amountFrom 仅支持 "eventValue" 与 "event.attrs.<path>"。防止配置了 CUSTOM 却
   *   没有金额来源，导致引擎静默跳过（配置错误而非规则设计如此）。
   */
  function validateRewardAmount(value, helpers) {
    if (value.type === "FIXED") {
      const fa = value.fixedAmount;
      const ok = fa !== undefined && fa !== null && fa !== "" && Number(fa) > 0;
      if (!ok) {
        return fail(helpers, `FIXED 奖励类型必须提供大于 0 的 fixedAmount（rewardId=${value.rewardId}）`);
      }
    }
    if (value.type === "CUSTOM") {
      const hasAmount = value.amount !== undefined && value.amount !== null && value.amount !== "" && Number(value.amount) > 0;
      const hasAmountFrom = typeof value.amountFrom === "string" && value.amountFrom.length > 0;
      if (!hasAmount && !hasAmountFrom) {
        return fail(helpers, `CUSTOM 奖励类型必须提供大于 0 的 amount 或有效的 amountFrom（rewardId=${value.rewardId}）`);
      }
      if (value.amountFrom && value.amountFrom !== "eventValue" && !value.amountFrom.startsWith("event.attrs.")) {
        return fail(helpers, `CUSTOM amountFrom 仅支持 "eventValue" 或 "event.attrs.<path>"（rewardId=${value.rewardId}）`);
      }
    }
    return value;
  }

  // levelRates 交叉校验（资金安全，fail-closed）：与计算层 _resolveLevelRates 的判定一致，
  // 保证「校验期通过 ⇒ 计算期不会因 levelRates 抛错」。
  // - 全 0 的比例表 = 静默零发放（配了多级比例却一分不发），通常是漏填；
  // - 与 accumulateInChain=true 并存 = 水位差与按层固定比例两套口径冲突，发放总额不同。
  function validateLevelRates(value, helpers) {
    const rates = value.levelRates;
    if (rates === undefined || rates === null) return value;
    if (value.accumulateInChain === true) {
      return fail(helpers, `levelRates 与 accumulateInChain=true 互斥（rewardId=${value.rewardId}）：` +
          "levelRates 是每层各拿固定比例，水位差是每层拿高于下方水位的差额，两者发放总额不同");
    }
    if (!rates.some((r) => Number(r) > 0)) {
      return fail(helpers, `levelRates 全部为 0，任何一层都发不出金额（rewardId=${value.rewardId}）：` +
          "若确实不想发放请移除该奖励定义，而不是把比例全置 0");
    }
    return value;
  }

  // target=ANCESTOR 必须声明 ancestorLevel（fail-closed）：
  // 「定点发第几层」漏配时计算期会抛错，这里提前到校验期拦住 ——
  // 保持「校验期通过 ⇒ 计算期不因 ancestorLevel 抛错」。
  function validateAncestorTarget(value, helpers) {
    if (value.target !== "ANCESTOR") return value;
    const level = value.ancestorLevel;
    if (level === null || level === undefined || level === "") {
      return fail(helpers, `target=ANCESTOR 必须声明 ancestorLevel（rewardId=${value.rewardId}）：` +
          "定点层号（>=1 整数，1 = 最近的祖先）漏配等于把钱发给不确定的人，引擎不会兜底取第 1 层");
    }
    return value;
  }

  // type=LEVEL 不支持 target=ANCESTOR（fail-closed）：
  // LEVEL 本身就是遍历整条祖先链，计算层根本不读 target ——
  // 配了 ANCESTOR 会让配置方误以为「只发第 n 层」，实际仍全链发放（超发方向）。
  function validateLevelTarget(value, helpers) {
    if (value.type === "LEVEL" && value.target === "ANCESTOR") {
      return fail(helpers, `type=LEVEL 不支持 target=ANCESTOR（rewardId=${value.rewardId}）：` +
          "LEVEL 本身就是遍历整条祖先链，定点单层发放请改用 " +
          "type=DIRECT/FIXED/CUSTOM + target=ANCESTOR + ancestorLevel");
    }
    return value;
  }

  function validateRewardIdUniqueness(arr, helpers) {
    const ids = arr.map((d) => d.rewardId);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) return fail(helpers, `rewardId ${id} 重复`);
      seen.add(id);
    }
    return arr;
  }

  function validateRankIdUniqueness(arr, helpers) {
    const ids = arr.map((d) => d.rankId);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) return fail(helpers, `rankId ${id} 重复`);
      seen.add(id);
    }
    return arr;
  }

  function validateCapIdUniqueness(arr, helpers) {
    const ids = arr.map((d) => d.capId);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) return fail(helpers, `capId ${id} 重复`);
      seen.add(id);
    }
    return arr;
  }

  function validateCampaignIdUniqueness(arr, helpers) {
    const seen = new Set();
    for (const d of arr) {
      if (seen.has(d.campaignId)) {
        return fail(helpers, `campaignId ${d.campaignId} 重复`);
      }
      seen.add(d.campaignId);
    }
    return arr;
  }

  /**
   * 活动窗口重叠校验（资金安全）：两个活动的时间窗口相交、且加成范围（rewardIds）也相交时，
   * 同一条收益记录会被两个活动同时命中 —— 引擎在运行期会**抛错**（相乘是数倍超发，
   * 静默取一条等于悄悄改钱）。窗口是静态配置，重叠在配置期就能判定，因此提前拦下，
   * 避免把错误留到活动开始那一刻（最不该出问题的时点）才暴露。
   * 判定口径与引擎一致：窗口左闭右开，`a.start < b.end && b.start < a.end` 即相交。
   */
  function validateCampaignOverlap(arr, helpers) {
    const parsed = [];
    for (const d of arr) {
      try {
        parsed.push({
          campaignId: d.campaignId,
          start: parseInstant("startAt", d.startAt),
          end: parseInstant("endAt", d.endAt),
          rewardIds: Array.isArray(d.rewardIds) && d.rewardIds.length > 0 ? new Set(d.rewardIds.map(String)) : null,
        });
      } catch (e) {
        // 时刻本身非法：已由 campaignDefSchema 报错，此处不重复报，直接跳过重叠判定。
        return arr;
      }
    }
    for (let i = 0; i < parsed.length; i += 1) {
      for (let j = i + 1; j < parsed.length; j += 1) {
        const a = parsed[i];
        const b = parsed[j];
        if (!(a.start < b.end && b.start < a.end)) continue;
        // rewardIds 任一为 null（不限定）即视为覆盖全部奖励 → 必然相交。
        const scopeIntersects = !a.rewardIds || !b.rewardIds
          || [...a.rewardIds].some((r) => b.rewardIds.has(r));
        if (!scopeIntersects) continue;
        return fail(helpers, `活动 ${a.campaignId} 与 ${b.campaignId} 的时间窗口重叠且加成范围相交：` +
            "同一条收益记录会被两个活动同时命中，引擎会在运行期抛错（多个系数相乘 = 数倍超发）。" +
            "请错开窗口（左闭右开，相邻窗口可共用同一时刻）或用 rewardIds 把加成范围拆开。");
      }
    }
    return arr;
  }

  /**
   * campaignDefs 与 pipelineDef 的交叉校验（资金安全，两个方向都拦）：
   * - 配了 campaignDefs 却没有 CAMPAIGN 阶段 → 活动完全不生效（静默少发，运营以为在翻倍）；
   * - CAMPAIGN 排在 CAP/OVER 之后 → 加成金额绕过封顶（静默超发）；
   * - CAMPAIGN 排在 DISTRIBUTE 之前或出现多次 → 加成失效 / 系数相乘。
   * 与 Orchestrate.executePipeline 的运行期约束同源，在配置期即给出可执行的错误。
   */
  function validateCampaignPipeline(value, helpers) {
    const stages = value.pipelineDef?.stages;
    const hasCampaignDefs = Array.isArray(value.campaignDefs) && value.campaignDefs.length > 0;
    if (!Array.isArray(stages)) {
      // 未声明 pipelineDef：适配层缺省流水线会在存在 campaignDefs 时自动插入 CAMPAIGN
      // （DISTRIBUTE → CAMPAIGN → CAP），无需在此校验顺序。
      return value;
    }
    const handlers = stages.map((st) => st && st.handler);
    const campaignIdx = handlers.indexOf("CAMPAIGN");
    if (hasCampaignDefs && campaignIdx === -1) {
      return fail(helpers, "配置了 campaignDefs（活动加成）但 pipelineDef.stages 里没有 CAMPAIGN 阶段：" +
          "活动系数不会生效（静默按原比例发放）。请在 DISTRIBUTE 之后、CAP/OVER 之前加入 { handler: \"CAMPAIGN\" }。");
    }
    if (campaignIdx === -1) return value;
    if (handlers.lastIndexOf("CAMPAIGN") !== campaignIdx) {
      return fail(helpers, "pipelineDef.stages 里出现了多个 CAMPAIGN 阶段：多个阶段的系数会相乘（2×2 = 4 倍超发）。" +
          "多个活动请写在同一个 campaignDefs 列表里。");
    }
    const distributeIdx = handlers.indexOf("DISTRIBUTE");
    if (distributeIdx === -1 || distributeIdx > campaignIdx) {
      return fail(helpers, "CAMPAIGN 阶段必须排在 DISTRIBUTE 之后：加成作用于已产出的收益记录，" +
          "排在分发之前会静默失效（活动配了却不加成）。");
    }
    const clampIdx = handlers.findIndex((h) => h === "CAP" || h === "OVER");
    if (clampIdx !== -1 && clampIdx < campaignIdx) {
      return fail(helpers, `CAMPAIGN 阶段排在 ${handlers[clampIdx]} 之后：加成必须在封顶/预算裁剪之前执行，` +
          "否则加成后的金额不再受封顶约束（「日限额 100」会被 2 倍活动放大成 200）。");
    }
    return value;
  }

  // ==================== 完整规则集配置 Schema ====================

  const ruleSetConfigSchema = Joi.object({
    rewardDefs: Joi.array().items(rewardDefSchema).min(1).required()
      .custom(validateRewardIdUniqueness, "rewardId 唯一性校验"),
    rankDefs: Joi.array().items(rankDefSchema).min(1).required()
      .custom(validateRankIdUniqueness, "rankId 唯一性校验"),
    capDefs: Joi.array().items(capDefSchema).optional()
      .custom(validateCapIdUniqueness, "capId 唯一性校验"),
    allocators: Joi.array().items(allocatorSchema).optional(),
    // 活动期加成（限时系数）。窗口重叠 + 与 pipelineDef 的顺序关系见下方两个交叉校验。
    campaignDefs: Joi.array().items(campaignDefSchema).optional()
      .custom(validateCampaignIdUniqueness, "campaignId 唯一性校验")
      .custom(validateCampaignOverlap, "活动窗口重叠校验（资金安全）"),
    // 规则集生效期：事件发生时刻落在窗口外时，Services 层拒绝结算（少发方向）。
    effective: effectiveSchema.optional(),
    pipelineDef: pipelineDefSchema.optional(),
  }).required()
    .custom(validateCampaignPipeline, "campaignDefs 与 pipelineDef 交叉校验（资金安全）");

  // ==================== 引擎事件预览 Schema ====================

  // 预览用节点：id + 可选 rankRate + 可选 attrs。
  // attrs 是受益节点侧条件（conditions 的 source:"target"）的取值来源
  // （condition-evaluator 对 attrs 优先），预览时必须能传，否则节点侧门槛无法试算。
  const previewNodeSchema = Joi.object({
    id: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
    rankRate: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
    attrs: Joi.object().optional(),
  });

  const engineEventPreviewSchema = Joi.object({
    event: Joi.object({
      sourceNodeId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
      eventType: Joi.string().max(64).optional(),
      eventValue: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
      eventId: Joi.string().max(64).allow(null).optional(),
      attrs: Joi.object().optional(),
    }).required(),
    // sourceNode：事件来源节点对象，仅 target:"SOURCE" + 受益节点侧条件时必需。
    sourceNode: previewNodeSchema.allow(null).optional(),
    directParent: previewNodeSchema.allow(null).optional(),
    ancestors: Joi.array().items(previewNodeSchema).optional(),
    capState: Joi.object({
      platformPaid: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
      memberPaid: Joi.object().pattern(
        Joi.alternatives(),
        Joi.alternatives().try(Joi.string(), Joi.number())
      ).optional(),
    }).allow(null).optional(),
  });

  return {
    pctRateSchema,
    nonNegativeSchema,
    rewardDefSchema,
    conditionSchema,
    rewardConditionTreeSchema,
    rankConditionTreeSchema,
    rankDefSchema,
    capDefSchema,
    instantSchema,
    effectiveSchema,
    campaignDefSchema,
    allocatorSchema,
    pipelineStageConfigSchema,
    pipelineStageSchema,
    pipelineDefSchema,
    ruleSetConfigSchema,
    validateRewardIdUniqueness,
    validateRankIdUniqueness,
    validateCapIdUniqueness,
    validateCampaignIdUniqueness,
    engineEventPreviewSchema,
  };
}

const { validateCustomerConfig } = require("./customer-config");

/**
 * 引擎配置字段键名常量（单一事实来源）
 *
 * 供消费方（rbb 等）引用，避免手写字段名与引擎漂移。
 * 消费方 `_computeDiff` 的 rewardDefs/rankDefs/capDefs 归类键应引用此常量，
 * 而非手写 `rewardId`/`rankId`/`capId` 字面量。
 *
 * @type {Object}
 * @property {string} REWARD_ID - rewardDef 唯一标识字段名
 * @property {string} RANK_ID - rankDef 唯一标识字段名
 * @property {string} CAP_ID - capDef 唯一标识字段名
 * @property {string} TYPE - 奖励类型字段名
 * @property {string} TARGET - 奖励目标字段名
 * @property {string} RATE - 比例字段名
 * @property {string} FIXED_AMOUNT - 固定金额字段名
 * @property {string} AMOUNT - CUSTOM 金额字段名
 * @property {string} AMOUNT_FROM - CUSTOM 动态取数路径字段名
 * @property {string} LEVEL_INDEX - 等级索引字段名
 * @property {string} SCOPE - 封顶范围字段名
 * @property {string} LIMIT - 封顶限额字段名
 * @property {string} CAMPAIGN_ID - 活动定义唯一标识字段名
 * @property {string} MULTIPLIER - 活动加成系数字段名
 * @property {string} START_AT - 时间窗口开始字段名
 * @property {string} END_AT - 时间窗口结束字段名
 */
const CONFIG_FIELD_KEYS = Object.freeze({
  // 顶层字段名（config_json 的顶层键，供消费方 diff/遍历引用）
  REWARD_DEFS: "rewardDefs",
  RANK_DEFS: "rankDefs",
  CAP_DEFS: "capDefs",
  ALLOCATORS: "allocators",
  CAMPAIGN_DEFS: "campaignDefs",
  EFFECTIVE: "effective",
  PIPELINE_DEF: "pipelineDef",
  // 子字段名（各 def 内部的键）
  REWARD_ID: "rewardId",
  RANK_ID: "rankId",
  CAP_ID: "capId",
  TYPE: "type",
  TARGET: "target",
  RATE: "rate",
  FIXED_AMOUNT: "fixedAmount",
  AMOUNT: "amount",
  AMOUNT_FROM: "amountFrom",
  MAX_DEPTH: "maxDepth",
  LEVEL_RATES: "levelRates",
  ANCESTOR_LEVEL: "ancestorLevel",
  LEVEL_INDEX: "levelIndex",
  SCOPE: "scope",
  LIMIT: "limit",
  CAMPAIGN_ID: "campaignId",
  MULTIPLIER: "multiplier",
  START_AT: "startAt",
  END_AT: "endAt",
});

module.exports = { createRuleSetValidation, validateCustomerConfig, CONFIG_FIELD_KEYS };


