# Krishiv Labels & Packaging MIS — Data Accuracy Audit
**Date:** 2026-10-08  
**Sources:** Google Sheets (ID: `1RaHeVHdTQxRmI3QD2YRv986AP7ROREe7ExjgAdgKnD0`) vs Supabase (project: `clthyxztmsfumfzxbmvf`)  
**Scope:** Read-only comparison. No changes were made to either source.

---

## 1. Products (design_status) ✅

**Counts match perfectly.**

| Source | Total Rows |
|--------|-----------|
| Google Sheets (`Products` tab) | 5,600 |
| Supabase (`products` table) | 5,600 |

### Status Distribution

| Status | Sheets | Supabase |
|--------|--------|----------|
| File Ready / `file_ready` | 4,417 | 4,417 |
| Cancelled / `cancelled` | 1,155 | 1,155 |
| Internal Approval / `internal_approval` | 22 | 22 |
| In Process / `in_process` | 4 | 4 |
| To Begin Yet / `to_process` | 2 | 2 |
| **Total** | **5,600** | **5,600** |

### Findings
- ✅ 0 IDs in Sheets missing from Supabase
- ✅ 0 IDs in Supabase missing from Sheets
- ✅ 0 status mismatches
- ✅ Perfect 1-to-1 match on all 5,600 rows

---

## 2. Orders ⚠️

**Row counts match, but 21 status mismatches found + 8 case-inconsistency rows in Supabase.**

| Source | Total Rows |
|--------|-----------|
| Google Sheets (`Orders` tab) | 11,714 |
| Supabase (`orders` table) | 11,714 |

### Status Distribution

| Status | Sheets | Supabase |
|--------|--------|----------|
| Complete / `complete` | 10,141 | 10,120 |
| Cancelled / `cancelled` | 1,180 | 1,180 |
| On Hold / `on_hold` | 175 | 175 |
| Active / `active` | 218 | 231 (lowercase) |
| Active / `Active` | — | 8 (capital A — **bug**) |

### Issue A — 21 Orders Marked Complete in Sheets but `active` in Supabase

These orders were completed in Google Sheets but Supabase still shows them as `active`. They are likely recently closed orders where the sync hasn't propagated.

| OID | Sheets Status | Supabase Status |
|-----|--------------|----------------|
| OID11483 | Complete | active |
| OID11535 | Complete | active |
| OID11561 | Complete | active |
| OID11591 | Complete | active |
| OID11592 | Complete | active |
| OID11599 | Complete | active |
| OID11643 | Complete | active |
| OID11644 | Complete | active |
| OID11648 | Complete | active |
| OID11649 | Complete | active |
| OID11650 | Complete | active |
| OID11651 | Complete | active |
| OID11652 | Complete | active |
| OID11653 | Complete | active |
| OID11654 | Complete | active |
| OID11655 | Complete | active |
| OID11656 | Complete | active |
| OID11657 | Complete | active |
| OID11658 | Complete | active |
| OID11659 | Complete | active |
| OID11660 | Complete | active |

### Issue B — 8 Orders with `Active` (capital A) in Supabase

Supabase should use consistent lowercase `active`. These 8 orders have a capital-A value, likely from a data entry or import that bypassed the normal validation. All 8 match the Sheets status (Active), so the data is correct, only the casing is wrong.

| OID | Sheets Status | Supabase Status |
|-----|--------------|----------------|
| OID11707 | Active | `Active` (should be `active`) |
| OID11708 | Active | `Active` |
| OID11709 | Active | `Active` |
| OID11710 | Active | `Active` |
| OID11711 | Active | `Active` |
| OID11712 | Active | `Active` |
| OID11713 | Active | `Active` |
| OID11714 | Active | `Active` |

---

## 3. Production Orders ✅

**Counts match perfectly. All field values match.**

| Source | Total Rows |
|--------|-----------|
| Google Sheets (`Production` tab) | 10,843 |
| Supabase (`production_orders` table) | 10,843 |

### Key Field Comparison

| Field | Sheets | Supabase |
|-------|--------|----------|
| `is_cancelled = Yes/True` | 211 | 211 |
| `is_on_hold = Yes/True` | 0 | 0 |

### Findings
- ✅ 0 PROD IDs in Sheets missing from Supabase
- ✅ 0 PROD IDs in Supabase missing from Sheets
- ✅ `is_cancelled` flags match on all 211 cancelled rows
- ✅ `is_on_hold` flags match (all False/empty in both)

> **Note on ID format:** Supabase `production_orders` uses both short IDs (`PROD05011`) and long legacy IDs (`PROD03449_2411_4166_P0721_2742`). These match the Sheets values and are not an error — they are a known historical ID format difference.

---

## 4. Jobs ⚠️

**13 Job IDs exist in Sheets but are missing from Supabase.**

| Source | Total Rows |
|--------|-----------|
| Google Sheets (`Jobs` tab) | 6,830 |
| Supabase (`jobs` table) | 6,817 |
| **Difference** | **13 missing from Supabase** |

### Jobs in Sheets but Missing from Supabase

These are all recent jobs (JB7014–JB7026M) — likely created after the last sync ran:

| Job ID |
|--------|
| JB7014 |
| JB7015 |
| JB7016 |
| JB7017M |
| JB7018M |
| JB7019 |
| JB7020M |
| JB7021 |
| JB7022M |
| JB7023M |
| JB7024M |
| JB7025 |
| JB7026M |

### Additional Note — Supabase `status` Field
All 6,817 jobs in Supabase have `status = 'done'`. The Sheets `Jobs` tab does not have a status column. This appears to be a Supabase-only field used by the app, not sourced from Sheets.

---

## 5. Design Queue ⚠️

**Supabase `design_queue` table is completely empty. Sheets has 3 active items.**

| Source | Total Rows |
|--------|-----------|
| Google Sheets (`Design` tab) | 3 |
| Supabase (`design_queue` table) | **0** |

### All 3 Items Missing from Supabase

| ID | Product Code | Product Name | Status | Assigned To |
|----|-------------|-------------|--------|-------------|
| DID/P0221/CS2826 | P0221/CS2826 | Hanger Label (V2) - Art Paper | To Begin Yet | Creative |
| DID/P0221/CS2825 | P0221/CS2825 | Maharaja - Chromo - Foil Stamping | To Begin Yet | Creative |
| DID/P0221/CS2824 | P0221/CS2824 | Rekha - Fluroscent - Foil Stamping | To Begin Yet | Creative |

> **Note:** The Google Sheets `Design` tab uses `ID` format `DID/P0221/CS2826` (slash-separated). The Supabase `design_queue` schema has an `id` (text), `product_id` (text), `design_status` (text), `assigned_to` (text), `priority` (text), and `notes` (text). The ID format and column names will need mapping when inserting these records.

---

## Summary of Actions Needed

### 🔴 High Priority

| # | Table | Action | Details |
|---|-------|--------|---------|
| 1 | **orders** | Update 21 stale `active` → `complete` in Supabase | OID11483, OID11535, OID11561, OID11591, OID11592, OID11599, OID11643, OID11644, OID11648–OID11660 (21 rows total). These are completed in Sheets but show as active in Supabase. |
| 2 | **design_queue** | Insert 3 missing rows into Supabase | DID/P0221/CS2824, CS2825, CS2826 — all assigned to "Creative", status "To Begin Yet" |
| 3 | **jobs** | Insert 13 missing jobs into Supabase | JB7014–JB7026M — newly created jobs not yet synced |

### 🟡 Medium Priority

| # | Table | Action | Details |
|---|-------|--------|---------|
| 4 | **orders** | Fix case inconsistency on 8 rows | Update `order_status = 'Active'` → `'active'` for OID11707–OID11714. Likely a DB constraint/trigger should enforce lowercase. |

### ✅ No Action Needed

| Table | Status |
|-------|--------|
| products | Perfect match — 5,600 rows, 0 mismatches |
| production_orders | Perfect match — 10,843 rows, 0 mismatches |

---

*Audit performed by Claude (Cowork) on 2026-10-08. Read-only — no data was modified.*
