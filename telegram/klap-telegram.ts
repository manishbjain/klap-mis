// klap-telegram — Telegram bot for KLAP MIS
// Flow 1: New Order group → Claude parses → provisional card (Confirm / Edit-by-reply / Delete) → order in Supabase
// Flow 2: New product → forum topic in Product Designs group → chat mirrored to design_messages, status buttons
// App routes (Supabase user JWT + app_users whitelist): inbox, design threads, post to topic, change status
import { createClient } from "npm:@supabase/supabase-js@2";

function encodeBase64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const OPS_SHEET_ID = "1RaHeVHdTQxRmI3QD2YRv986AP7ROREe7ExjgAdgKnD0";
const IMAGE_URL = (pid: string) => `${SB_URL}/functions/v1/klap-mis-data/image/${encodeURIComponent(pid)}`;
const FN_BASE = "/klap-telegram";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });

const UNITS = ["pcs", "Minimum", "kg", "meters", "packets", "bundles", "Single Block", "Double Block"];
const CATEGORIES = ["SA", "NA", "CR", "IM", "TU", "LP", "HT", "TG", "BL", "FB", "3D", "PU", "RB"];
const STATUS_LABEL: Record<string, string> = {
  to_process: "To Begin Yet",
  in_process: "In Process",
  internal_approval: "Internal Approval",
  customer_approval: "Customer Approval",
  file_ready: "File Ready",
  cancelled: "Cancelled",
};
const STATUS_CODE: Record<string, string> = { ip: "in_process", ia: "internal_approval", ca: "customer_approval", fr: "file_ready" };

// ───────────────────────── helpers ─────────────────────────
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fmtQty = (n: number | null) => (n == null ? "?" : Number(n).toLocaleString("en-IN"));
const tgName = (u: any) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || u?.username || "someone";
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) console.error(`tg ${method} failed`, JSON.stringify(j).slice(0, 400));
  return j;
}

async function tgDownload(fileId: string): Promise<{ bytes: Uint8Array; path: string } | null> {
  const f = await tg("getFile", { file_id: fileId });
  if (!f.ok) return null;
  const r = await fetch(`https://api.telegram.org/file/bot${BOT}/${f.result.file_path}`);
  if (!r.ok) return null;
  return { bytes: new Uint8Array(await r.arrayBuffer()), path: f.result.file_path };
}

async function getConfig(key: string): Promise<string | null> {
  const { data } = await sb.from("telegram_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
async function setConfig(key: string, value: string) {
  await sb.from("telegram_config").upsert({ key, value, updated_at: new Date().toISOString() });
}

async function displayNameFor(tgUser: any): Promise<string> {
  if (tgUser?.id) {
    const { data } = await sb.from("app_users").select("name,email").eq("telegram_user_id", tgUser.id).maybeSingle();
    if (data) return data.name || data.email;
  }
  return tgName(tgUser);
}

function topicLink(chatId: number | string, threadId: number | string) {
  const c = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${c}/${threadId}`;
}

// ───────────────────────── Claude ─────────────────────────
async function claudeTool(system: string, content: any[], tool: any): Promise<any> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Claude error: " + JSON.stringify(j).slice(0, 300));
  const block = (j.content || []).find((b: any) => b.type === "tool_use");
  if (!block) throw new Error("Claude returned no tool call");
  return block.input;
}

const EXTRACT_SYSTEM = `You read order messages posted in the "New Order" Telegram group of Krishiv Labels & Packaging (Ahmedabad), a label and packaging printer.
Messages are informal and may be in English, Hindi, Gujarati or a mix, or a screenshot/photo of a customer's message or PO.
Products: self-adhesive labels (SA), non-adhesive labels (NA), corrugated boxes (CR), in-mould labels (IM), shrink sleeves, folding cartons, tags (TG) etc.
Extract every distinct order (one product + one quantity = one order). If the message is chit-chat or not an order, set is_order=false.
- customer_text: the customer/party/brand as written (company, brand or short name).
- product_text: the product as written (label name, size, variant, code). Keep all distinguishing words like sizes (28cm), variants (S/B), codes.
- qty: a number (convert "5k" → 5000, "1 lakh" → 100000). units: one of ${UNITS.join(", ")}; default "pcs". "Minimum" means minimum order quantity.
- is_new_product: true only if the message says it is a new design/new label/new product.
- has_changes: true if it is a repeat but with modifications (new MRP, changed text, size change…); describe in change_desc.
- order_type: "From Stock" only if they say supply from stock/ready stock, else "From Production".
- Put urgency, delivery date, rates and anything else useful in notes. party_reference = customer's PO number if any.
Do not invent data you cannot see.`;

const extractTool = {
  name: "record_orders",
  description: "Record the orders found in the message.",
  input_schema: {
    type: "object",
    properties: {
      is_order: { type: "boolean" },
      orders: {
        type: "array",
        items: {
          type: "object",
          properties: {
            customer_text: { type: "string" },
            product_text: { type: "string" },
            qty: { type: ["number", "null"] },
            units: { type: "string", enum: UNITS },
            is_new_product: { type: "boolean" },
            has_changes: { type: "boolean" },
            change_desc: { type: ["string", "null"] },
            category: { type: ["string", "null"], enum: [...CATEGORIES, null] },
            material: { type: ["string", "null"] },
            order_type: { type: "string", enum: ["From Production", "From Stock"] },
            party_reference: { type: ["string", "null"] },
            notes: { type: ["string", "null"] },
          },
          required: ["customer_text", "product_text", "qty", "units", "is_new_product", "has_changes", "order_type"],
        },
      },
    },
    required: ["is_order", "orders"],
  },
};

const RESOLVE_SYSTEM = `You match a parsed order to the KLAP MIS database. You get the original message, the parsed order, candidate customers and candidate products (with how recently/often each was ordered).
Choose customer_id from the customer candidates (null if none plausibly matches).
Choose product_id from the product candidates of that customer, or null if it is a new product (message says new design, or no candidate plausibly matches).
When several products fit equally well, prefer the one ordered most recently and set confidence "low" so a human checks.
For a new product give new_product_name: a clean product name in the style of the customer's existing product names.`;

const resolveTool = {
  name: "resolve_order",
  description: "Pick the matching customer and product.",
  input_schema: {
    type: "object",
    properties: {
      customer_id: { type: ["string", "null"] },
      product_id: { type: ["string", "null"] },
      is_new_product: { type: "boolean" },
      new_product_name: { type: ["string", "null"] },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reason: { type: "string" },
    },
    required: ["customer_id", "product_id", "is_new_product", "confidence"],
  },
};

async function mediaBlocks(msg: any): Promise<any[]> {
  const out: any[] = [];
  try {
    if (msg.photo?.length) {
      const big = msg.photo[msg.photo.length - 1];
      const f = await tgDownload(big.file_id);
      if (f) out.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: encodeBase64(f.bytes) } });
    } else if (msg.document && (msg.document.file_size ?? 0) < 15e6) {
      const mt = msg.document.mime_type || "";
      if (mt.startsWith("image/") || mt === "application/pdf") {
        const f = await tgDownload(msg.document.file_id);
        if (f) {
          out.push(
            mt === "application/pdf"
              ? { type: "document", source: { type: "base64", media_type: mt, data: encodeBase64(f.bytes) } }
              : { type: "image", source: { type: "base64", media_type: mt, data: encodeBase64(f.bytes) } },
          );
        }
      }
    }
  } catch (e) {
    console.error("media download failed", e);
  }
  return out;
}

// ───────────────────────── matching ─────────────────────────
async function searchCustomers(q: string) {
  if (!q) return [];
  const { data } = await sb.rpc("tg_search_customers", { q, n: 5 });
  return (data || []) as any[];
}
async function searchProducts(customerId: string, q: string) {
  const { data } = await sb.rpc("tg_search_products", { p_customer: customerId, q: q || "", n: 8 });
  return (data || []) as any[];
}

// Turns one extracted order into inbox fields + candidates
async function resolveOrder(o: any, rawText: string, forcedCustomerId?: string | null) {
  let custCands = await searchCustomers(o.customer_text || "");
  let cust: any = null;
  if (forcedCustomerId) {
    const { data } = await sb.from("accounts").select("id,name,brand,alias,city").eq("id", forcedCustomerId).maybeSingle();
    if (data) {
      cust = { ...data, score: 1 };
      custCands = [cust, ...custCands.filter((c) => c.id !== cust.id)];
    }
  } else if (custCands[0]?.score >= 0.75 && (!custCands[1] || custCands[0].score - custCands[1].score >= 0.15)) {
    cust = custCands[0];
  }
  const plausible = custCands.filter((c) => c.score >= 0.35);
  const forProducts = cust ? [cust] : plausible.slice(0, 2);
  const prodCands: any[] = [];
  for (const c of forProducts) prodCands.push(...(await searchProducts(c.id, o.product_text || "")));

  let res: any = { customer_id: cust?.id ?? null, product_id: null, is_new_product: !!o.is_new_product, confidence: "low" };
  if (plausible.length || cust) {
    try {
      res = await claudeTool(RESOLVE_SYSTEM, [{
        type: "text",
        text: JSON.stringify({
          original_message: rawText,
          parsed_order: o,
          customer_candidates: (cust ? [cust] : plausible).map((c) => ({ id: c.id, name: c.name, brand: c.brand, alias: c.alias, score: c.score })),
          product_candidates: prodCands.map((p) => ({
            id: p.id, name: p.product_name, customer_id: p.customer_id, design_status: p.design_status,
            category: p.category, material: p.material, last_order: p.last_order, order_count: p.order_count, match: p.score,
          })),
        }),
      }], resolveTool);
    } catch (e) {
      console.error("resolve failed", e);
    }
  }
  // validate Claude's picks against candidates
  const custIds = new Set((cust ? [cust] : plausible).map((c) => c.id));
  if (forcedCustomerId) res.customer_id = forcedCustomerId;
  if (res.customer_id && !custIds.has(res.customer_id)) res.customer_id = cust?.id ?? null;
  const chosenProd = prodCands.find((p) => p.id === res.product_id && (!res.customer_id || p.customer_id === res.customer_id));
  if (!chosenProd) res.product_id = null;
  const customer = custCands.find((c) => c.id === res.customer_id) || null;

  const altProducts = prodCands
    .filter((p) => p.customer_id === res.customer_id && p.id !== res.product_id)
    .slice(0, 3)
    .map((p) => ({ id: p.id, name: p.product_name, design_status: p.design_status }));
  const altCustomers = custCands
    .filter((c) => c.id !== res.customer_id && c.score >= 0.3)
    .slice(0, 3)
    .map((c) => ({ id: c.id, name: c.name }));

  const isNew = !chosenProd;
  return {
    customer_id: customer?.id ?? null,
    customer_name: customer?.name ?? null,
    product_id: chosenProd?.id ?? null,
    product_name: chosenProd?.product_name ?? (res.new_product_name || o.product_text || null),
    is_new_product: isNew,
    is_repeat: !isNew && !o.has_changes,
    has_changes: !isNew && !!o.has_changes,
    change_desc: o.change_desc ?? null,
    category: chosenProd?.category ?? o.category ?? null,
    material: chosenProd?.material ?? o.material ?? null,
    qty: o.qty != null ? Math.round(Number(o.qty)) : null,
    units: o.units || "pcs",
    order_type: o.order_type || "From Production",
    party_reference: o.party_reference ?? null,
    notes: o.notes ?? null,
    candidates: {
      customers: altCustomers,
      products: altProducts,
      confidence: res.confidence,
      last_order: chosenProd?.last_order ?? null,
      design_status: chosenProd?.design_status ?? null,
      reason: res.reason ?? null,
    },
  };
}

// ───────────────────────── card ─────────────────────────
function renderCard(r: any) {
  const c = r.candidates || {};
  const lines: string[] = [];
  lines.push(`🧾 <b>Provisional order</b>  <code>#${r.id.slice(0, 6)}</code>`);
  lines.push(r.customer_id ? `👤 <b>${esc(r.customer_name)}</b>` : `👤 ❓ <b>Customer not matched</b> — pick below or reply with the name`);
  if (r.product_id) {
    lines.push(`📦 <b>${esc(r.product_name)}</b>  <code>${esc(r.product_id)}</code>`);
    if (r.has_changes) lines.push(`✏️ Repeat <b>with changes</b>${r.change_desc ? ": " + esc(r.change_desc) : ""}`);
    else lines.push(`🔁 Repeat order${c.last_order ? ` (last ordered ${esc(c.last_order)})` : ""}`);
    if (c.design_status && c.design_status !== "file_ready") lines.push(`⚠️ Design status: ${esc(STATUS_LABEL[c.design_status] || c.design_status)}`);
  } else {
    lines.push(`📦 <b>${esc(r.product_name || "?")}</b>`);
    lines.push(`✨ <b>New product</b> — a design topic will be created on confirm`);
  }
  lines.push(`🔢 <b>${fmtQty(r.qty)} ${esc(r.units || "")}</b> · ${esc(r.order_type)}`);
  if (r.party_reference) lines.push(`🧷 PO: ${esc(r.party_reference)}`);
  if (r.notes) lines.push(`📝 ${esc(r.notes)}`);
  if (c.confidence === "low" && r.product_id) lines.push(`\n⚠️ <i>Not sure about the product — check the options below.</i>`);
  lines.push(`\n<i>Posted by ${esc(r.posted_by)} · reply to this card to correct anything</i>`);

  const kb: any[][] = [[
    { text: "✅ Confirm", callback_data: `c:${r.id}` },
    { text: "🗑 Delete", callback_data: `d:${r.id}` },
  ]];
  (c.products || []).forEach((p: any, i: number) => kb.push([{ text: `↪ ${short(p.name || p.id, 34)}`, callback_data: `pp:${r.id}:${i}` }]));
  (c.customers || []).forEach((p: any, i: number) => kb.push([{ text: `👤 ${short(p.name, 34)}`, callback_data: `pc:${r.id}:${i}` }]));
  const row: any[] = [];
  if (r.product_id) row.push({ text: "✨ Treat as new product", callback_data: `np:${r.id}` });
  if (r.product_id) row.push({ text: r.has_changes ? "↩︎ No changes" : "✏️ With changes", callback_data: `hc:${r.id}` });
  row.push({ text: r.order_type === "From Stock" ? "🏭 From Production" : "📦 From Stock", callback_data: `ot:${r.id}` });
  kb.push(row);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: kb } };
}

// Send a fresh card (deleting the previous one if any)
async function sendCard(r: any) {
  if (r.tg_card_message_id) await tg("deleteMessage", { chat_id: r.tg_chat_id, message_id: r.tg_card_message_id });
  const { text, reply_markup } = renderCard(r);
  const reply = r.tg_message_id ? { reply_parameters: { message_id: r.tg_message_id, allow_sending_without_reply: true } } : {};
  let sent: any = null;
  let type = "text";
  if (r.product_id) {
    sent = await tg("sendPhoto", { chat_id: r.tg_chat_id, photo: IMAGE_URL(r.product_id), caption: text, parse_mode: "HTML", reply_markup, ...reply });
    if (sent.ok) type = "photo";
  }
  if (!sent?.ok) sent = await tg("sendMessage", { chat_id: r.tg_chat_id, text, parse_mode: "HTML", reply_markup, link_preview_options: { is_disabled: true }, ...reply });
  if (sent?.ok) {
    await sb.from("order_inbox").update({ tg_card_message_id: sent.result.message_id, card_type: type, updated_at: new Date().toISOString() }).eq("id", r.id);
  }
}

// Replace card contents with a final (button-less) message
async function finalizeCard(r: any, text: string) {
  if (!r.tg_card_message_id) return;
  const base = { chat_id: r.tg_chat_id, message_id: r.tg_card_message_id, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } };
  if (r.card_type === "photo") await tg("editMessageCaption", { ...base, caption: text });
  else await tg("editMessageText", { ...base, text, link_preview_options: { is_disabled: true } });
}

async function loadInbox(id: string) {
  const { data } = await sb.from("order_inbox").select("*").eq("id", id).maybeSingle();
  return data;
}
async function saveInbox(id: string, patch: Record<string, unknown>) {
  const { data } = await sb.from("order_inbox").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
  return data;
}

// ───────────────────────── order flow ─────────────────────────
async function handleNewOrderMessage(msg: any) {
  const text = msg.text || msg.caption || "";
  const media = await mediaBlocks(msg);
  if (!text.trim() && !media.length) return;
  const content = [...media, { type: "text", text: `Today is ${todayIST()}. Message from ${tgName(msg.from)}:\n${text || "(see attachment)"}` }];
  let ex: any;
  try {
    ex = await claudeTool(EXTRACT_SYSTEM, content, extractTool);
  } catch (e) {
    console.error(e);
    await tg("sendMessage", { chat_id: msg.chat.id, text: "⚠️ Couldn't read this order right now. Please try again in a minute.", reply_parameters: { message_id: msg.message_id } });
    return;
  }
  if (!ex.is_order || !ex.orders?.length) return; // chit-chat: stay quiet
  const poster = await displayNameFor(msg.from);
  for (const o of ex.orders) {
    const fields = await resolveOrder(o, text);
    const { data: row, error } = await sb.from("order_inbox").insert({
      ...fields,
      source: "telegram",
      tg_chat_id: msg.chat.id,
      tg_message_id: msg.message_id,
      posted_by: poster,
      posted_by_tg_id: msg.from?.id,
      raw_text: text,
      raw_media: media.length ? { kind: msg.photo ? "photo" : "document" } : null,
      parsed: o,
    }).select("*").single();
    if (error) { console.error(error); continue; }
    await sendCard(row);
  }
}

async function handleCardReply(msg: any, inbox: any) {
  if (inbox.status !== "pending") {
    await tg("sendMessage", { chat_id: msg.chat.id, text: `This order is already ${inbox.status}.`, reply_parameters: { message_id: msg.message_id } });
    return;
  }
  const instruction = msg.text || msg.caption || "";
  const media = await mediaBlocks(msg);
  const current = {
    customer: inbox.customer_name, product: inbox.product_name, product_id: inbox.product_id, qty: inbox.qty, units: inbox.units,
    order_type: inbox.order_type, has_changes: inbox.has_changes, change_desc: inbox.change_desc, notes: inbox.notes, party_reference: inbox.party_reference,
  };
  const content = [...media, {
    type: "text",
    text: `Today is ${todayIST()}. Original order message:\n${inbox.raw_text}\n\nCurrent provisional order:\n${JSON.stringify(current)}\n\nCorrection from ${tgName(msg.from)}:\n${instruction}\n\nReturn exactly ONE order: the current order with this correction applied. Keep everything not mentioned in the correction.`,
  }];
  let ex: any;
  try {
    ex = await claudeTool(EXTRACT_SYSTEM, content, extractTool);
  } catch (e) {
    console.error(e);
    return;
  }
  const o = ex.orders?.[0];
  if (!o) return;
  // keep the current customer unless the correction names a different one
  const custChanged = o.customer_text && inbox.customer_name &&
    !inbox.customer_name.toLowerCase().includes(o.customer_text.toLowerCase().slice(0, 5));
  const fields = await resolveOrder(o, inbox.raw_text + "\nCorrection: " + instruction, custChanged ? null : inbox.customer_id);
  const hist = [...(inbox.edit_history || []), { at: new Date().toISOString(), by: tgName(msg.from), text: instruction }];
  const row = await saveInbox(inbox.id, { ...fields, parsed: o, edit_history: hist });
  await sendCard(row);
}

async function sheetsMaxOid(): Promise<number> {
  try {
    const token = await googleToken("https://www.googleapis.com/auth/spreadsheets.readonly");
    if (!token) return 0;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${OPS_SHEET_ID}/values/Orders!A2:A`, {
      headers: { Authorization: "Bearer " + token }, signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return 0;
    const j = await r.json();
    let max = 0;
    for (const row of j.values || []) {
      const m = /^OID(\d+)$/.exec(String(row[0] || "").trim());
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  } catch {
    return 0;
  }
}

async function confirmInbox(inbox: any, byName: string) {
  const minOid = await sheetsMaxOid();
  const { data, error } = await sb.rpc("tg_confirm_inbox", { p_inbox: inbox.id, p_by: byName, p_min_oid: minOid });
  if (error) throw new Error(error.message);
  if (!data?.ok) return data;
  const row = await loadInbox(inbox.id);
  let topicLine = "";
  if (data.new_product || data.has_changes) {
    const t = await ensureDesignTopic(data.product_id, row, data);
    if (t) topicLine = `\n🎨 <a href="${t}">Design topic</a>`;
  }
  const kind = data.new_product ? "✨ new product" : data.has_changes ? "✏️ repeat with changes" : "🔁 repeat";
  await finalizeCard(row, `✅ <b>${data.order_id}</b> entered\n👤 ${esc(data.customer_name)}\n📦 ${esc(row.product_name)} <code>${data.product_id}</code> · ${kind}\n🔢 ${fmtQty(row.qty)} ${esc(row.units)} · ${esc(row.order_type)}${row.notes ? "\n📝 " + esc(row.notes) : ""}\n<i>Confirmed by ${esc(byName)}</i>${topicLine}`);
  return data;
}

// ───────────────────────── design topics ─────────────────────────
function headerText(p: any, extra?: string) {
  return `🎨 <b>${esc(p.product_name)}</b>\n<code>${esc(p.id)}</code> · ${esc(p.customer_name || "")}${p.category ? " · " + esc(p.category) : ""}${p.material ? " · " + esc(p.material) : ""}${extra ? "\n" + extra : ""}\n\nStatus: <b>${esc(STATUS_LABEL[p.design_status] || p.design_status)}</b>`;
}
function statusKeyboard(pid: string) {
  return {
    inline_keyboard: [
      [{ text: "🛠 In Process", callback_data: `ds:ip:${pid}` }, { text: "👀 Internal Approval", callback_data: `ds:ia:${pid}` }],
      [{ text: "📤 Customer Approval", callback_data: `ds:ca:${pid}` }, { text: "✅ File Ready", callback_data: `ds:fr:${pid}` }],
    ],
  };
}

async function ensureDesignTopic(pid: string, inbox: any | null, conf: any | null, openedBy?: string): Promise<string | null> {
  const chat = await getConfig("designs_chat_id");
  if (!chat) return null;
  const { data: p } = await sb.from("products").select("*").eq("id", pid).single();
  if (!p) return null;
  const orderLine = conf && inbox
    ? `Order <b>${conf.order_id}</b> · ${fmtQty(inbox.qty)} ${esc(inbox.units)} · posted by ${esc(inbox.posted_by)}` +
      (inbox.has_changes ? `\n✏️ Changes: ${esc(inbox.change_desc || "see order")}` : "") +
      (inbox.notes ? `\n📝 ${esc(inbox.notes)}` : "")
    : `Opened from KLAP MIS${openedBy ? " by " + esc(openedBy) : ""}`;
  if (p.tg_topic_id && String(p.tg_chat_id) === String(chat)) {
    if (!conf) return topicLink(chat, p.tg_topic_id);
    // existing topic (repeat with changes): post into it
    const m = await tg("sendMessage", { chat_id: chat, message_thread_id: p.tg_topic_id, text: `🔔 New order with changes\n${orderLine}`, parse_mode: "HTML" });
    if (m.ok) await logBotMessage(p.id, chat, p.tg_topic_id, m.result.message_id, `New order with changes — ${conf.order_id}`);
    return topicLink(chat, p.tg_topic_id);
  }
  const name = short(`${p.id} · ${p.product_name} · ${p.customer_name || ""}`, 128);
  const t = await tg("createForumTopic", { chat_id: chat, name, icon_color: 0x6FB9F0 });
  if (!t.ok) return null;
  const thread = t.result.message_thread_id;
  const h = await tg("sendMessage", { chat_id: chat, message_thread_id: thread, text: headerText(p, orderLine), parse_mode: "HTML", reply_markup: statusKeyboard(p.id) });
  if (h.ok) {
    await tg("pinChatMessage", { chat_id: chat, message_id: h.result.message_id, disable_notification: true });
    await logBotMessage(p.id, chat, thread, h.result.message_id, conf ? `Design topic opened for ${conf.order_id}` : `Design topic opened${openedBy ? " by " + openedBy : ""}`);
  }
  const link = topicLink(chat, thread);
  await sb.from("products").update({ tg_chat_id: Number(chat), tg_topic_id: thread, tg_header_msg_id: h.ok ? h.result.message_id : null, thread_link: link }).eq("id", p.id);
  return link;
}

async function logBotMessage(pid: string, chat: any, thread: any, msgId: number, text: string, from = "KLAP bot", source = "bot") {
  await sb.from("design_messages").upsert({
    product_id: pid, tg_chat_id: Number(chat), tg_thread_id: thread, tg_message_id: msgId, source, from_name: from, text,
  }, { onConflict: "tg_chat_id,tg_message_id" });
}

async function setDesignStatus(pid: string, status: string, byName: string) {
  const { data: p } = await sb.from("products").update({ design_status: status }).eq("id", pid).select("*").single();
  if (!p) return null;
  if (status === "file_ready") {
    await sb.from("orders").update({ pplan_group: "in_production" }).eq("product_id", pid).eq("order_status", "active").eq("pplan_group", "in_design");
  }
  if (p.tg_chat_id && p.tg_topic_id) {
    if (p.tg_header_msg_id) {
      await tg("editMessageText", { chat_id: p.tg_chat_id, message_id: p.tg_header_msg_id, text: headerText(p), parse_mode: "HTML", reply_markup: statusKeyboard(pid) });
    }
    const label = STATUS_LABEL[status] || status;
    const m = await tg("sendMessage", { chat_id: p.tg_chat_id, message_thread_id: p.tg_topic_id, text: `🔄 Status → <b>${esc(label)}</b> (by ${esc(byName)})`, parse_mode: "HTML", disable_notification: true });
    if (m.ok) await logBotMessage(pid, p.tg_chat_id, p.tg_topic_id, m.result.message_id, `Status → ${label} (by ${byName})`);
  }
  return p;
}

async function handleDesignMessage(msg: any, edited = false) {
  const thread = msg.message_thread_id;
  if (!thread || msg.forum_topic_created || msg.forum_topic_edited || msg.pinned_message) return;
  const { data: p } = await sb.from("products").select("id").eq("tg_chat_id", msg.chat.id).eq("tg_topic_id", thread).maybeSingle();
  const text = msg.text || msg.caption || null;
  if (edited) {
    await sb.from("design_messages").update({ text, edited: true }).eq("tg_chat_id", msg.chat.id).eq("tg_message_id", msg.message_id);
    return;
  }
  let file: any = null;
  if (msg.photo?.length) file = { ...msg.photo[msg.photo.length - 1], type: "photo", mime: "image/jpeg", name: `photo_${msg.message_id}.jpg` };
  else if (msg.document) file = { ...msg.document, type: "document", mime: msg.document.mime_type, name: msg.document.file_name };
  else if (msg.video) file = { ...msg.video, type: "video", mime: msg.video.mime_type || "video/mp4", name: msg.video.file_name || `video_${msg.message_id}.mp4` };
  else if (msg.voice) file = { ...msg.voice, type: "voice", mime: msg.voice.mime_type || "audio/ogg", name: `voice_${msg.message_id}.ogg` };

  let storage_path: string | null = null;
  if (file && (file.file_size ?? 0) <= 20e6) {
    const d = await tgDownload(file.file_id);
    if (d) {
      const safe = String(file.name || "file").replace(/[^\w.\-]+/g, "_");
      storage_path = `${p?.id || "unlinked"}/${msg.message_id}_${safe}`;
      const up = await sb.storage.from("design-files").upload(storage_path, d.bytes, { contentType: file.mime || "application/octet-stream", upsert: true });
      if (up.error) { console.error(up.error); storage_path = null; }
    }
  }
  await sb.from("design_messages").upsert({
    product_id: p?.id ?? null,
    tg_chat_id: msg.chat.id,
    tg_thread_id: thread,
    tg_message_id: msg.message_id,
    reply_to_message_id: msg.reply_to_message && msg.reply_to_message.message_id !== thread ? msg.reply_to_message.message_id : null,
    source: "telegram",
    from_name: await displayNameFor(msg.from),
    from_tg_id: msg.from?.id,
    text,
    file_type: file?.type ?? null,
    tg_file_id: file?.file_id ?? null,
    file_name: file?.name ?? null,
    mime_type: file?.mime ?? null,
    storage_path,
    raw: msg,
  }, { onConflict: "tg_chat_id,tg_message_id" });
}

// ───────────────────────── commands & callbacks ─────────────────────────
async function handleCommand(msg: any): Promise<boolean> {
  const text: string = msg.text || "";
  if (!text.startsWith("/")) return false;
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const chat = msg.chat.id;
  const reply = (t: string) => tg("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", reply_parameters: { message_id: msg.message_id }, ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}) });

  if (cmd === "/whoami") {
    await reply(`Your Telegram ID: <code>${msg.from?.id}</code>\nAdd it to your user in KLAP MIS → Settings → Users to show your name on confirmations.`);
    return true;
  }
  if (cmd === "/setup_orders" || cmd === "/setup_designs") {
    const key = cmd === "/setup_orders" ? "new_order_chat_id" : "designs_chat_id";
    if (msg.chat.type === "private") { await reply("Run this inside the group."); return true; }
    const member = await tg("getChatMember", { chat_id: chat, user_id: msg.from.id });
    if (!["creator", "administrator"].includes(member.result?.status)) { await reply("Only a group admin can run this."); return true; }
    const existing = await getConfig(key);
    if (existing && existing !== String(chat) && rest[0] !== "force") {
      await reply("Another group is already linked for this. Send the command again with <code>force</code> to switch to this group.");
      return true;
    }
    if (key === "designs_chat_id" && !msg.chat.is_forum) { await reply("Please turn on <b>Topics</b> for this group first (Group settings → Topics), then run this again."); return true; }
    await setConfig(key, String(chat));
    await reply(key === "new_order_chat_id"
      ? "✅ Linked. Post orders here in plain words (or a screenshot) and I'll prepare them for confirmation."
      : "✅ Linked. New products will get their own design topic here. Make sure I'm admin with <b>Manage Topics</b> and <b>Pin Messages</b>.");
    return true;
  }
  if (cmd === "/help" || cmd === "/start") {
    await reply("<b>KLAP MIS bot</b>\n• Post an order in the New Order group — I'll reply with a card to Confirm / Delete. Reply to the card to correct it.\n• New products get a design topic in Product Designs; use the pinned buttons to update status.\n• /whoami — your Telegram ID\n• /setup_orders, /setup_designs — link a group (admins)");
    return true;
  }
  return false;
}

async function handleCallback(cb: any) {
  const data: string = cb.data || "";
  const by = await displayNameFor(cb.from);
  const answer = (text?: string, alert = false) => tg("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });

  if (data.startsWith("ds:")) {
    const [, code, pid] = data.split(":");
    const status = STATUS_CODE[code];
    if (!status) return answer();
    const p = await setDesignStatus(pid, status, by);
    return answer(p ? `Status → ${STATUS_LABEL[status]}` : "Product not found", !p);
  }

  const [act, id, idxStr] = data.split(":");
  const inbox = id ? await loadInbox(id) : null;
  if (!inbox) return answer("This order card is no longer available.", true);
  if (inbox.status !== "pending") return answer(`Already ${inbox.status}${inbox.order_id ? " as " + inbox.order_id : ""}.`, true);

  try {
    if (act === "c") {
      if (!inbox.customer_id) return answer("Pick or reply with the customer first.", true);
      if (!inbox.qty) return answer("Quantity missing — reply to the card with the qty.", true);
      if (!inbox.product_id && !inbox.product_name) return answer("Product missing — reply to the card with the product.", true);
      await answer("Saving…");
      const res = await confirmInbox(inbox, by);
      if (res && !res.ok) await tg("sendMessage", { chat_id: inbox.tg_chat_id, text: `Already ${res.reason}.` });
      return;
    }
    if (act === "d") {
      const row = await saveInbox(inbox.id, { status: "deleted", confirmed_by: by, confirmed_at: new Date().toISOString() });
      await finalizeCard(row, `🗑 <s>Provisional order #${inbox.id.slice(0, 6)}</s> deleted by ${esc(by)}\n<i>${esc(short(inbox.raw_text || "", 120))}</i>`);
      return answer("Deleted");
    }
    if (act === "pp") {
      const p = inbox.candidates?.products?.[Number(idxStr)];
      if (!p) return answer();
      await answer("Updating…");
      const { data: full } = await sb.from("products").select("id,product_name,category,material,design_status").eq("id", p.id).single();
      if (!full) return answer("Product not found", true);
      const others = (inbox.candidates.products || []).filter((x: any) => x.id !== p.id);
      if (inbox.product_id) others.unshift({ id: inbox.product_id, name: inbox.product_name });
      const { data: lo } = await sb.from("orders").select("date").eq("product_id", p.id).order("date", { ascending: false }).limit(1);
      const row = await saveInbox(inbox.id, {
        product_id: full.id, product_name: full.product_name, category: full.category, material: full.material,
        is_new_product: false, is_repeat: !inbox.has_changes,
        candidates: { ...inbox.candidates, products: others.slice(0, 3), confidence: "high", design_status: full.design_status, last_order: lo?.[0]?.date ?? null },
      });
      return sendCard(row);
    }
    if (act === "pc") {
      const c = inbox.candidates?.customers?.[Number(idxStr)];
      if (!c) return answer();
      await answer("Updating…");
      const o = { ...(inbox.parsed || {}), qty: inbox.qty, units: inbox.units, order_type: inbox.order_type, notes: inbox.notes, has_changes: inbox.has_changes };
      const fields = await resolveOrder(o, inbox.raw_text, c.id);
      return sendCard(await saveInbox(inbox.id, fields));
    }
    if (act === "np") {
      const others = [{ id: inbox.product_id, name: inbox.product_name }, ...(inbox.candidates?.products || [])].slice(0, 3);
      const row = await saveInbox(inbox.id, {
        product_id: null, product_name: inbox.parsed?.product_text || inbox.product_name, is_new_product: true, is_repeat: false, has_changes: false,
        candidates: { ...inbox.candidates, products: others, design_status: null, last_order: null },
      });
      await answer("Marked as new product");
      return sendCard(row);
    }
    if (act === "hc") {
      const row = await saveInbox(inbox.id, { has_changes: !inbox.has_changes, is_repeat: inbox.has_changes });
      await answer(row.has_changes ? "Marked: with changes (reply to describe them)" : "Marked: no changes");
      return sendCard(row);
    }
    if (act === "ot") {
      const row = await saveInbox(inbox.id, { order_type: inbox.order_type === "From Stock" ? "From Production" : "From Stock" });
      await answer(row.order_type);
      return sendCard(row);
    }
    return answer();
  } catch (e) {
    console.error(e);
    return answer("Error: " + String((e as Error).message).slice(0, 150), true);
  }
}

// ───────────────────────── webhook dispatcher ─────────────────────────
async function processUpdate(u: any) {
  const { error: dup } = await sb.from("tg_updates").insert({ update_id: u.update_id });
  if (dup) return; // already handled (Telegram retry)

  if (u.callback_query) return handleCallback(u.callback_query);

  const msg = u.message || u.edited_message;
  if (!msg || msg.from?.is_bot) return;
  if (u.message && (await handleCommand(msg))) return;

  const chatId = String(msg.chat.id);
  const [orderChat, designChat] = await Promise.all([getConfig("new_order_chat_id"), getConfig("designs_chat_id")]);

  if (chatId === designChat) return handleDesignMessage(msg, !!u.edited_message);

  if (chatId === orderChat && u.message) {
    const rt = msg.reply_to_message;
    if (rt?.from?.is_bot) {
      const { data: inbox } = await sb.from("order_inbox").select("*").eq("tg_chat_id", msg.chat.id).eq("tg_card_message_id", rt.message_id).maybeSingle();
      if (inbox) return handleCardReply(msg, inbox);
      return;
    }
    return handleNewOrderMessage(msg);
  }
}

// ───────────────────────── app API ─────────────────────────
async function appUser(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await sb.auth.getUser(jwt);
  const email = data?.user?.email;
  if (!email) return null;
  const { data: u } = await sb.from("app_users").select("id,name,email,is_active").ilike("email", email).eq("is_active", true).maybeSingle();
  return u;
}

async function signedFiles(rows: any[]) {
  const paths = rows.filter((r) => r.storage_path).map((r) => r.storage_path);
  if (!paths.length) return rows;
  const { data } = await sb.storage.from("design-files").createSignedUrls(paths, 3600);
  const map = new Map((data || []).map((d: any) => [d.path, d.signedUrl]));
  return rows.map((r) => ({ ...r, file_url: r.storage_path ? map.get(r.storage_path) ?? null : null }));
}

async function appRoutes(req: Request, path: string[]): Promise<Response> {
  const user = await appUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const by = user.name || user.email;
  const [res, id, sub] = path;

  if (res === "inbox" && req.method === "GET" && !id) {
    const status = new URL(req.url).searchParams.get("status") || "pending";
    const { data } = await sb.from("order_inbox").select("*").eq("status", status).order("created_at", { ascending: false }).limit(200);
    return json({ items: data || [] });
  }
  if (res === "inbox" && id && req.method === "POST") {
    const inbox = await loadInbox(id);
    if (!inbox) return json({ error: "not found" }, 404);
    if (sub === "update") {
      if (inbox.status !== "pending") return json({ error: "not pending" }, 409);
      const b = await req.json();
      const allowed = ["customer_id", "product_id", "product_name", "qty", "units", "order_type", "has_changes", "change_desc", "notes", "party_reference", "category", "material"];
      const patch: any = {};
      for (const k of allowed) if (k in b) patch[k] = b[k];
      if ("customer_id" in patch) {
        const { data: a } = await sb.from("accounts").select("name").eq("id", patch.customer_id).maybeSingle();
        patch.customer_name = a?.name ?? null;
      }
      if ("product_id" in patch) {
        patch.is_new_product = !patch.product_id;
        if (patch.product_id) {
          const { data: p } = await sb.from("products").select("product_name,category,material").eq("id", patch.product_id).maybeSingle();
          if (p) Object.assign(patch, { product_name: p.product_name, category: p.category, material: p.material });
        }
      }
      const row = await saveInbox(id, patch);
      if (row.tg_chat_id) await sendCard(row);
      return json({ item: row });
    }
    if (sub === "confirm") {
      if (inbox.status !== "pending") return json({ error: "already " + inbox.status, order_id: inbox.order_id }, 409);
      try {
        const r = await confirmInbox(inbox, by);
        return json(r);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (sub === "delete") {
      if (inbox.status !== "pending") return json({ error: "already " + inbox.status }, 409);
      const row = await saveInbox(id, { status: "deleted", confirmed_by: by, confirmed_at: new Date().toISOString() });
      await finalizeCard(row, `🗑 <s>Provisional order #${id.slice(0, 6)}</s> deleted by ${esc(by)} (app)`);
      return json({ ok: true });
    }
  }

  if (res === "design-threads" && req.method === "GET") {
    const { data: prods } = await sb.from("products").select("id,product_name,customer_name,design_status,thread_link,tg_topic_id")
      .not("tg_topic_id", "is", null).order("id", { ascending: false }).limit(300);
    const ids = (prods || []).map((p: any) => p.id);
    const { data: last } = ids.length
      ? await sb.from("design_messages").select("product_id,created_at,from_name,text,file_type").in("product_id", ids).order("created_at", { ascending: false }).limit(1000)
      : { data: [] as any[] };
    const lastMap = new Map<string, any>();
    for (const m of last || []) if (!lastMap.has(m.product_id)) lastMap.set(m.product_id, m);
    return json({ items: (prods || []).map((p: any) => ({ ...p, last: lastMap.get(p.id) ?? null })) });
  }

  if (res === "design" && id) {
    const pid = decodeURIComponent(id);
    const { data: p } = await sb.from("products").select("id,product_name,customer_name,design_status,thread_link,tg_chat_id,tg_topic_id").eq("id", pid).maybeSingle();
    if (!p) return json({ error: "product not found" }, 404);

    if (req.method === "GET") {
      const { data } = await sb.from("design_messages").select("id,created_at,source,from_name,text,file_type,file_name,mime_type,storage_path,tg_message_id,reply_to_message_id,edited")
        .eq("product_id", pid).order("created_at", { ascending: true }).limit(1000);
      return json({ product: p, messages: await signedFiles(data || []) });
    }
    if (req.method === "POST" && sub === "topic") {
      const link = await ensureDesignTopic(pid, null, null, by);
      if (!link) return json({ error: "Product Designs group is not linked yet, or topic creation failed" }, 400);
      return json({ ok: true, link });
    }
    if (req.method === "POST" && sub === "status") {
      const b = await req.json();
      if (!STATUS_LABEL[b.status]) return json({ error: "bad status" }, 400);
      return json({ product: await setDesignStatus(pid, b.status, by) });
    }
    if (req.method === "POST") {
      if (!p.tg_topic_id) return json({ error: "this product has no design topic" }, 400);
      const b = await req.json();
      const prefix = `💬 <b>${esc(by)}</b> (app)`;
      let sent: any;
      let storage_path: string | null = null;
      if (b.file_base64 && b.file_name) {
        const bytes = Uint8Array.from(atob(b.file_base64), (ch) => ch.charCodeAt(0));
        const safe = String(b.file_name).replace(/[^\w.\-]+/g, "_");
        storage_path = `${pid}/app_${Date.now()}_${safe}`;
        await sb.storage.from("design-files").upload(storage_path, bytes, { contentType: b.mime || "application/octet-stream", upsert: true });
        const fd = new FormData();
        fd.append("chat_id", String(p.tg_chat_id));
        fd.append("message_thread_id", String(p.tg_topic_id));
        fd.append("caption", `${prefix}${b.text ? "\n" + esc(b.text) : ""}`);
        fd.append("parse_mode", "HTML");
        fd.append("document", new Blob([bytes], { type: b.mime || "application/octet-stream" }), b.file_name);
        sent = await (await fetch(`https://api.telegram.org/bot${BOT}/sendDocument`, { method: "POST", body: fd })).json();
      } else if (b.text?.trim()) {
        sent = await tg("sendMessage", { chat_id: p.tg_chat_id, message_thread_id: p.tg_topic_id, text: `${prefix}\n${esc(b.text)}`, parse_mode: "HTML" });
      } else return json({ error: "empty message" }, 400);
      if (!sent?.ok) return json({ error: "telegram send failed", detail: sent }, 502);
      await sb.from("design_messages").upsert({
        product_id: pid, tg_chat_id: p.tg_chat_id, tg_thread_id: p.tg_topic_id, tg_message_id: sent.result.message_id,
        source: "app", from_name: by, text: b.text || null,
        file_type: storage_path ? "document" : null, file_name: storage_path ? b.file_name : null, mime_type: b.mime || null, storage_path,
      }, { onConflict: "tg_chat_id,tg_message_id" });
      return json({ ok: true });
    }
  }
  return json({ error: "not found" }, 404);
}

// ───────────────────────── Google service account token (for Sheets OID check) ─────────────────────────
let _gTok: { scope: string; token: string; exp: number } | null = null;
async function googleToken(scope: string): Promise<string | null> {
  if (_gTok && _gTok.scope === scope && _gTok.exp > Date.now() + 60e3) return _gTok.token;
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
  if (!raw) return null;
  const sa = JSON.parse(raw);
  const b64u = (b: Uint8Array | string) => encodeBase64(typeof b === "string" ? new TextEncoder().encode(b) : b).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }))}`;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64u(sig)}` }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  _gTok = { scope, token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}

// ───────────────────────── server ─────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const i = url.pathname.indexOf(FN_BASE);
  const path = (i >= 0 ? url.pathname.slice(i + FN_BASE.length) : url.pathname).split("/").filter(Boolean);

  // Telegram webhook
  if (path[0] === "webhook" && req.method === "POST") {
    if (!WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
    const update = await req.json();
    EdgeRuntime.waitUntil(processUpdate(update).catch((e) => console.error("update failed", e)));
    return new Response("ok");
  }

  // One-time setup: registers the webhook with Telegram (needs ?key=<TELEGRAM_WEBHOOK_SECRET>)
  if (path[0] === "setup") {
    if (!WEBHOOK_SECRET || url.searchParams.get("key") !== WEBHOOK_SECRET) return json({ error: "forbidden" }, 403);
    const missing = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"].filter((k) => !Deno.env.get(k));
    if (missing.length) return json({ error: "missing secrets", missing }, 400);
    const me = await tg("getMe", {});
    const hook = await tg("setWebhook", {
      url: `${SB_URL}/functions/v1/klap-telegram/webhook`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "edited_message", "callback_query"],
      drop_pending_updates: true,
    });
    await tg("setMyCommands", { commands: [
      { command: "help", description: "How to use the KLAP bot" },
      { command: "whoami", description: "Show your Telegram ID" },
      { command: "setup_orders", description: "Link this group for new orders (admin)" },
      { command: "setup_designs", description: "Link this group for design topics (admin)" },
    ] });
    return json({ bot: me.result?.username, webhook: hook, orders_group: await getConfig("new_order_chat_id"), designs_group: await getConfig("designs_chat_id") });
  }

  if (path[0] === "health") {
    return json({ ok: true, bot: !!BOT, claude: !!ANTHROPIC_KEY, secret: !!WEBHOOK_SECRET, google: !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT") });
  }

  try {
    return await appRoutes(req, path);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
