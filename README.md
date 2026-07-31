# Mongo Change Tracker

Tool สำหรับ dev ที่อยากดูว่า MongoDB document เปลี่ยนแปลงอะไรบ้างระหว่าง test
เปิด dashboard แล้วกดปุ่มใน frontend ตามปกติ — document ที่เปลี่ยนจะขึ้น real-time
พร้อมแสดง field ที่เปลี่ยนแบบ before/after

## Features

- **ดู document ที่เปลี่ยน** — จัดกลุ่มตาม collection และ document แสดงใน dashboard แบบ real-time
- **before/after diff** — เห็นว่า field ไหนเปลี่ยนจากอะไรเป็นอะไร
- **Compare events** — เปรียบเทียบ document ระหว่าง 2 event โดยการ Right Click ที่ Event แบบ side-by-side field ที่ต่างกันจะถูก highlight สีเหลือง
- **Action Sessions** — กด Start ก่อนทำ action แล้วกด Stop เพื่อดูว่า document ไหนเปลี่ยนในช่วงนั้น
- **Templates** — สร้าง JSON Schema ไว้ validate ว่า document หลัง action มีหน้าตาถูกต้องตามที่ออกแบบไว้
- **History** — event ทุกอันเก็บถาวร ดู history ได้แม้ restart service

## ติดตั้ง

```bash
npm install
```

สร้างไฟล์ `.env`:

```env
SOURCE_MONGO_URI=mongodb://localhost:27017
SOURCE_DB_NAME=your_source_db

TRACKER_MONGO_URI=mongodb://localhost:27017
TRACKER_DB_NAME=mongo_tracker

WATCH_COLLECTIONS=Documents,Orders
UPDATED_AT_FIELD=updatedAt
```

> `WATCH_COLLECTIONS` — ชื่อ collection ที่ต้องการ watch คั่นด้วย comma  
> `UPDATED_AT_FIELD` — field เวลาที่ backend update ทุกครั้งที่แก้ข้อมูล เช่น `Audit.UpdatedDate`

## รัน

```bash
npm run dev
# → http://localhost:4400
```
