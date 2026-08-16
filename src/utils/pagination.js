/**
 * 分页参数归一化工具（通用，无外部依赖）
 *
 * 职责：统一 page/pageSize 的收敛规则，消除各控制器/服务各自手写
 * "Math.min(parseInt(pageSize) || 20, 100)" 的重复与差异，特别是：
 * - "limit 封顶 100 而 offset 仍按原始 pageSize 计算" 的翻页错位
 * - NaN/负值/超大 pageSize 直接进入 ORM 查询的边界隐患
 * - 各文件封顶规则不一致（有的 100、有的不封顶、有的回退值不同）
 *
 * 收敛规则：
 * - page：Number 化 + 向下取整，最小 1（非法值回退 1）
 * - pageSize：Number 化 + 向下取整，收敛 [1, maxPageSize]，非法值回退 defaultPageSize
 * - offset：(page - 1) * pageSize —— 必须基于收敛后的 pageSize，与 limit 严格一致
 *
 * 幂等性：输入已是合法整数时，输出与输入一致（可安全重复调用）。
 *
 * @version 1.0.0
 */

/**
 * 分页参数归一化
 *
 * @param {*} page - 原始页码（string/number/undefined 均可）
 * @param {*} pageSize - 原始每页条数（string/number/undefined 均可）
 * @param {Object} [opts]
 * @param {number} [opts.maxPageSize=100] - 每页条数上限
 * @param {number} [opts.defaultPageSize=20] - 非法时回退的默认每页条数
 * @returns {{ page: number, pageSize: number, offset: number }}
 */
function normalizePagination(page, pageSize, opts = {}) {
  const maxPageSize = Number.isFinite(Number(opts.maxPageSize))
    ? Math.max(1, Math.floor(Number(opts.maxPageSize)))
    : 100;
  const defaultPageSize = Number.isFinite(Number(opts.defaultPageSize))
    ? Math.min(Math.max(1, Math.floor(Number(opts.defaultPageSize))), maxPageSize)
    : Math.min(20, maxPageSize);

  const rawPage = Number(page);
  const rawPageSize = Number(pageSize);

  const safePageSize =
    Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(Math.floor(rawPageSize), maxPageSize) : defaultPageSize;
  const safePage = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  return { page: safePage, pageSize: safePageSize, offset: (safePage - 1) * safePageSize };
}

module.exports = { normalizePagination };