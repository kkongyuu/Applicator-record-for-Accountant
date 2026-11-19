/**
 * Dashboard Configuration
 * ตั้งค่าการเชื่อมต่อ Google Sheets และพารามิเตอร์สำหรับฝ่ายบัญชี
 */
window.DASHBOARD_CONFIG = {
  // Google Spreadsheet ID จาก URL ของผู้ใช้
  spreadsheetId: '1aZHfyPyzrKocAXUKCyhRm1COJRVE894ii9y2d3rA2HA',

  // ชื่อแท็บข้อมูลดิบ (Sheet1) และแท็บโครงสร้างสาขา/จำนวนเครื่องหลัก (Sheet2)
  sheetName: 'Sheet1',
  schemaSheetName: 'Sheet2',
  sheetGid: '0',

  // (ทางเลือก) URL ของ Google Apps Script Web App กรณีต้องการเก็บ Google Sheet เป็น Private
  // สามารถวางไว้ที่นี่ หรือตั้งค่าผ่านปุ่ม ⚙️ ในหน้า Dashboard (บันทึกลง localStorage อัตโนมัติ)
  appsScriptUrl: '',

  // ระยะเวลาดึงข้อมูลอัตโนมัติ (มิลลิวินาที) — ค่าเริ่มต้นทุก 5 นาที (300,000 ms)
  autoRefreshMs: 5 * 60 * 1000,

  // จำนวนเครื่องสูงสุดต่อสาขา (อิงตามความเป็นจริงและ Sheet2 = ไม่เกิน 2 เครื่องต่อสาขา)
  maxMachinesPerBranch: 2,

  // เกณฑ์ช็อตสูงสุดต่อเครื่องต่อวัน (สำหรับตรวจจับค่า OCR ผิดปกติ)
  maxShotsPerMachinePerDay: 200000,

  // ช่วงห่างวันสูงสุดที่ยอมให้นำมาลบหาผลต่างสะสม (หากขาดส่งเกิน 7 วันจะตั้งเป็นค่าเริ่มต้นใหม่แทนการบวกกระโดด)
  maxGapDaysForDelta: 7,

  // อายุการใช้งานสูงสุดต่อหัว Applicator (10 ล้านช็อต)
  maxHeadLifespan: 10000000,

  // แจ้งเตือนเมื่อช็อตคงเหลือน้อยกว่าค่านี้
  lowRemainingWarning: 1500000,

  // คีย์สำหรับเก็บการตั้งค่าในเบราว์เซอร์
  storageKey: 'applicator_accounting_dashboard_settings_v1'
};

window.loadSavedSettings = function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(window.DASHBOARD_CONFIG.storageKey);
    if (!raw) return { ...window.DASHBOARD_CONFIG };
    const parsed = JSON.parse(raw);
    return {
      ...window.DASHBOARD_CONFIG,
      ...parsed
    };
  } catch (_) {
    return { ...window.DASHBOARD_CONFIG };
  }
};

window.saveSettings = function saveSettings(partial) {
  const merged = { ...window.loadSavedSettings(), ...partial };
  try {
    localStorage.setItem(window.DASHBOARD_CONFIG.storageKey, JSON.stringify({
      spreadsheetId: merged.spreadsheetId,
      sheetName: merged.sheetName,
      appsScriptUrl: merged.appsScriptUrl,
      autoRefreshMs: merged.autoRefreshMs,
      maxShotsPerMachinePerDay: merged.maxShotsPerMachinePerDay
    }));
  } catch (_) {
    // ignore storage quota errors
  }
  return merged;
};
