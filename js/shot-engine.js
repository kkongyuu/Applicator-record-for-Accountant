/**
 * Accounting Shot Calculation Engine
 * คำนวณจำนวนช็อตที่ใช้จริงรายวัน แยกตามสาขาและเครื่อง พร้อมตรวจจับ:
 *  - แปลงวันที่ พ.ศ. (2569) ↔ ค.ศ. (2026)
 *  - กรองค่า OCR ผิดพลาด (ESC, ENTER, ตัวอักษร, เกิน 10 ล้าน, 0, ค่ากระโดดผิดปกติ)
 *  - ติดตามเครื่อง 1..N เครื่องในแต่ละสาขาจากความต่อเนื่องของเลขช็อตสะสม (แก้ปัญหา OCR ไม่ระบุหมายเลขเครื่อง)
 *  - แยกแยะ "เปลี่ยนหัวใหม่ (Head Swap)" ออกจาก "OCR อ่านพลาดวันเดียว" ด้วย Lookahead Verification
 *  - รองรับโหมดบัญชี 2 แบบ: ตามวันที่บันทึกจริง (Actual) และ เฉลี่ยวันขาดส่ง (Prorated)
 */
(function (global) {
  'use strict';

  const THAI_MONTHS = [
    '', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
  ];

  const THAI_MONTHS_SHORT = [
    '', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
  ];

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * Parse raw Thai date string like "2/1/2569" or "18/11/2569 20:52" or ISO "2026-11-18"
   */
  function parseDateTime(raw) {
    if (!raw) return null;
    const str = String(raw).trim();

    // Format: D/M/YYYY [HH:mm[:ss]]
    let m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      let year = parseInt(m[3], 10);
      const hour = m[4] ? parseInt(m[4], 10) : 20;
      const min = m[5] ? parseInt(m[5], 10) : 0;
      const yearCE = year >= 2400 ? year - 543 : year;
      const yearBE = yearCE + 543;
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const dateKey = `${yearCE}-${pad2(month)}-${pad2(day)}`;
      const monthKey = `${yearCE}-${pad2(month)}`;
      const utcMs = Date.UTC(yearCE, month - 1, day);
      return {
        day, month, yearCE, yearBE, hour, min,
        dateKey, monthKey, utcMs,
        timeMinutes: hour * 60 + min,
        thaiDate: `${pad2(day)}/${pad2(month)}/${yearBE}`,
        raw: str
      };
    }

    // Format: YYYY-MM-DD
    m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
      let year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const day = parseInt(m[3], 10);
      const yearCE = year >= 2400 ? year - 543 : year;
      const yearBE = yearCE + 543;
      const dateKey = `${yearCE}-${pad2(month)}-${pad2(day)}`;
      const monthKey = `${yearCE}-${pad2(month)}`;
      return {
        day, month, yearCE, yearBE, hour: 20, min: 0,
        dateKey, monthKey, utcMs: Date.UTC(yearCE, month - 1, day),
        timeMinutes: 1200,
        thaiDate: `${pad2(day)}/${pad2(month)}/${yearBE}`,
        raw: str
      };
    }

    return null;
  }

  function daysBetween(utcMsA, utcMsB) {
    return Math.round((utcMsB - utcMsA) / 86400000);
  }

  function addDaysDateKey(utcMs, deltaDays) {
    const d = new Date(utcMs + deltaDays * 86400000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    return {
      dateKey: `${y}-${pad2(m)}-${pad2(day)}`,
      monthKey: `${y}-${pad2(m)}`,
      day,
      month: m,
      yearCE: y,
      yearBE: y + 543,
      utcMs: Date.UTC(y, m - 1, day),
      thaiDate: `${pad2(day)}/${pad2(m)}/${y + 543}`
    };
  }

  /**
   * Strictly parse cumulative shot counter.
   * Strips trailing "(3 000 000)" notes, accepts digits/spaces/commas/optional .00.
   */
  function parseShotValue(raw, maxLifespan) {
    if (raw === null || raw === undefined) return { ok: false, reason: 'EMPTY', message: 'ค่าว่าง' };
    const orig = String(raw).trim();
    if (!orig) return { ok: false, reason: 'EMPTY', message: 'ค่าว่าง' };

    // Remove parenthetical note like "(3 000 000)"
    let cleaned = orig.replace(/\(.*$/, '').trim();
    if (!cleaned) return { ok: false, reason: 'INVALID_FORMAT', message: `OCR อ่านผิดรูปแบบ ("${orig}")` };

    // Remove trailing ".00" decimal if formatted as currency/float
    cleaned = cleaned.replace(/\.0+$/, '');

    // Handle OCR reading a space/comma as a period between 3-digit groups (e.g. "4.427 900")
    cleaned = cleaned.replace(/(\d)\.(\d{3})(?=\b|\s|,|\.)/g, '$1 $2');

    // Strict check: only digits, spaces, commas
    if (!/^\d[\d\s,]*$/.test(cleaned)) {
      return { ok: false, reason: 'INVALID_FORMAT', message: `OCR อ่านผิดรูปแบบ ("${orig}")` };
    }

    const numStr = cleaned.replace(/[\s,]/g, '');
    const value = Number(numStr);
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, reason: 'ZERO_OR_NEG', message: `ค่าเป็น 0 หรือติดลบ ("${orig}")` };
    }
    if (value > maxLifespan) {
      return {
        ok: false,
        reason: 'OUT_OF_RANGE',
        value,
        message: `เกินอายุหัว 10 ล้านช็อต (${value.toLocaleString('en-US')})`
      };
    }

    return { ok: true, value };
  }

  /**
   * Normalize machine ID to help match noisy OCR strings (e.g. "0120/05BF0302")
   */
  function normalizeMachineTag(rawId) {
    if (!rawId) return '';
    const s = String(rawId).trim();
    if (!s || s === 'ไม่ระบุ') return '';
    // Extract canonical BFxxxx suffix if present
    const bfMatch = s.toUpperCase().match(/BF[0-9A-Z]{3,5}/);
    if (bfMatch) return bfMatch[0];
    return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-8);
  }

  function cleanBranchName(raw) {
    return String(raw || '').trim();
  }

  /**
   * Main Accounting Engine: process compact Sheet1 rows using Sheet2 branch/machine schema
   * Compact row format: [machineId, rawCurrent, rawRemaining, rawDateTime, branch]
   * Options:
   *  - sheet2Schema: { order: [...], counts: { branch: 1|2 }, totalMachines }
   *  - scopeMode: 'sheet2' (default, strictly follows Sheet2 branches & machine counts) | 'all' (includes extra Sheet1 branches, still capped at max 2 machines/branch)
   */
  function processRows(compactRows, options = {}) {
    const maxPerDay = options.maxShotsPerMachinePerDay || 200000;
    const maxGapDays = options.maxGapDaysForDelta || 7;
    const maxLifespan = options.maxHeadLifespan || 10000000;
    const globalMaxMachines = Math.min(2, options.maxMachinesPerBranch || 2);
    const headSwapNewThreshold = 250000; // Counter <= 250k on swap day = brand new head from 0
    const sheet2Schema = options.sheet2Schema || { order: [], counts: {}, totalMachines: 0 };
    const scopeMode = options.scopeMode || 'sheet2';
    const hasSheet2Schema = sheet2Schema.order && sheet2Schema.order.length > 0;

    const audits = [];
    const byBranchDate = new Map(); // branch -> Map(dateKey -> { dateInfo, candidates: [] })
    const allMonthsSet = new Set();
    const allDatesSet = new Set();

    let totalRawRows = 0;

    // 1. Parse & group raw rows by branch + date
    for (let i = 0; i < compactRows.length; i++) {
      const row = compactRows[i];
      if (!row || row.length < 5) continue;
      const machineRaw = String(row[0] ?? '').trim() || 'ไม่ระบุ';
      const rawCurrent = String(row[1] ?? '').trim();
      const rawRemaining = String(row[2] ?? '').trim();
      const rawDateTime = String(row[3] ?? '').trim();
      const branch = cleanBranchName(row[4]);

      if (!branch || branch === '#N/A' || !rawDateTime) continue;
      if (scopeMode === 'sheet2' && hasSheet2Schema && !sheet2Schema.counts[branch]) continue;

      const dateInfo = parseDateTime(rawDateTime);
      if (!dateInfo) continue;

      totalRawRows++;
      allMonthsSet.add(dateInfo.monthKey);
      allDatesSet.add(dateInfo.dateKey);

      const parsedVal = parseShotValue(rawCurrent, maxLifespan);

      if (!parsedVal.ok) {
        audits.push({
          severity: 'error',
          type: parsedVal.reason,
          typeLabel: parsedVal.reason === 'OUT_OF_RANGE' ? 'ค่าเกิน 10 ล้าน' : 'OCR อ่านผิดพลาด',
          dateKey: dateInfo.dateKey,
          monthKey: dateInfo.monthKey,
          thaiDate: dateInfo.thaiDate,
          branch,
          machineId: machineRaw,
          rawCurrent,
          prevVal: null,
          curVal: parsedVal.value || null,
          shotsUsed: null,
          message: parsedVal.message
        });
        continue;
      }

      if (!byBranchDate.has(branch)) byBranchDate.set(branch, new Map());
      const branchMap = byBranchDate.get(branch);
      if (!branchMap.has(dateInfo.dateKey)) {
        branchMap.set(dateInfo.dateKey, { dateInfo, candidates: [] });
      }
      branchMap.get(dateInfo.dateKey).candidates.push({
        seq: i,
        machineRaw,
        machineTag: normalizeMachineTag(machineRaw),
        rawCurrent,
        rawRemaining,
        val: parsedVal.value,
        timeMinutes: dateInfo.timeMinutes,
        dateInfo
      });
    }

    const dailyEvents = []; // Every calculated machine-day usage record (Actual mode)
    const branchMeta = {};  // branch -> { tracks, machineCount, latestDate, headSwaps }

    // Order branches following Sheet2 order first, then any additional branches alphabetically
    const existingBranches = Array.from(byBranchDate.keys());
    const sortedBranches = [];
    if (hasSheet2Schema) {
      for (const b of sheet2Schema.order) {
        if (byBranchDate.has(b)) sortedBranches.push(b);
      }
    }
    for (const b of existingBranches.sort((a, b) => a.localeCompare(b, 'th'))) {
      if (!sortedBranches.includes(b)) sortedBranches.push(b);
    }

    // 2. Per-branch chronological tracking — STRICTLY capped to exact Sheet2 machine count (1 or 2, NEVER > 2!)
    for (const branch of sortedBranches) {
      const dateMap = byBranchDate.get(branch);
      const sortedDateKeys = Array.from(dateMap.keys()).sort();

      // Determine hard machine limit for this branch:
      // In 'sheet2' mode -> strictly uses Sheet2's exact count (1 or 2)
      // In 'all' mode    -> uses max(Sheet2 count, 2) but NEVER exceeds 2
      const sheet2Count = sheet2Schema.counts[branch] || 0;
      const maxTracksForBranch = (scopeMode === 'sheet2' && sheet2Count > 0)
        ? Math.min(globalMaxMachines, sheet2Count)
        : globalMaxMachines;

      const tracks = []; // Max length === maxTracksForBranch (1 or 2!)
      let nextTrackNum = 1;

      function isReasonableDelta(prevVal, nextVal, dayGap) {
        if (dayGap <= 0 || dayGap > maxGapDays) return false;
        const delta = nextVal - prevVal;
        if (delta < 0) return false;
        const cap = Math.min(750000, Math.max(maxPerDay, dayGap * maxPerDay));
        return delta <= cap;
      }

      function trackContinuesInFuture(track, fromIdx) {
        const maxLookIdx = Math.min(sortedDateKeys.length - 1, fromIdx + 4);
        for (let j = fromIdx + 1; j <= maxLookIdx; j++) {
          const fut = dateMap.get(sortedDateKeys[j]);
          const gap = daysBetween(track.lastDateInfo.utcMs, fut.dateInfo.utcMs);
          if (gap > maxGapDays) break;
          for (const c of fut.candidates) {
            if (isReasonableDelta(track.lastVal, c.val, gap)) return true;
          }
        }
        return false;
      }

      function candidateConfirmedInFuture(cand, fromIdx, activeTracks) {
        const maxLookIdx = Math.min(sortedDateKeys.length - 1, fromIdx + 4);
        for (let j = fromIdx + 1; j <= maxLookIdx; j++) {
          const fut = dateMap.get(sortedDateKeys[j]);
          const gap = daysBetween(cand.dateInfo.utcMs, fut.dateInfo.utcMs);
          if (gap <= 0 || gap > maxGapDays) continue;
          for (const fc of fut.candidates) {
            if (isReasonableDelta(cand.val, fc.val, gap)) {
              let explainedByOtherTrack = false;
              for (const t of activeTracks) {
                if (Math.abs(t.lastVal - cand.val) > 300000) {
                  const tGap = daysBetween(t.lastDateInfo.utcMs, fut.dateInfo.utcMs);
                  if (isReasonableDelta(t.lastVal, fc.val, tGap)) {
                    explainedByOtherTrack = true;
                    break;
                  }
                }
              }
              if (!explainedByOtherTrack) return true;
            }
          }
        }
        return false;
      }

      function registerMachineId(track, rawId) {
        if (!rawId || rawId === 'ไม่ระบุ') return;
        track.machineIdCounts[rawId] = (track.machineIdCounts[rawId] || 0) + 1;
        let bestId = '';
        let bestCount = 0;
        for (const [k, cnt] of Object.entries(track.machineIdCounts)) {
          if (cnt > bestCount) {
            bestCount = cnt;
            bestId = k;
          }
        }
        if (bestId) {
          track.canonicalId = bestId;
          track.canonicalTag = normalizeMachineTag(bestId);
        }
      }

      for (let dIdx = 0; dIdx < sortedDateKeys.length; dIdx++) {
        const dk = sortedDateKeys[dIdx];
        const dayBucket = dateMap.get(dk);
        const dateInfo = dayBucket.dateInfo;

        // Deduplicate same-day readings within 40,000 shots (duplicate submissions)
        const rawCands = dayBucket.candidates.slice().sort((a, b) => a.seq - b.seq);
        const clusters = [];
        for (const c of rawCands) {
          let merged = false;
          for (const cl of clusters) {
            if (Math.abs(cl.rep.val - c.val) <= 40000) {
              if (c.val >= cl.rep.val) cl.rep = c;
              cl.count++;
              merged = true;
              break;
            }
          }
          if (!merged) clusters.push({ rep: c, count: 1 });
        }
        // Sort candidates ascending so for 1-machine Sheet2 branches (like ชลบุรี/ระยอง matching Sheet2's SORT index 1),
        // the primary counter aligns cleanly with Sheet2!
        const candidates = clusters.map(cl => cl.rep).sort((a, b) => a.val - b.val);

        // Step A: EXACT Optimal 1-to-1 matching between active tracks (<= 2) and today's candidates.
        // Maximizes number of matched heads first (never drops a head due to greedy order or send order),
        // then minimizes combined cost (matching machine ID tag + realistic daily shot delta).
        const validEdges = [];
        for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
          const track = tracks[tIdx];
          const dayGap = daysBetween(track.lastDateInfo.utcMs, dateInfo.utcMs);
          if (dayGap <= 0 || dayGap > maxGapDays) continue;
          for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
            const cand = candidates[cIdx];
            if (isReasonableDelta(track.lastVal, cand.val, dayGap)) {
              const delta = cand.val - track.lastVal;
              const perDay = delta / dayGap;
              let tagBonus = 0;
              if (track.canonicalTag && cand.machineTag) {
                tagBonus = track.canonicalTag === cand.machineTag ? -120000 : 120000;
              }
              const score = Math.abs(perDay - 55000) + tagBonus;
              validEdges.push({ tIdx, cIdx, delta, dayGap, score });
            }
          }
        }

        // Exact optimal matching for <= 2 tracks (exhaustive over all 1-pair and 2-pair combinations)
        let bestAssignment = [];
        let bestScore = Infinity;

        // Consider single-edge assignments
        for (const e of validEdges) {
          if (bestAssignment.length < 1 || (bestAssignment.length === 1 && e.score < bestScore)) {
            bestAssignment = [e];
            bestScore = e.score;
          }
        }
        // Consider two-edge disjoint assignments (strictly preferred over 1-edge whenever valid!)
        if (tracks.length === 2 && validEdges.length >= 2) {
          for (let i = 0; i < validEdges.length; i++) {
            for (let j = i + 1; j < validEdges.length; j++) {
              const a = validEdges[i];
              const b = validEdges[j];
              if (a.tIdx !== b.tIdx && a.cIdx !== b.cIdx) {
                const comboScore = a.score + b.score;
                if (bestAssignment.length < 2 || comboScore < bestScore) {
                  bestAssignment = [a, b];
                  bestScore = comboScore;
                }
              }
            }
          }
        }

        const matchedTracks = new Set();
        const matchedCands = new Set();

        for (const p of bestAssignment) {
          matchedTracks.add(p.tIdx);
          matchedCands.add(p.cIdx);

          const track = tracks[p.tIdx];
          const cand = candidates[p.cIdx];
          const prevDateInfo = track.lastDateInfo;
          const prevVal = track.lastVal;

          track.lastDateInfo = dateInfo;
          track.lastVal = cand.val;
          track.readingsCount++;
          track.totalShots += p.delta;
          registerMachineId(track, cand.machineRaw);

          const status = p.dayGap > 1 ? 'MULTI_DAY' : 'OK';
          dailyEvents.push({
            dateKey: dk,
            monthKey: dateInfo.monthKey,
            day: dateInfo.day,
            month: dateInfo.month,
            yearCE: dateInfo.yearCE,
            yearBE: dateInfo.yearBE,
            thaiDate: dateInfo.thaiDate,
            utcMs: dateInfo.utcMs,
            branch,
            trackId: track.id,
            machineLabel: track.canonicalId || `เครื่อง ${track.num}`,
            prevDateKey: prevDateInfo.dateKey,
            prevThaiDate: prevDateInfo.thaiDate,
            prevUtcMs: prevDateInfo.utcMs,
            prevVal,
            curVal: cand.val,
            rawCurrent: cand.rawCurrent,
            shotsUsed: p.delta,
            dayGap: p.dayGap,
            status
          });

          if (p.dayGap > 1) {
            audits.push({
              severity: 'info',
              type: 'MULTI_DAY',
              typeLabel: `สะสม ${p.dayGap} วัน`,
              dateKey: dk,
              monthKey: dateInfo.monthKey,
              thaiDate: dateInfo.thaiDate,
              branch,
              machineId: track.canonicalId || cand.machineRaw,
              rawCurrent: cand.rawCurrent,
              prevVal,
              curVal: cand.val,
              shotsUsed: p.delta,
              message: `เว้นช่วง ${p.dayGap} วัน (จาก ${prevDateInfo.thaiDate}: ${prevVal.toLocaleString()} → ${cand.val.toLocaleString()})`
            });
          }
        }

        // Step B: Handle unmatched candidates — strictly bounded to maxTracksForBranch (1 or 2)
        const unmatchedCands = candidates.filter((_, idx) => !matchedCands.has(idx));

        for (const cand of unmatchedCands) {
          const confirmed = candidateConfirmedInFuture(cand, dIdx, tracks);
          const isLastFewDays = dIdx >= sortedDateKeys.length - 2;

          // If we already matched ALL allowed machines for this branch today, any extra reading is either
          // a duplicate/secondary unconfigured counter or an OCR outlier — never create a 3rd track!
          if (matchedTracks.size >= maxTracksForBranch) {
            if (!confirmed) {
              audits.push({
                severity: 'error',
                type: 'OCR_OUTLIER',
                typeLabel: 'ค่ากระโดด/OCR พลาด',
                dateKey: dk,
                monthKey: dateInfo.monthKey,
                thaiDate: dateInfo.thaiDate,
                branch,
                machineId: cand.machineRaw,
                rawCurrent: cand.rawCurrent,
                prevVal: tracks[0] ? tracks[0].lastVal : null,
                curVal: cand.val,
                shotsUsed: null,
                message: `พบค่าซ้ำ/ผิดปกติในวันที่เครื่องครบ ${maxTracksForBranch} เครื่องแล้ว (${cand.val.toLocaleString()}) — ตัดออกอัตโนมัติ`
              });
            }
            continue;
          }

          if (confirmed || (tracks.length === 0 && !isLastFewDays)) {
            // Check if any unmatched existing track should be replaced (Head Swap or Long-Gap Re-baseline)
            let replaceTarget = null;
            for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
              if (matchedTracks.has(tIdx)) continue;
              const t = tracks[tIdx];
              const gapSinceLast = daysBetween(t.lastDateInfo.utcMs, dateInfo.utcMs);
              const stopped = gapSinceLast > maxGapDays || !trackContinuesInFuture(t, dIdx);
              if (stopped) {
                if (!replaceTarget) {
                  replaceTarget = { tIdx, track: t, gapSinceLast };
                } else if (t.canonicalTag && cand.machineTag && t.canonicalTag === cand.machineTag) {
                  replaceTarget = { tIdx, track: t, gapSinceLast };
                } else if (gapSinceLast > replaceTarget.gapSinceLast) {
                  replaceTarget = { tIdx, track: t, gapSinceLast };
                }
              }
            }

            // If branch already reached maxTracksForBranch (1 or 2), MUST reuse an unmatched track if available
            if (!replaceTarget && tracks.length >= maxTracksForBranch) {
              for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
                if (!matchedTracks.has(tIdx)) {
                  const gapSinceLast = daysBetween(tracks[tIdx].lastDateInfo.utcMs, dateInfo.utcMs);
                  if (!replaceTarget || gapSinceLast > replaceTarget.gapSinceLast) {
                    replaceTarget = { tIdx, track: tracks[tIdx], gapSinceLast };
                  }
                }
              }
            }

            if (replaceTarget) {
              const track = replaceTarget.track;
              matchedTracks.add(replaceTarget.tIdx);
              const prevDateInfo = track.lastDateInfo;
              const prevVal = track.lastVal;
              const dayGap = Math.max(1, replaceTarget.gapSinceLast);

              // Distinguish: Long gap (> maxGapDays) on SAME head vs Head Replacement!
              const isLongGapSameHead = dayGap > maxGapDays && cand.val >= prevVal && (cand.val - prevVal) <= dayGap * maxPerDay;
              const isBrandNewHead = !isLongGapSameHead && cand.val <= headSwapNewThreshold;
              const swapShots = isBrandNewHead ? cand.val : 0;
              const status = isLongGapSameHead ? 'GAP_RESET' : (isBrandNewHead ? 'HEAD_SWAP_NEW' : 'HEAD_SWAP_USED');

              track.lastDateInfo = dateInfo;
              track.lastVal = cand.val;
              track.readingsCount++;
              if (!isLongGapSameHead) {
                track.headSwaps.push({
                  dateKey: dk,
                  thaiDate: dateInfo.thaiDate,
                  fromVal: prevVal,
                  toVal: cand.val,
                  isBrandNewHead
                });
              }
              track.totalShots += swapShots;
              registerMachineId(track, cand.machineRaw);

              dailyEvents.push({
                dateKey: dk,
                monthKey: dateInfo.monthKey,
                day: dateInfo.day,
                month: dateInfo.month,
                yearCE: dateInfo.yearCE,
                yearBE: dateInfo.yearBE,
                thaiDate: dateInfo.thaiDate,
                utcMs: dateInfo.utcMs,
                branch,
                trackId: track.id,
                machineLabel: track.canonicalId || `เครื่อง ${track.num}`,
                prevDateKey: prevDateInfo.dateKey,
                prevThaiDate: prevDateInfo.thaiDate,
                prevUtcMs: prevDateInfo.utcMs,
                prevVal,
                curVal: cand.val,
                rawCurrent: cand.rawCurrent,
                shotsUsed: swapShots,
                dayGap,
                status
              });

              audits.push({
                severity: 'warning',
                type: status,
                typeLabel: isLongGapSameHead
                  ? `ขาดส่งเกิน ${maxGapDays} วัน (รีเซ็ตฐาน)`
                  : (isBrandNewHead ? 'เปลี่ยนหัวใหม่' : 'สลับ/ย้ายหัวสำรอง'),
                dateKey: dk,
                monthKey: dateInfo.monthKey,
                thaiDate: dateInfo.thaiDate,
                branch,
                machineId: track.canonicalId || cand.machineRaw,
                rawCurrent: cand.rawCurrent,
                prevVal,
                curVal: cand.val,
                shotsUsed: swapShots,
                message: isLongGapSameHead
                  ? `ขาดส่งต่อเนื่อง ${dayGap} วัน (จาก ${prevDateInfo.thaiDate}: ${prevVal.toLocaleString()} → ${cand.val.toLocaleString()}, ผลต่างรวม ${(cand.val - prevVal).toLocaleString()} ช็อต) ตั้งฐานใหม่เพื่อไม่ให้ยอดกระโดดในวันเดียว`
                  : (isBrandNewHead
                    ? `เปลี่ยนหัว Applicator ใหม่ (${prevVal.toLocaleString()} → ${cand.val.toLocaleString()}) นับยอดหัวใหม่ ${swapShots.toLocaleString()} ช็อต`
                    : `สลับหัวที่มีช็อตสะสมอยู่แล้ว (${prevVal.toLocaleString()} → ${cand.val.toLocaleString()}) ตั้งยอดวันสลับเป็น 0 เพื่อไม่ให้ยอดบวม`)
              });
            } else if (tracks.length < maxTracksForBranch) {
              // Create new machine track ONLY if below maxTracksForBranch (1 or 2)
              const num = nextTrackNum++;
              const newTrack = {
                id: `${branch}#M${num}`,
                num,
                canonicalId: cand.machineRaw !== 'ไม่ระบุ' ? cand.machineRaw : '',
                canonicalTag: cand.machineTag,
                machineIdCounts: {},
                firstDateInfo: dateInfo,
                lastDateInfo: dateInfo,
                lastVal: cand.val,
                readingsCount: 1,
                totalShots: 0,
                headSwaps: []
              };
              registerMachineId(newTrack, cand.machineRaw);
              tracks.push(newTrack);
              matchedTracks.add(tracks.length - 1);

              dailyEvents.push({
                dateKey: dk,
                monthKey: dateInfo.monthKey,
                day: dateInfo.day,
                month: dateInfo.month,
                yearCE: dateInfo.yearCE,
                yearBE: dateInfo.yearBE,
                thaiDate: dateInfo.thaiDate,
                utcMs: dateInfo.utcMs,
                branch,
                trackId: newTrack.id,
                machineLabel: newTrack.canonicalId || `เครื่อง ${newTrack.num}`,
                prevDateKey: null,
                prevThaiDate: null,
                prevUtcMs: null,
                prevVal: null,
                curVal: cand.val,
                rawCurrent: cand.rawCurrent,
                shotsUsed: 0,
                dayGap: 1,
                status: 'BASELINE'
              });
            }
          } else {
            // Unconfirmed single-day jump/drop -> OCR Outlier!
            const nearestTrack = tracks.length > 0
              ? tracks.reduce((best, t) => (!best || Math.abs(t.lastVal - cand.val) < Math.abs(best.lastVal - cand.val) ? t : best), null)
              : null;

            audits.push({
              severity: 'error',
              type: 'OCR_OUTLIER',
              typeLabel: 'ค่ากระโดด/OCR พลาด',
              dateKey: dk,
              monthKey: dateInfo.monthKey,
              thaiDate: dateInfo.thaiDate,
              branch,
              machineId: cand.machineRaw,
              rawCurrent: cand.rawCurrent,
              prevVal: nearestTrack ? nearestTrack.lastVal : null,
              curVal: cand.val,
              shotsUsed: null,
              message: nearestTrack
                ? `ค่าไม่ต่อเนื่องกับวันก่อน/วันถัดไป (ค่าก่อนหน้า ${nearestTrack.lastVal.toLocaleString()} แต่ OCR อ่านได้ ${cand.val.toLocaleString()}) — ตัดออกอัตโนมัติ`
                : `ไม่สามารถยืนยันความต่อเนื่องกับวันถัดไปได้ (${cand.val.toLocaleString()})`
            });
          }
        }
      }

      // Finalize machine labels on events
      const trackLabelMap = {};
      for (const t of tracks) {
        trackLabelMap[t.id] = t.canonicalId || `เครื่อง ${t.num}`;
      }
      for (const ev of dailyEvents) {
        if (ev.branch === branch && trackLabelMap[ev.trackId]) {
          ev.machineLabel = trackLabelMap[ev.trackId];
        }
      }

      branchMeta[branch] = {
        branch,
        machineCount: tracks.length,
        sheet2MachineCount: sheet2Count || tracks.length,
        tracks: tracks.map(t => ({
          id: t.id,
          num: t.num,
          label: t.canonicalId || `เครื่อง ${t.num}`,
          firstThaiDate: t.firstDateInfo.thaiDate,
          lastDateKey: t.lastDateInfo.dateKey,
          lastThaiDate: t.lastDateInfo.thaiDate,
          lastVal: t.lastVal,
          remaining: Math.max(0, maxLifespan - t.lastVal),
          usedPct: Math.min(100, (t.lastVal / maxLifespan) * 100),
          readingsCount: t.readingsCount,
          totalShots: t.totalShots,
          headSwaps: t.headSwaps
        }))
      };
    }

    const months = Array.from(allMonthsSet).sort().reverse().map(mk => {
      const [y, m] = mk.split('-').map(Number);
      return {
        monthKey: mk,
        yearCE: y,
        yearBE: y + 543,
        month: m,
        label: `${THAI_MONTHS[m]} ${y + 543}`,
        shortLabel: `${THAI_MONTHS_SHORT[m]} ${String(y + 543).slice(-2)}`
      };
    });

    const sortedDates = Array.from(allDatesSet).sort();

    return {
      totalRawRows,
      scopeMode,
      sheet2Schema,
      branches: sortedBranches,
      branchMeta,
      months,
      minDateKey: sortedDates[0] || '',
      maxDateKey: sortedDates[sortedDates.length - 1] || '',
      dailyEvents,
      audits: audits.sort((a, b) => b.dateKey.localeCompare(a.dateKey) || a.branch.localeCompare(b.branch, 'th'))
    };
  }

  /**
   * Expand dailyEvents according to mode ('actual' vs 'prorate')
   * Notice: In 'prorate' mode, a multi-day span of N days splits shotsUsed into N exact integer pieces
   * whose sum equals the EXACT original shotsUsed (zero rounding loss for accounting!).
   */
  function expandEventsByMode(dailyEvents, mode) {
    if (mode !== 'prorate') return dailyEvents;

    const expanded = [];
    for (const ev of dailyEvents) {
      if (ev.status === 'MULTI_DAY' && ev.dayGap > 1 && ev.prevUtcMs && ev.shotsUsed > 0) {
        const base = Math.floor(ev.shotsUsed / ev.dayGap);
        const remainder = ev.shotsUsed - base * ev.dayGap;
        for (let step = 1; step <= ev.dayGap; step++) {
          const d = addDaysDateKey(ev.prevUtcMs, step);
          // Put integer remainder on the final recorded day so total is exact to 1 shot
          const share = step === ev.dayGap ? base + remainder : base;
          expanded.push({
            ...ev,
            dateKey: d.dateKey,
            monthKey: d.monthKey,
            day: d.day,
            month: d.month,
            yearCE: d.yearCE,
            yearBE: d.yearBE,
            thaiDate: d.thaiDate,
            utcMs: d.utcMs,
            shotsUsed: share,
            isProrated: true,
            originalTotalShots: ev.shotsUsed,
            originalDateThai: ev.thaiDate
          });
        }
      } else {
        expanded.push(ev);
      }
    }
    return expanded;
  }

  function formatMonthLabel(monthKey) {
    if (!monthKey || monthKey === 'ALL') return 'ทั้งหมดทุกเดือน';
    const [y, m] = monthKey.split('-').map(Number);
    return `${THAI_MONTHS[m] || m} ${y + 543}`;
  }

  function formatThaiDateShort(dateKey) {
    if (!dateKey) return '-';
    const [y, m, d] = dateKey.split('-').map(Number);
    return `${d} ${THAI_MONTHS_SHORT[m]} ${String(y + 543).slice(-2)}`;
  }

  global.ShotEngine = {
    processRows,
    expandEventsByMode,
    formatMonthLabel,
    formatThaiDateShort,
    THAI_MONTHS,
    THAI_MONTHS_SHORT
  };
})(window);
