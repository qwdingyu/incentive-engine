/**
 * 内存 Model 工厂 — 模拟 Sequelize Model 的最小可运行实现
 *
 * 用途：demo 与本地调试，无需数据库即可演示 GenericSettlementService 全流程。
 * 方法签名与真实 Sequelize Model 对齐：create / findAll / findOne / findAndCountAll。
 *
 * 特性：
 * - 自增 id + created_at
 * - 简易等值 where 匹配
 * - uniqueKeys：create 时检测唯一键冲突并抛出注入的 UniqueConstraintError，
 *   用于演示真实 DB 的「唯一约束兜底」幂等路径
 *
 * @param {Object} options
 * @param {string} [options.tableName] - 表名（仅错误信息使用）
 * @param {Array<Array<string>>} [options.uniqueKeys] - 唯一约束键组，如 [["order_id", "member_id"]]
 * @param {Function} [options.UniqueConstraintError] - 注入的错误类，冲突时 throw new 该类
 * @returns {Object} 内存 Model（含调试辅助 _rows）
 */
function createMemoryModel({ tableName = "memory_model", uniqueKeys = [], UniqueConstraintError } = {}) {
  const rows = [];
  let seq = 0;

  /** 简易等值 where 匹配 */
  function matches(row, where = {}) {
    return Object.entries(where).every(([k, v]) => row[k] === v);
  }

  async function create(record) {
    // 唯一约束冲突检测（模拟 DB 唯一索引，用于演示幂等兜底路径）
    const conflict = rows.find((row) =>
      uniqueKeys.some((keys) => keys.every((k) => row[k] === record[k]))
    );
    if (conflict) {
      const ErrClass = UniqueConstraintError || Error;
      const err = new ErrClass(`${tableName} 唯一约束冲突: ${JSON.stringify(record)}`);
      err.fields = uniqueKeys[0] || [];
      err.original = { code: "ER_DUP_ENTRY" };
      throw err;
    }
    const row = { id: ++seq, created_at: new Date().toISOString(), ...record };
    rows.push(row);
    return row;
  }

  async function findAll({ where = {} } = {}) {
    return rows.filter((r) => matches(r, where));
  }

  async function findOne({ where = {} } = {}) {
    return rows.find((r) => matches(r, where)) || null;
  }

  async function findAndCountAll({ where = {}, limit = 20, offset = 0 } = {}) {
    const filtered = rows.filter((r) => matches(r, where));
    return { rows: filtered.slice(offset, offset + limit), count: filtered.length };
  }

  return {
    create,
    findAll,
    findOne,
    findAndCountAll,
    /** 调试辅助：直接访问内存数据（仅 demo 场景使用） */
    _rows: rows,
  };
}

module.exports = { createMemoryModel };
