# EDOCV3 Mongo Tracker Dashboard Plan

## Goal

ใช้ `Tools/mongo-tracker` เป็น service กลางสำหรับดูว่า action จาก `CMU-EDOCV3/edocv3-backend` ทำให้ข้อมูลใน MongoDB เปลี่ยนแปลงอะไรบ้าง โดยเริ่มจากการเชื่อม MongoDB ของ EDOCV3 ให้ได้ก่อน แล้วค่อยเพิ่มการ map ระหว่างปุ่ม frontend, backend operation และ field diff ใน MongoDB

ผลลัพธ์ที่ต้องการจาก dashboard:

- เห็นชื่อการทำงาน เช่น `CreateDocument`, `UpdateDocument`, `SendDocument`, `ApproveDocument`
- เห็น collection/document ที่ถูกแก้ เช่น `Documents/{documentId}`
- เห็น field ที่เปลี่ยนแบบ before/after
- เลือก template ของ action ได้ แล้วตรวจว่าหลัง frontend กดปุ่ม ข้อมูลใน MongoDB เปลี่ยนตรงกับ template หรือไม่

## Current Findings

### EDOCV3 MongoDB

Backend `CMU-EDOCV3/edocv3-backend` อ่านค่า MongoDB จาก `MongoDbSettings` ใน `EdocV3/appsettings.Development.json`:

```json
{
  "MongoDbSettings": {
    "ConnectionString": "mongodb://root:mysecretpassword@localhost:27017/?authSource=admin",
    "DatabaseName": "EdocV3_MongoDB"
  }
}
```

Mongo EF context หลักคือ `ApplicationMongoDBContext` และ collection ที่ควรเริ่ม track ก่อนคือ:

- `Documents` - collection หลักของเอกสาร
- `DocumentChangeLogs` - log จาก backend ที่อาจช่วย map ชื่อ repository/service method ใน phase ถัดไป

### mongo-tracker ปัจจุบัน

Service มีโครงหลักแล้ว:

- `src/db.js` - ต่อ source DB และ tracker DB
- `src/watcher.js` - polling collection แล้ว diff document
- `src/server.js` - REST API + SSE + serve dashboard
- `src/schemaValidator.js` - validate document ด้วย JSON Schema ผ่าน AJV
- `public/index.html` - dashboard vanilla JS แบบ 3 columns

ข้อสังเกตสำคัญ: watcher ปัจจุบันเป็น polling mode และต้องตั้ง `WATCH_COLLECTIONS` เอง ถ้าเว้นว่างจะไม่ watch collection ใดเลย

## Phase 1: Connect mongo-tracker กับ EDOCV3 MongoDB

### 1. ตั้งค่า `.env` ของ mongo-tracker

ตั้งค่าให้ source DB ชี้ไปที่ MongoDB เดียวกับ backend และ tracker DB แยก database สำหรับเก็บ event/template:

```env
SOURCE_MONGO_URI=mongodb://root:mysecretpassword@localhost:27017/?authSource=admin
SOURCE_DB_NAME=EdocV3_MongoDB

TRACKER_MONGO_URI=mongodb://root:mysecretpassword@localhost:27017/?authSource=admin
TRACKER_DB_NAME=edocv3_mongo_tracker

WATCH_COLLECTIONS=Documents,DocumentChangeLogs
POLL_INTERVAL_MS=2000
UPDATED_AT_FIELD=Audit.UpdatedDate
PORT=4400
```

หมายเหตุ: ถ้า polling ด้วย nested field `Audit.UpdatedDate` แล้ว Mongo query ใช้ path นี้ได้ ให้ใช้ค่านี้ได้เลย แต่ watcher ต้องรองรับการอ่านค่า nested field ตอน update watermark ด้วย ไม่ใช่อ่าน `doc[updatedAtField]` ตรง ๆ อย่างเดียว

### 2. ปรับ watcher ให้เหมาะกับ EDOCV3

งานที่ต้องทำ:

- รองรับ nested updated field path เช่น `Audit.UpdatedDate`
- ทำ deep diff เป็น dotted path แทน shallow diff เช่น `Status.DocumentStatus.Id`, `Receiver.0.SenderInfo.DocumentSendStatus`
- seed snapshot ของ existing documents ให้ครบพอสำหรับ document ที่กำลัง test
- เพิ่ม collection filter ให้ไม่ track tracker DB เอง

Acceptance check:

- รัน `npm start` แล้วไม่มี error connection
- dashboard เปิดได้ที่ `http://localhost:4400`
- เมื่อแก้ document ใน `Documents` แล้วมี event ใหม่ใน `edocv3_mongo_tracker.change_events`

## Phase 2: Dashboard MVP

Dashboard MVP ควรแบ่งเป็น 4 ส่วน:

1. Action Monitor
   - แสดง event ล่าสุดแบบ real-time
   - filter ตาม collection, operation type, action name, document id

2. Document Timeline
   - แสดง timeline ของ document เดียว
   - แต่ละ event แสดง action name, operation type, timestamp, changed field count

3. Field Diff Viewer
   - แสดง changed fields เป็น dotted path
   - แสดง before/after
   - highlight pass/fail เมื่อเทียบกับ template

4. Template Compare Panel
   - เลือก template ตาม collection/action
   - กด Validate
   - สรุปว่า pass/fail และ field ไหนผิด expectation

MVP UI ที่ควรมีทันที:

- Header: สถานะ connected/disconnected
- Left column: รายการ document ที่มีการเปลี่ยนล่าสุด
- Middle column: timeline ของ document
- Right column: changed fields + template validator
- Top filters: collection, action name, document id, time range

## Phase 3: Map Frontend Button -> Backend Action -> MongoDB Diff

Change stream/polling เห็นแค่ document เปลี่ยน แต่ไม่รู้เองว่าเกิดจากปุ่มหรือ method ไหน ดังนั้นต้องมี action context เพิ่ม

### Option A: ใช้ tracker session จาก frontend/debug flow

เพิ่ม API ใน mongo-tracker:

- `POST /api/action-sessions/start`
- `POST /api/action-sessions/:id/end`
- `GET /api/action-sessions/:id/events`

Flow:

1. ก่อนกดปุ่ม frontend ให้ dashboard กด `Start Capture`
2. dashboard สร้าง `actionSessionId` และเริ่มจับเวลาช่วง test
3. user กดปุ่มใน frontend จริง
4. watcher เก็บ event ที่เกิดในช่วงเวลา session
5. dashboard กด `Stop Capture`
6. dashboard สรุปว่า action นี้ทำให้ document/field ไหนเปลี่ยนบ้าง

ข้อดี:

- ไม่ต้องแก้ backend ทันที
- เหมาะกับ manual test และ debug เร็ว

ข้อจำกัด:

- ถ้ามีหลาย user/test พร้อมกัน อาจจับ event ปนกัน ต้อง filter ด้วย document id หรือ user id เพิ่ม

### Option B: เพิ่ม action name จาก backend

ถ้าต้องการชื่อ action แม่นขึ้น ให้ backend เขียน context เพิ่มตอน save:

- ใช้ `DocumentChangeLogs` ที่ backend มีอยู่แล้วเพื่อดึง method name เช่น `UpdateDocument`
- หรือเพิ่ม field metadata ใน log เช่น `ActionName`, `RequestId`, `UserId`, `DocumentId`
- หรือถ้าใช้ native MongoDB driver ในจุดใด ให้ส่ง `comment` ไปกับ operation ได้

Flow ที่เหมาะกับ EDOCV3:

1. เริ่มจากอ่าน `DocumentChangeLogs` ที่มีอยู่
2. ตอน watcher เห็น `Documents` เปลี่ยน ให้หา log ที่ document id เดียวกันและ timestamp ใกล้กัน
3. ถ้าพบ log ให้ตั้ง `methodName/actionName` จาก log
4. ถ้าไม่พบให้ fallback เป็น `unknown`

Acceptance check:

- เมื่อ frontend กด action แล้ว dashboard แสดงชื่อ action ได้อย่างน้อยจาก log หรือ session name
- event แต่ละรายการมี `actionName`, `collection`, `documentId`, `changedFields`

## Phase 4: Template-Based Validation

Template ต้องตอบคำถามว่า action นี้ควรเปลี่ยน field อะไรเป็นค่าอะไร

### Template model ที่แนะนำ

```json
{
  "name": "send-document",
  "collection": "Documents",
  "actionName": "SendDocument",
  "description": "ส่งหนังสือออกจาก draft ไปยังผู้รับ",
  "expectedChanges": [
    {
      "path": "Status.DocumentStatus.Id",
      "operator": "equals",
      "after": 2
    },
    {
      "path": "Receiver.*.SenderInfo.DocumentSendStatus",
      "operator": "equals",
      "after": "Sent"
    }
  ],
  "requiredChangedPaths": [
    "Status.DocumentStatus",
    "Audit.UpdatedDate",
    "Audit.UpdatedUser"
  ],
  "forbiddenChangedPaths": [
    "Header.DocumentNo",
    "Content.Attachments"
  ]
}
```

### Validation logic

ควรแยก validation เป็น 2 แบบ:

1. JSON Schema validation
   - ตรวจ shape ของ document หลัง action
   - เหมาะกับ required fields และ type

2. Change expectation validation
   - ตรวจเฉพาะ field diff ของ action
   - เหมาะกับคำถามว่า action นี้ควรแก้ field ไหน และไม่ควรแก้ field ไหน

ผลลัพธ์ validation ควรแสดง:

- Pass: field เปลี่ยนตรง template
- Missing change: field ที่ควรเปลี่ยนแต่ไม่เปลี่ยน
- Unexpected change: field ที่ไม่ควรเปลี่ยนแต่เปลี่ยน
- Wrong value: field เปลี่ยนแล้วแต่ค่า after ไม่ตรง expectation

## Phase 5: Suggested Implementation Tasks

### Task 1: EDOC connection setup

- ตั้ง `.env` ให้ชี้ `EdocV3_MongoDB`
- ตั้ง `WATCH_COLLECTIONS=Documents,DocumentChangeLogs`
- ทดสอบรัน `npm start`

### Task 2: Watcher improvements

- เพิ่ม helper `getByPath(document, path)` สำหรับ nested field
- เปลี่ยน `shallowDiff` เป็น `deepDiff`
- รองรับ array diff เบื้องต้นด้วย dotted path/index
- บันทึก event เป็น dotted changed fields

### Task 3: Dashboard rough UI

- เพิ่ม filter bar
- เพิ่ม action session controls: `Start Capture`, `Stop Capture`, `Clear`
- เพิ่ม panel สรุป action ล่าสุด
- เพิ่ม template validation result แบบ pass/fail แยก field

### Task 4: Action session API

- เพิ่ม collection `action_sessions` ใน tracker DB
- เพิ่ม endpoint start/end/list events
- ผูก event ด้วย timestamp range และ optional filters เช่น collection/documentId/userId

### Task 5: Template expectation API

- ขยาย `templates` ให้รองรับ `actionName`, `expectedChanges`, `requiredChangedPaths`, `forbiddenChangedPaths`
- เพิ่ม endpoint validate event/session against template
- แสดงผลใน dashboard

### Task 6: Backend action mapping

- อ่าน `DocumentChangeLogs` เพื่อ map action name
- ถ้า log ไม่พอ ให้เพิ่ม field ใน backend change log เช่น `ActionName`, `RequestId`, `UserId`
- ถ้าอยาก trace ระดับ request ให้เพิ่ม middleware สร้าง `X-Request-Id` และ propagate ไป change log

## First Flow To Test

เริ่มจาก flow ที่มีผลกับ `Documents` ชัดเจนที่สุด:

1. เปิด mongo-tracker dashboard
2. กด `Start Capture` ตั้งชื่อ action เช่น `create-document-draft`
3. ไป frontend EDOCV3 แล้วสร้างเอกสาร draft
4. กลับ dashboard กด `Stop Capture`
5. ดูว่า collection `Documents` มี insert/update อะไรเกิดขึ้น
6. สร้าง template สำหรับ action นี้
7. ทำซ้ำอีกครั้งแล้ว validate ว่าผลตรง template หรือไม่

## Risks / Constraints

- Polling mode ต้องพึ่ง `Audit.UpdatedDate`; ถ้า action ไหนไม่ update field นี้ จะจับ update ไม่ได้
- ถ้า document เปลี่ยนก่อน tracker seed snapshot จะไม่มี before ที่ครบ
- ถ้ามีหลาย action เกิดพร้อมกัน session อาจจับ event ปน ต้องใช้ document id/user id filter
- ถ้าต้องการความแม่นระดับ production audit ควรใช้ MongoDB replica set + change streams + resume token
- EF Core MongoDB provider อาจไม่ได้ส่ง MongoDB `comment` ให้ operation ดังนั้นการ map action ผ่าน `DocumentChangeLogs` หรือ action session จะ practical กว่า

## Recommended Next Step

เริ่ม implement จาก Task 1-3 ก่อน:

1. ต่อ `.env` กับ `EdocV3_MongoDB`
2. ปรับ watcher ให้รองรับ `Audit.UpdatedDate` และ deep diff
3. ปรับ dashboard เป็น rough MVP สำหรับดู action/session + changed fields

เมื่อ dashboard เห็น event จาก frontend จริงแล้ว ค่อยทำ Task 4-6 เพื่อให้ชื่อ action และ template validation แม่นขึ้น
