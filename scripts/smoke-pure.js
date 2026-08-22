// `./pure` 子入口冒烟：守住「零 Node 内建依赖」与「与包根同形状」两条硬约束。
//
// 为什么必须有这个脚本：
// 打包型消费方（Cloudflare Workers / esbuild 单文件 ESM）无法执行动态 require。
// 只要 `./pure` 的**静态导入图**里出现任何 node 内建（crypto/fs/path/...），
// 就会在打包期报 `Could not resolve "crypto"`，或在运行期抛
// `Dynamic require of "crypto" is not supported` —— 后者曾造成消费方线上事故。
// 注意：把 require 改成惰性（挪进函数体）**不足以**解决打包问题，
// 打包器仍会静态解析函数体内的 require。唯一解是内建根本不在导入图里。
//
// 检查项：
//   1. 扫描器自检（正/负对照，见下）
//   2. 从 src/pure.js 静态遍历 require 图，断言 0 个 node 内建
//   3. `./pure` 与包根的形状契约（同名、同嵌套）
//   4. 真实计算冒烟（distributeByDefs）
//   5. esbuild 打包断言（仅当本机能解析到 esbuild 时执行，非必需）
//
// 用法：node scripts/smoke-pure.js
const fs = require("fs");
const path = require("path");
const Module = require("module");

const SRC = path.join(__dirname, "..", "src");
const PURE_ENTRY = path.join(SRC, "pure.js");

function fail(msg) {
  // eslint-disable-next-line no-console
  console.error("[smoke:pure] ✗ " + msg);
  process.exit(1);
}
function pass(msg) {
  // eslint-disable-next-line no-console
  console.log("[smoke:pure] ✓ " + msg);
}

function isBuiltin(spec) {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  if (typeof Module.isBuiltin === "function") return Module.isBuiltin(bare);
  return Module.builtinModules.includes(bare);
}

/* ============================================================================
 * 1. 注释剥离 + require 静态扫描
 * ==========================================================================*/

/**
 * 把 JS 源码里的注释替换成等长空白，保留字符串字面量（specifier 要从里面取）。
 *
 * 为什么不能直接正则搜 `require("x")`：
 * 本仓库的文档注释里就写着 `require("crypto")` 这样的示例文本
 * （src/pure.js 头部即是），直接搜会把文档当成代码，产生假告警。
 * 反过来，若剥离过度又会漏掉真实 require —— 所以下面用状态机逐字符扫，
 * 并在第 1 步用固定的正/负对照自检，扫描器不可信时直接让冒烟失败。
 */
function stripComments(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  let prevSignificant = ""; // 上一个非空白有效字符，用于区分「除法」与「正则字面量」
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];
    // 行注释
    if (c === "/" && c2 === "/") {
      while (i < n && code[i] !== "\n") { out += " "; i++; }
      continue;
    }
    // 块注释（保留换行，行号不漂移，报错信息才可信）
    if (c === "/" && c2 === "*") {
      out += "  "; i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  "; i += 2;
      continue;
    }
    // 字符串 / 模板字面量：原样保留，内部的 /* // 不算注释
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c; i++;
      while (i < n) {
        if (code[i] === "\\") { out += code[i] + (code[i + 1] || ""); i += 2; continue; }
        out += code[i];
        if (code[i] === quote) { i++; break; }
        i++;
      }
      prevSignificant = quote;
      continue;
    }
    // 正则字面量：用「上一个有效字符」启发式区分 a / b（除法）与 /re/（正则）
    if (c === "/" && !/[\w$)\]]/.test(prevSignificant)) {
      out += c; i++;
      let inClass = false;
      while (i < n) {
        if (code[i] === "\\") { out += code[i] + (code[i + 1] || ""); i += 2; continue; }
        if (code[i] === "[") inClass = true;
        else if (code[i] === "]") inClass = false;
        out += code[i];
        if (code[i] === "/" && !inClass) { i++; break; }
        if (code[i] === "\n") { i++; break; } // 不该发生；防御无限循环
        i++;
      }
      prevSignificant = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out;
}

/** 取一个文件里所有 `require("literal")` 的 specifier（含函数体内的惰性 require） */
function scanRequires(file) {
  const code = stripComments(fs.readFileSync(file, "utf8"));
  const specs = [];
  const re = /\brequire\s*\(\s*("([^"\\]*)"|'([^'\\]*)')\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) specs.push(m[2] !== undefined ? m[2] : m[3]);
  return specs;
}

// --- 扫描器自检：不通过就说明后面的结论不可信，直接失败 ---
// 正对照：version-select.js 的 crypto 是**函数体内的惰性 require**，必须被扫到。
const CTRL_POS = path.join(SRC, "utils", "version-select.js");
if (!scanRequires(CTRL_POS).includes("crypto")) {
  fail("扫描器自检失败（正对照）：未在 utils/version-select.js 中发现惰性 require(\"crypto\")。"
    + "扫描器漏报意味着本脚本的『0 内建』结论无效，请修 stripComments/scanRequires。");
}
// 负对照：pure.js 的头部注释里写着 require("crypto") 的示例文本，必须**不**被扫到。
if (scanRequires(PURE_ENTRY).includes("crypto")) {
  fail("扫描器自检失败（负对照）：把 src/pure.js 注释里的示例文本当成了真实 require。"
    + "扫描器误报意味着结论不可信，请修 stripComments。");
}
pass("扫描器自检通过（惰性 require 能扫到 / 注释里的示例不误报）");

/* ============================================================================
 * 2. 静态遍历 require 图，断言 0 个 node 内建
 * ==========================================================================*/
const visited = new Set();
const builtinHits = [];   // { file, spec }
const bareDeps = new Set(); // 裸包依赖（decimal.js 这类真实 npm 依赖，允许）

function walk(file) {
  const real = fs.realpathSync(file);
  if (visited.has(real)) return;
  visited.add(real);
  for (const spec of scanRequires(real)) {
    if (isBuiltin(spec)) {
      builtinHits.push({ file: path.relative(path.join(SRC, ".."), real), spec });
      continue;
    }
    if (spec.startsWith(".") || spec.startsWith("/")) {
      let resolved;
      try {
        resolved = require.resolve(spec, { paths: [path.dirname(real)] });
      } catch (err) {
        fail("无法解析 " + real + " 中的 require(\"" + spec + "\")：" + err.message);
      }
      walk(resolved);
      continue;
    }
    bareDeps.add(spec);
  }
}
walk(PURE_ENTRY);

if (builtinHits.length > 0) {
  const lines = builtinHits.map((h) => "    " + h.file + " -> require(\"" + h.spec + "\")").join("\n");
  fail("`./pure` 的导入图里出现了 " + builtinHits.length + " 处 node 内建依赖：\n" + lines
    + "\n  打包型消费方（Cloudflare Workers / esbuild ESM）会因此打包失败或运行期崩溃。"
    + "\n  修法：把用到内建的模块从 ./pure 的导入图里摘出去（不是改成惰性 require —— 打包器同样会静态解析）。");
}
pass("导入图 0 个 node 内建（遍历 " + visited.size + " 个文件）");

// 裸包依赖白名单：必须是 package.json 里声明的真实 dependencies（可被打包器打进产物）。
const pkg = require("../package.json");
const declared = Object.keys(pkg.dependencies || {});
const undeclared = [...bareDeps].filter((d) => !declared.includes(d.split("/")[0]));
if (undeclared.length > 0) {
  fail("`./pure` 依赖了未在 dependencies 中声明的包：" + undeclared.join(", ")
    + "（optional peer 如 joi/sequelize 绝不允许进入本入口的导入图）");
}
pass("裸包依赖均已声明：" + ([...bareDeps].join(",") || "(无)"));

/* ============================================================================
 * 3. 形状契约：./pure 与包根同名、同嵌套
 * ==========================================================================*/
const pure = require("../src/pure.js");
const root = require("../src/index.js");

const PURE_REQUIRED_KEYS = ["Distribute", "Evaluate", "Allocate", "Orchestrate", "Model", "Reverse", "Decimal"];
const missing = PURE_REQUIRED_KEYS.filter((k) => !(k in pure));
if (missing.length > 0) fail("`./pure` 缺少导出键：" + missing.join(", "));

// 只多不少也不行：多出来的键说明把带内建依赖的模块混进来了
const extra = Object.keys(pure).filter((k) => !PURE_REQUIRED_KEYS.includes(k));
if (extra.length > 0) {
  fail("`./pure` 多出了未预期的导出键：" + extra.join(", ")
    + "。若确实要新增，请同步更新 src/pure.d.ts、本脚本的 PURE_REQUIRED_KEYS 与 CHANGELOG。");
}

// 嵌套形状必须与包根逐键一致 —— 这是最关键的一条断言。
// 事故复盘：消费方曾深导入 src/engine/distribute/index.js，该文件把 Distribute 这一层
// 抹平了，于是 `engine.Distribute` 为 undefined，调用抛 TypeError 被消费方 try/catch 吞掉，
// 表现为「奖励全部静默不发放」且无任何报错。形状不一致必须在这里就炸。
const shapeDiff = [];
for (const k of PURE_REQUIRED_KEYS) {
  if (typeof pure[k] !== typeof root[k]) { shapeDiff.push(k + "（类型不同）"); continue; }
  if (pure[k] !== null && typeof pure[k] === "object") {
    const a = Object.keys(pure[k]).sort().join(",");
    const b = Object.keys(root[k]).sort().join(",");
    if (a !== b) shapeDiff.push(k + "（子键不同：pure=[" + a + "] root=[" + b + "]）");
  }
}
if (shapeDiff.length > 0) {
  fail("`./pure` 与包根形状不一致：" + shapeDiff.join("；")
    + "。消费方从包根切到 /pure 时只应改 import 路径，调用代码一行都不该动。");
}
pass("形状契约与包根一致：" + PURE_REQUIRED_KEYS.join(","));

/* ============================================================================
 * 4. 真实计算冒烟
 * ==========================================================================*/
const records = pure.Distribute.distributeByDefs({
  event: { sourceNodeId: "u1", eventValue: "1000" },
  directParent: { id: "u0", rankRate: "10" },
  ancestors: [{ id: "u0", rankRate: "10" }],
  rewardDefs: [
    { rewardId: "fixed", type: "CUSTOM", target: "SOURCE", amount: "2" },
    { rewardId: "referral", type: "DIRECT", target: "PARENT", rate: "5" },
  ],
});
const got = records.map((r) => r.rewardId + "=" + r.amount).join(",");
if (got !== "fixed=2,referral=50") {
  fail("distributeByDefs 结果与预期不符：得到 " + got + "，预期 fixed=2,referral=50");
}
if (pure.Decimal.add("0.1", "0.2") !== "0.3") {
  fail("Decimal.add 精度异常：" + pure.Decimal.add("0.1", "0.2"));
}
pass("真实计算 OK：" + got + "；Decimal.add(0.1,0.2)=" + pure.Decimal.add("0.1", "0.2"));

/* ============================================================================
 * 5. esbuild 打包断言（可选）
 * ==========================================================================*/
// 前 4 步已经是硬门槛；这一步用真实打包器复核，但不把 esbuild 变成引擎的 devDependency
// （引擎自身不需要打包，为一条断言引入重型依赖不值得）。本机解析不到就跳过。
let esbuild = null;
try {
  esbuild = require("esbuild");
} catch {
  // eslint-disable-next-line no-console
  console.log("[smoke:pure] · 本机未安装 esbuild，跳过打包断言（前 4 项已通过，非阻塞）");
}

if (esbuild) {
  let result;
  try {
    result = esbuild.buildSync({
      stdin: {
        contents: 'import engine from "./src/pure.js";\nif (typeof engine.Distribute.distributeByDefs !== "function") throw new Error("bad");\n',
        resolveDir: path.join(__dirname, ".."),
        sourcefile: "smoke-pure-entry.mjs",
        loader: "js",
      },
      bundle: true,
      format: "esm",
      // browser 是最严格的平台：node 内建一律无法解析，会在打包期直接报错。
      // 这正是 Cloudflare Workers 场景，也是本入口存在的理由。
      platform: "browser",
      // 关键：必须关掉 legal comments。src/pure.js 的文档块带 @license，
      // esbuild 默认会把整块注释搬进产物，而块内正好写着 require("crypto")
      // 与 `Dynamic require of "crypto"` 的示例文本，会让下面的断言假阳性。
      legalComments: "none",
      write: false,
    });
  } catch (err) {
    fail("esbuild 以 --format=esm --platform=browser 打包 ./pure 失败：\n" + (err && err.message)
      + "\n  说明导入图里仍有无法在非 Node 环境解析的依赖。");
  }

  const out = result.outputFiles[0].text;
  const dynReq = out.match(/(^|[^\w$.])require\s*\(/g);
  if (dynReq) {
    fail("打包产物里残留 " + dynReq.length + " 处 require( 调用 —— 纯 ESM 运行时会抛 "
      + "`Dynamic require of \"x\" is not supported`");
  }
  const builtinImport = out.match(/from\s*"(node:)?(crypto|fs|path|os|util|stream|buffer|events|url|zlib)"/g);
  if (builtinImport) fail("打包产物里残留 node 内建导入：" + [...new Set(builtinImport)].join(", "));
  pass("esbuild 打包断言通过（esm + browser，" + (out.length / 1024).toFixed(1) + "kb，0 动态 require，0 内建导入）");
}

// eslint-disable-next-line no-console
console.log("[smoke:pure] ✓ 全部通过 — ./pure 可安全用于 Cloudflare Workers / esbuild 单文件 ESM");
