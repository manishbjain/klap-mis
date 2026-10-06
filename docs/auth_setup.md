# KLAP MIS — Authentication Setup Documentation
*Completed: October 2026*

---

## Overview

The app uses **Google OAuth via Supabase Auth**. Users sign in with their Gmail. Only emails listed in the `app_users` Supabase table are allowed in — everyone else gets "not authorised."

**Cost: Free** — Google OAuth is free, Supabase Auth is free up to 50,000 monthly active users.

---

## Architecture

```
User clicks "Sign in with Google"
    ↓
Supabase Auth handles OAuth flow with Google
    ↓
Google redirects back to Supabase callback URL
    ↓
Supabase redirects back to the app (GitHub Pages URL)
    ↓
App calls Edge Function /auth endpoint with user's email
    ↓
Edge function checks app_users table
    ↓
If found + active → returns user profile + permissions
If not found → "not authorised" error
If inactive → "account deactivated" error
    ↓
App loads with role-based access applied
```

---

## What Was Set Up

### 1. Google Cloud Console
- **URL:** console.cloud.google.com
- **Account used:** mgtkrishiv@gmail.com
- **Project:** klap-mis (or whatever was named during setup)
- **Credential type:** OAuth 2.0 Client ID → Web application
- **Settings:**
  - Use for AI agent: **No**
  - User type: **External**
  - Authorised JavaScript origins: `https://manishbjain.github.io`
  - Authorised redirect URIs: `https://clthyxztmsfumfzxbmvf.supabase.co/auth/v1/callback`
- **Output:** Client ID + Client Secret (pasted into Supabase)

### 2. Supabase Dashboard
- **URL:** supabase.com → project clthyxztmsfumfzxbmvf
- **Authentication → Providers → Google**
  - Toggle: ON
  - Client ID: (from Google Cloud)
  - Client Secret: (from Google Cloud)
  - Saved ✅
- **Authentication → URL Configuration**
  - Site URL: `https://manishbjain.github.io/klap-mis/`
  - Redirect URLs: `https://manishbjain.github.io/klap-mis/`
  - Saved ✅

### 3. Supabase Database Tables

#### `roles` table
Pre-seeded with 6 system roles:

| id | name | description |
|---|---|---|
| owner | Owner | Full access — all tables, user & role management |
| manager | Manager | Full operational access, no user management |
| prepress | Prepress | Production planning — jobs, PROs, processes |
| sales | Sales | Order entry and customer management |
| accounts | Accounts | Despatch, invoicing, purchase orders, RM |
| operator | Floor Operator | View assigned jobs, log process step completion |

#### `app_users` table
| column | type | notes |
|---|---|---|
| id | uuid | auto-generated |
| email | text | Gmail address — must match exactly |
| name | text | Display name |
| role_id | text | FK → roles.id |
| is_active | bool | false = blocked from login |
| last_login | timestamptz | auto-updated on each login |
| created_at | timestamptz | auto |

**Current users:**
| email | name | role |
|---|---|---|
| mgtkrishiv@gmail.com | Manish Jain | owner |

#### `role_permissions` table
One row per role per resource (table). Columns:
- `role_id`, `resource` (table name)
- `can_read`, `can_write`, `can_delete` (booleans)
- `hidden_fields` (jsonb — fields to hide from this role)
- `visible_fields` (jsonb — if set, only these fields shown)
- `row_filter` (text — SQL-like condition e.g. `created_by = {me}`)

#### `audit_log` table
Every DB write automatically logged via Postgres triggers. Columns:
- `user_email`, `user_name`, `role_id`
- `action` (insert/update/delete/login/logout)
- `resource` (table name), `record_id`
- `old_data`, `new_data` (jsonb — full before/after)
- `created_at`

Triggers attached to: orders, production_orders, pro_steps, jobs, products, delivery_orders, delivery_order_items, purchase_orders, fg_inventory, rm_in, rm_out, app_users

### 4. Edge Function Endpoints
Base URL: `https://clthyxztmsfumfzxbmvf.supabase.co/functions/v1/klap-mis-data`

| Endpoint | Method | Purpose |
|---|---|---|
| `/klap-mis-data/auth` | POST | Check email, return user + permissions, log login |
| `/klap-mis-data/admin` | GET | Fetch users / roles / permissions / audit log |
| `/klap-mis-data/admin` | POST | Save user / role / permission changes |
| `/klap-mis-data` | GET | Main data fetch — all 17 business tables |

### 5. App Changes
- Login screen added (shown before app loads)
- `SB_CLIENT` = Supabase JS client for OAuth
- `CURRENT_USER`, `USER_ROLE`, `PERMISSIONS` globals set after login
- `canRead(resource)`, `canWrite(resource)`, `canDelete(resource)` helper functions
- `applyNavPermissions()` hides sidebar items the user can't access
- Settings page added with 4 tabs: Users, Roles, Permissions, Audit Log

---

## How to Add a New User

**Option 1 — From the app (easiest):**
1. Open app → Settings → Users tab
2. Click "+ Add User"
3. Enter their Gmail address, name, and role
4. Click "Add User"

**Option 2 — Direct SQL in Supabase:**
```sql
INSERT INTO app_users (email, name, role_id, is_active)
VALUES ('newuser@gmail.com', 'Their Name', 'prepress', true);
```

---

## How to Change a User's Role

**From app:** Settings → Users → Edit button next to user → change role → Save

**Direct SQL:**
```sql
UPDATE app_users SET role_id = 'manager' WHERE email = 'user@gmail.com';
```

---

## How to Deactivate a User

**From app:** Settings → Users → "Deactivate" button

**Direct SQL:**
```sql
UPDATE app_users SET is_active = false WHERE email = 'user@gmail.com';
```

---

## How to Edit Permissions for a Role

1. Open app → Settings → Permissions tab
2. Select role from dropdown
3. Check/uncheck Read, Write, Delete per table
4. Add row filters or hidden fields as needed
5. Click "Save All"

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| "Your email is not authorised" | Email not in app_users table | Add email via Settings → Users or direct SQL |
| "Account deactivated" | is_active = false | Update app_users SET is_active = true |
| "Unsupported provider" | Google not enabled in Supabase | Auth → Providers → Google → toggle ON → Save |
| "Safari can't connect" | Safari cross-site tracking | Use Chrome, or disable cross-site tracking in Safari |
| Blank screen after login | Redirect URL not configured | Auth → URL Configuration → add GitHub Pages URL |
| "Validation failed" | Redirect URL mismatch | Add `https://manishbjain.github.io/klap-mis/` to Supabase redirect URLs |

---

## Security Notes

- The Supabase **publishable key** is in the HTML (safe — it's designed to be public)
- All data access goes through the **Edge Function which uses the service role key** (server-side, never exposed)
- **RLS (Row Level Security)** is enabled on all tables — direct REST API calls return nothing
- Only the Edge Function (service_role) can read data
- Audit log records every login and every data change with full before/after values

---

## Files Reference

| File | Location |
|---|---|
| App HTML | github.com/manishbjain/klap-mis → index.html |
| Live URL | https://manishbjain.github.io/klap-mis/ |
| Supabase project | clthyxztmsfumfzxbmvf.supabase.co |
| Edge function source | Supabase dashboard → Edge Functions → klap-mis-data |
