/* ═══════════════════════════════════════════════════════════════
 * 13周年庆数据看板 · 数据层（js/data.js）
 * 职责：拉取 BI 爬虫生成的 JSON（GitHub Pages /data/*.json，每 10 分钟更新），
 *       装配成渲染层（main.js）需要的模型。业务数字不再写死在页面里。
 *
 * BI 里没有、页面又需要的字段，全部集中在下方 CONFIG，改这里即可：
 *   - storeExtras：各店弧段颜色 + 复诊到店率%（BI 无此指标，手填）
 *   - extraStores：BI 里没有的弧段（如"三级医院"），不用可整段删空
 *   - channels：   渠道 chip 与 BI 表的对应关系（自动取"合计"行）
 * ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const CONFIG = {
    /* 冲刺目标 = 基础目标 × SPRINT_K */
    sprintK: 1.18,
    /* 门店展示顺序（决定弧段从右上开始、左右镜像的排布） */
    order: ["神华店", "九星店", "青东店", "包百店", "校园店"],
    /* 各店颜色 + 复诊到店率%（BI 报表无此指标，手填，可随时改） */
    storeExtras: {
      神华店: { color: "#d9b876", revisit: 74 },
      九星店: { color: "#c99572", revisit: 62 },
      青东店: { color: "#8fb5a4", revisit: 81 },
      包百店: { color: "#86a0b4", revisit: 66 },
      校园店: { color: "#cfc9ba", revisit: 59 },
    },
    /* BI 无数据的弧段：实收/初诊 = 目标×完成率的演示值，configOnly 仅作占位。
       要去掉这个弧段：extraStores: [] 即可（版式自动退化为 5 段弧）。 */
    extraStores: [
      { id: "sy", name: "三级医院", color: "#b98da0", targetBase: 270, revPct: 68.1, initBase: 740, initPct: 64.3, revisit: 78 },
    ],
    /* 渠道 chip ↔ BI 表：cum=累计到诊 target=总目标 today=今日到诊（取"合计"行） */
    channels: [
      { name: "网电", file: "web", color: "#d9b876" },
      { name: "市场", file: "market", color: "#c99572" },
      { name: "老带新", file: "referral", color: "#8fb5a4" },
    ],
  };

  /* 数据地址：优先同源 ../data/（部署在 Pages /anniversary/ 下时命中），
     失败自动回退线上绝对地址（本地双击打开 / 任意静态服务器都能用） */
  const BASES = ["../data/", "https://yinna1234.github.io/solid-tribble/data/"];

  async function fetchJSON(file) {
    let lastErr;
    for (const base of BASES) {
      try {
        const res = await fetch(base + file + ".json?t=" + Date.now());
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error("取数失败: " + file + " (" + lastErr + ")");
  }

  const num = (v) => (v === "" || v == null || isNaN(+v) ? 0 : +v);

  function buildModel(storesRaw, consultsRaw, doctorsRaw, chanRaws, dailyRaw) {
    /* ── 活动进程：BI"天数/时间进度"列 = 第 N 天 / 共 30 天 ── */
    const D = 30;
    const T = Math.min(
      D,
      Math.max(1, Math.round(num(storesRaw.rows[0] && storesRaw.rows[0]["天数"])) || 28),
    );

    /* ── 门店：目标/实收/完成率/初诊 全部来自 stores.json（单位元 → 万） ── */
    const byName = {};
    storesRaw.rows.forEach((r) => (byName[r["门店"]] = r));
    const names = CONFIG.order.filter((n) => byName[n]);
    storesRaw.rows.forEach((r) => {
      if (!names.includes(r["门店"])) names.push(r["门店"]);
    });
    const stores = names.map((n) => {
      const r = byName[n];
      const ex = CONFIG.storeExtras[n] || {};
      return {
        id: n,
        name: n,
        color: ex.color || "#d4af37",
        targetBase: num(r["业绩目标"]) / 1e4, // 万
        actual: num(r["实收金额"]) / 1e4, // 万
        revPct: num(r["业绩完成率"]), // %
        initBase: num(r["初诊目标"]), // 人
        initActual: num(r["初诊到诊"]), // 人
        initPct: num(r["初诊完成率"]), // %
        revisit: ex.revisit != null ? ex.revisit : 0, // 复诊到店率%（BI 无，手填）
      };
    });
    /* BI 外的弧段（纯配置值），补出 actual/initActual，渲染层无需区分 */
    CONFIG.extraStores.forEach((s) => {
      stores.push({
        ...s,
        actual: (s.targetBase * s.revPct) / 100,
        initActual: (s.initBase * s.initPct) / 100,
      });
    });

    /* ── 渠道：优先取"合计"行，没有才逐行求和（排除合计防重复计数） ── */
    const todayOf = (r) =>
      num(r["今日到诊_总和"] != null ? r["今日到诊_总和"] : r["今日到诊"]);
    const channels = CONFIG.channels.map((c) => {
      const rows = (chanRaws[c.file] && chanRaws[c.file].rows) || [];
      const sumRow = rows.find((r) => /合计/.test(String(r["门店"])));
      let target, cum, today;
      if (sumRow) {
        target = num(sumRow["总目标"]);
        cum = num(sumRow["总到诊"]);
        today = todayOf(sumRow);
      } else {
        target = cum = today = 0;
        rows.forEach((r) => {
          if (/合计/.test(String(r["门店"]))) return;
          target += num(r["总目标"]);
          cum += num(r["总到诊"]);
          today += todayOf(r);
        });
      }
      return {
        ...c,
        target,
        cum,
        today,
        rate: target ? (cum / target) * 100 : 0, // 累计完成率
        share: 0,
      };
    });
    const cumSum = channels.reduce((a, c) => a + c.cum, 0) || 1;
    channels.forEach((c) => (c.share = c.cum / cumSum));

    /* ── 咨询/医生 TOP7：按实收金额降序；BI 无门店列，tag 放业绩完成率 ── */
    const top7 = (rows, nameKey, amtKey) =>
      rows
        .map((r) => ({
          name: r[nameKey],
          tag: (num(r["业绩完成率"]) * 100).toFixed(0) + "%",
          amount: num(r[amtKey]) / 1e4, // 万
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 7);
    const staff = {
      consultants: top7(consultsRaw.rows, "咨询人员", "实收金额"),
      doctors: top7(doctorsRaw.rows, "医生", "医生业绩"),
    };

    /* ── 每日实收（仅 9 月）：daily.json 时间形如"2026年9月X日"，元 → 万 ── */
    const per = {};
    (dailyRaw.rows || []).forEach((r) => {
      const m = /(\d+)年(\d+)月(\d+)日/.exec(String(r["时间"]));
      if (!m || +m[2] !== 9) return;
      const d = +m[3];
      (per[r["门店"]] = per[r["门店"]] || {})[d] = num(r["实收金额"]) / 1e4;
    });
    const byId = {};
    const all = new Array(T).fill(0);
    stores.forEach((s) => {
      const m = per[s.name] || {};
      const arr = [];
      for (let d = 1; d <= T; d++) arr.push(m[d] || 0);
      byId[s.id] = arr;
      for (let i = 0; i < T; i++) all[i] += arr[i];
    });

    /* ── 汇总指标 ── */
    const totalBase = stores.reduce((a, s) => a + s.targetBase, 0);
    const totalRev = stores.reduce((a, s) => a + s.actual, 0);
    const totalInitBase = stores.reduce((a, s) => a + s.initBase, 0);
    const totalInit = stores.reduce((a, s) => a + s.initActual, 0);
    const kpi = {
      timePct: (T / D) * 100,
      revPct: totalBase ? (totalRev / totalBase) * 100 : 0,
      initPct: totalInitBase ? (totalInit / totalInitBase) * 100 : 0,
      avgTicket: totalInit ? (totalRev * 1e4) / totalInit : 0,
    };
    const model = {
      stores,
      totalRev,
      totalInit,
      totalBase,
      totalInitBase,
      kpi,
      channels,
      staff,
      daily: { byId, all },
    };
    return {
      campaign: { year: 2026, month: 9, monthDays: D, today: T },
      sprintK: CONFIG.sprintK,
      stores,
      channels,
      staff,
      daily: { byId, all },
      totals: { totalBase, totalRev, totalInitBase, totalInit },
      kpi,
      model,
      updatedAt: "",
    };
  }

  async function loadDashboardData() {
    const [storesRaw, consultsRaw, doctorsRaw, webRaw, marketRaw, referralRaw, dailyRaw] =
      await Promise.all([
        fetchJSON("stores"),
        fetchJSON("consults"),
        fetchJSON("doctors"),
        fetchJSON("web"),
        fetchJSON("market"),
        fetchJSON("referral"),
        fetchJSON("daily"),
      ]);
    const out = buildModel(
      storesRaw,
      consultsRaw,
      doctorsRaw,
      { web: webRaw, market: marketRaw, referral: referralRaw },
      dailyRaw,
    );
    out.updatedAt = [
      storesRaw,
      consultsRaw,
      doctorsRaw,
      webRaw,
      marketRaw,
      referralRaw,
      dailyRaw,
    ]
      .map((j) => (j && j.updated_at) || "")
      .sort()
      .pop();
    return out;
  }

  global.loadDashboardData = loadDashboardData;
})(window);
