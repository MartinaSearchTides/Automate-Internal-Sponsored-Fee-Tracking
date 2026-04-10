const SERVER = "https://seatable.searchtides.com";

const BTF = ["Published", "Pending", "Content Requested", "Ready for Delivery"];
const TOP = ["Site Approved", "Negotiation"];
const ALL_STATUSES = [...BTF, ...TOP];
const LBT_CLIENTS  = ["FanDuel", "FanDuel Casino", "FanDuel Racing", "CreditNinja"];
const PRESS_CLIENT = "FanDuel";

// ── Get base access info ──
async function getAccess(apiToken) {
  const url = `${SERVER}/api/v2.1/dtable/app-access-token/`;
  const res = await fetch(url, {
    headers: { "Authorization": `Token ${apiToken}`, "Accept": "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`getAccess ${res.status}: ${text.substring(0, 300)}`);
  return JSON.parse(text);
}

// ── List all rows via API Gateway ──
// dtable_server is e.g. "https://seatable.searchtides.com/api-gateway/"
// endpoint: {dtable_server}api/v2/dtables/{uuid}/rows/
async function listRows(access, tableName, viewName) {
  const { access_token, dtable_uuid, dtable_server } = access;

  // Ensure dtable_server ends with /
  const base = dtable_server.endsWith("/") ? dtable_server : dtable_server + "/";

  let rows = [], start = 0, limit = 1000;

  while (true) {
    let url = `${base}api/v2/dtables/${dtable_uuid}/rows/?` +
      `table_name=${encodeURIComponent(tableName)}&limit=${limit}&start=${start}&convert_keys=true`;
    if (viewName) url += `&view_name=${encodeURIComponent(viewName)}`;

    const res = await fetch(url, {
      headers: { "Authorization": `Token ${access_token}`, "Accept": "application/json" }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`listRows(${tableName}) ${res.status}: ${text.substring(0, 300)}`);

    const data = JSON.parse(text);
    const batch = data.rows || [];
    rows = rows.concat(batch);
    if (batch.length < limit) break;
    start += limit;
  }
  return rows;
}

// ── Resolve linked column → string ──
function resolve(val) {
  if (Array.isArray(val)) val = val[0] || null;
  if (val && typeof val === "object") return val.display_value || val.name || null;
  return val || null;
}

function getCurrentProdMonth() {
  return new Date().toLocaleString("en-US", { month: "short", year: "numeric" });
}
function getCurrentMonthShort() {
  return new Date().toLocaleString("en-US", { month: "short" });
}
function getCurrentYear()  { return new Date().getFullYear(); }
function getCurrentMonth() { return new Date().getMonth() + 1; }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");

  const OM_TOKEN  = process.env.OM_API_TOKEN;
  const LBT_TOKEN = process.env.LBT_API_TOKEN;
  const CMS_TOKEN = process.env.CMS_API_TOKEN;

  if (!OM_TOKEN || !LBT_TOKEN || !CMS_TOKEN || !REPORTING_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: `Missing env vars: ${!OM_TOKEN?"OM_API_TOKEN ":""}${!LBT_TOKEN?"LBT_API_TOKEN ":""}${!CMS_TOKEN?"CMS_API_TOKEN ":""}${!REPORTING_TOKEN?"REPORTING_API_TOKEN":""}`
    });
  }

  try {
    const prodMonth    = getCurrentProdMonth();
    const monthShort   = getCurrentMonthShort();
    const currentYear  = getCurrentYear();
    const currentMonth = getCurrentMonth();

    // ══════════════════════════════════════════
    //  1. HSS BASE — OM + QUOTAS
    // ══════════════════════════════════════════
    const omAccess = await getAccess(OM_TOKEN);

    // Quotas
    const quotaRows = await listRows(omAccess, "QUOTAS", "");
    const quotas = {};
    for (const row of quotaRows) {
      const client   = resolve(row["\u{1F539}Client"] || row["Client"]);
      const monthVal = row["\u{1F539}Month"]     || row["Month"]    || "";
      const yearVal  = row["\u{1F539}Year"]      || row["Year"]     || "";
      const quotaVal = row["\u{1F539} LV Quota"] || row["LV Quota"] || 0;
      if (!client || !monthVal) continue;
      const mOk = monthVal.trim().toLowerCase() === monthShort.toLowerCase();
      const yOk = yearVal ? String(yearVal).trim() === String(currentYear) : true;
      if (mOk && yOk) quotas[client] = parseFloat(quotaVal) || 0;
    }

    // OM LV rows
    const omRows = await listRows(omAccess, "OM", "Martina Dashboard View");
    const internal = {};
    for (const row of omRows) {
      const client = resolve(row["CLIENT*"]);
      const status = row["STATUS 1"];
      const lv     = parseFloat(row["LV"]) || 0;
      const pm     = (row["Prod Month"] || "").trim();
      if (pm !== prodMonth) continue;
      if (!client || !ALL_STATUSES.includes(status)) continue;
      if (!internal[client]) internal[client] = {};
      internal[client][status] = (internal[client][status] || 0) + lv;
    }

    // ══════════════════════════════════════════
    //  2. LBT BASE
    // ══════════════════════════════════════════
    const lbtAccess = await getAccess(LBT_TOKEN);
    const lbtRows   = await listRows(lbtAccess, "OM", "View for dashboard");
    const external  = {};
    for (const row of lbtRows) {
      const client = resolve(row["CLIENT*"]);
      const status = row["STATUS 1"];
      const lv     = parseFloat(row["LV"]) || 0;
      const pm     = (row["Prod Month"] || "").trim();
      if (pm !== prodMonth) continue;
      if (!client || !LBT_CLIENTS.includes(client)) continue;
      if (status !== "Published") continue;
      external[client] = (external[client] || 0) + lv;
    }

    // ══════════════════════════════════════════
    //  3. CMS MASTER BASE — Journalists (FanDuel only)
    // ══════════════════════════════════════════
    const cmsAccess = await getAccess(CMS_TOKEN);
    const cmsRows   = await listRows(cmsAccess, "OM", "Default View_Martina");
    let journalists = 0;
    for (const row of cmsRows) {
      const dateVal = row["Live Link Date"] || "";
      const lv      = parseFloat(row["LV"]) || 0;
      if (!dateVal) continue;
      try {
        const d = new Date(String(dateVal).substring(0, 10));
        if (d.getFullYear() === currentYear && d.getMonth() + 1 === currentMonth) {
          journalists += lv;
        }
      } catch(e) { continue; }
    }

    // ══════════════════════════════════════════
    //  4. REPORTING BASE — Company quotas
    // ══════════════════════════════════════════
    const reportingAccess = await getAccess(REPORTING_TOKEN);
    const reportingRows   = await listRows(reportingAccess, "QUOTAS", "");
    const companyQuotas   = {};
    for (const row of reportingRows) {
      const client   = resolve(row["\u{1F539}Client"] || row["Client"]);
      const monthVal = row["\u{1F539}Month"] || row["Month"] || "";
      const quotaVal = row["\u{1F539} Monthly LV Quota"] || 0;
      if (!client || !monthVal) continue;
      if (monthVal.trim().toLowerCase() === monthShort.toLowerCase()) {
        companyQuotas[client] = parseFloat(quotaVal) || 0;
      }
    }

    // ══════════════════════════════════════════
    //  5. BUILD RESPONSE
    // ══════════════════════════════════════════
    const allClients = [...new Set([...Object.keys(internal), ...Object.keys(quotas)])].sort();

    const clients = allClients.map(name => {
      const quota   = quotas[name] || 0;
      const intData = internal[name] || {};
      const extPub  = LBT_CLIENTS.includes(name) ? Math.round((external[name] || 0) * 100) / 100 : 0;
      const journ   = name === PRESS_CLIENT ? Math.round(journalists * 100) / 100 : 0;
      const companyQuota = companyQuotas[name] || 0;
      const row     = { client: name, quota, company_quota: companyQuota, ext_published: extPub, journalists: journ };
      for (const s of ALL_STATUSES) row[s] = Math.round((intData[s] || 0) * 100) / 100;
      return row;
    });

    return res.status(200).json({
      ok: true,
      generated: new Date().toISOString(),
      prod_month: prodMonth,
      debug: {
        quotas_loaded: Object.keys(quotas).length,
        om_rows: omRows.length,
        lbt_rows: lbtRows.length,
        cms_rows: cmsRows.length,
        internal_clients: Object.keys(internal).length,
        company_quotas_loaded: Object.keys(companyQuotas).length,
        journalists_total: Math.round(journalists * 100) / 100
      },
      clients
    });

  } catch(err) {
    console.error("Dashboard API error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
