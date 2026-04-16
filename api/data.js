const SERVER = "https://seatable.searchtides.com";

const BTF = ["Published", "Pending", "Content Requested", "Ready for Delivery", "Revisions Requested"];
const TOP = ["Site Approved", "Negotiation"];
const ALL_STATUSES = [...BTF, ...TOP];

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

/** Parse one SeaTable cell to USD number; null = not filled (excluded from KPIs). Zero is filled. */
function parseFinalUsdCell(raw) {
  if (raw === undefined || raw === null) return null;
  let disp = raw;
  if (Array.isArray(disp)) disp = disp[0] ?? null;
  if (disp !== null && typeof disp === "object") {
    disp = disp.display_value ?? disp.name ?? null;
  }
  if (disp === null || disp === undefined) return null;
  if (typeof disp === "string" && disp.trim() === "") return null;
  if (typeof disp === "number" && !Number.isNaN(disp)) return disp;

  const n = parseFloat(String(disp).replace(/[$,\s]/g, ""));
  if (Number.isNaN(n)) return null;
  return n;
}

/** FINAL $ present (incl. 0); not filled => row excluded from sponsored KPIs */
function getFinalDollarValue(row) {
  const candidates = [
    "FINAL $",
    "FINAL$",
    "Final $",
    "\u{1F539}FINAL $",
    "\u{1F539} FINAL $"
  ];
  for (const key of candidates) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const n = parseFinalUsdCell(row[key]);
    if (n !== null) return n;
  }
  return null;
}

function monthShort()   { return new Date().toLocaleString("en-US", { month: "short" }); }
function prodMonth()    { return new Date().toLocaleString("en-US", { month: "short", year: "numeric" }); }
function currentYear()  { return new Date().getFullYear(); }

async function buildPayload(omToken) {
    console.log("[buildPayload] START");
    const PM = prodMonth();
    const MS = monthShort();
    const CY = currentYear();
    console.log("[buildPayload] Date filters: PM =", PM, ", MS =", MS, ", CY =", CY);

    console.log("[buildPayload] Getting SeaTable access...");
    const omAccess = await getAccess(omToken);
    console.log("[buildPayload] Access OK, uuid:", omAccess.dtable_uuid?.slice(0, 8) + "...");

    console.log("[buildPayload] Fetching QUOTAS and OM rows...");
    const [quotaRows, omRows] = await Promise.all([
      listRows(omAccess, "QUOTAS", ""),
      listRows(omAccess, "OM", "Martina Dashboard View")
    ]);
    console.log("[buildPayload] Rows fetched: quotaRows =", quotaRows.length, ", omRows =", omRows.length);

    // ── Internal quotas (HSS QUOTAS) ──
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

    // ── Internal OM LV + sponsored fee aggregates (BOF rows with filled FINAL $, year 2026 only) ──
    const internal = {};
    const sponsoredByClient = {};
    const sponsoredTotals = { sum_lv: 0, sum_cost: 0, count: 0 };

    for (const row of omRows) {
      const client = resolve(row["CLIENT*"]);
      const status = row["STATUS 1"];
      const lv     = parseFloat(row["LV"]) || 0;
      const pm     = (row["Prod Month"] || "").trim();
      if (!pm) continue;
      
      const pmYear = pm.includes("2026") ? 2026 : (pm.includes("2025") ? 2025 : null);
      if (pmYear !== 2026) continue;
      
      if (!client || !ALL_STATUSES.includes(status)) continue;
      if (!internal[client]) internal[client] = {};
      internal[client][status] = (internal[client][status] || 0) + lv;

      if (BTF.includes(status)) {
        const finalUsd = getFinalDollarValue(row);
        if (finalUsd !== null) {
          if (!sponsoredByClient[client]) {
            sponsoredByClient[client] = { sum_lv: 0, sum_cost: 0, count: 0 };
          }
          sponsoredByClient[client].sum_lv += lv;
          sponsoredByClient[client].sum_cost += finalUsd;
          sponsoredByClient[client].count += 1;
          sponsoredTotals.sum_lv += lv;
          sponsoredTotals.sum_cost += finalUsd;
          sponsoredTotals.count += 1;
        }
      }
    }

  // ── Team performance by month (Published only, year 2026 only) ──
  const teamByMonth = {};
  const teamLvByMonth = {};
  const teamCostByMonth = {};
  const teamAvgByMonth = {};
  const teamAvgLvByMonth = {};
  const allMonths = new Set();

  // ── Client performance by month (Published only, year 2026 only) ──
  const clientByMonth = {};
  const clientLvByMonth = {};
  const clientCostByMonth = {};
  const clientAvgByMonth = {};
  const clientAvgLvByMonth = {};

  for (const row of omRows) {
      const status = row["STATUS 1"];
      if (status !== "Published") continue;
      
      const team = resolve(row["TEAM"] || row["Team"] || row["team"]);
      if (!team || team === "Julie") continue;

      const pm = (row["Prod Month"] || "").trim();
      if (!pm) continue;
      
      const pmYear = pm.includes("2026") ? 2026 : (pm.includes("2025") ? 2025 : null);
      if (pmYear !== 2026) continue;
      
      const lv = parseFloat(row["LV"]) || 0;
      const finalUsd = getFinalDollarValue(row);
      
    if (!teamByMonth[team]) teamByMonth[team] = {};
    if (!teamLvByMonth[team]) teamLvByMonth[team] = {};
    if (!teamCostByMonth[team]) teamCostByMonth[team] = {};
    if (!teamAvgByMonth[team]) teamAvgByMonth[team] = {};
    if (!teamAvgLvByMonth[team]) teamAvgLvByMonth[team] = {};

    if (!teamByMonth[team][pm]) teamByMonth[team][pm] = 0;
    if (!teamLvByMonth[team][pm]) teamLvByMonth[team][pm] = 0;
    if (!teamCostByMonth[team][pm]) teamCostByMonth[team][pm] = 0;
    if (!teamAvgByMonth[team][pm]) teamAvgByMonth[team][pm] = { sum: 0, count: 0 };
    if (!teamAvgLvByMonth[team][pm]) teamAvgLvByMonth[team][pm] = { sum: 0, sumLv: 0 };

    teamByMonth[team][pm] += 1;
    teamLvByMonth[team][pm] += lv;
    if (finalUsd !== null) {
      teamCostByMonth[team][pm] += finalUsd;
      teamAvgByMonth[team][pm].sum += finalUsd;
      teamAvgByMonth[team][pm].count += 1;
      teamAvgLvByMonth[team][pm].sum += finalUsd;
      teamAvgLvByMonth[team][pm].sumLv += lv;
    }
    allMonths.add(pm);

    const client = resolve(row["CLIENT*"] || row["Client*"] || row["client*"]);
    if (client) {
      if (!clientByMonth[client]) clientByMonth[client] = {};
      if (!clientLvByMonth[client]) clientLvByMonth[client] = {};
      if (!clientCostByMonth[client]) clientCostByMonth[client] = {};
      if (!clientAvgByMonth[client]) clientAvgByMonth[client] = {};
      if (!clientAvgLvByMonth[client]) clientAvgLvByMonth[client] = {};

      if (!clientByMonth[client][pm]) clientByMonth[client][pm] = 0;
      if (!clientLvByMonth[client][pm]) clientLvByMonth[client][pm] = 0;
      if (!clientCostByMonth[client][pm]) clientCostByMonth[client][pm] = 0;
      if (!clientAvgByMonth[client][pm]) clientAvgByMonth[client][pm] = { sum: 0, count: 0 };
      if (!clientAvgLvByMonth[client][pm]) clientAvgLvByMonth[client][pm] = { sum: 0, sumLv: 0 };

      clientByMonth[client][pm] += 1;
      clientLvByMonth[client][pm] += lv;
      if (finalUsd !== null) {
        clientCostByMonth[client][pm] += finalUsd;
        clientAvgByMonth[client][pm].sum += finalUsd;
        clientAvgByMonth[client][pm].count += 1;
        clientAvgLvByMonth[client][pm].sum += finalUsd;
        clientAvgLvByMonth[client][pm].sumLv += lv;
      }
    }
  }

  const monthsArray = Array.from(allMonths).sort((a, b) => {
    const dA = new Date(a + " 01");
    const dB = new Date(b + " 01");
    return dA - dB;
  });

  const avgFeesByMonth = {};
  const avgFeesPerLvByMonth = {};
  for (const member in teamAvgByMonth) {
    avgFeesByMonth[member] = {};
    for (const month in teamAvgByMonth[member]) {
      const data = teamAvgByMonth[member][month];
      avgFeesByMonth[member][month] = data.count > 0 ? data.sum / data.count : 0;
    }
  }
  for (const member in teamAvgLvByMonth) {
    avgFeesPerLvByMonth[member] = {};
    for (const month in teamAvgLvByMonth[member]) {
      const data = teamAvgLvByMonth[member][month];
      avgFeesPerLvByMonth[member][month] = data.sumLv > 0 ? data.sum / data.sumLv : 0;
    }
  }

  const clientAvgFeesByMonth = {};
  const clientAvgFeesPerLvByMonth = {};
  for (const client in clientAvgByMonth) {
    clientAvgFeesByMonth[client] = {};
    for (const month in clientAvgByMonth[client]) {
      const data = clientAvgByMonth[client][month];
      clientAvgFeesByMonth[client][month] = data.count > 0 ? data.sum / data.count : 0;
    }
  }
  for (const client in clientAvgLvByMonth) {
    clientAvgFeesPerLvByMonth[client] = {};
    for (const month in clientAvgLvByMonth[client]) {
      const data = clientAvgLvByMonth[client][month];
      clientAvgFeesPerLvByMonth[client][month] = data.sumLv > 0 ? data.sum / data.sumLv : 0;
    }
  }

  console.log("[✓] Team performance aggregated:", {
    members: Object.keys(teamByMonth).length,
    months: monthsArray.length,
    avgFeesByMonth: Object.keys(avgFeesByMonth).length
  });

  const allClients = [...new Set([...Object.keys(internal), ...Object.keys(quotas)])].sort();

    const clients = allClients.map(name => {
      const row = {
        client: name,
        quota:  quotas[name] || 0
      };
      const intData = internal[name] || {};
      for (const s of ALL_STATUSES) row[s] = Math.round((intData[s] || 0) * 100) / 100;

      const sp = sponsoredByClient[name] || { sum_lv: 0, sum_cost: 0, count: 0 };
      const efficiency_ratio =
        sp.sum_lv > 0 ? Math.round((sp.sum_cost / sp.sum_lv) * 10000) / 10000 : null;
      const avg_sponsored_fee =
        sp.count > 0 ? Math.round((sp.sum_cost / sp.count) * 100) / 100 : null;
      row.sponsored = {
        sum_lv:          Math.round(sp.sum_lv * 100) / 100,
        sum_final_usd:   Math.round(sp.sum_cost * 100) / 100,
        count:           sp.count,
        efficiency_ratio,
        avg_sponsored_fee
      };
      return row;
    });

    const stEff =
      sponsoredTotals.sum_lv > 0
        ? Math.round((sponsoredTotals.sum_cost / sponsoredTotals.sum_lv) * 10000) / 10000
        : null;
    const stAvg =
      sponsoredTotals.count > 0
        ? Math.round((sponsoredTotals.sum_cost / sponsoredTotals.count) * 100) / 100
        : null;
    const sponsored_totals = {
      sum_lv:           Math.round(sponsoredTotals.sum_lv * 100) / 100,
      sum_final_usd:    Math.round(sponsoredTotals.sum_cost * 100) / 100,
      count:            sponsoredTotals.count,
      efficiency_ratio: stEff,
      avg_sponsored_fee: stAvg
    };

    console.log("[buildPayload] Payload built: clients =", clients.length, ", sponsored links =", sponsored_totals.count, ", team members =", Object.keys(teamByMonth).length, ", client rows =", Object.keys(clientByMonth).length);
    return {
      ok: true,
      generated: new Date().toISOString(),
      prod_month: PM,
      sponsored_totals,
      team_performance: {
        members: Object.keys(teamByMonth).sort(),
      months: monthsArray,
      link_counts: teamByMonth,
      link_values: teamLvByMonth,
      total_costs: teamCostByMonth,
      avg_fees: avgFeesByMonth,
      avg_fees_per_lv: avgFeesPerLvByMonth
    },
      client_performance: {
        members: Object.keys(clientByMonth).sort(),
        months: monthsArray,
        link_counts: clientByMonth,
        link_values: clientLvByMonth,
        total_costs: clientCostByMonth,
        avg_fees: clientAvgFeesByMonth,
        avg_fees_per_lv: clientAvgFeesPerLvByMonth
      },
      debug: {
        quotas_loaded: Object.keys(quotas).length,
        om_rows: omRows.length,
        internal_clients: Object.keys(internal).length
      },
      clients
    };
}

/**
 * Vercel Node serverless function (CommonJS for reliability with standalone /api).
 * @param {import("@vercel/node").VercelRequest} req
 * @param {import("@vercel/node").VercelResponse} res
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");

  console.log("[START] /api/data called");

  if (req.method === "OPTIONS") {
    console.log("[OPTIONS] Returning 204");
    return res.status(204).end();
  }

  const OM_TOKEN = process.env.OM_API_TOKEN;
  console.log("[ENV] OM_API_TOKEN present:", !!OM_TOKEN, OM_TOKEN ? `(length ${OM_TOKEN.length})` : "(missing)");

  if (!OM_TOKEN) {
    console.error("[ERROR] Missing OM_API_TOKEN");
    return res.status(500).json({
      ok: false,
      error:
        "Missing env var: OM_API_TOKEN. Vercel → Project → Settings → Environment Variables → add OM_API_TOKEN (exact name) → Redeploy."
    });
  }

  try {
    console.log("[BUILD] Calling buildPayload...");
    const body = await buildPayload(OM_TOKEN);
    console.log("[SUCCESS] buildPayload returned", Object.keys(body).join(", "), "- clients:", body.clients?.length);
    return res.status(200).json(body);
  } catch (err) {
    console.error("[ERROR] Dashboard API error:", err.message);
    console.error("[STACK]", err.stack);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
