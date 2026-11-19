/**
 * Applicator Shot Usage Accounting Dashboard — Main Controller
 */
(function () {
  'use strict';

  // Refined Fintech / Stripe-inspired categorical palette (restrained, cohesive)
  const PALETTE = [
    '#4f46e5', '#0f766e', '#2563eb', '#334155', '#0284c7',
    '#6366f1', '#0d9488', '#475569', '#3b82f6', '#64748b',
    '#818cf8', '#14b8a6', '#1e293b', '#0ea5e9', '#94a3b8',
    '#4338ca', '#115e59', '#1d4ed8', '#cbd5e1'
  ];

  const STRIPE_TOOLTIP = {
    backgroundColor: '#101828',
    titleColor: '#ffffff',
    bodyColor: '#e4e7ec',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
    titleFont: { weight: '600', size: 12 },
    bodyFont: { size: 12 }
  };

  const state = {
    settings: window.loadSavedSettings(),
    rawMeta: null,
    processed: null,
    scopeMode: 'sheet2',    // 'sheet2' (primary, follows Sheet2 branches & 1-2 machine counts) | 'all'
    selectedMonth: '',      // 'YYYY-MM' or 'ALL'
    selectedBranch: 'ALL',  // 'ALL' or branch name
    gapMode: 'actual',      // 'actual' | 'prorate'
    costPerShot: 0,
    auditType: 'ALL',
    auditSearch: '',
    rankingMetric: 'latest_counter', // 'latest_counter' | 'latest_day_used' | 'month_used'
    rankingView: 'branch',           // 'branch' | 'head'
    rankingAsOfDate: '',             // 'YYYY-MM-DD'
    lastRankingRows: [],
    charts: {
      ranking: null,
      daily: null,
      branchBar: null,
      branchShare: null,
      monthly: null
    },
    refreshTimer: null,
    cellIndex: new Map()    // `${branch}|${dateKey}` -> events[]
  };

  // ---------- Helpers ----------
  function fmtInt(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtMoney(n) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtTimeTH(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return isoStr;
    return d.toLocaleString('th-TH', {
      day: '2-digit', month: 'short', year: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function csvCell(val) {
    const s = String(val ?? '');
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadCsv(filename, rows) {
    // UTF-8 BOM so Microsoft Excel displays Thai characters cleanly
    const csvContent = '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function setSyncUI(status, text) {
    const pill = document.getElementById('syncPill');
    const titleEl = document.getElementById('syncTitle');
    const label = document.getElementById('syncText');
    if (pill) pill.className = `sync-card sync-pill ${status}`;
    if (titleEl) {
      titleEl.textContent = status === 'live'
        ? 'Google Sheets สด'
        : (status === 'loading' ? 'กำลังซิงค์ข้อมูล...' : 'โหมด Snapshot');
    }
    if (label) label.textContent = text;
  }

  function reprocessData() {
    if (!state.rawMeta) return;
    state.processed = window.ShotEngine.processRows(state.rawMeta.rows, {
      sheet2Schema: state.rawMeta.sheet2Schema,
      scopeMode: state.scopeMode,
      maxMachinesPerBranch: state.settings.maxMachinesPerBranch || 2,
      maxShotsPerMachinePerDay: state.settings.maxShotsPerMachinePerDay,
      maxGapDaysForDelta: state.settings.maxGapDaysForDelta || 7,
      maxHeadLifespan: state.settings.maxHeadLifespan
    });
    const schema = state.rawMeta.sheet2Schema;
    const scopeSelect = document.getElementById('scopeSelect');
    if (scopeSelect && schema && schema.order && schema.order.length > 0) {
      scopeSelect.options[0].textContent = `อิงตาม Sheet2 (${schema.order.length} สาขา / ${schema.totalMachines} เครื่อง)`;
    }
  }

  // ---------- Data Loading ----------
  async function loadData(isManual = false) {
    setSyncUI('loading', isManual ? 'กำลังอัปเดตจาก Google Sheet...' : 'กำลังเชื่อมต่อ Google Sheet...');

    try {
      const result = await window.SheetFetcher.fetchSheetData(state.settings);
      state.rawMeta = result;
      reprocessData();

      const banner = document.getElementById('snapshotBanner');
      if (result.source === 'snapshot') {
        setSyncUI('snapshot', `Snapshot (${fmtTimeTH(result.fetchedAt)})`);
        banner.classList.add('visible');
      } else {
        setSyncUI('live', `${result.sourceLabel} • ${fmtTimeTH(result.fetchedAt)}`);
        banner.classList.remove('visible');
      }

      populateFilters();
      renderAll();
      scheduleAutoRefresh();
    } catch (err) {
      setSyncUI('snapshot', 'เชื่อมต่อไม่สำเร็จ');
      console.error(err);
      alert('ไม่สามารถโหลดข้อมูลได้: ' + err.message);
    }
  }

  function scheduleAutoRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    const interval = Math.max(60000, Number(state.settings.autoRefreshMs) || 300000);
    state.refreshTimer = setInterval(() => {
      loadData(false);
    }, interval);
  }

  // ---------- Filters ----------
  function populateFilters() {
    const { months, branches } = state.processed;
    const monthSelect = document.getElementById('monthSelect');
    const branchSelect = document.getElementById('branchSelect');

    const prevMonth = state.selectedMonth;
    monthSelect.innerHTML = '';
    for (const m of months) {
      const opt = document.createElement('option');
      opt.value = m.monthKey;
      opt.textContent = m.label;
      monthSelect.appendChild(opt);
    }
    const allOpt = document.createElement('option');
    allOpt.value = 'ALL';
    allOpt.textContent = 'ทุกเดือนรวมกัน (ทั้งปี)';
    monthSelect.appendChild(allOpt);

    if (prevMonth && (prevMonth === 'ALL' || months.some(m => m.monthKey === prevMonth))) {
      state.selectedMonth = prevMonth;
    } else if (months.length > 0) {
      state.selectedMonth = months[0].monthKey; // Default to latest month
    } else {
      state.selectedMonth = 'ALL';
    }
    monthSelect.value = state.selectedMonth;

    const prevBranch = state.selectedBranch;
    branchSelect.innerHTML = `<option value="ALL">ทุกสาขา (${branches.length} สาขา)</option>`;
    for (const b of branches) {
      const opt = document.createElement('option');
      opt.value = b;
      const mc = state.processed.branchMeta[b]?.machineCount || 1;
      opt.textContent = `${b} (${mc} เครื่อง)`;
      branchSelect.appendChild(opt);
    }
    state.selectedBranch = (prevBranch === 'ALL' || branches.includes(prevBranch)) ? prevBranch : 'ALL';
    branchSelect.value = state.selectedBranch;

    // Default ranking As-Of Date to the latest date in dataset
    const asOfInput = document.getElementById('rankingAsOfDate');
    if (asOfInput) {
      asOfInput.min = state.processed.minDateKey || '';
      asOfInput.max = state.processed.maxDateKey || '';
      if (!state.rankingAsOfDate || state.rankingAsOfDate > state.processed.maxDateKey || state.rankingAsOfDate < state.processed.minDateKey) {
        state.rankingAsOfDate = state.processed.maxDateKey || '';
      }
      asOfInput.value = state.rankingAsOfDate;
    }

    // Populate Head 1 / Head 2 side-by-side branch comparison selector
    const headSel = document.getElementById('headCompareBranchSelect');
    if (headSel) {
      const prevHeadBranch = headSel.value;
      headSel.innerHTML = '';
      for (const b of branches) {
        const opt = document.createElement('option');
        opt.value = b;
        const mc = state.processed.branchMeta[b]?.machineCount || 1;
        opt.textContent = `${b} (${mc} หัว)`;
        headSel.appendChild(opt);
      }
      if (state.selectedBranch !== 'ALL' && branches.includes(state.selectedBranch)) {
        headSel.value = state.selectedBranch;
      } else if (prevHeadBranch && branches.includes(prevHeadBranch)) {
        headSel.value = prevHeadBranch;
      } else if (branches.includes('เชียงใหม่')) {
        headSel.value = 'เชียงใหม่';
      } else if (branches.length > 0) {
        headSel.value = branches[0];
      }
    }
  }

  // ---------- Filtered View Computation ----------
  function getActiveEvents() {
    const expanded = window.ShotEngine.expandEventsByMode(state.processed.dailyEvents, state.gapMode);
    return expanded.filter(ev => {
      if (state.selectedMonth !== 'ALL' && ev.monthKey !== state.selectedMonth) return false;
      if (state.selectedBranch !== 'ALL' && ev.branch !== state.selectedBranch) return false;
      return true;
    });
  }

  function getActiveAudits() {
    return state.processed.audits.filter(a => {
      if (state.selectedMonth !== 'ALL' && a.monthKey !== state.selectedMonth) return false;
      if (state.selectedBranch !== 'ALL' && a.branch !== state.selectedBranch) return false;
      return true;
    });
  }

  function getPreviousMonthTotal() {
    if (state.selectedMonth === 'ALL') return null;
    const months = state.processed.months;
    const idx = months.findIndex(m => m.monthKey === state.selectedMonth);
    if (idx < 0 || idx + 1 >= months.length) return null;
    const prevMk = months[idx + 1].monthKey;
    const expanded = window.ShotEngine.expandEventsByMode(state.processed.dailyEvents, state.gapMode);
    let total = 0;
    for (const ev of expanded) {
      if (ev.monthKey === prevMk && (state.selectedBranch === 'ALL' || ev.branch === state.selectedBranch)) {
        total += ev.shotsUsed;
      }
    }
    return { monthKey: prevMk, label: months[idx + 1].shortLabel, total };
  }

  // ---------- Master Render ----------
  function renderAll() {
    if (!state.processed) return;
    const events = getActiveEvents();
    const audits = getActiveAudits();

    renderKPIs(events, audits);
    renderRanking();
    renderMatrix(events);
    renderHeadCompareTable();
    renderBranchSummaryTable(events);
    renderCharts(events);
    renderMachines();
    renderAudits(audits);
  }

  // ---------- TAB 0: Ranking (Latest Head / Branch with Automatic Fallback) ----------
  function parseIsoToUtcMs(dateKey) {
    if (!dateKey) return 0;
    const [y, m, d] = dateKey.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function computeRankingData() {
    const asOf = state.rankingAsOfDate || state.processed.maxDateKey;
    const asOfMs = parseIsoToUtcMs(asOf);
    const maxLifespan = state.settings.maxHeadLifespan || 10000000;
    const branches = state.selectedBranch === 'ALL'
      ? state.processed.branches
      : [state.selectedBranch];

    // Pre-index events by branch+trackId (already chronological in dailyEvents)
    const eventsByTrack = new Map();
    const monthTotalsByBranch = new Map();
    const monthTotalsByTrack = new Map();
    const expandedForMonth = window.ShotEngine.expandEventsByMode(state.processed.dailyEvents, state.gapMode);

    for (const ev of expandedForMonth) {
      if (state.selectedMonth === 'ALL' || ev.monthKey === state.selectedMonth) {
        monthTotalsByBranch.set(ev.branch, (monthTotalsByBranch.get(ev.branch) || 0) + ev.shotsUsed);
        monthTotalsByTrack.set(ev.trackId, (monthTotalsByTrack.get(ev.trackId) || 0) + ev.shotsUsed);
      }
    }

    for (const ev of state.processed.dailyEvents) {
      if (asOf && ev.dateKey > asOf) continue;
      if (!eventsByTrack.has(ev.trackId)) eventsByTrack.set(ev.trackId, []);
      eventsByTrack.get(ev.trackId).push(ev);
    }

    const branchRows = [];
    const headRows = [];

    for (const b of branches) {
      const meta = state.processed.branchMeta[b];
      if (!meta) continue;

      const heads = [];
      for (const t of meta.tracks) {
        const list = eventsByTrack.get(t.id) || [];
        if (!list.length) continue;

        const latestEv = list[list.length - 1];
        const staleDays = asOfMs && latestEv.utcMs ? Math.max(0, Math.round((asOfMs - latestEv.utcMs) / 86400000)) : 0;

        // Calculate recent daily avg (last 14 active readings) to estimate days left until 10M
        const recent = list.slice(-14).filter(e => e.shotsUsed > 0 && e.status !== 'BASELINE');
        const recentShots = recent.reduce((s, e) => s + e.shotsUsed, 0);
        const recentDays = recent.reduce((s, e) => s + Math.max(1, e.dayGap || 1), 0);
        const avgPerDay = recentDays > 0 ? recentShots / recentDays : 0;

        const curVal = latestEv.curVal;
        const remaining = Math.max(0, maxLifespan - curVal);
        const usedPct = Math.min(100, (curVal / maxLifespan) * 100);
        const estDaysLeft = avgPerDay > 0 ? Math.ceil(remaining / avgPerDay) : null;

        // For latest day shots used, if latest reading had 0 (e.g. head swap/baseline), still show latestEv.shotsUsed
        const latestDayShots = latestEv.shotsUsed;
        const headObj = {
          branch: b,
          trackId: t.id,
          headNum: t.num,
          headLabel: t.label,
          displayLabel: `${b} — หัว ${t.num}${t.label && !t.label.startsWith('เครื่อง') ? ' (' + t.label + ')' : ''}`,
          latestDateKey: latestEv.dateKey,
          latestThaiDate: latestEv.thaiDate,
          staleDays,
          curVal,
          remaining,
          usedPct,
          latestDayShots,
          latestDayGap: latestEv.dayGap || 1,
          avgPerDay,
          estDaysLeft,
          monthShots: monthTotalsByTrack.get(t.id) || 0,
          status: latestEv.status
        };
        heads.push(headObj);
        headRows.push(headObj);
      }

      if (!heads.length) continue;

      // Peak head = head with highest latest counter (closest to 10M)
      const peakHead = heads.reduce((best, h) => (!best || h.curVal > best.curVal ? h : best), null);
      const latestDayTotal = heads.reduce((s, h) => s + h.latestDayShots, 0);
      const minStale = Math.min(...heads.map(h => h.staleDays));
      const maxStale = Math.max(...heads.map(h => h.staleDays));
      const anyFallback = heads.some(h => h.staleDays > 0);
      const latestDateOverall = heads.reduce((best, h) => (!best || h.latestDateKey > best.latestDateKey ? h : best), null);

      branchRows.push({
        branch: b,
        machineCount: meta.tracks.length,
        heads,
        peakHead,
        peakVal: peakHead.curVal,
        peakRemaining: peakHead.remaining,
        peakPct: peakHead.usedPct,
        peakEstDaysLeft: peakHead.estDaysLeft,
        latestDayTotal,
        monthTotal: monthTotalsByBranch.get(b) || 0,
        minStale,
        maxStale,
        anyFallback,
        latestThaiDate: latestDateOverall ? latestDateOverall.latestThaiDate : '-'
      });
    }

    // Sort according to selected metric
    const metric = state.rankingMetric;
    if (metric === 'latest_counter') {
      branchRows.sort((a, b) => b.peakVal - a.peakVal);
      headRows.sort((a, b) => b.curVal - a.curVal);
    } else if (metric === 'latest_day_used') {
      branchRows.sort((a, b) => b.latestDayTotal - a.latestDayTotal);
      headRows.sort((a, b) => b.latestDayShots - a.latestDayShots);
    } else {
      branchRows.sort((a, b) => b.monthTotal - a.monthTotal);
      headRows.sort((a, b) => b.monthShots - a.monthShots);
    }

    return { asOf, branchRows, headRows };
  }

  function renderRanking() {
    if (!state.processed) return;
    const { asOf, branchRows, headRows } = computeRankingData();
    const isBranchView = state.rankingView === 'branch';
    const items = isBranchView ? branchRows : headRows;
    state.lastRankingRows = { asOf, isBranchView, items };

    const asOfThai = window.ShotEngine.formatThaiDateShort(asOf);
    const fallbackCount = isBranchView
      ? branchRows.filter(r => r.anyFallback).length
      : headRows.filter(h => h.staleDays > 0).length;

    const summaryBadge = document.getElementById('rankingFallbackSummary');
    if (summaryBadge) {
      summaryBadge.className = fallbackCount > 0 ? 'badge badge-amber' : 'badge badge-emerald';
      summaryBadge.textContent = fallbackCount > 0
        ? `ณ ${asOfThai}: ขาดส่ง ${fallbackCount} ${isBranchView ? 'สาขา' : 'หัว'} (ดึงวันล่าสุดมาจัดอันดับแทน)`
        : `ณ ${asOfThai}: ส่งครบทุก${isBranchView ? 'สาขา' : 'หัว'} 100%`;
    }

    renderRankingPodium(items, isBranchView, asOfThai);
    renderRankingChart(items, isBranchView, asOfThai);
    renderRankingTable(items, isBranchView, asOfThai);
  }

  function getMetricDisplay(item, isBranchView) {
    const m = state.rankingMetric;
    if (isBranchView) {
      if (m === 'latest_counter') return { val: item.peakVal, unit: 'ช็อตสะสม (หัวสูงสุด)', sub: `คงเหลือ ${fmtInt(item.peakRemaining)} (${item.peakPct.toFixed(1)}%)` };
      if (m === 'latest_day_used') return { val: item.latestDayTotal, unit: 'ช็อต (วันล่าสุด)', sub: `อัปเดตล่าสุด ${item.latestThaiDate}` };
      return { val: item.monthTotal, unit: 'ช็อต (รวมทั้งเดือน)', sub: window.ShotEngine.formatMonthLabel(state.selectedMonth) };
    } else {
      if (m === 'latest_counter') return { val: item.curVal, unit: 'ช็อตสะสม', sub: `คงเหลือ ${fmtInt(item.remaining)} (${item.usedPct.toFixed(1)}%)` };
      if (m === 'latest_day_used') return { val: item.latestDayShots, unit: 'ช็อต (วันล่าสุด)', sub: `อัปเดตล่าสุด ${item.latestThaiDate}` };
      return { val: item.monthShots, unit: 'ช็อต (รวมทั้งเดือน)', sub: window.ShotEngine.formatMonthLabel(state.selectedMonth) };
    }
  }

  function renderRankingPodium(items, isBranchView, asOfThai) {
    const el = document.getElementById('rankingPodium');
    if (!el) return;
    const top3 = items.slice(0, 3);

    if (!top3.length) {
      el.innerHTML = '';
      return;
    }

    const maxVal = top3[0] ? getMetricDisplay(top3[0], isBranchView).val : 1;

    el.innerHTML = top3.map((item, idx) => {
      const disp = getMetricDisplay(item, isBranchView);
      const name = isBranchView ? item.branch : item.displayLabel;
      const stale = isBranchView ? item.maxStale : item.staleDays;
      const dateStr = isBranchView ? item.peakHead.latestThaiDate : item.latestThaiDate;
      const estDays = isBranchView ? item.peakEstDaysLeft : item.estDaysLeft;

      const statusPill = stale > 0
        ? `<span class="badge badge-amber"><span class="status-dot warn"></span>${escapeHtml(dateStr)} (-${stale} วัน)</span>`
        : `<span class="badge badge-emerald"><span class="status-dot ok"></span>ตรงวัน (${escapeHtml(asOfThai)})</span>`;

      const estPill = state.rankingMetric === 'latest_counter' && estDays !== null
        ? `<span class="badge ${estDays <= 14 ? 'badge-rose' : 'badge-slate'}">อีก ~${estDays} วันครบ 10M</span>`
        : '';

      const pctWidth = state.rankingMetric === 'latest_counter'
        ? (isBranchView ? item.peakPct : item.usedPct)
        : (maxVal > 0 ? (disp.val / maxVal) * 100 : 0);

      const barCls = state.rankingMetric === 'latest_counter'
        ? (disp.val >= 9000000 ? 'danger' : (disp.val >= 8000000 ? 'warn' : ''))
        : '';

      const rankNumStr = `0${idx + 1}`;

      return `
        <article class="podium-card rank-${idx + 1}">
          <div class="podium-top">
            <span class="podium-rank-num">
              <span class="rank-index-pill num">${rankNumStr}</span>
              <span>อันดับที่ ${idx + 1}</span>
            </span>
            ${statusPill}
          </div>
          <div>
            <div class="podium-name">${escapeHtml(name)}</div>
            <div class="podium-metric num">${fmtInt(disp.val)}<span class="podium-unit">${escapeHtml(disp.unit)}</span></div>
          </div>
          <div class="podium-bar">
            <div class="podium-bar-fill ${barCls}" style="width:${Math.min(100, Math.max(4, pctWidth)).toFixed(1)}%;"></div>
          </div>
          <div class="podium-meta">
            <span>${escapeHtml(disp.sub)}</span>
            ${estPill}
          </div>
        </article>`;
    }).join('');
  }

  function renderRankingChart(items, isBranchView, asOfThai) {
    destroyChart('ranking');
    const ctx = document.getElementById('rankingBarChart');
    const container = document.getElementById('rankingChartContainer');
    const titleEl = document.getElementById('rankingChartTitle');
    if (!ctx || typeof Chart === 'undefined') return;

    Chart.defaults.font.family = "'Inter', 'IBM Plex Sans Thai', sans-serif";
    Chart.defaults.color = '#667085';

    // Adjust chart height cleanly for 19 branches vs 31 heads
    if (container) {
      container.style.height = Math.max(400, items.length * 26 + 64) + 'px';
    }

    const metricTitleMap = {
      latest_counter: 'จัดอันดับช็อตสะสมหัวล่าสุด (ใกล้ครบ 10 ล้านช็อตที่สุด)',
      latest_day_used: 'จัดอันดับช็อตที่ใช้ไปวันล่าสุด (Fallback วันล่าสุดที่มี)',
      month_used: `จัดอันดับยอดใช้ช็อตรวม (${window.ShotEngine.formatMonthLabel(state.selectedMonth)})`
    };
    titleEl.textContent = `${metricTitleMap[state.rankingMetric]} — ${isBranchView ? 'รายสาขา' : 'รายหัวทั้งหมด'} (ณ ${asOfThai})`;

    const labels = items.map((item, idx) => {
      const baseName = isBranchView ? item.branch : item.displayLabel;
      const stale = isBranchView ? item.maxStale : item.staleDays;
      return `${String(idx + 1).padStart(2, '0')}  ${baseName}${stale > 0 ? ' *' : ''}`;
    });

    const values = items.map(item => getMetricDisplay(item, isBranchView).val);
    const colors = items.map((item, idx) => {
      if (state.rankingMetric === 'latest_counter') {
        const v = isBranchView ? item.peakVal : item.curVal;
        if (v >= 9000000) return '#e11d48';
        if (v >= 8000000) return '#d97706';
        return '#4f46e5';
      }
      const stale = isBranchView ? item.maxStale : item.staleDays;
      if (stale > 0) return '#d97706';
      return idx < 3 ? '#101828' : '#6366f1';
    });

    state.charts.ranking = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: metricTitleMap[state.rankingMetric],
          data: values,
          backgroundColor: colors,
          borderRadius: 4,
          barThickness: 16
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            beginAtZero: true,
            max: state.rankingMetric === 'latest_counter' ? 10000000 : undefined,
            border: { display: false },
            grid: { color: '#f2f4f7' },
            ticks: { callback: v => fmtInt(v), font: { size: 11 } }
          },
          y: {
            border: { display: false },
            grid: { display: false },
            ticks: { color: '#344054', font: { size: 12, weight: '500' } }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...STRIPE_TOOLTIP,
            callbacks: {
              label: c => {
                const item = items[c.dataIndex];
                const d = getMetricDisplay(item, isBranchView);
                const dateStr = isBranchView ? item.peakHead.latestThaiDate : item.latestThaiDate;
                return `${fmtInt(c.parsed.x)} ช็อต • ${d.sub} (ล่าสุด: ${dateStr})`;
              }
            }
          }
        }
      }
    });
  }

  function renderRankingTable(items, isBranchView, asOfThai) {
    const table = document.getElementById('rankingTable');
    const titleEl = document.getElementById('rankingTableTitle');
    if (!table) return;
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');

    titleEl.textContent = isBranchView
      ? `ตารางจัดอันดับรายสาขา (${items.length} สาขา) — อ้างอิง ณ ${asOfThai}`
      : `ตารางจัดอันดับรายหัวทั้งหมด (${items.length} หัว) — อ้างอิง ณ ${asOfThai}`;

    if (isBranchView) {
      thead.innerHTML = `
        <tr>
          <th style="width:68px;">อันดับ</th>
          <th>สาขา</th>
          <th class="right">หัว 1 (มิเตอร์ล่าสุด / วันที่)</th>
          <th class="right">หัว 2 (มิเตอร์ล่าสุด / วันที่)</th>
          <th class="right">หัวสูงสุด (% / คงเหลือ)</th>
          <th class="right">คาดว่าเหลือ (วัน)</th>
          <th class="right">ใช้ไปวันล่าสุด</th>
          <th class="right">รวมทั้งเดือน</th>
          <th>สถานะการส่ง ณ ${escapeHtml(asOfThai)}</th>
        </tr>`;

      const formatHeadCell = (h) => {
        if (!h) return `<span style="color:#cbd5e1;">-</span>`;
        const staleTag = h.staleDays > 0
          ? `<span style="color:var(--amber);font-weight:600;">${escapeHtml(h.latestThaiDate)} (-${h.staleDays} วัน)</span>`
          : `<span>${escapeHtml(h.latestThaiDate)}</span>`;
        return `<div class="head-pill"><strong class="num">${fmtInt(h.curVal)}</strong><span class="head-pill-sub">${staleTag}</span></div>`;
      };

      tbody.innerHTML = items.map((item, idx) => {
        const rank = idx + 1;
        const rCls = rank === 1 ? 'r1' : (rank === 2 ? 'r2' : (rank === 3 ? 'r3' : ''));
        const h1 = item.heads[0] || null;
        const h2 = item.heads[1] || null;

        const barCls = item.peakVal >= 9000000 ? 'danger' : (item.peakVal >= 8000000 ? 'warn' : '');
        const estText = item.peakEstDaysLeft !== null
          ? `<span class="badge ${item.peakEstDaysLeft <= 14 ? 'badge-rose' : (item.peakEstDaysLeft <= 30 ? 'badge-amber' : 'badge-slate')}">~${item.peakEstDaysLeft} วัน</span>`
          : '-';

        const statusHtml = item.anyFallback
          ? `<span class="badge badge-amber"><span class="status-dot warn"></span>${escapeHtml(item.latestThaiDate)} (-${item.maxStale} วัน)</span>`
          : `<span class="badge badge-emerald"><span class="status-dot ok"></span>ส่งครบตรงวัน</span>`;

        return `
          <tr>
            <td><span class="rank-badge num ${rCls}">${String(rank).padStart(2, '0')}</span></td>
            <td><strong>${escapeHtml(item.branch)}</strong> <span style="font-size:11.5px;color:var(--ink-tertiary);">(${item.machineCount} หัว)</span></td>
            <td class="right">${formatHeadCell(h1)}</td>
            <td class="right">${formatHeadCell(h2)}</td>
            <td class="right">
              <div class="head-pill" style="align-items:flex-end;">
                <span class="num"><strong>${item.peakPct.toFixed(1)}%</strong> <span style="color:var(--ink-tertiary);">(เหลือ ${fmtInt(item.peakRemaining)})</span></span>
                <div class="mini-bar-wrap"><div class="progress-track" style="margin:2px 0 0;"><div class="progress-fill ${barCls}" style="width:${item.peakPct.toFixed(1)}%;"></div></div></div>
              </div>
            </td>
            <td class="right">${estText}</td>
            <td class="right num"><strong>${fmtInt(item.latestDayTotal)}</strong></td>
            <td class="right num">${fmtInt(item.monthTotal)}</td>
            <td>${statusHtml}</td>
          </tr>`;
      }).join('');
    } else {
      thead.innerHTML = `
        <tr>
          <th style="width:68px;">อันดับ</th>
          <th>สาขา</th>
          <th>หัว / หมายเลขเครื่อง</th>
          <th class="right">มิเตอร์สะสมล่าสุด</th>
          <th class="right">คงเหลือ (จาก 10M)</th>
          <th class="right">อายุหัว (%)</th>
          <th class="right">เฉลี่ย/วัน</th>
          <th class="right">คาดว่าเหลือ (วัน)</th>
          <th class="right">ใช้ไปวันล่าสุด</th>
          <th>วันที่ส่งล่าสุด</th>
        </tr>`;

      tbody.innerHTML = items.map((h, idx) => {
        const rank = idx + 1;
        const rCls = rank === 1 ? 'r1' : (rank === 2 ? 'r2' : (rank === 3 ? 'r3' : ''));
        const barCls = h.curVal >= 9000000 ? 'danger' : (h.curVal >= 8000000 ? 'warn' : '');
        const estText = h.estDaysLeft !== null
          ? `<span class="badge ${h.estDaysLeft <= 14 ? 'badge-rose' : (h.estDaysLeft <= 30 ? 'badge-amber' : 'badge-slate')}">~${h.estDaysLeft} วัน</span>`
          : '-';
        const dateBadge = h.staleDays > 0
          ? `<span class="badge badge-amber"><span class="status-dot warn"></span>${escapeHtml(h.latestThaiDate)} (-${h.staleDays} วัน)</span>`
          : `<span class="badge badge-emerald"><span class="status-dot ok"></span>${escapeHtml(h.latestThaiDate)}</span>`;

        return `
          <tr>
            <td><span class="rank-badge num ${rCls}">${String(rank).padStart(2, '0')}</span></td>
            <td><strong>${escapeHtml(h.branch)}</strong></td>
            <td>หัว ${h.headNum} <span style="font-size:12px;color:var(--ink-tertiary);">(${escapeHtml(h.headLabel)})</span></td>
            <td class="right num"><strong>${fmtInt(h.curVal)}</strong></td>
            <td class="right num">${fmtInt(h.remaining)}</td>
            <td class="right">
              <span class="num">${h.usedPct.toFixed(1)}%</span>
              <div class="mini-bar-wrap" style="margin-left:6px;"><div class="progress-track" style="margin:0;"><div class="progress-fill ${barCls}" style="width:${h.usedPct.toFixed(1)}%;"></div></div></div>
            </td>
            <td class="right num">${h.avgPerDay > 0 ? fmtInt(h.avgPerDay) : '-'}</td>
            <td class="right">${estText}</td>
            <td class="right num">${fmtInt(h.latestDayShots)}</td>
            <td>${dateBadge}</td>
          </tr>`;
      }).join('');
    }
  }

  function exportRankingCsv() {
    if (!state.lastRankingRows || !state.lastRankingRows.items) return;
    const { asOf, isBranchView, items } = state.lastRankingRows;
    const rows = [];

    if (isBranchView) {
      rows.push(['อันดับ', 'สาขา', 'จำนวนหัว', 'หัว1_มิเตอร์ล่าสุด', 'หัว1_วันที่ล่าสุด', 'หัว2_มิเตอร์ล่าสุด', 'หัว2_วันที่ล่าสุด', 'หัวสูงสุด_ช็อตสะสม', 'หัวสูงสุด_คงเหลือ', 'อายุหัว(%)', 'คาดว่าอีกกี่วันครบ10M', 'ใช้ไปวันล่าสุด', 'รวมทั้งเดือน', 'สถานะอ้างอิง']);
      items.forEach((item, idx) => {
        const h1 = item.heads[0];
        const h2 = item.heads[1];
        rows.push([
          idx + 1,
          item.branch,
          item.machineCount,
          h1 ? h1.curVal : '',
          h1 ? h1.latestThaiDate : '',
          h2 ? h2.curVal : '',
          h2 ? h2.latestThaiDate : '',
          item.peakVal,
          item.peakRemaining,
          item.peakPct.toFixed(1),
          item.peakEstDaysLeft !== null ? item.peakEstDaysLeft : '',
          item.latestDayTotal,
          item.monthTotal,
          item.anyFallback ? `ใช้วันล่าสุด ${item.latestThaiDate} (ย้อนหลัง ${item.maxStale} วัน)` : 'ส่งครบตรงวัน'
        ]);
      });
    } else {
      rows.push(['อันดับ', 'สาขา', 'หัวที่', 'หมายเลขเครื่อง', 'มิเตอร์สะสมล่าสุด', 'คงเหลือ(จาก10M)', 'อายุหัว(%)', 'เฉลี่ย/วัน', 'คาดว่าอีกกี่วันครบ10M', 'ใช้ไปวันล่าสุด', 'วันที่ส่งล่าสุด', 'ย้อนหลัง(วัน)']);
      items.forEach((h, idx) => {
        rows.push([
          idx + 1,
          h.branch,
          h.headNum,
          h.headLabel,
          h.curVal,
          h.remaining,
          h.usedPct.toFixed(1),
          h.avgPerDay > 0 ? Math.round(h.avgPerDay) : '',
          h.estDaysLeft !== null ? h.estDaysLeft : '',
          h.latestDayShots,
          h.latestThaiDate,
          h.staleDays
        ]);
      });
    }

    downloadCsv(`applicator_ranking_${isBranchView ? 'by_branch' : 'by_head'}_${asOf || 'latest'}.csv`, rows);
  }

  // ---------- KPI Cards ----------
  function renderKPIs(events, audits) {
    let totalShots = 0;
    const dayTotals = new Map();
    const branchTotals = new Map();

    for (const ev of events) {
      totalShots += ev.shotsUsed;
      dayTotals.set(ev.dateKey, (dayTotals.get(ev.dateKey) || 0) + ev.shotsUsed);
      branchTotals.set(ev.branch, (branchTotals.get(ev.branch) || 0) + ev.shotsUsed);
    }

    const activeDays = Array.from(dayTotals.values()).filter(v => v > 0).length;
    const avgDaily = activeDays > 0 ? totalShots / activeDays : 0;

    let peakDate = '';
    let peakVal = 0;
    for (const [dk, val] of dayTotals.entries()) {
      if (val > peakVal) {
        peakVal = val;
        peakDate = dk;
      }
    }

    let topBranch = '-';
    let topBranchVal = 0;
    for (const [b, val] of branchTotals.entries()) {
      if (val > topBranchVal) {
        topBranchVal = val;
        topBranch = b;
      }
    }

    // KPI 1: Total Shots
    document.getElementById('kpiPeriodBadge').textContent = window.ShotEngine.formatMonthLabel(state.selectedMonth);
    document.getElementById('kpiTotalShots').textContent = fmtInt(totalShots);

    const subParts = [];
    if (state.costPerShot > 0) {
      subParts.push(`<span class="badge badge-emerald">≈ ฿${fmtMoney(totalShots * state.costPerShot)}</span>`);
    }
    const prevMonth = getPreviousMonthTotal();
    if (prevMonth && prevMonth.total > 0) {
      const diffPct = ((totalShots - prevMonth.total) / prevMonth.total) * 100;
      const sign = diffPct >= 0 ? '+' : '';
      const cls = diffPct >= 0 ? 'badge-blue' : 'badge-slate';
      subParts.push(`<span class="badge ${cls}">${sign}${diffPct.toFixed(1)}% เทียบ ${prevMonth.label}</span>`);
    } else {
      subParts.push(`<span>${fmtInt(events.length)} รายการบันทึกเครื่อง</span>`);
    }
    document.getElementById('kpiTotalSub').innerHTML = subParts.join(' ');

    // KPI 2: Daily Average
    document.getElementById('kpiAvgDaily').textContent = fmtInt(avgDaily);
    document.getElementById('kpiPeakDaySub').innerHTML = peakDate
      ? `สูงสุด: <strong>${window.ShotEngine.formatThaiDateShort(peakDate)}</strong> (${fmtInt(peakVal)} ช็อต) • ${activeDays} วัน`
      : 'ยังไม่มีข้อมูลการใช้งาน';

    // KPI 3: Top Branch
    document.getElementById('kpiActiveBranches').textContent = `${branchTotals.size} สาขา`;
    document.getElementById('kpiTopBranch').textContent = topBranch;
    const sharePct = totalShots > 0 ? ((topBranchVal / totalShots) * 100).toFixed(1) : '0.0';
    document.getElementById('kpiTopBranchSub').innerHTML = topBranchVal > 0
      ? `<strong class="num">${fmtInt(topBranchVal)}</strong> ช็อต (${sharePct}% ของทั้งหมด)`
      : '-';

    // KPI 4: Data Quality / Audit
    const errorAudits = audits.filter(a => a.severity === 'error').length;
    const swapAudits = audits.filter(a => a.type === 'HEAD_SWAP_NEW' || a.type === 'HEAD_SWAP_USED').length;
    const multiAudits = audits.filter(a => a.type === 'MULTI_DAY').length;
    const totalChecked = events.length + errorAudits;
    const qualityPct = totalChecked > 0 ? ((events.length / totalChecked) * 100) : 100;

    document.getElementById('kpiQualityPct').textContent = `${qualityPct.toFixed(1)}%`;
    document.getElementById('kpiAuditBadge').textContent = `${errorAudits} OCR พลาด`;
    document.getElementById('kpiAuditSub').innerHTML =
      `เปลี่ยนหัว <strong>${swapAudits}</strong> • เว้นช่วง <strong>${multiAudits}</strong> (คลิกดูรายละเอียด)`;
    document.getElementById('tabAuditCount').textContent = audits.length;
  }

  // ---------- TAB 1: Accounting Daily Matrix (Branch x Day) ----------
  function renderMatrix(events) {
    const table = document.getElementById('matrixTable');
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    const tfoot = table.querySelector('tfoot');

    state.cellIndex.clear();

    const branchesToShow = state.selectedBranch === 'ALL'
      ? state.processed.branches
      : [state.selectedBranch];

    const isSingleMonth = state.selectedMonth !== 'ALL';
    const titleEl = document.getElementById('matrixTitle');

    let colKeys = [];
    let colLabels = [];

    if (isSingleMonth) {
      const [y, m] = state.selectedMonth.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      // Find max day present or full days in month
      for (let d = 1; d <= daysInMonth; d++) {
        const dk = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        colKeys.push(dk);
        colLabels.push(String(d));
      }
      titleEl.textContent = `ตารางสรุปการใช้ช็อตรายวัน — ${window.ShotEngine.formatMonthLabel(state.selectedMonth)}`;
    } else {
      // Full-year view: columns = months chronologically!
      const monthsAsc = state.processed.months.slice().reverse();
      colKeys = monthsAsc.map(m => m.monthKey);
      colLabels = monthsAsc.map(m => m.shortLabel);
      titleEl.textContent = 'ตารางสรุปการใช้ช็อตรายเดือน — ภาพรวมทั้งปี';
    }

    // Aggregate cell totals & event details
    const cellValues = new Map(); // `${branch}|${colKey}` -> { sum, events }
    const branchTotals = new Map();
    const colTotals = new Map();
    let maxCellVal = 0;

    for (const ev of events) {
      const ck = isSingleMonth ? ev.dateKey : ev.monthKey;
      const key = `${ev.branch}|${ck}`;
      if (!cellValues.has(key)) cellValues.set(key, { sum: 0, events: [] });
      const cell = cellValues.get(key);
      cell.sum += ev.shotsUsed;
      cell.events.push(ev);

      branchTotals.set(ev.branch, (branchTotals.get(ev.branch) || 0) + ev.shotsUsed);
      colTotals.set(ck, (colTotals.get(ck) || 0) + ev.shotsUsed);
    }

    for (const c of cellValues.values()) {
      if (c.sum > maxCellVal) maxCellVal = c.sum;
    }

    // Build THEAD
    let headHtml = `<tr><th class="col-branch">สาขา (${branchesToShow.length})</th>`;
    for (let i = 0; i < colKeys.length; i++) {
      const subTitle = isSingleMonth ? `วันที่ ${colLabels[i]}` : colLabels[i];
      headHtml += `<th title="${escapeHtml(subTitle)}">${escapeHtml(colLabels[i])}</th>`;
    }
    headHtml += `<th class="col-total">รวมทั้งหมด</th></tr>`;
    thead.innerHTML = headHtml;

    // Sort branches by total desc for quick accounting scan
    const orderedBranches = branchesToShow.slice().sort((a, b) => (branchTotals.get(b) || 0) - (branchTotals.get(a) || 0));

    // Build TBODY
    let bodyHtml = '';
    for (const b of orderedBranches) {
      const bTotal = branchTotals.get(b) || 0;
      const mc = state.processed.branchMeta[b]?.machineCount || 1;
      bodyHtml += `<tr>`;
      bodyHtml += `<td class="col-branch">${escapeHtml(b)} <span style="font-size:11px;color:var(--ink-tertiary);font-weight:500;">(${mc} เครื่อง)</span></td>`;

      for (const ck of colKeys) {
        const key = `${b}|${ck}`;
        const cell = cellValues.get(key);
        if (!cell || cell.events.length === 0) {
          bodyHtml += `<td class="cell-empty">-</td>`;
          continue;
        }
        state.cellIndex.set(key, cell.events);

        const intensity = maxCellVal > 0 ? Math.min(1, cell.sum / maxCellVal) : 0;
        const bgStyle = cell.sum > 0
          ? `background: rgba(79, 70, 229, ${(0.03 + intensity * 0.14).toFixed(3)});`
          : '';

        const hasSwap = cell.events.some(e => e.status === 'HEAD_SWAP_NEW' || e.status === 'HEAD_SWAP_USED');
        const hasProrated = cell.events.some(e => e.isProrated);
        const hasMulti = !hasProrated && cell.events.some(e => e.status === 'MULTI_DAY');

        let flags = '';
        if (hasSwap) flags += `<span class="cell-flag swap" title="มีการเปลี่ยนหัว"></span>`;
        if (hasMulti) flags += `<span class="cell-flag multi" title="ยอดสะสมหลายวัน"></span>`;
        if (hasProrated) flags += `<span class="cell-flag prorated" title="ยอดเฉลี่ยวันขาดส่ง"></span>`;

        bodyHtml += `<td class="num cell-clickable" style="${bgStyle}" data-cell-key="${escapeHtml(key)}" title="คลิกเพื่อดูรายละเอียดเลขมิเตอร์">${fmtInt(cell.sum)}${flags}</td>`;
      }

      bodyHtml += `<td class="col-total num">${fmtInt(bTotal)}</td>`;
      bodyHtml += `</tr>`;
    }
    tbody.innerHTML = bodyHtml;

    // Build TFOOT (Grand Total row)
    let grandTotal = 0;
    let footHtml = `<tr><td class="col-branch">รวมทุกสาขา</td>`;
    for (const ck of colKeys) {
      const ct = colTotals.get(ck) || 0;
      grandTotal += ct;
      footHtml += `<td class="num">${ct > 0 ? fmtInt(ct) : '-'}</td>`;
    }
    footHtml += `<td class="col-total num">${fmtInt(grandTotal)}</td></tr>`;
    tfoot.innerHTML = footHtml;
  }

  // ---------- Side-by-Side Head 1 / Head 2 Daily Meter Comparison Table ----------
  function renderHeadCompareTable() {
    const sel = document.getElementById('headCompareBranchSelect');
    const table = document.getElementById('headCompareTable');
    if (!sel || !table || !state.processed) return;

    const branch = state.selectedBranch !== 'ALL' ? state.selectedBranch : sel.value;
    if (sel.value !== branch && branch) sel.value = branch;
    const meta = state.processed.branchMeta[branch];
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    const tfoot = table.querySelector('tfoot');

    if (!meta) {
      thead.innerHTML = '';
      tbody.innerHTML = '';
      tfoot.innerHTML = '';
      return;
    }

    const tracks = meta.tracks; // 1 or 2 tracks
    const rawEvents = state.processed.dailyEvents.filter(ev => {
      if (ev.branch !== branch) return false;
      if (state.selectedMonth !== 'ALL' && ev.monthKey !== state.selectedMonth) return false;
      return true;
    });

    // Group by dateKey -> trackId -> event
    const byDate = new Map();
    for (const ev of rawEvents) {
      if (!byDate.has(ev.dateKey)) byDate.set(ev.dateKey, { thaiDate: ev.thaiDate, byTrack: {} });
      byDate.get(ev.dateKey).byTrack[ev.trackId] = ev;
    }
    const sortedDates = Array.from(byDate.keys()).sort();

    // Header
    let hHtml = `<tr><th>วันที่</th>`;
    tracks.forEach((t, idx) => {
      hHtml += `<th class="right">หัว ${idx + 1} (${escapeHtml(t.label)}) — มิเตอร์สะสม</th>`;
      hHtml += `<th class="right">หัว ${idx + 1} — ใช้ไป</th>`;
    });
    hHtml += `<th class="right">รวมวันนั้น</th><th>หมายเหตุ</th></tr>`;
    thead.innerHTML = hHtml;

    const trackSums = tracks.map(() => 0);
    let grandSum = 0;
    let bHtml = '';

    for (const dk of sortedDates) {
      const row = byDate.get(dk);
      let daySum = 0;
      const notes = [];
      let cells = `<td class="num"><strong>${escapeHtml(row.thaiDate)}</strong></td>`;

      tracks.forEach((t, idx) => {
        const ev = row.byTrack[t.id];
        if (!ev) {
          cells += `<td class="right" style="color:#cbd5e1;">-</td><td class="right" style="color:#cbd5e1;">-</td>`;
        } else {
          daySum += ev.shotsUsed;
          trackSums[idx] += ev.shotsUsed;
          cells += `<td class="right num">${fmtInt(ev.curVal)}</td>`;
          cells += `<td class="right num" style="color:var(--accent);font-weight:600;">${ev.shotsUsed > 0 ? '+' + fmtInt(ev.shotsUsed) : '0'}</td>`;
          if (ev.status === 'HEAD_SWAP_NEW') notes.push(`<span class="badge badge-blue">หัว ${idx + 1} เปลี่ยนหัวใหม่</span>`);
          else if (ev.status === 'HEAD_SWAP_USED') notes.push(`<span class="badge badge-amber">หัว ${idx + 1} สลับหัวสำรอง</span>`);
          else if (ev.status === 'MULTI_DAY') notes.push(`<span class="badge badge-amber">หัว ${idx + 1} สะสม ${ev.dayGap} วัน</span>`);
          else if (ev.status === 'GAP_RESET') notes.push(`<span class="badge badge-amber">หัว ${idx + 1} ขาดส่ง ${ev.dayGap} วัน</span>`);
        }
      });

      grandSum += daySum;
      cells += `<td class="right num"><strong>${fmtInt(daySum)}</strong></td>`;
      cells += `<td>${notes.length ? notes.join(' ') : '<span class="badge badge-emerald"><span class="status-dot ok"></span>ปกติ</span>'}</td>`;
      bHtml += `<tr>${cells}</tr>`;
    }

    if (!sortedDates.length) {
      bHtml = `<tr><td colspan="${tracks.length * 2 + 3}" style="text-align:center;color:var(--ink-tertiary);padding:20px;">ไม่พบข้อมูลในช่วงเวลาที่เลือก</td></tr>`;
    }
    tbody.innerHTML = bHtml;

    // Footer totals
    let fHtml = `<tr style="background:#f1f5f9;font-weight:700;"><td>รวม (${sortedDates.length} วัน)</td>`;
    tracks.forEach((_, idx) => {
      fHtml += `<td class="right">-</td><td class="right num" style="color:var(--accent);">${fmtInt(trackSums[idx])}</td>`;
    });
    fHtml += `<td class="right num" style="color:var(--accent);">${fmtInt(grandSum)}</td><td></td></tr>`;
    tfoot.innerHTML = fHtml;
  }

  // ---------- Branch Summary Ranking Table ----------
  function renderBranchSummaryTable(events) {
    const tbody = document.querySelector('#branchSummaryTable tbody');
    const costHeader = document.querySelector('.col-cost-header');
    const showCost = state.costPerShot > 0;
    costHeader.style.display = showCost ? '' : 'none';

    const byBranch = new Map();
    let grandTotal = 0;

    for (const ev of events) {
      grandTotal += ev.shotsUsed;
      if (!byBranch.has(ev.branch)) {
        byBranch.set(ev.branch, { branch: ev.branch, total: 0, dayMap: new Map() });
      }
      const rec = byBranch.get(ev.branch);
      rec.total += ev.shotsUsed;
      rec.dayMap.set(ev.dateKey, (rec.dayMap.get(ev.dateKey) || 0) + ev.shotsUsed);
    }

    const list = Array.from(byBranch.values()).sort((a, b) => b.total - a.total);
    let html = '';

    list.forEach((item, idx) => {
      const activeDays = Array.from(item.dayMap.values()).filter(v => v > 0).length;
      const avg = activeDays > 0 ? item.total / activeDays : 0;
      const maxDay = Math.max(0, ...Array.from(item.dayMap.values()));
      const share = grandTotal > 0 ? (item.total / grandTotal) * 100 : 0;
      const mc = state.processed.branchMeta[item.branch]?.machineCount || 1;

      html += `<tr style="cursor:pointer;" data-pick-branch="${escapeHtml(item.branch)}">
        <td class="num">${idx + 1}</td>
        <td><strong>${escapeHtml(item.branch)}</strong></td>
        <td class="right num">${mc}</td>
        <td class="right num">${activeDays}</td>
        <td class="right num"><strong>${fmtInt(item.total)}</strong></td>
        <td class="right num">${fmtInt(avg)}</td>
        <td class="right num">${fmtInt(maxDay)}</td>
        <td class="right num">${share.toFixed(1)}%</td>
        ${showCost ? `<td class="right num">฿${fmtMoney(item.total * state.costPerShot)}</td>` : ''}
      </tr>`;
    });

    if (!list.length) {
      html = `<tr><td colspan="${showCost ? 9 : 8}" style="text-align:center;color:var(--ink-tertiary);padding:24px;">ไม่พบข้อมูลในช่วงเวลาที่เลือก</td></tr>`;
    }
    tbody.innerHTML = html;
  }

  // ---------- TAB 2: Chart.js Visualizations ----------
  function destroyChart(key) {
    if (state.charts[key]) {
      state.charts[key].destroy();
      state.charts[key] = null;
    }
  }

  function renderCharts(events) {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.font.family = "'Inter', 'IBM Plex Sans Thai', sans-serif";
    Chart.defaults.color = '#667085';

    renderDailyTrendChart(events);
    renderBranchBarAndShareCharts(events);
    renderMonthlyTrendChart();
  }

  function renderDailyTrendChart(events) {
    destroyChart('daily');
    const ctx = document.getElementById('dailyTrendChart');
    const titleEl = document.getElementById('dailyChartTitle');

    const datesSet = new Set(events.map(e => e.dateKey));
    const sortedDates = Array.from(datesSet).sort();

    let datasets = [];

    if (state.selectedBranch !== 'ALL') {
      // Single branch selected -> stack by machine!
      titleEl.textContent = `แนวโน้มการใช้ช็อตรายวัน — สาขา${state.selectedBranch} (แยกตามเครื่อง)`;
      const machineNames = Array.from(new Set(events.map(e => e.machineLabel)));
      datasets = machineNames.map((mLabel, idx) => {
        const map = new Map();
        for (const ev of events) {
          if (ev.machineLabel === mLabel) {
            map.set(ev.dateKey, (map.get(ev.dateKey) || 0) + ev.shotsUsed);
          }
        }
        return {
          label: mLabel,
          data: sortedDates.map(dk => map.get(dk) || 0),
          backgroundColor: PALETTE[idx % PALETTE.length] + 'cc',
          borderColor: PALETTE[idx % PALETTE.length],
          borderWidth: 1.5,
          borderRadius: 4
        };
      });
    } else {
      titleEl.textContent = `แนวโน้มการใช้ช็อตรายวันรวมทุกสาขา — ${window.ShotEngine.formatMonthLabel(state.selectedMonth)}`;
      const map = new Map();
      for (const ev of events) {
        map.set(ev.dateKey, (map.get(ev.dateKey) || 0) + ev.shotsUsed);
      }
      const values = sortedDates.map(dk => map.get(dk) || 0);
      const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

      datasets = [
        {
          type: 'bar',
          label: 'ยอดใช้ช็อตรายวัน',
          data: values,
          backgroundColor: 'rgba(79, 70, 229, 0.84)',
          hoverBackgroundColor: '#4338ca',
          borderRadius: 4,
          order: 2
        },
        {
          type: 'line',
          label: `ค่าเฉลี่ย (${fmtInt(avg)})`,
          data: sortedDates.map(() => Math.round(avg)),
          borderColor: '#101828',
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false,
          order: 1
        }
      ];
    }

    const labels = sortedDates.map(dk => {
      if (state.selectedMonth !== 'ALL') {
        return 'วันที่ ' + Number(dk.split('-')[2]);
      }
      return window.ShotEngine.formatThaiDateShort(dk);
    });

    state.charts.daily = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: state.selectedBranch !== 'ALL', border: { display: false }, grid: { display: false } },
          y: {
            stacked: state.selectedBranch !== 'ALL',
            beginAtZero: true,
            border: { display: false },
            grid: { color: '#f2f4f7' },
            ticks: { callback: v => fmtInt(v) }
          }
        },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
          tooltip: {
            ...STRIPE_TOOLTIP,
            callbacks: {
              label: c => `${c.dataset.label}: ${fmtInt(c.parsed.y)} ช็อต`
            }
          }
        }
      }
    });
  }

  function renderBranchBarAndShareCharts(events) {
    destroyChart('branchBar');
    destroyChart('branchShare');

    // Compute branch totals for selected month across ALL branches so comparison stays meaningful
    const expanded = window.ShotEngine.expandEventsByMode(state.processed.dailyEvents, state.gapMode);
    const branchTotals = new Map();
    for (const ev of expanded) {
      if (state.selectedMonth !== 'ALL' && ev.monthKey !== state.selectedMonth) continue;
      branchTotals.set(ev.branch, (branchTotals.get(ev.branch) || 0) + ev.shotsUsed);
    }

    const ranked = Array.from(branchTotals.entries()).sort((a, b) => b[1] - a[1]);
    const labels = ranked.map(r => r[0]);
    const values = ranked.map(r => r[1]);

    // 1. Horizontal Bar Chart
    const barCtx = document.getElementById('branchBarChart');
    state.charts.branchBar = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'ยอดใช้ช็อตรวม',
          data: values,
          backgroundColor: labels.map((b, i) => {
            if (state.selectedBranch !== 'ALL' && b !== state.selectedBranch) return '#e4e7ec';
            return i < 3 ? '#101828' : '#4f46e5';
          }),
          borderRadius: 4,
          barThickness: 15
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_, elements) => {
          if (elements && elements.length > 0) {
            const clickedBranch = labels[elements[0].index];
            state.selectedBranch = state.selectedBranch === clickedBranch ? 'ALL' : clickedBranch;
            document.getElementById('branchSelect').value = state.selectedBranch;
            renderAll();
          }
        },
        scales: {
          x: { beginAtZero: true, border: { display: false }, grid: { color: '#f2f4f7' }, ticks: { callback: v => fmtInt(v) } },
          y: { border: { display: false }, grid: { display: false }, ticks: { color: '#344054', font: { weight: '500' } } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...STRIPE_TOOLTIP,
            callbacks: {
              label: c => `${fmtInt(c.parsed.x)} ช็อต`
            }
          }
        }
      }
    });

    // 2. Doughnut Share Chart (Top 8 + Others)
    const top8 = ranked.slice(0, 8);
    const restSum = ranked.slice(8).reduce((s, r) => s + r[1], 0);
    const dLabels = top8.map(r => r[0]);
    const dValues = top8.map(r => r[1]);
    if (restSum > 0) {
      dLabels.push(`อื่นๆ (${ranked.length - 8} สาขา)`);
      dValues.push(restSum);
    }
    const grand = dValues.reduce((a, b) => a + b, 0);

    const shareCtx = document.getElementById('branchShareChart');
    state.charts.branchShare = new Chart(shareCtx, {
      type: 'doughnut',
      data: {
        labels: dLabels,
        datasets: [{
          data: dValues,
          backgroundColor: dLabels.map((_, i) => i === 8 ? '#94a3b8' : PALETTE[i % PALETTE.length]),
          borderWidth: 2,
          borderColor: '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 12, font: { size: 11.5 } } },
          tooltip: {
            ...STRIPE_TOOLTIP,
            callbacks: {
              label: c => {
                const pct = grand > 0 ? ((c.parsed / grand) * 100).toFixed(1) : '0.0';
                return `${c.label}: ${fmtInt(c.parsed)} ช็อต (${pct}%)`;
              }
            }
          }
        }
      }
    });
  }

  function renderMonthlyTrendChart() {
    destroyChart('monthly');
    const ctx = document.getElementById('monthlyTrendChart');

    const monthsAsc = state.processed.months.slice().reverse();
    const expanded = window.ShotEngine.expandEventsByMode(state.processed.dailyEvents, state.gapMode);

    const monthTotals = new Map();
    for (const ev of expanded) {
      if (state.selectedBranch !== 'ALL' && ev.branch !== state.selectedBranch) continue;
      monthTotals.set(ev.monthKey, (monthTotals.get(ev.monthKey) || 0) + ev.shotsUsed);
    }

    const labels = monthsAsc.map(m => m.shortLabel);
    const values = monthsAsc.map(m => monthTotals.get(m.monthKey) || 0);

    state.charts.monthly = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: state.selectedBranch === 'ALL' ? 'ยอดใช้ช็อตรวมทุกสาขา' : `สาขา${state.selectedBranch}`,
          data: values,
          backgroundColor: monthsAsc.map(m =>
            m.monthKey === state.selectedMonth ? '#101828' : '#c7d2fe'
          ),
          hoverBackgroundColor: '#4f46e5',
          borderRadius: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_, elements) => {
          if (elements && elements.length > 0) {
            state.selectedMonth = monthsAsc[elements[0].index].monthKey;
            document.getElementById('monthSelect').value = state.selectedMonth;
            renderAll();
          }
        },
        scales: {
          x: { border: { display: false }, grid: { display: false } },
          y: { beginAtZero: true, border: { display: false }, grid: { color: '#f2f4f7' }, ticks: { callback: v => fmtInt(v) } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...STRIPE_TOOLTIP,
            callbacks: {
              label: c => `${fmtInt(c.parsed.y)} ช็อต`
            }
          }
        }
      }
    });
  }

  // ---------- TAB 3: Machine Health & Head Lifespan ----------
  function renderMachines() {
    const grid = document.getElementById('machineGrid');
    const badgesEl = document.getElementById('machineSummaryBadges');
    const branches = state.selectedBranch === 'ALL'
      ? state.processed.branches
      : [state.selectedBranch];

    let totalMachines = 0;
    let warnMachines = 0;
    let totalSwaps = 0;
    let html = '';

    for (const b of branches) {
      const meta = state.processed.branchMeta[b];
      if (!meta) continue;
      totalMachines += meta.tracks.length;

      let tracksHtml = '';
      for (const t of meta.tracks) {
        totalSwaps += t.headSwaps.length;
        const isDanger = t.remaining < 800000;
        const isWarn = !isDanger && t.remaining < state.settings.lowRemainingWarning;
        if (isDanger || isWarn) warnMachines++;

        const barClass = isDanger ? 'danger' : (isWarn ? 'warn' : '');
        const statusBadge = isDanger
          ? '<span class="badge badge-rose">ใกล้หมดหัว!</span>'
          : (isWarn ? '<span class="badge badge-amber">เตรียมสำรองหัว</span>' : '<span class="badge badge-emerald">ปกติ</span>');

        const swapNote = t.headSwaps.length > 0
          ? `<div style="margin-top:6px;font-size:11.5px;color:var(--accent);">เปลี่ยนหัวแล้ว ${t.headSwaps.length} ครั้ง (ล่าสุด ${t.headSwaps[t.headSwaps.length - 1].thaiDate})</div>`
          : '';

        tracksHtml += `
          <div class="machine-item">
            <div class="machine-row-top">
              <span>${escapeHtml(t.label)}</span>
              ${statusBadge}
            </div>
            <div class="progress-track">
              <div class="progress-fill ${barClass}" style="width: ${t.usedPct.toFixed(1)}%;"></div>
            </div>
            <div class="machine-stats">
              <span>มิเตอร์ล่าสุด: <strong class="num">${fmtInt(t.lastVal)}</strong></span>
              <span>คงเหลือ: <strong class="num">${fmtInt(t.remaining)}</strong></span>
            </div>
            <div class="machine-stats" style="margin-top:3px;color:var(--ink-tertiary);">
              <span>อัปเดตล่าสุด: ${escapeHtml(t.lastThaiDate)}</span>
              <span>ใช้ไป ${t.usedPct.toFixed(1)}%</span>
            </div>
            ${swapNote}
          </div>`;
      }

      html += `
        <article class="branch-health-card">
          <div class="branch-health-head">
            <span class="branch-health-name">${escapeHtml(b)}</span>
            <span class="badge badge-blue">${meta.tracks.length} เครื่อง</span>
          </div>
          ${tracksHtml}
        </article>`;
    }

    grid.innerHTML = html;
    badgesEl.innerHTML = `
      <span class="badge badge-blue">เครื่องทั้งหมด ${totalMachines} เครื่อง</span>
      <span class="badge ${warnMachines > 0 ? 'badge-amber' : 'badge-emerald'}">ใกล้ครบ 10M: ${warnMachines} เครื่อง</span>
      <span class="badge badge-slate">ประวัติเปลี่ยนหัว: ${totalSwaps} ครั้ง</span>
    `;
  }

  // ---------- TAB 4: Audit Log ----------
  function renderAudits(audits) {
    const tbody = document.querySelector('#auditTable tbody');
    const countLabel = document.getElementById('auditCountLabel');
    const q = state.auditSearch.trim().toLowerCase();

    const filtered = audits.filter(a => {
      if (state.auditType === 'ERROR_ONLY' && a.severity !== 'error') return false;
      if (state.auditType === 'HEAD_SWAP' && a.type !== 'HEAD_SWAP_NEW' && a.type !== 'HEAD_SWAP_USED') return false;
      if (state.auditType === 'MULTI_DAY' && a.type !== 'MULTI_DAY') return false;
      if (q) {
        const hay = `${a.thaiDate} ${a.branch} ${a.machineId} ${a.rawCurrent} ${a.typeLabel} ${a.message}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    countLabel.textContent = `แสดง ${fmtInt(filtered.length)} จาก ${fmtInt(audits.length)} รายการ`;

    let html = '';
    const slice = filtered.slice(0, 500);
    for (const a of slice) {
      const badgeCls = a.severity === 'error'
        ? 'badge-rose'
        : (a.severity === 'warning' ? 'badge-amber' : 'badge-blue');
      html += `
        <tr>
          <td class="num">${escapeHtml(a.thaiDate)}</td>
          <td><strong>${escapeHtml(a.branch)}</strong></td>
          <td><span class="badge ${badgeCls}">${escapeHtml(a.typeLabel)}</span></td>
          <td style="font-size:12.5px;color:var(--ink-secondary);">${escapeHtml(a.machineId)}</td>
          <td class="right num"><code>${escapeHtml(a.rawCurrent || '-')}</code></td>
          <td class="right num">${a.prevVal !== null ? fmtInt(a.prevVal) : '-'}</td>
          <td style="font-size:12.5px;">${escapeHtml(a.message)}</td>
        </tr>`;
    }

    if (!slice.length) {
      html = `<tr><td colspan="7" style="text-align:center;color:var(--ink-tertiary);padding:28px;">ไม่พบรายการผิดปกติตามเงื่อนไขที่เลือก</td></tr>`;
    }
    tbody.innerHTML = html;
  }

  // ---------- Drill-Down Modal (click any cell in accounting matrix) ----------
  function openCellDrilldown(cellKey) {
    const events = state.cellIndex.get(cellKey);
    if (!events || !events.length) return;

    const [branch, periodKey] = cellKey.split('|');
    const isDate = periodKey.length === 10;
    const periodText = isDate
      ? window.ShotEngine.formatThaiDateShort(periodKey)
      : window.ShotEngine.formatMonthLabel(periodKey);

    const total = events.reduce((s, e) => s + e.shotsUsed, 0);
    document.getElementById('drillModalTitle').textContent = `หลักฐานการคำนวณช็อต: สาขา${branch} (${periodText})`;

    let rowsHtml = '';
    for (const ev of events) {
      const statusMap = {
        OK: '<span class="badge badge-emerald">ปกติ</span>',
        MULTI_DAY: `<span class="badge badge-amber">สะสม ${ev.dayGap} วัน</span>`,
        HEAD_SWAP_NEW: '<span class="badge badge-blue">เปลี่ยนหัวใหม่</span>',
        HEAD_SWAP_USED: '<span class="badge badge-amber">สลับหัวสำรอง</span>',
        GAP_RESET: `<span class="badge badge-amber">ขาดส่ง ${ev.dayGap} วัน (ตั้งฐานใหม่)</span>`,
        BASELINE: '<span class="badge badge-slate">ค่าตั้งต้น</span>'
      };
      const badge = ev.isProrated
        ? `<span class="badge badge-blue">เฉลี่ย 1/${ev.dayGap} (จาก ${fmtInt(ev.originalTotalShots)})</span>`
        : (statusMap[ev.status] || ev.status);

      rowsHtml += `
        <tr>
          <td class="num">${escapeHtml(ev.thaiDate)}</td>
          <td>${escapeHtml(ev.machineLabel)}</td>
          <td class="right num">${ev.prevVal !== null ? fmtInt(ev.prevVal) : '-'}<br><span style="font-size:11px;color:var(--ink-tertiary);">${escapeHtml(ev.prevThaiDate || '')}</span></td>
          <td class="right num">${fmtInt(ev.curVal)}</td>
          <td class="right num"><strong>${fmtInt(ev.shotsUsed)}</strong></td>
          <td>${badge}</td>
        </tr>`;
    }

    document.getElementById('drillModalBody').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding:12px 14px;background:var(--accent-soft);border-radius:10px;">
        <div>
          <div style="font-size:12.5px;color:var(--ink-secondary);">ยอดช็อตที่ใช้รวม (${events.length} รายการ)</div>
          <div style="font-size:24px;font-weight:700;color:var(--accent);" class="num">${fmtInt(total)} ช็อต</div>
        </div>
        ${state.costPerShot > 0 ? `<div style="text-align:right;"><div style="font-size:12px;color:var(--ink-secondary);">ประมาณการต้นทุน</div><div style="font-size:18px;font-weight:700;color:var(--emerald);" class="num">฿${fmtMoney(total * state.costPerShot)}</div></div>` : ''}
      </div>
      <div class="table-scroll" style="max-height:420px;">
        <table class="simple-table">
          <thead>
            <tr>
              <th>วันที่</th>
              <th>เครื่อง</th>
              <th class="right">มิเตอร์ก่อนหน้า</th>
              <th class="right">มิเตอร์ปัจจุบัน</th>
              <th class="right">ช็อตที่ใช้</th>
              <th>สถานะ</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;

    openModal('drillModal');
  }

  // ---------- CSV Exports for Accounting ----------
  function exportMatrixCsv() {
    if (!state.processed) return;
    const events = getActiveEvents();
    const isSingleMonth = state.selectedMonth !== 'ALL';
    const branches = state.selectedBranch === 'ALL' ? state.processed.branches : [state.selectedBranch];

    let colKeys = [];
    let colLabels = [];
    if (isSingleMonth) {
      const [y, m] = state.selectedMonth.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        colKeys.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
        colLabels.push(`${d}/${m}/${y + 543}`);
      }
    } else {
      const monthsAsc = state.processed.months.slice().reverse();
      colKeys = monthsAsc.map(m => m.monthKey);
      colLabels = monthsAsc.map(m => m.label);
    }

    const cellMap = new Map();
    const branchTotals = new Map();
    const colTotals = new Map();
    for (const ev of events) {
      const ck = isSingleMonth ? ev.dateKey : ev.monthKey;
      const key = `${ev.branch}|${ck}`;
      cellMap.set(key, (cellMap.get(key) || 0) + ev.shotsUsed);
      branchTotals.set(ev.branch, (branchTotals.get(ev.branch) || 0) + ev.shotsUsed);
      colTotals.set(ck, (colTotals.get(ck) || 0) + ev.shotsUsed);
    }

    const rows = [];
    const header = ['สาขา', 'จำนวนเครื่อง', ...colLabels, 'รวมทั้งหมด'];
    if (state.costPerShot > 0) header.push(`ต้นทุนประมาณการ (${state.costPerShot} บาท/ช็อต)`);
    rows.push(header);

    const ordered = branches.slice().sort((a, b) => (branchTotals.get(b) || 0) - (branchTotals.get(a) || 0));
    let grand = 0;
    for (const b of ordered) {
      const total = branchTotals.get(b) || 0;
      grand += total;
      const mc = state.processed.branchMeta[b]?.machineCount || 1;
      const line = [b, mc, ...colKeys.map(ck => cellMap.get(`${b}|${ck}`) || 0), total];
      if (state.costPerShot > 0) line.push((total * state.costPerShot).toFixed(2));
      rows.push(line);
    }

    const totalLine = ['รวมทุกสาขา', '', ...colKeys.map(ck => colTotals.get(ck) || 0), grand];
    if (state.costPerShot > 0) totalLine.push((grand * state.costPerShot).toFixed(2));
    rows.push(totalLine);

    const suffix = state.selectedMonth === 'ALL' ? 'all_year' : state.selectedMonth;
    downloadCsv(`shot_summary_accounting_${suffix}_${state.gapMode}.csv`, rows);
  }

  function exportDetailCsv() {
    if (!state.processed) return;
    const events = getActiveEvents().slice().sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.branch.localeCompare(b.branch, 'th'));
    const rows = [
      ['วันที่ (พ.ศ.)', 'วันที่ (ISO)', 'สาขา', 'หมายเลขเครื่อง', 'วันที่ก่อนหน้า', 'มิเตอร์ก่อนหน้า', 'มิเตอร์ปัจจุบัน', 'ช็อตที่ใช้', 'ช่วงห่าง (วัน)', 'สถานะ', 'ค่าดิบใน Sheet']
    ];
    for (const ev of events) {
      rows.push([
        ev.thaiDate,
        ev.dateKey,
        ev.branch,
        ev.machineLabel,
        ev.prevThaiDate || '',
        ev.prevVal !== null ? ev.prevVal : '',
        ev.curVal,
        ev.shotsUsed,
        ev.dayGap,
        ev.isProrated ? 'PRORATED' : ev.status,
        ev.rawCurrent
      ]);
    }
    const suffix = state.selectedMonth === 'ALL' ? 'all_year' : state.selectedMonth;
    downloadCsv(`shot_detail_ledger_${suffix}_${state.gapMode}.csv`, rows);
  }

  // ---------- Modals ----------
  function openModal(id) {
    document.getElementById(id).classList.add('open');
  }

  function closeModal(id) {
    document.getElementById(id).classList.remove('open');
  }

  function openSettingsModal() {
    document.getElementById('cfgSpreadsheetId').value = state.settings.spreadsheetId || '';
    document.getElementById('cfgSheetName').value = state.settings.sheetName || 'Sheet1';
    document.getElementById('cfgAppsScriptUrl').value = state.settings.appsScriptUrl || '';
    document.getElementById('cfgRefreshMinutes').value = Math.round((state.settings.autoRefreshMs || 300000) / 60000);
    document.getElementById('cfgMaxPerDay').value = state.settings.maxShotsPerMachinePerDay || 250000;
    openModal('settingsModal');
  }

  function switchTab(tabId) {
    let activeNav = null;
    document.querySelectorAll('.nav-item[data-tab], .tab-btn[data-tab]').forEach(btn => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
      if (active) activeNav = btn;
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === tabId);
    });
    if (activeNav) {
      const titleEl = document.getElementById('pageTitle');
      const subEl = document.getElementById('pageSubtitle');
      if (titleEl && activeNav.dataset.title) titleEl.textContent = activeNav.dataset.title;
      if (subEl && activeNav.dataset.subtitle) subEl.textContent = activeNav.dataset.subtitle;
    }
    // Close mobile sidebar drawer on selection
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sidebarOverlay');
    if (sb) sb.classList.remove('open');
    if (ov) ov.classList.remove('open');

    if (tabId === 'tab-overview' && state.processed) {
      // Ensure Chart.js resizes cleanly when tab becomes visible
      setTimeout(() => renderCharts(getActiveEvents()), 30);
    } else if (tabId === 'tab-ranking' && state.processed) {
      setTimeout(() => renderRanking(), 30);
    }
  }

  // ---------- Event Wiring ----------
  function bindEvents() {
    document.getElementById('scopeSelect').addEventListener('change', e => {
      state.scopeMode = e.target.value;
      reprocessData();
      populateFilters();
      renderAll();
    });

    document.getElementById('monthSelect').addEventListener('change', e => {
      state.selectedMonth = e.target.value;
      renderAll();
    });

    document.getElementById('branchSelect').addEventListener('change', e => {
      state.selectedBranch = e.target.value;
      renderAll();
    });

    document.getElementById('headCompareBranchSelect').addEventListener('change', () => {
      renderHeadCompareTable();
    });

    document.getElementById('rankingMetricSelect').addEventListener('change', e => {
      state.rankingMetric = e.target.value;
      renderRanking();
    });

    document.getElementById('rankingAsOfDate').addEventListener('change', e => {
      state.rankingAsOfDate = e.target.value;
      renderRanking();
    });

    document.querySelectorAll('[data-rank-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-rank-view]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.rankingView = btn.dataset.rankView;
        renderRanking();
      });
    });

    document.getElementById('btnExportRanking').addEventListener('click', exportRankingCsv);

    document.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.gapMode = btn.dataset.mode;
        renderAll();
      });
    });

    document.getElementById('costPerShotInput').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      state.costPerShot = Number.isFinite(v) && v >= 0 ? v : 0;
      renderAll();
    });

    document.querySelectorAll('.nav-item[data-tab], .tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    const btnMob = document.getElementById('btnMobileMenu');
    const sbEl = document.getElementById('sidebar');
    const ovEl = document.getElementById('sidebarOverlay');
    if (btnMob && sbEl && ovEl) {
      btnMob.addEventListener('click', () => {
        sbEl.classList.toggle('open');
        ovEl.classList.toggle('open');
      });
      ovEl.addEventListener('click', () => {
        sbEl.classList.remove('open');
        ovEl.classList.remove('open');
      });
    }

    document.getElementById('kpiAuditCard').addEventListener('click', () => switchTab('tab-audit'));

    document.getElementById('matrixTable').addEventListener('click', e => {
      const td = e.target.closest('td[data-cell-key]');
      if (td) openCellDrilldown(td.dataset.cellKey);
    });

    document.querySelector('#branchSummaryTable tbody').addEventListener('click', e => {
      const tr = e.target.closest('tr[data-pick-branch]');
      if (!tr) return;
      const b = tr.dataset.pickBranch;
      state.selectedBranch = state.selectedBranch === b ? 'ALL' : b;
      document.getElementById('branchSelect').value = state.selectedBranch;
      renderAll();
    });

    document.getElementById('auditTypeFilter').addEventListener('change', e => {
      state.auditType = e.target.value;
      renderAudits(getActiveAudits());
    });

    document.getElementById('auditSearchInput').addEventListener('input', e => {
      state.auditSearch = e.target.value;
      renderAudits(getActiveAudits());
    });

    document.getElementById('btnRefresh').addEventListener('click', () => loadData(true));
    document.getElementById('btnExportMatrix').addEventListener('click', exportMatrixCsv);
    document.getElementById('btnExportDetail').addEventListener('click', exportDetailCsv);
    document.getElementById('btnPrint').addEventListener('click', () => window.print());
    document.getElementById('btnSettings').addEventListener('click', openSettingsModal);
    document.getElementById('btnOpenSetupFromBanner').addEventListener('click', openSettingsModal);

    document.getElementById('btnSaveSettings').addEventListener('click', () => {
      const mins = Math.max(1, parseInt(document.getElementById('cfgRefreshMinutes').value, 10) || 5);
      const maxPerDay = Math.max(50000, parseInt(document.getElementById('cfgMaxPerDay').value, 10) || 250000);
      state.settings = window.saveSettings({
        spreadsheetId: document.getElementById('cfgSpreadsheetId').value.trim(),
        sheetName: document.getElementById('cfgSheetName').value.trim() || 'Sheet1',
        appsScriptUrl: document.getElementById('cfgAppsScriptUrl').value.trim(),
        autoRefreshMs: mins * 60 * 1000,
        maxShotsPerMachinePerDay: maxPerDay
      });
      closeModal('settingsModal');
      loadData(true);
    });

    document.getElementById('btnResetSettings').addEventListener('click', () => {
      try { localStorage.removeItem(window.DASHBOARD_CONFIG.storageKey); } catch (_) {}
      state.settings = { ...window.DASHBOARD_CONFIG };
      openSettingsModal();
    });

    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });

    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', e => {
        if (e.target === backdrop) backdrop.classList.remove('open');
      });
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
      }
    });
  }

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    loadData(false);
  });
})();
