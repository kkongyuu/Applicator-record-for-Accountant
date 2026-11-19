# 📊 Applicator Shot Usage Dashboard (สำหรับฝ่ายบัญชี)

แดชบอร์ดสรุปจำนวน **ช็อต Applicator ที่ใช้จริงรายวัน แยกตามสาขา (ครบทั้ง 19 สาขา)** สร้างด้วย **HTML / Vanilla JS / Chart.js** ไม่ต้องติดตั้ง Backend หรือ Build Tools สามารถเปิดใช้งานทันทีและอัปขึ้น **GitHub Pages** ได้เลย

## ✨ ฟีเจอร์หลักสำหรับฝ่ายบัญชี

1. **ดึงข้อมูลอัตโนมัติจาก Google Sheets** (รีเฟรชอัตโนมัติทุก 5 นาที + ปุ่มกดรีเฟรชทันที)
2. **ตารางสรุปบัญชี (สาขา × รายวัน 1–31)** พร้อมยอดรวมรายสาขา, ยอดรวมทุกสาขารายวัน และ Heatmap ช่วยสังเกตความผิดปกติ
3. **คลิกตรวจสอบหลักฐานได้ทุกช่อง (Drill-down)** แสดงเลขมิเตอร์ก่อนหน้า → ปัจจุบัน และแยกยอดทีละเครื่อง
4. **คำนวณแม่นยำแม้นำเข้าจาก OCR ในกลุ่ม LINE:**
   - ตัดค่า OCR อ่านพลาด (`ESC`, `ENTER`, ตัวอักษร, เกิน 10 ล้านช็อต, ค่ากระโดดผิดปกติ) ออกอัตโนมัติ
   - ติดตามเครื่อง **1–2 เครื่องต่อสาขา** อย่างแม่นยำ แม้บางวัน OCR จะอ่านหมายเลขเครื่องเป็น `ไม่ระบุ`
   - แยกแยะ **"เปลี่ยนหัวใหม่ (Head Swap)"** ออกจาก **"OCR อ่านพลาดวันเดียว"** อัตโนมัติ
   - สลับโหมดวันขาดส่งได้ 2 แบบ: **ตามวันที่บันทึกจริง (ตรงมิเตอร์ 100%)** และ **เฉลี่ยวันขาดส่ง (Prorate)** โดยยอดรวมทั้งเดือนเท่ากันเป๊ะ
5. **กราฟวิเคราะห์ Chart.js 4 ชุด:** แนวโน้มรายวัน, เปรียบเทียบทุกสาขา, สัดส่วนสาขา (Doughnut) และแนวโน้มรายเดือนทั้งปี
6. **ติดตามอายุหัว Applicator (10,000,000 ช็อต)** แจ้งเตือนเครื่องที่ใกล้หมดหัว
7. **ส่งออกไฟล์ Excel (`.csv` รองรับภาษาไทย UTF-8 BOM)** ได้ทั้งแบบตารางสรุปรายวัน และแบบบัญชีละเอียดรายเครื่อง
8. **ตาราง Audit Trail** แสดงรายการผิดปกติทั้งหมดเพื่อให้ฝ่ายบัญชีตรวจสอบย้อนกลับได้ 100%

---

## 🔗 วิธีเปิดการดึงข้อมูลสดอัตโนมัติจาก Google Sheet

ระบบรองรับ 2 วิธี (เลือกเพียง 1 วิธี):

### วิธีที่ 1: แชร์แบบอ่านอย่างเดียว (ง่ายที่สุด ไม่ต้องตั้งค่าเพิ่ม)
1. เปิด Google Sheet ของคุณ
2. กด **แชร์ (Share)** → เปลี่ยนการเข้าถึงทั่วไปเป็น **ทุกคนที่มีลิงก์ (Anyone with the link)** สิทธิ์ **ผู้มีสิทธิ์อ่าน (Viewer)**
3. เปิดหน้า `index.html` หรือเว็บ GitHub Pages ระบบจะดึงข้อมูลสดจาก `Sheet1` อัตโนมัติทันที (ขึ้นจุดสีเขียว 🟢)

### วิธีที่ 2: เก็บ Google Sheet เป็น Private (ใช้ Google Apps Script)
1. เปิด Google Sheet → เมนู **Extensions (ส่วนขยาย) > Apps Script**
2. คัดลอกโค้ดจากไฟล์ [`apps-script/Code.gs`](apps-script/Code.gs) ไปวางแล้วกด Save
3. กด **Deploy > New deployment > Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. นำ Web App URL (`https://script.google.com/macros/s/.../exec`) มาใส่ในไฟล์ `js/config.js` ตรงช่อง `appsScriptUrl` (หรือใส่ผ่านปุ่ม ⚙️ ตั้งค่า บนหน้าเว็บ)

---

## 🚀 แผนการอัปเดตขึ้น Git (`kkongyuu/Applicator-record-for-Accountant`) และเปิด GitHub Pages

### ขั้นตอนที่ 1: Push ขึ้น GitHub
```bash
cd Applicator-record-for-Accountant
git init
git branch -M main
git add .
git commit -m "Initial commit: Applicator Accounting Shot Usage Dashboard"
git remote add origin https://github.com/kkongyuu/Applicator-record-for-Accountant.git
git push -u origin main
```

*(หากยังไม่ได้ติดตั้ง Git บนเครื่อง Windows สามารถติดตั้งได้จาก https://git-scm.com/download/win หรือใช้ GitHub Desktop / อัปโหลดไฟล์ผ่านหน้าเว็บ GitHub โดยตรง)*

### ขั้นตอนที่ 2: เปิดใช้งาน GitHub Pages
1. เข้าไปที่ GitHub Repo ของคุณ → **Settings > Pages**
2. ตรง **Build and deployment > Source** เลือก **GitHub Actions** (ไฟล์ `.github/workflows/deploy-pages.yml` ถูกเตรียมไว้พร้อมแล้ว)
3. รอประมาณ 1 นาที จะได้ลิงก์เว็บแดชบอร์ดใช้งานจริงสำหรับส่งให้ฝ่ายบัญชีได้เลยที่:
   `https://kkongyuu.github.io/Applicator-record-for-Accountant/`
