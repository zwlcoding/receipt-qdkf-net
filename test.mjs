// 针对 index.html 里纯逻辑的零依赖回归测试。
//
// 这个项目刻意保持单文件、零构建，所以不引入测试框架：直接读出 index.html 的
// 内联脚本，在 node:vm 里跑一遍，然后断言那几个会「算钱」和「推日期」的函数。
// 脚本顶层的函数声明会挂到 vm 的全局对象上，可以直接取用。
//
// 用法：node test.mjs
//
// 注意：这个文件只用于本地验证。同步到 nginx 时请把它排除，不要发布到线上。

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, "index.html"), "utf8");

const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (blocks.length !== 1) {
  throw new Error(`预期 index.html 里只有一个内联 <script>，实际找到 ${blocks.length} 个`);
}

// 只提供脚本真正会触及的全局。Dexie 故意留空，这样 startApp() 不会被调用，
// 也就不会去碰 IndexedDB。
const sandbox = {
  alert: () => {},
  console,
  Intl,
  Date,
  Math,
  Number,
  String,
  Object,
  Array,
  JSON,
  Uint8Array,
  Blob: class Blob {},
  atob: (value) => Buffer.from(value, "base64").toString("binary"),
};
const context = createContext(sandbox);
runInContext(blocks[0], context, { filename: "index.html" });

const {
  amountToChinese,
  advanceBillingPeriod,
  parseAmount,
  moneyIssue,
  recordTotal,
  todayLocal,
} = context;

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    passed += 1;
  } else {
    failures.push(`${label}\n     实际: ${JSON.stringify(actual)}\n     预期: ${JSON.stringify(expected)}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

// —— 金额大写 ——
group("amountToChinese");
check("零", amountToChinese(0), "人民币零元整");
check("整十", amountToChinese(10), "人民币壹拾元整");
check("含零位", amountToChinese(101), "人民币壹佰零壹元整");
check("整万", amountToChinese(10000), "人民币壹万元整");
check("万零头", amountToChinese(10001), "人民币壹万零壹元整");
check("亿零头", amountToChinese(100000001), "人民币壹亿零壹元整");
check("带角分", amountToChinese(99999999.99), "人民币玖仟玖佰玖拾玖万玖仟玖佰玖拾玖元玖角玖分");
check("角为零只写分", amountToChinese(1000.05), "人民币壹仟元零伍分");
// 金额上限的边界：必须仍落在「亿」这一级之内，否则会打印出 undefined
check("上限 10 亿", amountToChinese(1000000000), "人民币壹拾亿元整");

// —— 费用周期推算 ——
group("advanceBillingPeriod");
check("中文格式加一月", advanceBillingPeriod("2026年9月"), "2026年10月");
check("中文跨年", advanceBillingPeriod("2026年12月"), "2027年1月");
check("中文补零保留", advanceBillingPeriod("2026年09月"), "2026年10月");
check("中文补零跨年", advanceBillingPeriod("2026年01月"), "2026年02月");
check("横线格式", advanceBillingPeriod("2026-09"), "2026-10");
check("横线跨年", advanceBillingPeriod("2026-12"), "2027-01");
check("横线不补零入参", advanceBillingPeriod("2026-9"), "2026-10");
check("前后空格", advanceBillingPeriod("  2026年9月  "), "2026年10月");
// 认不出的格式必须返回空串，由调用方决定保留原文（绝不能静默清空）
check("只有月份", advanceBillingPeriod("5月"), "");
check("点号格式", advanceBillingPeriod("2026.05"), "");
check("区间写法", advanceBillingPeriod("2026年5月-6月"), "");
check("非法月份", advanceBillingPeriod("2026年13月"), "");
check("随意文本", advanceBillingPeriod("另计"), "");
check("空串", advanceBillingPeriod(""), "");

// —— 金额解析 ——
group("parseAmount");
check("千分位", parseAmount("1,234.56"), 1234.56);
check("普通小数", parseAmount("1200.5"), 1200.5);
check("非数字兜底为 0", parseAmount("abc"), 0);
check("空串为 0", parseAmount(""), 0);
check("全角数字为 0", parseAmount("１００"), 0);
check("负数原样返回", parseAmount("-50"), -50);
check("undefined 为 0", parseAmount(undefined), 0);

// —— 金额校验 ——
group("moneyIssue");
check("空值合法", moneyIssue(""), "");
check("普通金额合法", moneyIssue("3500"), "");
check("千分位合法", moneyIssue("1,234.56"), "");
check("小数合法", moneyIssue("48.5"), "");
check("上限本身合法", moneyIssue("1000000000"), "");
check("负数被拒", moneyIssue("-50"), "不能为负数");
check("超上限被拒", moneyIssue("1000000001"), "不能超过 1,000,000,000");
check("非数字被拒", moneyIssue("abc"), "不是有效数字");
check("全角数字被拒", moneyIssue("１００"), "不是有效数字");
check("多个小数点被拒", moneyIssue("12.3.4"), "格式不正确");

// —— 合计 ——
group("recordTotal");
check(
  "一张典型收据",
  recordTotal({ rent: "3500", water: "48.5", electricity: "126.8", gas: "32", propertyFee: "150" }),
  3857.3,
);
check("缺失字段按 0", recordTotal({ rent: "100" }), 100);
check("非法字段按 0", recordTotal({ rent: "abc", water: "10" }), 10);

// —— 本地日期 ——
group("todayLocal");
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
check(
  "取本地日期而非 UTC",
  todayLocal(),
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
);

console.log(`\n${"-".repeat(52)}`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项，通过 ${passed} 项：\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}\n`));
  process.exit(1);
}
console.log(`全部通过：${passed} 项断言`);
