# Mongo Change Tracker

เครื่องมือสำหรับนักพัฒนาเพื่อดูการเปลี่ยนแปลงของ MongoDB document ระหว่างการทดสอบ โดยแสดง document ที่เปลี่ยนแบบ real-time พร้อมรายละเอียด field แบบ before/after

## Features

- ดู document ที่มีการเปลี่ยนแปลง โดยจัดกลุ่มตาม collection และ document
- ดูรายละเอียด field ที่เปลี่ยนแปลงแบบ before/after
- เปรียบเทียบ document ระหว่าง 2 events แบบ side-by-side โดยคลิกขวาที่ event
- ใช้ Action Sessions เพื่อจับ events ที่เกิดขึ้นระหว่างการทดสอบ action
- ตรวจสอบ document กับ JSON Schema templates
- เก็บ event history ไว้ใน tracker database
- ซ่อน document และล้าง event timeline เฉพาะหน้าเว็บ โดยไม่แก้ไขข้อมูลใน MongoDB

## Run with Docker Compose

Docker Compose จะรัน tracker app โดยใช้ค่าการเชื่อมต่อจากไฟล์ `.env` และไม่สร้าง MongoDB container เพิ่มขึ้นมา โดยเหมาะกับกรณีที่มี MongoDB อยู่แล้วบนเครื่องหรือใช้ MongoDB server ภายนอก

### 1. ตั้งค่า `.env`

ถ้า MongoDB รันอยู่บน host ให้ใช้ `host.docker.internal` เมื่อรันผ่าน Docker:

```env
SOURCE_MONGO_URI=mongodb://root:your_password@host.docker.internal:27017/?authSource=admin
SOURCE_DB_NAME=your_source_db

TRACKER_MONGO_URI=mongodb://root:your_password@host.docker.internal:27017/?authSource=admin
TRACKER_DB_NAME=mongo_tracker

WATCH_COLLECTIONS=Documents,Orders
UPDATED_AT_FIELD=updatedAt
PORT=4400
```

`WATCH_COLLECTIONS` คือรายชื่อ collections ที่ต้องการติดตาม คั่นด้วย comma และ `UPDATED_AT_FIELD` คือ field ที่ backend ใช้ระบุเวลาการแก้ไข เช่น `Audit.UpdatedDate`

### 2. Start

```bash
docker-compose up -d --build
```

เปิด dashboard ที่ <http://localhost:4400>

### 3. ดู logs

```bash
docker-compose logs -f mongo-tracker
```

### 4. Stop

```bash
docker-compose down
```

## Run locally

ใช้วิธีนี้เมื่อรัน Node.js และ MongoDB บนเครื่องโดยตรง

### 1. ติดตั้ง dependencies

```bash
npm install
```

### 2. ตั้งค่า `.env`

เมื่อรันแบบ local ให้ใช้ `localhost` สำหรับ MongoDB ที่รันอยู่บนเครื่อง:

```env
SOURCE_MONGO_URI=mongodb://root:your_password@localhost:27017/?authSource=admin
SOURCE_DB_NAME=your_source_db

TRACKER_MONGO_URI=mongodb://root:your_password@localhost:27017/?authSource=admin
TRACKER_DB_NAME=mongo_tracker

WATCH_COLLECTIONS=Documents,Orders
UPDATED_AT_FIELD=updatedAt
PORT=4400
```

### 3. Start development server

```bash
npm run dev
```

เปิด dashboard ที่ <http://localhost:4400>
