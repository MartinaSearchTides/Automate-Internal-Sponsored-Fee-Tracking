const SERVER = "https://seatable.searchtides.com";

const BTF = ["Published", "Pending", "Content Requested", "Ready for Delivery", "Revisions Requested"];
const TOP = ["Site Approved", "Negotiation"];
const ALL_STATUSES = [...BTF, ...TOP];
const LBT_CLIENTS  = ["FanDuel", "FanDuel Casino", "FanDuel Racing", "CreditNinja"];
const PRESS_CLIENT = "FanDuel";

async function getAccess(apiToken) {
  const res = await fetch(SERVER + "/api/v2.1/dtable/app-access-token/", {
    headers: { "Authorization": "Token " + apiToken, "Accept": "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error("getAccess " + res.status + ": " + text.substring(0, 200));
  return JSON.parse(text);
}

async function listRows(access, tableName, viewName) {
  const base = access.dtable_server.endsWith("/") ? access.dtable_server : access.dtable_server + "/";
  const uuid = access.dtable_uuid;
  const tok  = access.access_token;
  let rows = [], start = 0, limit = 1000;

  while (true) {
    let url = base + "api/v2/dtables/" + uuid + "/rows/?table_name=" +
      encodeURIComponent(tableName) + "&limit=" + limit + "&start=" + start + "&convert_keys=true";
    if (viewName && viewName.trim()) url += "&view_name=" + encodeURIComponent(viewName);

    const res = await fetch(url, {
      headers: { "Authorization": "Token " + tok, "Accept": "application/json" }
    });
    const text = await res.text();
    if (!res.ok) throw new Error("listRows(" + tableName + ") " + res.status + ": " + text.substring(0, 200));

    const batch = (JSON.parse(text).rows || []);
    rows = rows.concat(batch);
    if (batch.length < limit) break;
    start += limit;
  }
  return rows;
}

function resolve(val) {
  if (Array.isArray(val)) val = val[0] || null;
  if (val && typeof val === "object") return val.display_value || val.name || null;
  return val || null;
}

function monthShort()   { return new Date().toLocaleString("en-US", { month: "short" }); }
function prodMonth()    { return new Date().toLocaleString("en-US", { month: "short", year: "numeric" }); }
function currentYear()  { return new Date().getFullYear(); }
function currentMonth() { return new Date().getMonth() + 1; }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");

  const OM_TOKEN        = process.env.OM_API_TOKEN;
  const LBT_TOKEN       = process.env.LBT_API_TOKEN;
  const CMS_TOKEN       = process.env.CMS_API_TOKEN;
  const REPORTING_TOKEN = process.env.REPORTING_API_TOKEN;

  if (!OM_TOKEN || !LBT_TOKEN || !CMS_TOKEN || !REPORTING_TOKEN) {
    const missing = [
      !OM_TOKEN && "OM_API_TOKEN",
      !LBT_TOKEN && "LBT_API_TOKEN",
      !CMS_TOKEN && "CMS_API_TOKEN",
      !REPORTING_TOKEN && "REPORTING_API_TOKEN"
    ].filter(Boolean).join(", ");
    return res.status(500).json({ ok: false, error: "Missing env vars: " + missing });
  }

  try {
    const PM    = prodMonth();
    const MS    = monthShort();
    const CY    = currentYear();
    const CM    = currentMonth();

    // ── Auth all 4 bases in parallel ──
    const [omAccess, lbtAccess, cmsAccess, reportingAccess] = await Promise.all([
      getAccess(OM_TOKEN),
      getAccess(LBT_TOKEN),
      getAccess(CMS_TOKEN),
      getAccess(REPORTING_TOKEN)
    ]);

    // ── Fetch all data in parallel ──
    const [quotaRows, omRows, lbtRows, cmsRows, reportingRows] = await Promise.all([
      listRows(omAccess, "QUOTAS", ""),
      listRows(omAccess, "OM", "Martina Dashboard View"),
      listRows(lbtAccess, "OM", "View for dashboard"),
      listRows(cmsAccess, "OM", "Default View_Martina"),
      listRows(reportingAccess, "QUOTAS", "")
    ]);

    // ── 1. Internal quotas (HSS QUOTAS) ──
    const quotas = {};
    for (const row of quotaRows) {
      const client   = resolve(row["\u{1F539}Client"] || row["Client"]);
      const monthVal = row["\u{1F539}Month"]     || row["Month"]    || "";
      const yearVal  = row["\u{1F539}Year"]      || row["Year"]     || "";
      const quotaVal = row["\u{1F539} LV Quota"] || row["LV Quota"] || 0;
      if (!client || !monthVal) continue;
      const mOk = monthVal.trim().toLowerCase() === MS.toLowerCase();
      const yOk = yearVal ? String(yearVal).trim() === String(CY) : true;
      if (mOk && yOk) quotas[client] = parseFloat(quotaVal) || 0;
    }

    // ── 2. Internal OM LV data ──
    const internal = {};
    for (const row of omRows) {
      const client = resolve(row["CLIENT*"]);
      const status = row["STATUS 1"];
      const lv     = parseFloat(row["LV"]) || 0;
      const pm     = (row["Prod Month"] || "").trim();
      if (pm !== PM) continue;
      if (!client || !ALL_STATUSES.includes(status)) continue;
      if (!internal[client]) internal[client] = {};
      internal[client][status] = (internal[client][status] || 0) + lv;
    }

    // ── 3. External LBT ──
    const external = {};
    for (const row of lbtRows) {
      const client = resolve(row["CLIENT*"]);
      const status = row["STATUS 1"];
      const lv     = parseFloat(row["LV"]) || 0;
      const pm     = (row["Prod Month"] || "").trim();
      if (pm !== PM) continue;
      if (!client || !LBT_CLIENTS.includes(client)) continue;
      if (status !== "Published") continue;
      external[client] = (external[client] || 0) + lv;
    }

    // ── 4. Journalists / CMS Master ──
    let journalists = 0;
    for (const row of cmsRows) {
      const dateVal = row["Live Link Date"] || "";
      const lv      = parseFloat(row["LV"]) || 0;
      if (!dateVal) continue;
      try {
        const d = new Date(String(dateVal).substring(0, 10));
        if (d.getFullYear() === CY && d.getMonth() + 1 === CM) journalists += lv;
      } catch(e) { continue; }
    }

    // ── 5. Company quotas (Reporting QUOTAS) ──
    const companyQuotas = {};
    const reportingDebug = []; // capture first 5 rows for debugging
    for (const row of reportingRows) {
      // Try all possible column name variants
      const client   = resolve(row["Client"] || row["client"] || null);
      const monthVal = row["Month"] || row["month"] || "";
      const quotaVal = row["Monthly LV Quota"] || row["LV Quota"] || 0;

      if (reportingDebug.length < 3) {
        reportingDebug.push({
          raw_keys: Object.keys(row).slice(0, 8),
          client, monthVal, quotaVal
        });
      }

      if (!client || !monthVal) continue;
      if (monthVal.trim().toLowerCase() === MS.toLowerCase()) {
        companyQuotas[client] = parseFloat(quotaVal) || 0;
      }
    }

    // ── 6. Build response ──
    const allClients = [...new Set([...Object.keys(internal), ...Object.keys(quotas)])].sort();

    const clients = allClients.map(name => {
      const row = {
        client:        name,
        quota:         quotas[name] || 0,
        company_quota: companyQuotas[name] || 0,
        ext_published: LBT_CLIENTS.includes(name) ? Math.round((external[name] || 0) * 100) / 100 : 0,
        journalists:   name === PRESS_CLIENT ? Math.round(journalists * 100) / 100 : 0
      };
      const intData = internal[name] || {};
      for (const s of ALL_STATUSES) row[s] = Math.round((intData[s] || 0) * 100) / 100;
      return row;
    });

    return res.status(200).json({
      ok: true,
      generated: new Date().toISOString(),
      prod_month: PM,
      debug: {
        quotas_loaded: Object.keys(quotas).length,
        om_rows: omRows.length,
        lbt_rows: lbtRows.length,
        cms_rows: cmsRows.length,
        internal_clients: Object.keys(internal).length,
        company_quotas_loaded: Object.keys(companyQuotas).length,
        company_quotas_clients: Object.keys(companyQuotas),
        reporting_sample: reportingDebug,
        journalists_total: Math.round(journalists * 100) / 100
      },
      clients
    });

  } catch(err) {
    console.error("Dashboard API error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
