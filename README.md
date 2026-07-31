# Mongo Change Tracker

Service เดี่ยว ๆ ที่ watch MongoDB ผ่าน polling แล้วจัดกลุ่มการเปลี่ยนแปลงตาม
**collection + document ID** พร้อม dashboard ให้กดเข้าไปดู "ชื่อ method ที่เรียก" + field
ที่เปลี่ยน และเลือกเทียบกับ JSON Schema template ได้

```
mongo-tracker/
  src/
    db.js               # ต่อ 2 connection: source db (ของจริง) กับ tracker db (เก็บ event/template)
    watcher.js           # Polling watcher + dotted deep diff logic
    schemaValidator.js   # ajv validate เทียบกับ template
    server.js             # REST API + SSE + serve dashboard
  public/index.html      # dashboard (vanilla JS, ไม่ต้อง build)
```

## 1. ติดตั้งและตั้งค่า

```bash
cd mongo-tracker
npm install
cp .env.example .env
# แก้ SOURCE_MONGO_URI / SOURCE_DB_NAME ให้ชี้ไปที่ DB จริงที่ backend คุณใช้
```

สำหรับ EDOCV3 local development ใช้ standalone MongoDB ได้ เพราะ tracker ใช้ polling mode
โดยดู collection ที่กำหนดใน `WATCH_COLLECTIONS` และใช้ field เวลาใน `UPDATED_AT_FIELD`
เพื่อจับ update เช่น `Audit.UpdatedDate`

## 2. รัน service

```bash
npm start
# → http://localhost:4400
```

เปิด dashboard แล้วลองเรียก action จาก frontend ของคุณตามปกติ (เช่นกด "ยืนยันคำสั่งซื้อ")
document ที่เปลี่ยนจะโผล่ในลิสต์ฝั่งซ้ายแบบ real-time (ผ่าน SSE ไม่ต้อง refresh)

## 3. ให้ event รู้ว่ามาจาก method ไหน

MongoDB บอกได้ว่า document เปลี่ยน แต่ไม่ได้บอกตรง ๆ ว่าเกิดจากปุ่ม frontend หรือ service method ไหน
เวอร์ชันนี้รองรับ 2 วิธี:

- **Action Capture**: กด `Start Capture` ใน dashboard ก่อนกดปุ่ม frontend แล้วกด `Stop Capture` หลัง action จบ ระบบจะสรุป event ที่เกิดในช่วงเวลานั้น
- **DocumentChangeLogs mapping**: สำหรับ EDOCV3 watcher จะพยายาม map event ใน `Documents` กับ collection `DocumentChangeLogs` โดยใช้ `DocumentId` และเวลาที่ใกล้กัน เพื่อดึงชื่อ `Action` เช่น `CreateDocument` หรือ `UpdateDocument`

ถ้า map ไม่เจอ event จะยังแสดง `methodName: unknown` แต่ยังเห็น changed fields แบบ before/after ตามปกติ

## 4. สร้าง template (JSON Schema) ไว้เทียบ

Template ผูกกับ collection และมีชื่อของตัวเอง สร้างผ่าน API ได้ตรง ๆ:

```bash
curl -X POST http://localhost:4400/api/templates \
  -H "Content-Type: application/json" \
  -d '{
    "name": "order-confirmed",
    "collection": "orders",
    "schema": {
      "type": "object",
      "required": ["status", "confirmedAt"],
      "properties": {
        "status": { "const": "confirmed" },
        "confirmedAt": { "type": "string" }
      }
    }
  }'
```

จากนั้นในหน้า dashboard เวลาเปิด event ไหนก็ตาม จะมีปุ่ม toggle "เทียบกับ template" เลือก
template ที่ผูกกับ collection นั้น แล้วกด Validate จะบอกว่า pass หรือ field ไหนไม่ตรงตามที่กำหนด

## แนวคิดการทำงาน

- **insert**: watcher ใช้ `_id` watermark เพื่อจับ document ที่สร้างหลัง service เริ่มทำงาน
- **update**: watcher ใช้ field เวลาใน `UPDATED_AT_FIELD` เช่น `Audit.UpdatedDate` แล้ว diff กับ snapshot ล่าสุดใน memory
- **diff**: แสดง changed fields เป็น dotted path เช่น `Status.DocumentStatus.Id`
- Event ทุกอันถูกเก็บถาวรใน tracker DB (`change_events` collection) — เปิด dashboard วันหลัง
  ก็ยังเห็น history เดิม ไม่ใช่แค่ตอนที่ service กำลังรันอยู่

## ข้อจำกัดที่ควรรู้

- Snapshot cache สำหรับ diff จะเริ่มนับจากตอนที่ service เริ่มรัน ถ้า service ปิดอยู่ระหว่างที่มีการแก้ข้อมูล จะไม่เห็น event ช่วงนั้น
- Polling mode ต้องพึ่ง `UPDATED_AT_FIELD`; ถ้า backend action ไม่ update field นี้ watcher อาจไม่เห็น update นั้น
- ถ้าต้องการ audit log ระดับ production ค่อยเพิ่ม Change Streams + resume token ใน phase ถัดไป
