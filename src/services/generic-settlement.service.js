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
 * @version 3.0.0
 */

const engine = require("../engine");
const { buildPipelineStages } = require("../adapters");
const { normalizePagination } = require("../utils");

/** 唯一约束错误类（懒加载），sequelize 为可选 peer */
let _UniqueConstraintError = null;

/** 必填配置项 */
const REQUIRED_CONFIG_KEYS = ["name", "ruleSetCode", "model", "buildEvent", "buildRecord", "idempotency"];

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
 * @param {Function} config.buildRecord - (businessEvent, engineRecord, extra) => Object | null
 * @param {Object} config.idempotency - 幂等配置
 * @param {Function} config.idempotency.buildPreReadWhere - (event) => where object
 * @param {Function} config.idempotency.buildFallbackWhere - (event) => where object
 * @param {Function} [config.postProcess] - (businessEvent, createdRecords, transaction) => Promise<void>
 * @param {Object} config.sequelize - Sequelize 实例（必需）
 * @param {Object} config.ruleSetService - 规则集服务（必需，需有 getActiveRuleSet 方法）
 * @param {Object} [config.logger] - 日志对象（可选，缺省使用 console）
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
    this.buildRecord = config.buildRecord;
    this.idempotency = config.idempotency;
    this.postProcess = config.postProcess || null;

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
   * @returns {Object} { ok, message? } 校验结果
   */
  _validateEvent(businessEvent) {
    if (!businessEvent || typeof businessEvent !== "object" || Array.isArray(businessEvent)) {
      return { ok: false, message: "业务事件必须是非空对象" };
    }
    // 从幂等键预读条件推导必填字段：where 中的值若为 空/undefined/null 则视为缺失。
    const preReadWhere = this.idempotency.buildPreReadWhere(businessEvent);
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
      // 5. 落账阶段（事务内）
      const writeResult = await this._writeRecords(businessEvent, calcResult.dbRecords, t);
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

    const writeResult = await this._writeRecords(businessEvent, calcResult.dbRecords, transaction);
    return { success: true, data: writeResult, idempotent: false };
  }

  /**
   * 批量结算：同一事务内处理多个业务事件（原子提交）
   *
   * 每个事件独立 _calculate，但共享同一事务落账。
   * 任一事件失败则全部回滚。
   * 注意：批量场景下游事件可能依赖上游落账结果，需在配置 postProcess 中处理。
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
      for (const { event } of pendingEvents) {
        const calcResult = await this._calculate(event, options);
        if (!calcResult.ok) {
          await t.rollback();
          return { success: false, message: `事件 ${event.orderNo || event.tradeNo || "?"} 计算失败: ${calcResult.message}` };
        }
        const writeResult = await this._writeRecords(event, calcResult.dbRecords, t);
        newResults.push({ lines: writeResult.lines, idempotent: false });
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
      throw err;
    }
  }

  /**
   * 计算阶段（私有）：引擎计算 + 结果映射。不操作数据库，由调用方管理事务。
   *
   * @param {Object} businessEvent - 业务事件
   * @param {Object} options - { ruleSetCode?, routingKey? }
   * @returns {Promise<Object>} { ok, dbRecords?, message? }
   */
  async _calculate(businessEvent, options = {}) {
    const ruleSetCode = options.ruleSetCode || this.ruleSetCode;

    // 预防性告警（防止"把 ruleSetCode 放事件内却漏传 options"静默用错默认规则集）：
    // - options.ruleSetCode 缺省时本次用配置默认规则集；
    // - 若事件内也带 ruleSetCode，几乎可断定调用方意图覆盖但传错了地方，务必明示。
    if (!options.ruleSetCode) {
      this.log.warn(
        `[GenericSettlement:${this.name}] 未传 options.ruleSetCode，本次计算使用默认规则集 "${this.ruleSetCode}"` +
          (businessEvent && businessEvent.ruleSetCode
            ? `；注意：事件内 ruleSetCode="${businessEvent.ruleSetCode}" 仅用于 buildRecord 落库 rule_set_code 字段，不参与引擎选择规则集`
            : "")
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

    // 4. 组装流水线：规则集引擎配置存储在 config_json 中
    //    兼容两种数据格式：
    //    - 标准：loaded.data = { config_json: { rewardDefs, capDefs, pipelineDef } }
    //    - 直接：loaded.data = { rewardDefs, capDefs, pipelineDef }（测试/快速路径）
    const raw = loaded.data;
    const ruleSetConfig = {
      ...(raw.config_json || raw),
      rewardDefs: raw.rewardDefs || raw.config_json?.rewardDefs || [],
      capDefs: raw.capDefs || raw.config_json?.capDefs || [],
    };
    const stages = buildPipelineStages(ruleSetConfig, {
      event: engineEvent,
      directParent,
      ancestors,
    });

    // 5. 引擎执行
    const result = engine.Orchestrate.executePipeline({ stages });
    const engineRecords = result.final || [];

    // 6. 引擎输出 → 数据库记录（过滤 buildRecord 返回 null 的记录）
    const dbRecords = [];
    for (const rec of engineRecords) {
      const dbRecord = this.buildRecord(businessEvent, rec, { ancestors, ...(businessEvent.extra || {}) });
      if (dbRecord) {
        dbRecords.push(dbRecord);
      }
    }

    return { ok: true, dbRecords };
  }

  /**
   * 落账阶段（私有）：把计算好的记录批量写入事务。
   * create 用传入事务；落账后执行 postProcess 钩子（事务内，必须幂等）。
   *
   * @param {Object} businessEvent - 业务事件
   * @param {Array<Object>} dbRecords - 待落账记录
   * @param {import("sequelize").Transaction} transaction - 事务
   * @returns {Promise<Object>} { lines: Array } 已落账记录列表
   */
  async _writeRecords(businessEvent, dbRecords, transaction) {
    const createdRecords = [];
    for (const record of dbRecords) {
      const created = await this.model.create(record, { transaction });
      createdRecords.push(created);
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
   * @returns {Promise<Object>} { success, data?, idempotent? }（仅幂等路径）
   */
  async _handleSettleError(err, businessEvent) {
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
      const fallbackWhere = this.idempotency.buildFallbackWhere(businessEvent);
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

module.exports = { GenericSettlementService, REQUIRED_CONFIG_KEYS };