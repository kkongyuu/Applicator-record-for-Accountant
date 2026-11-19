/**
 * Google Apps Script Web App — สำหรับดึงข้อมูลสดจาก Google Sheet แบบ Private
 *
 * วิธีติดตั้ง (ใช้เวลา ~1 นาที):
 * 1. เปิด Google Sheet ของคุณ (Applicator record for ACCOUNTANT)
 * 2. เมนูด้านบนเลือก: Extensions (ส่วนขยาย) > Apps Script
 * 3. ลบโค้ดเดิมออกแล้ววางโค้ดนี้ลงไป กด Save (Ctrl+S)
 * 4. กดปุ่ม Deploy (ทำให้ใช้งานได้) > New deployment (การทำให้ใช้งานได้ใหม่)
 *    - Select type: Web app (เว็บแอป)
 *    - Execute as: Me (ฉัน)
 *    - Who has access: Anyone (ทุกคน)
 * 5. กด Deploy > อนุญาตสิทธิ์ (Authorize) > คัดลอก Web app URL (.../exec)
 * 6. นำ URL ไปวางในหน้า Dashboard ที่ปุ่ม "⚙️ ตั้งค่า" (หรือวางในไฟล์ js/config.js)
 */
function doGet(e) {
  var sheetName = (e && e.parameter && e.parameter.sheet) ? e.parameter.sheet : 'Sheet1';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Sheet not found: ' + sheetName }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return ContentService
      .createTextOutput(JSON.stringify({ rows: [], updatedAt: new Date().toISOString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // อ่านเฉพาะคอลัมน์ A ถึง F (หมายเลขเครื่อง, ช็อตปัจจุบัน, ช็อตคงเหลือ, กลุ่ม, วันเวลา, สาขา)
  var values = sheet.getRange(1, 1, lastRow, 6).getDisplayValues();
  var rows = [];

  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var dateTime = String(r[4] || '').trim();
    var branch = String(r[5] || '').trim();
    if (!dateTime || !branch || branch === '#N/A' || branch === '#VALUE!') continue;
    rows.push([
      String(r[0] || '').trim(),
      String(r[1] || '').trim(),
      String(r[2] || '').trim(),
      String(r[3] || '').trim(),
      dateTime,
      branch
    ]);
  }

  return ContentService
    .createTextOutput(JSON.stringify({
      sheetName: sheetName,
      updatedAt: new Date().toISOString(),
      count: rows.length,
      rows: rows
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
