# Diff Viewer Plan

## ปัญหาปัจจุบัน

- field ที่เป็น object/array ขนาดใหญ่เช่น `Receiver.Recipients` แสดง before/after เป็น JSON string ยาวในตาราง
- ไม่รู้ว่าเปลี่ยนบรรทัดไหน ต้องอ่านทั้งก้อน
- ตาราง 3 column (field / before / after) ไม่เหมาะกับ value ที่เป็น nested object

---

## สิ่งที่อยากได้

กด "Compare" แล้วเปิด side-by-side diff panel แสดงแบบนี้:

```
[ก่อน]                          [หลัง]
  "ApproveStatus": {           "ApproveStatus": {
-   "Id": 0,                 +   "Id": 1,
-   "Name": ""               +   "Name": "Approved"
  }                            }
```

- บรรทัดที่ลบออกแสดงสีแดง
- บรรทัดที่เพิ่มมาแสดงสีเขียว
- บรรทัดที่ไม่เปลี่ยนแสดงสีเทา (ย่อได้)

---

## แผนการทำ (3 ระดับ)

### Level 1 — JSON Pretty Diff (เร็วสุด, ทำได้ใน dashboard เดิม)

**วิธีทำ:**

1. เพิ่มปุ่ม `Compare` ใน changed fields table แต่ละ row ที่ value เป็น object/array
2. เมื่อกด popup/modal แสดง side-by-side diff
3. ใช้ library ฝั่ง browser ที่ไม่ต้อง build เช่น `jsondiffpatch` หรือ `diff-match-patch`

**สิ่งที่ต้องทำ:**

- เพิ่ม `<script src="https://cdn.jsdelivr.net/npm/jsondiffpatch/dist/jsondiffpatch.umd.min.js">` ใน `index.html`
- เพิ่ม `<link>` สำหรับ jsondiffpatch formatters CSS
- เพิ่มปุ่ม `Compare` ใน field table row
- เพิ่ม modal overlay แสดง jsondiffpatch HTML formatter output
- สไตล์ให้เข้ากับ dark theme ของ dashboard

**ตัวอย่าง output ที่ได้:**

jsondiffpatch HTML formatter แสดงแบบ annotated diff:
- `_t: 'a'` = array diff
- ข้อความที่ลบแสดง strikethrough สีแดง
- ข้อความที่เพิ่มแสดงสีเขียว
- nested object drill-down ได้

---

### Level 2 — Custom Line Diff Modal

**วิธีทำ:**

ใช้ `diff` library (ใน npm) หรือเขียน line differ เองใน server/client:

1. Server เพิ่ม endpoint `GET /api/events/:eventId/diff?field=Receiver.Recipients`
2. Server ทำ `JSON.stringify(before, null, 2).split('\n')` และ `JSON.stringify(after, null, 2).split('\n')`
3. ทำ LCS diff ระหว่างสอง array ของ lines
4. Return `[{ type: 'equal'|'added'|'removed', line: string }]`
5. Dashboard render เป็น unified diff หรือ side-by-side

**API ที่จะเพิ่ม:**

```
GET /api/events/:eventId/diff
  ?field=Receiver.Recipients   ← optional, ถ้าไม่ส่งจะ diff เต็ม document
  ?mode=unified|split          ← default: split
```

**Response:**

```json
{
  "field": "Receiver.Recipients",
  "lines": [
    { "type": "equal",   "lineNo": 1, "before": "{",           "after": "{" },
    { "type": "removed", "lineNo": 2, "before": "  \"Id\": 0", "after": null },
    { "type": "added",   "lineNo": 2, "before": null,          "after": "  \"Id\": 1" }
  ]
}
```

---

### Level 3 — Embedded Monaco Editor Diff (สวยสุด)

ใช้ Monaco Editor (VS Code engine) ที่โหลดจาก CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
```

แสดง diff แบบ VS Code เปิด diff editor ใน modal โดยตรง:

```js
monaco.editor.createDiffEditor(container, {
  original: monaco.editor.createModel(beforeJson, "json"),
  modified: monaco.editor.createModel(afterJson, "json"),
  readOnly: true,
  renderSideBySide: true
})
```

**ข้อดี:**
- รองรับ syntax highlight, fold, minimap
- เหมือน VS Code ทำงานได้เลยไม่ต้อง build
- รองรับ dark theme ตามเดิม

**ข้อจำกัด:**
- CDN bundle ใหญ่ (~2MB) โหลดครั้งแรกช้านิด

---

## Recommended: Level 1 + Level 3

ทำ Level 1 ก่อนเพราะเร็วและใช้งานได้ทันที จากนั้นค่อยเพิ่ม Monaco ถ้าต้องการ diff ที่ละเอียดขึ้น

### UI Flow ที่แนะนำ

```
[Changed Fields table]
┌─────────────────┬──────────┬──────────┬─────────┐
│ FIELD           │ BEFORE   │ AFTER    │         │
├─────────────────┼──────────┼──────────┼─────────┤
│ Status.Doc...   │ 0        │ 2        │         │
│ Receiver.Re...  │ [Array]  │ [Array]  │ Compare │  ← ถ้า value เป็น object/array
└─────────────────┴──────────┴──────────┴─────────┘
                                              ↓ กด Compare
                        ┌─────────────────────────────────┐
                        │  Diff: Receiver.Recipients     × │
                        │  ─────────────────────────────   │
                        │  [before JSON]  [after JSON]      │
                        │   line 1        line 1            │
                        │ - line 2      + line 2            │
                        └─────────────────────────────────┘
```

---

## Implementation Tasks

| Task | ไฟล์ที่แก้ | ประมาณเวลา |
|------|-----------|-----------|
| เพิ่ม jsondiffpatch CDN + CSS | `public/index.html` | 10 นาที |
| เพิ่มปุ่ม Compare ใน field table | `public/index.html` | 15 นาที |
| เพิ่ม modal/overlay สำหรับ diff | `public/index.html` | 20 นาที |
| Dark theme override สำหรับ jsondiffpatch | `public/index.html` | 15 นาที |
| (Optional) เพิ่ม Monaco Diff Editor | `public/index.html` | 30 นาที |
| (Optional) server endpoint `/diff` | `src/server.js` | 30 นาที |

---

## เริ่มทำได้เลยถ้าพร้อม

รันคำสั่ง:
```
แก้ mongo-tracker ตาม diff-viewer-plan ได้เลย
```
