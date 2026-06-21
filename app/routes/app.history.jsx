import { useState } from "react";
import { Form, useLoaderData, useNavigation, Link, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const statusFilter = url.searchParams.get("status") || "all";
  const orderSearch = url.searchParams.get("order") || "";
  const PAGE_SIZE = 50;

  const where = {
    shopDomain: shop,
    ...(statusFilter !== "all" ? { syncStatus: statusFilter } : {}),
    ...(orderSearch ? {
      OR: [
        { description: { contains: orderSearch, mode: "insensitive" } },
        { shopifyOrderId: { contains: orderSearch } }
      ]
    } : {}),
  };

  const [total, records] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
  ]);

  return {
    shop,
    records: records.map((r) => ({
      id: r.id,
      shopifyOrderId: r.shopifyOrderId || "",
      eventType: r.eventType,
      description: r.description,
      syncStatus: r.syncStatus || "synced",
      externalTaskUrl: r.externalTaskUrl || "",
      createdAt: r.createdAt.toISOString(),
    })),
    page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total,
    statusFilter,
    orderSearch,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "retry_sync") {
    const recordId = parseInt(formData.get("recordId"), 10);
    try {
      const record = await prisma.activityLog.findFirst({ where: { id: recordId, shopDomain: shop } });
      if (!record) return { ok: false, error: "Record not found." };
      if (!record.shopifyOrderId) return { ok: false, error: "No Shopify Order ID found in this log." };
      
      const existingJob = await prisma.syncJob.findFirst({
        where: { shopDomain: shop, shopifyOrderId: record.shopifyOrderId },
        orderBy: { createdAt: "desc" },
      });
      if (existingJob?.payload) {
        await prisma.syncJob.update({
          where: { id: existingJob.id },
          data: { status: "pending", attempts: 0 },
        });
        await prisma.activityLog.update({ where: { id: recordId }, data: { syncStatus: "retrying" } });
        
        // Also update any matching OrderSyncRecords if they exist
        await prisma.orderSyncRecord.updateMany({
          where: { shopDomain: shop, shopifyOrderId: record.shopifyOrderId },
          data: { syncStatus: "retrying" }
        });
        
        return { ok: true, retried: true };
      }
      return { ok: false, error: "Original order payload not found." };
    } catch (err) {
      return { ok: false, error: "Retry failed: " + err.message };
    }
  }

  if (intent === "export_csv") {
    const sf = formData.get("statusFilter") || "all";
    const where = { shopDomain: shop, ...(sf !== "all" ? { syncStatus: sf } : {}) };
    const all = await prisma.activityLog.findMany({
      where, orderBy: { createdAt: "desc" }, take: 5000,
    });
    const header = "Log ID,Event Type,Description,Shopify Order ID,Status,Created At\n";
    const rows = all.map((r) =>
      [r.id, r.eventType, r.description, r.shopifyOrderId || "",
       r.syncStatus || "", new Date(r.createdAt).toISOString()]
        .map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",")
    );
    return new Response(header + rows.join("\n"), {
      headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="syncup-history.csv"' },
    });
  }

  return { ok: false, error: "Unknown action." };
};

const C = { bg: "#0f0f0f", surface: "#1a1a1a", border: "#2a2a2a", text: "#ffffff", muted: "#9a9a9a", accent: "#00c48c" };

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

const SC = {
  synced:              { color: "#00c48c", bg: "rgba(0,196,140,0.12)", label: "Synced" },
  fulfilled:           { color: "#00c48c", bg: "rgba(0,196,140,0.12)", label: "Fulfilled" },
  partially_fulfilled: { color: "#ff9900", bg: "rgba(255,153,0,0.12)", label: "Partially Fulfilled" },
  partially_refunded:  { color: "#ff9900", bg: "rgba(255,153,0,0.12)", label: "Partially Refunded" },
  refunded:            { color: "#ff4444", bg: "rgba(255,68,68,0.12)", label: "Refunded" },
  retrying:            { color: "#ff9900", bg: "rgba(255,153,0,0.12)", label: "Retrying" },
  failed:              { color: "#ff4444", bg: "rgba(255,68,68,0.12)", label: "Failed" },
};

export default function HistoryPage() {
  const { records, page, totalPages, total, statusFilter, orderSearch } = useLoaderData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [searchVal, setSearchVal] = useState(orderSearch || "");
  const [searchParams] = useSearchParams();

  // Helper to preserve shop and host during link filtering / pagination transitions
  const getFilterUrl = (status, order, newPage) => {
    const params = new URLSearchParams(searchParams);
    if (status !== undefined) params.set("status", status);
    if (order !== undefined) params.set("order", order);
    if (newPage !== undefined) params.set("page", String(newPage));
    return `/app/history?${params.toString()}`;
  };

  const shopVal = searchParams.get("shop") || "";
  const hostVal = searchParams.get("host") || "";

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "system-ui,-apple-system,sans-serif" }}>
      <style>{".sh-row:hover{background:rgba(255,255,255,0.025)!important}@media(max-width:640px){.sh-hide{display:none!important}}"}</style>
      <div style={{ maxWidth: 920, margin: "0 auto", padding: "28px 20px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
          <div>
            <Link to={`/app?shop=${encodeURIComponent(shopVal)}&host=${encodeURIComponent(hostVal)}`} style={{ color: C.accent, textDecoration: "none", fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 10 }}>
              {"<"} Back to dashboard
            </Link>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Activity & Sync History</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: C.muted }}>{total.toLocaleString()} total records</p>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="export_csv" />
            <input type="hidden" name="statusFilter" value={statusFilter} />
            <button type="submit" disabled={isSubmitting} style={{ background: C.surface, border: "1px solid " + C.border, color: C.muted, padding: "8px 16px", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", outline: "none" }}>
              Export CSV
            </button>
          </Form>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          {["all", "synced", "fulfilled", "failed", "retrying"].map((s) => (
            <Link key={s} to={getFilterUrl(s, searchVal, 1)} style={{ padding: "5px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600, textDecoration: "none", border: statusFilter === s ? "1px solid " + C.accent : "1px solid " + C.border, color: statusFilter === s ? C.accent : C.muted, background: statusFilter === s ? "rgba(0,196,140,0.08)" : "transparent" }}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Link>
          ))}
          <Form method="get" action="/app/history" style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <input type="hidden" name="shop" value={shopVal} />
            <input type="hidden" name="host" value={hostVal} />
            <input type="hidden" name="status" value={statusFilter} />
            <input name="order" type="text" placeholder="Search logs..." value={searchVal} onChange={(e) => setSearchVal(e.currentTarget.value)} style={{ background: C.surface, border: "1px solid " + C.border, color: C.text, padding: "7px 12px", borderRadius: 8, fontSize: 12, outline: "none", width: 170 }} />
            <button type="submit" style={{ background: C.accent, border: "none", color: "#03251c", padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Search</button>
          </Form>
        </div>

        {/* Table */}
        <div style={{ border: "1px solid " + C.border, borderRadius: 14, overflow: "hidden", background: "#111" }}>
          {/* Header row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px 100px 90px 70px", padding: "12px 16px", background: "#161616", borderBottom: "1px solid " + C.border, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: C.muted }}>
            <div>Event Description</div>
            <div>Type</div>
            <div>Time</div>
            <div>Status</div>
            <div>Action</div>
          </div>

          {records.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 }}>No activity logs found.</div>
          ) : (
            records.map((r) => {
              const sc = SC[r.syncStatus] || SC.synced;
              return (
                <div key={r.id} className="sh-row" style={{ display: "grid", gridTemplateColumns: "1fr 140px 100px 90px 70px", padding: "12px 16px", borderBottom: "1px solid " + C.border, alignItems: "center", transition: "background 0.1s" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                    {r.externalTaskUrl ? (
                      <a href={r.externalTaskUrl} target="_blank" rel="noopener noreferrer" style={{ color: C.accent, textDecoration: "underline" }}>
                        {r.description}
                      </a>
                    ) : (
                      r.description
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase" }}>{r.eventType.replace(/_/g, " ")}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{timeAgo(r.createdAt)}</div>
                  <div>
                    {r.shopifyOrderId ? (
                      <span style={{ fontSize: 10, fontWeight: 700, color: sc.color, background: sc.bg, border: "1px solid " + sc.color + "44", padding: "2px 8px", borderRadius: 8, textTransform: "uppercase", whiteSpace: "nowrap" }}>
                        {sc.label}
                      </span>
                    ) : (
                      <span style={{ fontSize: 10, fontWeight: 700, color: C.muted, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", padding: "2px 8px", borderRadius: 8, textTransform: "uppercase", whiteSpace: "nowrap" }}>
                        System
                      </span>
                    )}
                  </div>
                  <div>
                    {r.syncStatus === "failed" && r.shopifyOrderId && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="retry_sync" />
                        <input type="hidden" name="recordId" value={r.id} />
                        <button type="submit" disabled={isSubmitting} style={{ background: "rgba(255,153,0,0.12)", border: "1px solid rgba(255,153,0,0.3)", color: "#ff9900", padding: "3px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", outline: "none" }}>
                          Retry
                        </button>
                      </Form>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 20 }}>
            {page > 1 && (
              <Link to={getFilterUrl(statusFilter, orderSearch, page - 1)} style={{ padding: "6px 14px", borderRadius: 8, background: C.surface, border: "1px solid " + C.border, color: C.muted, fontSize: 13, textDecoration: "none", fontWeight: 600 }}>Prev</Link>
            )}
            <span style={{ padding: "6px 14px", fontSize: 13, color: C.muted }}>Page {page} of {totalPages}</span>
            {page < totalPages && (
              <Link to={getFilterUrl(statusFilter, orderSearch, page + 1)} style={{ padding: "6px 14px", borderRadius: 8, background: C.surface, border: "1px solid " + C.border, color: C.muted, fontSize: 13, textDecoration: "none", fontWeight: 600 }}>Next</Link>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return (
    <div style={{ padding: 32, color: "#ff4444", fontFamily: "system-ui" }}>
      Something went wrong loading sync history.
    </div>
  );
}