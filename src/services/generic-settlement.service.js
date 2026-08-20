/**
 * 通用结算服务（引擎框架服务）
 *
 * 职责：为多客户场景提供统一的「业务事件 → 引擎计算 → 幂等落账」通用流程抽象。
 * 每个客户通过配置对象（customer config）声明自身的变体部分：
 *   buildEvent / buildDirectParent / buildAncestors / buildRecord / idempotency / postProcess
 *
 * 此服务消除了 N 个客户产生 N 个 Service 文件时 ~80% 的重复代码。
 *
 * 设计原则：
 * - 配置驱动，非继承：客户配置是纯数据对象，不是类。组合优于继承。
 * - 只抽象 Service 层，不抽象 API 层：路由/控制器/校验 schema 保持客户独立。
 * - 兼容包装：现有客户 Service 可保留并委托给本服务。
 *
 * 依赖注入（通过构造函数 config 传入）：
 * - sequelize：Sequelize 实例（用于事务管理）
 * - ruleSetService：具有 getActiveRuleSet(code, options) 方法的对象
 * - logger（可选）：日志对象，缺省使用 console
 *
 * ⚠️ UniqueConstraintError 仅在构造时懒加载（sequelize 为可选 peer），
 *    不安装 sequelize 时不会因模块级 require 而报错。
 *
 * 对外能力：
 * - settle()               : 自管事务的完整结算（幂等快路径在事务外）
 * - settleWithTransaction(): 委托模式，调用方已持有事务（用于并入更大事务 / 批量）
 * - batchSettle()          : 批量结算，同一事务原子提交
 * - list() / getByWhere()  : 查询能力（getByWhere 拒绝空条件，防止返回任意行）
 *
 * ⚠️ 跨结算周期封顶（scope 以 _WEEKLY / _MONTHLY / _TOTAL 结尾）必须成对配置
 *    loadCapState / saveCapState，否则 _calculate 直接返回 { ok:false }（见 §4.1 注释）。
 *
 * ⚠️ 规则集带时间维度（`effective` 生效期 / `campaignDefs` 活动加成）时，事件必须能取到
 *    **发生时刻**（`buildOccurredAt` 钩子，缺省读 `businessEvent.occurredAt`）。
 *    取不到时 _calculate 返回 { ok:false }：引擎绝不用「当前时间」兜底 —— 结算重试、
 *    补跑昨天的单、对账重算都在窗口之外执行，那会给历史订单套上今天的活动系数（见 §4.0）。
 *
 * @version 3.3.0
 */

const engine = require("../engine");
const { buildPipelineStages } = require("../adapters");
const { normalizePagination, isWithinWindow } = require("../utils");

/** 唯一约束错误类（懒加载），sequelize 为可选 peer */
let _UniqueConstraintError = null;

/** 必填配置项 */
const REQUIRED_CONFIG_KEYS = ["name", "ruleSetCode", "model", "buildEvent", "buildRecord", "idempotency"];

/**
 * 冲正块（config.reversal）的必填子项。
 * 配了 reversal 却缺子项 → 构造期抛错（fail-fast），绝不留到退款回调那一刻才发现。
 */
const REQUIRED_REVERSAL_KEYS = ["loadOriginalRecords", "buildOriginalRecord", "resolveReversal", "buildRecord", "idempotency"];

/**
 * 通用结算服务类
 *
 * @param {Object} config - 客户配置对象
 * @param {string} config.name - 客户名称（日志标识）
 * @param {string} config.ruleSetCode - 默认规则集编码
 * @param {Model} config.model - Sequelize Model（落账表）
 * @param {Function} config.buildEvent - (event) => EngineEvent { sourceNodeId, eventType, eventValue }
 * @param {Function} [config.buildDirectParent] - (event) => { id, rankRate } | null
 * @param {Function} [config.buildAncestors] - (event) => Array<{ id, rankRate }>
 * @param {Function} [config.buildSourceNode] - (event) => { id, attrs? } | null
 *   事件来源节点对象构造钩子（可选）。仅当规则集里存在 target:"SOURCE" 且
 *   conditions 含受益节点侧条件（source:"target"）的奖励时必需 —— 引擎需要节点对象
 *   才能对「本人」求值，缺失会抛错（绝不静默按事件求值，那会把门槛悄悄放行）。
 *   缺省返回 null，与 3.4.x 行为一致。
 * @param {Function} [config.buildOccurredAt] - (event) => Date | string | null
 *   事件**发生时刻**构造钩子（可选）。缺省读 `businessEvent.occurredAt`。
 *   仅当规则集带时间维度（`effective` 生效期 / `campaignDefs` 活动加成）时必需。
 *   只接受 Date 实例或**带时区偏移**的 ISO-8601 字符串（`"2026-11-11T00:00:00+08:00"`）；
 *   不带偏移的字面量会按进程本地时区解析，同一配置在不同环境相差数小时。
 *   ⚠️ 必须是**事件真实发生时刻**（下单/支付时间），不是结算执行时刻 ——
 *   否则补跑历史单会套上今天的活动系数（超发）或错过当时的活动（少发）。
 * @param {Function} config.buildRecord - (businessEvent, engineRecord, extra) => Object | null
 * @param {Object} config.idempotency - 幂等配置
 * @param {Function} config.idempotency.buildPreReadWhere - (event) => where object
 * @param {Function} config.idempotency.buildFallbackWhere - (event) => where object
 * @param {Function} [config.postProcess] - (businessEvent, createdRecords, transaction) => Promise<void>
 * @param {Function} [config.loadCapState] - (options?) => Promise<capState|null>
 *   平台/单用户日封顶水位加载钩子（可选）。
 *   结算前读取当前已发放水位，供 CAP 阶段跨事件累计封顶。
 *   返回 null/undefined 时引擎自建初始水位（与不配置时行为一致，封顶仅限单事件内）。
 *   配置后与 saveCapState 成对使用，才能实现「跨事件平台日封顶」（P0-1 资金安全修复）。
 *   ⚠️ 规则集里存在非 DAILY 周期封顶（`_WEEKLY`/`_MONTHLY`/`_TOTAL`）时**必须**成对配置
 *   本钩子与 saveCapState，否则结算直接返回 `{ success:false }` —— 水位每次从 0 起算的
 *   「月封顶」会退化成「单事件封顶」，跑 100 笔就发 100 倍（虚假额度保证比不配更危险）。
 *   宿主需连同 `capState.periods` 一起持久化/还原（memberPaid 必须还原成 Map）。
 * @param {Function} [config.saveCapState] - (capState, transaction) => Promise<void>
 *   平台/单用户日封顶水位持久化钩子（可选）。
 *   在结算事务内、落账之后调用；与记录共享同一事务，任一步失败即整体回滚，
 *   保证「水位推进」与「收益落账」原子一致，不留半截状态。
 * @param {Object} config.sequelize - Sequelize 实例（必需）
 * @param {Object} config.ruleSetService - 规则集服务（必需，需有 getActiveRuleSet 方法）
 * @param {Object} [config.logger] - 日志对象（可选，缺省使用 console）
 * @param {Object} [config.reversal] - 冲正（退款/撤单追回）配置块（可选）。
 *   不配置时 reverse() 返回 { success: false }，settle 路径完全不受影响。
 * @param {Function} config.reversal.loadOriginalRecords - (businessEvent, { transaction, options }) => Promise<Array<row>>
 *   还原本次冲正对应的**原始发放记录**（宿主查自己的收益表，通常按原订单号）。
 *   在冲正事务内调用 —— 宿主可在此加行锁（如 { lock: transaction.LOCK.UPDATE }）防并发超额追回。
 * @param {Function} config.reversal.buildOriginalRecord - (row, businessEvent) => { recordId, nodeId, amount, rewardId?, rewardType? } | null
 *   把宿主表行映射成引擎口径的原始记录；返回 null 的行被跳过。
 *   recordId 必须是落库主键（引擎用它做「已冲正累计」查找键与对账主键）。
 * @param {Function} config.reversal.resolveReversal - (businessEvent) => { ratio } | { reversalValue, originalEventValue }
 *   本次冲正比例（可另带 onExceed / reasonCode）。**没有缺省值**：引擎绝不默认全额冲正。
 * @param {Function} config.reversal.buildRecord - (businessEvent, reversalRecord, extra) => Object | null
 *   引擎冲正记录 → 落账行。reversalRecord.amount 为**负数**，reversedAmount 为正数绝对值。
 * @param {Object} config.reversal.idempotency - 冲正专属幂等配置（与发放侧独立）：
 *   { buildPreReadWhere, buildFallbackWhere } —— 通常按「退款单号」而非原订单号，
 *   否则同一订单的第二次部分退款会被误判为幂等命中而静默不追回。
 * @param {Function} [config.reversal.loadReversedMap] - (businessEvent, { transaction }) => Promise<Map|Object|null>
 *   recordId → 已冲正累计金额（正数）。**多次部分退款场景必配**：不配时引擎视为全部未冲正，
 *   两次 30% 退款会各按原额 30% 追回（累计可能超过原始发放额）。
 * @param {Function} [config.reversal.postProcess] - (businessEvent, createdRecords, transaction) => Promise<void>
 *   冲正专属后处理钩子（事务内）。**不复用发放侧 postProcess** —— 那会把冲正行当作新增发放
 *   计入宿主的累计/等级/业绩统计，方向上是重复计数。
 * @param {boolean} [config.useBulkCreate=false] - 是否用 model.bulkCreate 批量插入收益记录（可选）。
 *   缺省 false（逐条 model.create，与历史行为一致）。多条记录场景置 true 可把 N 次
 *   DB round-trip 压成 1 次；代价是返回实例的主键回填依赖数据库方言，
 *   若你的 postProcess / 调用方依赖 data.lines 里的自增主键，请先验证后再开启。
 */
class GenericSettlementService {
  constructor(config) {
    const missing = REQUIRED_CONFIG_KEYS.filter((k) => !config[k]);
    if (missing.length) {
      throw new Error(`GenericSettlement 配置缺少必填项: ${missing.join(", ")}`);
    }
    // 客户配置
    this.name = config.name;
    this.ruleSetCode = config.ruleSetCode;
    this.model = config.model;
    this.buildEvent = config.buildEvent;
    this.buildDirectParent = config.buildDirectParent || (() => null);
    this.buildAncestors = config.buildAncestors || (() => []);
    // 事件来源节点对象：仅 target:"SOURCE" + 受益节点侧条件时需要，缺省 null。
    this.buildSourceNode = config.buildSourceNode || (() => null);
    // 事件发生时刻：规则集生效期与活动加成的判定基准。缺省读事件的 occurredAt 字段
    // （宿主可用 buildOccurredAt 指向自己的字段名，如 paid_at / created_at）。
    // 绝不缺省成 new Date()：结算重试/补跑会把「现在」当成事件时刻，直接算错活动窗口。
    this.buildOccurredAt = config.buildOccurredAt || ((event) => (event && event.occurredAt) || null);
    this.buildRecord = config.buildRecord;
    this.idempotency = config.idempotency;
    this.postProcess = config.postProcess || null;
    // 封顶水位钩子（可选，成对使用）：loadCapState 结算前读水位，saveCapState 事务内持久化。
    // 未配置时维持历史行为（每次结算水位从零开始，封顶仅单事件内生效）。
    this.loadCapState = config.loadCapState || null;
    this.saveCapState = config.saveCapState || null;
    // 批量插入开关（P2 性能）：默认 false = 逐条 model.create（保持历史行为不变）。
    // 一次事件产出 N 条收益记录时，逐条 create 就是 N 次 round-trip；深层级链路
    // （10~20 层）下这是结算耗时的主要来源。置 true 改用 model.bulkCreate 一次插入。
    // 之所以不默认开启：bulkCreate 返回实例的主键回填依赖方言
    // （部分方言/配置下 id 不回填），而返回值会经 data.lines 与 postProcess 暴露给宿主 ——
    // 静默改变既有接入方拿到的实例内容属于破坏性变更，必须由宿主确认后显式开启。
    this.useBulkCreate = config.useBulkCreate === true;

    // 冲正块（可选）：配了就必须完整 —— 缺子项在构造期抛错，不留到退款回调时才炸。
    this.reversal = config.reversal || null;
    if (this.reversal) {
      const missingRev = REQUIRED_REVERSAL_KEYS.filter((k) => !this.reversal[k]);
      if (missingRev.length) {
        throw new Error(`GenericSettlement reversal 配置缺少必填项: ${missingRev.join(", ")}`);
      }
      const revIdem = this.reversal.idempotency;
      if (typeof revIdem.buildPreReadWhere !== "function" || typeof revIdem.buildFallbackWhere !== "function") {
        throw new Error("GenericSettlement reversal.idempotency 必须提供 buildPreReadWhere 与 buildFallbackWhere 函数");
      }
    }

    // 引擎依赖注入
    if (!config.sequelize) throw new Error("GenericSettlement 配置缺少必填项: sequelize");
    this.sequelize = config.sequelize;
    if (!config.ruleSetService) throw new Error("GenericSettlement 配置缺少必填项: ruleSetService");
    this.ruleSetService = config.ruleSetService;

    // 日志
    this.log = config.logger || console;

    // 可选：宿主项目注入 sequelize 的 UniqueConstraintError 类。
    // 解决 file:/npm 安装下引擎包内 require("sequelize") 解析不到宿主 node_modules 的问题。
    // 未注入时回退到引擎侧懒加载（sequelize 为可选 peer）。
    this.UniqueConstraintError = config.UniqueConstraintError || null;
  }

  /**
   * 事件守卫（私有，配置驱动）：校验业务事件与幂等键字段。
   *
   * 幂等键必填字段由配置的 buildPreReadWhere 推导——where 中值为 空/undefined/null 的字段即缺失。
   * 目的：防止空键误判幂等（findOne 空条件会返回任意行）、settle(undefined) 的裸 TypeError。
   *
   * @param {Object} businessEvent - 业务事件
   * @param {Object} [idempotency=this.idempotency] - 幂等配置（冲正路径传 reversal.idempotency）
   * @returns {Object} { ok, message? } 校验结果
   */
  _validateEvent(businessEvent, idempotency = this.idempotency) {
    if (!businessEvent || typeof businessEvent !== "object" || Array.isArray(businessEvent)) {
      return { ok: false, message: "业务事件必须是非空对象" };
    }
    // 从幂等键预读条件推导必填字段：where 中的值若为 空/undefined/null 则视为缺失。
    const preReadWhere = idempotency.buildPreReadWhere(businessEvent);
    if (!preReadWhere || typeof preReadWhere !== "object") {
      return { ok: false, message: "幂等键预读条件必须返回非空对象" };
    }
    // 防御：空 where 对象（{}）会导致 findAll({ where: {} }) 返回全表，
    // 所有新事件被误判为幂等命中而静默不落账（资金安全边界）。
    // 幂等键必须至少有一个字段，否则视为配置错误拒绝。
    if (Object.keys(preReadWhere).length === 0) {
      return { ok: false, message: "幂等键预读条件不能为空对象（必须包含至少一个幂等键字段）" };
    }
    // 根据 JSON 序列化字段名占位符判断缺失——未显式传值的字段在实际 Sequelize 查询中会传 undefined。
    const missingKeys = [];
    for (const [key, value] of Object.entries(preReadWhere)) {
      if (value === undefined || value === null || value === "") {
        missingKeys.push(key);
      }
    }
    if (missingKeys.length > 0) {
      return { ok: false, message: `业务事件缺少幂等键字段: ${missingKeys.join(", ")}` };
    }
    return { ok: true };
  }

  /**
   * 自管事务的完整结算（推荐入口）
   *
   * 幂等快路径：在事务外先预读，已有记录则直接返回（避免无意义的事务开销）。
   * 事务路径：预读无记录 → 开启事务 → 计算 → 落账 → 提交。
   * 事务回滚后异常由 _handleSettleError 统一处理（UniqueConstraintError 兜底）。
   *
   * @param {Object} businessEvent - 业务事件
   * @param {Object} [options] - 可选参数
   * @param {string} [options.ruleSetCode] - 覆盖默认规则集编码
   * @param {string} [options.routingKey] - 灰度路由依据
   * @returns {Promise<Object>} { success, data?, message?, idempotent? }
   */
  async settle(businessEvent, options = {}) {
    // 0. 事件守卫
    const validation = this._validateEvent(businessEvent);
    if (!validation.ok) {
      return { success: false, message: validation.message };
    }

    // 1. 幂等快路径（事务外预读）
    const preReadWhere = this.idempotency.buildPreReadWhere(businessEvent);
    const existing = await this.model.findAll({ where: preReadWhere });
    if (existing.length > 0) {
      this.log.info(`幂等命中: ${this.name} 订单 ${businessEvent.orderNo || businessEvent.tradeNo || "?"} 已处理，返回 ${existing.length} 条记录`);
      return { success: true, data: { lines: existing }, idempotent: true };
    }

    // 2. 计算阶段（纯计算，事务外执行）。
    //    规则集加载失败 / 无落账记录时不占用事务，避免无意义的事务开/回滚开销。
    const calcResult = await this._calculate(businessEvent, options);
    if (!calcResult.ok) {
      return { success: false, message: calcResult.message };
    }

    // 3. buildRecord 全部过滤：无落账记录直接返回（不开启事务）。
    if (calcResult.dbRecords.length === 0) {
      this.log.info(`${this.name} 订单 ${businessEvent.orderNo || businessEvent.tradeNo || "?"} 无落账记录（buildRecord 全部过滤）`);
      return { success: true, data: { skipped: true, lines: [] }, idempotent: false };
    }

    // 4. 开启事务 + 落账
    const t = await this.sequelize.transaction();
    try {
      // 5. 落账阶段（事务内）：写收益记录 + 持久化封顶水位（原子提交）。
      const writeResult = await this._writeRecords(businessEvent, calcResult.dbRecords, t, calcResult.capState);
      await t.commit();
      return { success: true, data: writeResult, idempotent: false };
    } catch (err) {
      await t.rollback();
      return this._handleSettleError(err, businessEvent);
    }
  }

  /**
   * 委托模式：调用方已持有事务时的结算（用于并入更大事务 / 批量结算）
   *
   * 与 settle() 差异：
   * - 不自管事务，由调用方负责提交/回滚
   * - 幂等预读在传入事务内执行（能看到调用方未提交的写入），命中则返回 idempotent=true
   * - 不接 UniqueConstraintError（由上抛调用方处理）
   *
   * @param {Object} businessEvent - 业务事件
   * @param {import("sequelize").Transaction} transaction - 外部事务
   * @param {Object} [options] - 可选参数
   * @param {string} [options.ruleSetCode] - 覆盖默认规则集编码
   * @param {string} [options.routingKey] - 灰度路由依据
   * @returns {Promise<Object>} { success, data?, message?, idempotent? }
   */
  async settleWithTransaction(businessEvent, transaction, options = {}) {
    // 0. 事件守卫
    const validation = this._validateEvent(businessEvent);
    if (!validation.ok) {
      return { success: false, message: validation.message };
    }

    // 1. 幂等预读（传入事务内执行，与 batchSettle 的预读口径一致）
    const preReadWhere = this.idempotency.buildPreReadWhere(businessEvent);
    const existing = await this.model.findAll({ where: preReadWhere, transaction });
    if (existing.length > 0) {
      return { success: true, data: { lines: existing }, idempotent: true };
    }

    const calcResult = await this._calculate(businessEvent, options);
    if (!calcResult.ok) {
      return { success: false, message: calcResult.message };
    }

    if (calcResult.dbRecords.length === 0) {
      return { success: true, data: { skipped: true, lines: [] }, idempotent: false };
    }

    const writeResult = await this._writeRecords(businessEvent, calcResult.dbRecords, transaction, calcResult.capState);
    return { success: true, data: writeResult, idempotent: false };
  }

  /**
   * 批量结算：同一事务内处理多个业务事件（原子提交）
   *
   * 每个事件独立 _calculate，但共享同一事务落账。
   * 任一事件失败则全部回滚。
   * 注意：批量场景下游事件可能依赖上游落账结果，需在配置 postProcess 中处理。
   *
   * 错误契约：所有失败路径（入参非数组 / 事件校验失败 / 计算失败 / 落账异常）
   * 一律返回 `{ success: false, message }`，**不抛异常** —— 调用方只需检查 `success`。
   * 失败时事务已回滚，本批次零落账，不存在部分成功。
   *
   * @param {Array<Object>} events - 业务事件列表
   * @param {Object} [options] - 可选参数（同 settle）
   * @returns {Promise<Object>} { success, data?, message?, results? }
   */
  async batchSettle(events, options = {}) {
    if (!Array.isArray(events)) {
      return { success: false, message: "批量结算事件列表必须为数组" };
    }
    // 空数组视为合法的空批次（无操作成功），保持与批量语义一致：不开启事务。
    if (events.length === 0) {
      return { success: true, data: { results: [] } };
    }

    // 所有事件预校验
    for (const event of events) {
      const validation = this._validateEvent(event);
      if (!validation.ok) {
        return { success: false, message: `事件 ${event.orderNo || event.tradeNo || "?"} 校验失败: ${validation.message}` };
      }
    }

    // 幂等快路径（事务外预读）：逐个检查，区分已处理与待处理事件
    const allPreReadWheres = events.map((e) => this.idempotency.buildPreReadWhere(e));
    const idempotentResults = [];  // 已处理事件结果
    const pendingEvents = [];      // 待处理事件（{ index, event }）
    for (let i = 0; i < events.length; i++) {
      const existing = await this.model.findAll({ where: allPreReadWheres[i] });
      if (existing.length > 0) {
        idempotentResults.push({ index: i, lines: existing, idempotent: true });
      } else {
        pendingEvents.push({ index: i, event: events[i] });
      }
    }
    // 全部已处理 → 直接返回
    if (pendingEvents.length === 0) {
      return {
        success: true,
        data: { results: idempotentResults.map((r) => ({ lines: r.lines, idempotent: true })) },
        allIdempotent: true,
      };
    }

    // 部分已处理：只处理未处理的事件，避免重入已处理事件导致唯一约束冲突
    const t = await this.sequelize.transaction();
    try {
      const newResults = [];
      // 批量内共享封顶水位：同一事务内上游事件推进的 capState 传给下游事件，
      // 使「平台日封顶」在批量内连续生效（P0-1 资金安全修复）。
      // 初始水位：优先取 loadCapState 钩子读取的历史累计（跨批次），
      // 未配置钩子时从零开始（与单事件行为一致）。
      let batchCapState = null;
      if (this.loadCapState) {
        batchCapState = await this.loadCapState(options);
      }
      for (const { event } of pendingEvents) {
        const calcResult = await this._calculate(event, { ...options, capState: batchCapState });
        if (!calcResult.ok) {
          await t.rollback();
          return { success: false, message: `事件 ${event.orderNo || event.tradeNo || "?"} 计算失败: ${calcResult.message}` };
        }
        const writeResult = await this._writeRecords(event, calcResult.dbRecords, t, calcResult.capState);
        newResults.push({ lines: writeResult.lines, idempotent: false });
        // 推进批量水位，供下一个事件使用
        if (calcResult.capState) {
          batchCapState = calcResult.capState;
        }
      }
      await t.commit();

      // 合并已处理 + 新处理结果（按原始顺序排列）
      const allResults = [];
      const idempotentMap = {};
      for (const r of idempotentResults) idempotentMap[r.index] = r;
      let newIdx = 0;
      for (let i = 0; i < events.length; i++) {
        if (idempotentMap[i]) {
          allResults.push({ lines: idempotentMap[i].lines, idempotent: true });
        } else {
          allResults.push(newResults[newIdx++]);
        }
      }
      return { success: true, data: { results: allResults } };
    } catch (err) {
      await t.rollback();
      // P2 一致性修复：与 batchSettle 的其他所有失败出口（非数组 / 校验失败 / 计算失败）
      // 以及 settle 的错误契约对齐 —— 统一返回 { success: false, message }，不再往外抛。
      // 原实现在 DB 层异常时 throw，导致同一个方法既可能返回 success:false 又可能抛异常，
      // 调用方只检查 result.success 就会漏掉整批未落账的情况（批量结算漏账无人知）。
      // 事务已回滚，本批次零落账，语义上就是「整批失败」。
      // 不复用 _handleSettleError：它的 UniqueConstraintError 兜底会按【单个事件】的
      // fallbackWhere 回读并宣告幂等成功，用在批量上会把整批失败误报成部分成功。
      this.log.error(
        `[GenericSettlement:${this.name}] 批量结算失败（事务已回滚，本批 ${pendingEvents.length} 个待处理事件均未落账）: ${err.message}`,
        err
      );
      return {
        success: false,
        message: `批量结算失败（事务已回滚，无部分落账）: ${err.message}`,
      };
    }
  }

  /**
   * 计算阶段（私有）：引擎计算 + 结果映射。不操作数据库，由调用方管理事务。
   *
   * @param {Object} businessEvent - 业务事件
   * @param {Object} options - { ruleSetCode?, routingKey? }
   * @returns {Promise<Object>} { ok, dbRecords?, capState?, message? }
   *   capState：引擎执行后推进的封顶水位（未配置 loadCapState 或流水线无 CAP 阶段时为 null）。
   *   调用方需在事务内通过 saveCapState 持久化，与收益记录原子提交。
   */
  async _calculate(businessEvent, options = {}) {
    const ruleSetCode = options.ruleSetCode || this.ruleSetCode;

    // 预防性告警（防止"把 ruleSetCode 放事件内却漏传 options"静默用错默认规则集）。
    //
    // P2 修复：只在【真有误用信号】时告警，不再每单都打。
    // 原实现只要 options.ruleSetCode 缺省就 warn —— 但"依赖构造时默认规则集"是文档
    // 明示的正常用法，等于给每一笔结算都打一条 warn（百万单量级刷爆日志、淹没真实告警，
    // 且运维会训练出忽略该级别日志的习惯）。
    // 真正的误用信号是：事件内带了 ruleSetCode 且与本次生效的规则集不同 ——
    // 此时几乎可断定调用方意图覆盖却传错了位置，必须明示。
    const eventRuleSetCode = businessEvent && businessEvent.ruleSetCode;
    if (!options.ruleSetCode && eventRuleSetCode && eventRuleSetCode !== ruleSetCode) {
      this.log.warn(
        `[GenericSettlement:${this.name}] 事件内 ruleSetCode="${eventRuleSetCode}" 与本次计算使用的规则集 "${ruleSetCode}" 不一致：` +
          `事件内字段仅用于 buildRecord 落库 rule_set_code 审计列，不参与引擎选择规则集。` +
          `如需覆盖规则集，请显式传 options.ruleSetCode。`
      );
    }

    // 1. 加载规则集
    const loaded = await this.ruleSetService.getActiveRuleSet(ruleSetCode, {
      routingKey: options.routingKey,
    });
    if (!loaded.success) {
      return { ok: false, message: `规则集加载失败: ${loaded.message}` };
    }

    // 2. 业务事件 → 引擎事件
    const engineEvent = this.buildEvent(businessEvent);
    if (!engineEvent || !engineEvent.sourceNodeId || engineEvent.eventValue === undefined) {
      return { ok: false, message: "buildEvent 必须返回包含 sourceNodeId 与 eventValue 的对象" };
    }

    // 2a. 将业务事件中未被 buildEvent 使用的字段注入 engineEvent.attrs
    //     （供 rewardDef.conditions 条件评估使用，如 event.attrs.orderAmount）。
    //     若 config 的 buildEvent 已显式设置 attrs，则保留不覆盖。
    //     排除引擎标准字段（sourceNodeId/eventType/eventValue）和元字段（ruleSetCode/extra）。
    if (!engineEvent.attrs) {
      engineEvent.attrs = {};
    }
    const stdFields = new Set(["sourceNodeId", "eventType", "eventValue", "ruleSetCode", "extra"]);
    for (const [key, value] of Object.entries(businessEvent)) {
      if (!stdFields.has(key) && !(key in engineEvent) && !(key in engineEvent.attrs)) {
        engineEvent.attrs[key] = value;
      }
    }

    // 3. 构建直接上级和祖先链
    const directParent = this.buildDirectParent(businessEvent);
    const ancestors = this.buildAncestors(businessEvent);
    // 事件来源节点对象（可选钩子）：供 target:"SOURCE" 的受益节点侧条件求值。
    const sourceNode = this.buildSourceNode(businessEvent);

    // 4. 组装流水线：规则集引擎配置存储在 config_json 中
    //    兼容两种数据格式：
    //    - 标准：loaded.data = { config_json: { rewardDefs, capDefs, pipelineDef } }
    //    - 直接：loaded.data = { rewardDefs, capDefs, pipelineDef }（测试/快速路径）
    const raw = loaded.data;
    const ruleSetConfig = {
      ...(raw.config_json || raw),
      rewardDefs: raw.rewardDefs || raw.config_json?.rewardDefs || [],
      capDefs: raw.capDefs || raw.config_json?.capDefs || [],
      campaignDefs: raw.campaignDefs || raw.config_json?.campaignDefs || [],
      effective: raw.effective || raw.config_json?.effective || null,
    };

    // 4.0 时间维度（fail-closed）：规则集生效期 + 活动期加成都以「事件发生时刻」为基准。
    //     引擎不认识日期、也绝不调用 Date.now() —— 结算重试、补跑昨天的单、对账重算
    //     都在活动窗口之外执行，用「当前时刻」判定等于给历史订单套上今天的系数（超发），
    //     或让当天的单错过当时的活动（少发）。因此时刻必须由宿主显式提供，取不到即拒绝结算。
    const needsOccurredAt =
      !!ruleSetConfig.effective
      || (Array.isArray(ruleSetConfig.campaignDefs) && ruleSetConfig.campaignDefs.length > 0);
    let occurredAt = null;
    if (needsOccurredAt) {
      occurredAt = this.buildOccurredAt(businessEvent);
      if (!occurredAt) {
        return {
          ok: false,
          message:
            `规则集 ${ruleSetCode} 带时间维度（`
            + [ruleSetConfig.effective && "effective 生效期", ruleSetConfig.campaignDefs.length && "campaignDefs 活动加成"]
              .filter(Boolean).join(" + ")
            + "），但取不到事件发生时刻：请在事件上提供 occurredAt，或配置 buildOccurredAt 钩子"
            + "指向你的时间字段（Date 实例或带偏移量的 ISO-8601，如 \"2026-11-11T00:00:00+08:00\"）。"
            + "引擎不会用当前时间兜底 —— 结算重试/补跑历史单会因此套错活动系数。",
        };
      }
      // 4.0.1 生效期：事件发生时刻落在 [startAt, endAt) 之外 → 本次不发放（少发方向）。
      //       过期规则集若静默按原比例继续发，等于「双十一的翻倍规则一直发到十二月」。
      try {
        if (ruleSetConfig.effective && !isWithinWindow(ruleSetConfig.effective, occurredAt, `规则集 ${ruleSetCode} 的 effective`)) {
          return {
            ok: false,
            message:
              `规则集 ${ruleSetCode} 不在生效期内：事件发生时刻 ${new Date(occurredAt).toISOString()} `
              + `不落在 [${ruleSetConfig.effective.startAt}, ${ruleSetConfig.effective.endAt}) 内（左闭右开），本次不发放。`,
          };
        }
      } catch (e) {
        // 时刻/窗口非法（如没写时区偏移）→ 拒绝结算而不是当作「不在生效期」或「在生效期」，
        // 两个方向的静默兜底都会算错钱。
        return { ok: false, message: `规则集 ${ruleSetCode} 的生效期或事件时刻非法: ${e.message}` };
      }
    }

    // 4.1 资金安全（fail-closed）：非 DAILY 周期封顶（WEEKLY/MONTHLY/TOTAL）必须成对配置
    //     loadCapState / saveCapState。引擎不认识日期 —— 周期语义完全由宿主的水位行
    //     生命周期决定；没有水位钩子时每次结算都从 0 起算，「月封顶 5 万」实际退化为
    //     「单事件封顶 5 万」，跑 100 笔就发 500 万。给出虚假的额度保证比不配更危险，
    //     因此这里拒绝结算（少发方向）而不是静默按单事件裁剪。
    //     DAILY 维持历史行为（未配钩子也照旧运行），避免破坏既有接入方。
    const longPeriodScopes = (ruleSetConfig.capDefs || [])
      .filter((c) => c && typeof c.scope === "string" && !c.scope.endsWith("_DAILY"))
      .map((c) => c.scope);
    if (longPeriodScopes.length && !(this.loadCapState && this.saveCapState)) {
      return {
        ok: false,
        message:
          `封顶 scope ${[...new Set(longPeriodScopes)].join(", ")} 是跨结算周期封顶，` +
          "必须成对配置 loadCapState / saveCapState 钩子才能生效" +
          `（当前缺少 ${[!this.loadCapState && "loadCapState", !this.saveCapState && "saveCapState"].filter(Boolean).join(" 与 ")}）` +
          " —— 否则每次结算水位从 0 起算，周/月/活动总量封顶会退化成单事件封顶并大幅超发。",
      };
    }

    const stages = buildPipelineStages(ruleSetConfig, {
      event: engineEvent,
      sourceNode,
      directParent,
      ancestors,
      // 活动加成的判定基准（见 §4.0）；无时间维度的规则集为 null，CAMPAIGN 阶段不会被装配。
      occurredAt,
    });

    // 5. 引擎执行
    //    封顶水位（capState）跨事件累计：若配置了 loadCapState 钩子，结算前读取
    //    当前已发放水位并注入 context，使 CAP 阶段能基于「历史累计」而非「单事件内」
    //    裁剪 —— 这是平台日封顶生效的前提（P0-1 资金安全修复）。
    //    未配置钩子时维持历史行为：context 无 capState，引擎自建初始水位（封顶仅单事件内）。
    //    批量场景（batchSettle）通过 options.capState 传入本批次已累计的水位，
    //    使同一事务内上游事件推进的水位对下游事件立即可见（优先于 loadCapState）。
    let capState = options.capState || null;
    if (!capState && this.loadCapState) {
      capState = await this.loadCapState(options);
    }
    const context = capState ? { capState } : {};
    const result = engine.Orchestrate.executePipeline({ stages, context });
    const engineRecords = result.final || [];
    // 引擎执行后 context.capState 已被 CAP 阶段推进（applyCaps 就地写水位），
    // 返回给调用方，供 _writeRecords 在事务内持久化。
    const updatedCapState = result.context?.capState || null;

    // 6. 引擎输出 → 数据库记录（过滤 buildRecord 返回 null 的记录）
    const dbRecords = [];
    for (const rec of engineRecords) {
      const dbRecord = this.buildRecord(businessEvent, rec, { ancestors, ...(businessEvent.extra || {}) });
      if (dbRecord) {
        dbRecords.push(dbRecord);
      }
    }

    return { ok: true, dbRecords, capState: updatedCapState };
  }

  /**
   * 落账阶段（私有）：把计算好的记录批量写入事务。
   * create 用传入事务；落账后执行 postProcess 钩子（事务内，必须幂等）。
   *
   * @param {Object} businessEvent - 业务事件
   * @param {Array<Object>} dbRecords - 待落账记录
   * @param {import("sequelize").Transaction} transaction - 事务
   * @param {Object|null} [capState] - 本次推进后的封顶水位（来自 _calculate 返回值）
   * @returns {Promise<Object>} { lines: Array } 已落账记录列表
   */
  async _writeRecords(businessEvent, dbRecords, transaction, capState = null) {
    // P2 性能：useBulkCreate=true 时一次插入（N 次 round-trip → 1 次）；
    // 缺省仍逐条 create，保持既有接入方拿到的实例语义完全不变。
    // 两条路径都在同一事务内，失败即整体回滚。
    let createdRecords;
    if (this.useBulkCreate && typeof this.model.bulkCreate === "function" && dbRecords.length > 0) {
      createdRecords = await this.model.bulkCreate(dbRecords, { transaction });
    } else {
      createdRecords = [];
      for (const record of dbRecords) {
        const created = await this.model.create(record, { transaction });
        createdRecords.push(created);
      }
    }

    // 封顶水位持久化（事务内，落账后）：若配置了 saveCapState 钩子，把本次推进后的
    // capState 与收益记录在同一事务内提交 —— 水位写失败即整体回滚，绝不允许
    // 「记录已落账但水位未保存」（否则后续事件会基于旧水位重复发放，超发）。
    // 注意：capState 需由调用方负责序列化/存储格式；Map 序列化等由钩子实现决定。
    if (this.saveCapState && capState) {
      await this.saveCapState(capState, transaction);
    }

    // postProcess 钩子（事务内，落账后）：客户扩展点，必须保持幂等
    if (this.postProcess) {
      await this.postProcess(businessEvent, createdRecords, transaction);
    }

    this.log.info(`订单 ${businessEvent.orderNo || businessEvent.tradeNo || "?"} 落账 ${createdRecords.length} 条记录`);
    return { lines: createdRecords };
  }

  /**
   * 结算异常统一处理（仅 settle 使用）。
   * UniqueConstraintError → 读取已落账记录视为幂等成功；其余异常记录日志后上抛。
   *
   * @param {Error} err - 捕获的异常
   * @param {Object} businessEvent - 业务事件
   * @param {Object} [idempotency=this.idempotency] - 幂等配置（冲正路径传 reversal.idempotency）
   * @returns {Promise<Object>} { success, data?, idempotent? }（仅幂等路径）
   */
  async _handleSettleError(err, businessEvent, idempotency = this.idempotency) {
    // 唯一约束兜底判定：优先宿主注入的类（实例级，不模块级缓存，避免跨宿主串味）；
    // 未注入时懒加载 sequelize 的 UniqueConstraintError（可选 peer，模块级缓存）。
    let isUniqueConstraint = false;
    if (this.UniqueConstraintError && err instanceof this.UniqueConstraintError) {
      isUniqueConstraint = true;
    } else if (_UniqueConstraintError === null) {
      try {
        _UniqueConstraintError = require("sequelize").UniqueConstraintError;
      } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") {
          _UniqueConstraintError = false; // 哨兵值：sequelize 未安装
        } else {
          throw e;
        }
      }
      if (_UniqueConstraintError && err instanceof _UniqueConstraintError) {
        isUniqueConstraint = true;
      }
    } else if (_UniqueConstraintError && err instanceof _UniqueConstraintError) {
      isUniqueConstraint = true;
    }

    if (isUniqueConstraint) {
      const fallbackWhere = idempotency.buildFallbackWhere(businessEvent);
      // 防御：空兜底查询条件会 findAll({ where: {} }) 返回全表，
      // 把无关记录当作幂等成功返回（与 _validateEvent 空 where 同类的数据泄漏边界）。
      if (!fallbackWhere || typeof fallbackWhere !== "object" || Object.keys(fallbackWhere).length === 0) {
        this.log.error(`唯一约束冲突但兜底查询条件为空: ${err.message}`, { orderNo: businessEvent.orderNo });
        throw err;
      }
      const dupRecords = await this.model.findAll({ where: fallbackWhere });
      if (dupRecords.length > 0) {
        return { success: true, data: { lines: dupRecords }, idempotent: true };
      }
      this.log.warn(`唯一约束冲突但兜底查询无数据: ${err.message}`, { orderNo: businessEvent.orderNo });
    } else {
      this.log.error(`结算失败: ${err.message}`, { orderNo: businessEvent.orderNo });
    }
    throw err;
  }

  /**
   * 冲正（退款/撤单追回）：把本次退款对应的已发放收益按比例反向追回并落账
   *
   * 与 settle() 的三处关键差异（均为资金安全考虑）：
   * 1. **计算在事务内**：冲正金额依赖 DB 现值（原始发放记录 + 已冲正累计），
   *    必须在事务内读取，宿主可在 loadOriginalRecords 里加行锁 —— 否则并发冲正
   *    各自看到旧的「已冲正累计」，累计追回可能超过原始发放额（超额扣款）。
   * 2. **幂等键独立**：用 reversal.idempotency（通常按退款单号），不复用发放侧的订单号 ——
   *    否则同一订单的第二次部分退款会被误判为幂等命中而静默不追回。
   * 3. **不动封顶水位**：冲正不回退 capState。回退会把当日已用额度"退还"，
   *    给「下单发佣 → 退款 → 再下单」留出套利空间（当日实际发放超过 limit）。
   *    确有回退需求的宿主请自行在 saveCapState 侧处理，并明确接受该风险。
   *
   * 找不到可冲正的原始记录（该订单本就未发放佣金）属正常运行期情况：
   * 返回 { success: true, data: { skipped: true } }，不落账、不报错。
   *
   * @param {Object} businessEvent - 业务事件（退款/撤单事件，字段由宿主的钩子解释）
   * @param {Object} [options] - 可选参数，原样透传给 loadOriginalRecords
   * @returns {Promise<Object>} { success, data?: { lines, summary, skipped? }, message?, idempotent? }
   */
  async reverse(businessEvent, options = {}) {
    if (!this.reversal) {
      return { success: false, message: `${this.name} 未配置 reversal 冲正块，reverse() 不可用` };
    }
    const revIdem = this.reversal.idempotency;

    // 0. 事件守卫（用冲正专属幂等键推导必填字段）
    const validation = this._validateEvent(businessEvent, revIdem);
    if (!validation.ok) {
      return { success: false, message: validation.message };
    }

    // 1. 幂等快路径（事务外预读）：同一笔退款重复回调不二次扣款。
    const preReadWhere = revIdem.buildPreReadWhere(businessEvent);
    const existing = await this.model.findAll({ where: preReadWhere });
    if (existing.length > 0) {
      this.log.info(`冲正幂等命中: ${this.name} 已处理，返回 ${existing.length} 条冲正记录`);
      return { success: true, data: { lines: existing }, idempotent: true };
    }

    // 2. 事务内：读原始记录 + 已冲正累计 → 计算 → 落账（见方法头第 1 条）。
    const t = await this.sequelize.transaction();
    try {
      const originalRows = await this.reversal.loadOriginalRecords(businessEvent, { transaction: t, options });
      if (!Array.isArray(originalRows)) {
        throw new Error(`${this.name} reversal.loadOriginalRecords 必须返回数组（收到 ${typeof originalRows}）`);
      }
      const originalRecords = originalRows
        .map((row) => this.reversal.buildOriginalRecord(row, businessEvent))
        .filter(Boolean);

      // 无可冲正记录：正常运行期情况（订单未达发放门槛 / 本就没发过佣金），不落账不报错。
      if (originalRecords.length === 0) {
        await t.rollback();
        this.log.info(`${this.name} 冲正无可追回记录（原始发放记录为空）`);
        return { success: true, data: { skipped: true, lines: [], summary: null }, idempotent: false };
      }

      // 已冲正累计（多次部分退款必配；未配时视为全部未冲正，见构造函数 JSDoc 警告）。
      const reversedMap = this.reversal.loadReversedMap
        ? await this.reversal.loadReversedMap(businessEvent, { transaction: t })
        : null;

      const input = this.reversal.resolveReversal(businessEvent) || {};
      const { records, summary } = engine.Reverse.reverseRecords({
        originalRecords,
        ratio: input.ratio,
        reversalValue: input.reversalValue,
        originalEventValue: input.originalEventValue,
        reversedMap: reversedMap ?? null,
        onExceed: input.onExceed || "CLAMP",
        reasonCode: input.reasonCode ?? null,
      });

      const dbRecords = records
        .map((r, i) => this.reversal.buildRecord(businessEvent, r, { index: i, total: records.length, summary }))
        .filter(Boolean);

      // 全部已冲正完（幂等）或 buildRecord 全过滤 → 无落账，不占用事务。
      if (dbRecords.length === 0) {
        await t.rollback();
        this.log.info(`${this.name} 冲正无落账记录（已全额冲正或 buildRecord 全部过滤）`);
        return { success: true, data: { skipped: true, lines: [], summary }, idempotent: false };
      }

      const writeResult = await this._writeReversalRecords(businessEvent, dbRecords, t);
      await t.commit();
      return { success: true, data: { ...writeResult, summary }, idempotent: false };
    } catch (err) {
      await t.rollback();
      // 与 settle 同一错误契约：唯一约束冲突走幂等兜底，其余异常上抛。
      return this._handleSettleError(err, businessEvent, revIdem);
    }
  }

  /**
   * 冲正记录落账（私有，事务内）
   *
   * 与 _writeRecords 的差异：不持久化封顶水位（冲正不回退水位），
   * 且只调用 reversal.postProcess —— 复用发放侧 postProcess 会把冲正行
   * 当作新增发放计入宿主的累计/业绩统计（重复计数，方向上是多算）。
   *
   * @param {Object} businessEvent - 业务事件
   * @param {Array<Object>} dbRecords - 待落账的冲正行
   * @param {import("sequelize").Transaction} transaction - 事务
   * @returns {Promise<Object>} { lines }
   */
  async _writeReversalRecords(businessEvent, dbRecords, transaction) {
    let createdRecords;
    if (this.useBulkCreate && typeof this.model.bulkCreate === "function" && dbRecords.length > 0) {
      createdRecords = await this.model.bulkCreate(dbRecords, { transaction });
    } else {
      createdRecords = [];
      for (const record of dbRecords) {
        const created = await this.model.create(record, { transaction });
        createdRecords.push(created);
      }
    }
    if (this.reversal.postProcess) {
      await this.reversal.postProcess(businessEvent, createdRecords, transaction);
    }
    this.log.info(`${this.name} 冲正落账 ${createdRecords.length} 条记录`);
    return { lines: createdRecords };
  }

  /**
   * 分页查询
   *
   * @param {Object} params
   * @param {number} [params.page=1] - 页码
   * @param {number} [params.pageSize=20] - 每页条数（最大 100）
   * @param {Object} [params.where={}] - 查询条件
   * @param {Array} [params.order] - 排序规则，默认 [["created_at", "DESC"]]
   * @returns {Promise<Object>} { list, pagination }
   */
  async list({ page = 1, pageSize = 20, where = {}, order = [["created_at", "DESC"]] } = {}) {
    const { page: safePage, pageSize: safePageSize, offset } = normalizePagination(page, pageSize);

    const { rows, count } = await this.model.findAndCountAll({
      where,
      order,
      limit: safePageSize,
      offset,
    });
    return {
      list: rows,
      pagination: { page: safePage, pageSize: safePageSize, total: count },
    };
  }

  /**
   * 按条件查询单条记录
   * @param {Object} where - 查询条件（必须非空，findOne 空条件会返回任意行）
   * @returns {Promise<Object|null>}
   */
  async getByWhere(where) {
    if (!where || typeof where !== "object" || Object.keys(where).length === 0) {
      throw new Error("getByWhere 必须提供非空查询条件（防止 findOne({}) 返回任意行）");
    }
    return this.model.findOne({ where });
  }
}

module.exports = { GenericSettlementService, REQUIRED_CONFIG_KEYS, REQUIRED_REVERSAL_KEYS };