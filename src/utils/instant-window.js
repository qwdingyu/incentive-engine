/**
 * 绝对时刻与时间窗口 — 通用纯函数，无外部依赖
 *
 * 为「规则集生效期」「活动期加成」这类**带时间维度**的配置提供统一的时刻口径。
 *
 * 为什么引擎只认「绝对时刻」而不认「日期 + 时区」：
 * 引擎是领域无关的纯计算核心，不持有业务日历，也不该猜测时区（封顶周期同理，
 * 见 budget-controller.js 的「引擎不认识日期」说明）。时间窗口一旦落到
 * 「2026-11-11 00:00:00」这种**不带偏移量**的字面量上，同一份配置在不同进程
 * 时区下会整体平移数小时 —— 对活动加成来说就是「提前几小时开始翻倍」或
 * 「活动结束后还在翻倍」，属于资金事故。因此本模块只接受**无歧义的绝对时刻**：
 * - `Date` 实例；
 * - 带显式偏移量的 ISO-8601 字符串（`...Z` / `...+08:00`）。
 *
 * 被**显式拒绝**的输入（全部是静默算错时刻的来源）：
 * - `"2026-11-11T00:00:00"`（无偏移量）—— V8 按**进程本地时区**解析；
 * - `"2026-11-11"`（纯日期）—— V8 按 **UTC** 解析，与上一条口径相反；
 * - 数字时间戳 —— 秒与毫秒无法区分（传秒会落到 1970 年，窗口永不命中）。
 *
 * 窗口区间一律 **左闭右开 [startAt, endAt)**：相邻窗口不会同时命中，
 * 也不必纠结 `23:59:59` 与 `24:00:00` 的边界。
 *
 * @version 1.0.0
 */

/** 带显式偏移量的 ISO-8601 时刻（T 或空格分隔；秒与毫秒可选；Z 或 ±HH:MM / ±HHMM）。 */
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|z|[+-]\d{2}:?\d{2})$/;

/**
 * 把入参解析为绝对时刻（epoch 毫秒），无歧义则抛错（绝不猜测时区）。
 *
 * @param {string} label - 字段名（错误信息定位用）
 * @param {Date|string} value - `Date` 实例，或带显式偏移量的 ISO-8601 字符串
 * @returns {number} epoch 毫秒
 * @throws {Error} 缺失 / 类型不支持 / 无偏移量 / 无法解析
 */
function parseInstant(label, value) {
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `${label} 缺失：时间窗口必须显式提供绝对时刻（Date 实例，或带偏移量的 ISO-8601 字符串如 "2026-11-11T00:00:00+08:00"）`
    );
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) {
      throw new Error(`${label} 是 Invalid Date（无法解析的 Date 实例）`);
    }
    return ms;
  }
  if (typeof value === "number") {
    // 数字时间戳的秒/毫秒之争没有安全的缺省：按毫秒解析传秒的值会落到 1970 年
    // （窗口永不命中 → 加成静默失效），反之则落到遥远未来。直接拒绝。
    throw new Error(
      `${label} 不接受数字时间戳（收到 ${value}）—— 秒与毫秒无法区分，` +
      "请传 Date 实例（`new Date(秒 * 1000)`）或带偏移量的 ISO-8601 字符串"
    );
  }
  if (typeof value !== "string") {
    throw new Error(`${label} 类型不支持（收到 ${typeof value}）—— 只接受 Date 实例或带偏移量的 ISO-8601 字符串`);
  }
  if (!ISO_INSTANT_RE.test(value.trim())) {
    throw new Error(
      `${label} 不是带偏移量的 ISO-8601 时刻（收到 ${JSON.stringify(value)}）：` +
      "必须写明时区偏移，如 \"2026-11-11T00:00:00+08:00\" 或 \"2026-11-10T16:00:00Z\"。" +
      "不带偏移的 \"2026-11-11T00:00:00\" 会按进程本地时区解析、纯日期 \"2026-11-11\" 会按 UTC 解析，" +
      "同一配置在不同环境下的实际生效时刻会相差数小时。"
    );
  }
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) {
    throw new Error(`${label} 无法解析为时刻（收到 ${JSON.stringify(value)}）`);
  }
  return ms;
}

/**
 * 判断某个时刻是否落在时间窗口内（左闭右开 `[startAt, endAt)`）
 *
 * `startAt` / `endAt` **都必须提供**：开放式窗口（只写开始不写结束）在活动加成
 * 场景下等于「永久翻倍」，属于超发方向的兜底，因此不允许省略。
 *
 * @param {Object} window - `{ startAt, endAt }`（Date 或带偏移量的 ISO-8601 字符串）
 * @param {Date|string} occurredAt - 待判定时刻（通常是事件发生时刻，由宿主提供）
 * @param {string} [label="window"] - 错误信息前缀（定位是哪个窗口配错了）
 * @returns {boolean} 是否命中窗口
 * @throws {Error} 窗口缺字段 / 时刻非法 / `endAt <= startAt`
 */
function isWithinWindow(window, occurredAt, label = "window") {
  if (!window || typeof window !== "object" || Array.isArray(window)) {
    throw new Error(`${label} 必须是包含 startAt / endAt 的对象`);
  }
  const start = parseInstant(`${label}.startAt`, window.startAt);
  const end = parseInstant(`${label}.endAt`, window.endAt);
  if (end <= start) {
    throw new Error(
      `${label}.endAt (${new Date(end).toISOString()}) 必须晚于 startAt (${new Date(start).toISOString()})：` +
      "空窗口或反向窗口永不命中，配置错误会让整段规则静默失效"
    );
  }
  const at = parseInstant(`${label} 的判定时刻 occurredAt`, occurredAt);
  return at >= start && at < end;
}

module.exports = { parseInstant, isWithinWindow, ISO_INSTANT_RE };
