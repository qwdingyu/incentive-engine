/**
 * 内存 Sequelize — 模拟事务管理器（供 demo 无 DB 运行）
 *
 * 真实项目中替换为项目 Sequelize 实例。
 * 注意：内存实现忽略事务隔离/回滚语义，仅保证方法签名与调用形态一致。
 */
function createMemorySequelize() {
  const mockTransaction = {
    async commit() { /* noop：内存无真实事务 */ },
    async rollback() { /* noop */ },
    get LOCK() { return { UPDATE: "UPDATE" }; },
  };

  return {
    async transaction() {
      return mockTransaction;
    },
    /** 调试辅助：拿到共享事务对象（仅 demo 场景使用） */
    _transaction: mockTransaction,
  };
}

module.exports = { createMemorySequelize };
