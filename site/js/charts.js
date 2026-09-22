/* 业绩数据看板:fetch data/*.json + ECharts 渲染 */
const PALETTE = {
  blue: '#4a7dbd',
  red: '#d64541',
  gray: '#aab2bd',
  teal: '#2a9d8f',
  amber: '#e9a13b',
  axis: '#666',
  split: '#eef0f3',
};

const fmtWan = (v) => (typeof v === 'number' ? (v / 10000).toFixed(1) : v);
const fmtInt = (v) => (typeof v === 'number' ? Math.round(v).toLocaleString('zh-CN') : v);

/* 按关键字模糊找列名:BI 表头偶尔会变(如"门店名称（全部）"变"门店名称（全部"),精确匹配会失灵 */
function colKey(rows, keyword) {
  const keys = Object.keys(rows[0] || {});
  return keys.find((k) => k.includes(keyword)) || keys[0] || keyword;
}

async function load(name) {
  // 加时间戳防缓存:GitHub Pages 默认缓存10分钟,不加的话数据更新后浏览器可能还拿旧文件
  const resp = await fetch('data/' + name + '.json?t=' + Date.now());
  if (!resp.ok) throw new Error(name + '.json 加载失败: ' + resp.status);
  return resp.json();
}

function renderTable(el, payload) {
  const cols = payload.columns;
  const thead = '<tr>' + cols.map((c) => '<th>' + c + '</th>').join('') + '</tr>';
  const tbody = payload.rows
    .map((r) => '<tr>' + cols.map((c) => '<td>' + (r[c] ?? '') + '</td>').join('') + '</tr>')
    .join('');
  el.innerHTML = '<table>' + thead + tbody + '</table>';
}

/* 门店:完成率横向条形 */
function storeRateChart(payload) {
  const rows = [...payload.rows].sort((a, b) => b['业绩完成率'] - a['业绩完成率']);
  const nameKey = colKey(rows, '门店');
  const chart = echarts.init(document.getElementById('store-rate'));
  chart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps) => `${ps[0].name}<br>业绩完成率:${ps[0].value}%` },
    grid: { left: 80, right: 50, top: 10, bottom: 30 },
    xAxis: { type: 'value', axisLabel: { color: PALETTE.axis, formatter: '{value}%' }, splitLine: { lineStyle: { color: PALETTE.split } } },
    yAxis: { type: 'category', data: rows.map((r) => r[nameKey]), axisLabel: { color: '#333' } },
    series: [
      {
        type: 'bar',
        barWidth: 18,
        data: rows.map((r) => ({
          value: r['业绩完成率'],
          itemStyle: { color: r['业绩完成率'] >= 100 ? PALETTE.red : PALETTE.blue, borderRadius: [0, 4, 4, 0] },
        })),
        markLine: {
          symbol: 'none',
          lineStyle: { color: PALETTE.gray, type: 'dashed' },
          label: { formatter: '目标 100%', color: PALETTE.axis },
          data: [{ xAxis: 100 }],
        },
      },
    ],
  });
  return chart;
}

/* 门店:业绩构成堆叠 */
function storeMixChart(payload) {
  const chart = echarts.init(document.getElementById('store-mix'));
  const nameKey = colKey(payload.rows, '门店');
  const names = payload.rows.map((r) => r[nameKey]);
  const parts = [
    ['初诊业绩', PALETTE.blue],
    ['复诊业绩', PALETTE.teal],
    ['再消费业绩', PALETTE.amber],
  ];
  chart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => fmtWan(v) + ' 万' },
    legend: { top: 0, textStyle: { color: '#555' } },
    grid: { left: 70, right: 30, top: 36, bottom: 30 },
    xAxis: { type: 'category', data: names, axisLabel: { color: '#333' } },
    yAxis: { type: 'value', axisLabel: { color: PALETTE.axis, formatter: (v) => (v / 10000) + '万' }, splitLine: { lineStyle: { color: PALETTE.split } } },
    series: parts.map(([key, color]) => ({
      name: key,
      type: 'bar',
      stack: 'total',
      barWidth: 32,
      data: payload.rows.map((r) => r[key]),
      itemStyle: { color },
    })),
  });
  return chart;
}

/* 咨询/医生:目标 vs 实际 分组柱状 + 完成率折线 */
function targetVsActual(id, payload, nameKey, actualKey) {
  const chart = echarts.init(document.getElementById(id));
  const names = payload.rows.map((r) => r[nameKey]);
  chart.setOption({
    tooltip: { trigger: 'axis', valueFormatter: (v) => fmtWan(v) + ' 万' },
    legend: { top: 0, textStyle: { color: '#555' } },
    grid: { left: 70, right: 60, top: 36, bottom: 60 },
    xAxis: { type: 'category', data: names, axisLabel: { color: '#333', rotate: 40 } },
    yAxis: [
      { type: 'value', axisLabel: { color: PALETTE.axis, formatter: (v) => (v / 10000) + '万' }, splitLine: { lineStyle: { color: PALETTE.split } } },
      { type: 'value', max: 1.6, axisLabel: { color: PALETTE.axis, formatter: (v) => (v * 100).toFixed(0) + '%' }, splitLine: { show: false } },
    ],
    series: [
      { name: '业绩目标', type: 'bar', barWidth: 14, data: payload.rows.map((r) => r['业绩目标']), itemStyle: { color: PALETTE.gray } },
      { name: actualKey, type: 'bar', barWidth: 14, data: payload.rows.map((r) => r[actualKey]), itemStyle: { color: PALETTE.blue } },
      { name: '业绩完成率', type: 'line', yAxisIndex: 1, data: payload.rows.map((r) => r['业绩完成率']), lineStyle: { color: PALETTE.amber, width: 2 }, itemStyle: { color: PALETTE.amber }, symbolSize: 6 },
    ],
  });
  return chart;
}

/* 网电/市场/老带新:到诊柱状 + 完成率折线(按门店) */
function visitVsRate(id, payload) {
  // 过滤掉无完成率的行(如小计行以外的说明行),保留"合计"排最后
  const rows = payload.rows.filter((r) => typeof r['总完成率'] === 'number');
  const nonTotal = rows.filter((r) => r['门店'] !== '合计');
  const total = rows.filter((r) => r['门店'] === '合计');
  const ordered = [...nonTotal.sort((a, b) => b['总到诊'] - a['总到诊']), ...total];
  const chart = echarts.init(document.getElementById(id));
  chart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0, textStyle: { color: '#555' } },
    grid: { left: 60, right: 60, top: 36, bottom: 40 },
    xAxis: { type: 'category', data: ordered.map((r) => r['门店']), axisLabel: { color: '#333' } },
    yAxis: [
      { type: 'value', name: '到诊', axisLabel: { color: PALETTE.axis }, splitLine: { lineStyle: { color: PALETTE.split } } },
      { type: 'value', name: '完成率', axisLabel: { color: PALETTE.axis, formatter: '{value}%' }, splitLine: { show: false } },
    ],
    series: [
      {
        name: '总目标', type: 'bar', barWidth: 14, data: ordered.map((r) => r['总目标']),
        itemStyle: { color: PALETTE.gray },
      },
      {
        name: '总到诊', type: 'bar', barWidth: 14, data: ordered.map((r) => r['总到诊']),
        itemStyle: { color: PALETTE.blue },
      },
      {
        name: '总完成率', type: 'line', yAxisIndex: 1, data: ordered.map((r) => r['总完成率']),
        lineStyle: { color: PALETTE.amber, width: 2 }, itemStyle: { color: PALETTE.amber }, symbolSize: 6,
      },
    ],
  });
  return chart;
}

function resizeAll(charts) {
  window.addEventListener('resize', () => charts.forEach((c) => c.resize()));
}

(async () => {
  const charts = [];
  try {
    const [stores, consults, doctors, web, market, referral] = await Promise.all([
      load('stores'), load('consults'), load('doctors'), load('web'), load('market'), load('referral'),
    ]);

    document.getElementById('updated-at').textContent = '更新于 ' + (stores.updated_at || '--');

    charts.push(storeRateChart(stores));
    charts.push(storeMixChart(stores));
    charts.push(targetVsActual('consult-chart', consults, '咨询人员', '实收金额'));
    charts.push(targetVsActual('doctor-chart', doctors, '医生', '医生业绩'));
    charts.push(visitVsRate('web-chart', web));
    charts.push(visitVsRate('market-chart', market));
    charts.push(visitVsRate('referral-chart', referral));

    renderTable(document.getElementById('store-table'), stores);
    renderTable(document.getElementById('consult-table'), consults);
    renderTable(document.getElementById('doctor-table'), doctors);
    renderTable(document.getElementById('web-table'), web);
    renderTable(document.getElementById('market-table'), market);
    renderTable(document.getElementById('referral-table'), referral);

    resizeAll(charts);
  } catch (e) {
    document.getElementById('err').textContent = '数据加载失败:' + e.message;
  }
})();
