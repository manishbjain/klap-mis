# KLAP MIS Sync Status Update
**Date:** 2026-10-16  
**Type:** Quick count-comparison vs Oct-12/14 audit baseline  
**Method:** Supabase SQL count queries + Google Sheets API row counts  
**Scope:** Read-only. No changes made.

---

## Row-Count Summary vs Oct-12 Baseline

| Table | Sheets (Oct-12) | SB (Oct-12) | Gap (Oct-12) | Sheets (Today) | SB (Today) | Gap (Today) | Δ Gap |
|-------|----------------|-------------|--------------|----------------|------------|-------------|-------|
| production_orders | 10,862 | 10,843 | 19 | **10,879** | **10,866** | **13** | ✅ −6 |
| orders | 11,734 | 11,714 | 20 | **11,745** | **11,736** | **9** | ✅ −11 |
| delivery_orders | 3,906 | 3,889 | 17 | **3,932** | **3,914** | **18** | ⚠️ +1 |
| rm_out | 4,630 | 4,595 | 35 | N/A¹ | **4,630** | **?** | — |
| pro_steps | 14,617 | 14,571 | 46 | **14,657** | **14,649** | **8** | ✅ −38 |
| fg_inventory | 30,956 | 30,826 | 130 | **31,027** | **30,991** | **36** | ✅ −94 |
| **TOTAL (excl. rm_out)** | **71,475** | **71,343** | **132** | **72,240** | **72,186** | **84** | ✅ −48 |

¹ RM_Out sheet lives in a separate workbook (KLAPAPP_Inventory) not accessible this run. Supabase `rm_out` has now reached 4,630 — the Oct-12 Sheets baseline — so the 35-row backlog from that audit is fully cleared. Current Sheets count unknown; SB may or may not be fully caught up to today's Sheets.

**Bottom line on the 265-row backlog:** ~181 rows have synced in the 4 days since the audit (mostly pro_steps +38 and fg_inventory +94). Estimated ~84 rows remain pending in known tables.

---

## Data Quality Issues — Regressions ⚠️

### 1. Blank `product_id` in `orders` — got worse (7 → 12)
Oct-12 had 7 orders (OID11697–OID11706) with blank `product_id` because products P1026_5592–P1026_5598 weren't in the products table yet.  
Today there are **12** such orders. Five more orders were created referencing products not yet in the products table.

| # | Count | Orders affected |
|---|-------|----------------|
| Oct-12 | 7 | OID11697–OID11706 |
| Today | **12** | OID11697–OID11706 + 5 more |

**Impact:** These orders exist in Supabase but have no product linkage — reports filtering by product will miss them.

### 2. Capital-A `Active` orders — got worse (8 → 13)
Oct-12 had 8 orders with `order_status = 'Active'` (capital A) instead of the correct `'active'`.  
Today there are **13**. Five more orders were inserted with the wrong casing.

**Impact:** Cosmetic but systematic — a data entry path is consistently bypassing case normalisation. If not fixed at the source, this will keep growing.

---

## Status on Previously Open Items

| Item | Oct-12 Status | Today |
|------|--------------|-------|
| 265 missing rows | Open | ~181 synced; ~84 remain |
| 7 blank product_ids | Open | ❌ Worsened to 12 |
| Capital-A Active orders | 8 (from Oct-08) | ❌ Worsened to 13 |
| rm_out 35-row backlog | Open | ✅ SB caught up to Oct-12 Sheets baseline |

---

## Recommended Actions

### 🔴 Urgent — Stop the bleeding

1. **Find and fix the insertion path creating capital-A `Active` orders.** 5 more were added since Oct-12. A DB-level `CHECK` constraint or trigger forcing `lower(order_status)` would prevent recurrence.

2. **Add the 5 new missing products to the `products` table** so the 12 orders can get their `product_id` linked. The 7 original ones (P1026_5592–P1026_5598) are still unresolved — total now 12 with `product_id = NULL` or blank.

### 🟡 Ongoing — Sync monitoring

3. **RM_Out:** Verify current Sheets count against SB 4,630 (need KLAPAPP_Inventory workbook access).

4. **Remaining ~84 rows:** Continue normal sync cadence. At current rate (~45 rows/day), all tables should close within 2–3 days.

---

*Audit performed by Claude (Cowork) on 2026-10-16. Read-only — no data was modified.*
