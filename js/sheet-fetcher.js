/**
 * Automatic Google Sheets Live Fetcher
 * รองรับการดึงข้อมูลอัตโนมัติ 3 ช่องทาง + Fallback Snapshot:
 *   1) Google Apps Script Web App URL (ถ้าผู้ใช้ตั้งค่าไว้ — ใช้ได้แม้ Sheet เป็น Private)
 *   2) Google Visualization API via JSONP (ไม่ต้องใช้ API Key, ไม่ติด CORS แม้เปิดผ่าน file:// หรือ GitHub Pages, เพียงแชร์ Sheet เป็น "ผู้ที่มีลิงก์สามารถดูได้")
 *   3) Google Sheets CSV Export (ทางเลือกสำรองบน HTTPS)
 *   4) Local Snapshot (window.SHEET_SNAPSHOT) กรณีออฟไลน์หรือยังไม่ได้เปิดสิทธิ์แชร์
 */
(function (global) {
  'use strict';

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          row.push(field);
          field = '';
        } else if (ch === '\r') {
          // skip CR
        } else if (ch === '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function normalizeSheet1Rows(rawRows) {
    const normalized = [];
    for (let i = 0; i < rawRows.length; i++) {
      const r = rawRows[i];
      if (!r || r.length < 6) continue;
      const col0 = String(r[0] ?? '').trim();
      const col4 = String(r[4] ?? '').trim();
      const col5 = String(r[5] ?? '').trim();
      // Skip header row
      if (i === 0 && (col0.includes('หมายเลขเครื่อง') || col5 === 'สาขา')) continue;
      if (!col4 || !col5 || col5 === '#N/A' || col5 === '#VALUE!') continue;
      normalized.push([
        col0,
        String(r[1] ?? '').trim(),
        String(r[2] ?? '').trim(),
        col4,
        col5
      ]);
    }
    return normalized;
  }

  /**
   * Method 1: Fetch via Google Apps Script Web App JSON
   */
  async function fetchFromAppsScript(url) {
    const cleanUrl = url.trim();
    if (!cleanUrl) throw new Error('No Apps Script URL configured');
    const sep = cleanUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${cleanUrl}${sep}_ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
    const data = await res.json();
    const rawRows = Array.isArray(data) ? data : (data.rows || data.values || []);
    const rows = normalizeSheet1Rows(rawRows);
    if (!rows.length) throw new Error('Apps Script returned 0 valid rows');
    return {
      source: 'apps_script',
      sourceLabel: 'Google Apps Script (Live)',
      fetchedAt: new Date().toISOString(),
      rows
    };
  }

  function extractYearAndTime(rawM, rawE) {
    const mStr = String(rawM ?? '').trim();
    // Match "2569 20:52" or "2569"
    let match = mStr.match(/(\d{4})(?:\s+(\d{1,2}:\d{2}))?/);
    if (match) {
      const y = parseInt(match[1], 10);
      if (y >= 2000 && y <= 2700) {
        return { year: y, time: match[2] || '' };
      }
    }
    const eStr = String(rawE ?? '').trim();
    // Match GViz Date(2569,0,2) or string "2/1/2569 20:52"
    match = eStr.match(/Date\((\d{4}),/);
    if (match) {
      const y = parseInt(match[1], 10);
      if (y >= 2000 && y <= 2700) return { year: y, time: '' };
    }
    match = eStr.match(/\/(\d{4})(?:\s+(\d{1,2}:\d{2}))?/);
    if (match) {
      const y = parseInt(match[1], 10);
      if (y >= 2000 && y <= 2700) return { year: y, time: match[2] || '' };
    }
    return { year: null, time: '' };
  }

  /**
   * Method 2: Fetch via Google Visualization JSONP (CORS-free, works on file:// and GitHub Pages)
   * IMPORTANT: Queries K (Day) & L (Month) as pure numbers so Google Sheets en_US locale
   * never swaps M/D or drops day 13-31 string rows!
   */
  function fetchFromGvizJsonp(spreadsheetId, sheetName, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const cbName = '__gvizSheetCb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      const script = document.createElement('script');
      let settled = false;

      const cleanup = () => {
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete global[cbName]; } catch (_) { global[cbName] = undefined; }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Google Sheet GViz timeout (อาจยังไม่ได้เปิดแชร์แบบผู้ที่มีลิงก์ดูได้)'));
      }, timeoutMs);

      global[cbName] = function (response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();

        if (!response || response.status === 'error' || !response.table) {
          const msg = response && response.errors && response.errors[0]
            ? response.errors[0].detailed_message || response.errors[0].message
            : 'Invalid GViz response';
          reject(new Error(msg));
          return;
        }

        // Columns requested: 0:A(machine), 1:B(current), 2:C(remaining), 3:E(rawDate), 4:F(branch), 5:K(day), 6:L(month), 7:M(yearTime)
        const tableRows = response.table.rows || [];
        const temp = [];

        for (let i = 0; i < tableRows.length; i++) {
          const cells = tableRows[i].c || [];
          const getCell = (idx) => {
            const c = cells[idx];
            if (!c) return '';
            if (c.f !== undefined && c.f !== null && c.f !== '') return String(c.f);
            if (c.v !== undefined && c.v !== null) return String(c.v);
            return '';
          };

          const machineId = getCell(0).trim();
          const rawCurrent = getCell(1).trim();
          const rawRemaining = getCell(2).trim();
          const rawE = getCell(3).trim();
          const branch = getCell(4).trim();
          const dayNum = parseInt(getCell(5), 10);
          const monthNum = parseInt(getCell(6), 10);
          const rawM = getCell(7).trim();

          if (!branch || branch === '#N/A' || branch === '#VALUE!' || branch === 'สาขา') continue;
          if (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > 31) continue;
          if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) continue;

          const yt = extractYearAndTime(rawM, rawE);
          temp.push({
            machineId,
            rawCurrent,
            rawRemaining,
            branch,
            day: dayNum,
            month: monthNum,
            year: yt.year,
            time: yt.time
          });
        }

        // Chronologically fill any rows where GViz nulled out mixed-type year column M
        let firstKnownYear = null;
        for (let i = 0; i < temp.length; i++) {
          if (temp[i].year !== null) {
            firstKnownYear = temp[i].year;
            break;
          }
        }
        if (firstKnownYear === null) {
          firstKnownYear = new Date().getFullYear() + 543;
        }

        let curYear = firstKnownYear;
        let prevMonth = temp.length > 0 ? temp[0].month : 1;
        const rows = [];

        for (let i = 0; i < temp.length; i++) {
          const item = temp[i];
          if (item.year !== null) {
            curYear = item.year;
          } else if (prevMonth >= 11 && item.month <= 2) {
            curYear += 1;
          }
          prevMonth = item.month;

          const dateStr = `${item.day}/${item.month}/${curYear}${item.time ? ' ' + item.time : ''}`;
          rows.push([
            item.machineId,
            item.rawCurrent,
            item.rawRemaining,
            dateStr,
            item.branch
          ]);
        }

        if (!rows.length) {
          reject(new Error('GViz returned 0 valid rows'));
          return;
        }

        resolve({
          source: 'gviz_live',
          sourceLabel: 'Google Sheet สด (อัตโนมัติ)',
          fetchedAt: new Date().toISOString(),
          rows
        });
      };

      // Query K (Day) and L (Month) as pure integers so mixed-type column E never drops days 13..31!
      const tq = encodeURIComponent('select A,B,C,E,F,K,L,M where K is not null and L is not null');
      const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq?sheet=${encodeURIComponent(sheetName)}&tq=${tq}&tqx=responseHandler:${cbName}&_ts=${Date.now()}`;
      script.src = url;
      script.async = true;
      script.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error('ไม่สามารถโหลด Google Sheet ได้ (อาจติดสิทธิ์การแชร์หรือออฟไลน์)'));
      };
      document.head.appendChild(script);
    });
  }

  /**
   * Method 3: Fetch via Google Sheets CSV export (fallback on HTTPS)
   */
  async function fetchFromCsvExport(spreadsheetId, gid) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=csv&gid=${encodeURIComponent(gid || '0')}&_ts=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`CSV export HTTP ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith('<!DOCTYPE') || text.includes('accounts.google.com')) {
      throw new Error('Google Sheet ยังเป็นแบบส่วนตัว (ต้องเปิดแชร์ผู้ที่มีลิงก์ดูได้ หรือใช้ Apps Script)');
    }
    const parsed = parseCsv(text);
    const rows = normalizeSheet1Rows(parsed);
    if (!rows.length) throw new Error('CSV export returned 0 valid rows');
    return {
      source: 'csv_live',
      sourceLabel: 'Google Sheet CSV (Live)',
      fetchedAt: new Date().toISOString(),
      rows
    };
  }

  /**
   * Method 4: Local Snapshot fallback (window.SHEET_SNAPSHOT)
   */
  function loadLocalSnapshot() {
    if (global.SHEET_SNAPSHOT && Array.isArray(global.SHEET_SNAPSHOT.rows) && global.SHEET_SNAPSHOT.rows.length > 0) {
      return {
        source: 'snapshot',
        sourceLabel: 'ข้อมูล Snapshot ในเครื่อง',
        fetchedAt: global.SHEET_SNAPSHOT.exportedAt || null,
        rows: global.SHEET_SNAPSHOT.rows
      };
    }
    return null;
  }

  /**
   * Master loader with smart fallback chain
   */
  async function fetchSheetData(settings) {
    const errors = [];

    // 1. Try Apps Script URL if configured
    if (settings.appsScriptUrl && settings.appsScriptUrl.trim()) {
      try {
        return await fetchFromAppsScript(settings.appsScriptUrl);
      } catch (err) {
        errors.push(`Apps Script: ${err.message}`);
      }
    }

    // 2. Try Google Visualization JSONP (direct live sync, zero CORS)
    if (settings.spreadsheetId && settings.spreadsheetId.trim()) {
      try {
        return await fetchFromGvizJsonp(settings.spreadsheetId.trim(), settings.sheetName || 'Sheet1');
      } catch (err) {
        errors.push(`GViz Live: ${err.message}`);
      }

      // 3. Try direct CSV export when running on HTTP/HTTPS
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        try {
          return await fetchFromCsvExport(settings.spreadsheetId.trim(), settings.sheetGid || '0');
        } catch (err) {
          errors.push(`CSV Live: ${err.message}`);
        }
      }
    }

    // 4. Fallback to embedded snapshot
    const snapshot = loadLocalSnapshot();
    if (snapshot) {
      return {
        ...snapshot,
        liveErrors: errors
      };
    }

    throw new Error('ไม่สามารถดึงข้อมูลได้: ' + errors.join(' | '));
  }

  global.SheetFetcher = {
    fetchSheetData,
    loadLocalSnapshot,
    parseCsv
  };
})(window);
